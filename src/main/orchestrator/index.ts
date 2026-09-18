/**
 * 执行编排：谁在跑、能不能再开、状态往哪推、落盘请求谁来接。
 *
 * 主进程在这里**只做编排**：
 *   · 并发上限与实例占用检查
 *   · fork/attach/kill 执行器进程
 *   · 收 worker 的状态与落盘请求（日志、留痕截图）
 * 截图、匹配、脚本执行一律在 utilityProcess 里，主线程一步都不碰
 * （实测主线程跑一次识别，事件循环卡顿 71.8ms，面板肉眼掉帧）。
 *
 * 本模块不注册 IPC handler（那是模块 e 的事），只导出函数供其调用。
 */

import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { makeId } from '@shared/defaults'
import { AppError } from '@shared/errors'
import type { Account, AppSettings, ResolvedPaths } from '@shared/domain'
import type { RunHandle, RunSnapshot, RunStatus, ScriptDef, StartRunRequest } from '@shared/script'
import type { AiAssistResult, WorkerAttachPayload, WorkerToMain } from '@shared/worker'
import { appendLogs } from '../store/logs'
import { saveShot } from '../store/shots'
import { RunWorker, STOP_GRACE_MS } from './pool'
import { instanceAccess } from '@main/instanceAccess'

/** 启动一次执行所需要的外部依赖，由模块 e 在 IPC handler 里注入。 */
export interface RunDeps {
  /** 读脚本定义（内置或用户脚本）。 */
  loadScript: (scriptId: string) => Promise<ScriptDef>
  /** 当前面板设置。 */
  settings: AppSettings
  /** 已解析好的绝对路径。 */
  paths: ResolvedPaths
  /** 实例 index -> 规范 serial（调用前应确保 adb 已 attach 且设备在线）。 */
  resolveSerial: (instanceIndex: number) => Promise<string>
  /** 取账号信息，用于日志归档与参数覆盖。 */
  loadAccount?: (accountId: string) => Promise<Account | null>
  /**
   * ★ AI 顾问端口：脚本某一步重试耗尽时，worker 会喊一声，由主进程去看一眼当前画面
   * （多半是活动弹窗挡路）并尝试处理掉。不接 = 脚本执行期间没有 AI 兜底，行为与从前完全一致。
   *
   * 实现方在**同一个 serial** 上自己截图自己点；worker 此刻停在 await 上不动手，
   * 所以不会两边同时驱动同一个模拟器。实现方不得抛异常（真抛了这里也会兜住）。
   */
  aiAssist?: (req: AiAssistRequest) => Promise<AiAssistResult>
}

/** 一次 AI 求助的上下文（编排器把 worker 的消息原样转给主进程的实现）。 */
export interface AiAssistRequest {
  runId: string
  instanceIndex: number
  scriptId: string
  /** 脚本的模板集 id（自学模板往这里存）。没有为 null。 */
  templateSetId: string | null
  stepId: string | null
  reason: string
  expectTemplateIds: string[]
}

export interface Orchestrator {
  /** 启动一次执行。并发超限 / 实例已占用 / 设备不可用都会抛带中文说明的 AppError。 */
  start(win: BrowserWindow | null, req: StartRunRequest, deps: RunDeps): Promise<RunHandle>
  /** 优雅停止（跑完当前步骤），超时后强杀。 */
  stop(runId: string): Promise<void>
  pause(runId: string): void
  resume(runId: string): void
  /** 全部执行快照（进行中 + 最近结束的）。 */
  list(): RunSnapshot[]
  snapshot(runId: string): RunSnapshot | null
  /** 某个实例上正在跑的执行 id。 */
  runIdOfInstance(instanceIndex: number): string | null
  /** 开关预览推流（面板切到别的页面时应该关掉，省 CPU）。 */
  setPreview(runId: string, enabled: boolean): void
  onChange(cb: (s: RunSnapshot) => void): () => void
  /** 退出应用前调用：停掉所有执行器并等它们退出。 */
  shutdownAll(timeoutMs?: number): Promise<void>
}

/** 结束的执行最多在内存里留这么多份快照，供面板回看。 */
const MAX_FINISHED_KEPT = 50

interface RunEntry {
  handle: RunHandle
  worker: RunWorker
  snapshot: RunSnapshot
  paths: ResolvedPaths
  /** 启动时那一份依赖，AI 求助要用（worker 的消息是异步回来的，那时 start 早返回了）。 */
  deps: RunDeps
  /** 脚本的模板集 id，AI 自学模板时要知道往哪个集合里存。 */
  templateSetId: string | null
  finished: boolean
  exited: Promise<void>
  resolveExited: () => void
  releaseAccess: () => void
  workerExited: boolean
}

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(['succeeded', 'failed', 'aborted'])

class OrchestratorImpl implements Orchestrator {
  private readonly runs = new Map<string, RunEntry>()
  private readonly listeners = new Set<(s: RunSnapshot) => void>()
  private readonly pending = new Map<number, string>()
  private shuttingDown = false

  // ── 查询 ────────────────────────────────────────────────────────────────

  list(): RunSnapshot[] {
    return [...this.runs.values()]
      .map((r) => cloneSnapshot(r.snapshot))
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  snapshot(runId: string): RunSnapshot | null {
    const e = this.runs.get(runId)
    return e ? cloneSnapshot(e.snapshot) : null
  }

  runIdOfInstance(instanceIndex: number): string | null {
    const pending = this.pending.get(instanceIndex)
    if (pending) return pending
    for (const e of this.runs.values()) {
      if (!e.workerExited && e.snapshot.instanceIndex === instanceIndex) return e.handle.runId
    }
    return null
  }

  onChange(cb: (s: RunSnapshot) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private notify(s: RunSnapshot): void {
    const copy = cloneSnapshot(s)
    for (const cb of this.listeners) {
      try {
        cb(copy)
      } catch (e) {
        console.error(`[orchestrator] 状态订阅者抛错：${String(e)}`)
      }
    }
  }

  // ── 启动 ────────────────────────────────────────────────────────────────

  async start(win: BrowserWindow | null, req: StartRunRequest, deps: RunDeps): Promise<RunHandle> {
    const { settings, paths } = deps
    if (this.shuttingDown) throw new AppError('RUN_ABORTED', '应用正在退出，不能启动新任务。')

    // ① 并发上限。实测单实例跑 Unity 游戏 45.7% CPU + 1.2GB RSS，超过 4 个会把机器打满。
    const active = [...this.runs.values()].filter((r) => !r.workerExited)
    const activeCount = active.length + this.pending.size
    const limit = Math.max(1, settings.maxConcurrentInstances)
    if (activeCount >= limit) {
      throw new AppError(
        'CONCURRENCY_LIMIT',
        `同时运行的实例已达上限 ${limit} 个。请先停掉一个正在跑的任务，或到设置里调高上限（不建议超过 4 个）。`,
        { active: activeCount, limit }
      )
    }

    // ② 一个实例同时只能跑一个脚本。
    const busy = this.runIdOfInstance(req.instanceIndex)
    if (busy) {
      throw new AppError(
        'CONCURRENCY_LIMIT',
        `实例 ${req.instanceIndex} 上已经有任务在跑（${busy}），请先停止它。`,
        { runId: busy }
      )
    }

    const runId = makeId('run')
    const releaseAccess = instanceAccess.acquire(req.instanceIndex, '运行脚本')
    this.pending.set(req.instanceIndex, runId)
    let transferred = false
    try {
      // ③ 占用已登记，再异步读取设备、脚本、账号。
      const serial = await deps.resolveSerial(req.instanceIndex)
      const script = await deps.loadScript(req.scriptId)
      const account =
        req.accountId && deps.loadAccount ? await deps.loadAccount(req.accountId) : null

      if (this.shuttingDown) throw new AppError('RUN_ABORTED', '应用正在退出，任务启动已取消。')
      const payload: WorkerAttachPayload = {
        runId,
        instanceIndex: req.instanceIndex,
        serial,
        script,
        params: mergeParams(script, account, req),
        request: req,
        settings: { ...settings, shotPolicy: req.shotPolicy ?? settings.shotPolicy },
        paths: {
          adbPath: paths.adbPath,
          templatesDir: paths.templatesDir,
          shotsDir: paths.shotsDir,
          logsDir: paths.logsDir
        },
        accountId: account?.id ?? req.accountId ?? null,
        accountName: account?.name ?? null
      }

      const snapshot: RunSnapshot = {
        runId,
        scriptId: script.id,
        scriptName: script.name,
        instanceIndex: req.instanceIndex,
        serial,
        accountId: payload.accountId,
        accountName: payload.accountName,
        status: 'starting',
        startedAt: Date.now(),
        endedAt: null,
        stepDone: 0,
        stepTotal: script.loop ? null : script.steps.length,
        currentStepId: null,
        currentStepName: null,
        iteration: 0,
        error: null,
        stats: {
          captures: 0,
          matches: 0,
          matchHits: 0,
          taps: 0,
          retries: 0,
          lastTickMs: 0,
          avgCaptureMs: 0
        }
      }

      let resolveExited!: () => void
      const exited = new Promise<void>((r) => {
        resolveExited = r
      })

      const worker = new RunWorker({
        runId,
        instanceIndex: req.instanceIndex,
        // runner.js 与主进程入口同在 out/main/ 下（见 electron.vite.config.ts 的双入口配置）。
        runnerPath: join(__dirname, 'runner.js'),
        onMessage: (m) => this.onWorkerMessage(runId, m),
        onExit: (code) => this.onWorkerExit(runId, code)
      })

      const entry: RunEntry = {
        handle: { runId, instanceIndex: req.instanceIndex, scriptId: script.id },
        worker,
        snapshot,
        paths,
        deps,
        templateSetId: script.templateSetId ?? null,
        finished: false,
        exited,
        resolveExited,
        releaseAccess,
        workerExited: false
      }
      this.runs.set(runId, entry)
      transferred = true
      this.pending.delete(req.instanceIndex)
      this.notify(snapshot)

      try {
        await worker.waitReady()
        await worker.attach(win, payload)
        worker.post({ type: 'start' })
      } catch (e) {
        // 启动阶段失败：把进程收干净，并把失败原因写进快照推给面板。
        worker.kill()
        const err = AppError.from(e, 'UNKNOWN')
        this.markFinished(entry, 'failed', err.message)
        throw err
      }

      snapshot.status = 'running'
      this.notify(snapshot)
      this.prune()
      return entry.handle
    } finally {
      this.pending.delete(req.instanceIndex)
      if (!transferred) releaseAccess()
    }
  }

  // ── 控制 ────────────────────────────────────────────────────────────────

  async stop(runId: string): Promise<void> {
    const e = this.mustGet(runId)
    if (e.finished) return
    e.snapshot.status = 'stopping'
    this.notify(e.snapshot)
    e.worker.requestStop(STOP_GRACE_MS)
    await e.exited
  }

  pause(runId: string): void {
    const e = this.mustGet(runId)
    if (e.finished) throw new AppError('RUN_NOT_FOUND', '该执行已经结束，无法暂停。')
    e.worker.post({ type: 'pause' })
  }

  resume(runId: string): void {
    const e = this.mustGet(runId)
    if (e.finished) throw new AppError('RUN_NOT_FOUND', '该执行已经结束，无法继续。')
    e.worker.post({ type: 'resume' })
  }

  setPreview(runId: string, enabled: boolean): void {
    const e = this.runs.get(runId)
    if (!e || e.finished) return
    e.worker.post({ type: 'preview', enabled })
  }

  async shutdownAll(timeoutMs = STOP_GRACE_MS + 2000): Promise<void> {
    this.shuttingDown = true
    const active = [...this.runs.values()].filter((r) => !r.workerExited)
    if (active.length === 0) return
    for (const e of active) e.worker.requestStop(STOP_GRACE_MS)
    await Promise.race([
      Promise.all(active.map((e) => e.exited)),
      new Promise<void>((r) => setTimeout(r, timeoutMs))
    ])
    for (const e of active) e.worker.kill()
  }

  // ── worker 消息 ────────────────────────────────────────────────────────

  private onWorkerMessage(runId: string, m: WorkerToMain): void {
    const e = this.runs.get(runId)
    if (!e) return

    switch (m.type) {
      case 'status':
        if (!e.finished) {
          e.snapshot = m.snapshot
          this.notify(e.snapshot)
        }
        break

      case 'persistLogs':
        // 落盘失败不该影响脚本继续跑，但绝不能静默 —— 至少要吼到终端里。
        void appendLogs(e.paths.logsDir, m.runId, m.entries).catch((err: unknown) => {
          console.error(`[orchestrator] 写运行日志失败（run=${m.runId}）：${String(err)}`)
        })
        break

      case 'persistShot':
        void saveShot(e.paths.shotsDir, m.runId, m.file, m.jpeg).catch((err: unknown) => {
          console.error(`[orchestrator] 保存留痕截图失败（run=${m.runId}）：${String(err)}`)
        })
        break

      case 'finished':
        e.snapshot = m.snapshot
        this.markFinished(e, m.snapshot.status, m.snapshot.error)
        // 脚本已经结束，让执行器自己退，把 100MB 的 WASM 堆还给系统。
        e.worker.requestShutdown()
        break

      case 'aiConsult':
        void this.onAiConsult(e, m)
        break

      case 'error':
        console.error(`[orchestrator] 执行器报错（run=${runId}）：${m.error.message}`)
        if (!e.finished) {
          e.snapshot.error = m.error.message
          this.notify(e.snapshot)
        }
        break

      default:
        // ready / attached / detectResult 由 waitFor 处理，这里不用管。
        break
    }
  }

  /**
   * worker 卡住了，转给主进程的 AI 顾问。
   *
   * ★ 无论成败都**必须**回一条 aiResult：worker 那边正停在 await 上等，
   *   漏回一条就是让脚本干等到 3 分钟超时，白白浪费一次执行窗口。
   */
  private async onAiConsult(
    e: RunEntry,
    m: Extract<WorkerToMain, { type: 'aiConsult' }>
  ): Promise<void> {
    let result: AiAssistResult
    const assist = e.deps.aiAssist
    if (!assist) {
      result = { handled: false, message: 'AI 顾问没有接入执行链路，本次跳过。' }
    } else {
      try {
        result = await assist({
          runId: m.runId,
          instanceIndex: m.instanceIndex,
          scriptId: e.handle.scriptId,
          templateSetId: e.templateSetId,
          stepId: m.stepId,
          reason: m.reason,
          expectTemplateIds: m.expectTemplateIds
        })
      } catch (err) {
        const ae = AppError.from(err)
        result = {
          handled: false,
          message: `AI 顾问出错，按未处理继续：${ae.message}`,
          requiresAttention: ae.code === 'AI_RISK_BLOCKED' || ae.code === 'GAME_UPDATE_REQUIRED'
        }
      }
    }
    if (e.workerExited || e.finished) return
    e.worker.post({ type: 'aiResult', requestId: m.requestId, result })
  }

  private onWorkerExit(runId: string, code: number): void {
    const e = this.runs.get(runId)
    if (!e) return
    e.workerExited = true
    e.releaseAccess()
    if (!e.finished) {
      // 没走到 finished 就退了 = 崩了/被杀了。要么是脚本把进程搞挂了，要么是被停止超时强杀。
      const stopping = e.snapshot.status === 'stopping'
      this.markFinished(
        e,
        stopping ? 'aborted' : 'failed',
        stopping ? null : `执行器进程异常退出（code=${code}），本次执行未完成。`
      )
    }
    e.resolveExited()
    this.prune()
  }

  private markFinished(e: RunEntry, status: RunStatus, error: string | null): void {
    if (e.finished) return
    e.finished = true
    e.snapshot = {
      ...e.snapshot,
      status: TERMINAL.has(status) ? status : 'failed',
      endedAt: e.snapshot.endedAt ?? Date.now(),
      currentStepId: null,
      currentStepName: null,
      error: error ?? e.snapshot.error
    }
    this.notify(e.snapshot)
    this.prune()
  }

  private mustGet(runId: string): RunEntry {
    const e = this.runs.get(runId)
    if (!e)
      throw new AppError('RUN_NOT_FOUND', `找不到执行记录：${runId}（可能已经结束并被清理）。`)
    return e
  }

  /** 只保留最近 MAX_FINISHED_KEPT 条已结束的记录，避免长时间挂机后内存里全是历史快照。 */
  private prune(): void {
    const done = [...this.runs.values()]
      .filter((r) => r.finished && r.workerExited)
      .sort((a, b) => (b.snapshot.endedAt ?? 0) - (a.snapshot.endedAt ?? 0))
    for (const e of done.slice(MAX_FINISHED_KEPT)) this.runs.delete(e.handle.runId)
  }
}

/** 参数优先级：脚本默认值 < 账号里存的覆盖 < 本次启动请求。 */
function mergeParams(
  script: ScriptDef,
  account: Account | null,
  req: StartRunRequest
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const p of script.params ?? []) {
    if (p.default !== undefined) out[p.key] = p.default
  }
  Object.assign(out, account?.scriptParams?.[script.id] ?? {})
  Object.assign(out, req.params ?? {})
  return out
}

function cloneSnapshot(s: RunSnapshot): RunSnapshot {
  return { ...s, stats: { ...s.stats } }
}

let singleton: Orchestrator | null = null

/** 全局唯一的编排器。模块 e 在 app ready 之后取用。 */
export function getOrchestrator(): Orchestrator {
  if (!singleton) singleton = new OrchestratorImpl()
  return singleton
}

export { RunWorker } from './pool'
