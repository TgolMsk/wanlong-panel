/**
 * 异常检测 / 自动暂停 / Telegram 推送的**离线**自检。
 *
 * ★★ 全程不碰模拟器、不发一条 adb 命令、不发一个真实网络请求：
 *     · 设备接口是假的（resolveDevice 直接抛「adb 连不上」）
 *     · fetch 是假的（setTelegramFetch 注入，请求全部记在内存里）
 *     · 数据目录是 os.tmpdir() 下的临时目录，跑完就扔
 *
 * 跑法（工程根目录）：
 *     npm run check:alerts
 *
 * 覆盖的东西：
 *   一、失败计数与阈值（含「队列满不是故障」这条最容易误报的）
 *   二、第二层顶号识别在模板缺失时静默降级
 *   三、Telegram 通道：四类失败各自的中文话术、重试与不可重试、attempts 计数
 *   四、★ token 泄露实测：把含 token 的 URL 塞进 message / cause / stack / 响应体，
 *       逐一确认它不会出现在 NotifyResult、日志行、IPC 返回值里
 *   五、三道闸（开关 / 订阅 / 冷却）与冷却快照落盘往返
 *   六、★ 端到端链路：连续失败 → 真·调度器被关掉 auto → 唤醒 timer 被取消 →
 *       暂停原因落盘 → 推送发出一次 → 重复触发不重复推 → 恢复后一切复位
 *   七、机器人通道：/start 发菜单键盘、菜单按钮文本当命令、截图先选账号、
 *       回调 → answerCallbackQuery → sendPhoto 走 FormData、未授权会话被忽略、token 不进 body/日志
 */

import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ALERT_CH,
  defaultAlertsConfig,
  makeAlertEvent,
  type AlertDetectConfig,
  type AlertEvent
} from '@shared/alerts'
import type { DeviceInfo } from '@shared/domain'
import {
  BOT_MENU_BUTTON,
  type BotAction,
  type BotActionPort,
  type BotActionResult,
  type BotInstanceRef
} from '@shared/bot'
import { AppError } from '@shared/errors'

import { ALERT_PAUSES_FILE, getAlertCenter } from '@main/alerts/center'
import { FailureTracker, type CycleFact } from '@main/alerts/detect'
import { hasKickedTemplates, probeKickedOnRawFrame } from '@main/alerts/kicked'
import { getNotifyHub } from '@main/alerts/notifier'
import { setTelegramFetch, TelegramNotifier, type FetchLike } from '@main/alerts/telegram'
import { TelegramBot } from '@main/alerts/telegramBot'
import { createQueueFreeHook, type GatherCycleFact } from '@main/game/gatherRunner'
import type { GatherTemplates } from '@main/game/gather/index'
import { getScheduler } from '@main/scheduler/index'
import { emptyInstanceState } from '@main/scheduler/state'

// ── 断言小工具 ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n【${title}】`)
}

const quiet = (): void => undefined

// ── 假 token（形状合法，能过 validateTelegramConfig，但绝对无效）──────────
//
// ★ 这一串是**测试数据**，不是任何真实凭据。真实 token 只存在于用户本机的
//   <dataDir>/alerts.json，而那个目录已被 .gitignore 覆盖。
const FAKE_TOKEN = '999888777:AAFakeTokenForOfflineCheckOnly_0123456789'
/** token 的后半段，单独扫一遍，防止「只洗了整串、没洗掉半串」这种漏网。 */
const FAKE_TOKEN_TAIL = 'AAFakeTokenForOfflineCheckOnly_0123456789'
const FAKE_CHAT_ID = '123456789'

/** NotifyHub 写出来的日志行。★ 泄露实测要把它们也逐行扫一遍。 */
const hubLogs: string[] = []

/** 一段文本里有没有 token 的任何痕迹。 */
function leaks(text: string): boolean {
  return text.includes(FAKE_TOKEN) || text.includes(FAKE_TOKEN_TAIL)
}

// ── 假 fetch：把每次请求记下来，按剧本回结果 ──────────────────────────────

interface FakeCall {
  url: string
  /** JSON 请求体原文；multipart 请求记成 '[FormData]'（字段见 formFields）。 */
  body: string
  /** FormData 的字段：字符串原样、文件记成 `[blob <bytes>B]`。 */
  formFields?: Record<string, string>
}

interface FakeReply {
  status: number
  json: unknown
  /** 直接抛异常（模拟传输层失败）。 */
  throwWith?: (url: string) => Error
}

class FakeTelegram {
  readonly calls: FakeCall[] = []
  private script: FakeReply[] = []
  private fallback: FakeReply = { status: 200, json: { ok: true, result: { message_id: 1 } } }

  /** 排一串按顺序生效的回复；用完之后回落到 fallback。 */
  queue(...replies: FakeReply[]): void {
    this.script = [...replies]
  }

  setFallback(r: FakeReply): void {
    this.fallback = r
  }

  reset(): void {
    this.calls.length = 0
    this.script = []
    this.fallback = { status: 200, json: { ok: true, result: { message_id: 1 } } }
  }

  get impl(): FetchLike {
    return async (url, init) => {
      if (typeof init.body === 'string') {
        this.calls.push({ url, body: init.body })
      } else {
        const formFields: Record<string, string> = {}
        for (const [k, v] of init.body.entries()) {
          formFields[k] = typeof v === 'string' ? v : `[blob ${v.size}B]`
        }
        this.calls.push({ url, body: '[FormData]', formFields })
      }
      const r = this.script.shift() ?? this.fallback
      if (r.throwWith) throw r.throwWith(url)
      return {
        status: r.status,
        text: async () => JSON.stringify(r.json)
      }
    }
  }
}

const tg = new FakeTelegram()

// ── 采集事实工厂 ───────────────────────────────────────────────────────────

function factOf(p: Partial<CycleFact>): CycleFact {
  return {
    outcome: 'error',
    message: '第 G7 步失败：找不到「创建部队」页',
    step: null,
    errorCode: 'STEP_FAILED',
    dispatched: 0,
    shotPath: null,
    kicked: null,
    ...p
  }
}

const detectDefaults = defaultAlertsConfig().detect

function trackerOf(
  cfg: AlertDetectConfig = detectDefaults,
  now: () => number = () => Date.now()
): FailureTracker {
  return new FailureTracker({ config: () => cfg, log: quiet, now })
}

// ══════════════════════════════════════════════════════════════════════════
// 一、失败计数与阈值
// ══════════════════════════════════════════════════════════════════════════

function checkCounting(): void {
  section('一、失败计数与阈值')

  {
    const t = trackerOf()
    const a = t.noteCycle(0, factOf({}))
    const b = t.noteCycle(0, factOf({}))
    const c = t.noteCycle(0, factOf({}))
    ok('普通失败前两次不报警', a === null && b === null)
    ok(
      `第 ${detectDefaults.cycleFailThreshold} 次报 consecutiveFailures`,
      c?.type === 'consecutiveFailures',
      c?.reason
    )
    ok('出过事件之后计数清零（同一件事不会每轮刷屏）', t.noteCycle(0, factOf({})) === null)
  }

  {
    const t = trackerOf()
    const a = t.noteCycle(0, factOf({ step: 'G0' }))
    const b = t.noteCycle(0, factOf({ step: 'G0' }))
    ok('恢复阶梯用尽第 1 次不报警', a === null)
    ok(
      `第 ${detectDefaults.recoveryFailThreshold} 次报 needsAttention（比普通失败更早触发）`,
      b?.type === 'needsAttention'
    )
    ok('原因里点名了「顶号 / 维护 / 更新」这几种可能', (b?.reason ?? '').includes('顶号'))
  }

  {
    const t = trackerOf()
    t.noteCycle(0, factOf({}))
    t.noteCycle(0, factOf({}))
    const queueFull = t.noteCycle(0, factOf({ outcome: 'queueFull', message: '队列 5/5' }))
    ok('★ queueFull 不算失败（队列 5/5 是挂机稳态，判成故障必然误报）', queueFull === null)
    ok('非失败之后连续失败链被清零', t.noteCycle(0, factOf({})) === null)
  }

  {
    const t = trackerOf()
    for (const outcome of ['noResourceWanted', 'giveUp', 'staminaLow', 'circuitBroken'] as const) {
      t.noteCycle(9, factOf({}))
      t.noteCycle(9, factOf({}))
      const e = t.noteCycle(9, factOf({ outcome, message: outcome }))
      ok(`${outcome} 不算失败且会清零计数`, e === null)
    }
  }

  {
    const t = trackerOf()
    const e = t.noteCycle(
      0,
      factOf({
        kicked: {
          type: 'suspectedKicked',
          reason: '画面上出现了「账号已在其他设备登录」的提示框',
          detail: { 命中模板: 'tpl_dlg_kicked' }
        }
      })
    )
    ok('第二层命中时一次就出事件（证据够硬，不用等阈值）', e?.type === 'suspectedKicked')
    ok('第二层的 detail 被并进事件', String(e?.detail?.命中模板) === 'tpl_dlg_kicked')
  }

  {
    const t = trackerOf()
    const a = t.noteSampleFailed(1, 'adb 连不上')
    const b = t.noteSampleFailed(1, 'adb 连不上')
    t.noteSampleOk(1)
    const c = t.noteSampleFailed(1, 'adb 连不上')
    ok('采样失败未达阈值不报警', a === null && b === null)
    ok('采样成功会清零计数', c === null)
    t.noteSampleFailed(1, 'adb 连不上')
    const d = t.noteSampleFailed(1, 'adb 连不上')
    ok(
      `连续 ${detectDefaults.sampleFailThreshold} 次采样失败报 deviceOffline`,
      d?.type === 'deviceOffline'
    )
  }

  {
    let clock = 1_700_000_000_000
    const t = trackerOf(detectDefaults, () => clock)
    t.noteCycle(2, factOf({ outcome: 'dispatched', dispatched: 1, message: '派出 1 支' }))
    clock += (detectDefaults.stalledMinutes + 1) * 60_000
    const e = t.noteCycle(2, factOf({ outcome: 'staminaLow', message: '指挥官耐力不足' }))
    ok('长时间派不出队报 dispatchStalled', e?.type === 'dispatchStalled')
    ok('★ dispatchStalled 是 warning，不会暂停实例', e?.severity === 'warning')
    ok(
      '同一段停滞不会每轮再报',
      t.noteCycle(2, factOf({ outcome: 'staminaLow', message: '指挥官耐力不足' })) === null
    )
  }

  {
    // 阈值全部来自配置，改小立刻生效（面板上调阈值不用重启）。
    const strict: AlertDetectConfig = { ...detectDefaults, cycleFailThreshold: 1 }
    const t = trackerOf(strict)
    ok('阈值改成 1 时第一次失败就报警（阈值确实来自配置）', t.noteCycle(5, factOf({})) !== null)
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 二、第二层：模板缺失必须静默降级
// ══════════════════════════════════════════════════════════════════════════

async function checkKickedFallback(): Promise<void> {
  section('二、第二层顶号识别：模板缺失必须静默降级')

  const emptyTemplates = {
    setId: 'offline-check',
    refWidth: 2560,
    refHeight: 1440,
    ui: new Map(),
    glyphSets: new Map(),
    missing: [],
    get: () => undefined,
    has: () => false,
    require: () => {
      throw new Error('不该被调用')
    },
    requireGlyphs: () => {
      throw new Error('不该被调用')
    },
    hasGlyphs: () => false
  } as unknown as GatherTemplates

  ok('没有任何顶号模板时 hasKickedTemplates=false', hasKickedTemplates(emptyTemplates) === false)

  const raw = { width: 8, height: 8, format: 1, data: new Uint8Array(8 * 8 * 4) } as never
  let threw = false
  let result: unknown = 'not-called'
  try {
    result = await probeKickedOnRawFrame(raw, { templates: emptyTemplates })
  } catch {
    threw = true
  }
  ok('★ 模板缺失时探针返回 null 且绝不抛异常（不因缺模板中止采集）', !threw && result === null)
}

// ══════════════════════════════════════════════════════════════════════════
// 二之二、「这一轮压根没跑起来」也要计进连续失败
// ══════════════════════════════════════════════════════════════════════════

async function checkStartupFailureCounted(): Promise<void> {
  section('二之二、采集流程没能启动时也要通报（否则永远等不到「需要人工介入」）')

  const facts: GatherCycleFact[] = []
  const hook = createQueueFreeHook({
    dataDir: () => '/tmp/wl-offline-check-nonexistent',
    // ★ 模拟「模板目录读不出来」这类在状态机启动之前就炸掉的失败。
    templatesDir: () => {
      throw new Error('离线自检：模板目录不可用')
    },
    resolveSerial: async () => 'offline',
    loadConfig: async () => null,
    noteDispatch: async () => undefined,
    log: quiet,
    onCycleResult: async (_index, fact) => {
      facts.push(fact)
    }
  })

  let threw = false
  try {
    await hook(emptyInstanceState(4))
  } catch {
    threw = true
  }
  ok('★ 启动阶段就失败时，onCycleResult 照样被通报了一次', facts.length === 1)
  ok('通报的 outcome 是 error（会计进连续失败）', facts[0]?.outcome === 'error')
  ok('中文原因说清了「没能启动」', (facts[0]?.message ?? '').includes('没能启动'))
  ok('错误照样往上抛给调度器走退避（行为没变）', threw === true)
}

// ══════════════════════════════════════════════════════════════════════════
// 三 & 四、Telegram 通道：话术分类 + token 泄露实测
// ══════════════════════════════════════════════════════════════════════════

function notifierWithLogs(logs: string[], retryCount = 0): TelegramNotifier {
  return new TelegramNotifier({
    config: () => ({
      enabled: true,
      botToken: FAKE_TOKEN,
      chatId: FAKE_CHAT_ID,
      cooldownSeconds: 0,
      retryCount,
      timeoutMs: 5_000,
      subscribedTypes: [],
      remoteControl: false
    }),
    log: (level, message) => logs.push(`[${level}] ${message}`)
  })
}

function sampleEvent(): AlertEvent {
  return makeAlertEvent({
    type: 'needsAttention',
    instanceIndex: 3,
    reason: '连续 2 轮都回不到世界地图',
    // ★ 故意带上 markdown 元字符：这正是不开 parse_mode 的原因。
    accountName: '主号-王朝A_区[测试]'
  })
}

async function checkTelegramChannel(): Promise<void> {
  section('三、Telegram 通道：失败分类与中文话术')

  // 成功
  {
    tg.reset()
    const logs: string[] = []
    const r = await notifierWithLogs(logs).send(sampleEvent())
    ok('正常情况能发出去', r.ok === true && r.attempts === 1)
    ok('只发了一次请求', tg.calls.length === 1)
    const body = JSON.parse(tg.calls[0]!.body) as Record<string, unknown>
    ok('chat_id 用的是配置里的值', body.chat_id === FAKE_CHAT_ID)
    ok(
      '★ 请求体里没有 parse_mode（账号名里的 _ [ ] 才不会把 Telegram 噎住）',
      !('parse_mode' in body)
    )
    const text = String(body.text)
    ok('正文含实例号', text.includes('实例 3'))
    ok('正文含账号名', text.includes('主号-王朝A_区[测试]'))
    ok('正文含事件标题', text.includes('需要人工介入'))
    ok('正文含原因', text.includes('连续 2 轮都回不到世界地图'))
    ok('★ 正文的时间戳标着「北京时间」', text.includes('（北京时间）'))
    ok('正文含处置建议', text.includes('处置：'))
  }

  // 401 / 404：token 配错，不可重试
  for (const [status, label] of [
    [401, 'HTTP 401'],
    [404, 'HTTP 404']
  ] as const) {
    tg.reset()
    tg.setFallback({ status, json: { ok: false, description: 'Unauthorized' } })
    const logs: string[] = []
    const r = await notifierWithLogs(logs, 2).send(sampleEvent())
    ok(`${label} 判成 badToken`, r.failure === 'badToken')
    ok(`${label} 的话术点名了 @BotFather`, r.message.includes('BotFather'))
    ok(`★ ${label} 不可重试，只发 1 次就放弃`, tg.calls.length === 1)
    ok(`★ ${label} 上报的 attempts 是真实次数 1（不是 retryCount+1）`, r.attempts === 1)
  }

  // 400 chat not found
  {
    tg.reset()
    tg.setFallback({ status: 400, json: { ok: false, description: 'Bad Request: chat not found' } })
    const r = await notifierWithLogs([]).send(sampleEvent())
    ok('chat not found 判成 badChat', r.failure === 'badChat')
    ok('话术教用户怎么拿 chat id', r.message.includes('userinfobot') || r.message.includes('id'))
  }

  // 403：被用户拉黑 / 没先给 bot 发过消息
  {
    tg.reset()
    tg.setFallback({
      status: 403,
      json: { ok: false, description: 'Forbidden: bot was blocked by the user' }
    })
    const r = await notifierWithLogs([]).send(sampleEvent())
    ok(
      '403 有自己的话术（不是「未知错误」）',
      r.failure !== 'unknown' && r.message.length > 10,
      r.message.slice(0, 40)
    )
  }

  // 429：限流，可重试
  {
    tg.reset()
    tg.queue({
      status: 429,
      json: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } }
    })
    const logs: string[] = []
    const r = await notifierWithLogs(logs, 2).send(sampleEvent())
    ok('429 之后重试并最终成功', r.ok === true, `attempts=${r.attempts}`)
    ok('429 确实重试了（发了 2 次请求）', tg.calls.length === 2)
  }

  // 传输层异常：网络不通
  {
    tg.reset()
    tg.setFallback({
      status: 0,
      json: null,
      throwWith: () => {
        const inner = new Error('getaddrinfo ENOTFOUND api.telegram.org')
        ;(inner as { code?: string }).code = 'ENOTFOUND'
        const outer = new Error('fetch failed')
        ;(outer as { cause?: unknown }).cause = inner
        return outer
      }
    })
    const r = await notifierWithLogs([], 1).send(sampleEvent())
    ok('传输层失败判成 network', r.failure === 'network')
    ok(
      '话术点名了 api.telegram.org 与代理',
      r.message.includes('api.telegram.org') && r.message.includes('代理')
    )
    ok('底层 errno 被保留下来（排障要用）', r.message.includes('ENOTFOUND'))
    ok('network 属于可重试，确实重试了', tg.calls.length === 2)
  }

  // 未配置 / 开关关
  {
    tg.reset()
    const half = new TelegramNotifier({
      config: () => ({
        enabled: true,
        botToken: '',
        chatId: '',
        cooldownSeconds: 0,
        retryCount: 0,
        timeoutMs: 5_000,
        subscribedTypes: [],
        remoteControl: false
      })
    })
    const r = await half.send(sampleEvent())
    ok(
      '没填 token/chatId 时直接回 notConfigured，不发请求',
      r.failure === 'notConfigured' && tg.calls.length === 0
    )
    ok(
      '话术里教用户去哪拿 token 和 chat id',
      r.message.includes('BotFather') && r.message.includes('userinfobot')
    )

    const off = new TelegramNotifier({
      config: () => ({
        enabled: false,
        botToken: FAKE_TOKEN,
        chatId: FAKE_CHAT_ID,
        cooldownSeconds: 0,
        retryCount: 0,
        timeoutMs: 5_000,
        subscribedTypes: [],
        remoteControl: false
      })
    })
    ok(
      '开关关掉时 send() 不发请求',
      (await off.send(sampleEvent())).failure === 'disabled' && tg.calls.length === 0
    )
    ok(
      '★ 但「测试推送」刻意忽略开关（用户是先填后测再开）',
      (await off.test()).failure !== 'disabled'
    )
  }
}

// ── 四、token 泄露实测 ────────────────────────────────────────────────────

async function checkTokenLeak(dataDir: string): Promise<void> {
  section('四、★ token 泄露实测（把含 token 的 URL 塞满每一条可能的出口）')

  const logs: string[] = []

  // ① 最坏情况：undici 风格的异常，message / cause / stack 里全是含 token 的完整 URL。
  tg.reset()
  tg.setFallback({
    status: 0,
    json: null,
    throwWith: (url) => {
      const inner = new Error(`connect ECONNREFUSED 149.154.167.220:443 ${url}`)
      ;(inner as { code?: string }).code = 'ECONNREFUSED'
      const outer = new Error(`fetch failed: ${url}`)
      ;(outer as { cause?: unknown }).cause = inner
      outer.stack = `Error: fetch failed: ${url}\n    at Object.fetch (node:internal/deps/undici/undici:13502:13)`
      return outer
    }
  })
  const r1 = await notifierWithLogs(logs).send(sampleEvent())
  ok('请求 URL 里确实带着 token（否则这条实测没有意义）', tg.calls[0]!.url.includes(FAKE_TOKEN))
  ok('★ NotifyResult.message 里没有 token', !leaks(r1.message), r1.message.slice(0, 60) + '…')
  ok('★ 整个 NotifyResult 序列化后没有 token', !leaks(JSON.stringify(r1)))
  ok('底层原因仍然可读（ECONNREFUSED 保留了下来）', r1.message.includes('ECONNREFUSED'))
  ok('token 被替换成了 ***', r1.message.includes('bot***/sendMessage'))

  // ② 响应体里回显 token（理论上 Telegram 不会，但代理/中间件可能）。
  tg.reset()
  tg.setFallback({
    status: 400,
    json: {
      ok: false,
      description: `Bad Request: something about https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`
    }
  })
  const r2 = await notifierWithLogs(logs).send(sampleEvent())
  ok('★ 响应体回显 token 时也被洗掉', !leaks(r2.message), r2.message.slice(0, 60) + '…')

  // ③ 读响应体时断流。
  tg.reset()
  setTelegramFetch(async (url) => ({
    status: 200,
    text: async () => {
      throw new Error(`aborted while reading ${url}`)
    }
  }))
  const r3 = await notifierWithLogs(logs).send(sampleEvent())
  ok('★ 读响应体断流时也不泄露', !leaks(r3.message), r3.message.slice(0, 60) + '…')
  setTelegramFetch(tg.impl)

  // ④ 重试路径：这条会真的往日志里写「第 N 次失败，X 秒后重试」，正好用来验日志出口。
  tg.reset()
  tg.queue({
    status: 0,
    json: null,
    throwWith: (url) => {
      const e = new Error(`fetch failed ${url}`)
      ;(e as { cause?: unknown }).cause = new Error(`getaddrinfo ENOTFOUND ${url}`)
      return e
    }
  })
  await notifierWithLogs(logs, 1).send(sampleEvent())

  // ⑤ 所有日志行（通道自己的 + NotifyHub 的）。
  const allLogs = [...logs, ...hubLogs]
  const dirty = allLogs.filter((l) => leaks(l))
  ok(`★ 本轮 ${allLogs.length} 条日志行里没有一条含 token`, dirty.length === 0, dirty[0] ?? '')
  ok('日志里确实有内容可扫（不是因为一条都没记才「干净」）', allLogs.length >= 3)

  // ⑥ IPC 出口（面板拿到的配置视图）。
  const hub = getNotifyHub()
  const view = hub.getConfigView()
  const viewJson = JSON.stringify(view)
  ok('★ alerts:config 的返回值里没有 token', !leaks(viewJson))
  ok('★ 类型上就没有 botToken 这个键', !('botToken' in (view.telegram as object)))
  ok(
    '面板拿到的是打码值（只剩后 4 位）',
    view.telegram.botTokenMasked.endsWith(FAKE_TOKEN.slice(-4))
  )
  ok('打码值本身不含 token 明文', !leaks(view.telegram.botTokenMasked))
  ok('面板知道「已经配过 token 了」', view.telegram.botTokenSet === true)

  // ⑦ 落盘：只有 alerts.json 该有明文（那就是本地凭据存储），别的文件一律不许有。
  const files = await readdir(dataDir)
  for (const f of files) {
    if (f.endsWith('.tmp') || f.includes('.tmp-')) continue
    const text = await readFile(join(dataDir, f), 'utf8')
    if (f === 'alerts.json') {
      ok('alerts.json 里存着明文 token（本地凭据存储，符合预期）', text.includes(FAKE_TOKEN))
    } else {
      ok(`★ ${f} 里没有 token`, !leaks(text))
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 五、三道闸与冷却去重
// ══════════════════════════════════════════════════════════════════════════

async function checkThrottle(dataDir: string): Promise<void> {
  section('五、三道闸（开关 / 订阅 / 冷却）与落盘往返')

  const hub = getNotifyHub()
  tg.reset()

  // 开关
  await hub.saveConfig({ telegram: { enabled: false } })
  const offOut = await hub.dispatch(
    makeAlertEvent({ type: 'needsAttention', instanceIndex: 7, reason: '开关关着' })
  )
  ok('闸一：开关关着时不发请求', tg.calls.length === 0 && offOut.suppressed === true)
  ok('闸一：失败分类是 disabled', offOut.results[0]?.failure === 'disabled')

  // 订阅
  await hub.saveConfig({ telegram: { enabled: true, subscribedTypes: ['deviceOffline'] } })
  const unsubOut = await hub.dispatch(
    makeAlertEvent({ type: 'needsAttention', instanceIndex: 7, reason: '没订阅' })
  )
  ok(
    '闸二：没订阅的事件不发请求',
    tg.calls.length === 0 && unsubOut.results[0]?.failure === 'unsubscribed'
  )

  // 冷却
  await hub.saveConfig({
    telegram: {
      subscribedTypes: [...defaultAlertsConfig().telegram.subscribedTypes],
      cooldownSeconds: 600
    }
  })
  const first = await hub.dispatch(
    makeAlertEvent({ type: 'needsAttention', instanceIndex: 7, reason: '第一次' })
  )
  ok('闸三：第一次放行', first.results[0]?.ok === true && tg.calls.length === 1)

  const second = await hub.dispatch(
    makeAlertEvent({ type: 'needsAttention', instanceIndex: 7, reason: '第二次' })
  )
  ok(
    '★ 闸三：冷却期内同实例同类型不重复推送',
    tg.calls.length === 1 && second.results[0]?.failure === 'throttled'
  )
  ok(
    '被压掉的那条 suppressed=true（面板据此区分「没发」与「发了但失败」）',
    second.suppressed === true
  )

  const other = await hub.dispatch(
    makeAlertEvent({ type: 'deviceOffline', instanceIndex: 7, reason: '换个事件类型' })
  )
  ok('不同事件类型是另一个去重键，照样能推', other.results[0]?.ok === true && tg.calls.length === 2)

  const otherInst = await hub.dispatch(
    makeAlertEvent({ type: 'needsAttention', instanceIndex: 8, reason: '换个实例' })
  )
  ok('不同实例是另一个去重键，照样能推', otherInst.results[0]?.ok === true && tg.calls.length === 3)

  // 冷却期内被压掉的次数会在下次放行时补进正文
  await hub.dispatch(makeAlertEvent({ type: 'needsAttention', instanceIndex: 7, reason: '第三次' }))
  await hub.saveConfig({ telegram: { cooldownSeconds: 0 } })
  const afterCooldown = await hub.dispatch(
    makeAlertEvent({ type: 'needsAttention', instanceIndex: 7, reason: '冷却过后' })
  )
  ok('冷却过后重新放行', afterCooldown.results[0]?.ok === true)
  const lastBody = String((JSON.parse(tg.calls.at(-1)!.body) as { text: string }).text)
  ok(
    '★ 补上了「冷却期内还发生过 N 次」',
    lastBody.includes('冷却期内还发生过'),
    lastBody.split('\n').at(-1)
  )

  // 落盘往返：冷却快照跨重启有效
  await hub.saveConfig({ telegram: { cooldownSeconds: 600 } })
  const raw = JSON.parse(await readFile(join(dataDir, 'alerts.json'), 'utf8')) as {
    config: { telegram: { cooldownSeconds: number } }
    throttle: Record<string, { lastSentAt: number }>
  }
  ok('★ 冷却快照随配置一起落盘（重启后不会立刻再轰一条）', Object.keys(raw.throttle).length > 0)
  ok('落盘的配置能读回来', raw.config.telegram.cooldownSeconds === 600)

  // 失败不重置冷却窗口
  tg.reset()
  await hub.resetThrottleForInstance(11)
  tg.setFallback({ status: 500, json: { ok: false, description: 'Internal Server Error' } })
  await hub.saveConfig({ telegram: { retryCount: 0 } })
  const failed = await hub.dispatch(
    makeAlertEvent({ type: 'needsAttention', instanceIndex: 11, reason: '发失败' })
  )
  ok(
    '推送失败时 suppressed=false（确实尝试过）',
    failed.suppressed === false && failed.results[0]?.ok === false
  )
  tg.setFallback({ status: 200, json: { ok: true } })
  const retryAfterFail = await hub.dispatch(
    makeAlertEvent({ type: 'needsAttention', instanceIndex: 11, reason: '再来一次' })
  )
  ok('★ 上一次失败没有白吃掉冷却窗口（失败不 markSent）', retryAfterFail.results[0]?.ok === true)
}

// ══════════════════════════════════════════════════════════════════════════
// 六、端到端：连续失败 → 暂停 → 通知 → 去重 → 恢复
// ══════════════════════════════════════════════════════════════════════════

async function checkEndToEnd(dataDir: string): Promise<void> {
  section('六、★ 端到端：连续失败 → 真·调度器被暂停 → 推送一次 → 恢复')

  const hub = getNotifyHub()
  const center = getAlertCenter()
  const scheduler = getScheduler()

  // 采样阈值调高，免得「设备连不上」在端到端过程中抢跑；冷却保持默认 10 分钟。
  await hub.saveConfig({
    detect: { sampleFailThreshold: 99 },
    telegram: {
      enabled: true,
      botToken: FAKE_TOKEN,
      chatId: FAKE_CHAT_ID,
      cooldownSeconds: 600,
      retryCount: 0,
      subscribedTypes: [...defaultAlertsConfig().telegram.subscribedTypes]
    }
  })

  const sampleResults: [number, boolean][] = []
  const autoChanges: [number, boolean][] = []
  const centerLogs: string[] = []

  // ★ 假设备：resolveDevice 直接抛。整个自检不会向任何模拟器发一条 adb 命令。
  await scheduler.init({
    dataDir: () => dataDir,
    refSize: () => ({ refWidth: 2560, refHeight: 1440 }),
    resolveDevice: async (): Promise<DeviceInfo> => {
      throw new AppError('ADB_DEVICE_OFFLINE', '离线自检：这里没有真设备，adb 连不上。')
    },
    busyRunIdOf: () => null,
    adb: {
      capture: async () => {
        throw new Error('离线自检不该走到截图')
      },
      tap: async () => {
        throw new Error('离线自检不该走到点击')
      },
      key: async () => {
        throw new Error('离线自检不该走到按键')
      }
    },
    log: quiet,
    onSampleResult: (index, okFlag) => {
      sampleResults.push([index, okFlag])
    },
    // 数据统计的「暂停 / 恢复」事件来源：开关真的翻转才通报。
    onAutoChanged: (index, enabled) => {
      autoChanges.push([index, enabled])
    }
  })

  const failureTracker = new FailureTracker({
    config: () => center.detectConfig(),
    log: quiet
  })

  const resumedCounters: number[] = []
  await center.init({
    dataDir: () => dataDir,
    notify: () => hub,
    setAuto: (index, enabled) => scheduler.setAuto(index, enabled),
    accountOf: async () => ({ id: 'acc-1', name: '主号-王朝A区' }),
    resetCounters: (index) => {
      resumedCounters.push(index)
      failureTracker.reset(index)
    },
    log: (level, message) => centerLogs.push(`[${level}] ${message}`)
  })

  // ── 起点：打开自动调度 ──
  await scheduler.setAuto(0, true)
  ok('起点：实例 0 的 auto=true', scheduler.getState(0).auto === true)
  ok(
    '起点：首次采样失败（假设备）也补排了唤醒 timer',
    scheduler.listWakes().some((w) => w.instanceIndex === 0)
  )
  ok(
    '起点：采样失败被通报给了检测模块',
    sampleResults.some(([i, o]) => i === 0 && o === false)
  )

  // ── 连续失败直到出事件 ──
  tg.reset()
  let event: AlertEvent | null = null
  let rounds = 0
  while (event === null && rounds < 10) {
    rounds += 1
    event = failureTracker.noteCycle(
      0,
      factOf({
        message: `第 ${rounds} 轮：找不到「创建部队」页`,
        shotPath: 'alerts/inst0-cycle-error-1.jpg'
      })
    )
  }
  ok(`连续 ${detectDefaults.cycleFailThreshold} 轮失败后产出了事件`, event !== null, event?.type)
  ok('事件类型是「连续失败熔断」', event?.type === 'consecutiveFailures')

  const record = await center.raise(event!)

  // ── 断言：暂停真的发生了 ──
  ok('★ 暂停：pausedNow=true', record.pausedNow === true)
  ok('★ 暂停：调度器的 auto 被关掉了', scheduler.getState(0).auto === false)
  ok(
    '★ 暂停：唤醒 timer 被取消（不会继续在坏状态上操作游戏）',
    !scheduler.listWakes().some((w) => w.instanceIndex === 0)
  )
  ok('★ 暂停：nextWakeAt 被清空', scheduler.getState(0).nextWakeAt === null)
  ok('账号名被补齐（推送里要显示）', record.event.accountName === '主号-王朝A区')

  const pause = center.getPause(0)
  ok('面板拿到的暂停态 paused=true', pause.paused === true)
  ok(
    '暂停原因是中文可懂的一句话',
    typeof pause.reason === 'string' && pause.reason!.includes('连续')
  )
  ok('暂停时刻被记下', typeof pause.pausedAt === 'number' && pause.pausedAt! > 0)
  ok('现场截图路径进了暂停态', pause.shotPath === 'alerts/inst0-cycle-error-1.jpg')
  ok('处置建议来自 ALERT_SPECS', typeof pause.advice === 'string' && pause.advice!.length > 0)
  ok('推送结果被记进暂停态', pause.notified === true && pause.notifyError === null)

  // ── 断言：落盘 ──
  const pauseFile = JSON.parse(await readFile(join(dataDir, ALERT_PAUSES_FILE), 'utf8')) as {
    pauses: {
      instanceIndex: number
      paused: boolean
      reason: string | null
      pausedAt: number | null
    }[]
  }
  const persisted = pauseFile.pauses.find((p) => p.instanceIndex === 0)
  ok(
    '★ 落盘：pausedReason 写进了 alerts-pauses.json（重启后不丢）',
    persisted?.paused === true && !!persisted?.reason
  )
  ok('★ 落盘：pausedAt 也写下来了', typeof persisted?.pausedAt === 'number')

  const schedFile = JSON.parse(await readFile(join(dataDir, 'scheduler.json'), 'utf8')) as {
    instances: { instanceIndex: number; auto: boolean }[]
  }
  ok(
    '★ 落盘：scheduler.json 里 auto 已经是 false（重启后也不会自己跑起来）',
    schedFile.instances.find((i) => i.instanceIndex === 0)?.auto === false
  )

  // ── 断言：推送发出了一次 ──
  ok('★ 推送：发出了 1 条', tg.calls.length === 1)
  const pushed = String((JSON.parse(tg.calls[0]!.body) as { text: string }).text)
  ok('推送正文含实例号与账号名', pushed.includes('实例 0') && pushed.includes('主号-王朝A区'))
  ok('推送正文含事件类型', pushed.includes('连续失败'))
  ok('推送正文含北京时间时间戳', pushed.includes('（北京时间）'))
  ok('推送正文含现场截图路径', pushed.includes('alerts/inst0-cycle-error-1.jpg'))

  // ── 断言：重复触发幂等 + 不重复推送 ──
  const again = await center.raise(event!)
  ok('★ 幂等：重复触发不再关一次调度', again.pausedNow === false)
  ok('★ 幂等：不覆盖最初的暂停原因', center.getPause(0).reason === pause.reason)
  ok('★ 去重：冷却期内不重复推送', tg.calls.length === 1)
  ok('第二条被记为「压制」', again.results[0]?.failure === 'throttled')

  // 再来三次，确认不会越攒越多地推
  for (let i = 0; i < 3; i += 1) await center.raise(event!)
  ok('★ 去重：连轰 5 次也只推了 1 条', tg.calls.length === 1)

  // ── 断言：推送失败不影响暂停 ──
  tg.reset()
  tg.setFallback({
    status: 0,
    json: null,
    throwWith: () => new Error('fetch failed')
  })
  await hub.resetThrottleForInstance(1)
  const evt1 = makeAlertEvent({ type: 'needsAttention', instanceIndex: 1, reason: '恢复阶梯用尽' })
  const rec1 = await center.raise(evt1)
  ok('★ 推送失败时暂停照样生效', rec1.pausedNow === true && scheduler.getState(1).auto === false)
  // 实例 0：开（814 行的 setAuto(0,true)）→ 连续失败被暂停 = 两次翻转；连轰 5 次 raise 只通报 1 次暂停。
  // 实例 1：从来没开过，setAuto(1,false) 不是翻转 → 不通报（否则统计会记出一段凭空的「暂停」）。
  ok(
    '★ 暂停通报给了数据统计：只在开关真的翻转时（[0,true],[0,false]，实例 1 未曾打开所以不通报）',
    JSON.stringify(autoChanges) === JSON.stringify([[0, true], [0, false]]),
    JSON.stringify(autoChanges)
  )
  ok(
    '★ 推送失败的原因被记进暂停态，面板上看得到',
    typeof center.getPause(1).notifyError === 'string'
  )
  ok('推送失败的原因里没有 token', !leaks(center.getPause(1).notifyError ?? ''))
  tg.setFallback({ status: 200, json: { ok: true } })

  // ── 恢复 ──
  tg.reset()
  const after = await center.resume(0)
  ok('★ 恢复：paused 回到 false', after.paused === false)
  ok('★ 恢复：调度器 auto 重新打开', scheduler.getState(0).auto === true)
  ok(
    '★ 恢复：重新排上了唤醒 timer（不会留下「开着但永不唤醒」的僵尸态）',
    scheduler.listWakes().some((w) => w.instanceIndex === 0)
  )
  ok('★ 恢复：失败计数被清零', resumedCounters.includes(0))
  ok('★ 恢复通报给了数据统计（onAutoChanged(0,true)）', autoChanges.some(([i, en]) => i === 0 && en))
  ok('★ 恢复：暂停态落盘也被清掉', (await readPause(dataDir, 0))?.paused !== true)

  // 闭环通知是**故意**不 await 的（点「恢复」不该被一次网络请求拖住），等一小会儿再断言。
  await new Promise((r) => setTimeout(r, 50))
  ok('★ 恢复：补了一条 instanceResumed 闭环通知', tg.calls.length >= 1)

  // 恢复会清掉推送冷却：同样的事件应该能立刻再推
  tg.reset()
  const evtAgain = makeAlertEvent({
    type: 'consecutiveFailures',
    instanceIndex: 0,
    reason: '恢复之后又坏了'
  })
  await center.raise(evtAgain)
  ok('★ 恢复会清掉推送冷却，下次再出事能立刻推', tg.calls.length === 1)

  ok('历史里查得到这些记录', center.history().length >= 5)
  ok(
    '日志里没有 token',
    centerLogs.every((l) => !leaks(l))
  )

  // ── IPC 分工不重叠 ──
  const { ipcMain } = (await import('electron')) as unknown as {
    ipcMain: { _handlers: Map<string, unknown> }
  }
  const channels = [...ipcMain._handlers.keys()].filter((c) => c.startsWith('alerts:'))
  const expected = [
    ALERT_CH.config,
    ALERT_CH.saveConfig,
    ALERT_CH.test,
    ALERT_CH.pauses,
    ALERT_CH.resume,
    ALERT_CH.history
  ]
  ok(
    'alerts:* 六条通道全部注册上了',
    expected.every((c) => channels.includes(c)),
    channels.join(' ')
  )
  ok('没有多注册出别的 alerts:* 通道', channels.length === expected.length)

  await scheduler.stop()
}

// ══════════════════════════════════════════════════════════════════════════
// 七、机器人通道：菜单键盘 / 账号选择 / 发图 / 鉴权
// ══════════════════════════════════════════════════════════════════════════

/** 假 getUpdates 剧本：每次轮询吐一条更新，吐完后回空数组。 */
type FakeUpdate = Record<string, unknown>

async function checkBotChannel(): Promise<void> {
  section('七、机器人通道：菜单键盘 / 账号选择 / sendPhoto 走 FormData / 未授权忽略')

  const botLogs: string[] = []
  const performed: Array<[BotAction, number | null]> = []
  let instances: BotInstanceRef[] = [
    { index: 0, name: '主号' },
    { index: 1, name: '小号' }
  ]
  const fakeJpeg = new Uint8Array(1024).fill(0xd8).buffer

  const fakePort: BotActionPort = {
    async perform(action, idx): Promise<BotActionResult> {
      performed.push([action, idx])
      if (action === 'shot') {
        return {
          text: '',
          photo: { jpeg: fakeJpeg, caption: `实例 ${idx}「小号」截图`, filename: `inst${idx}-20260909-212233.jpg` }
        }
      }
      if (action === 'resources') return { text: `【资源统计】实例 ${idx}` }
      if (action === 'menu') return { text: '菜单已刷新。', showMenu: true }
      if (action === 'status') return { text: `状态 ${idx ?? '全部'}` }
      return { text: `${action} 已执行` }
    },
    async listInstances() {
      return instances
    }
  }

  // getUpdates 剧本；其余方法一律回 ok。
  const updates: FakeUpdate[] = []
  let updateId = 100
  const pushUpdate = (u: FakeUpdate): void => {
    updateId += 1
    updates.push({ update_id: updateId, ...u })
  }
  const msg = (chatId: string, text: string): FakeUpdate => ({ message: { chat: { id: Number(chatId) }, text } })
  const cb = (chatId: string, data: string, id = 'cbq-1'): FakeUpdate => ({
    callback_query: { id, data, message: { chat: { id: Number(chatId) } } }
  })

  const calls: FakeCall[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const rec: FakeCall = { url, body: typeof init.body === 'string' ? init.body : '[FormData]' }
    if (typeof init.body !== 'string') {
      rec.formFields = {}
      for (const [k, v] of init.body.entries()) rec.formFields[k] = typeof v === 'string' ? v : `[blob ${v.size}B]`
      // ★ multipart 绝不能手动设 content-type（boundary 由 fetch 自己生成）。
      ok('sendPhoto 请求没有手动设 content-type', !init.headers || !('content-type' in init.headers))
    }
    if (url.endsWith('/getUpdates')) {
      // ★ 真实 Telegram 会把长轮询挂 25s；假的没更新时也要小睡一下，否则轮询循环会空转吃满 CPU/内存。
      const next = updates.shift()
      if (!next) await new Promise((r) => setTimeout(r, 5))
      return { status: 200, text: async () => JSON.stringify({ ok: true, result: next ? [next] : [] }) }
    }
    calls.push(rec)
    return { status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }) }
  }

  const bot = new TelegramBot({
    config: () => ({
      enabled: true,
      botToken: FAKE_TOKEN,
      chatId: FAKE_CHAT_ID,
      cooldownSeconds: 0,
      retryCount: 0,
      timeoutMs: 5_000,
      subscribedTypes: [],
      remoteControl: true
    }),
    actions: fakePort,
    log: (level, message) => botLogs.push(`[${level}] ${message}`),
    fetchImpl
  })

  const methodOf = (c: FakeCall): string => c.url.slice(c.url.lastIndexOf('/') + 1)
  const sends = (): FakeCall[] => calls.filter((c) => methodOf(c) === 'sendMessage')
  const bodyOf = (c: FakeCall): Record<string, unknown> => JSON.parse(c.body) as Record<string, unknown>
  /** 等到剧本里的更新都被消费、且机器人已经把回复发出去。 */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 100 && updates.length > 0; i += 1) await new Promise((r) => setTimeout(r, 5))
    await new Promise((r) => setTimeout(r, 30))
  }

  // ① /start → 帮助 + 底部菜单键盘
  pushUpdate(msg(FAKE_CHAT_ID, '/start'))
  await bot.start()
  ok('机器人按配置启动了（enabled + remoteControl + token/chatId 合法）', bot.isRunning())
  await drain()
  ok('启动时用 setMyCommands 注册了命令列表', calls.some((c) => methodOf(c) === 'setMyCommands'))
  {
    const reg = calls.find((c) => methodOf(c) === 'setMyCommands')
    const cmds = reg ? (bodyOf(reg).commands as Array<{ command: string }>) : []
    ok(
      '命令列表含 accounts / shot / resources / stats / menu',
      ['accounts', 'shot', 'resources', 'stats', 'menu'].every((n) => cmds.some((c) => c.command === n)),
      cmds.map((c) => c.command).join(',')
    )
  }
  {
    const start = sends()[0]
    const b = start ? bodyOf(start) : {}
    const markup = b.reply_markup as { keyboard?: Array<Array<{ text: string }>>; is_persistent?: boolean; resize_keyboard?: boolean } | undefined
    ok('/start 回了一条消息', !!start)
    ok('/start 的正文是帮助说明', String(b.text ?? '').includes('/accounts'))
    ok('★ /start 带 reply_markup.keyboard（底部菜单）', Array.isArray(markup?.keyboard))
    const flat = (markup?.keyboard ?? []).flat().map((k) => k.text)
    ok(
      '菜单 6 个按钮字面量与 BOT_MENU_BUTTON 一一对应',
      flat.length === 6 && Object.values(BOT_MENU_BUTTON).every((t) => flat.includes(t)),
      flat.join(' | ')
    )
    ok('菜单键盘 resize_keyboard + is_persistent', markup?.resize_keyboard === true && markup?.is_persistent === true)
    ok('★ 请求体里没有 parse_mode', !('parse_mode' in b))
  }

  // ② 菜单按钮文本「📷 截图」，有 2 个实例 → 回账号选择内联按钮
  calls.length = 0
  pushUpdate(msg(FAKE_CHAT_ID, BOT_MENU_BUTTON.shot))
  await drain()
  {
    const pick = sends()[0]
    const b = pick ? bodyOf(pick) : {}
    const kb = (b.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | undefined)?.inline_keyboard ?? []
    const datas = kb.flat().map((k) => k.callback_data)
    ok('★ 按钮文本被当命令处理，没有执行 perform（要先选账号）', !performed.some(([a]) => a === 'shot'))
    ok('回了「请选择账号」+ 内联按钮', String(b.text ?? '').includes('请选择账号') && kb.length === 2)
    ok('callback_data 是 shot:0 / shot:1', datas.join(',') === 'shot:0,shot:1', datas.join(','))
    ok('按钮文本带账号名', kb.flat().some((k) => k.text.includes('小号')))
  }

  // ③ 回调 shot:1 → answerCallbackQuery → perform('shot',1) → sendPhoto(FormData)
  calls.length = 0
  pushUpdate(cb(FAKE_CHAT_ID, 'shot:1', 'cbq-shot'))
  await drain()
  {
    const order = calls.map(methodOf).filter((m) => m !== 'getUpdates')
    ok('先 answerCallbackQuery 再发图', order[0] === 'answerCallbackQuery' && order.includes('sendPhoto'), order.join(' → '))
    const ans = calls.find((c) => methodOf(c) === 'answerCallbackQuery')
    ok('应答带的是同一个 callback_query_id', ans ? bodyOf(ans).callback_query_id === 'cbq-shot' : false)
    ok('perform 收到 (shot, 1)', performed.some(([a, i]) => a === 'shot' && i === 1))
    const photo = calls.find((c) => methodOf(c) === 'sendPhoto')
    ok('★ sendPhoto 的 body 是 FormData', photo?.body === '[FormData]')
    ok('FormData 里有 chat_id / caption / photo 三个字段', !!photo?.formFields && ['chat_id', 'caption', 'photo'].every((k) => k in photo.formFields!), JSON.stringify(photo?.formFields))
    ok('photo 字段是 1024 字节的文件', photo?.formFields?.photo === '[blob 1024B]')
    ok('chat_id 是配置里的会话', photo?.formFields?.chat_id === FAKE_CHAT_ID)
    ok('caption 带实例与账号名', (photo?.formFields?.caption ?? '').includes('实例 1「小号」'))
    ok('只发图时不再额外发一条空文本', sends().length === 0)
  }

  // ④ 未授权会话的 /status → 一条都不回
  calls.length = 0
  performed.length = 0
  pushUpdate(msg('42', '/status'))
  await drain()
  ok('★ 未授权 chat 的命令被忽略：没有 sendMessage、没有 perform', sends().length === 0 && performed.length === 0)
  ok('未授权会话记了一条日志', botLogs.some((l) => l.includes('未授权')))
  calls.length = 0
  pushUpdate(cb('42', 'shot:0', 'cbq-bad'))
  await drain()
  ok('未授权 chat 的回调只被应答「未授权」，不执行', performed.length === 0 && calls.some((c) => methodOf(c) === 'answerCallbackQuery'))

  // ⑤ res:0 回调 → perform('resources', 0) → 文本
  calls.length = 0
  performed.length = 0
  pushUpdate(cb(FAKE_CHAT_ID, 'res:0', 'cbq-res'))
  await drain()
  ok('res:<idx> 回调路由到 resources 动作', performed.some(([a, i]) => a === 'resources' && i === 0))
  ok('资源统计结果以文本发回', sends().some((c) => String(bodyOf(c).text).includes('【资源统计】实例 0')))

  // ⑥ 只有 1 个实例时 required 动作直接执行、不问
  instances = [{ index: 3, name: null }]
  calls.length = 0
  performed.length = 0
  pushUpdate(msg(FAKE_CHAT_ID, '/resources'))
  await drain()
  ok('只有一个实例时不发选择器、直接 perform(resources, 3)', performed.some(([a, i]) => a === 'resources' && i === 3))

  // ⑦ /shot 2 带实例号直接执行；/menu 附菜单键盘；perform 抛异常回「操作失败」
  instances = [
    { index: 0, name: '主号' },
    { index: 1, name: '小号' }
  ]
  calls.length = 0
  performed.length = 0
  pushUpdate(msg(FAKE_CHAT_ID, '/shot 2'))
  pushUpdate(msg(FAKE_CHAT_ID, '/menu'))
  await drain()
  ok('/shot 2 直接 perform(shot, 2)', performed.some(([a, i]) => a === 'shot' && i === 2))
  {
    const menuMsg = sends().find((c) => String(bodyOf(c).text).includes('菜单已刷新'))
    const markup = menuMsg ? (bodyOf(menuMsg).reply_markup as { keyboard?: unknown } | undefined) : undefined
    ok('/menu 的回复附带菜单键盘', Array.isArray(markup?.keyboard))
  }
  {
    const throwing: BotActionPort = {
      perform: async () => {
        throw new AppError('CONCURRENCY_LIMIT', `实例 0 上正有脚本在跑，截图稍后再试。 https://api.telegram.org/bot${FAKE_TOKEN}/x`)
      },
      listInstances: async () => instances
    }
    ;(bot as unknown as { deps: { actions: BotActionPort } }).deps.actions = throwing
    calls.length = 0
    pushUpdate(cb(FAKE_CHAT_ID, 'shot:0', 'cbq-fail'))
    await drain()
    const fail = sends().find((c) => String(bodyOf(c).text).startsWith('操作失败：'))
    ok('perform 抛异常时回「操作失败：<中文原因>」', !!fail && String(bodyOf(fail!).text).includes('稍后再试'))
    ok('★ 回给用户的失败原因里 token 被洗掉', !!fail && !leaks(String(bodyOf(fail!).text)))
    ;(bot as unknown as { deps: { actions: BotActionPort } }).deps.actions = fakePort
  }

  // ⑧ sendPhoto 失败（HTTP 400）→ 退化成文字说明；超过 10MB 不发请求
  {
    const failingFetch: FetchLike = async (url, init) => {
      const m = url.slice(url.lastIndexOf('/') + 1)
      if (m === 'sendPhoto') {
        return { status: 400, text: async () => JSON.stringify({ ok: false, description: `Bad Request: photo ${url}` }) }
      }
      return fetchImpl(url, init)
    }
    ;(bot as unknown as { deps: { fetchImpl: FetchLike } }).deps.fetchImpl = failingFetch
    calls.length = 0
    pushUpdate(cb(FAKE_CHAT_ID, 'shot:1', 'cbq-photo-fail'))
    await drain()
    const fallback = sends().find((c) => String(bodyOf(c).text).includes('截图发送失败'))
    ok('sendPhoto 失败时退化成文字说明（带 caption）', !!fallback && String(bodyOf(fallback!).text).includes('小号'))
    ok('★ 退化文字里 token 被洗掉', !!fallback && !leaks(String(bodyOf(fallback!).text)))
    ;(bot as unknown as { deps: { fetchImpl: FetchLike } }).deps.fetchImpl = fetchImpl

    const huge: BotActionPort = {
      perform: async () => ({
        text: '',
        photo: { jpeg: new ArrayBuffer(11 * 1024 * 1024), caption: '巨图', filename: 'huge.jpg' }
      }),
      listInstances: async () => instances
    }
    ;(bot as unknown as { deps: { actions: BotActionPort } }).deps.actions = huge
    calls.length = 0
    pushUpdate(cb(FAKE_CHAT_ID, 'shot:0', 'cbq-huge'))
    await drain()
    ok('超过 10MB 的图不发 sendPhoto', !calls.some((c) => methodOf(c) === 'sendPhoto'))
    ok('并回一条「超过 Telegram 10MB 限制」的文字', sends().some((c) => String(bodyOf(c).text).includes('10MB')))
    ;(bot as unknown as { deps: { actions: BotActionPort } }).deps.actions = fakePort
  }

  await bot.stop()
  ok('机器人能停下来', !bot.isRunning())

  // ⑨ 泄露扫描：URL 里带 token 是设计（Bot API 就长这样），只扫请求体、FormData 字段与日志。
  const dirtyBodies = calls.filter((c) => leaks(c.body) || leaks(JSON.stringify(c.formFields ?? {})))
  ok('★ 所有请求体 / FormData 字段里都没有 token', dirtyBodies.length === 0)
  ok('★ 机器人日志行里没有 token', botLogs.every((l) => !leaks(l)), botLogs.find((l) => leaks(l)) ?? '')
  ok('日志里确实有内容可扫', botLogs.length >= 2)
}

async function readPause(dataDir: string, index: number): Promise<{ paused: boolean } | undefined> {
  const file = JSON.parse(await readFile(join(dataDir, ALERT_PAUSES_FILE), 'utf8')) as {
    pauses: { instanceIndex: number; paused: boolean }[]
  }
  return file.pauses.find((p) => p.instanceIndex === index)
}

// ══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'wl-alerts-check-'))
  console.log(`临时数据目录：${dataDir}（跑完可以直接删）`)
  console.log('★ 本自检不碰模拟器、不发真实网络请求。')

  setTelegramFetch(tg.impl)

  checkCounting()
  await checkKickedFallback()
  await checkStartupFailureCounted()
  await checkTelegramChannel()

  // 后面几节要用 NotifyHub 的真实读写盘。
  const hub = getNotifyHub()
  await hub.init({
    dataDir: () => dataDir,
    log: (level, message) => hubLogs.push(`[${level}] ${message}`)
  })
  await hub.saveConfig({
    telegram: { enabled: true, botToken: FAKE_TOKEN, chatId: FAKE_CHAT_ID, retryCount: 0 }
  })
  hub.registerConfigHandlers()

  await checkTokenLeak(dataDir)
  await checkThrottle(dataDir)
  await checkEndToEnd(dataDir)
  await checkBotChannel()

  setTelegramFetch(null)

  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
  if (fail > 0) process.exitCode = 1
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
