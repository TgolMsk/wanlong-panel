/**
 * 任务计划（「A 游戏账号勾选脚本 + 运行时间」）的公共契约（主进程 ⇄ 渲染进程）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【它解决什么问题】
 *
 * 在它之前，脚本只能在「脚本」页手点运行，一个账号还只能挂一个 defaultScriptId。
 * 本模块在**已有的**脚本执行链（orchestrator + utilityProcess）上加一层计划表：
 *   账号 → 勾选若干脚本 → 每个脚本配一个运行时间 → 到点自动排队执行。
 * 脚本本身、模板库、执行器一个字都不用改 —— 这正是当初把脚本做成纯数据的回报。
 *
 * 【三条铁律】
 *
 *  1. ★ **脚本优先级最高。** 到点要跑脚本时，采集调度器必须让路：
 *     先礼（等 preemptGraceMs 让它自然收尾）后兵（abort 掉在飞的采样/派遣链）。
 *     脚本跑完再把调度器放回去。反过来绝不成立 —— 调度器不会挤掉脚本。
 *  2. ★ **一个实例同时只有一条链在动它。** 队列是**每实例串行**的，
 *     一个账号勾了 5 个脚本就排 5 个，挨个跑。并发上限仍由编排器的 maxConcurrentInstances 管。
 *  3. ★ **时间一律北京时间。** 'HH:MM' 指的是北京时间的那一刻（游戏按北京时间跑，
 *     而宿主机时区不一定是北京，本机实测是 America/Los_Angeles）。
 *     绝不使用 toLocaleString() / getHours()，一律显式 UTC+8 位移（与 alerts.ts / stats.ts 同一套算法）。
 *
 * 【本文件里的时间函数都是纯函数】主进程排定时器用它，渲染进程显示「下次运行」也用它，
 * 两边算出来必然是同一个毫秒数。**不要再写第二份。**
 *
 * ★ 与 scheduler.ts 一样：ipc.ts 的 IpcRoutes 已冻结，所以本模块自带一小组 plan:* 通道，
 *   走同一条 Electron IPC 桥，客户端函数（callPlan / onPlanEvent）把类型断言全关在本文件底部。
 * ══════════════════════════════════════════════════════════════════════════
 */

import { CST_OFFSET_MS } from './alerts'

export const PLAN_FILE = 'plans.json'

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

// ── 触发方式（「运行时间」）────────────────────────────────────────────────

/**
 * 什么时候跑。
 *   manual   只在面板上手点「立即运行」时跑（勾上但不自动）。
 *   daily    每天北京时间的这几个时刻各跑一次，例如 ['08:00', '20:30']。
 *   interval 每隔 everyMinutes 分钟跑一次；给了 window 就只在这个北京时间段内跑。
 */
export type TaskTrigger =
  | { kind: 'manual' }
  | { kind: 'daily'; at: string[] }
  | { kind: 'interval'; everyMinutes: number; window?: ClockWindow }

/** 北京时间的一个时间段。from > to 表示跨零点（例如 22:00 → 06:00）。 */
export interface ClockWindow {
  from: string
  to: string
}

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** 'HH:MM' → 当天零点起的毫秒偏移；不合法返回 null。 */
export function parseClock(hhmm: string): number | null {
  const m = CLOCK_RE.exec(hhmm.trim())
  if (!m) return null
  return Number(m[1]) * 3_600_000 + Number(m[2]) * MINUTE_MS
}

/** 当天零点起的毫秒偏移 → 'HH:MM'。 */
export function formatClock(offsetMs: number): string {
  const v = ((offsetMs % DAY_MS) + DAY_MS) % DAY_MS
  const h = Math.floor(v / 3_600_000)
  const m = Math.floor((v % 3_600_000) / MINUTE_MS)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 绝对时刻在北京当天里的偏移（0 ~ 86399999）。 */
export function cstOffsetOfDay(at: number): number {
  return (((at + CST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS
}

/** 该时刻所在北京日的 0 点（绝对毫秒）。与 stats.ts 的 cstDayStart 同值。 */
export function cstDayStartOf(at: number): number {
  return at - cstOffsetOfDay(at)
}

/** 绝对时刻是否落在北京时间的 window 内（含端点；from === to 视为全天）。 */
export function inClockWindow(at: number, w: ClockWindow): boolean {
  const from = parseClock(w.from)
  const to = parseClock(w.to)
  if (from == null || to == null || from === to) return true
  const now = cstOffsetOfDay(at)
  return from < to ? now >= from && now <= to : now >= from || now <= to
}

/** at 之后（含）最近的一个 window 起点。window 不合法时返回 at。 */
export function nextWindowStart(at: number, w: ClockWindow): number {
  const from = parseClock(w.from)
  if (from == null) return at
  const dayStart = cstDayStartOf(at)
  const today = dayStart + from
  return today >= at ? today : today + DAY_MS
}

/**
 * 下一次该跑的绝对时刻；manual 或配置不合法返回 null。
 *
 * @param lastRunAt 上一次**开始执行**的时刻（没跑过给 null）。interval 从它往后推。
 * @param now       现在。显式传进来是为了让这个函数可测。
 *
 * daily：取所有时刻里晚于 now 的最早一个，都不晚就取明天的最早一个。
 * interval：lastRunAt + 间隔；从没跑过就是 now（马上跑）。落在 window 外就推到下一个窗口起点。
 */
export function nextFireAt(
  trigger: TaskTrigger,
  now: number,
  lastRunAt: number | null
): number | null {
  if (trigger.kind === 'manual') return null

  if (trigger.kind === 'daily') {
    const offsets = trigger.at
      .map(parseClock)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b)
    if (offsets.length === 0) return null
    const dayStart = cstDayStartOf(now)
    for (const off of offsets) {
      const due = dayStart + off
      if (due > now) return due
    }
    return dayStart + DAY_MS + offsets[0]
  }

  const every = Math.max(1, Math.round(trigger.everyMinutes)) * MINUTE_MS
  let due = lastRunAt == null ? now : lastRunAt + every
  if (due < now) due = now
  if (trigger.window && !inClockWindow(due, trigger.window)) {
    due = nextWindowStart(due, trigger.window)
  }
  return due
}

/**
 * 最近一个**已经过去**的触发时刻；没有（manual / interval / 配置不合法）返回 null。
 *
 * 只对 daily 有意义，用途是补跑判定：「上一个 08:00 到了，但那会儿面板关着 / 实例没开机，
 * 现在 08:07 了，还补不补？」——由调用方拿它与 lastRunAt、catchUpMs 一起判断。
 * interval 不需要它：nextFireAt(lastRunAt) 落在过去本身就代表该跑了。
 */
export function previousFireAt(trigger: TaskTrigger, now: number): number | null {
  if (trigger.kind !== 'daily') return null
  const offsets = trigger.at
    .map(parseClock)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b)
  if (offsets.length === 0) return null
  const dayStart = cstDayStartOf(now)
  let best: number | null = null
  for (const off of offsets) {
    const at = dayStart + off
    if (at <= now && (best == null || at > best)) best = at
  }
  // 今天还没到任何一个时刻 → 上一个是昨天最后那一个。
  return best ?? dayStart - DAY_MS + offsets[offsets.length - 1]
}

/** 触发方式的中文描述，面板与日志共用一份。 */
export function describeTrigger(t: TaskTrigger): string {
  switch (t.kind) {
    case 'manual':
      return '仅手动'
    case 'daily': {
      const list = t.at.filter((v) => parseClock(v) != null)
      return list.length === 0 ? '每天（未设时刻）' : `每天 ${list.join('、')}`
    }
    case 'interval': {
      const every = Math.max(1, Math.round(t.everyMinutes))
      const base = every % 60 === 0 ? `每 ${every / 60} 小时` : `每 ${every} 分钟`
      return t.window ? `${base}（${t.window.from}–${t.window.to}）` : base
    }
  }
}

// ── 计划表（落盘结构）────────────────────────────────────────────────────

export interface PlanTask {
  /** 计划内唯一。 */
  id: string
  /** 要跑哪个脚本。 */
  scriptId: string
  /** ★ 面板上的那个勾选框。关掉只是不自动跑，配置留着。 */
  enabled: boolean
  trigger: TaskTrigger
  /** 同一实例上同时到点时，数字大的先跑。默认 50。 */
  priority: number
  /** 覆盖脚本参数（与账号的 scriptParams 合并，本表优先）。 */
  params?: Record<string, string | number | boolean>
  /** 单次执行的时间上限（分钟）。到点还没跑完就停掉，防止一个卡死的脚本霸占实例。0 = 不限。 */
  maxRunMinutes: number
  note?: string
}

/** 一个账号的计划。账号已经绑定了实例，所以这里不再记实例号。 */
export interface AccountPlan {
  accountId: string
  /** 账号级开关。关掉则这个账号下所有任务都不自动跑。 */
  enabled: boolean
  tasks: PlanTask[]
  updatedAt: number
}

export interface PlanConfig {
  version: 1
  /** 全局总开关。关掉后只剩手动「立即运行」。 */
  enabled: boolean
  /**
   * ★ 抢占宽限期：到点要跑脚本、而采集调度器正在动这个实例时，先等它自然收尾这么久；
   * 还没让开就 abort 掉它在飞的那条链。0 = 立刻打断。
   */
  preemptGraceMs: number
  /**
   * 错过的触发点在这个时长内还补跑（面板关了一会儿、实例刚开机）；超过就当这一轮没了，
   * 直接排下一次。防止开机瞬间把攒了一天的任务一股脑全排上。
   */
  catchUpMs: number
  /** 排到队里等实例空闲的上限，超了这一轮放弃（记 skipped），不会无限堆积。 */
  queueWaitMs: number
  /** 执行失败后重试几次。 */
  retry: number
  retryDelayMs: number
  /**
   * ★ 脚本执行期间允许 AI 顾问介入：某一步重试耗尽时，先让视觉大模型看一眼
   * （多半是活动弹窗挡路），它关掉了就重试这一步。需要 AI 顾问本身也已开启。
   */
  aiAssist: boolean
}

export function defaultPlanConfig(): PlanConfig {
  return {
    version: 1,
    enabled: false,
    preemptGraceMs: 8_000,
    catchUpMs: 30 * MINUTE_MS,
    queueWaitMs: 30 * MINUTE_MS,
    retry: 1,
    retryDelayMs: 60_000,
    aiAssist: true
  }
}

/** 取值范围（渲染进程表单的 min/max 与这里一一对应；这些是**边界**不是默认值）。 */
export const PLAN_RANGE = {
  preemptGraceMs: [0, 120_000],
  catchUpMs: [0, 12 * 3_600_000],
  queueWaitMs: [MINUTE_MS, 12 * 3_600_000],
  retry: [0, 5],
  retryDelayMs: [0, 30 * MINUTE_MS],
  everyMinutes: [1, 24 * 60],
  maxRunMinutes: [0, 12 * 60],
  priority: [0, 100]
} as const satisfies Record<string, readonly [number, number]>

export function clampToRange(v: number, range: readonly [number, number]): number {
  if (!Number.isFinite(v)) return range[0]
  return Math.min(range[1], Math.max(range[0], Math.round(v)))
}

/** 新建一个任务的默认形状。面板「添加脚本」用它。 */
export function emptyTask(id: string, scriptId: string): PlanTask {
  return {
    id,
    scriptId,
    enabled: true,
    trigger: { kind: 'daily', at: ['08:00'] },
    priority: 50,
    maxRunMinutes: 30
  }
}

// ── 运行时状态（推给面板）────────────────────────────────────────────────

export type PlanTaskPhase =
  /** 等下一次触发。 */
  | 'idle'
  /** 已到点，排在实例队列里等。 */
  | 'queued'
  /** 正在跑。 */
  | 'running'
  /** 上一轮成功。 */
  | 'done'
  /** 上一轮失败（重试也用完了）。 */
  | 'failed'
  /** 这一轮被跳过（实例没开机 / 等太久 / 上一轮还没跑完）。 */
  | 'skipped'

export const PLAN_PHASE_TEXT: Record<PlanTaskPhase, string> = {
  idle: '等待',
  queued: '排队中',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  skipped: '已跳过'
}

/** 面板一行。计划表 + 运行时都拍平在这里，渲染进程不用自己拼。 */
export interface PlanTaskState {
  accountId: string
  accountName: string
  /** 账号绑定的实例；没绑为 null（面板要标黄：没绑实例跑不了）。 */
  instanceIndex: number | null
  taskId: string
  scriptId: string
  /** 脚本名；脚本被删了为 null（面板标红）。 */
  scriptName: string | null
  enabled: boolean
  /** 账号级开关，false 时整行置灰。 */
  accountEnabled: boolean
  trigger: TaskTrigger
  priority: number
  maxRunMinutes: number
  /** 自由备注，面板显示在脚本名下面。 */
  note?: string
  phase: PlanTaskPhase
  /** 下一次该跑的绝对时刻；manual / 关掉了为 null。 */
  nextRunAt: number | null
  /** 上一次开始执行的时刻。 */
  lastRunAt: number | null
  lastEndedAt: number | null
  lastResult: 'succeeded' | 'failed' | 'aborted' | null
  /** 上一次失败的中文原因。 */
  lastError: string | null
  /** 正在跑时的执行 id，可以跳到「执行监控」。 */
  runId: string | null
  /** 排队进入时刻（phase=queued 时有值），面板显示「已等 N 秒」。 */
  queuedAt: number | null
  runs: number
  fails: number
}

/** 某个实例的队列快照。 */
export interface PlanQueueView {
  instanceIndex: number
  /** 队首正在跑的那个任务，没有为 null。 */
  runningTaskId: string | null
  /** 还在等的任务 id，已按优先级排好序。 */
  waitingTaskIds: string[]
}

export interface PlanOverview {
  config: PlanConfig
  tasks: PlanTaskState[]
  queues: PlanQueueView[]
  /** 主进程算这份快照的时刻，面板据此本地递推倒计时。 */
  at: number
}

// ── IPC ───────────────────────────────────────────────────────────────────

export const PLAN_CH = {
  /** 拉取整张计划表 + 运行时状态。 */
  state: 'plan:state',
  /** 读某个账号的计划（面板编辑器用）。没有就返回一份空的。 */
  get: 'plan:get',
  /** 整账号覆盖保存。 */
  save: 'plan:save',
  /** 只翻一个任务的勾选框（面板上最高频的操作，不必整份回写）。 */
  setTaskEnabled: 'plan:setTaskEnabled',
  /** 只翻账号级开关。 */
  setAccountEnabled: 'plan:setAccountEnabled',
  /** 立即运行一个任务（无视触发时间，照样走队列与抢占）。 */
  runNow: 'plan:runNow',
  /** 取消排队中的任务；正在跑的则停掉。 */
  cancel: 'plan:cancel',
  config: 'plan:config',
  saveConfig: 'plan:saveConfig'
} as const

export type PlanRoutes = {
  'plan:state': [[], PlanOverview]
  'plan:get': [[accountId: string], AccountPlan]
  'plan:save': [[plan: AccountPlan], AccountPlan]
  'plan:setTaskEnabled': [[accountId: string, taskId: string, enabled: boolean], PlanOverview]
  'plan:setAccountEnabled': [[accountId: string, enabled: boolean], PlanOverview]
  'plan:runNow': [[accountId: string, taskId: string], PlanOverview]
  'plan:cancel': [[accountId: string, taskId: string], PlanOverview]
  'plan:config': [[], PlanConfig]
  'plan:saveConfig': [[patch: Partial<PlanConfig>], PlanConfig]
}

export type PlanChannel = keyof PlanRoutes
export type PlanArgs<K extends PlanChannel> = PlanRoutes[K][0]
export type PlanResult<K extends PlanChannel> = PlanRoutes[K][1]

export type PlanEvents = {
  /** 计划表或运行时状态变了（到点、入队、开跑、跑完、勾选翻转）。 */
  'plan:changed': PlanOverview
  'plan:configChanged': PlanConfig
}

export type PlanEventChannel = keyof PlanEvents

// ── 渲染进程客户端（类型断言全部关在这里）────────────────────────────────

interface RawBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, cb: (payload: unknown) => void): () => void
}

function bridge(): RawBridge {
  const api = (globalThis as { api?: unknown }).api
  if (!api || typeof (api as RawBridge).invoke !== 'function') {
    throw new Error('window.api 尚未就绪：计划接口只能在渲染进程里调用。')
  }
  return api as RawBridge
}

/** 渲染进程调用计划模块。用法与 window.api.invoke 一致，只是通道表换成 PlanRoutes。 */
export function callPlan<K extends PlanChannel>(
  channel: K,
  ...args: PlanArgs<K>
): Promise<PlanResult<K>> {
  return bridge().invoke(channel, ...args) as Promise<PlanResult<K>>
}

/** 订阅计划模块推送，返回退订函数。 */
export function onPlanEvent<K extends PlanEventChannel>(
  channel: K,
  cb: (payload: PlanEvents[K]) => void
): () => void {
  return bridge().on(channel, (p) => cb(p as PlanEvents[K]))
}
