/**
 * Telegram 机器人：让用户在手机上**点按钮 / 发命令**远程操作面板。
 *
 * 场景：半夜收到「疑似被顶号」推送，人在外面没法开电脑 —— 在消息下面点一下
 * 「重启游戏并恢复」就行，不用回来点面板。白天想看看号在不在正常挂着 —— 点底部
 * 菜单的「📷 截图」，选个账号，几秒后画面就发过来了。
 *
 * 实现要点：
 *   · 用 getUpdates **长轮询**（timeout=25s），不用 webhook —— 面板跑在家用电脑上没有公网地址。
 *   · 只响应配置里那一个 chatId 的会话。别的会话发来的按钮/命令一律忽略并记一次日志。
 *   · 动作本身由 deps.actions（BotActionPort，src/main/bot/actions.ts）提供，本文件只做
 *     「收消息 → 鉴权 → 解析 → 调 perform → 把 BotActionResult 发回去」。
 *   · 三种输入统一收敛成 (action, instanceIndex)：
 *       斜杠命令 `/shot 1`、底部菜单按钮文本「📷 截图」、内联按钮回调 `shot:1`。
 *     需要实例号却没给的动作，先发一组内联按钮让用户选账号（buildInstancePicker），点了再执行。
 *   · 长动作（截图 / 读资源统计要抢实例锁，可能 10~40s）：先 answerCallbackQuery「正在处理…」
 *     （Telegram 要求 10 秒内应答），再慢慢做，结果单独发一条。
 *   · 任何失败都不抛到外面：轮询循环自己退避重试；一次动作失败就把中文原因回给用户。
 *   · ★ token 只出现在 api() 里的 URL 上；所有日志与回给用户的文本都先过 scrubSecret。
 *   · 409 Conflict = 还有另一个进程在用同一个 token 轮询（比如开了两个面板），退避 60s 再试。
 */
import type { TelegramConfig } from '@shared/alerts'
import { scrubSecret, telegramApiUrl, validateTelegramConfig } from '@shared/alerts'
import type {
  BotAction,
  BotActionPort,
  BotActionResult,
  BotInlineKeyboard,
  BotPhoto,
  BotReplyKeyboard
} from '@shared/bot'
import {
  BOT_ACTION_SPECS,
  BOT_COMMAND_LIST,
  BOT_HELP_TEXT,
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_PHOTO_MAX_BYTES,
  actionOfCommand,
  buildInstancePicker,
  buildMenuKeyboard,
  commandOfButtonText,
  parseCallbackData
} from '@shared/bot'
import { describeThrown, resolveFetch, type FetchBody, type FetchLike } from './telegram'

/** 保住旧 import：动作枚举的权威现在在 @shared/bot。 */
export type { BotAction } from '@shared/bot'

export interface TelegramBotDeps {
  /** 取当前配置（用 getter：用户改完设置立刻生效）。 */
  config(): TelegramConfig
  /**
   * 动作执行器（通道层与动作层之间唯一的边界，见 @shared/bot 文件头）。
   * perform 抛异常也没关系：这里会兜住并把中文 message 回给用户。
   */
  actions: BotActionPort
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
  /** 离线自检注入用；不给就走 resolveFetch()。 */
  fetchImpl?: FetchLike
}

// ── Telegram 更新体（只声明用到的字段） ───────────────────────────────────

interface TgChat {
  id?: number | string
}
interface TgUser {
  id?: number | string
}
interface TgMessage {
  message_id?: number
  chat?: TgChat
  from?: TgUser
  text?: string
}
interface TgCallbackQuery {
  id?: string
  from?: TgUser
  message?: TgMessage
  data?: string
}
interface TgUpdate {
  update_id?: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
}
interface TgResponse {
  ok?: unknown
  description?: unknown
  result?: unknown
  error_code?: unknown
}

/** sendMessage 可以挂的两种键盘：内联按钮 或 底部回复键盘。 */
type ReplyMarkup = BotInlineKeyboard | BotReplyKeyboard

/** 长轮询每次最多等这么久（Telegram 侧 timeout 参数）。 */
const POLL_TIMEOUT_SEC = 25
/** 请求超时要比长轮询本身长，否则每次都会被自己掐断。 */
const POLL_HTTP_TIMEOUT_MS = (POLL_TIMEOUT_SEC + 10) * 1000
const ACTION_HTTP_TIMEOUT_MS = 15_000
/** 上传一张图片比发一条文本慢得多，单独给 30 秒。 */
const PHOTO_HTTP_TIMEOUT_MS = 30_000
/** 出错后的退避：1s 起翻倍，封顶 60s；409 直接 60s。 */
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 60_000
/** 单条文本按 4000 截断（Telegram 上限 4096，留余量）。 */
const TEXT_MAX = 4000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export class TelegramBot {
  private running = false
  private offset = 0
  private loopPromise: Promise<void> | null = null
  private abort: AbortController | null = null
  /** 已经为「未授权会话」记过日志的 chat id，避免被陌生人刷屏。 */
  private readonly warnedChats = new Set<string>()

  constructor(private readonly deps: TelegramBotDeps) {}

  isRunning(): boolean {
    return this.running
  }

  /** 按当前配置决定要不要跑。配置不满足就静默不跑（不是错误）。 */
  async start(): Promise<void> {
    if (this.running) return
    const cfg = this.deps.config()
    if (!cfg.enabled || !cfg.remoteControl) return
    if (validateTelegramConfig(cfg).length > 0) return
    this.running = true
    this.abort = new AbortController()
    await this.registerCommands()
    this.loopPromise = this.loop()
    this.log('info', 'Telegram 机器人已启动（长轮询），可在手机上用菜单按钮/命令远程操作。')
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.abort?.abort()
    try {
      await this.loopPromise
    } catch {
      // 循环自己兜异常，这里只是保险。
    }
    this.loopPromise = null
    this.abort = null
    this.log('info', 'Telegram 机器人已停止。')
  }

  /** 配置变了就重启一次：start() 会按新配置决定跑不跑。 */
  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  // ── 轮询 ───────────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    let backoff = BACKOFF_MIN_MS
    while (this.running) {
      try {
        const updates = await this.getUpdates()
        backoff = BACKOFF_MIN_MS
        for (const u of updates) {
          if (typeof u.update_id === 'number') this.offset = u.update_id + 1
          try {
            await this.handle(u)
          } catch (e) {
            this.log('warn', `处理一条 Telegram 更新时出错（已跳过）：${errText(e)}`)
          }
        }
      } catch (e) {
        if (!this.running) break
        const msg = errText(e)
        if (/409/.test(msg)) {
          this.log(
            'warn',
            '另有一个进程在用同一个 Bot Token 轮询（比如开了两个面板）。Telegram 只允许一个，60 秒后重试。'
          )
          backoff = BACKOFF_MAX_MS
        } else {
          this.log('warn', `Telegram 轮询失败，${Math.round(backoff / 1000)} 秒后重试：${msg}`)
        }
        await sleep(backoff)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    }
  }

  private async getUpdates(): Promise<TgUpdate[]> {
    const r = await this.api(
      'getUpdates',
      { offset: this.offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ['message', 'callback_query'] },
      POLL_HTTP_TIMEOUT_MS
    )
    return Array.isArray(r) ? (r as TgUpdate[]) : []
  }

  private async handle(u: TgUpdate): Promise<void> {
    if (u.callback_query) return this.onCallback(u.callback_query)
    if (u.message?.text) return this.onMessage(u.message)
  }

  // ── 鉴权 ───────────────────────────────────────────────────────────────

  private authorized(chatId: string): boolean {
    const want = this.deps.config().chatId.trim()
    if (want !== '' && chatId === want) return true
    if (!this.warnedChats.has(chatId)) {
      this.warnedChats.add(chatId)
      this.log('warn', `收到来自未授权会话 ${chatId} 的消息，已忽略（只响应配置里的 Chat ID）。`)
    }
    return false
  }

  // ── 按钮回调 ───────────────────────────────────────────────────────────

  private async onCallback(q: TgCallbackQuery): Promise<void> {
    const chatId = String(q.message?.chat?.id ?? '')
    const qid = typeof q.id === 'string' ? q.id : ''
    if (!this.authorized(chatId)) {
      if (qid) await this.answerCallback(qid, '未授权的会话。')
      return
    }
    const parsed = parseCallbackData(String(q.data ?? ''))
    if (!parsed) {
      if (qid) await this.answerCallback(qid, '不认识这个按钮。')
      return
    }
    // 先应答按钮（Telegram 要求 10 秒内），再慢慢做动作、把结果单独发一条。
    if (qid) {
      const spec = BOT_ACTION_SPECS[parsed.action]
      await this.answerCallback(qid, spec.touchesDevice ? '收到，正在操作模拟器，请稍等…' : '收到，正在处理…')
    }
    await this.run(chatId, parsed.action, parsed.instanceIndex)
  }

  // ── 命令 / 菜单按钮文本 ───────────────────────────────────────────────

  private async onMessage(m: TgMessage): Promise<void> {
    const chatId = String(m.chat?.id ?? '')
    if (!this.authorized(chatId)) return
    const text = (m.text ?? '').trim()
    if (text === '') return

    // ① 底部菜单按钮：Telegram 发来的就是按钮的字面量文本。
    const fromButton = commandOfButtonText(text)
    if (fromButton) return this.dispatchCommand(chatId, fromButton, null)

    // ② 斜杠命令 `/cmd [idx]`（群里会带 @botname 后缀，去掉）。
    if (!text.startsWith('/')) return
    const [cmdRaw, arg] = text.slice(1).split(/\s+/)
    const cmd = (cmdRaw ?? '').split('@')[0].toLowerCase()
    const idx = /^\d{1,4}$/.test(arg ?? '') ? Number(arg) : null

    if (cmd === 'help' || cmd === 'start') return this.dispatchCommand(chatId, cmd, null)
    const action = actionOfCommand(cmd)
    if (!action) {
      return this.sendText(chatId, `不认识的命令「/${cmd}」。\n${BOT_HELP_TEXT}`, buildMenuKeyboard())
    }
    return this.dispatchCommand(chatId, action, idx)
  }

  /**
   * 命令 → 动作。help/start 是本地命令（发说明 + 菜单键盘）；
   * required 动作没带实例号时先发账号选择按钮，其余直接执行。
   */
  private async dispatchCommand(chatId: string, cmd: BotAction | 'help' | 'start', idx: number | null): Promise<void> {
    if (cmd === 'help' || cmd === 'start') {
      return this.sendText(chatId, BOT_HELP_TEXT, buildMenuKeyboard())
    }
    const spec = BOT_ACTION_SPECS[cmd]
    if (spec.instance === 'required' && idx === null) {
      let list: Awaited<ReturnType<BotActionPort['listInstances']>>
      try {
        list = await this.deps.actions.listInstances()
      } catch (e) {
        return this.sendText(chatId, `取实例列表失败：${this.scrub(errText(e))}`)
      }
      if (list.length === 1) return this.run(chatId, cmd, list[0]!.index)
      if (list.length === 0) return this.sendText(chatId, '还没有任何可操作的实例。先到面板「账号」页绑定实例。')
      return this.sendText(chatId, `请选择账号（${spec.description}）：`, buildInstancePicker(cmd, list))
    }
    return this.run(chatId, cmd, idx)
  }

  /** 执行一个动作并把结果发回去。perform 抛出的中文原因兜住回给用户，绝不让异常逃出去。 */
  private async run(chatId: string, action: BotAction, idx: number | null): Promise<void> {
    let r: BotActionResult
    try {
      r = await this.deps.actions.perform(action, idx)
    } catch (e) {
      // 动作层拿不到 token，理论上不可能带出来；但回给用户的文本一律洗一遍，当最后一道保险。
      return this.sendText(chatId, `操作失败：${this.scrub(errText(e))}`)
    }
    if (r.photo) await this.sendPhoto(chatId, r.photo)
    if (r.text.trim() !== '') {
      const markup: ReplyMarkup | undefined = r.keyboard ?? (r.showMenu ? buildMenuKeyboard() : undefined)
      await this.sendText(chatId, r.text, markup)
    } else if (r.showMenu) {
      await this.sendText(chatId, '菜单已刷新。', buildMenuKeyboard())
    }
  }

  // ── Telegram API ───────────────────────────────────────────────────────

  private async registerCommands(): Promise<void> {
    try {
      await this.api('setMyCommands', { commands: BOT_COMMAND_LIST }, ACTION_HTTP_TIMEOUT_MS)
    } catch (e) {
      // 注册菜单失败不影响收发消息，只是手机上没有「/」下拉提示。
      this.log('warn', `注册机器人命令菜单失败（不影响使用）：${errText(e)}`)
    }
  }

  private async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    try {
      await this.api(
        'answerCallbackQuery',
        { callback_query_id: callbackQueryId, text: text.slice(0, 190) },
        ACTION_HTTP_TIMEOUT_MS
      )
    } catch (e) {
      this.log('warn', `应答按钮失败：${errText(e)}`)
    }
  }

  private async sendText(chatId: string, text: string, replyMarkup?: ReplyMarkup): Promise<void> {
    try {
      // ★ 绝不加 parse_mode，理由同 telegram.ts。
      await this.api(
        'sendMessage',
        {
          chat_id: chatId,
          text: text.slice(0, TEXT_MAX),
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {})
        },
        ACTION_HTTP_TIMEOUT_MS
      )
    } catch (e) {
      this.log('warn', `回复消息失败：${errText(e)}`)
    }
  }

  /**
   * 以图片形式发一张截图（sendPhoto，multipart 上传）。
   * ★ FormData 时不设 content-type，boundary 由 fetch 实现自己生成（见 telegram.ts 的 FetchBody）。
   * 超过 Telegram 10MB 硬限的直接退化成文字说明，不浪费一次请求。
   */
  private async sendPhoto(chatId: string, photo: BotPhoto): Promise<void> {
    const bytes = photo.jpeg.byteLength
    if (bytes > TELEGRAM_PHOTO_MAX_BYTES) {
      const mb = (bytes / 1024 / 1024).toFixed(1)
      return this.sendText(chatId, `截图 ${mb} MB 超过 Telegram 10MB 限制，没有发送。\n${photo.caption}`)
    }
    const fd = new FormData()
    fd.append('chat_id', chatId)
    fd.append('caption', photo.caption.slice(0, TELEGRAM_CAPTION_MAX))
    fd.append('photo', new Blob([new Uint8Array(photo.jpeg)], { type: 'image/jpeg' }), photo.filename)
    try {
      await this.api('sendPhoto', fd, PHOTO_HTTP_TIMEOUT_MS)
    } catch (e) {
      const why = errText(e)
      this.log('warn', `发送截图失败：${why}`)
      // 图发不出去也把说明文字发过去，用户至少知道现场信息与失败原因。
      await this.sendText(chatId, `截图发送失败：${why}\n${photo.caption}`)
    }
  }

  /**
   * 调一次 Bot API。失败抛 Error（message 已洗掉 token）。
   * payload 是 FormData 时走 multipart（不设 content-type），否则按 JSON 发。
   * ★ 这是本文件唯一持有含 token 的 URL 的地方。
   */
  private async api(method: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    const token = this.deps.config().botToken.trim()
    const url = telegramApiUrl(token, method)
    const doFetch = this.deps.fetchImpl ?? (await resolveFetch())
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = this.abort ? AbortSignal.any([timeout, this.abort.signal]) : timeout
    const isForm = payload instanceof FormData
    const body: FetchBody = isForm ? payload : JSON.stringify(payload)
    let status = 0
    let bodyText = ''
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: isForm ? {} : { 'content-type': 'application/json' },
        body,
        signal
      })
      status = res.status
      bodyText = await res.text()
    } catch (e) {
      // ★ undici 会把完整 URL（含 token）写进 error.message / cause，第一件事就洗。
      throw new Error(scrubSecret(`${method} 请求失败：${describeThrown(e)}`, token))
    }
    let parsed: TgResponse | null = null
    try {
      parsed = JSON.parse(bodyText) as TgResponse
    } catch {
      parsed = null
    }
    if (status >= 200 && status < 300 && parsed?.ok === true) return parsed.result
    const desc = typeof parsed?.description === 'string' ? parsed.description : bodyText.slice(0, 200)
    throw new Error(scrubSecret(`${method} 返回 HTTP ${status}：${desc}`, token))
  }

  /** 任何要回给用户的文本都过一遍：token 在文本里一律变成 ***。 */
  private scrub(text: string): string {
    return scrubSecret(text, this.deps.config().botToken)
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const safe = this.scrub(message)
    if (this.deps.log) this.deps.log(level, safe)
    else if (level === 'error' || level === 'warn') console.warn(`[alerts/bot] ${safe}`)
    else console.log(`[alerts/bot] ${safe}`)
  }
}
