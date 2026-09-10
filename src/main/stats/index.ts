/**
 * 数据统计中心（StatsCenter）：收事件 → 折进当天的日桶 → 落盘 → 推给面板。
 *
 * 职责边界：
 *   · 只认 StatsEvent（@shared/stats），不知道调度器 / 采集流程 / 告警中心长什么样；
 *     谁在哪发事件见 src/shared/stats.ts 顶部【统计口径】第四条，接线在 src/main/index.ts。
 *   · 日期一律按北京时间（cstDateKey），宿主时区是 America/Los_Angeles 也不影响。
 *   · record() 是**同步且绝不抛**的：统计链路坏了不能连累采集。
 *
 * 落盘与推送：
 *   · 落盘 1s 防抖（派兵那一刻会连发好几条事件）；日切时前一天立刻写出。
 *   · stats:today 推送 1s 节流（合并一次）；跨北京 0 点推的是新一天的空桶。
 *   · 事件早于今天（例如面板重启后补记）：读回那天的文件改完存回，不碰 current。
 *   · 事件晚于今天（定时器还没醒、或时钟跳了）：先把日子滚过去再记。
 *
 * 用法（主进程接线）：
 *   const statsCenter = getStatsCenter()
 *   await statsCenter.init({ dataDir, accountNameOf, log, snapshotNow })
 *   statsCenter.registerHandlers()
 *   statsCenter.record({ kind: 'dispatch', ... })
 *   ...
 *   await statsCenter.stop()
 */

import { AppError } from '@shared/errors'
import type { ResourceSnapshot, ResourceType } from '@shared/resources'
import {
  STATS_CH,
  STATS_RETENTION_DAYS,
  cstDateKey,
  cstNextDayStart,
  dateKeyRange,
  dateKeyToDayStart,
  emptyDailyStats,
  isDateKey,
  type DailyStats,
  type DateKey,
  type StatsEvent
} from '@shared/stats'

import { emitStats, handleStats, resetStatsIpc } from './ipc'
import { applyStatsEvent, isDayEmpty, rolloverDay } from './reduce'
import { loadDailyStats, pruneDailyStats, saveDailyStats } from './store'

export type StatsLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface StatsCenterDeps {
  dataDir(): string
  /** 反查实例当前绑定的账号名；异步、可能慢，结果会被缓存。 */
  accountNameOf(instanceIndex: number): Promise<string | null>
  /** 时钟（离线自检注入假时间用）。 */
  now?(): number
  log(level: StatsLogLevel, message: string): void
  /** 面板「读一次资源统计」；不给则 stats:snapshotNow 抛「未接线」。 */
  snapshotNow?(instanceIndex: number): Promise<ResourceSnapshot>
  /** 每次推送 stats:today 时同步回调一份（离线自检 / 机器人扩展用；正式接线不必给）。 */
  onToday?(stats: DailyStats): void
}

/** 落盘防抖窗口。 */
const SAVE_DEBOUNCE_MS = 1_000
/** stats:today 推送节流窗口。 */
const EMIT_THROTTLE_MS = 1_000
/** 账号名缓存的刷新间隔（同一实例）。 */
const NAME_REFRESH_MS = 60_000
/** setTimeout 的最大延迟（超过会被 Node 当成 1ms 立刻触发）。 */
const MAX_TIMER_MS = 2_147_483_647
/** 日切最多连续滚多少天（防止时钟异常把循环跑飞）。 */
const MAX_ROLLOVER_DAYS = 3_660

export class StatsCenter {
  private deps: StatsCenterDeps | null = null
  private current: DailyStats = emptyDailyStats('0000-00-00')
  private dirty = false
  private saveTimer: NodeJS.Timeout | null = null
  private emitTimer: NodeJS.Timeout | null = null
  private rolloverTimer: NodeJS.Timeout | null = null
  /** 正在进行中的落盘 / 补记，stop() 时要等它们。 */
  private inflight: Promise<unknown> = Promise.resolve()
  /** 账号名缓存：instanceIndex → 名字（null = 没绑）。 */
  private names = new Map<number, string | null>()
  private nameRefreshedAt = new Map<number, number>()
  /** 派兵记账：`${instanceIndex}|${coord}` → 资源类型，队伍回城时反查后删除。 */
  private coordResource = new Map<string, ResourceType>()

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async init(deps: StatsCenterDeps): Promise<void> {
    this.deps = deps
    const now = this.now()
    const key = cstDateKey(now)
    try {
      const loaded = await loadDailyStats(deps.dataDir(), key, (m) => this.log('warn', m))
      this.current = loaded ?? emptyDailyStats(key)
    } catch (e) {
      this.log('error', `[统计] 读取今天的统计文件失败，本次从空桶开始：${AppError.from(e).message}`)
      this.current = emptyDailyStats(key)
    }
    for (const inst of Object.values(this.current.byInstance)) {
      this.names.set(inst.instanceIndex, inst.accountName)
    }
    this.dirty = false
    // 万一文件里的日期已经是昨天（例如面板关着跨过了 0 点后又被手工改过），先把日子滚过去。
    this.checkRollover(now)
    this.armRolloverTimer()
    // 清理过期日桶：不阻塞启动，失败只记日志。
    void pruneDailyStats(deps.dataDir(), STATS_RETENTION_DAYS, {
      now,
      warn: (m) => this.log('warn', m)
    })
      .then((removed) => {
        if (removed.length > 0) this.log('info', `[统计] 已清理 ${removed.length} 个超过 ${STATS_RETENTION_DAYS} 天的日统计文件。`)
      })
      .catch((e) => this.log('warn', `[统计] 清理旧统计文件失败：${AppError.from(e).message}`))
    this.log('info', `[统计] 数据统计已就绪：今天（北京）${this.current.dateKey}，已有派兵 ${this.current.dispatches} 次。`)
  }

  /** 收尾：写出还没落盘的今天，等补记完成，摘掉 IPC。 */
  async stop(): Promise<void> {
    if (this.rolloverTimer) clearTimeout(this.rolloverTimer)
    this.rolloverTimer = null
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    await this.flushSave()
    await this.inflight.catch(() => undefined)
    resetStatsIpc()
  }

  registerHandlers(): void {
    handleStats(STATS_CH.daily, (key) => this.daily(key))
    handleStats(STATS_CH.range, (from, to) => this.range(from, to))
    handleStats(STATS_CH.snapshotNow, (instanceIndex) => this.snapshotNow(instanceIndex))
  }

  // ── 记账 ────────────────────────────────────────────────────────────────

  /**
   * 记一条事件。★ 同步、绝不抛：任何异常只进日志。
   * 事件日期 = 今天 → 折进 current；晚于今天 → 先日切再折；早于今天 → 异步读回旧文件补记。
   */
  record(e: StatsEvent): void {
    try {
      this.recordInner(e)
    } catch (err) {
      this.log('error', `[统计] 记录事件 ${e?.kind ?? '?'} 失败（已忽略）：${AppError.from(err).message}`)
    }
  }

  private recordInner(e: StatsEvent): void {
    if (!this.deps) {
      this.log('warn', `[统计] 尚未 init，事件 ${e.kind} 被丢弃。`)
      return
    }
    const at = Number.isFinite(e.at) ? e.at : this.now()
    const ev: StatsEvent = at === e.at ? e : { ...e, at }
    const key = cstDateKey(ev.at)

    // 派兵记账表：与日桶无关，跨日也要能反查。
    if (ev.kind === 'dispatch' && ev.coord) {
      this.coordResource.set(this.coordKey(ev.instanceIndex, ev.coord), ev.resource)
    }
    let resolvedEvent = ev
    if (ev.kind === 'tripCompleted') {
      const k = this.coordKey(ev.instanceIndex, ev.coord)
      const found = ev.coord ? (this.coordResource.get(k) ?? null) : null
      if (ev.coord) this.coordResource.delete(k)
      if (ev.resource == null && found) resolvedEvent = { ...ev, resource: found }
    }

    const accountName = this.nameOf(ev.instanceIndex)
    const ctx = {
      accountName,
      resourceOfCoord: (i: number, c: string | null) =>
        c ? (this.coordResource.get(this.coordKey(i, c)) ?? null) : null,
      warn: (m: string) => this.log('warn', m)
    }

    if (key > this.current.dateKey) this.checkRollover(ev.at)

    if (key === this.current.dateKey) {
      this.current = applyStatsEvent(this.current, resolvedEvent, ctx)
      this.dirty = true
      this.scheduleSave()
      this.scheduleEmit()
      return
    }

    // 早于今天：补记进那天的文件，不动 current。
    const dataDir = this.deps.dataDir()
    const job = this.inflight
      .catch(() => undefined)
      .then(async () => {
        const day = (await loadDailyStats(dataDir, key, (m) => this.log('warn', m))) ?? emptyDailyStats(key)
        const next = applyStatsEvent(day, resolvedEvent, ctx)
        await saveDailyStats(dataDir, next)
      })
      .catch((err) => this.log('error', `[统计] 补记 ${key} 的事件 ${ev.kind} 失败：${AppError.from(err).message}`))
    this.inflight = job
  }

  /**
   * 日切检查：current 的日期早于 at 所在的北京日就逐日滚过去。
   * 定时器与 record() 都会调；也可由自检直接调（传假时间）。
   */
  checkRollover(at: number = this.now()): void {
    if (!this.deps) return
    const target = cstDateKey(at)
    if (!isDateKey(this.current.dateKey) || !isDateKey(target)) return
    let rolled = 0
    while (this.current.dateKey < target && rolled < MAX_ROLLOVER_DAYS) {
      const { closed, opened } = rolloverDay(this.current, at)
      if (!isDayEmpty(closed)) this.persist(closed, `日切写出 ${closed.dateKey}`)
      this.current = opened
      this.dirty = !isDayEmpty(opened)
      rolled += 1
    }
    if (rolled > 0) {
      this.log('info', `[统计] 北京时间已过 0 点，统计换到新的一天：${this.current.dateKey}（滚过 ${rolled} 天）。`)
      if (this.dirty) this.scheduleSave()
      this.emitNow()
    }
  }

  // ── 查询 ────────────────────────────────────────────────────────────────

  /** 今天（北京）的日桶（克隆，改了不影响内部状态）。 */
  today(): DailyStats {
    return structuredClone(this.current)
  }

  /** 某一天的日桶；不传 = 今天。没有文件返回空桶（不是 null）。 */
  async daily(key?: DateKey): Promise<DailyStats> {
    const k = key ?? this.current.dateKey
    if (!isDateKey(k)) throw new AppError('INVALID_ARGUMENT', `日期格式应为 YYYY-MM-DD，收到：${String(key)}`)
    if (k === this.current.dateKey) return this.today()
    const deps = this.requireDeps()
    const loaded = await loadDailyStats(deps.dataDir(), k, (m) => this.log('warn', m))
    return loaded ?? emptyDailyStats(k)
  }

  /** [from, to] 逐日（含两端）；from > to 或格式非法抛 INVALID_ARGUMENT。 */
  async range(from: DateKey, to: DateKey): Promise<DailyStats[]> {
    if (!isDateKey(from) || !isDateKey(to)) {
      throw new AppError('INVALID_ARGUMENT', `日期格式应为 YYYY-MM-DD，收到：${String(from)} ~ ${String(to)}`)
    }
    if (dateKeyToDayStart(from) > dateKeyToDayStart(to)) {
      throw new AppError('INVALID_ARGUMENT', `起始日期 ${from} 晚于结束日期 ${to}。`)
    }
    const keys = dateKeyRange(from, to)
    const out: DailyStats[] = []
    for (const k of keys) out.push(await this.daily(k))
    return out
  }

  /** 面板「读一次资源统计」：交给接线方去抢锁读界面，成功后记成 snapshot 事件。 */
  async snapshotNow(instanceIndex: number): Promise<ResourceSnapshot> {
    const deps = this.requireDeps()
    if (!deps.snapshotNow) {
      throw new AppError('STEP_FAILED', '资源统计读取尚未接线（snapshotNow 未提供），暂时只能通过 Telegram 机器人读取。')
    }
    if (!Number.isInteger(instanceIndex) || instanceIndex < 0) {
      throw new AppError('INVALID_ARGUMENT', `实例序号非法：${String(instanceIndex)}`)
    }
    const snap = await deps.snapshotNow(instanceIndex)
    this.record({ kind: 'snapshot', at: snap.at, instanceIndex: snap.instanceIndex, snapshot: snap })
    return snap
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private requireDeps(): StatsCenterDeps {
    if (!this.deps) throw new AppError('STEP_FAILED', '数据统计模块尚未初始化（StatsCenter.init 未调用）。')
    return this.deps
  }

  private now(): number {
    return this.deps?.now?.() ?? Date.now()
  }

  private log(level: StatsLogLevel, message: string): void {
    this.deps?.log(level, message)
  }

  private coordKey(instanceIndex: number, coord: string | null): string {
    return `${instanceIndex}|${coord ?? ''}`
  }

  /** 账号名缓存：命中就用；过期（或没有）就异步刷新，刷新完补进 current。 */
  private nameOf(instanceIndex: number): string | null {
    const deps = this.deps
    const cached = this.names.get(instanceIndex) ?? null
    if (!deps) return cached
    const now = this.now()
    const last = this.nameRefreshedAt.get(instanceIndex) ?? Number.NEGATIVE_INFINITY
    if (now - last >= NAME_REFRESH_MS) {
      this.nameRefreshedAt.set(instanceIndex, now)
      deps
        .accountNameOf(instanceIndex)
        .then((name) => {
          this.names.set(instanceIndex, name)
          // 刷新到名字后把已经记在 current 里的实例补上（首次事件时可能记的是 null）。
          const inst = this.current.byInstance[String(instanceIndex)]
          if (inst && name != null && inst.accountName !== name) {
            inst.accountName = name
            this.dirty = true
            this.scheduleSave()
            this.scheduleEmit()
          }
        })
        .catch((e) => {
          // 查不到名字只影响显示，退回上次的缓存；下个刷新周期再试。
          this.nameRefreshedAt.set(instanceIndex, now)
          this.log('debug', `[统计] 查询实例 ${instanceIndex} 的账号名失败：${AppError.from(e).message}`)
        })
    }
    return cached
  }

  private armRolloverTimer(): void {
    if (this.rolloverTimer) clearTimeout(this.rolloverTimer)
    const now = this.now()
    // 边界后再等 1s，避免定时器提前几毫秒醒来时 cstDateKey 还是昨天。
    const delay = Math.min(MAX_TIMER_MS, Math.max(1_000, cstNextDayStart(now) - now + 1_000))
    this.rolloverTimer = setTimeout(() => {
      this.rolloverTimer = null
      try {
        this.checkRollover(this.now())
      } catch (e) {
        this.log('error', `[统计] 日切失败：${AppError.from(e).message}`)
      }
      this.armRolloverTimer()
    }, delay)
    this.rolloverTimer.unref()
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flushSave()
    }, SAVE_DEBOUNCE_MS)
    this.saveTimer.unref()
  }

  /** 把 current 写出去（若有改动）。返回的 promise 绝不 reject。 */
  private flushSave(): Promise<void> {
    if (!this.dirty || !this.deps) return Promise.resolve()
    this.dirty = false
    const snapshot = this.current
    return this.persist(snapshot, `落盘 ${snapshot.dateKey}`)
  }

  private persist(day: DailyStats, what: string): Promise<void> {
    const deps = this.deps
    if (!deps) return Promise.resolve()
    const job = this.inflight
      .catch(() => undefined)
      .then(() => saveDailyStats(deps.dataDir(), day))
      .catch((e) => {
        this.log('error', `[统计] ${what}失败：${AppError.from(e).message}`)
        // 今天的桶写失败就保留脏标记，下一条事件会再试一次。
        if (day.dateKey === this.current.dateKey) this.dirty = true
      })
    this.inflight = job
    return job
  }

  private scheduleEmit(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emitNow()
    }, EMIT_THROTTLE_MS)
    this.emitTimer.unref()
  }

  private emitNow(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    const snapshot = this.today()
    try {
      emitStats('stats:today', snapshot)
      this.deps?.onToday?.(snapshot)
    } catch (e) {
      this.log('warn', `[统计] 推送 stats:today 失败：${AppError.from(e).message}`)
    }
  }
}

// ── 单例 ──────────────────────────────────────────────────────────────────

let center: StatsCenter | null = null

export function getStatsCenter(): StatsCenter {
  if (!center) center = new StatsCenter()
  return center
}

/** 离线自检用：丢掉单例（调用方应先 await stop()）。 */
export function resetStatsCenterForTest(): void {
  center = null
}

export { applyStatsEvent, isDayEmpty, rolloverDay } from './reduce'
export type { ApplyContext } from './reduce'
export { listDailyKeys, loadDailyStats, pruneDailyStats, saveDailyStats, statsFileOf } from './store'
