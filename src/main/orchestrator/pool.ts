/**
 * 单个执行器进程（utilityProcess）的封装。
 *
 * 为什么是 utilityProcess 而不是 worker_threads：
 *  · 脚本跑飞只炸一个账号，不影响别的实例；
 *  · 能被 kill() 硬停（跑飞的 worker thread 停不干净）；
 *  · opencv 的 WASM 堆各自独立；
 *  · MessagePortMain 转交渲染进程是它的一等公民能力（日志/预览直连，不经主进程中转）。
 *
 * 本文件只管一个进程的生老病死，多实例的调度在 index.ts。
 */

import { MessageChannelMain, utilityProcess } from 'electron'
import type { BrowserWindow, UtilityProcess } from 'electron'
import { WORKER_PORT_CHANNEL } from '@shared/worker'
import { AppError } from '@shared/errors'
import type { MainToWorker, WorkerAttachPayload, WorkerToMain } from '@shared/worker'

/** 等 worker 完成 opencv 预热并回 ready 的上限。冷启动实测约 1.1s，给足余量。 */
export const READY_TIMEOUT_MS = 30_000
/** 等 attach 回执的上限（要加载并编译模板集）。 */
export const ATTACH_TIMEOUT_MS = 30_000
/** 优雅停止的等待上限，超时就 kill。 */
export const STOP_GRACE_MS = 10_000
/** 保留多少行 stderr 用于报错时的诊断。 */
const STDERR_TAIL_LINES = 40

type MessageOf<T extends WorkerToMain['type']> = Extract<WorkerToMain, { type: T }>

interface Waiter {
  type: WorkerToMain['type']
  resolve: (m: WorkerToMain) => void
  reject: (e: unknown) => void
  timer: NodeJS.Timeout
}

export interface RunWorkerOptions {
  runId: string
  instanceIndex: number
  /** out/main/runner.js 的绝对路径。 */
  runnerPath: string
  /** 收到 worker 主动上报的消息（status / persistLogs / persistShot / finished / error）。 */
  onMessage: (m: WorkerToMain) => void
  /** 进程退出（不管是正常退出还是崩溃）。 */
  onExit: (code: number) => void
}

export class RunWorker {
  readonly runId: string
  readonly instanceIndex: number

  private readonly child: UtilityProcess
  private readonly opts: RunWorkerOptions
  private readonly waiters: Waiter[] = []
  private readonly stderrTail: string[] = []
  private exited = false
  private killTimer: NodeJS.Timeout | null = null

  constructor(opts: RunWorkerOptions) {
    this.opts = opts
    this.runId = opts.runId
    this.instanceIndex = opts.instanceIndex

    this.child = utilityProcess.fork(opts.runnerPath, [], {
      // 面板的活动监视器里能直接看出是哪个实例的执行器。
      serviceName: `wl-runner-${opts.instanceIndex}`,
      // stdout 继承（方便开发时直接看 console），stderr 单独收一份用于报错诊断。
      stdio: ['ignore', 'inherit', 'pipe']
    })

    this.child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk)
      process.stderr.write(`[runner ${opts.instanceIndex}] ${text}`)
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        this.stderrTail.push(line)
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
      }
    })

    this.child.on('message', (m: WorkerToMain) => {
      this.settleWaiters(m)
      try {
        this.opts.onMessage(m)
      } catch (e) {
        console.error(`[orchestrator] 处理执行器消息失败：${String(e)}`)
      }
    })

    this.child.on('exit', (code: number) => {
      this.exited = true
      if (this.killTimer) {
        clearTimeout(this.killTimer)
        this.killTimer = null
      }
      const err = new AppError(
        'RUN_ABORTED',
        `执行器进程已退出（code=${code}）。${this.stderrText()}`,
        { code, runId: this.runId }
      )
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer)
        w.reject(err)
      }
      this.opts.onExit(code)
    })
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get alive(): boolean {
    return !this.exited
  }

  private stderrText(): string {
    return this.stderrTail.length > 0 ? `最后几行错误输出：\n${this.stderrTail.join('\n')}` : ''
  }

  private settleWaiters(m: WorkerToMain): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]
      if (w.type === m.type) {
        this.waiters.splice(i, 1)
        clearTimeout(w.timer)
        w.resolve(m)
      } else if (m.type === 'error' && w.type !== 'error') {
        // worker 报了致命错误，任何还在等的握手都不可能等到了。
        this.waiters.splice(i, 1)
        clearTimeout(w.timer)
        w.reject(new AppError(m.error.code, m.error.message, m.error.detail))
      }
    }
  }

  /** 等一条特定类型的消息。 */
  waitFor<T extends WorkerToMain['type']>(
    type: T,
    timeoutMs: number,
    what: string
  ): Promise<MessageOf<T>> {
    if (this.exited) {
      return Promise.reject(
        new AppError('RUN_ABORTED', `执行器进程已退出，无法${what}。${this.stderrText()}`)
      )
    }
    return new Promise<MessageOf<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(
          new AppError('TIMEOUT', `${what}超时（${timeoutMs}ms 没有响应）。${this.stderrText()}`, {
            runId: this.runId
          })
        )
      }, timeoutMs)
      this.waiters.push({
        type,
        timer,
        resolve: resolve as (m: WorkerToMain) => void,
        reject
      })
    })
  }

  post(msg: MainToWorker): void {
    if (this.exited) return
    this.child.postMessage(msg)
  }

  /**
   * 建立三方连接：
   *   主进程 -> worker    ：attach（带 port1）
   *   worker <-> 渲染进程 ：port1 <-> port2，日志与预览帧从此不再经过主进程
   */
  async attach(win: BrowserWindow | null, payload: WorkerAttachPayload): Promise<void> {
    const { port1, port2 } = new MessageChannelMain()
    this.child.postMessage({ type: 'attach', payload } satisfies MainToWorker, [port1])

    if (win && !win.isDestroyed()) {
      // preload 会把这个 port 用 window.postMessage 转发到主世界
      // （MessagePort 穿不了 contextBridge，见 shared/worker.ts 的说明）。
      win.webContents.postMessage(
        WORKER_PORT_CHANNEL,
        { runId: payload.runId, instanceIndex: payload.instanceIndex },
        [port2]
      )
    } else {
      // 没有窗口就直接关掉，别让端口悬着。worker 那侧发消息会被静默丢弃，不影响执行。
      port2.close()
    }

    await this.waitFor('attached', ATTACH_TIMEOUT_MS, '执行器绑定脚本')
  }

  /** 等 worker 完成预热。 */
  async waitReady(timeoutMs = READY_TIMEOUT_MS): Promise<MessageOf<'ready'>> {
    return this.waitFor('ready', timeoutMs, '执行器启动')
  }

  /** 优雅停止：先让它跑完当前步骤，超时再硬杀。 */
  requestStop(graceMs = STOP_GRACE_MS): void {
    if (this.exited) return
    this.post({ type: 'stop' })
    if (this.killTimer) return
    this.killTimer = setTimeout(() => {
      this.killTimer = null
      if (!this.exited) {
        console.warn(`[orchestrator] 执行器 ${this.runId} 优雅停止超时，强制结束。`)
        this.kill()
      }
    }, graceMs)
    this.killTimer.unref?.()
  }

  /** 让它自己退出（脚本已经结束时用）。 */
  requestShutdown(graceMs = 3000): void {
    if (this.exited) return
    this.post({ type: 'shutdown' })
    if (this.killTimer) return
    this.killTimer = setTimeout(() => {
      this.killTimer = null
      if (!this.exited) this.kill()
    }, graceMs)
    this.killTimer.unref?.()
  }

  kill(): void {
    if (this.exited) return
    try {
      this.child.kill()
    } catch (e) {
      console.error(`[orchestrator] kill 执行器失败：${String(e)}`)
    }
  }
}
