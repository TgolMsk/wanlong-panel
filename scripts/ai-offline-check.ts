/**
 * AI 顾问（视觉大模型兜底 + 模板自学习）的**离线**自检。
 *
 * ★★ 全程不碰模拟器、不发一个真实网络请求：
 *     · fetch 是假的（setAiFetch 注入，请求全部记在内存里，按剧本回复）
 *     · 设备是假的（RecoverIo 只记录点击，截图返回合成帧）
 *     · 模板库落在 os.tmpdir() 下的临时目录，跑完就扔
 *
 *   npm run check:ai
 *
 * 覆盖：
 *   一、配置：归一化 / 三态合并 / 打码视图（类型与值上都没有 apiKey）/ 体检
 *   二、客户端：请求形状（URL、Bearer 头、data URL 图片、模型名）；401 / 404 / 400-图片 / 429 / 500 /
 *       非 JSON / 超时 / 网络异常 各自的分类与中文话术；★ apiKey 泄露实测（异常消息里带 key 也洗掉）
 *   三、视觉探测：认出 W ⇒ 通过；答非所问 ⇒ 判「不支持图片」；400 提到 image ⇒ kind=vision
 *   四、回复解析：```json 围栏、bbox 数组写法、白名单外动作、tap 缺框、框过大
 *   五、限频：每小时上限、同实例冷却
 *   六、★ 端到端：合成一张带弹窗 × 的 2560x1440 帧 → 假 AI 给框（两阶段）→ 点击落点正确 →
 *       复验通过 → 自学出 tpl_btn_close_popup → 用正式视觉层 loadPrepared + matchIn 在原帧上重新命中 →
 *       第二次同样的弹窗「已有模板覆盖」不再学；back / 低置信 / 点了没反应 三种情况都不动手、不学
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  defaultAiConfig,
  mergeAiConfig,
  normalizeAiConfig,
  redactAiConfig,
  toAiConfigView,
  validateAiConfig,
  type AiConfig,
  type AiConsultRecord
} from '@shared/ai'
import type { RawFrame } from '@shared/vision'
import {
  AiAdvisor,
  CLOSE_POPUP_TEMPLATE_ID,
  aiRecoverUnknownScreen,
  chatCompletionsUrl,
  chatVision,
  meanAbsDiff,
  nextHarvestId,
  parseAdvice,
  probeVision,
  setAiFetch,
  type FetchLike,
  type RecoverIo
} from '@main/ai/index'
import {
  createSet,
  loadPrepared,
  matchIn,
  prepareFrame,
  readSet,
  setTemplatesDir
} from '@vision/index'

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

/** ★ 测试用假 Key，形状像真的但绝对无效。 */
const FAKE_KEY = 'sk-fakekey-0123456789abcdefFAKE'
const FAKE_KEY_TAIL = '0123456789abcdefFAKE'

function leaks(text: string): boolean {
  return text.includes(FAKE_KEY) || text.includes(FAKE_KEY_TAIL)
}

function cfgWith(patch: Partial<AiConfig> = {}): AiConfig {
  return normalizeAiConfig({
    ...defaultAiConfig(),
    enabled: true,
    apiKey: FAKE_KEY,
    model: 'fake-vl',
    baseUrl: 'https://ai.example.test/v1',
    timeoutMs: 5000,
    cooldownSeconds: 0,
    ...patch
  })
}

// ── 假 fetch ─────────────────────────────────────────────────────────────

interface FakeCall {
  url: string
  headers: Record<string, string>
  body: string
}
interface FakeReply {
  status: number
  body: string
  throwWith?: () => Error
}

class FakeApi {
  readonly calls: FakeCall[] = []
  private script: FakeReply[] = []
  fallback: FakeReply = {
    status: 200,
    body: chatBody(
      '{"screen":"unknown","action":"none","target":null,"confidence":0.3,"reason":"看不出来"}'
    )
  }

  queue(...replies: FakeReply[]): void {
    this.script.push(...replies)
  }
  reset(): void {
    this.script = []
    this.calls.length = 0
  }
  get impl(): FetchLike {
    return async (url, init) => {
      this.calls.push({ url, headers: init.headers, body: init.body })
      const r = this.script.shift() ?? this.fallback
      if (r.throwWith) throw r.throwWith()
      return { status: r.status, text: async () => r.body }
    }
  }
}

/** 造一个 chat/completions 的成功响应体。 */
function chatBody(content: string, model = 'fake-vl'): string {
  return JSON.stringify({ model, choices: [{ message: { role: 'assistant', content } }] })
}

const api = new FakeApi()
setAiFetch(api.impl)

// ── 合成帧 ───────────────────────────────────────────────────────────────
//
// 2560x1440 RGBA。背景是 64px 的棋盘格（有纹理，shrink=4 的差异才有意义）；
// 「弹窗」是一块浅色大矩形；右上角 (1840,220) 处 80x80 的白底黑 × 就是要学的关闭按钮。

const W = 2560
const H = 1440
const BTN = { x: 1840, y: 220, w: 80, h: 80 }

function makeFrame(withPopup: boolean): RawFrame {
  const data = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = ((x >> 6) + (y >> 6)) % 2 === 0 ? 92 : 112
      if (withPopup) {
        const inPopup = x >= 700 && x < 1900 && y >= 200 && y < 1240
        if (inPopup) v = 205
        const bx = x - BTN.x
        const by = y - BTN.y
        if (bx >= 0 && bx < BTN.w && by >= 0 && by < BTN.h) {
          v = 250
          // 两条对角线（粗 6px）
          if (Math.abs(bx - by) < 6 || Math.abs(bx + by - (BTN.w - 1)) < 6) v = 10
          // 边框
          if (bx < 3 || by < 3 || bx >= BTN.w - 3 || by >= BTN.h - 3) v = 40
        }
      } else {
        // 「世界地图」的标志物：左下角一块深色块 + 右侧一条亮竖线，让复验有东西可认。
        if (x >= 100 && x < 300 && y >= 1250 && y < 1400) v = 30
        if (x >= 2400 && x < 2420 && y >= 300 && y < 900) v = 240
      }
      const i = (y * W + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return { width: W, height: H, format: 1, data, capturedAt: Date.now() }
}

/** 假 IO：记录点击；capture 返回「点击后的帧」（由测试决定是哪一帧）。 */
function makeIo(
  after: () => RawFrame
): RecoverIo & { taps: Array<[number, number]>; keys: string[] } {
  const taps: Array<[number, number]> = []
  const keys: string[] = []
  return {
    taps,
    keys,
    capture: async () => after(),
    tap: async (x, y) => {
      taps.push([x, y])
    },
    key: async (k) => {
      keys.push(k)
    }
  }
}

/** 复验判据：弹窗区域里的像素还是浅色 ⇒ 弹窗还在 ⇒ 不是已知界面。 */
async function recognizeNoPopup(raw: RawFrame): Promise<boolean> {
  const i = (600 * W + 1300) * 4
  return raw.data[i]! < 150
}

// ── 顾问工厂 ─────────────────────────────────────────────────────────────

const logs: string[] = []
const emitted: AiConsultRecord[] = []

function makeAdvisor(cfg: AiConfig, dataDir: string): AiAdvisor {
  const a = new AiAdvisor()
  a.setConfigForTest(cfg, {
    dataDir: () => dataDir,
    log: (level, message) => logs.push(`[${level}] ${message}`),
    emit: (ch, payload) => {
      if (ch === 'ai:consulted') emitted.push(payload as AiConsultRecord)
    }
  })
  return a
}

const quietLog = (): void => undefined

// ═══════════════════════════════════════════════════════════════════════════

async function checkConfig(): Promise<void> {
  section('一、配置')
  const d = defaultAiConfig()
  ok('默认关闭', d.enabled === false)
  ok(
    '默认模型是 qwen3.8-flash、地址是百炼兼容模式',
    d.model === 'qwen3.8-flash' && d.baseUrl.includes('dashscope')
  )

  const n = normalizeAiConfig({
    enabled: 'yes',
    maxCallsPerHour: 99999,
    minConfidence: 7,
    baseUrl: ' https://x.test/v1/ ',
    imageWidth: 10
  })
  ok(
    '归一化：非布尔回默认、越界夹回范围、地址去尾斜杠',
    n.enabled === false &&
      n.maxCallsPerHour === 500 &&
      n.minConfidence === 1 &&
      n.baseUrl === 'https://x.test/v1' &&
      n.imageWidth === 640
  )

  const base = cfgWith()
  const m1 = mergeAiConfig(base, { model: 'other' })
  ok('合并：不带 apiKey 键 ⇒ 保持原 Key', m1.apiKey === FAKE_KEY && m1.model === 'other')
  const m2 = mergeAiConfig(base, { apiKey: '' })
  ok('合并：apiKey 空串 ⇒ 显式清空', m2.apiKey === '')
  const m3 = mergeAiConfig(base, { apiKey: 'sk-new-key-xxxxxxxx' })
  ok('合并：apiKey 非空 ⇒ 覆盖', m3.apiKey === 'sk-new-key-xxxxxxxx')

  const view = toAiConfigView(base) as unknown as Record<string, unknown>
  ok('★ 打码视图里没有 apiKey 键', !('apiKey' in view))
  ok(
    '打码视图：apiKeySet + 只留后 4 位',
    view.apiKeySet === true &&
      String(view.apiKeyMasked).endsWith('FAKE') &&
      !leaks(String(view.apiKeyMasked))
  )
  ok('日志形状里 Key 已打码', !leaks(JSON.stringify(redactAiConfig(base))))

  ok('体检：合法配置无问题', validateAiConfig(base).length === 0)
  ok(
    '体检：地址带 /chat/completions 会被指出',
    validateAiConfig(cfgWith({ baseUrl: 'https://x.test/v1/chat/completions' })).some((p) =>
      p.includes('/chat/completions')
    )
  )
  ok(
    '体检：没 Key 会被指出',
    validateAiConfig(cfgWith({ apiKey: '' })).some((p) => p.includes('API Key'))
  )
}

async function checkClient(): Promise<void> {
  section('二、客户端')
  const cfg = cfgWith()
  const img = new Uint8Array([1, 2, 3, 4])

  api.reset()
  api.queue({ status: 200, body: chatBody('hello') })
  const r = await chatVision(cfg, { system: 'S', user: 'U', image: img, mime: 'image/png' })
  ok('成功：拿到文本与模型名', r.ok && r.text === 'hello' && r.model === 'fake-vl')
  const call = api.calls[0]!
  ok(
    'URL = baseUrl + /chat/completions',
    call.url === chatCompletionsUrl(cfg.baseUrl) && call.url.endsWith('/v1/chat/completions')
  )
  ok('Bearer 头带 Key', call.headers.authorization === `Bearer ${FAKE_KEY}`)
  const body = JSON.parse(call.body) as {
    model: string
    messages: Array<{ role: string; content: unknown }>
  }
  ok(
    '请求体：模型名 + system + user',
    body.model === 'fake-vl' &&
      body.messages[0]!.role === 'system' &&
      body.messages[1]!.role === 'user'
  )
  const parts = body.messages[1]!.content as Array<{ type: string; image_url?: { url: string } }>
  ok(
    '图片以 data URL 放在 user 消息里',
    parts.some(
      (p) => p.type === 'image_url' && p.image_url!.url.startsWith('data:image/png;base64,AQIDBA==')
    )
  )

  // content 是分段数组的响应也能解
  api.queue({
    status: 200,
    body: JSON.stringify({
      model: 'x',
      choices: [{ message: { content: [{ type: 'text', text: 'seg' }] } }]
    })
  })
  const r2 = await chatVision(cfg, { system: 'S', user: 'U', image: img, mime: 'image/png' })
  ok('content 分段数组也能解', r2.ok && r2.text === 'seg')

  const cases: Array<[string, FakeReply, string, (m: string) => boolean]> = [
    [
      '401 ⇒ auth',
      { status: 401, body: '{"error":{"message":"Invalid API key"}}' },
      'auth',
      (m) => m.includes('鉴权')
    ],
    [
      '404 且提到 model ⇒ model',
      { status: 404, body: '{"error":{"message":"model not found"}}' },
      'model',
      (m) => m.includes('404')
    ],
    [
      '400 提到 image ⇒ vision',
      { status: 400, body: '{"error":{"message":"This model does not support image input"}}' },
      'vision',
      (m) => m.includes('不接受图片')
    ],
    [
      '400 其它 ⇒ bad_request',
      { status: 400, body: '{"error":{"message":"max_tokens too large"}}' },
      'bad_request',
      (m) => m.includes('max_tokens')
    ],
    [
      '429 ⇒ rate',
      { status: 429, body: '{"error":{"message":"rate limit"}}' },
      'rate',
      (m) => m.includes('限流')
    ],
    ['500 ⇒ server', { status: 500, body: 'oops' }, 'server', (m) => m.includes('服务端')],
    [
      '200 但不是 JSON ⇒ bad_response',
      { status: 200, body: '<html>' },
      'bad_response',
      (m) => m.includes('不是 JSON')
    ],
    [
      '200 但空内容 ⇒ bad_response',
      { status: 200, body: chatBody('') },
      'bad_response',
      (m) => m.includes('空内容')
    ]
  ]
  for (const [name, reply, kind, check] of cases) {
    api.queue(reply)
    const x = await chatVision(cfg, { system: 'S', user: 'U', image: img, mime: 'image/png' })
    ok(
      name,
      !x.ok && x.kind === kind && check(x.message),
      !x.ok ? `${x.kind}: ${x.message.slice(0, 80)}` : 'ok?!'
    )
  }

  // 超时 / 网络异常 + ★ Key 泄露实测
  const te = new Error('The operation was aborted due to timeout')
  te.name = 'TimeoutError'
  api.queue({ status: 0, body: '', throwWith: () => te })
  const t = await chatVision(cfg, { system: 'S', user: 'U', image: img, mime: 'image/png' })
  ok('超时 ⇒ timeout', !t.ok && t.kind === 'timeout')

  api.queue({
    status: 0,
    body: '',
    throwWith: () =>
      new Error(`fetch failed: https://ai.example.test/v1 Bearer ${FAKE_KEY} ECONNREFUSED`)
  })
  const nw = await chatVision(cfg, { system: 'S', user: 'U', image: img, mime: 'image/png' })
  ok('网络异常 ⇒ network', !nw.ok && nw.kind === 'network')
  ok(
    '★ 异常消息里的 Key 被洗掉',
    !nw.ok && !leaks(nw.message),
    nw.ok ? '' : nw.message.slice(0, 100)
  )

  api.queue({ status: 401, body: `{"error":{"message":"bad key ${FAKE_KEY}"}}` })
  const lk = await chatVision(cfg, { system: 'S', user: 'U', image: img, mime: 'image/png' })
  ok('★ 响应体里的 Key 也被洗掉', !lk.ok && !leaks(lk.message))

  const bad = await chatVision(cfgWith({ apiKey: '' }), {
    system: 'S',
    user: 'U',
    image: img,
    mime: 'image/png'
  })
  ok(
    '配置不完整 ⇒ config，且不发请求',
    !bad.ok && bad.kind === 'config' && api.calls.length === cases.length + 5
  )
}

async function checkProbe(): Promise<void> {
  section('三、视觉能力探测')
  const cfg = cfgWith()
  api.reset()
  api.queue({ status: 200, body: chatBody('这个字母是 W。', 'qwen-fake') })
  const a = await probeVision(cfg)
  ok(
    '认出 W ⇒ ok / vision=true',
    a.ok && a.vision === true && a.model === 'qwen-fake' && a.message.includes('能看图')
  )
  const sent = JSON.parse(api.calls[0]!.body) as { messages: Array<{ content: unknown }> }
  const parts = sent.messages[1]!.content as Array<{ type: string; image_url?: { url: string } }>
  ok(
    '探测确实发了一张 PNG',
    parts.some((p) => p.image_url?.url.startsWith('data:image/png;base64,'))
  )

  api.queue({ status: 200, body: chatBody('我无法查看图片，请描述图片内容。') })
  const b = await probeVision(cfg)
  ok(
    '答非所问 ⇒ ok=false / vision=false / kind=vision',
    !b.ok && b.vision === false && b.kind === 'vision' && b.reply !== null
  )

  api.queue({
    status: 400,
    body: '{"error":{"message":"invalid content type: image_url is not supported"}}'
  })
  const c = await probeVision(cfg)
  ok('400 提到 image ⇒ vision=false', !c.ok && c.vision === false && c.kind === 'vision')

  api.queue({ status: 401, body: '{"error":{"message":"unauthorized"}}' })
  const d = await probeVision(cfg)
  ok('401 ⇒ vision=null（没走到看图那一步）', !d.ok && d.vision === null && d.kind === 'auth')
}

async function checkParse(): Promise<void> {
  section('四、回复解析')
  const p1 = parseAdvice(
    '```json\n{"screen":"popup","action":"tap_close","target":{"x":10,"y":20,"w":40,"h":40},"confidence":0.9,"reason":"有×"}\n```',
    1280,
    720
  )
  ok(
    '围栏里的 JSON 能解',
    p1.ok &&
      p1.action === 'tap_close' &&
      p1.target?.x === 10 &&
      p1.confidence === 0.9 &&
      p1.screen === 'popup'
  )
  const p2 = parseAdvice(
    '结果如下：{"screen":"dialog","action":"tap_cancel","target":{"bbox":[100,100,150,140]},"confidence":"0.8"}',
    1280,
    720
  )
  ok(
    'bbox 数组写法 + 字符串置信度',
    p2.ok && p2.target?.w === 50 && p2.target?.h === 40 && p2.confidence === 0.8
  )
  const p3 = parseAdvice(
    '{"screen":"popup","action":"tap_confirm","target":{"x":1,"y":1,"w":40,"h":40},"confidence":1}',
    1280,
    720
  )
  ok('白名单外的动作被拒', !p3.ok)
  const p4 = parseAdvice(
    '{"screen":"popup","action":"tap_close","target":null,"confidence":1}',
    1280,
    720
  )
  ok('tap_close 没框被拒', !p4.ok)
  const p5 = parseAdvice(
    '{"screen":"popup","action":"tap_close","target":{"x":0,"y":0,"w":900,"h":600},"confidence":1}',
    1280,
    720
  )
  ok('框大得离谱被拒', !p5.ok)
  const p6 = parseAdvice(
    '{"screen":"loading","action":"none","target":{"x":0,"y":0,"w":40,"h":40},"confidence":1}',
    1280,
    720
  )
  ok('none 动作忽略框', p6.ok && p6.action === 'none' && p6.target === null)
  const p7 = parseAdvice('我不知道', 1280, 720)
  ok('没有 JSON ⇒ 解析失败', !p7.ok)
  ok('nextHarvestId：原 id 空着就用它', nextHarvestId(['tpl_a']) === CLOSE_POPUP_TEMPLATE_ID)
  ok(
    'nextHarvestId：已有原 id ⇒ _ai2',
    nextHarvestId([CLOSE_POPUP_TEMPLATE_ID]) === `${CLOSE_POPUP_TEMPLATE_ID}_ai2`
  )
  ok(
    'nextHarvestId：满 8 张 ⇒ null',
    nextHarvestId([
      CLOSE_POPUP_TEMPLATE_ID,
      ...[2, 3, 4, 5, 6, 7, 8].map((n) => `${CLOSE_POPUP_TEMPLATE_ID}_ai${n}`)
    ]) === null
  )
}

async function checkRateLimit(dataDir: string): Promise<void> {
  section('五、限频')
  const frame = makeFrame(true)
  const adv = makeAdvisor(
    cfgWith({ maxCallsPerHour: 2, cooldownSeconds: 0, refine: false }),
    dataDir
  )
  api.reset()
  const input = {
    instanceIndex: 1,
    context: 't',
    raw: frame,
    refWidth: W,
    refHeight: H,
    attempt: 1
  }
  const c1 = await adv.consult(input)
  const c2 = await adv.consult(input)
  const c3 = await adv.consult(input)
  ok('前两次真的发了请求', c1.advice !== null && c2.advice !== null && api.calls.length === 2)
  ok(
    '第三次被每小时上限拦下',
    c3.advice === null && c3.outcome === 'skipped' && c3.reason.includes('上限')
  )

  const adv2 = makeAdvisor(
    cfgWith({ maxCallsPerHour: 0, cooldownSeconds: 60, refine: false }),
    dataDir
  )
  api.reset()
  const d1 = await adv2.consult(input)
  const d2 = await adv2.consult(input)
  const d3 = await adv2.consult({ ...input, instanceIndex: 2 })
  ok(
    '同实例 60s 内第二次被冷却拦下',
    d1.advice !== null &&
      d2.advice === null &&
      d2.outcome === 'skipped' &&
      d2.reason.includes('冷却') === false &&
      d2.reason.includes('不足')
  )
  ok('换一个实例不受该冷却影响', d3.advice !== null && api.calls.length === 2)

  const off = makeAdvisor(cfgWith({ enabled: false }), dataDir)
  api.reset()
  const e1 = await off.consult(input)
  ok(
    '未启用 ⇒ 不发请求、不算 skipped 记录',
    e1.advice === null && e1.outcome === null && api.calls.length === 0
  )
}

async function checkEndToEnd(dataDir: string): Promise<void> {
  section('六、端到端：点掉弹窗 → 自学模板 → 本地重新认出')
  const templatesDir = join(dataDir, 'templates')
  setTemplatesDir(templatesDir)
  const set = await createSet('AI 自检模板集', 'com.lilithgames.samo.android.cn')

  const before = makeFrame(true)
  const after = makeFrame(false)
  const diff = await meanAbsDiff(before, after, W, H)
  ok('两帧差异足够大（复验判据有意义）', diff > 6, `差异 ${diff.toFixed(1)}`)
  ok(
    '复验判据：弹窗帧不算已知界面、干净帧算',
    !(await recognizeNoPopup(before)) && (await recognizeNoPopup(after))
  )

  const adv = makeAdvisor(
    cfgWith({ refine: true, autoHarvest: true, minConfidence: 0.5, imageWidth: 1280 }),
    dataDir
  )
  emitted.length = 0

  // 第一阶段：整帧 1280x720，按钮在 (920,110) 40x40；第二阶段：局部放大图 480x480，按钮在 (160,160) 160x160。
  api.reset()
  api.queue(
    {
      status: 200,
      body: chatBody(
        '{"screen":"popup","action":"tap_close","target":{"x":920,"y":110,"w":40,"h":40},"confidence":0.92,"reason":"活动弹窗右上角有关闭按钮"}'
      )
    },
    {
      status: 200,
      body: chatBody('{"target":{"x":160,"y":160,"w":160,"h":160},"confidence":0.95}')
    }
  )
  const io = makeIo(() => after)
  const r = await aiRecoverUnknownScreen(adv, {
    instanceIndex: 1,
    context: 'gather-g0',
    raw: before,
    io,
    refWidth: W,
    refHeight: H,
    setId: set.id,
    attempt: 3,
    recognize: recognizeNoPopup,
    existingCloseTemplates: [],
    log: quietLog
  })
  ok(
    'handled=true，结果是 harvested',
    r.handled && r.outcome === 'harvested',
    `${r.outcome}: ${r.message}`
  )
  ok('发了两次请求（整帧 + 局部放大）', api.calls.length === 2)
  const secondBody = JSON.parse(api.calls[1]!.body) as { messages: Array<{ content: unknown }> }
  const secondParts = secondBody.messages[1]!.content as Array<{ image_url?: { url: string } }>
  ok(
    '第二次发的是 PNG 局部图',
    secondParts.some((p) => p.image_url?.url.startsWith('data:image/png;base64,'))
  )
  ok(
    '精修框映射回参考坐标正确',
    r.advice?.refined === true &&
      r.advice.target?.x === BTN.x &&
      r.advice.target?.y === BTN.y &&
      r.advice.target?.w === BTN.w &&
      r.advice.target?.h === BTN.h,
    JSON.stringify(r.advice?.target)
  )
  const [tx, ty] = io.taps[0] ?? [-1, -1]
  ok(
    '点击落在按钮中心',
    io.taps.length === 1 &&
      Math.abs(tx - (BTN.x + BTN.w / 2)) <= 1 &&
      Math.abs(ty - (BTN.y + BTN.h / 2)) <= 1,
    `tap=(${tx},${ty})`
  )
  ok('没有按任何键', io.keys.length === 0)

  const saved = await readSet(set.id)
  const def = saved.templates.find((t) => t.id === CLOSE_POPUP_TEMPLATE_ID)
  ok(
    '模板库里多了 tpl_btn_close_popup',
    def !== undefined && r.harvestedTemplateId === CLOSE_POPUP_TEMPLATE_ID
  )
  ok(
    '带 ai-harvest 标签、bounds 贴着按钮',
    !!def &&
      (def.tags ?? []).includes('ai-harvest') &&
      Math.abs(def.bounds.x - BTN.x) <= 4 &&
      Math.abs(def.bounds.y - BTN.y) <= 4 &&
      def.bounds.w >= BTN.w &&
      def.bounds.w <= BTN.w + 8,
    def ? JSON.stringify(def.bounds) : ''
  )
  ok('模板 std 通过方差守卫', !!def && (def.std ?? 0) >= 12, `std ${def?.std}`)
  ok(
    '记录已推给面板',
    emitted.some(
      (e) => e.outcome === 'harvested' && e.harvestedTemplateId === CLOSE_POPUP_TEMPLATE_ID
    )
  )
  ok('状态计数', adv.status().harvestedCount === 1 && adv.status().consultCount === 1)

  // ★ 闭环：用正式视觉层加载刚学的模板，在原帧上重新命中
  const prepared = await loadPrepared(set.id, { refW: W, shrink: 2 })
  const tpl = prepared.get(CLOSE_POPUP_TEMPLATE_ID)
  ok('loadPrepared 能编译新模板', tpl !== undefined)
  if (tpl) {
    const frame = await prepareFrame(before, { refW: W, refH: H, shrink: 2 })
    const m = await matchIn(frame, tpl, { roi: tpl.defaultRoi })
    ok(
      '★ 新模板在原帧上重新命中、位置正确',
      m.found &&
        Math.abs(m.centerX - (BTN.x + BTN.w / 2)) <= 4 &&
        Math.abs(m.centerY - (BTN.y + BTN.h / 2)) <= 4,
      `score ${m.score} @ (${m.centerX},${m.centerY})`
    )
    const mAfter = await matchIn(await prepareFrame(after, { refW: W, refH: H, shrink: 2 }), tpl, {
      roi: tpl.defaultRoi
    })
    ok('新模板在干净帧上不命中（负样本）', !mAfter.found, `score ${mAfter.score}`)

    // 第二次同样的弹窗：已有模板覆盖 ⇒ verified 但不再学
    api.reset()
    api.queue({
      status: 200,
      body: chatBody(
        '{"screen":"popup","action":"tap_close","target":{"x":920,"y":110,"w":40,"h":40},"confidence":0.9,"reason":"×"}'
      )
    })
    const io2 = makeIo(() => after)
    const r2 = await aiRecoverUnknownScreen(adv, {
      instanceIndex: 1,
      context: 'gather-g0',
      raw: before,
      io: io2,
      refWidth: W,
      refHeight: H,
      setId: set.id,
      attempt: 3,
      recognize: recognizeNoPopup,
      existingCloseTemplates: [tpl],
      log: quietLog
    })
    ok(
      '已有模板能认出 ⇒ verified 且不重复学',
      r2.handled && r2.outcome === 'verified' && r2.message.includes('不再重复'),
      r2.message
    )
    ok('模板数没变', (await readSet(set.id)).templates.length === 1)
  }

  // back 建议：不动手、不学
  api.reset()
  api.queue({
    status: 200,
    body: chatBody(
      '{"screen":"other","action":"back","target":null,"confidence":0.8,"reason":"在背包页"}'
    )
  })
  const io3 = makeIo(() => after)
  const r3 = await aiRecoverUnknownScreen(adv, {
    instanceIndex: 1,
    context: 'gather-g0',
    raw: before,
    io: io3,
    refWidth: W,
    refHeight: H,
    setId: set.id,
    attempt: 4,
    recognize: recognizeNoPopup,
    existingCloseTemplates: [],
    log: quietLog
  })
  ok(
    'back ⇒ no_action，不点不按',
    !r3.handled && r3.outcome === 'no_action' && io3.taps.length === 0 && io3.keys.length === 0
  )

  // 低置信：不动手
  api.queue({
    status: 200,
    body: chatBody(
      '{"screen":"popup","action":"tap_close","target":{"x":920,"y":110,"w":40,"h":40},"confidence":0.2,"reason":"不太确定"}'
    )
  })
  const io4 = makeIo(() => after)
  const r4 = await aiRecoverUnknownScreen(adv, {
    instanceIndex: 1,
    context: 'gather-g0',
    raw: before,
    io: io4,
    refWidth: W,
    refHeight: H,
    setId: set.id,
    attempt: 4,
    recognize: recognizeNoPopup,
    existingCloseTemplates: [],
    log: quietLog
  })
  ok('低置信 ⇒ rejected，不点', !r4.handled && r4.outcome === 'rejected' && io4.taps.length === 0)

  // 点了没反应（after 仍是弹窗帧）⇒ rejected，不学
  api.queue({
    status: 200,
    body: chatBody(
      '{"screen":"popup","action":"tap_close","target":{"x":300,"y":300,"w":40,"h":40},"confidence":0.9,"reason":"认错了"}'
    )
  })
  const io5 = makeIo(() => before)
  const r5 = await aiRecoverUnknownScreen(adv, {
    instanceIndex: 1,
    context: 'gather-g0',
    raw: before,
    io: io5,
    refWidth: W,
    refHeight: H,
    setId: set.id,
    attempt: 4,
    recognize: recognizeNoPopup,
    existingCloseTemplates: [],
    log: quietLog
  })
  ok(
    '点了画面没变 ⇒ rejected，不学',
    !r5.handled &&
      r5.outcome === 'rejected' &&
      io5.taps.length === 1 &&
      (await readSet(set.id)).templates.length === 1,
    r5.message
  )

  // 画面变了但没回到已知界面 ⇒ applied（handled）但不学。
  // 弹窗下半截被涂黑（画面明显变了），但复验采样点 (1300,600) 仍是弹窗的浅色 ⇒ 不算已知界面。
  const halfway = makeFrame(true)
  for (let y = 800; y < 1200; y++)
    for (let x = 700; x < 1900; x++)
      halfway.data[(y * W + x) * 4] =
        halfway.data[(y * W + x) * 4 + 1] =
        halfway.data[(y * W + x) * 4 + 2] =
          20
  api.queue({
    status: 200,
    body: chatBody(
      '{"screen":"popup","action":"tap_close","target":{"x":920,"y":110,"w":40,"h":40},"confidence":0.9,"reason":"×"}'
    )
  })
  const io6 = makeIo(() => halfway)
  const r6 = await aiRecoverUnknownScreen(adv, {
    instanceIndex: 1,
    context: 'scheduler-sample',
    raw: before,
    io: io6,
    refWidth: W,
    refHeight: H,
    setId: set.id,
    attempt: 3,
    recognize: recognizeNoPopup,
    existingCloseTemplates: [],
    log: quietLog
  })
  ok(
    '画面变了但没回已知界面 ⇒ applied、handled=true、不学',
    r6.handled && r6.outcome === 'applied' && (await readSet(set.id)).templates.length === 1,
    r6.message
  )

  // 请求失败 ⇒ failed，不动手
  api.queue({ status: 500, body: 'boom' })
  const io7 = makeIo(() => after)
  const r7 = await aiRecoverUnknownScreen(adv, {
    instanceIndex: 1,
    context: 'gather-g0',
    raw: before,
    io: io7,
    refWidth: W,
    refHeight: H,
    setId: set.id,
    attempt: 3,
    recognize: recognizeNoPopup,
    existingCloseTemplates: [],
    log: quietLog
  })
  ok('请求失败 ⇒ failed，不点', !r7.handled && r7.outcome === 'failed' && io7.taps.length === 0)

  ok('★ 全部日志与记录里没有 Key', !logs.some(leaks) && !emitted.some((e) => leaks(e.message)))
  ok(
    '历史记录条数正确（1 harvested + 1 verified + no_action + 2 rejected + applied + failed = 7）',
    adv.history().length === 7,
    `${adv.history().length}`
  )
}

// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('AI 顾问 —— 离线自检（不碰模拟器、不发真实网络请求）')
  const dataDir = await mkdtemp(join(tmpdir(), 'wl-ai-check-'))
  try {
    await checkConfig()
    await checkClient()
    await checkProbe()
    await checkParse()
    await checkRateLimit(dataDir)
    await checkEndToEnd(dataDir)
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e))
  process.exitCode = 1
})
