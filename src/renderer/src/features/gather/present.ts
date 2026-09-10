/**
 * 倒计时的**表现层**：在 `@shared/scheduler` 的纯递推之上，补出界面需要的
 * 色调 / 临期 / 数据陈旧 / 中文原因，以及全局汇总。
 *
 * ★ 时间怎么算，一律以 `@shared/scheduler.deriveMarchView` 为准，这里绝不重复实现一遍。
 *   主进程与渲染进程共用同一份递推函数，才不会出现「面板显示 03:12、日志写 03:15」这种事。
 *
 * ★ 为什么可以每秒本地递推：
 *   采样一次「部队管理」面板要开面板 + 十几张截图（游戏在前台时单张实测约 750ms）。
 *   所以采样时只把读到的相对倒计时换算成绝对时刻（timerEndsAt / gatherDoneAt / freeAt）
 *   存进 MarchState，之后界面每秒拿 Date.now() 做减法即可，**零 adb 开销**。
 *   采集完成后队伍自动回城，freeAt = gatherDoneAt + travelTimeMs 在派兵时就已知，
 *   所以 now 越过 gatherDoneAt 时会自动翻成「返回中」，不需要重新采样。
 */

import {
  deriveMarchView,
  formatDuration,
  type InstanceQueueState,
  type MarchState,
  type MarchView
} from '@shared/scheduler'

// ── 小工具 ──────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 「3 分钟前」这类相对时间，给「上次采样」用。 */
export function formatAgo(ms: number): string {
  if (ms < 0) return '刚刚'
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total} 秒前`
  const m = Math.floor(total / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分前`
}

/** 绝对时刻 -> `14:05:30`。 */
export function formatClock(at: number): string {
  const d = new Date(at)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/**
 * 短格式倒计时：不足一小时用 `MM:SS`，超过一小时退回 `HH:MM:SS`。
 * 行军 / 返程是分钟量级，用短格式更好读；采集动辄几小时，统一用 formatDuration。
 */
export function formatShort(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '--:--'
  const total = Math.max(0, Math.round(ms / 1000))
  if (total >= 3600) return formatDuration(ms)
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`
}

// ── 表现层派生 ──────────────────────────────────────────────────────────────

export type MarchTone = 'accent' | 'warning' | 'danger' | 'neutral'

export interface PresentOptions {
  /** 剩余不足这个毫秒数算「临期」，行高亮。 */
  imminentMs: number
  /** 距上次采样超过这个毫秒数算「数据陈旧」，行灰化并标「待校准」。 */
  staleAfterMs: number
}

export interface MarchPresentation {
  /** 来自 @shared/scheduler 的递推结果，时间口径与主进程完全一致。 */
  view: MarchView
  /** 倒计时文本。采集用 HH:MM:SS，行军/返程用 MM:SS。 */
  text: string
  tone: MarchTone
  imminent: boolean
  /** 数据陈旧（超过校准间隔）。 */
  stale: boolean
  staleForMs: number
  /** 需要显示给用户的中文原因；正常为 null。 */
  reason: string | null
  /** reason 是错误（红）还是提醒（黄）。 */
  reasonLevel: 'error' | 'warning'
  /** 队列释放时刻，用于「释放 14:05:30」那一行。 */
  freeAt: number | null
}

/** 把一行队伍状态换算成这一秒该显示的样子。纯计算，无副作用。 */
export function presentMarch(m: MarchState, now: number, opts: PresentOptions): MarchPresentation {
  const view = deriveMarchView(m, now)
  const staleForMs = Math.max(0, now - m.sampledAt - opts.staleAfterMs)
  const stale = staleForMs > 0

  // 倒计时读不出来是最需要让人看见的情况：不能悄悄当成 0，更不能当成「空闲」，
  // 否则调度会误判队列有空位而提前派兵。
  const unreadable = m.status === 'unknown' || (m.status !== 'idle' && m.remainingMs == null)

  let tone: MarchTone = 'accent'
  let reason: string | null = m.warning ?? null
  let reasonLevel: 'error' | 'warning' = 'warning'

  if (unreadable) {
    tone = 'danger'
    reasonLevel = 'error'
    reason =
      m.warning ??
      (m.status === 'unknown'
        ? `状态词「${m.statusText || '（空）'}」没有命中任何已知模板，无法判断这支队伍在做什么。` +
          '调度会按「倒计时识别失败时的保守 ETA」重排，不会提前派兵。'
        : '这一行读不到倒计时（数字未命中模板）。调度会按保守 ETA 重排，不会提前派兵。')
  } else if (view.phase === 'idle') {
    tone = 'neutral'
  } else if (view.phase === 'due') {
    // 本地递推认为已经到点了，等下一次采样确认。这是正常状态，不是错误。
    tone = 'accent'
  } else if (view.phase === 'marching') {
    tone = 'neutral'
  }

  const imminent =
    !unreadable &&
    view.untilFreeMs != null &&
    view.untilFreeMs > 0 &&
    view.untilFreeMs <= opts.imminentMs
  if (imminent && tone !== 'danger') tone = 'warning'

  // travelTime 是兜底值时，freeAt 只是个估计，得说清楚，别让人以为是精确时刻。
  // 两种来源要分开说：'fallback' 是面板派的但行军按钮上的耗时没读到；'unrecorded' 是压根没有派兵记录（手动派的）。
  if (!unreadable && m.travelTimeSource === 'fallback' && m.freeAt != null && reason == null) {
    reason =
      '单程行军耗时没有从「创建部队」页读到，用的是配置里的兜底估计，' +
      '所以「释放时刻」只是个估算值（调度已按宁晚勿早处理）。'
    reasonLevel = 'warning'
  } else if (
    !unreadable &&
    m.travelTimeSource === 'unrecorded' &&
    m.freeAt != null &&
    reason == null
  ) {
    reason =
      '没有这支队的派兵记录（多半是手动派出的，或面板重装后记录丢失）：资源类型未知，' +
      '单程行军耗时按配置的兜底值估算，「释放时刻」只是估算值（调度已按宁晚勿早处理）。它采完回城后，面板接管派兵即可。'
    reasonLevel = 'warning'
  }

  let text: string
  if (unreadable) {
    text = '倒计时不可用'
  } else if (view.phase === 'idle') {
    text = '空闲'
  } else if (view.phase === 'due') {
    text = '待校准'
  } else if (view.phase === 'gathering') {
    text = formatDuration(view.remainingMs)
  } else {
    text = formatShort(view.remainingMs)
  }

  return {
    view,
    text,
    tone,
    imminent,
    stale,
    staleForMs,
    reason,
    reasonLevel,
    freeAt: m.freeAt
  }
}

// ── 全局汇总 ────────────────────────────────────────────────────────────────

export interface QueueSummary {
  /** 读到过队列 N/M 的实例数。 */
  instanceCount: number
  queueUsed: number
  queueTotal: number
  /** 在途队伍总数（不含空闲行与读不出的行）。 */
  activeMarches: number
  /** 读不出状态/倒计时的行数。 */
  unreadableMarches: number
  /** 采样失败的实例数。 */
  failedInstances: number
  /** 开了自动调度的实例数。 */
  autoInstances: number
  /** 最近一个队列释放时刻。 */
  nextFreeAt: number | null
  nextFreeInstance: number | null
  /** 最近一次已排定的唤醒时刻。 */
  nextWakeAt: number | null
  nextWakeInstance: number | null
  nextWakeReason: string | null
  /** 最旧的一次成功采样时刻（0 表示有实例从没采过）。 */
  oldestSampledAt: number | null
}

export function summarizeQueues(states: readonly InstanceQueueState[]): QueueSummary {
  let instanceCount = 0
  let queueUsed = 0
  let queueTotal = 0
  let activeMarches = 0
  let unreadableMarches = 0
  let failedInstances = 0
  let autoInstances = 0
  let nextFreeAt: number | null = null
  let nextFreeInstance: number | null = null
  let nextWakeAt: number | null = null
  let nextWakeInstance: number | null = null
  let nextWakeReason: string | null = null
  let oldestSampledAt: number | null = null

  for (const s of states) {
    if (s.auto) autoInstances += 1
    if (!s.lastSampleOk && s.lastSampledAt > 0) failedInstances += 1
    if (s.error) failedInstances += s.lastSampleOk ? 1 : 0

    if (s.queueUsed != null && s.queueTotal != null) {
      queueUsed += s.queueUsed
      queueTotal += s.queueTotal
      instanceCount += 1
    }
    if (s.lastSampledAt > 0) {
      oldestSampledAt =
        oldestSampledAt == null ? s.lastSampledAt : Math.min(oldestSampledAt, s.lastSampledAt)
    }
    if (s.nextWakeAt != null && (nextWakeAt == null || s.nextWakeAt < nextWakeAt)) {
      nextWakeAt = s.nextWakeAt
      nextWakeInstance = s.instanceIndex
      nextWakeReason = s.nextWakeReason
    }
    for (const m of s.marches) {
      if (m.status === 'idle') continue
      if (m.status === 'unknown' || m.remainingMs == null) {
        unreadableMarches += 1
        continue
      }
      activeMarches += 1
      if (m.freeAt != null && (nextFreeAt == null || m.freeAt < nextFreeAt)) {
        nextFreeAt = m.freeAt
        nextFreeInstance = s.instanceIndex
      }
    }
  }

  return {
    instanceCount,
    queueUsed,
    queueTotal,
    activeMarches,
    unreadableMarches,
    failedInstances,
    autoInstances,
    nextFreeAt,
    nextFreeInstance,
    nextWakeAt,
    nextWakeInstance,
    nextWakeReason,
    oldestSampledAt
  }
}
