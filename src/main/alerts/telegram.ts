/**
 * Telegram 推送通道（Notifier 的第一个实现）。
 *
 * 只做一件事：把一条 AlertEvent 变成一条 Telegram 消息发出去，并把失败翻译成中文。
 * 它**不认识**「暂停」「实例」「调度器」这些概念 —— 那些是 notifier.ts / center.ts 的事。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【★★ 凭据纪律：读这个文件之前先读这一段】
 *
 * Telegram Bot API 的 token 就长在 URL 路径里：
 *     https://api.telegram.org/bot<TOKEN>/sendMessage
 * 这意味着**任何**把 URL 带出去的动作都是一次凭据泄漏：
 *   · Node 的 undici 在传输层失败时会把完整 URL 写进 error.message
 *     （形如 "TypeError: fetch failed ... https://api.telegram.org/bot123:AAE.../sendMessage"）
 *   · 错误对象的 cause 链里同样可能带 URL
 *   · console.log(err) / String(err) / err.stack 一律会带出来
 *
 * 所以本文件的铁律是：
 *   1. URL 只在 doPost() 内部存在，**绝不**作为参数往外传、绝不进任何返回值
 *   2. 每一处 catch 的第一件事就是 scrubSecret(String(e), token)，之后才允许它出现在
 *      message / 日志 / 抛出的异常里
 *   3. send() / test() **绝不抛异常** —— 一切失败都走返回值。异常一旦逃出去，
 *      栈里可能带 URL，还会被 ipc.ts 原样编码过桥推给渲染进程
 *   4. 本文件的 log() 出口统一过一次 scrubSecret，当作最后一道保险
 *
 * 自查方法（改完这个文件请跑一遍）：
 *     grep -n "botToken\|telegramApiUrl\|url" src/main/alerts/telegram.ts
 * 每一处都要能说清「它为什么不会流到外面去」。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 【为什么不开 parse_mode】
 * 账号名和错误原因里随时可能出现 `_ * [ ]`（例如「主号-王朝A_区」）。一旦开了
 * Markdown/HTML parse_mode，Telegram 会返回 400 "can't parse entities"，
 * 表现为「测试推送能通、真出事的时候推不出去」—— 最坏的一类 bug，只在真需要它时坏掉。
 * 所以一律发纯文本，请求体里**没有** parse_mode 这个字段。
 */

import type {
  AlertEvent,
  NotifyFailureKind,
  NotifyResult,
  Notifier,
  TelegramConfig
} from '@shared/alerts'
import {
  NOTIFIER_LABEL,
  describeTelegramFailure,
  isRetriableFailure,
  isTelegramReady,
  makeAlertEvent,
  pausesInstance,
  renderAlertText,
  scrubSecret,
  skippedNotifyResult,
  telegramApiUrl,
  validateTelegramConfig
} from '@shared/alerts'
import type { BotInlineKeyboard } from '@shared/bot'
import { TELEGRAM_CAPTION_MAX, TELEGRAM_PHOTO_MAX_BYTES } from '@shared/bot'

// ── 内部 HTTP 抽象 ────────────────────────────────────────────────────────
//
// ★ 刻意不用全局的 RequestInit / Response 类型：@types/node 的 undici 类型与 electron
//   的类型在同一个工程里都存在，直接引用会打架。这里只声明真正用到的那几个字段。

interface HttpResponse {
  readonly status: number
  text(): Promise<string>
}

/**
 * 请求体的两种形态：
 *   · string   —— JSON（sendMessage / getUpdates / setMyCommands …），调用方自己设 content-type
 *   · FormData —— multipart（sendPhoto 上传图片）。★ 用 FormData 时**绝不**手动设 content-type：
 *     boundary 是 fetch 实现在序列化时自己生成的，手写的 content-type 里没有 boundary，
 *     Telegram 会回 400 "Bad Request: there is no photo in the request"。
 * Node 22+ 与 Electron 都有全局 FormData / Blob，electron 的 net.fetch 与 undici 行为一致。
 */
export type FetchBody = string | FormData

export type FetchLike = (
  url: string,
  init: {
    method: string
    /** JSON 请求带 content-type；multipart 请求这里为空对象或省略。 */
    headers?: Record<string, string>
    body: FetchBody
    signal: AbortSignal
  }
) => Promise<HttpResponse>

let cachedFetch: FetchLike | null = null

/**
 * 挑一个 fetch 实现。
 *
 * 优先用 Electron 的 net.fetch：它走 Chromium 的网络栈，**会遵守系统/应用的代理设置**。
 * 这对本工程是刚需 —— 国内直连 api.telegram.org 基本不通，用户十有八九挂着代理，
 * 而 Node 内置的 fetch（undici）默认**不读** HTTP_PROXY/HTTPS_PROXY 环境变量，
 * 会表现成「浏览器能开 Telegram，面板却报网络不通」。
 *
 * 拿不到 electron（例如离线自检脚本在纯 node 里跑）就回落到全局 fetch。
 * 两者都没有才报错 —— 那说明运行环境实在太老，属于配置问题而不是网络问题。
 */
export async function resolveFetch(): Promise<FetchLike> {
  if (cachedFetch) return cachedFetch
  try {
    const mod = (await import('electron')) as { net?: { fetch?: unknown } }
    const f = mod.net?.fetch
    if (typeof f === 'function') {
      cachedFetch = f.bind(mod.net) as FetchLike
      return cachedFetch
    }
  } catch {
    // 不在 Electron 里（离线自检脚本），静默回落。这不是错误。
  }
  const g = (globalThis as { fetch?: unknown }).fetch
  if (typeof g === 'function') {
    cachedFetch = g as FetchLike
    return cachedFetch
  }
  throw new Error('当前运行环境没有可用的 fetch 实现，无法发送 Telegram 推送。')
}

/** 单元测试/离线自检可以塞一个假的进来；传 null 恢复自动挑选。 */
export function setTelegramFetch(impl: FetchLike | null): void {
  cachedFetch = impl
}

// ── 重试节奏 ──────────────────────────────────────────────────────────────

/** 429 时最多按对方要求等这么久；再长就不值得把主流程卡在这里了。 */
const MAX_RETRY_AFTER_MS = 60_000
/**
 * ★ 整轮重试的等待时间上限。
 *
 * dispatch() 会在调度器的实例锁内被 await（见 center.ts 的 raise → hub.dispatch），
 * 所以推送**不能**无限期地把主流程扣在这里。retryCount 最大是 5，若每次都按
 * 对方要求的 60 秒等，就是 5 分钟 —— 那期间这个实例什么都干不了。
 * 累计等待超过这个上限就不再重试，直接返回失败（失败原因照样是中文的，照样进面板）。
 */
const MAX_TOTAL_RETRY_WAIT_MS = 60_000
/** 非限流类失败（网络抖动 / 5xx）的退避阶梯，单位毫秒。 */
const BACKOFF_LADDER_MS = [1_000, 2_000, 4_000, 8_000, 8_000]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// ── 单次尝试的结果 ────────────────────────────────────────────────────────

interface Attempt {
  ok: boolean
  kind: NotifyFailureKind | null
  /** ★ 已经过 scrubSecret 的中文说明。 */
  message: string
  retryAfterSec: number | null
}

/** Telegram 响应体里我们关心的那几个字段。 */
interface TelegramBody {
  ok?: unknown
  description?: unknown
  parameters?: { retry_after?: unknown }
}

function parseBody(text: string): TelegramBody | null {
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null ? (v as TelegramBody) : null
  } catch {
    // Telegram 正常情况下一定回 JSON。回了别的（比如代理吐了一张 HTML 错误页）
    // 就当"没有 description"，交给状态码去分类。
    return null
  }
}

/**
 * 把一次 HTTP 结果翻译成分类 + 中文原因。
 *
 * 中文话术的**唯一权威**是 @shared/alerts 的 describeTelegramFailure()，这里只补一种
 * 它没覆盖的情况：HTTP 404。Telegram 对「token 里那串数字 id 根本不存在」返回的是
 * 404 Not Found（而不是 401），落到 describeTelegramFailure 的兜底分支会说成
 * 「推送失败（HTTP 404）」—— 用户看了不知道该改哪。所以这一种在这里单独给话术。
 */
function classify(
  status: number | null,
  description: string | null,
  retryAfterSec: number | null,
  transportError: string | null
): { kind: NotifyFailureKind; message: string } {
  if (status === 404) {
    return {
      kind: 'badToken',
      message:
        'Bot Token 无效（Telegram 返回 404 Not Found，说明这个 token 对应的机器人不存在）。' +
        '请回到 @BotFather 用 /mybots 选中你的机器人、点 API Token 重新复制一次，' +
        '注意只复制冒号两边那一整串，不要带上「HTTP API:」这几个字，也不要有多余空格或换行。'
    }
  }
  return describeTelegramFailure({ status, description, retryAfterSec, transportError })
}

// ── 内联按钮 ──────────────────────────────────────────────────────────────

/**
 * Telegram 内联键盘（只用到 callback_data 这一种按钮）。
 * ★ 形状的唯一权威在 @shared/bot 的 BotInlineKeyboard，这里只是别名，保住旧 import。
 */
export type InlineKeyboard = BotInlineKeyboard

/**
 * 按事件类型决定要不要在消息下面挂操作按钮。
 * 会暂停实例的事件（顶号 / 掉线 / 连续失败…）挂「恢复」「重启游戏并恢复」「查看状态」；
 * 「已恢复」只挂「查看状态」。callback_data 形如 `resume:0`，≤64 字节，由 telegramBot.ts 解析。
 * ★ 远程控制开关关着、或事件不针对具体实例（测试推送的 -1）时不挂。
 */
export function buildInlineKeyboard(event: AlertEvent, cfg: TelegramConfig): InlineKeyboard | undefined {
  if (!cfg.remoteControl || event.instanceIndex < 0) return undefined
  const i = event.instanceIndex
  if (pausesInstance(event.type)) {
    return {
      inline_keyboard: [
        [{ text: '▶️ 恢复自动调度', callback_data: `resume:${i}` }],
        [{ text: '🔁 重启游戏并恢复', callback_data: `relaunch:${i}` }],
        [{ text: '📊 查看状态', callback_data: `status:${i}` }]
      ]
    }
  }
  if (event.type === 'instanceResumed') {
    return { inline_keyboard: [[{ text: '📊 查看状态', callback_data: `status:${i}` }]] }
  }
  return undefined
}

// ── 通道实现 ──────────────────────────────────────────────────────────────

export interface TelegramNotifierDeps {
  /**
   * 取当前 Telegram 配置。
   * ★ 用 getter 而不是构造时快照：用户在设置页改完立刻生效，不用重建实例。
   */
  config(): TelegramConfig
  /** 日志出口（可选）。★ 本类调用它之前一定已经过 scrubSecret。 */
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
}

/**
 * 可以附带一句补充说明的通道。
 *
 * Notifier 接口（已冻结在 @shared/alerts）只有 send(event)。但限流器需要在放行时
 * 往正文尾巴上补一句「冷却期内还发生过 N 次同类事件」，那句话属于**这一次发送**、
 * 不属于事件本身（写进 event.reason 会污染面板历史与去重键）。
 * 所以这里把它做成一个可选的第二参数：多一个可选参数的方法**仍然满足** Notifier，
 * 只认 Notifier 的调用方一行都不用改。
 */
export interface NotifierWithNote extends Notifier {
  send(event: AlertEvent, note?: string): Promise<NotifyResult>
}

export class TelegramNotifier implements NotifierWithNote {
  readonly id = 'telegram' as const
  readonly label = NOTIFIER_LABEL.telegram

  constructor(private readonly deps: TelegramNotifierDeps) {}

  /** 开关开着且 token/chatId 形状都对。 */
  isReady(): boolean {
    return isTelegramReady(this.deps.config())
  }

  /**
   * 发一条告警。**绝不抛异常** —— 推送失败不得影响主流程（该暂停还是要暂停）。
   *
   * @param note 可选的补充说明，拼在正文最后一行（限流器的「期间还发生过 N 次」走这里）。
   */
  async send(event: AlertEvent, note?: string): Promise<NotifyResult> {
    const cfg = this.deps.config()
    if (!cfg.enabled) {
      return skippedNotifyResult(
        'telegram',
        'disabled',
        'Telegram 推送开关没有打开，本条只记录未发送。'
      )
    }
    const problems = validateTelegramConfig(cfg)
    if (problems.length > 0) {
      return skippedNotifyResult('telegram', 'notConfigured', problems.join('；'))
    }
    const body = note ? `${renderAlertText(event)}\n${note}` : renderAlertText(event)
    return this.postWithRetry(
      'sendMessage',
      () => textPayload(cfg.chatId.trim(), body, buildInlineKeyboard(event, cfg)),
      cfg
    )
  }

  /**
   * 以**图片**形式发一张截图（Bot API 的 sendPhoto，multipart 上传）。**绝不抛异常**。
   *
   * 与 send() 共用同一套重试节奏与中文失败话术（badToken / badChat / rateLimited / network …）。
   * ★ 每次尝试都重新构造一个 FormData —— multipart 流只能被 fetch 消费一次，复用会在重试时发空包。
   * ★ 图片超过 Telegram 的 10MB 硬限直接返回失败并说明，不浪费一次请求。
   *
   * @param chatId  目标会话；传空串用配置里的 chatId（告警通道的默认收件人）。
   * @param jpeg    JPEG 字节（调用方已按 BOT_PHOTO_MAX_WIDTH / BOT_PHOTO_JPEG_QUALITY 降采样）。
   * @param caption 中文说明，超过 TELEGRAM_CAPTION_MAX 会被截断。
   * @param filename multipart 的文件名（只影响 Telegram 客户端里显示的名字）。
   */
  async sendPhoto(
    chatId: string,
    jpeg: ArrayBuffer | Uint8Array,
    caption: string,
    filename = 'shot.jpg'
  ): Promise<NotifyResult> {
    const cfg = this.deps.config()
    const problems = validateTelegramConfig(cfg)
    if (problems.length > 0) {
      return skippedNotifyResult('telegram', 'notConfigured', problems.join('；'))
    }
    const bytes = jpeg.byteLength
    if (bytes > TELEGRAM_PHOTO_MAX_BYTES) {
      const mb = (bytes / 1024 / 1024).toFixed(1)
      return {
        ok: false,
        channel: 'telegram',
        failure: 'unknown',
        message: `截图 ${mb} MB 超过 Telegram 10MB 限制，没有发送。请把截图降采样后再试。`,
        attempts: 0,
        elapsedMs: 0,
        at: Date.now(),
        retryAfterSec: null
      }
    }
    const target = chatId.trim() || cfg.chatId.trim()
    return this.postWithRetry('sendPhoto', () => photoPayload(target, jpeg, caption, filename), cfg)
  }

  /**
   * 「测试推送」按钮。发一条合成的 test 事件，绕过订阅过滤与冷却（那两层在 NotifyHub 里）。
   * 同样**绝不抛异常**。
   */
  async test(): Promise<NotifyResult> {
    const cfg = this.deps.config()
    // ★ 测试推送刻意**不看** enabled：用户的操作顺序通常是"先填 token → 点测试 → 再打开开关"，
    //   要求先打开开关才能测，等于逼他在配置还没验证过的时候就开着推送。
    const problems = validateTelegramConfig(cfg)
    if (problems.length > 0) {
      return skippedNotifyResult('telegram', 'notConfigured', problems.join('；'))
    }
    // ★ instanceIndex 用 -1：测试推送不针对任何真实实例，用 0 会让人以为 0 号出事了。
    //   正文里那行「实例 -1（测试）」看着有点怪，所以下面补一句话解释它。
    const event = makeAlertEvent({
      type: 'test',
      instanceIndex: -1,
      reason: '这是一条来自万龙控制面板的测试推送',
      accountName: '测试'
    })
    const body = `${renderAlertText(event)}\n（实例号 -1 表示这条不针对任何具体实例，是设置页「测试推送」按钮发出来的。）`
    const r = await this.postWithRetry('sendMessage', () => textPayload(cfg.chatId.trim(), body), cfg)
    if (r.ok) {
      return { ...r, message: '已推送到 Telegram，去手机上看一眼是不是收到了。' }
    }
    return r
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  /**
   * 发送 + 重试。只对可重试的失败重试（token/chat 配错了重试一万次也没用）。
   *
   * @param method   Bot API 方法名（sendMessage / sendPhoto）。
   * @param payload  每次尝试都重新生成请求体：JSON 字符串可以复用，但 FormData 只能消费一次。
   */
  private async postWithRetry(
    method: string,
    payload: () => FetchBody,
    cfg: TelegramConfig
  ): Promise<NotifyResult> {
    const startedAt = Date.now()
    const maxAttempts = 1 + Math.max(0, cfg.retryCount)
    let waited = 0
    /**
     * ★ 真正发出去的请求次数。
     *   以前这里失败时一律回 maxAttempts，于是「token 配错了，只发了 1 次就放弃重试」
     *   在面板上会显示成「尝试 3 次」—— 用户会以为网络在反复重试，排错方向直接跑偏。
     *   现在只记实际打出去的次数。
     */
    let tried = 0
    let last: Attempt = {
      ok: false,
      kind: 'unknown',
      message: '推送没有真正发出去（没有执行任何一次尝试）。',
      retryAfterSec: null
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      last = await this.doPost(method, payload(), cfg)
      tried = attempt
      if (last.ok) {
        return {
          ok: true,
          channel: 'telegram',
          failure: null,
          message:
            attempt === 1
              ? '已推送到 Telegram。'
              : `已推送到 Telegram（第 ${attempt} 次尝试成功）。`,
          attempts: attempt,
          elapsedMs: Date.now() - startedAt,
          at: Date.now(),
          retryAfterSec: null
        }
      }

      const kind = last.kind ?? 'unknown'
      if (attempt >= maxAttempts || !isRetriableFailure(kind)) {
        if (!isRetriableFailure(kind) && attempt < maxAttempts) {
          this.log('warn', `Telegram 推送失败且重试无意义（${kind}），不再重试：${last.message}`)
        }
        break
      }

      // 等多久：429 听对方的（封顶 60s），其余走退避阶梯。
      const wantMs =
        kind === 'rateLimited' && last.retryAfterSec != null
          ? Math.min(Math.max(1, last.retryAfterSec) * 1000, MAX_RETRY_AFTER_MS)
          : (BACKOFF_LADDER_MS[Math.min(attempt - 1, BACKOFF_LADDER_MS.length - 1)] ?? 4_000)

      if (waited + wantMs > MAX_TOTAL_RETRY_WAIT_MS) {
        this.log(
          'warn',
          `Telegram 推送重试累计等待已超过 ${Math.round(MAX_TOTAL_RETRY_WAIT_MS / 1000)} 秒，` +
            `不再继续重试（避免把主流程卡住）。最后一次的原因：${last.message}`
        )
        break
      }
      waited += wantMs
      this.log(
        'info',
        `Telegram 推送第 ${attempt} 次失败（${kind}），${Math.round(wantMs / 1000)} 秒后重试。`
      )
      await sleep(wantMs)
    }

    return {
      ok: false,
      channel: 'telegram',
      failure: last.kind ?? 'unknown',
      message: last.message,
      attempts: tried,
      elapsedMs: Date.now() - startedAt,
      at: Date.now(),
      retryAfterSec: last.retryAfterSec
    }
  }

  /**
   * 单次 HTTP 请求。**不抛异常**，一切失败都变成 Attempt。
   *
   * ★★ 这是整个模块唯一持有含 token 的 URL 的地方。url 这个局部变量
   *    既不进日志、也不进返回值、更不作为参数往外传。所有 catch 都先 scrubSecret。
   */
  private async doPost(method: string, body: FetchBody, cfg: TelegramConfig): Promise<Attempt> {
    const token = cfg.botToken.trim()
    // ★ 含 token。作用域仅限本函数。
    const url = telegramApiUrl(token, method)

    let res: HttpResponse
    try {
      const doFetch = await resolveFetch()
      res = await doFetch(url, {
        method: 'POST',
        // ★ FormData 时不设 content-type（boundary 由 fetch 自己生成），见 FetchBody 的说明。
        headers: typeof body === 'string' ? { 'content-type': 'application/json' } : {},
        body,
        // 图片上传比一条文本慢得多，超时至少给 30 秒。
        signal: AbortSignal.timeout(typeof body === 'string' ? cfg.timeoutMs : Math.max(cfg.timeoutMs, 30_000))
      })
    } catch (e) {
      // ★★ 泄漏高危点 1：undici 会把完整 URL（含 token）写进 error.message 与 cause。
      //    这里是**第一件事**就洗，洗完的字符串才允许继续往下走。
      const raw = scrubSecret(describeThrown(e), token)
      const { kind, message } = classify(null, null, null, raw)
      return { ok: false, kind, message: scrubSecret(message, token), retryAfterSec: null }
    }

    let bodyText = ''
    try {
      bodyText = await res.text()
    } catch (e) {
      // ★★ 泄漏高危点 2：读响应体中途断流，抛出来的错一样可能带 URL。
      const raw = scrubSecret(describeThrown(e), token)
      return {
        ok: false,
        kind: 'network',
        message: `已经连上 Telegram，但读取响应中途断开了。底层报错：${raw}`,
        retryAfterSec: null
      }
    }

    const parsed = parseBody(bodyText)
    if (res.status >= 200 && res.status < 300 && parsed?.ok === true) {
      return { ok: true, kind: null, message: '已推送到 Telegram。', retryAfterSec: null }
    }

    const description = typeof parsed?.description === 'string' ? parsed.description : null
    const retryAfterRaw = parsed?.parameters?.retry_after
    const retryAfterSec =
      typeof retryAfterRaw === 'number' && Number.isFinite(retryAfterRaw) ? retryAfterRaw : null

    const { kind, message } = classify(res.status, description, retryAfterSec, null)
    // ★ Telegram 的 description 理论上不会回显 token，但这条 message 会一路走到面板与日志，
    //   多洗一次成本为零。
    return { ok: false, kind, message: scrubSecret(message, token), retryAfterSec }
  }

  /** ★ 统一日志出口。这里再洗一次 token，当作最后一道保险。 */
  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const safe = scrubSecret(message, this.deps.config().botToken)
    if (this.deps.log) this.deps.log(level, safe)
    else if (level === 'error' || level === 'warn') console.warn(`[alerts/telegram] ${safe}`)
    else console.log(`[alerts/telegram] ${safe}`)
  }
}

// ── 请求体工厂 ────────────────────────────────────────────────────────────

/** sendMessage 的 JSON 请求体。★ 绝不加 parse_mode：见文件头「为什么不开 parse_mode」。 */
function textPayload(chatId: string, text: string, replyMarkup?: InlineKeyboard): string {
  return JSON.stringify({
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  })
}

/**
 * sendPhoto 的 multipart 请求体。
 * 每次调用都新建 FormData（重试时不能复用已被消费的流）。
 */
function photoPayload(
  chatId: string,
  jpeg: ArrayBuffer | Uint8Array,
  caption: string,
  filename: string
): FormData {
  const fd = new FormData()
  fd.append('chat_id', chatId)
  fd.append('caption', caption.slice(0, TELEGRAM_CAPTION_MAX))
  fd.append('photo', new Blob([toUint8(jpeg)], { type: 'image/jpeg' }), filename)
  return fd
}

/**
 * ArrayBuffer / Uint8Array 统一成 Uint8Array<ArrayBuffer>（TS 的 BlobPart 不收 SharedArrayBuffer 背书的视图）。
 * 底层已经是普通 ArrayBuffer 的视图直接复用；否则拷一份（截图 ≤10MB，拷贝代价可忽略）。
 */
function toUint8(v: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  if (v instanceof Uint8Array) {
    return v.buffer instanceof ArrayBuffer ? (v as Uint8Array<ArrayBuffer>) : new Uint8Array(v)
  }
  return new Uint8Array(v)
}

/**
 * 把一个 catch 到的东西压成一行字。
 *
 * ★ 刻意**只取 message，不取 stack** —— 栈里同样可能带含 token 的 URL，而且对用户毫无意义。
 *   cause 链要取（undici 的真实原因如 ENOTFOUND / ECONNREFUSED 都在 cause 里），
 *   但最多跟两层，避免拼出一长串。调用方拿到之后还会再过一次 scrubSecret。
 */
export function describeThrown(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const parts: string[] = [e.message]
  let cur: unknown = (e as { cause?: unknown }).cause
  for (let i = 0; i < 2 && cur; i += 1) {
    if (cur instanceof Error) {
      const code = (cur as { code?: unknown }).code
      parts.push(typeof code === 'string' ? `${cur.message}（${code}）` : cur.message)
      cur = (cur as { cause?: unknown }).cause
    } else {
      parts.push(String(cur))
      break
    }
  }
  return parts.join(' ← ')
}
