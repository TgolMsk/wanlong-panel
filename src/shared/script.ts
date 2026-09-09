/**
 * 脚本 DSL 与执行模型。
 *
 * 设计原则：
 *  1. 脚本是**纯数据**（可 JSON 序列化），不是代码。这样面板能可视化编辑、能存盘、能跨实例复用。
 *  2. 一切坐标在**参考分辨率**空间（见 vision.ts）。
 *  3. 脚本不认识 adb/mumu，只认识「条件」和「动作」，由执行器（src/worker/engine.ts）翻译成实际调用。
 *  4. 游戏未装好之前，这套 DSL 只需覆盖通用能力；具体游戏逻辑靠往 templates + steps 里填内容实现，
 *     不要为某个游戏往 DSL 里加特化 step。
 */

import type { Point, Rect } from './vision'

// ── 条件 ─────────────────────────────────────────────────────────────────

export type Condition =
  | { kind: 'always' }
  | { kind: 'never' }
  /** 模板是否出现。present 默认 true；false 表示「不存在」。 */
  | {
      kind: 'template'
      templateId: string
      roi?: Rect
      threshold?: number
      present?: boolean
    }
  /** 任意一个模板出现（用于「多种弹窗任选其一」）。命中的模板 id 会写进步骤上下文。 */
  | { kind: 'anyTemplate'; templateIds: string[]; roi?: Rect; threshold?: number }
  /** 当前前台应用包名。 */
  | { kind: 'foreground'; packageName: string; equals?: boolean }
  | { kind: 'and'; all: Condition[] }
  | { kind: 'or'; any: Condition[] }
  | { kind: 'not'; of: Condition }

// ── 步骤 ─────────────────────────────────────────────────────────────────

/** 步骤失败后的处置策略。 */
export type FailPolicy =
  /** 中止整个执行（默认）。 */
  | { kind: 'abort' }
  /** 忽略，继续下一步。 */
  | { kind: 'continue' }
  /** 跳到某个 label。 */
  | { kind: 'goto'; label: string }
  /** 冷启动应用后跳回脚本开头，用于「卡界面了就重开」。 */
  | { kind: 'restartApp' }

export type AndroidKey =
  | 'BACK'
  | 'HOME'
  | 'ENTER'
  | 'MENU'
  | 'APP_SWITCH'
  | 'DEL'
  | 'ESCAPE'
  | 'VOLUME_UP'
  | 'VOLUME_DOWN'

export interface StepBase {
  /** 脚本内唯一，日志与留痕按它归档。 */
  id: string
  /** 中文步骤名，显示在日志和面板上。 */
  name?: string
  /** 只有条件成立才执行本步；不成立则跳过（不算失败）。 */
  when?: Condition
  /** 本步整体超时。 */
  timeoutMs?: number
  /** 失败后重试次数（不含首次）。 */
  retry?: number
  /** 两次重试之间的间隔。 */
  retryDelayMs?: number
  /** 重试耗尽后的处置。默认 { kind: 'abort' }。 */
  onFail?: FailPolicy
  /** 执行完后固定等待，给 UI 动画留时间。 */
  afterDelayMs?: number
  /** 是否为这一步强制留一张截图（覆盖全局 shotPolicy）。 */
  capture?: boolean
}

export type ScriptStep =
  /** 点击固定坐标（参考分辨率）。 */
  | (StepBase & { kind: 'tap'; at: Point })
  /** 找到模板再点它（最常用）。找不到即为失败。 */
  | (StepBase & {
      kind: 'tapTemplate'
      templateId: string
      roi?: Rect
      threshold?: number
      /** 相对匹配中心的偏移（参考分辨率像素）。 */
      offset?: Point
      /** 找不到时先等多久再放弃。0 表示只看一帧。 */
      waitMs?: number
      /** 轮询间隔。 */
      pollMs?: number
    })
  /** 等待条件成立。超时即为失败。 */
  | (StepBase & { kind: 'waitFor'; cond: Condition; waitMs: number; pollMs?: number })
  /** 滑动。注意 input swipe 是全程阻塞的（耗时 ≈ duration + 30ms）。 */
  | (StepBase & { kind: 'swipe'; from: Point; to: Point; durationMs?: number })
  /**
   * 长按。★ 不要用 swipe 实现长按（会全程占住队列），
   * 执行器必须发 `input motionevent DOWN; sleep; input motionevent UP` 到**同一次** adb shell。
   */
  | (StepBase & { kind: 'longPress'; at: Point; durationMs: number })
  /** 输入文本。★ 中文必须走 ADBKeyboard 的 base64 broadcast，`input text` 会静默丢弃非 ASCII。 */
  | (StepBase & { kind: 'text'; text: string })
  | (StepBase & { kind: 'key'; key: AndroidKey })
  | (StepBase & { kind: 'sleep'; ms: number })
  /** 启动应用。cold=true 时先 force-stop 保证全新进程。 */
  | (StepBase & { kind: 'launchApp'; packageName?: string; cold?: boolean })
  | (StepBase & { kind: 'stopApp'; packageName?: string })
  /** 主动留痕一张截图。 */
  | (StepBase & { kind: 'screenshot'; label?: string })
  | (StepBase & { kind: 'log'; level: LogLevel; message: string })
  /** goto 的落点，本身是空操作。 */
  | (StepBase & { kind: 'label'; label: string })
  /** 无条件跳转。maxTimes 防死循环，超出即整个执行失败。 */
  | (StepBase & { kind: 'goto'; label: string; maxTimes?: number })
  /** 条件分支。 */
  | (StepBase & { kind: 'if'; cond: Condition; then: ScriptStep[]; else?: ScriptStep[] })
  /** 循环。repeat 与 while 至少给一个；两个都给时以先满足的为准。 */
  | (StepBase & {
      kind: 'loop'
      steps: ScriptStep[]
      repeat?: number
      while?: Condition
      /** 硬上限，防死循环。默认 1000。 */
      maxIterations?: number
    })

export type StepKind = ScriptStep['kind']

// ── 脚本定义 ──────────────────────────────────────────────────────────────

export interface ScriptParamDef {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'enum'
  /** type='enum' 时的候选。 */
  options?: { value: string; label: string }[]
  default?: string | number | boolean
  note?: string
}

export interface ScriptDef {
  id: string
  name: string
  description?: string
  /** 语义化版本，改了步骤就要涨，方便排查「昨天还能跑」。 */
  version: string
  /** 目标游戏包名。启动前执行器会确保它在前台。 */
  packageName?: string
  /** 依赖的模板集 id。 */
  templateSetId?: string
  /** 脚本作者坐标所处的参考分辨率。与全局设置不一致时执行器负责换算。 */
  refWidth: number
  refHeight: number
  params?: ScriptParamDef[]
  steps: ScriptStep[]
  /** 走完 steps 后是否从头再来（挂机脚本用）。 */
  loop?: boolean
  /** loop 模式下每轮之间的间隔。 */
  loopIntervalMs?: number
  updatedAt: number
}

/** 面板列表用的轻量元信息，不含 steps。 */
export interface ScriptMeta {
  id: string
  name: string
  description?: string
  version: string
  packageName?: string
  templateSetId?: string
  stepCount: number
  updatedAt: number
  /** 是否内置（随包分发，不可删）。 */
  builtin: boolean
}

export interface ValidationIssue {
  level: 'error' | 'warn'
  /** 出问题的步骤 id；脚本级问题为 null。 */
  stepId: string | null
  /** 中文说明。 */
  message: string
}

// ── 执行 ─────────────────────────────────────────────────────────────────

export type RunStatus =
  | 'pending'
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'aborted'

export interface StartRunRequest {
  scriptId: string
  /** 目标实例 index。 */
  instanceIndex: number
  /** 绑定的账号 id，用于日志归档和参数取值。 */
  accountId?: string
  /** 覆盖脚本参数。 */
  params?: Record<string, string | number | boolean>
  /** 覆盖本次执行的截图留痕策略。 */
  shotPolicy?: 'never' | 'onFail' | 'always'
}

export interface RunHandle {
  runId: string
  instanceIndex: number
  scriptId: string
}

/** 一次执行的完整快照，面板列表和详情都用它。 */
export interface RunSnapshot {
  runId: string
  scriptId: string
  scriptName: string
  instanceIndex: number
  serial: string | null
  accountId: string | null
  accountName: string | null
  status: RunStatus
  startedAt: number
  endedAt: number | null
  /** 已完成的步骤数 / 顶层步骤总数。loop 模式下 total 为 null。 */
  stepDone: number
  stepTotal: number | null
  /** 当前正在执行的步骤。 */
  currentStepId: string | null
  currentStepName: string | null
  /** loop 模式下的轮次。 */
  iteration: number
  /** 失败时的错误说明（中文）。 */
  error: string | null
  /** 累计计数，面板显示健康度。 */
  stats: RunStats
}

export interface RunStats {
  captures: number
  matches: number
  matchHits: number
  taps: number
  retries: number
  /** 最近一次完整 tick 的耗时，用于观察是否被 screencap 拖慢。 */
  lastTickMs: number
  avgCaptureMs: number
}

// ── 日志 ─────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 一条日志。落盘为 ndjson（每行一个 LogEntry）。 */
export interface LogEntry {
  ts: number
  level: LogLevel
  /** 归属执行；面板级日志为 null。 */
  runId: string | null
  instanceIndex: number | null
  /** 产生日志的模块，例如 'adb' | 'mumu' | 'vision' | 'engine' | 'main'。 */
  scope: string
  stepId?: string
  message: string
  /** 结构化附加信息，必须可 JSON 序列化。 */
  data?: Record<string, unknown>
  /** 关联的留痕截图相对路径（相对 shots 目录）。 */
  shot?: string
}

/** 读取历史日志的过滤条件。 */
export interface LogQuery {
  runId?: string
  instanceIndex?: number
  minLevel?: LogLevel
  /** 只要这个时间戳之后的。 */
  since?: number
  limit?: number
}
