/**
 * AiAdvisor：配置、限频、问询（两阶段）、记录。**只出主意，不动手**。
 * 真正点屏幕、复验、裁模板在 recover.ts —— 这样问询逻辑可以用假 fetch 离线测，
 * 执行逻辑可以用假 IO 离线测，两边互不牵扯。
 *
 * 【两阶段问询】
 *   ① 整帧缩到 imageWidth 宽（JPEG），让模型分类界面 + 从白名单选动作 + 给目标边界框
 *      （坐标是**发过去那张图**的像素坐标，回来后按比例换算到参考分辨率）。
 *   ② 可选：把 ① 的框外扩一圈从原始裸帧里裁出来（PNG，小图不损），再问一次精确边界框。
 *      裁模板时贴合度决定了模板质量，所以默认开着；模型给的精修框若跑出了 ① 的外扩区就不采信。
 *
 * 【限频】maxCallsPerHour（全局）+ cooldownSeconds（每实例）。识别出错时流程可能反复认不出界面，
 * 没有这两道闸就是在烧钱。计数只算真正发出去的请求。
 *
 * 纯 Node，不 import electron（推送靠注入的 emit）。
 */

import type {
  AiAction,
  AiAdvice,
  AiBox,
  AiConfig,
  AiConfigPatch,
  AiConfigView,
  AiConsultOutcome,
  AiConsultRecord,
  AiPushChannel,
  AiPushEvents,
  AiScreenKind,
  AiStatus,
  AiTestResult
} from '@shared/ai'
import {
  AI_ACTIONS,
  AI_ACTION_LABEL,
  AI_HISTORY_LIMIT,
  AI_SCREEN_KINDS,
  defaultAiConfig,
  mergeAiConfig,
  redactAiConfig,
  scrubAiSecret,
  toAiConfigView,
  validateAiConfig
} from '@shared/ai'
import { makeId } from '@shared/defaults'
import { AppError } from '@shared/errors'
import type { RawFrame } from '@shared/vision'
import { sharp } from '@vision/cv'
import { chatVision, probeVision } from './client'
import { loadAiFile, saveAiFile } from './store'

export type AiLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface AiAdvisorDeps {
  dataDir(): string
  log(level: AiLogLevel, message: string): void
  /** 推送给面板（主进程接 emitAi；离线自检可以不给或给假的）。 */
  emit?<K extends AiPushChannel>(channel: K, payload: AiPushEvents[K]): void
  /** 裁出新模板后回调（主进程用它让采集 / 调度器的模板缓存失效）。 */
  onTemplateHarvested?(setId: string, templateId: string): void
  now?(): number
}

export interface ConsultInput {
  instanceIndex: number | null
  /** gather-g0 / scheduler-sample / … 只用于记录。 */
  context: string
  raw: RawFrame
  refWidth: number
  refHeight: number
  /** 兜底阶梯的第几次尝试，写进提示词让模型知道之前的招已经试过。 */
  attempt: number
}

export interface ConsultResult {
  advice: AiAdvice | null
  /** advice 为 null 时的原因（中文）。 */
  reason: string
  /** 为 null 时是被拦下（skipped）还是失败（failed / unparsable）。 */
  outcome: Extract<AiConsultOutcome, 'skipped' | 'failed' | 'unparsable'> | null
  latencyMs: number
}

/** 模型回复里最多认这么大的框（占画面的比例），再大就不是按钮了。 */
const MAX_TARGET_FRACTION = 0.4
/** 最小框（发过去那张图的像素）。 */
const MIN_TARGET_PX = 6

export class AiAdvisor {
  private deps: AiAdvisorDeps | null = null
  private cfg: AiConfig = defaultAiConfig()
  private records: AiConsultRecord[] = []
  /** 真正发出请求的时刻（限频用），只保留最近一小时。 */
  private callTimestamps: number[] = []
  /** 每实例最近一次问询时刻（冷却用）。 */
  private lastConsultAt = new Map<number, number>()
  private started = false
  private readonly configListeners = new Set<(view: AiConfigView) => void>()

  // ── 生命周期 ───────────────────────────────────────────────────────────

  /** 读盘并就绪。读盘失败不阻断启动（从默认配置开始，顾问处于关闭态）。 */
  async init(deps: AiAdvisorDeps): Promise<void> {
    if (this.started) return
    this.deps = deps
    this.started = true
    try {
      const file = await loadAiFile(deps.dataDir())
      this.cfg = file.config
      this.records = file.history
      for (const w of file.loadWarnings ?? []) this.log('warn', w)
      this.log('info', `AI 顾问已就绪：${JSON.stringify(redactAiConfig(this.cfg))}`)
    } catch (e) {
      this.cfg = defaultAiConfig()
      this.log(
        'error',
        `读取 AI 顾问配置失败，本次从默认配置开始（顾问关闭）：${AppError.from(e).message}`
      )
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return
    await this.persist()
    this.started = false
    this.configListeners.clear()
  }

  /** 离线自检用：直接塞配置，不读盘。 */
  setConfigForTest(cfg: AiConfig, deps: AiAdvisorDeps): void {
    this.deps = deps
    this.started = true
    this.cfg = cfg
    this.records = []
    this.callTimestamps = []
    this.lastConsultAt.clear()
  }

  // ── 配置 ───────────────────────────────────────────────────────────────

  /** 含明文 apiKey 的当前配置。★ 只给主进程内部用，绝不过桥、绝不进日志。 */
  currentConfig(): AiConfig {
    return this.cfg
  }

  getConfigView(): AiConfigView {
    return toAiConfigView(this.cfg)
  }

  /** 顾问是否会真的去问：开关开着且配置齐全。 */
  isActive(): boolean {
    return this.cfg.enabled && validateAiConfig(this.cfg).length === 0
  }

  async saveConfig(patch: AiConfigPatch | undefined): Promise<AiConfigView> {
    this.cfg = mergeAiConfig(this.cfg, patch)
    await this.persist()
    const view = this.getConfigView()
    this.log('info', `AI 顾问配置已更新：${JSON.stringify(redactAiConfig(this.cfg))}`)
    this.deps?.emit?.('ai:configChanged', view)
    for (const cb of this.configListeners) {
      try {
        cb(view)
      } catch (e) {
        this.log('warn', `AI 配置变更回调抛异常，已忽略：${AppError.from(e).message}`)
      }
    }
    return view
  }

  onConfigChanged(cb: (view: AiConfigView) => void): () => void {
    this.configListeners.add(cb)
    return () => this.configListeners.delete(cb)
  }

  // ── 测试 / 状态 / 历史 ─────────────────────────────────────────────────

  async test(): Promise<AiTestResult> {
    const r = await probeVision(this.cfg)
    this.note({
      instanceIndex: null,
      context: 'test',
      outcome: r.ok ? 'verified' : 'failed',
      message: r.message,
      advice: null,
      harvestedTemplateId: null,
      latencyMs: r.latencyMs
    })
    return r
  }

  status(): AiStatus {
    return {
      enabled: this.cfg.enabled,
      configured: validateAiConfig(this.cfg).length === 0,
      model: this.cfg.model,
      baseUrl: this.cfg.baseUrl,
      callsLastHour: this.callsLastHour(),
      maxCallsPerHour: this.cfg.maxCallsPerHour,
      consultCount: this.records.filter((r) => r.outcome !== 'skipped' && r.context !== 'test')
        .length,
      harvestedCount: this.records.filter((r) => r.outcome === 'harvested').length,
      lastRecord: this.records[0] ?? null
    }
  }

  history(limit = AI_HISTORY_LIMIT): AiConsultRecord[] {
    return this.records.slice(0, Math.max(1, Math.min(AI_HISTORY_LIMIT, limit)))
  }

  /** recover.ts 裁出新模板后调用：让主进程把采集 / 调度器的模板缓存打掉，下一轮就用上新模板。 */
  templateHarvested(setId: string, templateId: string): void {
    this.log(
      'info',
      `模板库新增 AI 自学模板「${templateId}」（模板集 ${setId}），已通知模板缓存失效。`
    )
    this.deps?.onTemplateHarvested?.(setId, templateId)
  }

  /**
   * 记一条问询结果（recover.ts 在执行 / 复验 / 裁模板之后调用），落盘并推给面板。
   * ★ message 在这里再过一次 scrubAiSecret，当作最后一道保险。
   */
  note(r: Omit<AiConsultRecord, 'id' | 'at'>): AiConsultRecord {
    const record: AiConsultRecord = {
      id: makeId('ai'),
      at: this.now(),
      ...r,
      message: scrubAiSecret(r.message, this.cfg).slice(0, 500)
    }
    this.records = [record, ...this.records].slice(0, AI_HISTORY_LIMIT)
    void this.persist()
    try {
      this.deps?.emit?.('ai:consulted', record)
    } catch (e) {
      this.log('warn', `推送 AI 问询记录到面板失败：${AppError.from(e).message}`)
    }
    return record
  }

  // ── 问询 ───────────────────────────────────────────────────────────────

  /**
   * 认不出界面时问一次。**绝不抛异常**：拦下 / 失败 / 解析不出都体现在返回值里。
   * 这里只负责拿到建议；点不点、怎么复验、裁不裁模板是 recover.ts 的事。
   */
  async consult(input: ConsultInput): Promise<ConsultResult> {
    const t0 = this.now()
    const cfg = this.cfg

    if (!cfg.enabled)
      return { advice: null, reason: 'AI 顾问未启用。', outcome: null, latencyMs: 0 }
    const problems = validateAiConfig(cfg)
    if (problems.length > 0) {
      return {
        advice: null,
        reason: `AI 顾问配置不完整：${problems.join(' ')}`,
        outcome: 'skipped',
        latencyMs: 0
      }
    }
    const used = this.callsLastHour()
    if (cfg.maxCallsPerHour > 0 && used >= cfg.maxCallsPerHour) {
      return {
        advice: null,
        reason: `最近一小时已问询 ${used} 次，达到上限 ${cfg.maxCallsPerHour} 次，本次不问（防止识别出错时反复烧钱）。`,
        outcome: 'skipped',
        latencyMs: 0
      }
    }
    if (input.instanceIndex !== null) {
      const last = this.lastConsultAt.get(input.instanceIndex)
      if (last !== undefined && this.now() - last < cfg.cooldownSeconds * 1000) {
        const left = Math.ceil((cfg.cooldownSeconds * 1000 - (this.now() - last)) / 1000)
        return {
          advice: null,
          reason: `实例 ${input.instanceIndex} 距上次问询不足 ${cfg.cooldownSeconds} 秒（还剩 ${left} 秒），本次不问。`,
          outcome: 'skipped',
          latencyMs: 0
        }
      }
      this.lastConsultAt.set(input.instanceIndex, this.now())
    }
    this.callTimestamps.push(this.now())

    // ① 整帧
    let encoded: { jpeg: Uint8Array; w: number; h: number }
    try {
      encoded = await encodeFrameJpeg(input.raw, cfg.imageWidth)
    } catch (e) {
      const msg = `截图编码失败：${scrubAiSecret(AppError.from(e).message, cfg)}`
      return { advice: null, reason: msg, outcome: 'failed', latencyMs: this.now() - t0 }
    }
    const r1 = await chatVision(cfg, {
      system: SYSTEM_PROMPT,
      user: stage1Prompt(encoded.w, encoded.h, input.attempt),
      image: encoded.jpeg,
      mime: 'image/jpeg',
      maxTokens: 300
    })
    if (!r1.ok) {
      this.log('warn', `AI 问询失败（${r1.kind}）：${r1.message}`)
      return { advice: null, reason: r1.message, outcome: 'failed', latencyMs: this.now() - t0 }
    }
    const parsed = parseAdvice(r1.text, encoded.w, encoded.h)
    if (!parsed.ok) {
      this.log('warn', `AI 回复无法解析：${parsed.reason}（原文：${r1.text.slice(0, 160)}）`)
      return {
        advice: null,
        reason: parsed.reason,
        outcome: 'unparsable',
        latencyMs: this.now() - t0
      }
    }

    // 图像像素 -> 参考坐标
    const kx = input.refWidth / encoded.w
    const ky = input.refHeight / encoded.h
    let target: AiBox | null = parsed.target
      ? {
          x: Math.round(parsed.target.x * kx),
          y: Math.round(parsed.target.y * ky),
          w: Math.max(1, Math.round(parsed.target.w * kx)),
          h: Math.max(1, Math.round(parsed.target.h * ky))
        }
      : null
    let refined = false

    // ② 局部放大精定位（只对要点的动作做）
    if (target && cfg.refine && (parsed.action === 'tap_close' || parsed.action === 'tap_cancel')) {
      const better = await this.refine(input, target)
      if (better) {
        target = better
        refined = true
      }
    }

    const advice: AiAdvice = {
      screen: parsed.screen,
      action: parsed.action,
      target,
      confidence: parsed.confidence,
      reason: parsed.reason.slice(0, 200),
      model: r1.model,
      latencyMs: this.now() - t0,
      refined
    }
    this.log(
      'info',
      `AI 建议：界面=${advice.screen} 动作=${AI_ACTION_LABEL[advice.action]}` +
        (target
          ? ` 目标=(${target.x},${target.y} ${target.w}x${target.h})${refined ? '·已精修' : ''}`
          : '') +
        ` 置信=${advice.confidence.toFixed(2)} 理由=${advice.reason}`
    )
    return { advice, reason: '', outcome: null, latencyMs: advice.latencyMs }
  }

  /** 第二阶段：从裸帧裁出目标周围一块（PNG，必要时放大），再问精确框。失败一律返回 null（沿用 ① 的框）。 */
  private async refine(input: ConsultInput, target: AiBox): Promise<AiBox | null> {
    const cfg = this.cfg
    const raw = input.raw
    // 参考坐标 -> 设备像素
    const dx = raw.width / input.refWidth
    const dy = raw.height / input.refHeight
    const box = {
      x: target.x * dx,
      y: target.y * dy,
      w: Math.max(1, target.w * dx),
      h: Math.max(1, target.h * dy)
    }
    const pad = Math.max(box.w, box.h, 60)
    const left = clampInt(box.x - pad, 0, raw.width - 1)
    const top = clampInt(box.y - pad, 0, raw.height - 1)
    const right = clampInt(box.x + box.w + pad, left + 1, raw.width)
    const bottom = clampInt(box.y + box.h + pad, top + 1, raw.height)
    const cropW = right - left
    const cropH = bottom - top
    // 小于 480 宽就放大 2 倍，模型对小图上的小控件定位很差。
    const up = cropW < 480 ? 2 : 1

    let png: Uint8Array
    try {
      png = await encodeCropPng(raw, left, top, cropW, cropH, up)
    } catch (e) {
      this.log('warn', `局部放大图编码失败，沿用整帧框：${AppError.from(e).message}`)
      return null
    }
    const r = await chatVision(cfg, {
      system: SYSTEM_PROMPT,
      user: refinePrompt(cropW * up, cropH * up),
      image: png,
      mime: 'image/png',
      maxTokens: 120
    })
    if (!r.ok) {
      this.log('warn', `精定位请求失败，沿用整帧框：${r.message}`)
      return null
    }
    const j = extractJson(r.text)
    const t = j && typeof j === 'object' ? (j as { target?: unknown }).target : null
    const b = readBox(t, cropW * up, cropH * up)
    if (!b) {
      this.log('warn', `精定位回复无法解析，沿用整帧框（原文：${r.text.slice(0, 120)}）`)
      return null
    }
    // 局部图像素 -> 设备像素 -> 参考坐标
    const dev = { x: left + b.x / up, y: top + b.y / up, w: b.w / up, h: b.h / up }
    const ref: AiBox = {
      x: Math.round(dev.x / dx),
      y: Math.round(dev.y / dy),
      w: Math.max(1, Math.round(dev.w / dx)),
      h: Math.max(1, Math.round(dev.h / dy))
    }
    // 精修框必须落在外扩区里，且尺寸别离谱（比 ① 的框大 3 倍以上就是认错东西了）。
    const cx = ref.x + ref.w / 2
    const cy = ref.y + ref.h / 2
    const withinX = cx >= left / dx && cx <= right / dx
    const withinY = cy >= top / dy && cy <= bottom / dy
    if (!withinX || !withinY || ref.w > target.w * 3 + 40 || ref.h > target.h * 3 + 40) {
      this.log('warn', '精定位给的框跑出了合理范围，沿用整帧框。')
      return null
    }
    return ref
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  private callsLastHour(): number {
    const cutoff = this.now() - 3_600_000
    this.callTimestamps = this.callTimestamps.filter((t) => t >= cutoff)
    return this.callTimestamps.length
  }

  private now(): number {
    return this.deps?.now ? this.deps.now() : Date.now()
  }

  private log(level: AiLogLevel, message: string): void {
    const safe = scrubAiSecret(message, this.cfg)
    if (this.deps) this.deps.log(level, safe)
    else if (level === 'error' || level === 'warn') console.warn(`[ai] ${safe}`)
  }

  private async persist(): Promise<void> {
    if (!this.deps) return
    try {
      await saveAiFile(this.deps.dataDir(), { version: 1, config: this.cfg, history: this.records })
    } catch (e) {
      this.log('warn', `AI 顾问配置/历史落盘失败：${AppError.from(e).message}`)
    }
  }
}

// ── 提示词 ────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT =
  '你是一个手游自动化助手，负责看《万龙觉醒》（横屏策略手游）的截图，判断当前界面并从给定的动作白名单里选一个安全动作。' +
  '你只能输出一个 JSON 对象，不要输出 markdown、解释或任何多余文字。'

function stage1Prompt(w: number, h: number, attempt: number): string {
  return (
    `这是当前游戏画面的截图，尺寸 ${w}x${h} 像素（左上角为原点）。自动化程序用模板匹配没认出这个界面（第 ${attempt} 次尝试）。\n` +
    '请判断当前界面属于哪一类，并从动作白名单里选一个最安全、最能让画面回到「世界地图」或「城内主界面」的动作。\n\n' +
    `界面类别（screen）只能取：${AI_SCREEN_KINDS.join(' / ')}。\n` +
    '动作（action）只能取：\n' +
    '  tap_close  —— 画面上有活动弹窗、公告、广告、奖励领取等覆盖层，且能看到关闭按钮（右上角 ×、「关闭」按钮等）。target 必须给出该关闭按钮的边界框。\n' +
    '  tap_cancel —— 画面上是一个询问对话框（例如「确定要退出游戏吗」「是否购买」），应当点「取消」/「否」。target 必须给出「取消」按钮的边界框。\n' +
    '  back       —— 看起来在某个二级页面（背包、商店、聊天、设置等），没有明显的关闭按钮，按返回键更合适。\n' +
    '  none       —— 不该动：正在加载、账号被顶下线/登录界面、维护公告、网络断开、或者你不确定。\n\n' +
    '铁律：\n' +
    '  1. 绝不选择「确定」「退出」「购买」「派遣」「出征」「领取并前往」这类会改变游戏状态的按钮，即使它看起来能关闭弹窗。\n' +
    '  2. 只有你看到了清晰的关闭/取消按钮才给 target；target 是紧贴按钮的边界框，坐标用这张图的像素。\n' +
    '  3. 不确定就选 none。\n\n' +
    '输出格式（严格 JSON）：\n' +
    '{"screen":"popup","action":"tap_close","target":{"x":1180,"y":42,"w":48,"h":48},"confidence":0.9,"reason":"活动弹窗，右上角有×"}\n' +
    '没有目标时 target 为 null。confidence 是 0 到 1 的小数。reason 用一句简短中文。'
  )
}

function refinePrompt(w: number, h: number): string {
  return (
    `这是刚才那张截图中目标按钮附近的局部放大图，尺寸 ${w}x${h} 像素（左上角为原点）。\n` +
    '请给出这张图里那个关闭/取消按钮的精确边界框（紧贴按钮图形本身，不要把周围背景框进来）。\n' +
    '只输出 JSON：{"target":{"x":..,"y":..,"w":..,"h":..},"confidence":0.9}。看不到按钮就输出 {"target":null,"confidence":0}。'
  )
}

// ── 回复解析 ──────────────────────────────────────────────────────────────

/** 从模型回复里抠出第一个 JSON 对象（剥掉 ```json 围栏和前后废话）。 */
export function extractJson(text: string): unknown | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

function readBox(v: unknown, imgW: number, imgH: number): AiBox | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const n = (k: string): number | null =>
    typeof o[k] === 'number' && Number.isFinite(o[k] as number) ? (o[k] as number) : null
  let x = n('x')
  let y = n('y')
  let w = n('w') ?? n('width')
  let h = n('h') ?? n('height')
  // 也接受 [x1,y1,x2,y2] / {x1,y1,x2,y2} 的写法（Qwen 系列常这么给）。
  if ((x === null || w === null) && Array.isArray(o.bbox) && o.bbox.length === 4) {
    const [x1, y1, x2, y2] = o.bbox as number[]
    x = x1
    y = y1
    w = x2 - x1
    h = y2 - y1
  }
  if (x === null && n('x1') !== null) {
    x = n('x1')
    y = n('y1')
    w = (n('x2') ?? 0) - (x ?? 0)
    h = (n('y2') ?? 0) - (y ?? 0)
  }
  if (x === null || y === null || w === null || h === null) return null
  if (w < MIN_TARGET_PX || h < MIN_TARGET_PX) return null
  if (w > imgW * MAX_TARGET_FRACTION || h > imgH * MAX_TARGET_FRACTION) return null
  if (x < 0 || y < 0 || x + w > imgW + 2 || y + h > imgH + 2) return null
  return { x, y, w, h }
}

export interface ParsedAdvice {
  screen: AiScreenKind
  action: AiAction
  /** 发过去那张图的像素坐标。 */
  target: AiBox | null
  confidence: number
  reason: string
}

/** 解析第一阶段回复。合法性：动作在白名单、tap_* 必须带合理的框。 */
export function parseAdvice(
  text: string,
  imgW: number,
  imgH: number
): ({ ok: true } & ParsedAdvice) | { ok: false; reason: string } {
  const j = extractJson(text)
  if (!j || typeof j !== 'object') return { ok: false, reason: '回复里没有 JSON 对象' }
  const o = j as Record<string, unknown>
  const actionRaw = typeof o.action === 'string' ? o.action.trim().toLowerCase() : ''
  if (!(AI_ACTIONS as readonly string[]).includes(actionRaw)) {
    return { ok: false, reason: `动作「${actionRaw || '空'}」不在白名单里` }
  }
  const action = actionRaw as AiAction
  const screenRaw = typeof o.screen === 'string' ? o.screen.trim().toLowerCase() : 'unknown'
  const screen = (
    (AI_SCREEN_KINDS as readonly string[]).includes(screenRaw) ? screenRaw : 'unknown'
  ) as AiScreenKind
  const confRaw = typeof o.confidence === 'number' ? o.confidence : Number(o.confidence)
  const confidence = Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw)) : 0
  const reason = typeof o.reason === 'string' ? o.reason : ''
  const target = readBox(o.target, imgW, imgH)
  if ((action === 'tap_close' || action === 'tap_cancel') && !target) {
    return { ok: false, reason: `动作是 ${action} 但没有给出合理的目标框` }
  }
  return {
    ok: true,
    screen,
    action,
    target: action === 'tap_close' || action === 'tap_cancel' ? target : null,
    confidence,
    reason
  }
}

// ── 图像编码 ──────────────────────────────────────────────────────────────

/** 裸 RGBA 帧 -> 缩到 width 宽的 JPEG。 */
export async function encodeFrameJpeg(
  raw: RawFrame,
  width: number
): Promise<{ jpeg: Uint8Array; w: number; h: number }> {
  const target = Math.min(width, raw.width)
  const { data, info } = await sharp(
    Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
    {
      raw: { width: raw.width, height: raw.height, channels: 4 }
    }
  )
    .resize({ width: target, fit: 'inside' })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true })
  return { jpeg: new Uint8Array(data), w: info.width, h: info.height }
}

/** 裸 RGBA 帧里裁一块并按整数倍放大 -> PNG。 */
export async function encodeCropPng(
  raw: RawFrame,
  left: number,
  top: number,
  width: number,
  height: number,
  up: number
): Promise<Uint8Array> {
  let pipe = sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), {
    raw: { width: raw.width, height: raw.height, channels: 4 }
  }).extract({ left, top, width, height })
  if (up > 1) pipe = pipe.resize({ width: width * up, height: height * up, kernel: 'nearest' })
  const png = await pipe.png({ compressionLevel: 6 }).toBuffer()
  return new Uint8Array(png)
}

function clampInt(v: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, v)))
}
