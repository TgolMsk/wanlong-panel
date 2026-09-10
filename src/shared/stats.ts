/**
 * 「每日数据统计」的公共契约（主进程 ⇄ 渲染进程 ⇄ Telegram 机器人）。
 *
 * ★ 本文件是**新增**的，不改动 src/shared 里任何既有文件。做法与 scheduler.ts / alerts.ts 一致：
 *   自带一小组 `stats:*` 通道，走同一条 Electron IPC 桥，没有登记进已冻结的 IpcRoutes；
 *   渲染进程用本文件底部的 callStats / onStatsEvent，类型断言全部关在这里。
 * ★ 四端共用：不得 import electron / node:fs / sharp / opencv。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【统计口径 —— 读代码前先看这段】
 *
 * 用户诉求原话：「统计每天北京时间 0 点开始统计 24 小时采集了多少资源等，做一个数据统计」。
 *
 * 一、日桶按**北京时间**日期切（游戏按 CST 跑，宿主机时区实测是 America/Los_Angeles）。
 *     键是 `YYYY-MM-DD`（北京日期），由 cstDateKey(ts) 算，**绝不能**用 toLocaleDateString / getDate。
 *
 * 二、主数据源是**派兵记账**：每次派兵成功都从资源点卡片读到了储量（DispatchRecord.storage，
 *     精确到个位），而配置默认勾「自动采集至清空」⇒ 该趟采集量 ≈ 储量。
 *     所以 `estimatedAmount` 是「预计采集量」= Σ storage（storage 读不出的那趟计 0 并记进
 *     `unknownStorageDispatches`，面板据此提示「有 N 趟储量未知」）。
 *     ★ 资源统计弹窗（resources.ts）精度只到 0.1亿，**不能**拿它做差值，只作日切快照（snapshots）。
 *
 * 三、统计项：按资源的派兵次数 / 预计采集量 / 完成趟数；总派兵次数；失败轮数；熔断次数；
 *     告警条数；暂停时长；资源统计快照。全部同时有「实例分桶」与「全局汇总」。
 *
 * 四、所有事件先变成 StatsEvent（只有事实），再由主进程的纯 reducer 折进日桶。
 *     事件源分工（谁在哪里发，签名定在这里，下游照抄）：
 *       dispatch        gatherRunner.createQueueFreeHook → deps.onDispatched（★ 新增钩子）
 *       cycleFailed     index.ts 的 onCycleResult（fact.outcome === 'error' | 'circuitBroken'）
 *       tripCompleted   scheduler 采样对比：上次采样在外的本引擎队伍这次不在了（★ 新增 SchedulerDeps.onMarchGone）
 *       alertRaised     AlertCenter.raise 之后（index.ts 接线）
 *       paused/resumed  alerts:pauseChanged 的同一处（AlertCenter.raise / resume）
 *       snapshot        资源统计读成功后（机器人「💰 资源」/ 面板「读一次资源统计」）
 * ══════════════════════════════════════════════════════════════════════════
 */

import { CST_OFFSET_MS } from './alerts'
import { RESOURCE_NAME, RESOURCE_TYPES, formatCnAmount, type ResourceSnapshot, type ResourceType } from './resources'

// ══════════════════════════════════════════════════════════════════════════
// 一、北京时间日期键
// ══════════════════════════════════════════════════════════════════════════
//
// ★ 与 src/main/scheduler/state.ts 的 nextCstBoundary / isFatigueWindow 同一套算法（UTC+8 位移后取 UTC 字段）。
//   这几个是纯函数，主进程与渲染进程共用；**主进程不要再写第二份**。

const DAY_MS = 86_400_000

/** `YYYY-MM-DD` 形状的北京日期键。 */
export type DateKey = string

const DATE_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

export function isDateKey(v: unknown): v is DateKey {
  return typeof v === 'string' && DATE_KEY_RE.test(v)
}

/**
 * 绝对时刻 → 北京日期键。
 *   cstDateKey(Date.UTC(2026, 8, 9, 15, 59)) === '2026-09-09'   // 北京 23:59
 *   cstDateKey(Date.UTC(2026, 8, 9, 16, 0))  === '2026-09-10'   // 北京次日 00:00
 * 非法输入（NaN/Infinity）返回 '0000-00-00'，调用方应当把它当成「无日期」。
 */
export function cstDateKey(ts: number): DateKey {
  if (!Number.isFinite(ts)) return '0000-00-00'
  const d = new Date(ts + CST_OFFSET_MS)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** 给定时刻所在北京日的 0 点（绝对毫秒）。 */
export function cstDayStart(ts: number): number {
  const cst = ts + CST_OFFSET_MS
  return Math.floor(cst / DAY_MS) * DAY_MS - CST_OFFSET_MS
}

/** 给定时刻的下一个北京 0 点（绝对毫秒）。等于 state.ts 的 nextCstBoundary(ts, 0)。 */
export function cstNextDayStart(ts: number): number {
  return cstDayStart(ts) + DAY_MS
}

/** 日期键 → 该北京日 0 点的绝对毫秒。非法键返回 NaN。 */
export function dateKeyToDayStart(key: DateKey): number {
  if (!isDateKey(key)) return Number.NaN
  const [y, m, d] = key.split('-').map(Number)
  return Date.UTC(y, m - 1, d) - CST_OFFSET_MS
}

/** 日期键加减 n 天（n 可为负）。 */
export function shiftDateKey(key: DateKey, n: number): DateKey {
  return cstDateKey(dateKeyToDayStart(key) + n * DAY_MS)
}

/** 把 [fromKey, toKey] 展开成逐日的键（含两端）；from > to 时返回空数组。上限 366 天。 */
export function dateKeyRange(fromKey: DateKey, toKey: DateKey): DateKey[] {
  const a = dateKeyToDayStart(fromKey)
  const b = dateKeyToDayStart(toKey)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return []
  const out: DateKey[] = []
  for (let t = a; t <= b && out.length < 366; t += DAY_MS) out.push(cstDateKey(t))
  return out
}

// ══════════════════════════════════════════════════════════════════════════
// 二、日桶
// ══════════════════════════════════════════════════════════════════════════

/** 一种资源在一天里的账。 */
export interface DailyResourceStat {
  /** 派兵次数（本引擎派出的、G15 复验队列 +1 的那些）。 */
  dispatches: number
  /** 预计采集量 = Σ 派兵时读到的卡片储量（个）。储量读不出的那趟计 0。 */
  estimatedAmount: number
  /** 储量没读出来的派兵次数（面板提示「预计量偏低」用）。 */
  unknownStorageDispatches: number
  /** 完成趟数：派出去的队伍从部队管理面板上消失（回城）。 */
  completed: number
}

/** 一个实例在一天里的账。 */
export interface InstanceDailyStats {
  instanceIndex: number
  /** 当天最后一次事件时该实例绑定的账号名；没绑为 null。 */
  accountName: string | null
  byResource: Record<ResourceType, DailyResourceStat>
  /** 总派兵次数（= Σ byResource.dispatches）。 */
  dispatches: number
  /** 以 outcome==='error' 收场的采集轮数（含「压根没跑起来」的那种）。 */
  failures: number
  /** 熔断次数（outcome==='circuitBroken'）。 */
  circuitBreaks: number
  /** 告警条数（AlertCenter.raise 产生的事件数，含被冷却压掉的）。 */
  alerts: number
  /** 当天累计的暂停时长（毫秒）。跨天时在 0 点切开：昨天到 24:00，今天从 00:00 起算。 */
  pausedMs: number
  /**
   * 若此刻仍处于暂停态，则是本日桶内这段暂停的起点（跨天后 = 当日 0 点）；否则 null。
   * 面板显示「今日暂停时长」时要把 now - pausedSince 加上去。
   */
  pausedSince: number | null
}

/** 一天（北京时间）的全部统计。 */
export interface DailyStats {
  /** 北京日期键 `YYYY-MM-DD`。 */
  dateKey: DateKey
  /** 全局汇总（所有实例相加）。 */
  byResource: Record<ResourceType, DailyResourceStat>
  dispatches: number
  failures: number
  circuitBreaks: number
  alerts: number
  pausedMs: number
  /** 按实例分桶。★ 键是 String(instanceIndex)（JSON 只能用字符串键）。 */
  byInstance: Record<string, InstanceDailyStats>
  /** 当天读到的资源统计快照（日切快照与手动读取都进这里），按时间升序，上限 STATS_SNAPSHOTS_PER_DAY。 */
  snapshots: ResourceSnapshot[]
  /** 最后一次写入时刻。 */
  updatedAt: number
}

/** 一天里最多保留多少张快照（每实例日切 1 张 + 手动读几张足够；防止有人把机器人按钮当鼠标连点）。 */
export const STATS_SNAPSHOTS_PER_DAY = 48
/** 日桶文件保留多少天（更早的按需清理）。 */
export const STATS_RETENTION_DAYS = 90
/** 落盘目录（相对 <dataDir>），每天一个文件 `<dateKey>.json`。 */
export const STATS_DIR = 'stats'

export function emptyResourceStat(): DailyResourceStat {
  return { dispatches: 0, estimatedAmount: 0, unknownStorageDispatches: 0, completed: 0 }
}

export function emptyByResource(): Record<ResourceType, DailyResourceStat> {
  return {
    gold: emptyResourceStat(),
    wood: emptyResourceStat(),
    iron: emptyResourceStat(),
    mana: emptyResourceStat()
  }
}

export function emptyInstanceDailyStats(instanceIndex: number): InstanceDailyStats {
  return {
    instanceIndex,
    accountName: null,
    byResource: emptyByResource(),
    dispatches: 0,
    failures: 0,
    circuitBreaks: 0,
    alerts: 0,
    pausedMs: 0,
    pausedSince: null
  }
}

export function emptyDailyStats(dateKey: DateKey, updatedAt = 0): DailyStats {
  return {
    dateKey,
    byResource: emptyByResource(),
    dispatches: 0,
    failures: 0,
    circuitBreaks: 0,
    alerts: 0,
    pausedMs: 0,
    byInstance: {},
    snapshots: [],
    updatedAt
  }
}

/** 从磁盘读回来的东西逐字段容错归一化：坏一个字段只回退这一个字段，不整体作废。 */
export function normalizeDailyStats(raw: unknown, fallbackKey: DateKey): DailyStats {
  const base = emptyDailyStats(fallbackKey)
  if (typeof raw !== 'object' || raw === null) return base
  const o = raw as Record<string, unknown>
  const out: DailyStats = {
    ...base,
    dateKey: isDateKey(o.dateKey) ? o.dateKey : fallbackKey,
    byResource: normalizeByResource(o.byResource),
    dispatches: numOr(o.dispatches),
    failures: numOr(o.failures),
    circuitBreaks: numOr(o.circuitBreaks),
    alerts: numOr(o.alerts),
    pausedMs: numOr(o.pausedMs),
    updatedAt: numOr(o.updatedAt),
    snapshots: Array.isArray(o.snapshots)
      ? (o.snapshots as unknown[]).filter(isSnapshotLike).slice(-STATS_SNAPSHOTS_PER_DAY)
      : []
  }
  if (typeof o.byInstance === 'object' && o.byInstance !== null) {
    for (const [k, v] of Object.entries(o.byInstance as Record<string, unknown>)) {
      const idx = Number(k)
      if (!Number.isInteger(idx) || idx < 0 || typeof v !== 'object' || v === null) continue
      const iv = v as Record<string, unknown>
      out.byInstance[k] = {
        instanceIndex: idx,
        accountName: typeof iv.accountName === 'string' ? iv.accountName : null,
        byResource: normalizeByResource(iv.byResource),
        dispatches: numOr(iv.dispatches),
        failures: numOr(iv.failures),
        circuitBreaks: numOr(iv.circuitBreaks),
        alerts: numOr(iv.alerts),
        pausedMs: numOr(iv.pausedMs),
        pausedSince: typeof iv.pausedSince === 'number' && Number.isFinite(iv.pausedSince) ? iv.pausedSince : null
      }
    }
  }
  return out
}

function normalizeByResource(raw: unknown): Record<ResourceType, DailyResourceStat> {
  const out = emptyByResource()
  if (typeof raw !== 'object' || raw === null) return out
  const o = raw as Record<string, unknown>
  for (const t of RESOURCE_TYPES) {
    const v = o[t]
    if (typeof v !== 'object' || v === null) continue
    const s = v as Record<string, unknown>
    out[t] = {
      dispatches: numOr(s.dispatches),
      estimatedAmount: numOr(s.estimatedAmount),
      unknownStorageDispatches: numOr(s.unknownStorageDispatches),
      completed: numOr(s.completed)
    }
  }
  return out
}

function isSnapshotLike(v: unknown): v is ResourceSnapshot {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.at === 'number' && typeof o.instanceIndex === 'number' && Array.isArray(o.rows)
}

function numOr(v: unknown, dflt = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

// ══════════════════════════════════════════════════════════════════════════
// 三、事件（只有事实，不含结论）
// ══════════════════════════════════════════════════════════════════════════

/** 派兵成功一次（DispatchRecord 的子集，shared 层不 import main 的类型）。 */
export interface StatsDispatchEvent {
  kind: 'dispatch'
  at: number
  instanceIndex: number
  resource: ResourceType
  /** 卡片储量（个）；读不出为 null（计入 unknownStorageDispatches）。 */
  storage: number | null
  coord: string | null
  level: number | null
  travelTimeSec: number | null
}

/** 一轮采集以失败/熔断收场。 */
export interface StatsCycleFailedEvent {
  kind: 'cycleFailed'
  at: number
  instanceIndex: number
  /** 'error' 计 failures；'circuitBroken' 计 circuitBreaks。 */
  outcome: 'error' | 'circuitBroken'
  message: string
  step: string | null
  errorCode: string | null
}

/** 一支本引擎派出的队伍回城了（在部队管理面板上消失）。 */
export interface StatsTripCompletedEvent {
  kind: 'tripCompleted'
  at: number
  instanceIndex: number
  coord: string | null
  /** 从派兵记账反查到的资源类型；查不到为 null（只计总数不计分类）。 */
  resource: ResourceType | null
}

/** 产生了一条告警（不论是否暂停、是否推送成功）。 */
export interface StatsAlertRaisedEvent {
  kind: 'alertRaised'
  at: number
  instanceIndex: number
  /** AlertType 的字符串（shared/alerts 的 AlertType），这里只存字符串不做判断。 */
  alertType: string
}

/** 实例被暂停 / 恢复。pausedMs 由这两个事件的时间差累出来。 */
export interface StatsPausedEvent {
  kind: 'paused'
  at: number
  instanceIndex: number
  reason: string | null
}

export interface StatsResumedEvent {
  kind: 'resumed'
  at: number
  instanceIndex: number
}

/** 读到了一张资源统计快照。 */
export interface StatsSnapshotEvent {
  kind: 'snapshot'
  at: number
  instanceIndex: number
  snapshot: ResourceSnapshot
}

export type StatsEvent =
  | StatsDispatchEvent
  | StatsCycleFailedEvent
  | StatsTripCompletedEvent
  | StatsAlertRaisedEvent
  | StatsPausedEvent
  | StatsResumedEvent
  | StatsSnapshotEvent

export type StatsEventKind = StatsEvent['kind']

// ══════════════════════════════════════════════════════════════════════════
// 四、IPC 通道
// ══════════════════════════════════════════════════════════════════════════

export const STATS_CH = {
  /** 读某一天的日桶；不传 dateKey = 今天（北京）。没有数据也返回一个空桶（不是 null）。 */
  daily: 'stats:daily',
  /** 读 [from, to] 逐日的日桶（含两端，最多 366 天）；没数据的天返回空桶。 */
  range: 'stats:range',
  /** 立刻对某实例读一次资源统计弹窗并写成快照（抢实例锁；脚本在跑/不在主界面会抛中文错误）。 */
  snapshotNow: 'stats:snapshotNow'
} as const

export type StatsRoutes = {
  'stats:daily': [[dateKey?: DateKey], DailyStats]
  'stats:range': [[fromKey: DateKey, toKey: DateKey], DailyStats[]]
  'stats:snapshotNow': [[instanceIndex: number], ResourceSnapshot]
}

export type StatsChannel = keyof StatsRoutes
export type StatsArgs<K extends StatsChannel> = StatsRoutes[K][0]
export type StatsResult<K extends StatsChannel> = StatsRoutes[K][1]

export type StatsPushEvents = {
  /**
   * 今天（北京）的日桶变了。★ 主进程要节流（≥1s 合并一次），派兵那一刻会连发好几个事件。
   * 跨过北京 0 点时推的是**新的一天**的空桶，面板据此换日。
   */
  'stats:today': DailyStats
}

export type StatsPushChannel = keyof StatsPushEvents

// ── 渲染进程客户端（类型断言全部关在这里，与 scheduler.ts / alerts.ts 同一套写法）────

interface RawBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, cb: (payload: unknown) => void): () => void
}

function bridge(): RawBridge {
  const api = (globalThis as { api?: unknown }).api
  if (!api || typeof (api as RawBridge).invoke !== 'function') {
    throw new Error('window.api 尚未就绪：统计接口只能在渲染进程里调用。')
  }
  return api as RawBridge
}

/**
 * 渲染进程调用统计模块。用法与 window.api.invoke 完全一致。
 *   const today = await callStats('stats:daily')
 *   const week = await callStats('stats:range', shiftDateKey(k, -6), k)
 */
export function callStats<K extends StatsChannel>(
  channel: K,
  ...args: StatsArgs<K>
): Promise<StatsResult<K>> {
  return bridge().invoke(channel, ...args) as Promise<StatsResult<K>>
}

/** 订阅统计推送，返回退订函数（useEffect 可以直接 return 它）。 */
export function onStatsEvent<K extends StatsPushChannel>(
  channel: K,
  cb: (payload: StatsPushEvents[K]) => void
): () => void {
  return bridge().on(channel, (p) => cb(p as StatsPushEvents[K]))
}

/** 把主进程/桥抛回来的异常翻译成一句能指向修复方向的中文（与 describeAlertError 同一写法）。 */
export function describeStatsError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const stripped = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
  if (/No handler registered|no handler/i.test(stripped)) {
    return '主进程还没有注册统计通道（stats:*）。数据统计模块接线之后本页会自动可用。'
  }
  return stripped || '未知错误'
}

// ══════════════════════════════════════════════════════════════════════════
// 五、渲染（机器人「📈 今日统计」与面板摘要共用同一段文案）
// ══════════════════════════════════════════════════════════════════════════

/** 毫秒 → `3小时12分` / `45分` / `<1分`；0 或负数 → `0分`。 */
export function formatPausedDuration(ms: number): string {
  if (!(ms > 0)) return '0分'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '<1分'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}小时${m}分` : `${m}分`
}

/** 实例今日暂停时长（含仍在进行中的那段）。 */
export function livePausedMs(inst: InstanceDailyStats, now: number = Date.now()): number {
  return inst.pausedMs + (inst.pausedSince != null ? Math.max(0, now - inst.pausedSince) : 0)
}

/**
 * 把一天的统计渲染成纯文本（★ 不用 Markdown）。
 *
 *   【今日统计】2026-09-09（北京时间，截至 21:22）
 *   派兵 12 次｜完成 9 趟｜失败 1 轮｜熔断 0 次｜告警 2 条｜暂停 15分
 *   木材 6 次 ≈ 756万　金币 3 次 ≈ 210万　铁矿石 3 次 ≈ 180万　魔水 0 次
 *   ── 实例 0「主号」：派兵 12 次 ≈ 1146万，暂停 15分
 *   资源统计快照 1 张（最近 00:03）
 *   （预计采集量 = Σ 派兵时卡片储量，按「自动采集至清空」估算）
 */
export function renderDailyStatsText(
  s: DailyStats,
  opts: { now?: number; formatClock: (at: number) => string }
): string {
  const now = opts.now ?? Date.now()
  const isToday = cstDateKey(now) === s.dateKey
  const totalPaused = Object.values(s.byInstance).reduce((acc, i) => acc + livePausedMs(i, now), 0)
  const completed = RESOURCE_TYPES.reduce((acc, t) => acc + s.byResource[t].completed, 0)
  const unknown = RESOURCE_TYPES.reduce((acc, t) => acc + s.byResource[t].unknownStorageDispatches, 0)

  const lines: string[] = [
    `【${isToday ? '今日' : '当日'}统计】${s.dateKey}（北京时间${isToday ? `，截至 ${opts.formatClock(now)}` : ''}）`,
    `派兵 ${s.dispatches} 次｜完成 ${completed} 趟｜失败 ${s.failures} 轮｜熔断 ${s.circuitBreaks} 次｜告警 ${s.alerts} 条｜暂停 ${formatPausedDuration(totalPaused)}`,
    RESOURCE_TYPES.map((t) => {
      const r = s.byResource[t]
      return r.dispatches > 0
        ? `${RESOURCE_NAME[t]} ${r.dispatches} 次 ≈ ${formatCnAmount(r.estimatedAmount)}`
        : `${RESOURCE_NAME[t]} 0 次`
    }).join('　')
  ]
  const insts = Object.values(s.byInstance).sort((a, b) => a.instanceIndex - b.instanceIndex)
  for (const i of insts) {
    const amount = RESOURCE_TYPES.reduce((acc, t) => acc + i.byResource[t].estimatedAmount, 0)
    const who = i.accountName ? `「${i.accountName}」` : ''
    lines.push(
      `── 实例 ${i.instanceIndex}${who}：派兵 ${i.dispatches} 次 ≈ ${formatCnAmount(amount)}` +
        `${i.failures > 0 ? `，失败 ${i.failures} 轮` : ''}` +
        `${livePausedMs(i, now) > 0 ? `，暂停 ${formatPausedDuration(livePausedMs(i, now))}` : ''}` +
        `${i.pausedSince != null ? '（暂停中）' : ''}`
    )
  }
  if (s.snapshots.length > 0) {
    const last = s.snapshots[s.snapshots.length - 1]
    lines.push(`资源统计快照 ${s.snapshots.length} 张（最近 ${opts.formatClock(last.at)}）`)
  }
  if (unknown > 0) lines.push(`⚠️ 有 ${unknown} 趟储量没读出来，预计采集量偏低。`)
  lines.push('（预计采集量 = Σ 派兵时卡片储量，按「自动采集至清空」估算）')
  return lines.join('\n')
}
