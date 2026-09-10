/**
 * Telegram 机器人的公共契约：动作枚举、菜单按钮、回调数据、动作执行器接口、面板测试通道。
 *
 * ★ 本文件是**新增**的，不改动 src/shared 里任何既有文件。
 * ★ 四端共用：不得 import electron / node:fs / sharp / opencv。
 * ★ 凭据纪律沿用 alerts.ts：本文件的任何类型里都**没有** botToken；BotActionResult 只装要回给
 *   用户的文本/图片/按钮，绝不装配置。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【分层 —— 读代码前先看这段】
 *
 *   telegramBot.ts（通道，a 组）  收消息 → 鉴权 → 解析命令/按钮文本/回调 → 调 BotActionPort.perform
 *                                 → 把 BotActionResult 发回去（sendMessage / sendPhoto）
 *   bot/actions.ts（动作，b 组）  实现 BotActionPort：Electron 无关、deps 注入、离线脚本可直接跑。
 *                                 凡要碰模拟器的动作（shot / resources）必须走 scheduler.exclusive()
 *   index.ts（接线，b 组）        把 actions 的 deps 接到调度器 / 告警中心 / 账号库 / adb 上，
 *                                 并注册 bot:* 通道给面板「在面板内测试机器人动作」用
 *
 * 通道层与动作层之间**只有** BotActionPort 这一个接口。改任何一边都不需要动另一边。
 * ══════════════════════════════════════════════════════════════════════════
 */

import { formatCst, formatCstClock } from './alerts'

// ══════════════════════════════════════════════════════════════════════════
// 一、动作
// ══════════════════════════════════════════════════════════════════════════

/**
 * 机器人能做的事。★ 扩展方式：加一个值 → 补 BOT_ACTION_SPECS 一条（TS 会强制）→ actions.ts 实现它。
 * 通道层不用改。
 */
export const BOT_ACTIONS = [
  /** 查看队列 / 在途 / 自动调度 / 暂停原因（instanceIndex 为 null = 全部实例） */
  'status',
  /** 恢复该实例的自动调度（= alerts:resume） */
  'resume',
  /** 点掉顶号/断线弹窗、重启游戏，然后恢复 */
  'relaunch',
  /** 手动关掉该实例的自动调度 */
  'pause',
  /** 账号列表：名称 / 绑定实例 / 启用状态 / 实例是否运行 / 自动调度 / 暂停原因 / 上次读面板 */
  'accounts',
  /** 截一帧发图（★ 抢实例锁） */
  'shot',
  /** 读游戏「道具 → 资源统计」表并回文本（★ 抢实例锁，读完必须还原到主界面） */
  'resources',
  /** 今日（北京）采集统计 */
  'stats',
  /** 重发一次回复键盘（菜单） */
  'menu'
] as const

export type BotAction = (typeof BOT_ACTIONS)[number]

/** 通道层自己处理、不进 BotActionPort 的命令（帮助 / 开始）。 */
export type BotLocalCommand = 'help' | 'start'
export type BotCommand = BotAction | BotLocalCommand

export function isBotAction(v: unknown): v is BotAction {
  return typeof v === 'string' && (BOT_ACTIONS as readonly string[]).includes(v)
}

/** 动作对「实例号」的要求。 */
export type BotInstanceNeed =
  /** 必须给实例号；没给时通道层先发一组内联按钮让用户选（见 buildInstancePicker） */
  | 'required'
  /** 可给可不给；没给 = 全部 */
  | 'optional'
  /** 用不着 */
  | 'none'

export interface BotActionSpec {
  readonly action: BotAction
  /** 斜杠命令名（不带 `/`），setMyCommands 与文本解析都用它。 */
  readonly command: string
  /** setMyCommands 里的中文描述（Telegram 限 3~256 字）。 */
  readonly description: string
  /** 回调数据前缀（`<prefix>:<idx>`，总长 ≤ 64 字节）。 */
  readonly callbackPrefix: string
  readonly instance: BotInstanceNeed
  /** 是否要驱动模拟器（截图 / 点界面）。为 true 的动作**必须**走 scheduler.exclusive()。 */
  readonly touchesDevice: boolean
  /** 是否允许离线（模拟器没跑）时执行。 */
  readonly worksOffline: boolean
}

export const BOT_ACTION_SPECS = {
  status: {
    action: 'status',
    command: 'status',
    description: '查看实例队列与调度状态',
    callbackPrefix: 'status',
    instance: 'optional',
    touchesDevice: false,
    worksOffline: true
  },
  resume: {
    action: 'resume',
    command: 'resume',
    description: '恢复实例的自动调度',
    callbackPrefix: 'resume',
    instance: 'required',
    touchesDevice: false,
    worksOffline: true
  },
  relaunch: {
    action: 'relaunch',
    command: 'relaunch',
    description: '重启游戏并恢复自动调度',
    callbackPrefix: 'relaunch',
    instance: 'required',
    touchesDevice: true,
    worksOffline: false
  },
  pause: {
    action: 'pause',
    command: 'pause',
    description: '手动关掉实例的自动调度',
    callbackPrefix: 'pause',
    instance: 'required',
    touchesDevice: false,
    worksOffline: true
  },
  accounts: {
    action: 'accounts',
    command: 'accounts',
    description: '查看账号列表与各实例状态',
    callbackPrefix: 'accounts',
    instance: 'none',
    touchesDevice: false,
    worksOffline: true
  },
  shot: {
    action: 'shot',
    command: 'shot',
    description: '截一张指定账号的画面发过来',
    callbackPrefix: 'shot',
    instance: 'required',
    touchesDevice: true,
    worksOffline: false
  },
  resources: {
    action: 'resources',
    command: 'resources',
    description: '读游戏里的资源统计表',
    callbackPrefix: 'res',
    instance: 'required',
    touchesDevice: true,
    worksOffline: false
  },
  stats: {
    action: 'stats',
    command: 'stats',
    description: '今日采集统计（北京时间）',
    callbackPrefix: 'stats',
    instance: 'none',
    touchesDevice: false,
    worksOffline: true
  },
  menu: {
    action: 'menu',
    command: 'menu',
    description: '显示菜单按钮',
    callbackPrefix: 'menu',
    instance: 'none',
    touchesDevice: false,
    worksOffline: true
  }
} as const satisfies Record<BotAction, BotActionSpec>

export function botActionSpec(action: BotAction): BotActionSpec {
  return BOT_ACTION_SPECS[action]
}

/** setMyCommands 的完整列表（动作 + help）。顺序 = 手机上「/」菜单里的顺序。 */
export const BOT_COMMAND_LIST: ReadonlyArray<{ command: string; description: string }> = [
  ...BOT_ACTIONS.map((a) => ({ command: BOT_ACTION_SPECS[a].command, description: BOT_ACTION_SPECS[a].description })),
  { command: 'help', description: '查看可用命令' }
]

/** 斜杠命令名 → 动作。不认识返回 null。 */
export function actionOfCommand(cmd: string): BotAction | null {
  const c = cmd.trim().toLowerCase()
  for (const a of BOT_ACTIONS) if (BOT_ACTION_SPECS[a].command === c) return a
  return null
}

// ══════════════════════════════════════════════════════════════════════════
// 二、菜单（持久回复键盘 ReplyKeyboardMarkup）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 回复键盘上的按钮字面量。用户按下按钮，Telegram 发来的就是**这个文本**，
 * 通道层用 commandOfButtonText() 反查成命令 —— 所以字面量一个字都不能改，改了旧键盘就失效。
 */
export const BOT_MENU_BUTTON = {
  status: '📊 状态',
  accounts: '👥 账号列表',
  shot: '📷 截图',
  resources: '💰 资源',
  stats: '📈 今日统计',
  help: '❓ 帮助'
} as const

export type BotMenuKey = keyof typeof BOT_MENU_BUTTON

/** 键盘布局：两行三列。 */
export const BOT_MENU_LAYOUT: ReadonlyArray<ReadonlyArray<BotMenuKey>> = [
  ['status', 'accounts', 'shot'],
  ['resources', 'stats', 'help']
]

/** 按钮键 → 命令。help 是通道层本地命令，其余是动作。 */
export const BOT_MENU_COMMAND: Record<BotMenuKey, BotCommand> = {
  status: 'status',
  accounts: 'accounts',
  shot: 'shot',
  resources: 'resources',
  stats: 'stats',
  help: 'help'
}

/**
 * Telegram ReplyKeyboardMarkup（只声明用到的字段）。
 * 通道层发 /start /menu 时把它作为 sendMessage 的 reply_markup。
 */
export interface BotReplyKeyboard {
  keyboard: Array<Array<{ text: string }>>
  resize_keyboard: true
  is_persistent: true
  /** 提示语（输入框占位）。 */
  input_field_placeholder?: string
}

export function buildMenuKeyboard(): BotReplyKeyboard {
  return {
    keyboard: BOT_MENU_LAYOUT.map((row) => row.map((k) => ({ text: BOT_MENU_BUTTON[k] }))),
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: '点下面的按钮，或发 /help'
  }
}

/** 收到的消息文本是不是某个菜单按钮；是就返回对应命令，否则 null。前后空白与大小写不敏感。 */
export function commandOfButtonText(text: string): BotCommand | null {
  const t = text.trim()
  for (const k of Object.keys(BOT_MENU_BUTTON) as BotMenuKey[]) {
    if (BOT_MENU_BUTTON[k] === t) return BOT_MENU_COMMAND[k]
  }
  return null
}

/** /help 与 /start 的正文（通道层直接发，不进动作层）。 */
export const BOT_HELP_TEXT = [
  '万龙控制面板 · 可用命令：',
  '/status [实例号] —— 查看队列、在途队伍、自动调度与暂停原因',
  '/accounts —— 账号列表：绑定实例 / 启用 / 运行 / 自动调度 / 暂停原因 / 上次读面板',
  '/shot [实例号] —— 截一张画面发过来，方便人工看看是否正常',
  '/resources [实例号] —— 读游戏「道具 → 资源统计」表（精度 0.1亿，只作对账）',
  '/stats —— 今日（北京时间）采集统计',
  '/resume <实例号> —— 恢复该实例的自动调度',
  '/relaunch <实例号> —— 点掉顶号/断线弹窗、重启游戏，然后恢复',
  '/pause <实例号> —— 手动关掉该实例的自动调度',
  '/menu —— 重新显示底部菜单按钮',
  '/help —— 看这份说明',
  '底部菜单按钮、告警消息下面的按钮和这些命令是一回事。'
].join('\n')

// ══════════════════════════════════════════════════════════════════════════
// 三、内联按钮与回调数据
// ══════════════════════════════════════════════════════════════════════════

/** Telegram 内联键盘（只用 callback_data 按钮）。与 src/main/alerts/telegram.ts 的 InlineKeyboard 同形。 */
export interface BotInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

/** Telegram 限制 callback_data ≤ 64 字节。 */
export const BOT_CALLBACK_MAX_BYTES = 64

/** 拼回调数据：`shot:0` / `res:2` / `status:all`。 */
export function buildCallbackData(action: BotAction, instanceIndex: number | null): string {
  const p = BOT_ACTION_SPECS[action].callbackPrefix
  return instanceIndex === null ? `${p}:all` : `${p}:${instanceIndex}`
}

/**
 * 解析回调数据。不认识的前缀 / 非法实例号 → null。
 *   'resume:0'  → { action:'resume', instanceIndex:0 }
 *   'res:3'     → { action:'resources', instanceIndex:3 }
 *   'status:all'→ { action:'status', instanceIndex:null }
 *   'status'    → { action:'status', instanceIndex:null }（旧版按钮没带 idx 也兼容）
 */
export function parseCallbackData(data: string): { action: BotAction; instanceIndex: number | null } | null {
  const [prefix, idxRaw] = String(data ?? '').split(':')
  const action = BOT_ACTIONS.find((a) => BOT_ACTION_SPECS[a].callbackPrefix === prefix)
  if (!action) return null
  if (idxRaw === undefined || idxRaw === '' || idxRaw === 'all') return { action, instanceIndex: null }
  if (!/^\d{1,4}$/.test(idxRaw)) return null
  return { action, instanceIndex: Number(idxRaw) }
}

/** 可选实例（listInstances 的一项）。 */
export interface BotInstanceRef {
  index: number
  /** 绑定账号的展示名；没绑为 null。 */
  name: string | null
}

/**
 * 「先选账号再执行」的内联按钮：每个实例一行，文本 `实例 0 · 主号`。
 * 通道层在 shot / resources（instance==='required'）没带实例号时发它，用户点了再走 perform。
 */
export function buildInstancePicker(action: BotAction, instances: BotInstanceRef[]): BotInlineKeyboard {
  return {
    inline_keyboard: instances.map((i) => [
      {
        text: i.name ? `实例 ${i.index} · ${i.name}` : `实例 ${i.index}`,
        callback_data: buildCallbackData(action, i.index)
      }
    ])
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 四、动作执行器接口（通道层 ⇄ 动作层唯一的边界）
// ══════════════════════════════════════════════════════════════════════════

/** 一张要以图片形式发出去的截图。 */
export interface BotPhoto {
  /** JPEG 字节。★ 已降采样到宽 ≤ BOT_PHOTO_MAX_WIDTH、质量 ≈ BOT_PHOTO_JPEG_QUALITY，≤ TELEGRAM_PHOTO_MAX_BYTES。 */
  jpeg: ArrayBuffer
  /** 图片说明（中文；Telegram 限 TELEGRAM_CAPTION_MAX 字）。 */
  caption: string
  /** 建议的文件名（multipart 的 filename），如 `inst0-20260909-212233.jpg`。 */
  filename: string
}

/** 一次动作的结果。通道层按有什么就发什么：有 photo 先 sendPhoto（caption），再发 text（若非空）。 */
export interface BotActionResult {
  /** 纯文本正文（★ 不用 Markdown）。可以为空串（只发图时）。 */
  text: string
  photo?: BotPhoto
  /** 挂在 text 那条消息下面的内联按钮。 */
  keyboard?: BotInlineKeyboard
  /** 为 true 时通道层把菜单回复键盘随这条消息一起发出去（menu 动作用）。 */
  showMenu?: boolean
}

/**
 * 动作执行器。通道层只认这个接口。
 *
 * ★ perform() **允许抛异常**（中文 message），通道层会兜住并回「操作失败：<message>」；
 *   但 message 里绝不许出现 token（动作层根本拿不到 token，天然满足）。
 * ★ instanceIndex 语义按 BOT_ACTION_SPECS[action].instance：
 *     required 动作收到 null 时动作层应抛「请先选择实例」（通道层正常情况下已经用 picker 拦住了）。
 */
export interface BotActionPort {
  perform(action: BotAction, instanceIndex: number | null): Promise<BotActionResult>
  /** 可操作的实例（有账号绑定的在前；一个都没有时返回 [{ index: 0, name: null }]）。 */
  listInstances(): Promise<BotInstanceRef[]>
}

// ── 图片尺寸约束 ───────────────────────────────────────────────────────────

/** 发图前先降采样到这个宽度以内（2560 → 1280，约 150KB）。 */
export const BOT_PHOTO_MAX_WIDTH = 1280
export const BOT_PHOTO_JPEG_QUALITY = 70
/** Telegram sendPhoto 的硬上限。超过就退化成只发文字并说明。 */
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024
/** Telegram caption 上限（字符）。 */
export const TELEGRAM_CAPTION_MAX = 1024
/** Telegram 单条文本上限（字符）。通道层按 4000 截断留余量。 */
export const TELEGRAM_TEXT_MAX = 4096

// ══════════════════════════════════════════════════════════════════════════
// 五、账号列表 / 截图说明 的渲染（动作层与离线自检共用）
// ══════════════════════════════════════════════════════════════════════════

/** 账号列表里的一行（动作层从账号库 + 实例注册表 + 调度器 + 告警中心拼出来）。 */
export interface BotAccountRow {
  accountName: string
  enabled: boolean
  /** 绑定的实例；没绑为 null。 */
  instanceIndex: number | null
  /** 实例名（MuMu 里的名字）；没绑/找不到为 null。 */
  instanceName: string | null
  /** MuMu 实例状态（running / stopped / …）；没绑/找不到为 null。 */
  instanceState: string | null
  /** 自动调度开关；没绑为 null。 */
  auto: boolean | null
  /** 被异常暂停时的中文原因；没暂停为 null。 */
  pausedReason: string | null
  /** 上次读部队管理面板的时刻；从没读过为 null。 */
  lastSampledAt: number | null
  /** 上次采样是否成功；没读过为 null。 */
  lastSampleOk: boolean | null
  queueUsed: number | null
  queueTotal: number | null
}

/**
 * 渲染账号列表（纯文本）。
 *
 *   【账号列表】共 2 个（北京时间 21:22:33）
 *   1. 主号 · 实例 0「MuMu-0」运行中
 *      启用 ✅｜自动调度 开｜队列 5/5｜上次读面板 21:20:11
 *   2. 小号 · 未绑定实例
 *      启用 ❌
 */
export function renderAccountList(rows: BotAccountRow[], now: number = Date.now()): string {
  if (rows.length === 0) {
    return `【账号列表】还没有任何账号。到面板「账号」页新建并绑定实例后再来看。（北京时间 ${formatCstClock(now)}）`
  }
  const lines: string[] = [`【账号列表】共 ${rows.length} 个（北京时间 ${formatCstClock(now)}）`]
  rows.forEach((r, i) => {
    const head =
      r.instanceIndex === null
        ? `${i + 1}. ${r.accountName} · 未绑定实例`
        : `${i + 1}. ${r.accountName} · 实例 ${r.instanceIndex}${r.instanceName ? `「${r.instanceName}」` : ''}${describeInstanceState(r.instanceState)}`
    lines.push(head)
    const parts: string[] = [`启用 ${r.enabled ? '✅' : '❌'}`]
    if (r.instanceIndex !== null) {
      parts.push(`自动调度 ${r.auto === null ? '未知' : r.auto ? '开' : '关'}`)
      if (r.queueUsed != null || r.queueTotal != null) parts.push(`队列 ${r.queueUsed ?? '?'}/${r.queueTotal ?? '?'}`)
      parts.push(
        r.lastSampledAt
          ? `上次读面板 ${formatCstClock(r.lastSampledAt)}${r.lastSampleOk === false ? '（失败）' : ''}`
          : '还没读过面板'
      )
    }
    lines.push(`   ${parts.join('｜')}`)
    if (r.pausedReason) lines.push(`   ⛔ 已暂停：${r.pausedReason}`)
  })
  return lines.join('\n')
}

function describeInstanceState(state: string | null): string {
  if (state === null) return ''
  if (state === 'running') return '（运行中）'
  if (state === 'stopped') return '（未运行）'
  if (state === 'starting') return '（启动中）'
  return `（${state}）`
}

/** 截图说明里要带的现场信息。 */
export interface BotShotContext {
  instanceIndex: number
  accountName: string | null
  /** 截图时刻。 */
  at: number
  /** 前台包名；读不到为 null。 */
  foreground: string | null
  /** 游戏进程是否存活；没查为 null。 */
  gameRunning: boolean | null
  /** 游戏包名（用来把前台包名翻译成「游戏」）。 */
  gamePackage: string
}

/**
 * 截图的中文说明（sendPhoto 的 caption，≤ TELEGRAM_CAPTION_MAX）。
 *   实例 0「主号」截图
 *   北京时间 2026-09-09 21:22:33
 *   前台：游戏（com.lilithgames.samo.android.cn）｜游戏进程：存活
 */
export function renderShotCaption(ctx: BotShotContext): string {
  const who = ctx.accountName ? `「${ctx.accountName}」` : ''
  const fg =
    ctx.foreground === null
      ? '未知'
      : ctx.foreground === ctx.gamePackage
        ? `游戏（${ctx.foreground}）`
        : `★ 不是游戏：${ctx.foreground}`
  const running = ctx.gameRunning === null ? '未查' : ctx.gameRunning ? '存活' : '★ 不在'
  return [
    `实例 ${ctx.instanceIndex}${who}截图`,
    `北京时间 ${formatCst(ctx.at)}`,
    `前台：${fg}｜游戏进程：${running}`
  ]
    .join('\n')
    .slice(0, TELEGRAM_CAPTION_MAX)
}

/** 截图文件名：`inst0-20260909-212233.jpg`（只含 [A-Za-z0-9_.-]，可直接给 saveShot）。 */
export function shotFilename(instanceIndex: number, at: number): string {
  const s = formatCst(at).replace(/[-: ]/g, '')
  return `inst${instanceIndex}-${s.slice(0, 8)}-${s.slice(8)}.jpg`
}

// ══════════════════════════════════════════════════════════════════════════
// 六、面板「在面板内测试机器人动作」的 IPC 通道
// ══════════════════════════════════════════════════════════════════════════
//
// 与 alerts:* / scheduler:* 同一套做法：自带一小组通道，不登记进已冻结的 IpcRoutes。
// 主进程（b 组，src/main/bot/ipc.ts）注册；渲染进程用 callBot。
// ★ 'bot:perform' 直接调同一个 BotActionPort —— 面板测的就是机器人真正会跑的那条路。
//   截图动作返回的 BotPhoto.jpeg 是 ArrayBuffer，结构化克隆直接搬字节，面板用 bufferToObjectUrl 上屏。

export const BOT_CH = {
  /** 执行一个动作（与 Telegram 里点按钮完全同一条路）。 */
  perform: 'bot:perform',
  /** 可选实例列表（面板里的下拉框用）。 */
  instances: 'bot:instances'
} as const

export type BotRoutes = {
  'bot:perform': [[action: BotAction, instanceIndex: number | null], BotActionResult]
  'bot:instances': [[], BotInstanceRef[]]
}

export type BotChannel = keyof BotRoutes
export type BotArgs<K extends BotChannel> = BotRoutes[K][0]
export type BotResult<K extends BotChannel> = BotRoutes[K][1]

interface RawBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

function bridge(): RawBridge {
  const api = (globalThis as { api?: unknown }).api
  if (!api || typeof (api as RawBridge).invoke !== 'function') {
    throw new Error('window.api 尚未就绪：机器人测试接口只能在渲染进程里调用。')
  }
  return api as RawBridge
}

/** 渲染进程调用机器人动作。`await callBot('bot:perform', 'accounts', null)`。 */
export function callBot<K extends BotChannel>(channel: K, ...args: BotArgs<K>): Promise<BotResult<K>> {
  return bridge().invoke(channel, ...args) as Promise<BotResult<K>>
}

/** 把主进程/桥抛回来的异常翻译成一句中文（与 describeAlertError 同一写法）。 */
export function describeBotError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const stripped = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
  if (/No handler registered|no handler/i.test(stripped)) {
    return '主进程还没有注册机器人通道（bot:*）。机器人动作模块接线之后本按钮会自动可用。'
  }
  return stripped || '未知错误'
}
