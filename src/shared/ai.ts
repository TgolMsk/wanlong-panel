/**
 * AI 顾问（视觉大模型兜底 + 模板自学习）的公共契约（主进程 ⇄ 渲染进程）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【它解决什么问题】
 *
 * 采集流程与调度器都有一条「认不出当前界面」的分支：模板全不命中时只能盲按 BACK 试探，
 * 六次不行就暂停实例 + 推送。活动弹窗（带「前往」和右上角 ×）是最常见的元凶，而它的 ×
 * 模板（tpl_btn_close_popup）一直缺着 —— 弹窗不可复现，没法提前裁。
 *
 * 本模块把「认不出」这一格交给视觉大模型（OpenAI 兼容接口，任何支持图片输入的模型都行）：
 *   1. 把当前截图缩到 imageWidth 宽发过去，让模型**分类**当前界面并从**动作白名单**里选一个；
 *   2. 只有「点关闭按钮」「点取消」两种动作会被执行，坐标由模型给出边界框，可选做第二阶段
 *      局部放大精定位；「按返回」「不动」一律交回原来的兜底阶梯（安全逻辑只有一份）；
 *   3. 点完必须复验（画面变了 / 已回到已知界面），不通过就当没发生；
 *   4. ★ 自学习：确认是关闭按钮且关掉后回到了已知界面，就把点击前那一帧里的按钮裁成模板
 *      存进模板库（tpl_btn_close_popup 或 _ai<N> 变体）。下次同样的弹窗 1ms 本地解决，不再问。
 *
 * 【凭据纪律】与 Telegram token 完全一致（见 alerts.ts）：
 *   · apiKey 只存 <dataDir>/ai.json；绝不进日志、绝不进 SerializedError、绝不过 IPC 桥
 *   · 渲染进程只拿得到 AiConfigView（类型上就没有 apiKey 这个键）
 *   · 任何往外抛的文本先过 scrubSecret()
 *
 * 【默认值只有一份权威】defaultAiConfig()。主进程 / 渲染进程 / 离线自检一律 import 它。
 * ══════════════════════════════════════════════════════════════════════════
 */

import { maskToken, scrubSecret } from './alerts'

export const AI_FILE = 'ai.json'
export const AI_HISTORY_LIMIT = 50

// ── 配置 ──────────────────────────────────────────────────────────────────

export interface AiConfig {
  version: 1
  /** 总开关。关掉后认不出界面时照旧只走 BACK 兜底，不发任何请求。 */
  enabled: boolean
  /** OpenAI 兼容接口根地址，例如 https://dashscope.aliyuncs.com/compatible-mode/v1（不带 /chat/completions）。 */
  baseUrl: string
  /** ★ 凭据。 */
  apiKey: string
  /** 模型名，必须是支持图片输入的模型，例如 qwen3.8-flash / qwen3-vl-plus。 */
  model: string
  /** 单次请求超时（ms）。视觉模型看一张 1280 宽的图通常 3~15 秒。 */
  timeoutMs: number
  /** 每小时最多问几次（所有实例合计）。0 = 不限制。识别出错时它是防止烧钱的熔断。 */
  maxCallsPerHour: number
  /** 同一实例两次问询的最小间隔（秒）。 */
  cooldownSeconds: number
  /** 发给模型的截图宽度（像素），高度按比例。越大越准也越贵。 */
  imageWidth: number
  /** 第二阶段：把模型给的区域放大再问一次，拿到更精确的边界框（裁模板时更贴合）。 */
  refine: boolean
  /** 认出关闭按钮并成功关掉后，自动把它裁成模板存进模板库。 */
  autoHarvest: boolean
  /** 模型自报置信度低于此值的建议不执行。 */
  minConfidence: number
}

export function defaultAiConfig(): AiConfig {
  return {
    version: 1,
    enabled: false,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    model: 'qwen3.8-flash',
    timeoutMs: 40_000,
    maxCallsPerHour: 20,
    cooldownSeconds: 20,
    imageWidth: 1280,
    refine: true,
    autoHarvest: true,
    minConfidence: 0.5
  }
}

/** 取值范围（渲染进程表单的 min/max 与这里一一对应；这些是**边界**不是默认值）。 */
export const AI_RANGE = {
  timeoutMs: [5_000, 180_000],
  maxCallsPerHour: [0, 500],
  cooldownSeconds: [0, 3_600],
  imageWidth: [640, 2560],
  minConfidence: [0, 1]
} as const

function numIn(v: unknown, dflt: number, range: readonly [number, number]): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt
  return Math.min(range[1], Math.max(range[0], n))
}

function str(v: unknown, dflt: string): string {
  return typeof v === 'string' ? v.trim() : dflt
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt
}

/** 把磁盘 / 补丁上来的任意东西归一成合法配置。缺什么补什么，越界的夹回范围。 */
export function normalizeAiConfig(raw: unknown): AiConfig {
  const d = defaultAiConfig()
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    version: 1,
    enabled: bool(o.enabled, d.enabled),
    baseUrl: str(o.baseUrl, d.baseUrl).replace(/\/+$/, ''),
    apiKey: str(o.apiKey, d.apiKey),
    model: str(o.model, d.model),
    timeoutMs: Math.round(numIn(o.timeoutMs, d.timeoutMs, AI_RANGE.timeoutMs)),
    maxCallsPerHour: Math.round(
      numIn(o.maxCallsPerHour, d.maxCallsPerHour, AI_RANGE.maxCallsPerHour)
    ),
    cooldownSeconds: Math.round(
      numIn(o.cooldownSeconds, d.cooldownSeconds, AI_RANGE.cooldownSeconds)
    ),
    imageWidth: Math.round(numIn(o.imageWidth, d.imageWidth, AI_RANGE.imageWidth)),
    refine: bool(o.refine, d.refine),
    autoHarvest: bool(o.autoHarvest, d.autoHarvest),
    minConfidence: numIn(o.minConfidence, d.minConfidence, AI_RANGE.minConfidence)
  }
}

/** 渲染进程看到的配置：apiKey 打码，类型上就没有 apiKey 这个键。 */
export interface AiConfigView extends Omit<AiConfig, 'apiKey'> {
  apiKeySet: boolean
  /** 只留后 4 位，例如 ••••••ab12。 */
  apiKeyMasked: string
}

/** ★ 主进程往渲染进程送配置的**唯一**出口。 */
export function toAiConfigView(cfg: AiConfig): AiConfigView {
  const { apiKey, ...rest } = cfg
  return { ...rest, apiKeySet: apiKey.trim() !== '', apiKeyMasked: maskToken(apiKey) }
}

/**
 * 保存补丁。apiKey 三态：
 *   不带这个键 → 保持原值（改个模型名不会把 key 抹掉）
 *   非空字符串 → 覆盖
 *   空字符串   → 显式清空（面板「清除 Key」按钮）
 */
export type AiConfigPatch = Partial<Omit<AiConfig, 'version'>>

export function mergeAiConfig(base: AiConfig, patch: AiConfigPatch | undefined): AiConfig {
  if (!patch) return normalizeAiConfig(base)
  const merged: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) merged[k] = v
  }
  return normalizeAiConfig(merged)
}

/** 可以安全写进日志的形状（apiKey 已打码）。 */
export function redactAiConfig(cfg: AiConfig): Record<string, unknown> {
  return { ...cfg, apiKey: maskToken(cfg.apiKey) }
}

/** 把文本里的 apiKey 洗掉。 */
export function scrubAiSecret(text: string, cfg: Pick<AiConfig, 'apiKey'>): string {
  return scrubSecret(text, cfg.apiKey)
}

/** 本地体检：不发请求就能发现的问题（中文）。空数组 = 可以发请求。 */
export function validateAiConfig(cfg: AiConfig): string[] {
  const problems: string[] = []
  if (!/^https?:\/\/\S+$/i.test(cfg.baseUrl)) {
    problems.push(
      '接口地址必须以 http:// 或 https:// 开头，例如 https://dashscope.aliyuncs.com/compatible-mode/v1'
    )
  } else if (/\/chat\/completions\/?$/i.test(cfg.baseUrl)) {
    problems.push('接口地址只填到 /v1 这一层，不要带 /chat/completions（面板会自己拼）。')
  }
  if (!cfg.model) problems.push('模型名不能为空，例如 qwen3.8-flash。')
  if (!cfg.apiKey.trim()) problems.push('还没有填 API Key。')
  return problems
}

/** 设置页的预设（只是填表快捷方式，模型名以各家最新文档为准）。 */
export const AI_PRESETS: ReadonlyArray<{ label: string; baseUrl: string; models: string[] }> = [
  {
    label: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-flash', 'qwen3-vl-plus', 'qwen3-vl-flash', 'qwen-vl-max']
  },
  {
    label: '智谱 BigModel',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5v', 'glm-4v-flash']
  },
  {
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k-vision-preview']
  },
  {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o']
  }
]

// ── 建议（模型的输出）────────────────────────────────────────────────────

/** 模型对当前界面的分类。只用于日志与统计，不参与安全判定。 */
export const AI_SCREEN_KINDS = [
  'world_map',
  'city',
  'troop_panel',
  'popup',
  'dialog',
  'kicked',
  'network',
  'maintenance',
  'loading',
  'other',
  'unknown'
] as const
export type AiScreenKind = (typeof AI_SCREEN_KINDS)[number]

export const AI_SCREEN_LABEL: Record<AiScreenKind, string> = {
  world_map: '世界地图',
  city: '城内',
  troop_panel: '部队管理面板',
  popup: '活动弹窗',
  dialog: '系统对话框',
  kicked: '顶号/登录界面',
  network: '网络断开提示',
  maintenance: '维护/更新公告',
  loading: '加载中',
  other: '其它二级页',
  unknown: '看不出来'
}

/**
 * ★ 动作白名单。模型只能从这里选，**没有**「确定」「派兵」「购买」这类动作，永远不会有。
 *   tap_close / tap_cancel 需要模型给出目标边界框，由本地点击并复验；
 *   back / none 不由 AI 执行 —— 交回原来的兜底阶梯（安全逻辑只写一份）。
 */
export const AI_ACTIONS = ['tap_close', 'tap_cancel', 'back', 'none'] as const
export type AiAction = (typeof AI_ACTIONS)[number]

export const AI_ACTION_LABEL: Record<AiAction, string> = {
  tap_close: '点关闭按钮（×）',
  tap_cancel: '点「取消」',
  back: '按返回键',
  none: '不动'
}

/** 参考分辨率空间的矩形。 */
export interface AiBox {
  x: number
  y: number
  w: number
  h: number
}

export interface AiAdvice {
  screen: AiScreenKind
  action: AiAction
  /** 参考坐标下的目标边界框；tap_* 必有，其余为 null。 */
  target: AiBox | null
  /** 0~1。 */
  confidence: number
  /** 模型给的一句中文理由（截断到 200 字）。 */
  reason: string
  model: string
  latencyMs: number
  /** 是否经过第二阶段放大精定位。 */
  refined: boolean
}

// ── 记录 / 状态 ───────────────────────────────────────────────────────────

export type AiConsultOutcome =
  /** 被开关 / 限频 / 冷却拦下，没发请求 */
  | 'skipped'
  /** 请求失败（网络 / 鉴权 / 模型不支持图片…） */
  | 'failed'
  /** 模型回了但解析不出合法建议 */
  | 'unparsable'
  /** 模型建议 back / none，交回兜底阶梯 */
  | 'no_action'
  /** 建议被本地否决（置信度低 / 框不合理 / 点了没反应） */
  | 'rejected'
  /** 点了，画面变了，但没回到已知界面 */
  | 'applied'
  /** 点了，回到了已知界面 */
  | 'verified'
  /** verified 且成功裁出新模板 */
  | 'harvested'

export const AI_OUTCOME_LABEL: Record<AiConsultOutcome, string> = {
  skipped: '未问询',
  failed: '请求失败',
  unparsable: '回复无法解析',
  no_action: '交回兜底',
  rejected: '建议被否决',
  applied: '已执行',
  verified: '已执行并回到已知界面',
  harvested: '已执行并裁出新模板'
}

export interface AiConsultRecord {
  id: string
  at: number
  instanceIndex: number | null
  /** 哪条链路问的：gather-g0（采集流程）/ scheduler-sample（调度器采样）/ test（设置页测试）。 */
  context: string
  outcome: AiConsultOutcome
  /** 中文一句话，可直接显示。★ 已过 scrubSecret。 */
  message: string
  advice: AiAdvice | null
  harvestedTemplateId: string | null
  /** 整个问询 + 执行的耗时。 */
  latencyMs: number
}

export interface AiStatus {
  enabled: boolean
  /** baseUrl / model / apiKey 都齐了。 */
  configured: boolean
  model: string
  baseUrl: string
  callsLastHour: number
  maxCallsPerHour: number
  /** 历史里真正发出过请求的次数。 */
  consultCount: number
  harvestedCount: number
  lastRecord: AiConsultRecord | null
}

// ── 测试 ──────────────────────────────────────────────────────────────────

export type AiFailureKind =
  | 'config'
  | 'auth'
  | 'model'
  | 'vision'
  | 'rate'
  | 'bad_request'
  | 'network'
  | 'timeout'
  | 'server'
  | 'bad_response'

export interface AiTestResult {
  ok: boolean
  /** true = 模型认出了测试图；false = 不支持图片或答错；null = 没走到这一步。 */
  vision: boolean | null
  kind: AiFailureKind | null
  model: string
  latencyMs: number
  /** 中文结论。★ 已过 scrubSecret。 */
  message: string
  /** 模型的原话（截断），便于判断它到底看没看到图。 */
  reply: string | null
}

// ── IPC ───────────────────────────────────────────────────────────────────

export const AI_CH = {
  /** 读配置（★ 打码视图）。 */
  config: 'ai:config',
  /** 改配置（部分字段）。返回打码视图。 */
  saveConfig: 'ai:saveConfig',
  /** 「测试连接与视觉能力」：发一张合成图让模型认字母。 */
  test: 'ai:test',
  status: 'ai:status',
  history: 'ai:history'
} as const

export type AiRoutes = {
  'ai:config': [[], AiConfigView]
  'ai:saveConfig': [[patch: AiConfigPatch], AiConfigView]
  'ai:test': [[], AiTestResult]
  'ai:status': [[], AiStatus]
  'ai:history': [[limit?: number], AiConsultRecord[]]
}

export type AiChannel = keyof AiRoutes
export type AiArgs<K extends AiChannel> = AiRoutes[K][0]
export type AiResult<K extends AiChannel> = AiRoutes[K][1]

export type AiPushEvents = {
  'ai:configChanged': AiConfigView
  /** 每次问询（含被拦下的）结束后推一条，面板据此刷新「最近问询」与计数。 */
  'ai:consulted': AiConsultRecord
}
export type AiPushChannel = keyof AiPushEvents

// ── 渲染进程客户端（写法与 alerts.ts 一致，类型断言全部关在这里）────────────

interface RawBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, cb: (payload: unknown) => void): () => void
}

function bridge(): RawBridge {
  const api = (globalThis as { api?: unknown }).api
  if (!api || typeof (api as RawBridge).invoke !== 'function') {
    throw new Error('window.api 尚未就绪：AI 顾问接口只能在渲染进程里调用。')
  }
  return api as RawBridge
}

export function callAi<K extends AiChannel>(channel: K, ...args: AiArgs<K>): Promise<AiResult<K>> {
  return bridge().invoke(channel, ...args) as Promise<AiResult<K>>
}

export function onAiEvent<K extends AiPushChannel>(
  channel: K,
  cb: (payload: AiPushEvents[K]) => void
): () => void {
  return bridge().on(channel, (p) => cb(p as AiPushEvents[K]))
}

export function describeAiError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const stripped = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
  if (/No handler registered|no handler/i.test(stripped)) {
    return '主进程还没有注册 AI 顾问通道（ai:*）。模块接线之后本页会自动可用。'
  }
  return stripped || '未知错误'
}
