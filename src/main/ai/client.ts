/**
 * OpenAI 兼容接口的视觉调用客户端（POST <baseUrl>/chat/completions，图片走 data URL）。
 *
 * 只做一件事：发一张图 + 两段提示词，把回复文本和失败原因（中文、已洗掉 apiKey）交回去。
 * 它**不认识**「界面」「模板」「实例」—— 那些是 advisor.ts / recover.ts 的事。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【★★ 凭据纪律】apiKey 在请求头 Authorization: Bearer <key> 里。
 *   · 每一处 catch 的第一件事就是 scrubSecret(describeThrown(e), apiKey)
 *   · chatVision() **绝不抛异常**，一切失败走返回值
 *   · 不取 stack（栈里可能带请求信息，对用户也毫无意义）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 【为什么不用 response_format: json_object】
 * 不是所有兼容网关都支持它与图片同时出现（有的直接 400）。提示词里要求纯 JSON，
 * 解析时再宽容地把 ```json 围栏和前后废话剥掉，比依赖网关特性稳。
 *
 * 【fetch 的选择】与 Telegram 通道一致：优先 Electron 的 net.fetch（遵守系统代理），
 * 纯 node（离线自检）回落到全局 fetch；自检可以 setAiFetch 注入假实现。
 */

import type { AiConfig, AiFailureKind, AiTestResult } from '@shared/ai'
import { scrubAiSecret, validateAiConfig } from '@shared/ai'
import { describeThrown } from '@main/alerts/telegram'
import { sharp } from '@vision/cv'

// ── HTTP 抽象（与 telegram.ts 同样刻意不引全局 RequestInit / Response 类型）──

interface HttpResponse {
  readonly status: number
  text(): Promise<string>
}

export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  }
) => Promise<HttpResponse>

let cachedFetch: FetchLike | null = null

export async function resolveAiFetch(): Promise<FetchLike> {
  if (cachedFetch) return cachedFetch
  try {
    const mod = (await import('electron')) as { net?: { fetch?: unknown } }
    const f = mod.net?.fetch
    if (typeof f === 'function') {
      cachedFetch = f.bind(mod.net) as FetchLike
      return cachedFetch
    }
  } catch {
    // 不在 Electron 里（离线自检脚本），静默回落。
  }
  const g = (globalThis as { fetch?: unknown }).fetch
  if (typeof g === 'function') {
    cachedFetch = g as FetchLike
    return cachedFetch
  }
  throw new Error('当前运行环境没有可用的 fetch 实现，无法调用 AI 接口。')
}

/** 离线自检注入假 fetch；传 null 恢复自动挑选。 */
export function setAiFetch(impl: FetchLike | null): void {
  cachedFetch = impl
}

// ── 请求 / 回复 ───────────────────────────────────────────────────────────

export interface VisionRequest {
  system: string
  user: string
  /** 已编码的图片字节。 */
  image: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  maxTokens?: number
  temperature?: number
}

export type VisionReply =
  | { ok: true; text: string; model: string; latencyMs: number }
  | { ok: false; kind: AiFailureKind; message: string; status: number | null; latencyMs: number }

/** baseUrl 只填到 /v1，这里拼上路径。 */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

/**
 * 发一次「文本 + 一张图」的对话请求。**绝不抛异常**。
 */
export async function chatVision(cfg: AiConfig, req: VisionRequest): Promise<VisionReply> {
  const t0 = Date.now()
  const problems = validateAiConfig(cfg)
  if (problems.length > 0) {
    return { ok: false, kind: 'config', message: problems.join(' '), status: null, latencyMs: 0 }
  }

  const body = JSON.stringify({
    model: cfg.model,
    temperature: req.temperature ?? 0,
    max_tokens: req.maxTokens ?? 400,
    messages: [
      { role: 'system', content: req.system },
      {
        role: 'user',
        content: [
          { type: 'text', text: req.user },
          {
            type: 'image_url',
            image_url: {
              url: `data:${req.mime};base64,${Buffer.from(req.image).toString('base64')}`
            }
          }
        ]
      }
    ]
  })

  let fetchImpl: FetchLike
  try {
    fetchImpl = await resolveAiFetch()
  } catch (e) {
    return {
      ok: false,
      kind: 'network',
      message: scrubAiSecret(describeThrown(e), cfg),
      status: null,
      latencyMs: Date.now() - t0
    }
  }

  let res: HttpResponse
  try {
    res = await fetchImpl(chatCompletionsUrl(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`
      },
      body,
      signal: AbortSignal.timeout(cfg.timeoutMs)
    })
  } catch (e) {
    const raw = scrubAiSecret(describeThrown(e), cfg)
    const name = e instanceof Error ? e.name : ''
    const isTimeout =
      name === 'TimeoutError' || name === 'AbortError' || /timeout|aborted/i.test(raw)
    return {
      ok: false,
      kind: isTimeout ? 'timeout' : 'network',
      message: isTimeout
        ? `请求超过 ${Math.round(cfg.timeoutMs / 1000)} 秒没有返回，已放弃。可以在设置里调大超时，或检查网络/代理。`
        : `网络请求失败：${raw}。请确认接口地址能访问（浏览器能打开吗？）以及代理设置。`,
      status: null,
      latencyMs: Date.now() - t0
    }
  }

  let text = ''
  try {
    text = await res.text()
  } catch (e) {
    return {
      ok: false,
      kind: 'network',
      message: `读取响应失败：${scrubAiSecret(describeThrown(e), cfg)}`,
      status: res.status,
      latencyMs: Date.now() - t0
    }
  }
  const latencyMs = Date.now() - t0

  if (res.status < 200 || res.status >= 300) {
    const { kind, message } = classifyHttpFailure(res.status, text)
    return { ok: false, kind, message: scrubAiSecret(message, cfg), status: res.status, latencyMs }
  }

  const parsed = parseChatResponse(text)
  if (!parsed.ok) {
    return {
      ok: false,
      kind: parsed.kind,
      message: scrubAiSecret(parsed.message, cfg),
      status: res.status,
      latencyMs
    }
  }
  return { ok: true, text: parsed.text, model: parsed.model || cfg.model, latencyMs }
}

// ── 失败分类 ──────────────────────────────────────────────────────────────

/** 从响应体里把错误说明抠出来（各家格式都是 {error:{message}} 或 {message} 的变体）。 */
function errorMessageOf(bodyText: string): string {
  try {
    const j = JSON.parse(bodyText) as {
      error?: { message?: unknown; code?: unknown; type?: unknown } | string
      message?: unknown
    }
    if (typeof j.error === 'string') return j.error
    if (j.error && typeof j.error === 'object') {
      const m = j.error.message
      const c = j.error.code ?? j.error.type
      if (typeof m === 'string') return typeof c === 'string' ? `${m}（${c}）` : m
    }
    if (typeof j.message === 'string') return j.message
  } catch {
    // 不是 JSON，用原文
  }
  return bodyText.replace(/\s+/g, ' ').slice(0, 300)
}

const VISION_UNSUPPORTED_RE =
  /image|vision|multimodal|multi-modal|图片|图像|视觉|content type|content_type|input type|unsupported.*type|not support/i
const MODEL_MISSING_RE =
  /model.*(not (found|exist)|invalid|unknown|does not exist|unavailable)|no such model|模型不存在|不支持的模型|unknown model|invalid model/i

export function classifyHttpFailure(
  status: number,
  bodyText: string
): { kind: AiFailureKind; message: string } {
  const detail = errorMessageOf(bodyText)
  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      message: `鉴权失败（HTTP ${status}）：${detail}。请检查 API Key 是否正确、是否属于这个接口地址对应的平台。`
    }
  }
  if (status === 404) {
    return {
      kind: MODEL_MISSING_RE.test(detail) ? 'model' : 'bad_request',
      message: `接口返回 404：${detail}。多半是模型名写错，或接口地址不对（应填到 /v1 这一层）。`
    }
  }
  if (status === 429 || status === 402) {
    return {
      kind: 'rate',
      message: `被限流或额度不足（HTTP ${status}）：${detail}。稍后再试，或到平台看余额/并发限制。`
    }
  }
  if (status === 400 || status === 422) {
    if (MODEL_MISSING_RE.test(detail)) {
      return { kind: 'model', message: `模型不可用（HTTP ${status}）：${detail}。请核对模型名。` }
    }
    if (VISION_UNSUPPORTED_RE.test(detail)) {
      return {
        kind: 'vision',
        message: `这个模型不接受图片输入（HTTP ${status}）：${detail}。请换一个视觉模型（名字里通常带 vl / vision / v）。`
      }
    }
    return { kind: 'bad_request', message: `请求被拒绝（HTTP ${status}）：${detail}` }
  }
  if (status >= 500) {
    return {
      kind: 'server',
      message: `服务端错误（HTTP ${status}）：${detail}。通常过一会儿就好。`
    }
  }
  return { kind: 'bad_request', message: `HTTP ${status}：${detail}` }
}

/** 把 chat/completions 的响应解成文本。兼容 content 是字符串或分段数组两种形状。 */
function parseChatResponse(
  bodyText: string
): { ok: true; text: string; model: string } | { ok: false; kind: AiFailureKind; message: string } {
  let j: unknown
  try {
    j = JSON.parse(bodyText)
  } catch {
    return {
      ok: false,
      kind: 'bad_response',
      message: `响应不是 JSON：${bodyText.replace(/\s+/g, ' ').slice(0, 200)}`
    }
  }
  const o = (j ?? {}) as {
    error?: unknown
    model?: unknown
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>
  }
  if (o.error) {
    const msg = errorMessageOf(bodyText)
    return {
      ok: false,
      kind: VISION_UNSUPPORTED_RE.test(msg) ? 'vision' : 'bad_request',
      message: `接口返回错误：${msg}`
    }
  }
  const content = o.choices?.[0]?.message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .map((p) =>
        p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
          ? (p as { text: string }).text
          : ''
      )
      .join('')
  }
  if (!text.trim()) {
    return { ok: false, kind: 'bad_response', message: '模型返回了空内容。' }
  }
  return { ok: true, text, model: typeof o.model === 'string' ? o.model : '' }
}

/** 每类失败给一句「下一步做什么」。 */
export function describeAiFailure(kind: AiFailureKind): string {
  switch (kind) {
    case 'config':
      return '配置不完整。'
    case 'auth':
      return 'API Key 不对或不属于这个平台。'
    case 'model':
      return '模型名不存在。'
    case 'vision':
      return '这个模型不支持图片输入，换一个视觉模型。'
    case 'rate':
      return '限流或额度不足。'
    case 'bad_request':
      return '请求格式被拒绝。'
    case 'network':
      return '网络不通或代理问题。'
    case 'timeout':
      return '超时。'
    case 'server':
      return '服务端故障。'
    case 'bad_response':
      return '响应格式异常。'
  }
}

// ── 视觉能力探测 ──────────────────────────────────────────────────────────

/** 探测图里的字母。选 W 是因为它笔画特征明显、不易与数字混。 */
export const PROBE_LETTER = 'W'

/** 合成一张 480x300 的测试图：白底、居中大红字母 W、右下角蓝色方块。 */
export async function buildProbeImage(): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300">
  <rect width="480" height="300" fill="#ffffff"/>
  <text x="200" y="215" font-family="Arial, Helvetica, sans-serif" font-size="220" font-weight="bold" fill="#d62828" text-anchor="middle">${PROBE_LETTER}</text>
  <rect x="380" y="200" width="70" height="70" fill="#1d4ed8"/>
</svg>`
  const png = await sharp(Buffer.from(svg)).png().toBuffer()
  return new Uint8Array(png)
}

/**
 * 「测试连接与视觉能力」：发合成图问「最大的字母是什么」。
 *   · 回答里有 W        ⇒ ok, vision=true
 *   · 请求成功但没有 W   ⇒ ok=false, vision=false（模型多半没看到图，或根本是纯文本模型被网关静默降级）
 *   · 400 且提到 image  ⇒ kind=vision, vision=false
 *   · 其它失败          ⇒ 对应 kind，vision=null
 * 绝不抛异常。
 */
export async function probeVision(cfg: AiConfig): Promise<AiTestResult> {
  const problems = validateAiConfig(cfg)
  if (problems.length > 0) {
    return {
      ok: false,
      vision: null,
      kind: 'config',
      model: cfg.model,
      latencyMs: 0,
      message: problems.join(' '),
      reply: null
    }
  }
  let image: Uint8Array
  try {
    image = await buildProbeImage()
  } catch (e) {
    return {
      ok: false,
      vision: null,
      kind: 'bad_request',
      model: cfg.model,
      latencyMs: 0,
      message: `生成测试图失败：${scrubAiSecret(describeThrown(e), cfg)}`,
      reply: null
    }
  }
  const r = await chatVision(cfg, {
    system: '你是图像识别助手。只回答问题本身，不要解释。',
    user: '这张图片里最大的那个字母是什么？只回答这个字母，不要任何其它文字。',
    image,
    mime: 'image/png',
    maxTokens: 20
  })
  if (!r.ok) {
    return {
      ok: false,
      vision: r.kind === 'vision' ? false : null,
      kind: r.kind,
      model: cfg.model,
      latencyMs: r.latencyMs,
      message: r.message,
      reply: null
    }
  }
  const reply = r.text.trim().slice(0, 120)
  const seen = reply.toUpperCase().includes(PROBE_LETTER)
  return {
    ok: seen,
    vision: seen,
    kind: seen ? null : 'vision',
    model: r.model,
    latencyMs: r.latencyMs,
    message: seen
      ? `模型「${r.model}」能看图：正确认出了测试图里的字母 ${PROBE_LETTER}，耗时 ${r.latencyMs}ms。可以启用。`
      : `模型「${r.model}」回复了「${reply}」，没有认出测试图里的字母 ${PROBE_LETTER}。` +
        '它多半没有真的看到图片（纯文本模型，或网关静默丢掉了图片），请换一个视觉模型再测。',
    reply
  }
}
