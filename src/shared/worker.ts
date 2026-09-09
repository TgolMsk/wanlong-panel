/**
 * utilityProcess（脚本执行器）的通信协议。
 *
 * 三条链路，别搞混：
 *   ① 主进程 -> worker   : child.postMessage(MainToWorker)         —— 编排指令
 *   ② worker -> 主进程   : process.parentPort.postMessage(WorkerToMain) —— 状态回报、落盘请求
 *   ③ worker <-> 渲染进程: MessagePort 直连（WorkerToRenderer / RendererToWorker）
 *                          —— 高频的日志流与预览帧，**完全绕开主进程**，避免把 main 卡死
 *
 * ★ 已实测的两个坑：
 *   1. MessagePort 不能穿 contextBridge（会被克隆成失去方法的代理，renderer 里报
 *      `port.start is not a function`）。preload 只能用 window.postMessage 转发，
 *      renderer 在主世界用 window.addEventListener('message') 接。
 *   2. 大块二进制（预览 jpeg、原始帧）一律用 Transferable ArrayBuffer 转移，不要 base64。
 */

import type { SerializedError } from './errors'
import type { DetectSpec, MatchResult } from './vision'
import type { LogEntry, RunSnapshot, ScriptDef, StartRunRequest } from './script'
import type { AppSettings } from './domain'

/** preload -> renderer 转发 MessagePort 时用的标识。 */
export const WORKER_PORT_CHANNEL = 'wl:worker-port'

/** preload 用 window.postMessage 转发的信封。 */
export interface WorkerPortEnvelope {
  __wlPort: typeof WORKER_PORT_CHANNEL
  runId: string
  instanceIndex: number
}

// ── ① 主进程 -> worker ────────────────────────────────────────────────────

/** worker 启动后收到的第一条消息，附带一个 MessagePortMain（转交给 renderer 的那一端在主进程留着）。 */
export interface WorkerAttachPayload {
  runId: string
  instanceIndex: number
  /** 规范 serial `127.0.0.1:<adbPort>`。 */
  serial: string
  /** 完整脚本定义（worker 不读磁盘找脚本，由主进程喂进来）。 */
  script: ScriptDef
  /** 已合并默认值的参数。 */
  params: Record<string, string | number | boolean>
  request: StartRunRequest
  /** worker 需要的那部分设置（路径、阈值、参考分辨率等）。 */
  settings: AppSettings
  /** 已解析好的绝对路径，worker 直接用，不再自己拼。 */
  paths: {
    adbPath: string
    templatesDir: string
    shotsDir: string
    logsDir: string
  }
  accountId: string | null
  accountName: string | null
}

export type MainToWorker =
  | { type: 'attach'; payload: WorkerAttachPayload }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  /** 优雅停止：跑完当前步骤就退出。 */
  | { type: 'stop' }
  /** 立刻退出（主进程随后还会 kill 兜底）。 */
  | { type: 'shutdown' }
  /** 开关预览推流，省 CPU。 */
  | { type: 'preview'; enabled: boolean }
  /** 不跑脚本、只做一次检测，供模板编辑器「立即验证」使用。 */
  | { type: 'detectOnce'; requestId: string; specs: DetectSpec[] }

// ── ② worker -> 主进程 ────────────────────────────────────────────────────

export type WorkerToMain =
  /** worker 已加载完 opencv/sharp，可以接 attach 了。 */
  | { type: 'ready'; pid: number; initMs: number }
  | { type: 'attached'; runId: string }
  | { type: 'status'; snapshot: RunSnapshot }
  /** 请求主进程把这批日志落盘（worker 不直接写文件，避免多进程抢同一个文件句柄）。 */
  | { type: 'persistLogs'; runId: string; entries: LogEntry[] }
  /** 请求主进程保存一张留痕截图。jpeg 为 Transferable。 */
  | {
      type: 'persistShot'
      runId: string
      /** 相对 shots/<runId>/ 的文件名。 */
      file: string
      jpeg: ArrayBuffer
    }
  | { type: 'detectResult'; requestId: string; results: MatchResult[] }
  | { type: 'finished'; snapshot: RunSnapshot }
  | { type: 'error'; error: SerializedError }

// ── ③ worker <-> 渲染进程（MessagePort 直连）──────────────────────────────

export type WorkerToRenderer =
  /** 批量日志。worker 侧每 LOG_FLUSH_INTERVAL_MS 合并一批，不要每行一次 postMessage。 */
  | { type: 'logs'; runId: string; entries: LogEntry[] }
  /** 预览帧。jpeg 是 Transferable ArrayBuffer，零拷贝。 */
  | {
      type: 'frame'
      runId: string
      jpeg: ArrayBuffer
      /** jpeg 自身的宽高。 */
      width: number
      height: number
      /** 设备真实分辨率，画标注框时要用它换算。 */
      deviceWidth: number
      deviceHeight: number
      capturedAt: number
    }
  | { type: 'status'; snapshot: RunSnapshot }
  /** 调试用：把本 tick 的匹配结果推给面板画框。 */
  | { type: 'matches'; runId: string; results: MatchResult[] }
  | { type: 'closed'; runId: string; reason: string }

export type RendererToWorker =
  | { type: 'preview'; enabled: boolean }
  /** 调整推流帧率上限，面板最小化时可以调低。 */
  | { type: 'previewFps'; fps: number }
  | { type: 'debugMatches'; enabled: boolean }
