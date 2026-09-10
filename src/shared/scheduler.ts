/**
 * ETA 调度与队列状态的公共契约（主进程 ⇄ 渲染进程）。
 *
 * ★ 本文件是**新增**的，一个字都没有改动 ipc.ts 里已冻结的 52 条通道与 6 条推送。
 *   调度器自带一小组通道（见 SCHED_CH），走的是同一条 Electron IPC 桥，
 *   只是没有登记进 IpcRoutes —— 因为 IpcRoutes 已冻结，不属于本模块可以改的范围。
 *   渲染进程请用本文件底部的 callScheduler / onSchedulerEvent，它们把必要的类型
 *   断言全部关在这里，调用方仍然是**完全类型安全**的。
 *   后续若契约层解冻，把 SchedulerRoutes / SchedulerEvents 并进 IpcRoutes / IpcEvents
 *   即可，届时这两个客户端函数可以整体删掉，调用点无需改动。
 *
 * 核心时间模型（全部是**绝对时刻**，毫秒。绝不存相对值，否则面板重启即失效）：
 *
 *   sampledAt        本次读面板的时刻
 *   remainingMs      面板上读到的倒计时
 *   gatherDoneAt     采集完成时刻 = sampledAt + remainingMs（状态=采集中时）
 *   travelTimeMs     单程行军耗时（派兵时从「创建部队」页行军按钮直接读到）
 *   freeAt           队列真正释放、可派下一轮的时刻 = gatherDoneAt + travelTimeMs
 *
 * 调度定时器挂在 `freeAt + slackSeconds` 上（**宁晚勿早**），不是 gatherDoneAt。
 * UI 侧按本地时钟递推显示，零 adb 开销；只有到点唤醒与周期校准才真的去动模拟器。
 */

// ── 队伍状态 ──────────────────────────────────────────────────────────────

/**
 * 面板里读到的队伍状态。
 * 取值来自真机实测的状态词模板；未来补采「驻扎中/集结中/战斗中」时在这里加。
 */
export type MarchStatus =
  /** 采集中（白字压在载重进度条上，倒计时是「采集剩余」） */
  | 'gathering'
  /** 采集行军中 —— 去程。实测状态词是 5 个字，不是「行军中」 */
  | 'gatherMarching'
  /** 返回中 —— 采集完成或被召回后回城，倒计时归零即释放队列 */
  | 'returning'
  /** 行没有内容，队列空位 */
  | 'idle'
  /** 行有内容但状态词没认出来（模板未采集 / 遮挡）。按兜底 ETA 处理，绝不猜 */
  | 'unknown'

/** 状态词的中文显示名。面板直接用它，不要在渲染层再写一份。 */
export const MARCH_STATUS_TEXT: Record<MarchStatus, string> = {
  gathering: '采集中',
  gatherMarching: '采集行军中',
  returning: '返回中',
  idle: '空闲',
  unknown: '未知状态'
}

/** travelTime 的来源，决定 freeAt 有多可信。 */
export type TravelTimeSource =
  /** 没有这支队的派兵记录（手动派出的，或记录已丢失）：只能按配置兜底值估 */
  | 'unrecorded'
  /** 派兵时从「创建部队」页行军按钮上直接读到的，最可信 */
  | 'dispatch'
  /** 由「采集行军中」倒计时观察反推 */
  | 'observed'
  /** 谁都没给，用配置里的兜底值 */
  | 'fallback'

/** 指挥官耐力。读不出时两项都是 null，**绝不填猜测值**。 */
export interface StaminaValue {
  current: number | null
  max: number | null
}

/** 采集资源类型（与 gather/config.ts 的 GatherResourceType 同值；放在契约层供面板/调度器共用）。 */
export type MarchResourceType = 'wood' | 'gold' | 'iron' | 'mana'

/** 一支队伍（部队管理面板里的一行）。 */
export interface MarchState {
  /** 面板中的行序，1 起。 */
  slot: number
  status: MarchStatus
  /** 状态词原文（识别到什么就是什么，便于排查）。 */
  statusText: string
  /** 目标坐标，如 "615,535"。读不出为 null。 */
  targetCoord: string | null
  /** 兵力，如 31500。读不出为 null。 */
  troopCount: number | null
  /** 本行两名指挥官的耐力（读不出的位置是 {null,null}）。 */
  commanders: StaminaValue[]

  /** 本次采样读到的倒计时（毫秒）。读不出为 null。 */
  remainingMs: number | null
  /** 本行倒计时归零的绝对时刻 = sampledAt + remainingMs。 */
  timerEndsAt: number | null
  /** 采集完成的绝对时刻。状态不是「采集中」时可能为 null。 */
  gatherDoneAt: number | null
  /** ★ 队列真正释放的绝对时刻。调度定时器就挂在它上面。 */
  freeAt: number | null
  /** 单程行军耗时（毫秒）。 */
  travelTimeMs: number | null
  travelTimeSource: TravelTimeSource
  /**
   * 这支队在采什么。来源：① 采集中的行按左侧资源点缩略图识别（tpl_row_res_*）；
   * ② 行军中/返回中的行缩略图是部队图，只能靠派兵记账按坐标对上。都没有 = null（面板显示「?」）。
   */
  resourceType?: MarchResourceType | null

  sampledAt: number
  /** 识别不确定 / 数据缺失时的中文说明，面板标黄用。 */
  warning?: string
}

/** UI 展示用的派生视图。纯函数算出来，不产生任何 adb 开销。 */
export type MarchPhase =
  /** 去资源点的路上 */
  | 'marching'
  /** 正在采集 */
  | 'gathering'
  /** 回城路上 */
  | 'returning'
  /** 按本地递推应该已经空了，等下一次校验 */
  | 'due'
  | 'idle'
  | 'unknown'

export interface MarchView {
  phase: MarchPhase
  /** 中文阶段名。 */
  phaseText: string
  /** 当前阶段的剩余毫秒（不可用为 null）。 */
  remainingMs: number | null
  /** 距队列释放还有多久（不可用为 null）。 */
  untilFreeMs: number | null
  /** 0..1，仅在能算出总时长时有值，用来画进度条。 */
  progress: number | null
}

// ── 每个实例的队列状态 ────────────────────────────────────────────────────

export interface InstanceQueueState {
  instanceIndex: number
  /** 绑定的账号 id，没有为 null。 */
  accountId: string | null
  /** 面板右上的 N（已用行军队列）。读不出为 null。 */
  queueUsed: number | null
  /** 面板右上的 M（队列上限）。读不出为 null。 */
  queueTotal: number | null
  marches: MarchState[]
  /** 上次成功采样的时刻；从没采过为 0。 */
  lastSampledAt: number
  /** 上次采样是否成功。 */
  lastSampleOk: boolean
  /** 最近一次失败的中文原因；正常为 null。 */
  error: string | null
  /** 采样过程中的中文告警（识别不确定、行数对不上等），每次采样覆盖。 */
  warnings: string[]

  /** 是否开启了 ETA 自动调度。 */
  auto: boolean
  /** 当前正在采样（面板可以显示转圈并禁用手动采样按钮）。 */
  sampling: boolean
  /** 下一次唤醒的绝对时刻；没有排期为 null。 */
  nextWakeAt: number | null
  /** 下一次唤醒的中文理由，如「队列释放校验」「周期校准」「退避重试 60s」。 */
  nextWakeReason: string | null
  /** 连续退避次数，0 表示没在退避。 */
  backoffStep: number
}

// ── 调度配置 ──────────────────────────────────────────────────────────────

export interface SchedulerConfig {
  /** 唤醒时刻 = freeAt + slackSeconds。宁晚勿早，默认 60s。 */
  slackSeconds: number
  /** 唤醒后队列仍未空时的退避阶梯（秒）。 */
  retryBackoffSeconds: number[]
  /** 退避封顶（秒）。 */
  maxBackoffSeconds: number
  /** 周期校准间隔（分钟）。 */
  calibrateIntervalMin: number
  /**
   * 健康探针间隔（分钟），0 = 关闭。
   * 只截一帧、不开面板：跑顶号探针 + 看游戏进程还在不在。
   * 用来给「顶号 / 掉线」的检测延迟设一个上限 —— 否则队列满着的时候，
   * 下一次采样可能要等几小时后的队列释放唤醒，顶号了也没人发现。
   */
  healthProbeIntervalMin: number
  /** 每次唤醒附加的随机抖动上限（秒），多实例错峰用。 */
  jitterSeconds: number
  /** 没拿到 travelTime 时的单程兜底估计（秒）。回程约 1 分钟量级，默认给 90s。 */
  defaultTravelSeconds: number
  /** 状态词或倒计时读不出时的兜底 ETA（秒）。 */
  unknownEtaFallbackSeconds: number
  /** 两次采样之间的最小间隔（毫秒），防止手抖连点把模拟器打爆。 */
  minSampleIntervalMs: number
  /** 单次采样总超时（毫秒）。单张截图实测 750ms，一次采样十几张。 */
  sampleTimeoutMs: number
  /** 采样完成后是否关闭面板（默认 true，读完即关，不常驻）。 */
  closePanelAfterSample: boolean
  /** 最多扫描几行（= 队列上限）。 */
  maxRows: number
  /** 是否读取坐标/兵力/耐力这些非必需字段（关掉能省一半识别时间）。 */
  readOptionalFields: boolean
  /** 使用哪个模板集；留空则按包名自动挑「万龙觉醒」那一套。 */
  templateSetId: string
}

export function defaultSchedulerConfig(): SchedulerConfig {
  return {
    slackSeconds: 60,
    retryBackoffSeconds: [30, 60, 120, 240, 300],
    maxBackoffSeconds: 300,
    calibrateIntervalMin: 15,
    healthProbeIntervalMin: 3,
    jitterSeconds: 20,
    defaultTravelSeconds: 90,
    unknownEtaFallbackSeconds: 300,
    minSampleIntervalMs: 8000,
    sampleTimeoutMs: 60000,
    closePanelAfterSample: true,
    maxRows: 5,
    readOptionalFields: true,
    templateSetId: ''
  }
}

/** 一条已排定的唤醒任务（面板的「调度」页用它列出待办）。 */
export interface WakeInfo {
  instanceIndex: number
  dueAt: number
  reason: string
  backoffStep: number
}

// ── 通道 ─────────────────────────────────────────────────────────────────

export const SCHED_CH = {
  /** 拉取全部实例的队列状态。 */
  state: 'scheduler:state',
  /** 立刻对某个实例采样一次（面板上的「刷新」按钮）。 */
  sample: 'scheduler:sample',
  /** 开/关某个实例的 ETA 自动调度。 */
  setAuto: 'scheduler:setAuto',
  /** 读调度配置。 */
  config: 'scheduler:config',
  /** 改调度配置（部分字段）。 */
  saveConfig: 'scheduler:saveConfig',
  /** 列出已排定的唤醒任务。 */
  wakes: 'scheduler:wakes',
  /** 取消某个实例的唤醒排期。 */
  cancelWake: 'scheduler:cancelWake',
  /** 忘掉某个实例的全部记账（面板「重置」用）。 */
  forget: 'scheduler:forget'
} as const

export type SchedulerRoutes = {
  'scheduler:state': [[], InstanceQueueState[]]
  'scheduler:sample': [[instanceIndex: number], InstanceQueueState]
  'scheduler:setAuto': [[instanceIndex: number, enabled: boolean], InstanceQueueState]
  'scheduler:config': [[], SchedulerConfig]
  'scheduler:saveConfig': [[patch: Partial<SchedulerConfig>], SchedulerConfig]
  'scheduler:wakes': [[], WakeInfo[]]
  'scheduler:cancelWake': [[instanceIndex: number], void]
  'scheduler:forget': [[instanceIndex: number], void]
}

export type SchedulerChannel = keyof SchedulerRoutes
export type SchedulerArgs<K extends SchedulerChannel> = SchedulerRoutes[K][0]
export type SchedulerResult<K extends SchedulerChannel> = SchedulerRoutes[K][1]

export type SchedulerEvents = {
  /** 某个实例的队列状态变了（采样完成、开关自动、排期变化）。 */
  'scheduler:changed': InstanceQueueState
  /** 调度配置被改写。 */
  'scheduler:configChanged': SchedulerConfig
}

export type SchedulerEventChannel = keyof SchedulerEvents

// ── 纯函数：本地递推（主进程与渲染进程共用同一份，避免两边算出不同的秒数）─────

/** 按当前时刻把一支队伍换算成 UI 视图。不做任何 IO。 */
export function deriveMarchView(m: MarchState, now: number = Date.now()): MarchView {
  if (m.status === 'idle') {
    return { phase: 'idle', phaseText: '空闲', remainingMs: null, untilFreeMs: null, progress: null }
  }

  const untilFree = m.freeAt == null ? null : Math.max(0, m.freeAt - now)

  // 去程：倒计时归零后进入采集，但采集时长面板没给，只能等下一次校准。
  if (m.status === 'gatherMarching') {
    const left = m.timerEndsAt == null ? null : Math.max(0, m.timerEndsAt - now)
    if (left != null && left > 0) {
      return {
        phase: 'marching',
        phaseText: '采集行军中',
        remainingMs: left,
        untilFreeMs: untilFree,
        progress: ratio(m.timerEndsAt, m.sampledAt, now)
      }
    }
    // 已经到点了，但采集时长未知 —— 只能标成待校验，绝不编一个倒计时出来。
    return {
      phase: 'due',
      phaseText: '已抵达，待校准',
      remainingMs: null,
      untilFreeMs: untilFree,
      progress: null
    }
  }

  if (m.status === 'returning') {
    if (untilFree != null && untilFree > 0) {
      return {
        phase: 'returning',
        phaseText: '返回中',
        remainingMs: untilFree,
        untilFreeMs: untilFree,
        progress: ratio(m.freeAt, m.sampledAt, now)
      }
    }
    return { phase: 'due', phaseText: '应已归队', remainingMs: 0, untilFreeMs: 0, progress: 1 }
  }

  if (m.status === 'gathering') {
    if (m.gatherDoneAt != null && now < m.gatherDoneAt) {
      return {
        phase: 'gathering',
        phaseText: '采集中',
        remainingMs: m.gatherDoneAt - now,
        untilFreeMs: untilFree,
        progress: ratio(m.gatherDoneAt, m.sampledAt, now)
      }
    }
    // 采集已完成 -> 本地直接切成「返回中」，不需要再开面板采样。
    if (m.freeAt != null && now < m.freeAt) {
      return {
        phase: 'returning',
        phaseText: '返回中',
        remainingMs: m.freeAt - now,
        untilFreeMs: untilFree,
        progress: ratio(m.freeAt, m.gatherDoneAt ?? m.sampledAt, now)
      }
    }
    return { phase: 'due', phaseText: '应已归队', remainingMs: 0, untilFreeMs: 0, progress: 1 }
  }

  // unknown
  return {
    phase: 'unknown',
    phaseText: m.statusText || '未知状态',
    remainingMs: untilFree,
    untilFreeMs: untilFree,
    progress: null
  }
}

function ratio(endAt: number | null, startAt: number | null, now: number): number | null {
  if (endAt == null || startAt == null || endAt <= startAt) return null
  const p = (now - startAt) / (endAt - startAt)
  return Math.min(1, Math.max(0, p))
}

/** 毫秒 -> HH:MM:SS（超过一天按天+时分秒）。面板倒计时统一用它，保证两处显示一致。 */
export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '--:--:--'
  const total = Math.max(0, Math.round(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const hh = String(h).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return d > 0 ? `${d}天 ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`
}

/** 这个实例现在还有几个空队列位？读不出返回 null（**不要当成 0 或无限**）。 */
export function freeQueueSlots(s: InstanceQueueState): number | null {
  if (s.queueUsed == null || s.queueTotal == null) return null
  return Math.max(0, s.queueTotal - s.queueUsed)
}

/** 全部队伍里最早释放的时刻；一个都没有返回 null。 */
export function earliestFreeAt(s: InstanceQueueState): number | null {
  let best: number | null = null
  for (const m of s.marches) {
    if (m.status === 'idle' || m.freeAt == null) continue
    if (best == null || m.freeAt < best) best = m.freeAt
  }
  return best
}

// ── 渲染进程客户端（类型断言全部关在这里）────────────────────────────────

interface RawBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, cb: (payload: unknown) => void): () => void
}

function bridge(): RawBridge {
  const api = (globalThis as { api?: unknown }).api
  if (!api || typeof (api as RawBridge).invoke !== 'function') {
    throw new Error('window.api 尚未就绪：调度器接口只能在渲染进程里调用。')
  }
  return api as RawBridge
}

/**
 * 渲染进程调用调度器。用法与 window.api.invoke 完全一致，只是通道表换成 SchedulerRoutes。
 *   const list = await callScheduler('scheduler:state')
 *   await callScheduler('scheduler:setAuto', 0, true)
 */
export function callScheduler<K extends SchedulerChannel>(
  channel: K,
  ...args: SchedulerArgs<K>
): Promise<SchedulerResult<K>> {
  return bridge().invoke(channel, ...args) as Promise<SchedulerResult<K>>
}

/** 订阅调度器推送，返回退订函数（useEffect 可以直接 return 它）。 */
export function onSchedulerEvent<K extends SchedulerEventChannel>(
  channel: K,
  cb: (payload: SchedulerEvents[K]) => void
): () => void {
  return bridge().on(channel, (p) => cb(p as SchedulerEvents[K]))
}
