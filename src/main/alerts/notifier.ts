/**
 * 通知中枢 NotifyHub —— 配置 + 限流去重 + 多通道分发。
 *
 * 【它管什么】
 *   · 持有 <dataDir>/alerts.json 里的那份 AlertsConfig（含 detect 阈值与 Telegram 配置）
 *   · 持有 AlertThrottle（按「实例 + 事件类型」冷却），并把它随配置一起落盘
 *   · 把一条 AlertEvent 按「开关 → 订阅 → 冷却」三道闸过滤后交给各通道发送
 *   · 注册并伺候三条 IPC：alerts:config / alerts:saveConfig / alerts:test
 *
 * 【它不管什么 ★】
 *   NotifyHub **不认识「暂停」这件事**。要不要暂停实例、暂停态怎么落盘、面板怎么标红，
 *   全部是 AlertCenter（center.ts）的职责。这条边界是故意的：
 *   将来加钉钉/飞书/邮件只动这一侧，暂停逻辑一行都不用碰；反过来改暂停判定也不会碰到凭据。
 *
 * 【★ 推送失败不得影响主流程】
 *   dispatch() **绝不抛异常**。通道的 send() 契约上就不抛，落盘失败也只记日志。
 *   调用方（AlertCenter）拿到结果只管记账：暂停该做还是要做。
 *
 * 【★★ 凭据纪律】
 *   本文件是唯一在主进程内存里持有明文 botToken 的地方（this.cfg.telegram.botToken）。
 *   往外的三个出口都已经堵死：
 *     · IPC   → 只回 toAlertsConfigView()（AlertsConfigView 的类型上根本没有 botToken 这个键）
 *     · 日志  → 只写 redactAlertsConfig()（token 已打码）
 *     · 给别的模块 → 只给 getDetectConfig()（AlertDetectConfig 里没有凭据），
 *                    绝不提供返回完整 AlertsConfig 的公开方法
 */

import type {
  AlertDetectConfig,
  AlertEvent,
  AlertsConfig,
  AlertsConfigPatch,
  AlertsConfigView,
  NotifyResult,
  TelegramConfig
} from '@shared/alerts'
import {
  ALERT_CH,
  AlertThrottle,
  defaultAlertsConfig,
  isSubscribed,
  mergeAlertsConfig,
  redactAlertsConfig,
  renderAlertSummary,
  renderSuppressedNote,
  skippedNotifyResult,
  toAlertsConfigView,
  validateTelegramConfig
} from '@shared/alerts'
import { AppError } from '@shared/errors'
import { handleAlerts, emitAlerts } from './ipc'
import { loadAlertsFile, saveAlertsFile } from './store'
import { TelegramNotifier } from './telegram'
import type { NotifierWithNote } from './telegram'

export interface NotifyHubDeps {
  /** 配置文件落在哪个目录（<dataDir>/alerts.json）。 */
  dataDir(): string
  /** 日志出口。★ 本类写进去的东西一律已经打码。 */
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
}

/** dispatch() 的返回值。★ 不含事件本身，调用方手里就有。 */
export interface DispatchOutcome {
  results: NotifyResult[]
  /**
   * 本条压根没有真的发出去（开关没开 / 未订阅 / 未配置 / 被冷却压掉）。
   * 判据是「一次网络尝试都没发生」（每条 result 的 attempts 都是 0）——
   * 比只看冷却更准，面板据此区分「没发」和「发了但失败」。
   */
  suppressed: boolean
}

export class NotifyHub {
  private deps: NotifyHubDeps | null = null
  private cfg: AlertsConfig = defaultAlertsConfig()
  private started = false
  private handlersRegistered = false

  /** ★ 冷却秒数用 getter 传进去，用户在设置页改完立刻生效，不用重建限流器。 */
  private readonly throttle = new AlertThrottle(() => this.cfg.telegram.cooldownSeconds)

  private readonly telegram = new TelegramNotifier({
    config: () => this.cfg.telegram,
    log: (level, message) => this.log(level, message)
  })

  /** 现在只有一条通道。加钉钉/飞书就往这个数组里再 push 一个实现，dispatch 一行都不用改。 */
  private readonly notifiers: NotifierWithNote[] = [this.telegram]

  private readonly configListeners = new Set<(view: AlertsConfigView) => void>()

  // ── 生命周期 ───────────────────────────────────────────────────────────

  /**
   * 读盘并就绪。重复调用直接返回（幂等）。
   *
   * ★ 读盘失败**不阻断启动**：从默认配置开始，面板照常能打开、能重新填配置。
   *   把一个坏掉的缓存文件变成"面板起不来"是最糟的处理方式。
   */
  async init(deps: NotifyHubDeps): Promise<void> {
    if (this.started) return
    this.deps = deps
    this.started = true
    try {
      const file = await loadAlertsFile(deps.dataDir())
      this.cfg = file.config
      // ★ 冷却快照跨重启恢复：不恢复的话，一个还卡在坏状态的实例会在每次重启后
      //   立刻再推一条 Telegram，用户重启几次就被轰炸几次。
      this.throttle.restore(file.throttle)
      for (const w of file.loadWarnings ?? []) this.log('warn', w)
      this.log(
        'info',
        `告警推送模块已就绪：${JSON.stringify(redactAlertsConfig(this.cfg))}`
      )
    } catch (e) {
      this.cfg = defaultAlertsConfig()
      this.log(
        'error',
        `读取告警配置失败，本次从默认配置开始（推送处于关闭状态，不影响别的功能）：${AppError.from(e).message}`
      )
    }
  }

  /** 退出前收尾：把冷却快照写下去。★ 不负责注销 IPC —— 那是 resetAlertsIpc() 的事，由接线层统一调。 */
  async stop(): Promise<void> {
    if (!this.started) return
    await this.persist()
    this.started = false
    this.handlersRegistered = false
    this.configListeners.clear()
  }

  // ── 配置 ───────────────────────────────────────────────────────────────

  /**
   * 给主进程内部模块（Telegram 机器人）取**含明文 token** 的当前配置。
   * ★ 绝不能经 IPC 送出去，也不要写进日志 —— 那些出口一律走 getConfigView()。
   */
  currentTelegramConfig(): TelegramConfig {
    return this.cfg.telegram
  }

  /** ★ 主进程往渲染进程送配置的唯一出口（token 已打码，且类型上就没有 botToken 这个键）。 */
  getConfigView(): AlertsConfigView {
    return toAlertsConfigView(this.cfg)
  }

  /**
   * 检测阈值（第一层兜底判定用）。
   * ★ 刻意只暴露 detect 这一半 —— 别的模块永远拿不到 telegram 那一半，也就拿不到凭据。
   */
  getDetectConfig(): AlertDetectConfig {
    return { ...this.cfg.detect }
  }

  /**
   * 改配置（部分字段），落盘并推给面板。
   *
   * ★ botToken 的三态语义由 mergeAlertsConfig 保证：
   *     不带这个键     → 保持原值（面板正常保存就是这样，改个冷却秒数不会把 token 抹掉）
   *     非空字符串     → 覆盖
   *     空字符串 ''    → 显式清空（面板上的「清除 Token」按钮才会送这个）
   */
  async saveConfig(patch: AlertsConfigPatch | undefined): Promise<AlertsConfigView> {
    const before = this.cfg
    this.cfg = mergeAlertsConfig(before, patch)
    await this.persist()
    const view = this.getConfigView()
    // ★ 日志里只写打码后的配置，永远不写 patch 本体（patch 里可能就是一个明文 token）。
    this.log('info', `告警配置已更新：${JSON.stringify(redactAlertsConfig(this.cfg))}`)
    emitAlerts('alerts:configChanged', view)
    for (const cb of this.configListeners) {
      try {
        cb(view)
      } catch (e) {
        this.log('warn', `告警配置变更回调抛异常，已忽略：${AppError.from(e).message}`)
      }
    }
    return view
  }

  /** 订阅配置变更（detect 阈值改了时 center.ts 要跟着走）。返回退订函数。 */
  onConfigChanged(cb: (view: AlertsConfigView) => void): () => void {
    this.configListeners.add(cb)
    return () => this.configListeners.delete(cb)
  }

  // ── 测试推送 ───────────────────────────────────────────────────────────

  /**
   * 设置页「测试推送」按钮。
   *
   * ★ 先做本地体检（token/chatId 形状），有问题就**不发请求**直接回中文原因 ——
   *   让用户等 15 秒超时再告诉他"token 是空的"是很差的体验。
   * ★ 绕过订阅过滤与冷却：测试就是要立刻能看到结果。
   */
  async test(): Promise<NotifyResult> {
    const problems = validateTelegramConfig(this.cfg.telegram)
    if (problems.length > 0) {
      return skippedNotifyResult('telegram', 'notConfigured', problems.join('；'))
    }
    const r = await this.telegram.test()
    this.log(r.ok ? 'info' : 'warn', `测试推送${r.ok ? '成功' : '失败'}：${r.message}`)
    return r
  }

  // ── 分发 ───────────────────────────────────────────────────────────────

  /**
   * 把一条事件推出去。**绝不抛异常。**
   *
   * 三道闸，顺序不能换：
   *   1. 开关没开 / 没配置完整 → 不发（由通道自己判，返回 disabled / notConfigured）
   *   2. 这类事件没被订阅       → 不发（订阅是"推不推"的开关，不影响"暂不暂停"）
   *   3. 冷却期内               → 不发，只把压制计数 +1；下次放行时会把
   *                               「冷却期内还发生过 N 次同类事件」拼进正文
   */
  async dispatch(event: AlertEvent): Promise<DispatchOutcome> {
    const results: NotifyResult[] = []

    if (!this.cfg.telegram.enabled) {
      results.push(
        skippedNotifyResult(
          'telegram',
          'disabled',
          'Telegram 推送开关没有打开，本条只记录在面板里，没有发出去。'
        )
      )
      return this.finishDispatch(event, results)
    }

    if (!isSubscribed(this.cfg.telegram, event.type)) {
      results.push(
        skippedNotifyResult(
          'telegram',
          'unsubscribed',
          `「${event.type}」这类事件没有被订阅推送（可在设置页勾上）。`
        )
      )
      return this.finishDispatch(event, results)
    }

    const decision = this.throttle.check(event.dedupeKey)
    if (!decision.allow) {
      this.throttle.markSuppressed(event.dedupeKey)
      results.push(
        skippedNotifyResult(
          'telegram',
          'throttled',
          `${decision.reason}，本条只记录未推送（累计已压掉 ${decision.suppressedCount + 1} 条）。`
        )
      )
      // 压制计数变了要落盘，否则重启后计数丢失、用户看不到"期间又出了几次"。
      return this.finishDispatch(event, results)
    }

    // 放行。把「冷却期内还发生过 N 次」补在正文尾巴上（那句话属于这一次发送，
    // 不属于事件本身 —— 写进 event.reason 会污染面板历史和去重键）。
    const note = renderSuppressedNote(decision.suppressedCount)
    let anyOk = false
    for (const n of this.notifiers) {
      let r: NotifyResult
      try {
        r = await n.send(event, note || undefined)
      } catch (e) {
        // 通道契约上就不该抛。真抛了也不能让主流程跟着倒 —— 兜住，记账，继续。
        r = skippedNotifyResult(
          n.id,
          'unknown',
          `${n.label} 通道内部异常（这属于程序 bug，请把日志发给开发）：${AppError.from(e).message}`
        )
        this.log('error', `${n.label} 通道的 send() 抛了异常，已兜住：${AppError.from(e).message}`)
      }
      results.push(r)
      if (r.ok) anyOk = true
    }

    // ★ 只有真的发出去了才重置冷却起点。失败就不重置 —— 否则一次失败会白白吃掉
    //   10 分钟的冷却窗口，等于把这条告警彻底吞了。
    if (anyOk) this.throttle.markSent(event.dedupeKey)

    return this.finishDispatch(event, results)
  }

  /** 收尾：落盘冷却快照 + 记一行日志。 */
  private async finishDispatch(
    event: AlertEvent,
    results: NotifyResult[]
  ): Promise<DispatchOutcome> {
    const suppressed = results.length > 0 && results.every((r) => r.attempts === 0)
    await this.persist()
    const detail = results.map((r) => `${r.channel}:${r.ok ? 'ok' : (r.failure ?? 'fail')}`).join(' ')
    this.log(
      results.some((r) => r.ok) ? 'info' : 'warn',
      `告警推送 ${suppressed ? '未发送' : results.some((r) => r.ok) ? '已发送' : '发送失败'}` +
        `｜${renderAlertSummary(event)}｜${detail}`
    )
    return { results, suppressed }
  }

  // ── 冷却维护 ───────────────────────────────────────────────────────────

  /** 实例恢复正常时清掉它的全部冷却，下次再出事能立刻推。 */
  async resetThrottleForInstance(instanceIndex: number): Promise<void> {
    this.throttle.resetInstance(instanceIndex)
    await this.persist()
  }

  /** 排障用：当前的冷却快照（键是 `实例:事件类型`）。 */
  snapshotThrottle(): Record<string, { lastSentAt: number; suppressedCount: number; lastSuppressedAt: number | null }> {
    return this.throttle.snapshot()
  }

  // ── IPC ────────────────────────────────────────────────────────────────

  /**
   * 注册本模块负责的三条通道。
   *
   * ★ 分工（handleAlerts 有重复注册检查，划错会在启动时立刻抛，不会静默覆盖）：
   *     本类           alerts:config / alerts:saveConfig / alerts:test
   *     AlertCenter    alerts:pauses / alerts:resume / alerts:history
   */
  registerConfigHandlers(): void {
    if (this.handlersRegistered) return
    this.handlersRegistered = true
    handleAlerts(ALERT_CH.config, () => this.getConfigView())
    handleAlerts(ALERT_CH.saveConfig, (patch) => this.saveConfig(patch))
    handleAlerts(ALERT_CH.test, () => this.test())
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  /** 落盘。★ 失败只记日志不抛 —— 存不下配置不该让推送/暂停跟着失败。 */
  private async persist(): Promise<void> {
    if (!this.deps) return
    try {
      await saveAlertsFile(this.deps.dataDir(), {
        version: 1,
        config: this.cfg,
        throttle: this.throttle.snapshot()
      })
    } catch (e) {
      this.log('error', `保存告警配置失败：${AppError.from(e).message}`)
    }
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    if (this.deps?.log) this.deps.log(level, message)
    else if (level === 'error' || level === 'warn') console.warn(`[alerts] ${message}`)
    else console.log(`[alerts] ${message}`)
  }
}

let singleton: NotifyHub | null = null

/** 全局唯一的通知中枢。主进程在 bootstrap 里 init 一次。 */
export function getNotifyHub(): NotifyHub {
  if (!singleton) singleton = new NotifyHub()
  return singleton
}

/** 仅供测试：丢掉单例。生产代码不要调。 */
export function resetNotifyHubForTest(): void {
  singleton = null
}
