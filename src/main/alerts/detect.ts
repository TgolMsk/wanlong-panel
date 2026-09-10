/**
 * 第一层「通用兜底」的判定逻辑：把采集/采样的**事实**攒成**结论**。
 *
 * 为什么必须新造一个计数器（而不是复用现成的）：
 *   · `InstanceQueueState.backoffStep`（调度器）在「队列仍是 5/5」这种**完全正常**的挂机
 *     稳态下也会每 ≤300s 自增一次，且没有上界。拿它判「需要人工介入」会在正常挂机时误报。
 *   · `GatherRuntimeState.backoffIndex`（采集流程）被 `Math.min(..., ladder.length-1)` 夹在 4 以内，
 *     而且 `queueFull` 也会让它 +1，同样不是纯失败计数。
 * 所以这里只统计**真失败**：采集轮 outcome === 'error'，以及开部队面板采样抛错。
 *
 * 本文件是**纯判定**：不写盘、不发通知、不关调度。它只回答一个问题 ——
 * 「按当前阈值，这件事够不够格产生一条告警？」产生了就返回 AlertEvent，否则返回 null。
 * 拿到事件之后干什么（暂停 / 推送 / 落盘）是 AlertCenter 的事。
 *
 * ★ 阈值全部来自 AlertDetectConfig（用户可在设置页改），本文件不写死任何数字。
 */

import {
  makeAlertEvent,
  type AlertDetail,
  type AlertDetectConfig,
  type AlertEvent,
  type KickedProbeResult
} from '@shared/alerts'
import type { LogLevel } from '@shared/script'

import type { GatherOutcome } from '@main/game/gather/index'

/** 一轮采集结束后交给判定器的事实。 */
export interface CycleFact {
  outcome: GatherOutcome
  /** 采集流程给出的中文摘要。 */
  message: string
  /**
   * 失败发生在哪一步。`'G0'` 表示「未知界面恢复阶梯已经用尽」——
   * 这是比普通失败强得多的信号（游戏根本不在世界地图上，多半是顶号/维护/更新/掉线）。
   */
  step: string | null
  /** 失败的错误码（SerializedError.code），排障用。 */
  errorCode: string | null
  /** 本轮派出了几支队。 */
  dispatched: number
  /** 现场截图（相对 <dataDir>/shots）；没留到为 null。 */
  shotPath: string | null
  /** 第二层顶号探测的结论；模板缺失或没命中为 null。 */
  kicked: KickedProbeResult | null
}

export interface FailureTrackerDeps {
  /** 现取阈值 —— 用户在设置页改完立刻生效，不用重建实例。 */
  config(): AlertDetectConfig
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void
  /** 可注入的时钟，便于离线自检。 */
  now?(): number
}

interface Counters {
  /** 连续「采集轮失败」次数（outcome === 'error'）。 */
  cycleFail: number
  /** 连续「恢复阶梯用尽」次数（step === 'G0'）。 */
  recoveryFail: number
  /** 连续「开部队面板采样失败」次数。 */
  sampleFail: number
  /** 最近一次成功派兵的时刻；从未派出过时是「开始观察」的时刻。 */
  lastDispatchAt: number
  /** 上次因为「长时间派不出队」告警的时刻，用来避免每轮都报。 */
  stalledNotifiedAt: number | null
  /** 最近一次失败的中文原因，进事件 detail。 */
  lastFailReason: string | null
}

function emptyCounters(now: number): Counters {
  return {
    cycleFail: 0,
    recoveryFail: 0,
    sampleFail: 0,
    lastDispatchAt: now,
    stalledNotifiedAt: null,
    lastFailReason: null
  }
}

/**
 * 每实例的失败计数器。
 *
 * 只在内存里 —— 面板重启后从零开始重新观察是**故意的**：
 * 重启本身就是一次人工介入的机会，把重启前攒的失败次数带过来只会造成开机即暂停。
 * 真正需要跨重启的是「暂停态」本身，那个由 AlertCenter 落盘。
 */
export class FailureTracker {
  private readonly counters = new Map<number, Counters>()

  constructor(private readonly deps: FailureTrackerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private of(instanceIndex: number): Counters {
    let c = this.counters.get(instanceIndex)
    if (!c) {
      c = emptyCounters(this.now())
      this.counters.set(instanceIndex, c)
    }
    return c
  }

  /** 实例恢复正常（人工点「恢复」，或成功派出了队）时清零。 */
  reset(instanceIndex: number): void {
    this.counters.delete(instanceIndex)
    this.deps.log('debug', `[告警] 实例 ${instanceIndex} 的失败计数已清零。`)
  }

  /** 排障用：看看现在攒了几次。 */
  peek(instanceIndex: number): Readonly<Counters> | null {
    return this.counters.get(instanceIndex) ?? null
  }

  // ── 采集轮 ──────────────────────────────────────────────────────────────

  /**
   * 记一轮采集的结果，必要时产出告警事件。
   *
   * 判定顺序（先精确后兜底）：
   *   ① 第二层顶号探测命中          → 立刻出事件（不用等阈值，证据已经很硬了）
   *   ② 恢复阶梯连续用尽 ≥ 阈值      → needsAttention（默认 2 次，比普通失败更早触发）
   *   ③ 普通失败连续 ≥ 阈值          → consecutiveFailures（默认 3 次）
   *   ④ 很久没派出过队               → dispatchStalled（警告，**不暂停**）
   */
  noteCycle(instanceIndex: number, fact: CycleFact): AlertEvent | null {
    const cfg = this.deps.config()
    const c = this.of(instanceIndex)
    const now = this.now()

    if (fact.dispatched > 0) {
      c.lastDispatchAt = now
      c.stalledNotifiedAt = null
    }

    if (fact.outcome !== 'error') {
      // 只要这一轮没报错，连续失败链就断了。queueFull / noResourceWanted / giveUp /
      // staminaLow / circuitBroken 都是「游戏是好的，只是这轮没活干」，绝不能当故障。
      if (c.cycleFail > 0 || c.recoveryFail > 0) {
        this.deps.log(
          'info',
          `[告警] 实例 ${instanceIndex} 本轮结果为 ${fact.outcome}（非失败），` +
            `连续失败计数由 ${c.cycleFail} 清零。`
        )
      }
      c.cycleFail = 0
      c.recoveryFail = 0
      c.lastFailReason = null
      return this.checkStalled(instanceIndex, now, fact)
    }

    // ── 到这里就是真失败了 ──
    c.cycleFail += 1
    c.lastFailReason = fact.message
    const isRecoveryExhausted = fact.step === 'G0'
    if (isRecoveryExhausted) c.recoveryFail += 1
    else c.recoveryFail = 0

    this.deps.log(
      'warn',
      `[告警] 实例 ${instanceIndex} 采集失败计数 ${c.cycleFail}/${cfg.cycleFailThreshold}` +
        (isRecoveryExhausted
          ? `，其中「未知界面恢复阶梯用尽」${c.recoveryFail}/${cfg.recoveryFailThreshold}`
          : '') +
        `：${fact.message}`,
      { step: fact.step, errorCode: fact.errorCode }
    )

    const detail: AlertDetail = {
      outcome: fact.outcome,
      step: fact.step,
      errorCode: fact.errorCode,
      连续失败次数: c.cycleFail
    }

    // ① 第二层：顶号/维护/更新精确识别命中。模板缺失时 fact.kicked 永远是 null，自动降级到 ②③。
    if (fact.kicked) {
      this.resetFailCounts(c)
      return makeAlertEvent({
        type: fact.kicked.type,
        instanceIndex,
        at: now,
        reason: fact.kicked.reason,
        shotPath: fact.shotPath,
        detail: { ...detail, ...fact.kicked.detail }
      })
    }

    // ② 恢复阶梯连续用尽。
    if (isRecoveryExhausted && c.recoveryFail >= Math.max(1, cfg.recoveryFailThreshold)) {
      const times = c.recoveryFail
      this.resetFailCounts(c)
      return makeAlertEvent({
        type: 'needsAttention',
        instanceIndex,
        at: now,
        reason:
          `连续 ${times} 轮都回不到世界地图（未知界面恢复阶梯已用尽：通用关闭、返回键、` +
          `重新拉起游戏都试过了）。游戏很可能被顶号踢回了登录界面，或者弹了维护/强制更新公告。`,
        shotPath: fact.shotPath,
        detail: { ...detail, 恢复阶梯用尽次数: times }
      })
    }

    // ③ 普通连续失败熔断。
    if (c.cycleFail >= Math.max(1, cfg.cycleFailThreshold)) {
      const times = c.cycleFail
      this.resetFailCounts(c)
      return makeAlertEvent({
        type: 'consecutiveFailures',
        instanceIndex,
        at: now,
        reason: `连续 ${times} 轮采集都失败，最后一次的原因是：${fact.message}`,
        shotPath: fact.shotPath,
        detail: { ...detail, 连续失败次数: times }
      })
    }

    return null
  }

  /** 出过事件之后把失败链清掉，避免同一件事每轮都再报一次（暂停本身是幂等的，但历史会刷屏）。 */
  private resetFailCounts(c: Counters): void {
    c.cycleFail = 0
    c.recoveryFail = 0
  }

  // ── 长时间派不出队 ──────────────────────────────────────────────────────

  /**
   * 「游戏是好的，但很久没干成活了」。
   * ★ 这是 warning，**不暂停** —— 那是资源不够（耐力/兵力/队列占满），
   *   暂停反而会让用户更晚发现队列空着。
   */
  private checkStalled(instanceIndex: number, now: number, fact: CycleFact): AlertEvent | null {
    const cfg = this.deps.config()
    const c = this.of(instanceIndex)
    const windowMs = Math.max(1, cfg.stalledMinutes) * 60_000
    if (fact.dispatched > 0) return null
    if (now - c.lastDispatchAt < windowMs) return null
    // 同一段停滞里只报一次，下一个完整窗口过去了才再报。
    if (c.stalledNotifiedAt !== null && now - c.stalledNotifiedAt < windowMs) return null

    c.stalledNotifiedAt = now
    const minutes = Math.round((now - c.lastDispatchAt) / 60_000)
    return makeAlertEvent({
      type: 'dispatchStalled',
      instanceIndex,
      at: now,
      reason:
        `已经 ${minutes} 分钟没有成功派出过采集队，最近一轮的结果是「${fact.message}」。` +
        '常见原因是兵力不够、行军队列一直占满，或搜索下限太高找不到合格资源点。',
      shotPath: null,
      detail: { outcome: fact.outcome, 停滞分钟: minutes }
    })
  }

  // ── 采样（开部队管理面板）──────────────────────────────────────────────

  /** 采样成功：掉线计数清零。 */
  noteSampleOk(instanceIndex: number): void {
    const c = this.of(instanceIndex)
    if (c.sampleFail > 0) {
      this.deps.log(
        'info',
        `[告警] 实例 ${instanceIndex} 采样恢复正常，连续采样失败计数由 ${c.sampleFail} 清零。`
      )
    }
    c.sampleFail = 0
  }

  /**
   * 采样失败：连续 N 次判定为「模拟器或游戏掉线」。
   *
   * ★ 调用方必须先把「实例上有脚本在跑（CONCURRENCY_LIMIT）」这种**正常的让路**过滤掉，
   *   那不是故障。
   */
  noteSampleFailed(instanceIndex: number, message: string): AlertEvent | null {
    const cfg = this.deps.config()
    const c = this.of(instanceIndex)
    c.sampleFail += 1
    this.deps.log(
      'warn',
      `[告警] 实例 ${instanceIndex} 采样失败计数 ${c.sampleFail}/${cfg.sampleFailThreshold}：${message}`
    )
    if (c.sampleFail < Math.max(1, cfg.sampleFailThreshold)) return null

    const times = c.sampleFail
    c.sampleFail = 0
    return makeAlertEvent({
      type: 'deviceOffline',
      instanceIndex,
      at: this.now(),
      reason:
        `连续 ${times} 次打不开部队管理面板，最后一次的原因是：${message}。` +
        '模拟器可能已经关闭或崩溃，也可能是 adb 掉线、游戏被系统杀掉了。',
      shotPath: null,
      detail: { 连续采样失败次数: times }
    })
  }
}
