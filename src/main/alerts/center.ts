/**
 * 告警中心：把「判定出来的事件」变成「实际发生的动作」。
 *
 *   raise(event)
 *     ├─ 补齐账号信息
 *     ├─ 该暂停就暂停（关掉该实例的自动调度，取消已注册的唤醒 timer）  ← 幂等
 *     ├─ 交给通知通道推送（★ 推送失败绝不影响暂停本身）
 *     ├─ 落一条历史 + 把暂停态写盘
 *     └─ 推给面板（alerts:pauseChanged / alerts:raised）
 *
 * ★ 暂停 = `scheduler.setAuto(i, false)`。这一步本身就已经是干净的暂停原语：
 *   它内部会 cancelWake(i)、清空 nextWakeAt/nextWakeReason/backoffStep，并落盘 + 推送
 *   scheduler:changed。而 planNextWake / rearm / onWake 三处都有 `!auto` 早退，
 *   所以关掉之后**不会再排任何唤醒**。这里不需要、也**绝不允许**再去调 rearm。
 *
 * ★ 「暂停不会中断正在跑的那一轮」：调度器的 sample() 与 queueFreeHook() 都没接 AbortSignal，
 *   所以暂停生效后，可能还有一次已经在跑的采样/派兵会自己跑完。跑完之后 rearm 看到 !auto
 *   就会 cancel，不会再有下一次。要做到「立刻停手」需要另外接 AbortController，
 *   那是更大的改动，本次不做（见交付说明里的遗留项）。
 *
 * ★ 锁：raise() 会在**调度器的实例锁内**被调用（queueFreeHook 那条路）。
 *   setAuto(false) 只做 cancelWake + publish + persist，不抢锁，安全；
 *   而 resume() 里的 setAuto(true) 会 await 一次采样（要抢锁），
 *   所以 resume() **只能从 IPC handler 调**，绝不能从锁内调，否则死锁。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  ALERT_CH,
  ALERT_HISTORY_LIMIT,
  alertSpec,
  defaultAlertsConfig,
  emptyPauseState,
  makeAlertEvent,
  pauseStateFromEvent,
  pausesInstance,
  renderAlertSummary,
  type AlertDetectConfig,
  type AlertEvent,
  type AlertRecord,
  type AlertsConfigView,
  type InstancePauseState,
  type NotifyResult
} from '@shared/alerts'
import { AppError } from '@shared/errors'
import type { LogLevel } from '@shared/script'

import { emitAlerts, handleAlerts, resetAlertsIpc } from './ipc'

/** 暂停态的落盘文件名（与 scheduler.json / alerts.json 并列放在 dataDir 根下）。 */
export const ALERT_PAUSES_FILE = 'alerts-pauses.json'

/**
 * 通知通道端口。
 *
 * 只声明告警中心真正用到的三件事，**结构化匹配** —— a 组的 `NotifyHub` 天然满足它，
 * 但本文件不 import 它的实现，所以推送模块没接上时告警中心照样能暂停（只是不推送）。
 */
export interface AlertNotifyPort {
  /** 读配置（打码视图，token 不过来）。告警中心只用其中的 detect 阈值。 */
  getConfigView(): AlertsConfigView
  /** 检测阈值的直取入口（有就优先用，省一次视图构造）。 */
  getDetectConfig?(): AlertDetectConfig
  /** 推一条告警。★ 契约上不抛异常，失败体现在返回值里。 */
  dispatch(event: AlertEvent): Promise<{ results: NotifyResult[]; suppressed: boolean }>
  /** 实例恢复时清掉它的推送冷却，下次再出事能立刻推。 */
  resetThrottleForInstance(instanceIndex: number): void | Promise<void>
}

export interface AlertCenterDeps {
  /** 运行数据根目录。每次现取 —— 用户可能改了数据目录。 */
  dataDir(): string
  /** 通知通道；还没接上时返回 null（只暂停不推送）。 */
  notify(): AlertNotifyPort | null
  /**
   * 暂停/恢复原语。生产环境接 `getScheduler().setAuto`。
   * ★ 传 false 时必须是幂等的、且不会再排唤醒。
   */
  setAuto(instanceIndex: number, enabled: boolean): Promise<unknown>
  /** 实例绑定的账号（推送里要显示账号名）。读不到就返回 null。 */
  accountOf(instanceIndex: number): Promise<{ id: string | null; name: string | null } | null>
  /** 实例恢复时把失败计数器清零。 */
  resetCounters(instanceIndex: number): void
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void
}

// ── 暂停态落盘 ─────────────────────────────────────────────────────────────
//
// 写法照抄 src/main/scheduler/store.ts：全量读写 + 临时文件 rename + 进程内写串行化，
// 读取一律容错（坏文件只该让「暂停原因」丢失，绝不能把面板卡在启动阶段）。

interface PauseFile {
  version: 1
  pauses: InstancePauseState[]
}

let writeChain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn)
  writeChain = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 逐字段容错地把磁盘上的一条记录收成合法的暂停态。 */
function sanitizePause(raw: unknown): InstancePauseState | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const idx = numOrNull(o.instanceIndex)
  if (idx === null || !Number.isInteger(idx) || idx < 0) return null
  const base = emptyPauseState(idx)
  if (o.paused !== true) return base
  return {
    ...base,
    paused: true,
    type: (str(o.type) as InstancePauseState['type']) ?? null,
    severity: (str(o.severity) as InstancePauseState['severity']) ?? null,
    reason: str(o.reason),
    pausedAt: numOrNull(o.pausedAt),
    shotPath: str(o.shotPath),
    advice: str(o.advice),
    detail:
      o.detail && typeof o.detail === 'object' && !Array.isArray(o.detail)
        ? (o.detail as InstancePauseState['detail'])
        : undefined,
    notified: typeof o.notified === 'boolean' ? o.notified : null,
    notifyError: str(o.notifyError),
    eventId: str(o.eventId)
  }
}

async function loadPauseFile(dataDir: string): Promise<InstancePauseState[]> {
  const path = join(dataDir, ALERT_PAUSES_FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new AppError('IO_ERROR', `读取暂停状态文件失败：${path}`, { cause: String(e) })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  const list = (raw as { pauses?: unknown })?.pauses
  if (!Array.isArray(list)) return []
  const out: InstancePauseState[] = []
  for (const item of list) {
    const p = sanitizePause(item)
    if (p) out.push(p)
  }
  return out
}

async function savePauseFile(dataDir: string, pauses: InstancePauseState[]): Promise<void> {
  await serialize(async () => {
    const path = join(dataDir, ALERT_PAUSES_FILE)
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    try {
      await mkdir(dataDir, { recursive: true })
      const payload: PauseFile = { version: 1, pauses }
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await rename(tmp, path)
    } catch (e) {
      await unlink(tmp).catch(() => undefined)
      throw new AppError('IO_ERROR', `写入暂停状态文件失败：${path}`, { cause: String(e) })
    }
  })
}

// ── 告警中心 ───────────────────────────────────────────────────────────────

class AlertCenterImpl {
  private deps: AlertCenterDeps | null = null
  private readonly pauses = new Map<number, InstancePauseState>()
  private readonly records: AlertRecord[] = []
  private started = false

  async init(deps: AlertCenterDeps): Promise<void> {
    if (this.started) return
    this.deps = deps
    this.started = true

    // ★ 先注册通道：万一状态文件读坏了，面板至少能拉到空列表并看到日志，
    //   而不是收到一句「No handler registered」不知所云。
    this.registerHandlers()

    try {
      for (const p of await loadPauseFile(deps.dataDir())) this.pauses.set(p.instanceIndex, p)
    } catch (e) {
      deps.log('error', `[告警] 读取暂停状态失败，本次从空状态开始：${AppError.from(e).message}`)
      return
    }
    const pausedList = [...this.pauses.values()].filter((p) => p.paused)
    deps.log(
      'info',
      `[告警] 告警中心已就绪，恢复了 ${pausedList.length} 个处于暂停状态的实例` +
        (pausedList.length > 0 ? `（实例 ${pausedList.map((p) => p.instanceIndex).join('、')}）` : '') +
        '。'
    )
  }

  /** 退出前收尾。 */
  async stop(): Promise<void> {
    if (!this.started) return
    try {
      await this.persist()
    } catch (e) {
      this.log('error', `[告警] 保存暂停状态失败：${AppError.from(e).message}`)
    }
    resetAlertsIpc()
    this.started = false
  }

  // ── 查询 ────────────────────────────────────────────────────────────────

  listPauses(): InstancePauseState[] {
    return [...this.pauses.values()]
      .map((p) => ({ ...p }))
      .sort((a, b) => a.instanceIndex - b.instanceIndex)
  }

  getPause(instanceIndex: number): InstancePauseState {
    return { ...(this.pauses.get(instanceIndex) ?? emptyPauseState(instanceIndex)) }
  }

  isPaused(instanceIndex: number): boolean {
    return this.pauses.get(instanceIndex)?.paused === true
  }

  history(limit?: number): AlertRecord[] {
    const n = Math.max(1, Math.min(ALERT_HISTORY_LIMIT, limit ?? ALERT_HISTORY_LIMIT))
    return this.records.slice(0, n)
  }

  /** 当前生效的检测阈值。推送模块没接上时用默认值（不因此报错）。 */
  detectConfig(): AlertDetectConfig {
    try {
      const port = this.deps?.notify()
      if (port?.getDetectConfig) return port.getDetectConfig()
      const view = port?.getConfigView()
      if (view?.detect) return view.detect
    } catch (e) {
      this.log('warn', `[告警] 读取检测阈值失败，本次用默认阈值：${AppError.from(e).message}`)
    }
    return defaultAlertsConfig().detect
  }

  // ── 核心：产生一条告警 ──────────────────────────────────────────────────

  /**
   * 处理一条告警事件。**不抛异常** —— 告警链路自己坏掉绝不能影响采集主流程。
   */
  async raise(event: AlertEvent): Promise<AlertRecord> {
    const enriched = await this.enrich(event)
    const detect = this.detectConfig()

    // ① 该暂停就暂停。★ 顺序很重要：先把游戏停下来，再去发网络请求。
    let pausedNow = false
    if (pausesInstance(enriched.type)) {
      if (!detect.autoPauseEnabled) {
        this.log(
          'warn',
          `[告警] ${renderAlertSummary(enriched)}｜「出事自动暂停」开关是关的，本次只记录不暂停。`
        )
      } else if (this.isPaused(enriched.instanceIndex)) {
        // 幂等：已经是暂停态了，不重复关调度、不覆盖最初的暂停原因。
        this.log(
          'info',
          `[告警] 实例 ${enriched.instanceIndex} 已处于暂停状态，本次不重复暂停：${enriched.reason}`
        )
      } else {
        pausedNow = await this.doPause(enriched)
      }
    }

    // ② 推送。★ 推送失败不得影响暂停本身，所以这一步在暂停之后，且吞掉一切异常。
    const { results, suppressed } = await this.dispatchQuietly(enriched)
    const ok = results.some((r) => r.ok)
    const firstErr = results.find((r) => !r.ok)
    const notified = results.length === 0 ? null : ok
    const notifyError = ok ? null : (firstErr?.message ?? null)

    // ③ 把推送结果补进暂停态（面板要显示「推送失败：xxx」）。
    if (pausedNow) {
      const pause = pauseStateFromEvent(enriched, { notified, notifyError })
      this.pauses.set(enriched.instanceIndex, pause)
      await this.persistQuietly()
      this.emitPause(pause)
    }

    const record: AlertRecord = { event: enriched, results, suppressed, pausedNow }
    this.records.unshift(record)
    if (this.records.length > ALERT_HISTORY_LIMIT) this.records.length = ALERT_HISTORY_LIMIT
    this.emitRaised(record)

    this.log(
      alertSpec(enriched.type).severity === 'info' ? 'info' : 'warn',
      `[告警] ${renderAlertSummary(enriched)}｜${pausedNow ? '已暂停该实例' : '未暂停'}｜` +
        (results.length === 0
          ? '未配置推送'
          : ok
            ? '已推送'
            : `推送未发出：${firstErr?.message ?? '原因未知'}`)
    )
    return record
  }

  /** 真正执行暂停。失败也要留下痕迹，不能静默。 */
  private async doPause(event: AlertEvent): Promise<boolean> {
    const deps = this.deps
    if (!deps) return false
    try {
      // setAuto(false) 内部已经做了 cancelWake + 清 nextWakeAt + 落盘 + 推 scheduler:changed。
      await deps.setAuto(event.instanceIndex, false)
      this.log('warn', `[告警] 已暂停实例 ${event.instanceIndex} 的自动调度：${event.reason}`)
      return true
    } catch (e) {
      this.log(
        'error',
        `[告警] 想暂停实例 ${event.instanceIndex} 但没成功（自动调度可能还开着，请到面板手动关闭）：` +
          AppError.from(e).message
      )
      return false
    }
  }

  /** 推送。★ 任何异常都在这里吃掉：推送坏了不能连累暂停。 */
  private async dispatchQuietly(
    event: AlertEvent
  ): Promise<{ results: NotifyResult[]; suppressed: boolean }> {
    const port = this.deps?.notify() ?? null
    if (!port) return { results: [], suppressed: false }
    try {
      return await port.dispatch(event)
    } catch (e) {
      // Notifier 契约上不该抛，但这里必须兜住 —— 契约是给人守的，兜底是给机器守的。
      const message = `推送模块内部出错：${AppError.from(e).message}`
      this.log('error', `[告警] ${message}`)
      return {
        results: [
          {
            ok: false,
            channel: 'telegram',
            failure: 'unknown',
            message,
            attempts: 0,
            elapsedMs: 0,
            at: Date.now(),
            retryAfterSec: null
          }
        ],
        suppressed: false
      }
    }
  }

  // ── 恢复 ────────────────────────────────────────────────────────────────

  /**
   * 人工点「恢复」。
   *
   * ★ 只能从 IPC handler 调 —— setAuto(true) 内部会 await 一次采样（要抢实例锁），
   *   从调度器的锁内调它会死锁。
   */
  async resume(instanceIndex: number): Promise<InstancePauseState> {
    const deps = this.requireDeps()
    const before = this.pauses.get(instanceIndex)

    // 先清暂停态：接下来 setAuto(true) 会立刻采样，采样失败可能再次触发告警，
    // 那时候必须看到「当前未暂停」才能正确地再暂停一次。
    const cleared = emptyPauseState(instanceIndex)
    this.pauses.set(instanceIndex, cleared)
    deps.resetCounters(instanceIndex)
    try {
      await deps.notify()?.resetThrottleForInstance(instanceIndex)
    } catch (e) {
      this.log('warn', `[告警] 清理实例 ${instanceIndex} 的推送冷却失败：${AppError.from(e).message}`)
    }
    await this.persistQuietly()
    this.emitPause(cleared)

    try {
      await deps.setAuto(instanceIndex, true)
    } catch (e) {
      const err = AppError.from(e)
      this.log('error', `[告警] 恢复实例 ${instanceIndex} 失败：${err.message}`)
      throw err
    }

    this.log(
      'info',
      `[告警] 实例 ${instanceIndex} 已恢复自动调度` +
        (before?.reason ? `（此前的暂停原因：${before.reason}）` : '') +
        '。'
    )

    // 给用户一个闭环通知（info 级，不暂停）。推送失败不影响恢复本身。
    void this.raise(
      makeAlertEvent({
        type: 'instanceResumed',
        instanceIndex,
        reason: before?.reason
          ? `已人工恢复自动调度。此前因「${before.reason}」被暂停。`
          : '已人工恢复自动调度。'
      })
    ).catch(() => undefined)

    return this.getPause(instanceIndex)
  }

  // ── 杂项 ────────────────────────────────────────────────────────────────

  private async enrich(event: AlertEvent): Promise<AlertEvent> {
    if (event.accountName !== null || !this.deps) return event
    try {
      const acc = await this.deps.accountOf(event.instanceIndex)
      if (!acc) return event
      return { ...event, accountId: acc.id, accountName: acc.name }
    } catch {
      // 读不到账号只是显示上退化成「未绑定账号」，不该影响告警本身。
      return event
    }
  }

  private emitPause(pause: InstancePauseState): void {
    try {
      emitAlerts('alerts:pauseChanged', { ...pause })
    } catch (e) {
      this.log('warn', `[告警] 推送暂停态到面板失败：${AppError.from(e).message}`)
    }
  }

  private emitRaised(record: AlertRecord): void {
    try {
      emitAlerts('alerts:raised', record)
    } catch (e) {
      this.log('warn', `[告警] 推送告警记录到面板失败：${AppError.from(e).message}`)
    }
  }

  private async persist(): Promise<void> {
    if (!this.deps) return
    await savePauseFile(this.deps.dataDir(), [...this.pauses.values()])
  }

  private async persistQuietly(): Promise<void> {
    try {
      await this.persist()
    } catch (e) {
      // 落盘失败不该打断暂停（内存里已经是暂停态了），但绝不静默。
      this.log('error', `[告警] 保存暂停状态失败：${AppError.from(e).message}`)
    }
  }

  private requireDeps(): AlertCenterDeps {
    if (!this.deps) throw new AppError('UNKNOWN', '告警中心还没初始化完成，请稍后再试。')
    return this.deps
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (this.deps) this.deps.log(level, message, data)
    else if (level === 'error' || level === 'warn') console.warn(`[alerts] ${message}`)
    else console.log(`[alerts] ${message}`)
  }

  private registerHandlers(): void {
    handleAlerts(ALERT_CH.pauses, () => this.listPauses())
    handleAlerts(ALERT_CH.resume, (i) => this.resume(i))
    handleAlerts(ALERT_CH.history, (limit) => this.history(limit))
  }
}

let singleton: AlertCenterImpl | null = null

/** 全局唯一的告警中心。主进程在 bootstrap 里 init 一次。 */
export function getAlertCenter(): AlertCenterImpl {
  if (!singleton) singleton = new AlertCenterImpl()
  return singleton
}

export type AlertCenter = AlertCenterImpl
