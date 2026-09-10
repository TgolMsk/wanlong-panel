/**
 * 异常告警 / 自动暂停 / 外部通知 的公共契约（主进程 ⇄ 渲染进程 ⇄ 通知通道）。
 *
 * ★ 本文件是**新增**的，一个字都没有改动 src/shared 里已冻结的既有文件
 *   （ipc.ts 的 52 条通道 + 6 条推送、domain.ts、defaults.ts、constants.ts 全部原样）。
 *   做法与 scheduler.ts 完全一致：自带一小组 `alerts:*` 通道，走同一条 Electron IPC 桥，
 *   没有登记进 IpcRoutes；渲染进程用本文件底部的 callAlerts / onAlertEvent，
 *   必要的类型断言全部关在这里，调用方仍然是**完全类型安全**的。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【为什么要有这一层，读代码前先看这段】
 *
 * 用户的原始诉求是「设备被顶号了就暂停任务并且推送到 telegram」。
 * 顶号 = 账号在别的设备登录，本端被踢下线，游戏弹提示并退回登录界面。
 *
 * 现实约束：**没有顶号界面的模板**，也没法制造顶号来采集样本（要另一台设备登同一个号）。
 * 所以本模块分成**两层**，第二层缺席时第一层必须照样работать：
 *
 *   第一层（通用兜底，不依赖任何特定模板）：
 *     采集状态机已有「未知界面兜底恢复」阶梯（通用关闭 → BACK → 回家序列 → 冷启动 App，
 *     见 src/main/game/gather/navigation.ts 的 ensureWorldMap）。
 *     当这套阶梯**连续 N 次全部失败**、或连续 N 轮采集周期都以失败告终时，
 *     判定为 `needsAttention`（需要人工介入）⇒ 暂停该实例的自动调度 + 留痕 + 推送。
 *     这一层覆盖顶号、封号、维护公告、版本更新、网络断开等**所有**导致卡死的场景。
 *
 *   第二层（精确识别，本次只预留钩子）：
 *     为「顶号」预留了独立的事件类型 `suspectedKicked` 与模板 id
 *     `RESERVED_TEMPLATE.kickedDialog` / `loginScreen`（见下方）。
 *     ★ 模板缺失时 `GatherTemplates.get(id)` 返回 undefined（不是抛错、也不会进 missing 列表，
 *       因为 missing 只登记「模板集里有但编译失败」的），检测方**必须**据此静默降级到第一层，
 *       绝不允许因为模板不存在就报错或中止流程。
 *     等用户哪天真被顶号、把截图给过来，往模板集里补一张图即可生效，**代码一行都不用改**。
 *
 * 【暂停语义】
 *   暂停 = 把该实例的自动调度关掉（scheduler.setAuto(i, false)），
 *   并记录 pausedReason / pausedAt / 现场截图路径，面板显眼标红并给「恢复」按钮。
 *   暂停必须**幂等**：同一实例已经是暂停态时再次触发，不重复关调度、不重复推送。
 *   暂停后**不得继续排唤醒** —— setAuto(false) 已经会 cancelWake 并把 nextWakeAt 清空，
 *   不要在暂停之后再调 rearm。
 *
 * 【凭据纪律】★★ 违反这条比功能不可用严重得多
 *   TelegramConfig.botToken 是凭据。
 *     · 只存本地配置文件（<dataDir>/alerts.json，dataDir 已被 .gitignore 覆盖）
 *     · **绝不能**写进日志、绝不能出现在任何 SerializedError.message / detail 里
 *     · **绝不过 IPC 桥**：渲染进程只拿得到 AlertsConfigView（token 打码，只留后 4 位）
 *     · 任何要往外抛的文本，先过一遍 scrubSecret()
 *   见本文件的 SENSITIVE_ALERT_FIELDS / maskToken / scrubSecret / toAlertsConfigView。
 * ══════════════════════════════════════════════════════════════════════════
 */

import { makeId } from './defaults'

// ══════════════════════════════════════════════════════════════════════════
// 一、事件模型
// ══════════════════════════════════════════════════════════════════════════

/**
 * 告警事件类型。
 *
 * ★ 扩展方式：在这个数组里加一个值，再在 ALERT_SPECS 里补一条（标题/级别/是否暂停/文案），
 *   就完事了 —— 通道代码、限流代码、面板代码**都不用改**。
 *   TypeScript 会强制你补 ALERT_SPECS：Record<AlertType, AlertSpec> 少一个键就编译不过。
 */
export const ALERT_TYPES = [
  /** 需要人工介入：通用兜底判定（恢复阶梯用尽 / 连续多轮失败）。★ 用户诉求的主路径 */
  'needsAttention',
  /** 疑似顶号：第二层精确识别命中（模板缺失时永远不会产生这个事件，会降级成 needsAttention） */
  'suspectedKicked',
  /** 连续失败熔断：同一实例连续 N 轮采集/派遣失败 */
  'consecutiveFailures',
  /** 模拟器或游戏进程掉线：实例不在 running / adb 连不上 / 前台包名长期不是游戏 */
  'deviceOffline',
  /** 采集因体力、兵力、队列长期无法派出（不是坏状态，只是干不了活） */
  'dispatchStalled',
  /** 实例已恢复（人工点「恢复」或自愈成功）。信息级，用来给用户一个闭环 */
  'instanceResumed',
  /** 「测试推送」按钮产生的合成事件。不参与订阅列表，也永不触发暂停 */
  'test'
] as const

export type AlertType = (typeof ALERT_TYPES)[number]

/**
 * 严重级别。
 *   critical 需人工介入 —— 触发暂停，默认推送
 *   warning  警告       —— 不暂停，默认推送
 *   info     信息       —— 不暂停，默认推送（量很小）
 */
export type AlertSeverity = 'critical' | 'warning' | 'info'

export const ALERT_SEVERITY_TEXT: Record<AlertSeverity, string> = {
  critical: '需要人工介入',
  warning: '警告',
  info: '信息'
}

/** 面板标色用。颜色一律走 --wl-* CSS 变量，这里只给语义名，不给色值。 */
export const ALERT_SEVERITY_TONE: Record<AlertSeverity, 'danger' | 'warning' | 'info'> = {
  critical: 'danger',
  warning: 'warning',
  info: 'info'
}

/** 一种事件类型的静态描述。★ 「哪些事件触发暂停」就表达在这里，不散落在业务代码里。 */
export interface AlertSpec {
  readonly type: AlertType
  /** 中文标题，推送的第一行、面板的标签都用它。 */
  readonly title: string
  readonly severity: AlertSeverity
  /** ★ 是否触发「暂停该实例的自动调度」。 */
  readonly pauses: boolean
  /** 默认是否订阅推送（用户可在设置页逐项改）。 */
  readonly notifyByDefault: boolean
  /** 这类事件是什么意思（面板 Tooltip / 设置页说明）。 */
  readonly summary: string
  /** 出了这个事用户该做什么（写进推送正文的「处置」一行）。 */
  readonly advice: string
}

/**
 * 事件类型总表。
 *
 * `as const satisfies Record<AlertType, AlertSpec>`：
 *   · satisfies 保证不缺键、字段类型不写错（缺一个 AlertType 就编译失败）
 *   · as const 保留 pauses 的字面量 true/false，PausingAlertType 才推得出来
 */
export const ALERT_SPECS = {
  needsAttention: {
    type: 'needsAttention',
    title: '需要人工介入',
    severity: 'critical',
    pauses: true,
    notifyByDefault: true,
    summary:
      '通用兜底判定：采集状态机的「未知界面恢复阶梯」已经用尽（通用关闭 → BACK → 回家序列 → 冷启动 App 都没能回到世界地图），' +
      '或连续多轮采集周期都以失败告终。顶号、封号、维护公告、版本更新、网络断开都会走到这里。',
    advice:
      '已暂停该实例的自动调度。请打开模拟器看一眼当前是什么界面（是否被顶号、是否弹了维护/更新公告），' +
      '处理完成后回面板点「恢复」。'
  },
  suspectedKicked: {
    type: 'suspectedKicked',
    title: '疑似被顶号',
    severity: 'critical',
    pauses: true,
    notifyByDefault: true,
    summary:
      '第二层精确识别命中了「账号在其他设备登录」提示框或登录界面。' +
      '★ 相应模板尚未采集时，这类事件永远不会产生，检测会自动降级成「需要人工介入」。',
    advice:
      '已暂停该实例的自动调度。账号很可能在别的设备上登录了，请先确认是不是自己在别处操作；' +
      '确认安全后重新登录游戏，再回面板点「恢复」。'
  },
  consecutiveFailures: {
    type: 'consecutiveFailures',
    title: '连续失败熔断',
    severity: 'critical',
    pauses: true,
    notifyByDefault: true,
    summary: '同一实例连续多轮采集/派遣都失败，继续重试只会在坏状态上反复操作游戏。',
    advice: '已暂停该实例的自动调度。请查看日志里最近几轮的失败原因，处理后回面板点「恢复」。'
  },
  deviceOffline: {
    type: 'deviceOffline',
    title: '模拟器或游戏掉线',
    severity: 'critical',
    pauses: true,
    notifyByDefault: true,
    summary:
      'MuMu 实例不在运行状态、adb 连不上，或前台包名长期不是万龙觉醒且拉不起来。' +
      '这时候任何点击都会落到别的应用上。',
    advice: '已暂停该实例的自动调度。请确认模拟器是否被关掉或崩溃，重开实例并把游戏拉起来后点「恢复」。'
  },
  dispatchStalled: {
    type: 'dispatchStalled',
    title: '长时间派不出队',
    severity: 'warning',
    pauses: false,
    notifyByDefault: true,
    summary:
      '游戏本身是好的，但因为指挥官耐力不足、兵力不够、行军队列一直占满或搜不到合格资源点，' +
      '已经很久没有成功派出过采集队。',
    advice: '不影响面板运行，自动调度**照常继续**。要提高产出可以调低搜索下限、放宽储量要求或补充耐力。'
  },
  instanceResumed: {
    type: 'instanceResumed',
    title: '实例已恢复',
    severity: 'info',
    pauses: false,
    notifyByDefault: true,
    summary: '被暂停的实例已经重新开启自动调度。',
    advice: '无需处理。'
  },
  test: {
    type: 'test',
    title: '测试推送',
    severity: 'info',
    pauses: false,
    notifyByDefault: true,
    summary: '设置页「测试推送」按钮产生的合成事件，用来验证 Telegram 配置是否通。',
    advice: '收到这条就说明 bot token 与 chat id 都是对的。'
  }
} as const satisfies Record<AlertType, AlertSpec>

/**
 * ★ 会触发暂停的事件类型 —— **在类型层面**从 ALERT_SPECS 推出来，不是手抄的第二份清单。
 * 往 ALERT_SPECS 里加一条 `pauses: true`，这个联合类型自动就多一个成员。
 */
export type PausingAlertType = {
  [K in AlertType]: (typeof ALERT_SPECS)[K]['pauses'] extends true ? K : never
}[AlertType]

/** 取一种事件的静态描述。 */
export function alertSpec(type: AlertType): AlertSpec {
  return ALERT_SPECS[type]
}

/** 这个事件是否应该暂停实例。返回 true 时 TS 会把 type 收窄成 PausingAlertType。 */
export function pausesInstance(type: AlertType): type is PausingAlertType {
  return ALERT_SPECS[type].pauses
}

/** 设置页里可以逐项订阅的事件类型（排除合成的 test）。 */
export const SUBSCRIBABLE_ALERT_TYPES: readonly AlertType[] = ALERT_TYPES.filter((t) => t !== 'test')

// ── 事件负载 ──────────────────────────────────────────────────────────────

/**
 * 事件的结构化细节。
 * ★ 必须能被 structuredClone（要过 IPC 桥），所以只允许这几种标量，不要放 Error / Map / Buffer。
 */
export type AlertDetail = Record<string, string | number | boolean | null>

/** 一条告警事件。所有时刻都是**绝对毫秒**（Date.now()），显示时才换算成北京时间。 */
export interface AlertEvent {
  /** 事件 id，makeAlertId() 生成，形如 `alert_mtuf7pp50gfr`。 */
  id: string
  type: AlertType
  /** 冗余存一份，避免面板为了知道级别再去查表。永远等于 ALERT_SPECS[type].severity。 */
  severity: AlertSeverity
  /** 出事的 MuMu 实例编号。 */
  instanceIndex: number
  /** 绑定的账号 id；没绑为 null。 */
  accountId: string | null
  /** 账号展示名；没绑或读不到为 null（推送里回落成「未绑定账号」）。 */
  accountName: string | null
  /** 发生时刻（Date.now()）。 */
  at: number
  /**
   * 中文原因，一句话说清「为什么判定成这个事件」。
   * 面板直接显示，推送直接引用，所以**不要**放英文栈或裸错误码。
   */
  reason: string
  /**
   * 现场截图，相对 <dataDir>/shots 的路径，形如 `alerts/inst0-1757462412345.jpg`。
   * 没留到就是 null（★ 留痕失败绝不能让暂停这件事本身失败）。
   */
  shotPath: string | null
  /** 排障用的补充信息，例如 { step: 'G0', attempts: 6, outcome: 'error' }。 */
  detail?: AlertDetail
  /**
   * ★ 限流与去重的键 = `${instanceIndex}:${type}`。
   *   同一实例同一原因在冷却期内只推一次。由 makeAlertEvent 自动填。
   */
  dedupeKey: string
}

/** 造事件时要填的字段（severity / dedupeKey / id / at 由工厂补齐）。 */
export interface AlertEventInput {
  type: AlertType
  instanceIndex: number
  reason: string
  accountId?: string | null
  accountName?: string | null
  shotPath?: string | null
  detail?: AlertDetail
  /** 不传取 Date.now()。传进来是为了让单测可控。 */
  at?: number
}

/** 限流/去重的键。同一实例 + 同一事件类型算「同一件事」。 */
export function alertDedupeKey(instanceIndex: number, type: AlertType): string {
  return `${instanceIndex}:${type}`
}

export function makeAlertId(): string {
  return makeId('alert')
}

/** 唯一的事件构造入口。别在业务代码里手搓 AlertEvent 字面量，会漏掉 dedupeKey。 */
export function makeAlertEvent(input: AlertEventInput): AlertEvent {
  const type = input.type
  return {
    id: makeAlertId(),
    type,
    severity: ALERT_SPECS[type].severity,
    instanceIndex: input.instanceIndex,
    accountId: input.accountId ?? null,
    accountName: input.accountName ?? null,
    at: input.at ?? Date.now(),
    reason: input.reason,
    shotPath: input.shotPath ?? null,
    detail: input.detail,
    dedupeKey: alertDedupeKey(input.instanceIndex, type)
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 二、北京时间
// ══════════════════════════════════════════════════════════════════════════
//
// ★ 游戏按**北京时间**运行（疲劳期 0:00–9:00 就是按 CST 划的，见 scheduler/state.ts 的
//   nextCstBoundary），而宿主机时区不一定是北京 —— 实测本机是 America/Los_Angeles。
//   所以推送里的时间戳必须显式按 UTC+8 算，**绝对不能**用 toLocaleString()。

export const CST_OFFSET_MS = 8 * 3_600_000

/** 绝对时刻 -> 北京时间 `YYYY-MM-DD HH:MM:SS`。纯函数，与本机时区无关。 */
export function formatCst(at: number, withSeconds = true): string {
  if (!Number.isFinite(at)) return '--'
  const d = new Date(at + CST_OFFSET_MS)
  const p = (n: number): string => String(n).padStart(2, '0')
  const ymd = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
  const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  return withSeconds ? `${ymd} ${hm}:${p(d.getUTCSeconds())}` : `${ymd} ${hm}`
}

/** 只要 `HH:MM:SS`（北京时间），面板里空间紧张的地方用。 */
export function formatCstClock(at: number): string {
  if (!Number.isFinite(at)) return '--:--:--'
  const d = new Date(at + CST_OFFSET_MS)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

// ══════════════════════════════════════════════════════════════════════════
// 三、消息渲染
// ══════════════════════════════════════════════════════════════════════════

/**
 * 渲染推送正文。
 *
 * ★ 输出是**纯文本**，不用 Markdown / HTML parse_mode ——
 *   账号名和错误原因里随时可能出现 `_ * [ ]` 这类字符，一旦开了 parse_mode，
 *   Telegram 会返回 400 "can't parse entities"，表现为「测试推送能通、真出事时推不出去」。
 *   这是最坏的一类 bug：只在真需要它的时候坏掉。所以一律不开 parse_mode。
 */
export function renderAlertText(e: AlertEvent): string {
  const spec = ALERT_SPECS[e.type]
  const who = e.accountName ? `${e.accountName}` : '未绑定账号'
  const tag = ALERT_SEVERITY_TEXT[spec.severity]
  // 标题本身就是级别名时（「需要人工介入」）不要写两遍。
  const head = spec.title === tag ? `【${spec.title}】` : `【${tag}】${spec.title}`
  const lines: string[] = [
    head,
    `实例 ${e.instanceIndex}（${who}）`,
    `原因：${e.reason}`,
    `时间：${formatCst(e.at)}（北京时间）`
  ]
  const detailLine = renderAlertDetail(e.detail)
  if (detailLine) lines.push(`现场：${detailLine}`)
  if (e.shotPath) lines.push(`截图：${e.shotPath}`)
  lines.push(`处置：${spec.advice}`)
  return lines.join('\n')
}

/** 一行式摘要，面板列表和日志用。 */
export function renderAlertSummary(e: AlertEvent): string {
  return `实例 ${e.instanceIndex}｜${ALERT_SPECS[e.type].title}｜${e.reason}`
}

function renderAlertDetail(detail: AlertDetail | undefined): string {
  if (!detail) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === '') continue
    parts.push(`${k}=${String(v)}`)
  }
  return parts.join(' ')
}

// ══════════════════════════════════════════════════════════════════════════
// 四、通知通道契约（与服务商无关）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 通道 id。加钉钉/飞书/邮件时在这里加一个值，实现一个 Notifier，
 * **调用方一行都不用改** —— 它只认 Notifier 接口。
 */
export const NOTIFIER_IDS = ['telegram'] as const
export type NotifierId = (typeof NOTIFIER_IDS)[number]

export const NOTIFIER_LABEL: Record<NotifierId, string> = {
  telegram: 'Telegram'
}

/** 发送失败的分类。★ 每一类都要给出**不一样的**中文提示，否则用户不知道该改哪。 */
export type NotifyFailureKind =
  /** 开关没打开 */
  | 'disabled'
  /** token / chatId 还没填 */
  | 'notConfigured'
  /** 这条事件类型没被订阅 */
  | 'unsubscribed'
  /** 冷却期内被去重压掉 */
  | 'throttled'
  /** bot token 不对（Telegram 401） */
  | 'badToken'
  /** chat id 不对 / bot 没被拉进那个会话（400 chat not found、403 blocked） */
  | 'badChat'
  /** 网络不通（DNS / 连接被拒 / 被墙） */
  | 'network'
  /** 请求超时 */
  | 'timeout'
  /** 被限流（429），retryAfterSec 有值 */
  | 'rateLimited'
  /** 对方服务器 5xx */
  | 'serverError'
  /** 其它 */
  | 'unknown'

export const NOTIFY_FAILURE_TEXT: Record<NotifyFailureKind, string> = {
  disabled: '推送开关没打开',
  notConfigured: '推送尚未配置完整',
  unsubscribed: '这类事件没有被订阅',
  throttled: '冷却期内已去重',
  badToken: 'Bot Token 无效',
  badChat: 'Chat ID 不对',
  network: '网络不通',
  timeout: '请求超时',
  rateLimited: '被限流',
  serverError: '对方服务器出错',
  unknown: '未知错误'
}

/** 一次发送的结果。★ 里面**绝不允许**出现 token —— 构造前先过 scrubSecret()。 */
export interface NotifyResult {
  ok: boolean
  channel: NotifierId
  /** 失败分类；成功时为 null。 */
  failure: NotifyFailureKind | null
  /** 面向用户的中文说明。成功时也要给一句（例如「已推送到 Telegram」）。 */
  message: string
  /** 实际尝试了几次（含首次）。被开关/订阅/冷却挡掉时是 0。 */
  attempts: number
  elapsedMs: number
  /** 完成时刻。 */
  at: number
  /** 429 时对方要求的等待秒数；其它情况为 null。 */
  retryAfterSec: number | null
}

/**
 * 与具体服务商无关的通知通道。
 *
 * 实现方（TelegramNotifier）负责：拼消息、发 HTTPS、重试、把失败翻译成中文。
 * 调用方（暂停接线）只做一件事：`await notifier.send(event)`，然后把结果记进日志与面板。
 *
 * ★ send() **绝不允许抛异常** —— 推送失败不得影响主流程（暂停该做还是要做）。
 *   一切失败都走返回值里的 ok:false + failure + message。
 */
export interface Notifier {
  readonly id: NotifierId
  readonly label: string
  /** 当前配置下是否可用（开关开着且 token/chatId 都填了）。 */
  isReady(): boolean
  /** 发一条告警。不抛异常。 */
  send(event: AlertEvent): Promise<NotifyResult>
  /** 「测试推送」按钮：发一条合成的 test 事件，绕过订阅过滤与冷却。不抛异常。 */
  test(): Promise<NotifyResult>
}

/** 多通道分发器（现在只有 telegram，将来 for..of 一圈就行）。 */
export interface NotifyDispatchResult {
  event: AlertEvent
  results: NotifyResult[]
  /** 是否至少有一条通道发成功。 */
  anyOk: boolean
}

/** 构造一个「压根没发」的结果，用于开关关闭/未订阅/冷却压制。 */
export function skippedNotifyResult(
  channel: NotifierId,
  failure: NotifyFailureKind,
  message: string,
  at: number = Date.now()
): NotifyResult {
  return { ok: false, channel, failure, message, attempts: 0, elapsedMs: 0, at, retryAfterSec: null }
}

// ── 限流与去重 ────────────────────────────────────────────────────────────

export interface ThrottleEntry {
  /** 上次**实际发出去**的时刻。 */
  lastSentAt: number
  /** 冷却期内被压掉了几条。下次放行时会带上这个数字，让用户知道期间又出了几次。 */
  suppressedCount: number
  /** 最近一次被压掉的时刻（面板显示「还有多久解冻」用）。 */
  lastSuppressedAt: number | null
}

export interface ThrottleDecision {
  allow: boolean
  /** 中文说明，写日志用。 */
  reason: string
  /** 若放行，本次消息应附带「期间还被压掉 N 条」；不放行时是当前累计值。 */
  suppressedCount: number
  /** 不放行时，最早什么时候能再发；放行时为 null。 */
  nextAllowedAt: number | null
}

/**
 * 按 `实例 + 事件类型` 做冷却的限流器。
 *
 * 纯内存 + 纯函数式，放在 shared 是为了让主进程和离线自检用同一份实现。
 * ★ 幂等要求：暂停被重复触发时，check() 会返回 allow:false，调用方据此**跳过推送**，
 *   但**照样**要保证暂停这个动作本身已经生效（那是幂等的，setAuto(false) 重复调没有副作用）。
 * ★ 跨重启：用 snapshot() / restore() 把状态随 alerts.json 一起落盘，
 *   否则面板一重启，坏状态下的实例会立刻再推一次。
 */
export class AlertThrottle {
  private readonly entries = new Map<string, ThrottleEntry>()

  /** 冷却秒数用 getter 传进来，配置改了立刻生效，不用重建实例。 */
  constructor(private readonly cooldownSecondsOf: () => number) {}

  check(key: string, now: number = Date.now()): ThrottleDecision {
    const cooldownMs = Math.max(0, this.cooldownSecondsOf()) * 1000
    const e = this.entries.get(key)
    if (!e || cooldownMs === 0) {
      return { allow: true, reason: '首次触发或未设冷却', suppressedCount: e?.suppressedCount ?? 0, nextAllowedAt: null }
    }
    const nextAllowedAt = e.lastSentAt + cooldownMs
    if (now >= nextAllowedAt) {
      return { allow: true, reason: '冷却已过', suppressedCount: e.suppressedCount, nextAllowedAt: null }
    }
    return {
      allow: false,
      reason: `同一实例同一原因在冷却期内（还需 ${Math.ceil((nextAllowedAt - now) / 1000)}s）`,
      suppressedCount: e.suppressedCount,
      nextAllowedAt
    }
  }

  /** 真的发出去之后调用：重置冷却起点并清空压制计数。 */
  markSent(key: string, now: number = Date.now()): void {
    this.entries.set(key, { lastSentAt: now, suppressedCount: 0, lastSuppressedAt: null })
  }

  /** 被冷却压掉之后调用：累加压制计数（下次放行时会一并告知用户）。 */
  markSuppressed(key: string, now: number = Date.now()): void {
    const e = this.entries.get(key)
    if (!e) {
      this.entries.set(key, { lastSentAt: 0, suppressedCount: 1, lastSuppressedAt: now })
      return
    }
    this.entries.set(key, { ...e, suppressedCount: e.suppressedCount + 1, lastSuppressedAt: now })
  }

  /** 实例恢复正常时把它的冷却清掉，下次再出事能立刻推。 */
  reset(key?: string): void {
    if (key === undefined) this.entries.clear()
    else this.entries.delete(key)
  }

  /** 清掉某个实例的全部事件类型（点「恢复」时调）。 */
  resetInstance(instanceIndex: number): void {
    const prefix = `${instanceIndex}:`
    for (const k of [...this.entries.keys()]) {
      if (k.startsWith(prefix)) this.entries.delete(k)
    }
  }

  snapshot(): Record<string, ThrottleEntry> {
    return Object.fromEntries(this.entries)
  }

  restore(snap: Record<string, ThrottleEntry> | undefined | null): void {
    this.entries.clear()
    if (!snap) return
    for (const [k, v] of Object.entries(snap)) {
      if (!v || typeof v !== 'object') continue
      this.entries.set(k, {
        lastSentAt: numOr(v.lastSentAt, 0),
        suppressedCount: numOr(v.suppressedCount, 0),
        lastSuppressedAt: typeof v.lastSuppressedAt === 'number' ? v.lastSuppressedAt : null
      })
    }
  }
}

/** 「期间还被压掉 N 条」的补充说明。suppressedCount 为 0 时返回空串。 */
export function renderSuppressedNote(suppressedCount: number): string {
  return suppressedCount > 0 ? `（冷却期内还发生过 ${suppressedCount} 次同类事件）` : ''
}

// ══════════════════════════════════════════════════════════════════════════
// 五、配置
// ══════════════════════════════════════════════════════════════════════════

/**
 * ★★ 敏感字段清单。任何要落日志/过桥/进报错的地方都必须先剔除这些字段。
 *   路径写法是 `<段>.<段>`，与 AlertsConfig 的结构一一对应。
 */
export const SENSITIVE_ALERT_FIELDS = ['telegram.botToken'] as const

export interface TelegramConfig {
  enabled: boolean
  /**
   * ★★ 敏感：Bot Token（形如 `123456789:AAE...`）。
   *   只存 <dataDir>/alerts.json，**绝不过 IPC 桥、绝不进日志、绝不进报错**。
   *   面板拿到的是 AlertsConfigView.telegram.botTokenMasked（只留后 4 位）。
   */
  botToken: string
  /** 目标会话 id。私聊是正数，群/频道是负数（形如 -1001234567890）。 */
  chatId: string
  /** 同一实例同一原因的推送冷却（秒）。默认 600 = 10 分钟。 */
  cooldownSeconds: number
  /** 失败重试次数（不含首次）。默认 2，即最多发 3 次。 */
  retryCount: number
  /** 单次请求超时（毫秒）。 */
  timeoutMs: number
  /** 订阅哪些事件类型。不在列表里的事件不推送（但该暂停还是要暂停）。 */
  subscribedTypes: AlertType[]
  /**
   * 远程控制：允许通过 Telegram 的按钮 / 命令恢复实例、重启游戏、查状态。
   * ★ 只响应 chatId 那一个会话，其它会话一律忽略并记日志。
   */
  remoteControl: boolean
}

/** 第一层「通用兜底」的判定阈值。 */
export interface AlertDetectConfig {
  /** 总开关：关掉之后只记录不暂停（排查期可能想让它继续跑）。 */
  autoPauseEnabled: boolean
  /**
   * 连续 N 轮采集周期失败即判定「需要人工介入」。默认 3。
   * 一轮失败 = runGatherCycle 返回 outcome === 'error'，或抛出 G0 恢复失败。
   */
  cycleFailThreshold: number
  /**
   * 「未知界面恢复阶梯」连续 N 次全部走完仍失败即判定。默认 2。
   * 比 cycleFailThreshold 小是故意的：阶梯用尽是比普通失败强得多的信号。
   */
  recoveryFailThreshold: number
  /** 连续 N 次采样（开部队管理面板）失败即判定「模拟器或游戏掉线」。默认 3。 */
  sampleFailThreshold: number
  /** 超过这么多分钟一支队都没派出去，就报「长时间派不出队」。默认 120。 */
  stalledMinutes: number
  /**
   * 是否尝试第二层精确识别（顶号）。
   * ★ 打开也不会报错：模板不存在时静默降级到第一层。默认 true。
   */
  kickedProbeEnabled: boolean
}

export interface AlertsConfig {
  /** 配置结构版本，将来加字段时用来做迁移。当前 1。 */
  version: 1
  detect: AlertDetectConfig
  telegram: TelegramConfig
}

/** 配置文件名，落在 <dataDir>/alerts.json（dataDir 已被 .gitignore 覆盖）。 */
export const ALERTS_FILE = 'alerts.json'

/**
 * ★★★ 默认值的**唯一权威**就是这个函数。
 *
 * 本工程有过「三镜像默认值打架」的教训（采集配置同时住在
 * resources/game-data/gather-config.schema.json、src/main/game/gather/config.ts、
 * src/renderer/src/features/gather/config.ts 三处，改一处忘两处）。
 * 这次不重蹈覆辙：**主进程、渲染进程、离线自检一律 import 这个函数**，
 * 任何地方都不许再写第二份 `{ enabled: false, cooldownSeconds: 600, ... }` 字面量。
 * 需要同步的镜像位置见本文件末尾「配置镜像位置清单」。
 */
export function defaultAlertsConfig(): AlertsConfig {
  return {
    version: 1,
    detect: {
      autoPauseEnabled: true,
      cycleFailThreshold: 3,
      recoveryFailThreshold: 2,
      sampleFailThreshold: 3,
      stalledMinutes: 120,
      kickedProbeEnabled: true
    },
    telegram: {
      enabled: false,
      botToken: '',
      chatId: '',
      cooldownSeconds: 600,
      retryCount: 2,
      timeoutMs: 15_000,
      subscribedTypes: SUBSCRIBABLE_ALERT_TYPES.filter((t) => ALERT_SPECS[t].notifyByDefault),
      remoteControl: true
    }
  }
}

function numOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function boolOr(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt
}

function strOr(v: unknown, dflt: string): string {
  return typeof v === 'string' ? v : dflt
}

function isAlertType(v: unknown): v is AlertType {
  return typeof v === 'string' && (ALERT_TYPES as readonly string[]).includes(v)
}

/**
 * 逐字段容错归一化：单个字段非法只回退这一个字段，**不整体作废**。
 * 磁盘文件坏了 / 面板传来半份补丁 / 版本升级多了字段，都走这里。
 */
export function normalizeAlertsConfig(raw: unknown): AlertsConfig {
  const base = defaultAlertsConfig()
  if (typeof raw !== 'object' || raw === null) return base
  const o = raw as Record<string, unknown>

  const d = (typeof o.detect === 'object' && o.detect !== null ? o.detect : {}) as Record<
    string,
    unknown
  >
  const t = (typeof o.telegram === 'object' && o.telegram !== null ? o.telegram : {}) as Record<
    string,
    unknown
  >

  const subs = Array.isArray(t.subscribedTypes)
    ? (t.subscribedTypes as unknown[]).filter(isAlertType)
    : base.telegram.subscribedTypes

  return {
    version: 1,
    detect: {
      autoPauseEnabled: boolOr(d.autoPauseEnabled, base.detect.autoPauseEnabled),
      cycleFailThreshold: clamp(numOr(d.cycleFailThreshold, base.detect.cycleFailThreshold), 1, 20),
      recoveryFailThreshold: clamp(
        numOr(d.recoveryFailThreshold, base.detect.recoveryFailThreshold),
        1,
        20
      ),
      sampleFailThreshold: clamp(
        numOr(d.sampleFailThreshold, base.detect.sampleFailThreshold),
        1,
        20
      ),
      stalledMinutes: clamp(numOr(d.stalledMinutes, base.detect.stalledMinutes), 5, 1440),
      kickedProbeEnabled: boolOr(d.kickedProbeEnabled, base.detect.kickedProbeEnabled)
    },
    telegram: {
      enabled: boolOr(t.enabled, base.telegram.enabled),
      botToken: strOr(t.botToken, base.telegram.botToken).trim(),
      chatId: strOr(t.chatId, base.telegram.chatId).trim(),
      cooldownSeconds: clamp(numOr(t.cooldownSeconds, base.telegram.cooldownSeconds), 0, 86_400),
      retryCount: clamp(numOr(t.retryCount, base.telegram.retryCount), 0, 5),
      timeoutMs: clamp(numOr(t.timeoutMs, base.telegram.timeoutMs), 2_000, 120_000),
      // 去重后保持 ALERT_TYPES 的声明顺序，面板显示才稳定。
      subscribedTypes: ALERT_TYPES.filter((x) => subs.includes(x)),
      remoteControl: boolOr(t.remoteControl, base.telegram.remoteControl)
    }
  }
}

// ── 面板可见的配置视图（token 打码，绝不过桥）──────────────────────────────

export interface TelegramConfigView extends Omit<TelegramConfig, 'botToken'> {
  /** 打码后的 token，形如 `••••••dEf0`。没填过是空串。 */
  botTokenMasked: string
  /** 是否已经存过一个 token。面板据此显示「已配置 / 未配置」。 */
  botTokenSet: boolean
}

export interface AlertsConfigView extends Omit<AlertsConfig, 'telegram'> {
  telegram: TelegramConfigView
}

/**
 * token 打码：只显示后 4 位。
 *   ''              -> ''
 *   'abc'（≤4 位）  -> '••••'   ← 太短就整体遮掉，别把短 token 直接漏出去
 *   '123456:AAEdEf0'-> '••••••dEf0'
 */
export function maskToken(token: string): string {
  const t = (token ?? '').trim()
  if (t === '') return ''
  if (t.length <= 4) return '••••'
  return `••••••${t.slice(-4)}`
}

/** ★ 主进程往渲染进程送配置的**唯一**出口。任何别的路径都算凭据泄漏。 */
export function toAlertsConfigView(cfg: AlertsConfig): AlertsConfigView {
  const { botToken, ...rest } = cfg.telegram
  return {
    version: cfg.version,
    detect: { ...cfg.detect },
    telegram: {
      ...rest,
      subscribedTypes: [...rest.subscribedTypes],
      botTokenMasked: maskToken(botToken),
      botTokenSet: botToken.trim() !== ''
    }
  }
}

/**
 * 面板提交的补丁。
 *
 * ★ botToken 的三态语义（下游必须照这个实现，否则用户改个冷却秒数就会把 token 抹掉）：
 *     字段不存在（undefined）→ **保持原值不动**（面板正常保存时就是这样）
 *     非空字符串             → 用新值覆盖
 *     空字符串 ''            → **显式清空**（面板上有个「清除 Token」按钮才会送这个）
 */
export interface TelegramConfigPatch extends Partial<Omit<TelegramConfig, 'botToken'>> {
  botToken?: string
}

export interface AlertsConfigPatch {
  detect?: Partial<AlertDetectConfig>
  telegram?: TelegramConfigPatch
}

/** 把补丁合进现配置。实现了上面那条 botToken 三态语义。 */
export function mergeAlertsConfig(base: AlertsConfig, patch: AlertsConfigPatch | undefined): AlertsConfig {
  const p = patch ?? {}
  const merged: unknown = {
    version: 1,
    detect: { ...base.detect, ...(p.detect ?? {}) },
    telegram: {
      ...base.telegram,
      ...(p.telegram ?? {}),
      // undefined 就保持原值；'' 表示显式清空。
      botToken: p.telegram?.botToken === undefined ? base.telegram.botToken : p.telegram.botToken
    }
  }
  return normalizeAlertsConfig(merged)
}

// ── 配置体检 ──────────────────────────────────────────────────────────────

/** Telegram bot token 的形状：`<数字 id>:<35 位左右的串>`。只做形状检查，真假要靠测试推送。 */
const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/
/** chat id：正整数（私聊）、负整数（群/超级群/频道）。 */
const CHAT_ID_SHAPE = /^-?\d{1,32}$/

/**
 * 配置体检，返回中文问题列表（空数组 = 没问题）。
 * ★ 返回值里**不含 token 本身**，可以直接显示、直接写日志。
 */
export function validateTelegramConfig(cfg: TelegramConfig): string[] {
  const problems: string[] = []
  const token = cfg.botToken.trim()
  const chat = cfg.chatId.trim()
  if (token === '') {
    problems.push('还没有填 Bot Token。到 Telegram 里找 @BotFather 发 /newbot 建一个机器人就能拿到。')
  } else if (!TOKEN_SHAPE.test(token)) {
    problems.push(
      'Bot Token 的格式不对：应该形如「123456789:AAE…」（冒号前是一串数字，冒号后是一长串字母数字）。' +
        '常见错误是把整行「HTTP API: xxx」都粘进来了。'
    )
  }
  if (chat === '') {
    problems.push(
      '还没有填 Chat ID。给你的机器人随便发一条消息，然后找 @userinfobot 或 @getidsbot 要一下你的数字 id。'
    )
  } else if (!CHAT_ID_SHAPE.test(chat)) {
    problems.push(
      'Chat ID 只能是数字（群和频道是负数，形如 -1001234567890）。@username 这种写法这里不支持。'
    )
  }
  return problems
}

/** 配置是否已经能用（开关开着 + 体检通过）。 */
export function isTelegramReady(cfg: TelegramConfig): boolean {
  return cfg.enabled && validateTelegramConfig(cfg).length === 0
}

/** 这条事件类型是否被订阅。 */
export function isSubscribed(cfg: TelegramConfig, type: AlertType): boolean {
  // test 是「测试推送」按钮的合成事件，永远绕过订阅过滤。
  if (type === 'test') return true
  return cfg.subscribedTypes.includes(type)
}

// ── 凭据清洗 ──────────────────────────────────────────────────────────────

/**
 * ★★ 把文本里出现的 token 洗成 `***`。
 *
 * 用在**每一处**可能把 token 带出去的地方：
 *   · fetch 抛出的错误（Node 的 undici 会把完整 URL 写进 message，URL 里就有 token）
 *   · 任何 `catch (e) { log(String(e)) }`
 *   · NotifyResult.message
 * 空 token 时原样返回（别把空串替换成 *** 把整段文本打成马赛克）。
 */
export function scrubSecret(text: string, secret: string): string {
  const s = (secret ?? '').trim()
  if (s === '' || s.length < 8) return text
  return text.split(s).join('***')
}

/** 把配置压成可以安全写进日志的形状（token 已打码）。 */
export function redactAlertsConfig(cfg: AlertsConfig): Record<string, unknown> {
  return {
    version: cfg.version,
    detect: { ...cfg.detect },
    telegram: {
      enabled: cfg.telegram.enabled,
      botToken: maskToken(cfg.telegram.botToken),
      chatId: cfg.telegram.chatId,
      cooldownSeconds: cfg.telegram.cooldownSeconds,
      retryCount: cfg.telegram.retryCount,
      timeoutMs: cfg.telegram.timeoutMs,
      subscribedTypes: [...cfg.telegram.subscribedTypes]
    }
  }
}

// ── Telegram 专用的纯函数（放这里是为了让中文提示只有一份）────────────────

export const TELEGRAM_API_HOST = 'https://api.telegram.org'

/**
 * 拼 Bot API 的 URL。
 * ★★ 返回值里**含 token**。绝对不要把它写进日志或错误信息；
 *    真要往外说，先 `scrubSecret(text, token)`。
 */
export function telegramApiUrl(botToken: string, method: string): string {
  return `${TELEGRAM_API_HOST}/bot${botToken}/${method}`
}

export interface TelegramFailureInput {
  /** HTTP 状态码；根本没连上就传 null。 */
  status: number | null
  /** 响应体里的 description 字段（Telegram 用它说明原因）。没有传 null。 */
  description: string | null
  /** 响应体 parameters.retry_after。没有传 null。 */
  retryAfterSec: number | null
  /** 传输层异常的原始文本（★ 传进来之前请先 scrubSecret 洗过）。 */
  transportError: string | null
}

/**
 * 把一次失败翻译成「分类 + 用户看得懂的中文原因」。
 * ★ token 无效 / chat id 不对 / 网络不通 / 被限流 —— 四种情况给四种不同的话，这是硬要求。
 */
export function describeTelegramFailure(input: TelegramFailureInput): {
  kind: NotifyFailureKind
  message: string
} {
  const desc = (input.description ?? '').toLowerCase()

  if (input.status === null) {
    const raw = input.transportError ?? ''
    if (/abort|timeout|timed out/i.test(raw)) {
      return {
        kind: 'timeout',
        message:
          '请求超时，没能连上 api.telegram.org。国内网络通常需要给面板配代理，' +
          '或者确认你的网络能访问 Telegram。'
      }
    }
    return {
      kind: 'network',
      message:
        '网络不通，连不上 api.telegram.org。请确认这台机器能访问 Telegram' +
        '（国内直连通常是不行的，需要代理），也检查一下 DNS 与防火墙。' +
        (raw ? `底层报错：${raw}` : '')
    }
  }

  if (input.status === 401) {
    return {
      kind: 'badToken',
      message:
        'Bot Token 无效（Telegram 返回 401 Unauthorized）。请回到 @BotFather 用 /mybots 重新复制一次 token，' +
        '注意只复制冒号两边那一整串，不要带上「HTTP API:」这几个字，也不要有多余空格。'
    }
  }

  if (input.status === 429) {
    const wait = input.retryAfterSec ?? 0
    return {
      kind: 'rateLimited',
      message:
        `被 Telegram 限流了（429）${wait > 0 ? `，要求等 ${wait} 秒再试` : ''}。` +
        '这通常是短时间内推得太多，把「推送冷却」调大一些即可。'
    }
  }

  if (input.status === 403) {
    return {
      kind: 'badChat',
      message:
        '机器人没有权限往这个会话发消息（403）。私聊的话，请先在 Telegram 里主动给你的机器人发一条消息' +
        '（哪怕只发一个 /start），机器人才被允许回你；群里的话，请把机器人拉进群。'
    }
  }

  if (input.status === 400) {
    if (desc.includes('chat not found') || desc.includes('chat_id')) {
      return {
        kind: 'badChat',
        message:
          'Chat ID 不对（Telegram 返回 chat not found）。私聊的 id 是正数，群/频道是负数（形如 -1001234567890）。' +
          '可以给 @userinfobot 发条消息拿到自己的数字 id。'
      }
    }
    if (desc.includes("can't parse entities") || desc.includes('parse')) {
      return {
        kind: 'unknown',
        message:
          '消息内容里有 Telegram 解析不了的字符。本工程发送时**不应该**开 parse_mode，' +
          '出现这个提示说明有人给请求加了 parse_mode，请去掉。'
      }
    }
    return {
      kind: 'badChat',
      message: `Telegram 拒绝了这条请求（400）：${input.description ?? '没有给出原因'}。请检查 Chat ID。`
    }
  }

  if (input.status >= 500) {
    return {
      kind: 'serverError',
      message: `Telegram 服务器暂时出错（${input.status}）。稍后会自动重试，不用管。`
    }
  }

  return {
    kind: 'unknown',
    message: `推送失败（HTTP ${input.status}）：${input.description ?? '没有给出原因'}。`
  }
}

/** 这一类失败重试还有意义吗？token/chat 配错了重试一万次也没用，白白拖慢暂停流程。 */
export function isRetriableFailure(kind: NotifyFailureKind): boolean {
  return kind === 'network' || kind === 'timeout' || kind === 'serverError' || kind === 'rateLimited'
}

// ══════════════════════════════════════════════════════════════════════════
// 六、第二层预留：顶号精确识别
// ══════════════════════════════════════════════════════════════════════════

/**
 * ★ 预留的模板 id。**现在模板库里没有这几张图，这是有意的。**
 *
 * 使用方式（这就是「模板缺失自动降级」的全部实现，照抄即可）：
 *
 *   const tpl = templates.get(RESERVED_TEMPLATE.kickedDialog)
 *   if (!tpl) return null            // ← 模板没采集，静默降级到第一层。不报错、不告警、不中止
 *   const m = await matchIn(frame, tpl)
 *   if (m.found) return '疑似被顶号：命中「账号在其他设备登录」提示框'
 *
 * ★ 千万不要把这几个 id 加进 gather/templates.ts 的 CRITICAL_TEMPLATES 或 OPTIONAL_TEMPLATES：
 *   前者会让整个采集模块加载即失败，后者会每次加载都刷一条「缺模板」告警。
 *   `GatherTemplates.get()` 对不存在的 id 返回 undefined，这已经是完美的降级点了。
 *
 * 用户哪天真被顶号、把截图发过来，在「模板库」页裁一张图、id 填成下面这个值，
 * 第二层就自动生效，**代码一行都不用动**。
 */
export const RESERVED_TEMPLATE = {
  /** 「您的账号已在其他设备登录」这类提示框的标题/正文特征区。 */
  kickedDialog: 'tpl_dlg_kicked',
  /** 被踢回去之后的登录界面特征（登录按钮 / 服务器选择）。 */
  loginScreen: 'tpl_login_screen',
  /** 「服务器维护中」公告。命中它可以给出比「需要人工介入」更准的原因。 */
  maintenanceDialog: 'tpl_dlg_maintenance',
  /** 「有新版本，请更新」强制更新弹窗。 */
  updateDialog: 'tpl_dlg_update'
} as const

export type ReservedTemplateId = (typeof RESERVED_TEMPLATE)[keyof typeof RESERVED_TEMPLATE]

/**
 * 第二层检测钩子的签名。
 *
 * 返回 null 表示「没结论」（模板缺失、没命中、或压根没跑）—— 调用方据此走第一层兜底。
 * ★ 实现方**绝不允许**因为模板缺失抛异常。
 */
export type KickedProbe = () => Promise<KickedProbeResult | null>

export interface KickedProbeResult {
  /** 命中之后要产生哪种事件。 */
  type: PausingAlertType
  /** 中文原因，直接进 AlertEvent.reason。 */
  reason: string
  /** 命中的模板 id 与分数，进 AlertEvent.detail。 */
  detail: AlertDetail
}

// ══════════════════════════════════════════════════════════════════════════
// 七、实例暂停态（面板展示契约）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 一个实例的暂停状态。
 *
 * ★ 它是 InstanceQueueState 的**补充**，不是替代 —— 调度状态里的 `auto` 仍然是
 *   「自动调度开没开」的唯一事实来源，暂停只是把 auto 置 false 并在这里记下原因。
 *   面板判断「这个实例被异常暂停了」的条件是：`pause.paused === true`（而不是 `!auto`，
 *   因为用户自己手动关掉 auto 也会让 auto 为 false，那不该标红）。
 */
export interface InstancePauseState {
  instanceIndex: number
  paused: boolean
  /** 触发暂停的事件类型；没暂停为 null。 */
  type: AlertType | null
  severity: AlertSeverity | null
  /** 中文原因，面板红条上直接显示。 */
  reason: string | null
  /** 暂停时刻（绝对毫秒）。面板用 formatCst() 显示成北京时间。 */
  pausedAt: number | null
  /** 现场截图，相对 <dataDir>/shots；没留到为 null。面板走既有的 app:readShot 通道取图。 */
  shotPath: string | null
  /** 该做什么（= ALERT_SPECS[type].advice），面板显示在原因下面。 */
  advice: string | null
  detail?: AlertDetail
  /** 这次暂停有没有成功推送出去；没配推送为 null。 */
  notified: boolean | null
  /** 推送失败的中文原因（★ 已 scrubSecret）；成功或没推为 null。 */
  notifyError: string | null
  /** 触发暂停的那条事件 id，用来在历史里定位。 */
  eventId: string | null
}

export function emptyPauseState(instanceIndex: number): InstancePauseState {
  return {
    instanceIndex,
    paused: false,
    type: null,
    severity: null,
    reason: null,
    pausedAt: null,
    shotPath: null,
    advice: null,
    notified: null,
    notifyError: null,
    eventId: null
  }
}

/** 从一条事件造出暂停态。★ 只有 pausesInstance(type) 为真的事件才该走这里。 */
export function pauseStateFromEvent(
  e: AlertEvent,
  notify: { notified: boolean | null; notifyError: string | null }
): InstancePauseState {
  return {
    instanceIndex: e.instanceIndex,
    paused: true,
    type: e.type,
    severity: e.severity,
    reason: e.reason,
    pausedAt: e.at,
    shotPath: e.shotPath,
    advice: ALERT_SPECS[e.type].advice,
    detail: e.detail,
    notified: notify.notified,
    notifyError: notify.notifyError,
    eventId: e.id
  }
}

// ── 告警历史（面板「最近告警」列表 + 推送成败留痕）─────────────────────────

export interface AlertRecord {
  event: AlertEvent
  /** 各通道的发送结果。没有任何通道时是空数组。 */
  results: NotifyResult[]
  /** 是否被冷却/订阅过滤压掉（压掉时 results 里是 skippedNotifyResult）。 */
  suppressed: boolean
  /** 本次是否真的执行了暂停动作（已经是暂停态时是 false —— 幂等）。 */
  pausedNow: boolean
}

/** 面板最多显示/主进程最多保留多少条历史。 */
export const ALERT_HISTORY_LIMIT = 100

// ══════════════════════════════════════════════════════════════════════════
// 八、IPC 通道
// ══════════════════════════════════════════════════════════════════════════

export const ALERT_CH = {
  /** 读配置（★ 返回的是打码视图，token 不过桥）。 */
  config: 'alerts:config',
  /** 改配置（部分字段）。返回打码视图。 */
  saveConfig: 'alerts:saveConfig',
  /** 「测试推送」按钮：立刻发一条 test 事件，绕过订阅与冷却。 */
  test: 'alerts:test',
  /** 拉全部实例的暂停态。 */
  pauses: 'alerts:pauses',
  /** 手动恢复某个实例（重新打开自动调度并清掉暂停态与该实例的推送冷却）。 */
  resume: 'alerts:resume',
  /** 最近的告警历史。 */
  history: 'alerts:history'
} as const

export type AlertRoutes = {
  'alerts:config': [[], AlertsConfigView]
  'alerts:saveConfig': [[patch: AlertsConfigPatch], AlertsConfigView]
  'alerts:test': [[], NotifyResult]
  'alerts:pauses': [[], InstancePauseState[]]
  'alerts:resume': [[instanceIndex: number], InstancePauseState]
  'alerts:history': [[limit?: number], AlertRecord[]]
}

export type AlertChannel = keyof AlertRoutes
export type AlertArgs<K extends AlertChannel> = AlertRoutes[K][0]
export type AlertResult<K extends AlertChannel> = AlertRoutes[K][1]

export type AlertPushEvents = {
  /** 某个实例的暂停态变了（被暂停 / 被恢复）。面板据此标红或取消标红。 */
  'alerts:pauseChanged': InstancePauseState
  /** 新产生了一条告警（不论是否暂停、是否推送成功）。面板据此更新「最近告警」列表。 */
  'alerts:raised': AlertRecord
  /** 配置被改写（打码视图）。 */
  'alerts:configChanged': AlertsConfigView
}

export type AlertPushChannel = keyof AlertPushEvents

// ── 渲染进程客户端（类型断言全部关在这里，与 scheduler.ts 同一套写法）────────

interface RawBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, cb: (payload: unknown) => void): () => void
}

function bridge(): RawBridge {
  const api = (globalThis as { api?: unknown }).api
  if (!api || typeof (api as RawBridge).invoke !== 'function') {
    throw new Error('window.api 尚未就绪：告警接口只能在渲染进程里调用。')
  }
  return api as RawBridge
}

/**
 * 渲染进程调用告警模块。用法与 window.api.invoke 完全一致。
 *   const view = await callAlerts('alerts:config')
 *   await callAlerts('alerts:resume', 0)
 */
export function callAlerts<K extends AlertChannel>(
  channel: K,
  ...args: AlertArgs<K>
): Promise<AlertResult<K>> {
  return bridge().invoke(channel, ...args) as Promise<AlertResult<K>>
}

/** 订阅告警推送，返回退订函数（useEffect 可以直接 return 它）。 */
export function onAlertEvent<K extends AlertPushChannel>(
  channel: K,
  cb: (payload: AlertPushEvents[K]) => void
): () => void {
  return bridge().on(channel, (p) => cb(p as AlertPushEvents[K]))
}

/**
 * 把主进程/桥抛回来的异常翻译成一句能指向修复方向的中文。
 * 写法与 marchStore.describeSchedulerError 一致（那边处理 scheduler:*，这边处理 alerts:*）。
 */
export function describeAlertError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const stripped = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
  if (/No handler registered|no handler/i.test(stripped)) {
    return '主进程还没有注册告警通道（alerts:*）。异常检测与推送模块接线之后本页会自动可用。'
  }
  return stripped || '未知错误'
}

// ══════════════════════════════════════════════════════════════════════════
// 九、配置镜像位置清单（★ 加字段时**逐条**对一遍，本工程有前科）
// ══════════════════════════════════════════════════════════════════════════
//
// 采集配置当年同时住在三个地方（resources/game-data/gather-config.schema.json、
// src/main/game/gather/config.ts、src/renderer/src/features/gather/config.ts），
// 改一处忘两处，默认值互相打架。**本模块刻意不重复那个结构**：
//
//   唯一权威   src/shared/alerts.ts        ← 就是本文件：类型 + defaultAlertsConfig() + normalizeAlertsConfig()
//   落盘       <dataDir>/alerts.json       ← 只存值，不存默认值；缺字段由 normalize 补
//   主进程     src/main/alerts/store.ts    ← 只能 import defaultAlertsConfig / normalizeAlertsConfig，
//                                             **禁止**再写一份 { enabled:false, cooldownSeconds:600 } 字面量
//   渲染进程   src/renderer/src/features/alerts/alertStore.ts
//                                          ← 同上，表单初值一律来自 defaultAlertsConfig()
//   离线自检   scripts/*.ts                ← 同上
//
// 判定标准很简单：**全工程 grep `cooldownSeconds` 时，出现具体数字 600 的地方只允许有一处**
// （即 defaultAlertsConfig）。多出第二处就是回到老路上了。
//
// 与既有配置的边界：
//   · AppSettings（src/shared/domain.ts）**不动** —— 那是已冻结契约，而且告警配置含凭据，
//     不该跟着 settings.json 到处走（settings 会被推给渲染进程，见 IpcEvents['app:settingsChanged']）。
//   · SchedulerConfig（src/shared/scheduler.ts）**不动** —— 那是 ETA 时间参数，与告警无关。
