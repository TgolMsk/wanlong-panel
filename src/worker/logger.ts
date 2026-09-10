/**
 * 执行日志的批量缓冲（跑在 utilityProcess 里）。
 *
 * 两条硬约束：
 *  1. **不要每行一次 postMessage**。一次 tick 可能产生十几条日志，逐条发会把 MessagePort
 *     和主进程的事件循环打满。这里每 LOG_FLUSH_INTERVAL_MS(100ms) 合并成一批。
 *  2. **worker 不直接写文件**。多个 utilityProcess 抢同一个文件句柄会写出交错的半截行，
 *     所以落盘请求通过 WorkerToMain('persistLogs') 交给主进程。
 *
 * 同一批日志同时发两路：emit -> 渲染进程（实时显示），report -> 主进程（落盘）。
 */

import { LOG_FLUSH_INTERVAL_MS } from '@shared/constants'
import type { LogEntry, LogLevel } from '@shared/script'
import type { WorkerToMain, WorkerToRenderer } from '@shared/worker'

/** 调用方只需给这些字段，ts / runId / instanceIndex 由 logger 补齐。 */
export interface LogInput {
  level: LogLevel
  /** 产生日志的模块：'engine' | 'step' | 'vision' | 'adb' | 'runner' … */
  scope: string
  message: string
  stepId?: string
  data?: Record<string, unknown>
  /** 关联的留痕截图相对路径。 */
  shot?: string
  /** 覆盖时间戳，一般不用传。 */
  ts?: number
}

/**
 * 缓冲上限。正常情况下 100ms 一批，攒不到这个量；
 * 一旦端口卡死或脚本疯狂刷日志，超出部分丢弃并留一条 warn，绝不无限吃内存。
 */
const MAX_BUFFER = 4000

export class RunLogger {
  private buf: LogEntry[] = []
  private timer: NodeJS.Timeout | null = null
  private dropped = 0
  private closed = false

  constructor(
    private readonly runId: string,
    private readonly instanceIndex: number,
    private readonly emit: (m: WorkerToRenderer) => void,
    private readonly report: (m: WorkerToMain) => void,
    private readonly flushMs: number = LOG_FLUSH_INTERVAL_MS
  ) {}

  push(input: LogInput): void {
    if (this.closed) return

    if (this.buf.length >= MAX_BUFFER) {
      this.dropped += 1
      return
    }

    const entry: LogEntry = {
      ts: input.ts ?? Date.now(),
      level: input.level,
      runId: this.runId,
      instanceIndex: this.instanceIndex,
      scope: input.scope,
      message: input.message
    }
    if (input.stepId !== undefined) entry.stepId = input.stepId
    if (input.data !== undefined) entry.data = input.data
    if (input.shot !== undefined) entry.shot = input.shot
    this.buf.push(entry)

    // warn/error 同时打到 stdout：utilityProcess 的输出默认 inherit 到主进程终端，
    // 面板还没起来（或端口已断）时这是唯一能看到问题的地方。
    if (input.level === 'error' || input.level === 'warn') {
      const tag = `[run ${this.runId}#${this.instanceIndex}]`
      const line = `${tag} ${input.stepId ? `(${input.stepId}) ` : ''}${input.message}`
      if (input.level === 'error') console.error(line)
      else console.warn(line)
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.flushMs)
      // 别让这个定时器把进程吊住：该退出的时候就该退出。
      this.timer.unref?.()
    }
  }

  /** 立刻把缓冲里的日志发出去。步骤失败、执行结束、退出前都应该主动调一次。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.dropped > 0) {
      const n = this.dropped
      this.dropped = 0
      this.buf.push({
        ts: Date.now(),
        level: 'warn',
        runId: this.runId,
        instanceIndex: this.instanceIndex,
        scope: 'logger',
        message: `日志产生速度超过发送速度，已丢弃 ${n} 条。请降低脚本的日志密度。`
      })
    }
    if (this.buf.length === 0) return

    const entries = this.buf
    this.buf = []

    // 两路互不影响：面板关了不该导致日志不落盘，反之亦然。
    try {
      this.emit({ type: 'logs', runId: this.runId, entries })
    } catch {
      // 端口已关闭，忽略。
    }
    try {
      this.report({ type: 'persistLogs', runId: this.runId, entries })
    } catch (e) {
      console.error(`[run ${this.runId}] 日志落盘请求发送失败：${String(e)}`)
    }
  }

  /** 关闭前最后一次 flush；之后 push 变成空操作。 */
  dispose(): void {
    this.flush()
    this.closed = true
  }
}
