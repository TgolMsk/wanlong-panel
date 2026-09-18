/**
 * 任务计划器：到点 → 排队 → 抢占 → 执行 → 记账 → 排下一次。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【分工】本模块**只做编排**，一行 adb、一次截图、一次匹配都不碰：
 *   · 什么时候该跑          —— shared/plan.ts 的纯函数 nextFireAt / previousFireAt
 *   · 跑哪个脚本、在哪个实例 —— 计划表（plans.json）+ 账号的实例绑定
 *   · 怎么跑                —— 交给已有的 orchestrator（utilityProcess 执行器）
 *   · 采集调度器怎么让路     —— 交给 scheduler.suspendForScript()
 *
 * 【四条铁律】
 *
 *  1. ★ **脚本优先级最高。** 启动执行前先 suspendForScript：先礼（等 preemptGraceMs
 *     让在飞的采样/派遣链自然收尾）后兵（abort 掉它）。脚本跑完再把调度器放回去，
 *     并安排一次「重读队列校验」—— 脚本期间画面被动过，调度器的旧状态不可信。
 *  2. ★ **每实例串行。** 队列按实例分，同一实例同时只发一个执行；
 *     一个账号勾了 5 个脚本就排 5 个挨个跑。全局并发上限仍由编排器管（maxConcurrentInstances）。
 *  3. ★ **等不到就跳过，绝不堆积。** 实例没开机、被别的任务占着超过 queueWaitMs，
 *     这一轮记 skipped 直接排下一次。挂机工具最怕的是半夜攒了 200 个任务天亮一起冲。
 *  4. ★ **触发时刻是北京时间。** 全部走 shared/plan.ts 的纯函数，本文件不自己算时间。
 *
 * 【与 scheduler 的区别】调度器盯的是**游戏里的队列什么时候空**（ETA，事件驱动）；
 * 计划器盯的是**墙上的钟**（到点就跑）。两者都会动同一个实例，所以有铁律 1。
 * ══════════════════════════════════════════════════════════════════════════
 */

import { AppError } from '@shared/errors'
import type { Account } from '@shared/domain'
import type { RunHandle, RunSnapshot, ScriptMeta, StartRunRequest } from '@shared/script'
import type {
  AccountPlan,
  PlanConfig,
  PlanOverview,
  PlanQueueView,
  PlanTask,
  PlanTaskPhase,
  PlanTaskState
} from '@shared/plan'
import { defaultPlanConfig, describeTrigger, nextFireAt, previousFireAt } from '@shared/plan'
import { loadPlanFile, mergePlanConfig, savePlanFile } from './store'
import type { PersistedTaskRuntime } from './store'
import { emitPlan, handlePlan } from './ipc'

/** 计划器要的外部能力，全部由 src/main/index.ts 的接线区注入。 */
export interface PlanDeps {
  /** 运行数据根目录（plans.json 落在这里）。每次现取，用户可能改了数据目录。 */
  dataDir(): string
  /** 账号列表（含实例绑定）。每次现取。 */
  listAccounts(): Promise<Account[]>
  /** 脚本元信息，用来显示名字并判断脚本是不是被删了。 */
  listScripts(): Promise<ScriptMeta[]>
  /** 启动一次执行（转发给编排器）。 */
  startRun(req: StartRunRequest): Promise<RunHandle>
  /** 停止一次执行。 */
  stopRun(runId: string): Promise<void>
  /** 订阅执行状态变化（编排器的 onChange），返回退订函数。 */
  onRunChange(cb: (s: RunSnapshot) => void): () => void
  /**
   * ★ 让采集调度器为脚本让路，返回「放回去」的函数。
   * 没有调度器（或实例本来就没开自动调度）时给一个空函数即可。
   */
  suspendScheduler(instanceIndex: number, graceMs: number, reason: string): Promise<() => void>
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
}

/** 这些失败不是「脚本没跑通」，而是「现在没法跑」：记 skipped，不重试、不计失败次数。 */
const SKIP_CODES = new Set([
  'DEVICE_NOT_READY',
  'ADB_DEVICE_OFFLINE',
  'ADB_CONNECT_FAILED',
  'ADB_NOT_FOUND',
  'MUMU_INSTANCE_MISSING',
  'INVALID_ARGUMENT'
])

/** 定时器最长睡这么久就醒一次，重新评估（实例开机了没、队列等超时了没）。 */
const MAX_SLEEP_MS = 60_000
/** 被并发上限挡住时，隔这么久再试一次。 */
const BUSY_RETRY_MS = 15_000
/** 无人认领的终态快照最多留这么多份，防止长期挂机把内存攒满。 */
const MAX_TERMINAL_KEPT = 50
/**
 * 失败重试的最小等待。不是拍脑袋：execute 的收尾（把队列项摘掉）要过一次 await，
 * 定时器比它先响的话，enqueue 会因为「这条已经在队列里」而静默丢掉这次重试。
 */
const MIN_RETRY_DELAY_MS = 200

interface TaskRuntime {
  phase: PlanTaskPhase
  lastRunAt: number | null
  lastEndedAt: number | null
  lastResult: 'succeeded' | 'failed' | 'aborted' | null
  lastError: string | null
  runId: string | null
  queuedAt: number | null
  /** 排队超时时刻，超了就放弃这一轮。 */
  deadline: number | null
  runs: number
  fails: number
  /** 本轮还剩几次重试。 */
  retryLeft: number
  /** 下次允许入队的最早时刻（重试等待 / 并发退避期间用）。 */
  holdUntil: number | null
}

interface QueueItem {
  key: string
  accountId: string
  taskId: string
  priority: number
}

function emptyRuntime(): TaskRuntime {
  return {
    phase: 'idle',
    lastRunAt: null,
    lastEndedAt: null,
    lastResult: null,
    lastError: null,
    runId: null,
    queuedAt: null,
    deadline: null,
    runs: 0,
    fails: 0,
    retryLeft: 0,
    holdUntil: null
  }
}

function keyOf(accountId: string, taskId: string): string {
  return `${accountId}::${taskId}`
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, Math.max(0, ms))
    t.unref?.()
  })
}

class PlanRunnerImpl {
  private deps: PlanDeps | null = null
  private config: PlanConfig = defaultPlanConfig()
  private plans = new Map<string, AccountPlan>()
  private readonly rt = new Map<string, TaskRuntime>()
  /** 每实例一条队列。执行中的那个也留在队首，pump 据此判断实例忙不忙。 */
  private readonly queues = new Map<number, QueueItem[]>()
  /** 正在跑的实例 → 队列项，用于停止与去重。 */
  private readonly active = new Map<number, QueueItem>()
  private timer: NodeJS.Timeout | null = null
  private unsubscribeRuns: (() => void) | null = null
  /** runId → 等这次执行结束的 resolver。 */
  private readonly waiters = new Map<string, (s: RunSnapshot) => void>()
  /** 没人等的终态快照（先到先存），解决「执行结束比 awaitRun 注册还快」的竞态。 */
  private readonly recentTerminal = new Map<string, RunSnapshot>()
  private started = false
  private stopping = false
  /** 账号快照（避免每次 tick 都读磁盘）。计划变更 / 每次 tick 前刷新。 */
  private accounts: Account[] = []
  private scripts: ScriptMeta[] = []

  // ── 生命周期 ───────────────────────────────────────────────────────────

  async init(deps: PlanDeps): Promise<void> {
    if (this.started) return
    this.deps = deps
    this.started = true
    this.stopping = false

    // 先注册通道：万一 plans.json 读坏了，面板至少能拉到空计划并看到中文原因。
    this.registerHandlers()

    const file = await loadPlanFile(deps.dataDir())
    this.config = file.config
    this.plans = new Map(file.plans.map((p) => [p.accountId, p]))
    for (const w of file.loadWarnings ?? []) this.log('warn', w)
    for (const r of file.runtime ?? []) {
      const rt = emptyRuntime()
      rt.lastRunAt = r.lastRunAt
      rt.lastEndedAt = r.lastEndedAt
      rt.lastResult = r.lastResult
      rt.lastError = r.lastError
      rt.runs = r.runs
      rt.fails = r.fails
      this.rt.set(keyOf(r.accountId, r.taskId), rt)
    }

    this.unsubscribeRuns = deps.onRunChange((s) => this.onRunChange(s))
    await this.refreshRefs()
    this.log(
      'info',
      `任务计划已加载：${this.plans.size} 个账号、${[...this.plans.values()].reduce((n, p) => n + p.tasks.length, 0)} 条任务，` +
        `总开关${this.config.enabled ? '已开启' : '未开启'}。`
    )
    this.tick('启动')
  }

  /** 退出前收尾：停掉定时器，正在跑的执行交给编排器的 shutdownAll 收。 */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.unsubscribeRuns?.()
    this.unsubscribeRuns = null
    await this.persist().catch(() => undefined)
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const fn = this.deps?.log
    if (fn) fn(level, message)
    else if (level === 'warn' || level === 'error') console.warn(`[plan] ${message}`)
    else console.log(`[plan] ${message}`)
  }

  private requireDeps(): PlanDeps {
    if (!this.deps) throw new AppError('UNKNOWN', '任务计划器还没初始化。')
    return this.deps
  }

  // ── 对外查询与编辑 ─────────────────────────────────────────────────────

  getConfig(): PlanConfig {
    return { ...this.config }
  }

  async saveConfig(patch: Partial<PlanConfig>): Promise<PlanConfig> {
    this.config = mergePlanConfig(this.config, patch)
    await this.persist()
    emitPlan('plan:configChanged', this.getConfig())
    this.tick('配置变更')
    return this.getConfig()
  }

  getPlan(accountId: string): AccountPlan {
    const p = this.plans.get(accountId)
    if (p) return structuredClone(p)
    return { accountId, enabled: false, tasks: [], updatedAt: 0 }
  }

  async savePlan(plan: AccountPlan): Promise<AccountPlan> {
    const next: AccountPlan = { ...plan, updatedAt: Date.now() }
    this.plans.set(next.accountId, next)
    // 任务被删掉时，把它的运行时一并清掉，免得内存里越攒越多。
    const alive = new Set(next.tasks.map((t) => keyOf(next.accountId, t.id)))
    for (const k of [...this.rt.keys()]) {
      if (k.startsWith(`${next.accountId}::`) && !alive.has(k)) this.rt.delete(k)
    }
    await this.persist()
    this.tick('计划变更')
    return structuredClone(next)
  }

  async setTaskEnabled(accountId: string, taskId: string, enabled: boolean): Promise<PlanOverview> {
    const plan = this.plans.get(accountId)
    const task = plan?.tasks.find((t) => t.id === taskId)
    if (!plan || !task)
      throw new AppError('NOT_FOUND', '找不到这条任务，面板可能不是最新的，刷新一下再试。')
    task.enabled = enabled
    plan.updatedAt = Date.now()
    if (!enabled) this.dequeue(accountId, taskId)
    await this.persist()
    this.tick(`任务开关 ${enabled ? '开' : '关'}`)
    return this.state()
  }

  async setAccountEnabled(accountId: string, enabled: boolean): Promise<PlanOverview> {
    const plan = this.plans.get(accountId) ?? {
      accountId,
      enabled: false,
      tasks: [],
      updatedAt: 0
    }
    plan.enabled = enabled
    plan.updatedAt = Date.now()
    this.plans.set(accountId, plan)
    if (!enabled) for (const t of plan.tasks) this.dequeue(accountId, t.id)
    await this.persist()
    this.tick(`账号开关 ${enabled ? '开' : '关'}`)
    return this.state()
  }

  /** 面板「立即运行」：无视触发时间，但照样走队列与抢占（绝不插队直接动实例）。 */
  async runNow(accountId: string, taskId: string): Promise<PlanOverview> {
    await this.refreshRefs()
    const plan = this.plans.get(accountId)
    const task = plan?.tasks.find((t) => t.id === taskId)
    if (!plan || !task)
      throw new AppError('NOT_FOUND', '找不到这条任务，面板可能不是最新的，刷新一下再试。')
    const account = this.accounts.find((a) => a.id === accountId)
    if (!account) throw new AppError('NOT_FOUND', '这条计划挂的账号已经不存在了，请先把它删掉。')
    if (account.instanceIndex == null) {
      throw new AppError('INVALID_ARGUMENT', `账号「${account.name}」还没绑定实例，没法跑脚本。`)
    }
    const rt = this.runtimeOf(accountId, taskId)
    if (rt.phase === 'running' || rt.phase === 'queued') {
      throw new AppError('CONCURRENCY_LIMIT', '这条任务已经在队列里了，不用重复点。')
    }
    rt.holdUntil = null
    rt.retryLeft = this.config.retry
    this.enqueue(account.instanceIndex, accountId, task, '手动立即运行')
    this.pump(account.instanceIndex)
    return this.state()
  }

  /** 取消：排队中的踢出队列，正在跑的停掉执行。 */
  async cancel(accountId: string, taskId: string): Promise<PlanOverview> {
    const rt = this.runtimeOf(accountId, taskId)
    this.dequeue(accountId, taskId)
    if (rt.phase === 'running' && rt.runId) {
      await this.requireDeps()
        .stopRun(rt.runId)
        .catch((e: unknown) => this.log('warn', `停止执行失败：${AppError.from(e).message}`))
    }
    this.publish()
    return this.state()
  }

  // ── 快照 ───────────────────────────────────────────────────────────────

  state(): PlanOverview {
    const now = Date.now()
    const tasks: PlanTaskState[] = []
    for (const plan of this.plans.values()) {
      const account = this.accounts.find((a) => a.id === plan.accountId)
      for (const task of plan.tasks) {
        const rt = this.runtimeOf(plan.accountId, task.id)
        const script = this.scripts.find((s) => s.id === task.scriptId)
        tasks.push({
          accountId: plan.accountId,
          accountName: account?.name ?? '（账号已删除）',
          instanceIndex: account?.instanceIndex ?? null,
          taskId: task.id,
          scriptId: task.scriptId,
          scriptName: script?.name ?? null,
          enabled: task.enabled,
          accountEnabled: plan.enabled,
          trigger: task.trigger,
          priority: task.priority,
          maxRunMinutes: task.maxRunMinutes,
          note: task.note,
          phase: rt.phase,
          nextRunAt: this.nextRunAtOf(plan, task, rt, now),
          lastRunAt: rt.lastRunAt,
          lastEndedAt: rt.lastEndedAt,
          lastResult: rt.lastResult,
          lastError: rt.lastError,
          runId: rt.runId,
          queuedAt: rt.queuedAt,
          runs: rt.runs,
          fails: rt.fails
        })
      }
    }
    const queues: PlanQueueView[] = []
    for (const [instanceIndex, items] of this.queues) {
      const running = this.active.get(instanceIndex)
      queues.push({
        instanceIndex,
        runningTaskId: running?.taskId ?? null,
        waitingTaskIds: items.filter((i) => i.key !== running?.key).map((i) => i.taskId)
      })
    }
    return { config: this.getConfig(), tasks, queues, at: now }
  }

  private publish(): void {
    try {
      emitPlan('plan:changed', this.state())
    } catch (e) {
      this.log('warn', `推送计划状态失败（已忽略）：${AppError.from(e).message}`)
    }
  }

  /** 下次运行时刻。关掉的、总开关没开的、脚本没了的一律 null（面板显示「—」）。 */
  private nextRunAtOf(
    plan: AccountPlan,
    task: PlanTask,
    rt: TaskRuntime,
    now: number
  ): number | null {
    if (!this.config.enabled || !plan.enabled || !task.enabled) return null
    if (rt.phase === 'queued' || rt.phase === 'running') return null
    const base = rt.holdUntil != null && rt.holdUntil > now ? rt.holdUntil : null
    const next = nextFireAt(task.trigger, now, rt.lastRunAt)
    if (base == null) return next
    return next == null ? base : Math.max(base, next)
  }

  private runtimeOf(accountId: string, taskId: string): TaskRuntime {
    const k = keyOf(accountId, taskId)
    let rt = this.rt.get(k)
    if (!rt) {
      rt = emptyRuntime()
      this.rt.set(k, rt)
    }
    return rt
  }

  // ── 主循环 ─────────────────────────────────────────────────────────────

  /** 评估一遍：该到点的入队，然后各实例 pump 一次，最后重排定时器。 */
  private tick(why: string): void {
    if (this.stopping) return
    void this.tickAsync(why).catch((e: unknown) => {
      this.log('error', `计划评估出错（已忽略，下一轮继续）：${AppError.from(e).message}`)
    })
  }

  private async tickAsync(why: string): Promise<void> {
    await this.refreshRefs()
    const now = Date.now()
    const cfg = this.config

    if (cfg.enabled) {
      for (const plan of this.plans.values()) {
        if (!plan.enabled) continue
        const account = this.accounts.find((a) => a.id === plan.accountId)
        if (!account || account.instanceIndex == null) continue
        for (const task of plan.tasks) {
          if (!task.enabled) continue
          const rt = this.runtimeOf(plan.accountId, task.id)
          if (rt.phase === 'queued' || rt.phase === 'running') continue
          if (rt.holdUntil != null && now < rt.holdUntil) continue
          const due = this.dueReason(task, rt, now)
          if (!due) continue
          rt.retryLeft = cfg.retry
          this.enqueue(account.instanceIndex, plan.accountId, task, due)
        }
      }
    }

    // 排队超时清理。
    for (const [instanceIndex, items] of this.queues) {
      const running = this.active.get(instanceIndex)
      for (const item of [...items]) {
        if (item.key === running?.key) continue
        const rt = this.runtimeOf(item.accountId, item.taskId)
        if (rt.deadline != null && now > rt.deadline) {
          this.dequeue(item.accountId, item.taskId)
          rt.phase = 'skipped'
          rt.lastError = `等了 ${Math.round((now - (rt.queuedAt ?? now)) / 60_000)} 分钟仍没轮到（实例一直忙），这一轮跳过。`
          rt.queuedAt = null
          rt.deadline = null
          this.log('warn', `[${item.accountId}/${item.taskId}] ${rt.lastError}`)
        }
      }
    }

    for (const instanceIndex of this.queues.keys()) this.pump(instanceIndex)
    this.publish()
    this.armTimer(why)
  }

  /**
   * 这条任务现在该跑吗？该跑就返回中文理由，不该跑返回 null。
   *
   * ★ 补跑判定：面板关了一会儿、实例刚开机，错过的触发点在 catchUpMs 内还补一次；
   *   超过就当这一轮没了 —— 绝不能把攒了一天的任务一起放出来。
   */
  private dueReason(task: PlanTask, rt: TaskRuntime, now: number): string | null {
    if (task.trigger.kind === 'manual') return null

    if (task.trigger.kind === 'daily') {
      const prev = previousFireAt(task.trigger, now)
      if (prev == null) return null
      if (rt.lastRunAt != null && rt.lastRunAt >= prev) return null
      if (now - prev > this.config.catchUpMs) return null
      return now - prev < 60_000
        ? `到点（${describeTrigger(task.trigger)}）`
        : `补跑错过的触发点（晚了 ${Math.round((now - prev) / 60_000)} 分钟）`
    }

    const due = nextFireAt(task.trigger, now, rt.lastRunAt)
    if (due == null || due > now) return null
    return `到点（${describeTrigger(task.trigger)}）`
  }

  private armTimer(why: string): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.stopping) return

    const now = Date.now()
    let due = now + MAX_SLEEP_MS
    for (const plan of this.plans.values()) {
      for (const task of plan.tasks) {
        const rt = this.runtimeOf(plan.accountId, task.id)
        const at = this.nextRunAtOf(plan, task, rt, now)
        if (at != null && at > now && at < due) due = at
        if (rt.holdUntil != null && rt.holdUntil > now && rt.holdUntil < due) due = rt.holdUntil
      }
    }
    const wait = Math.min(MAX_SLEEP_MS, Math.max(1000, due - now))
    const t = setTimeout(() => this.tick('定时评估'), wait)
    // ★ 不 unref 的话，关掉窗口后主进程会被这个定时器吊着不退出（与 scheduler/timers.ts 同一条教训）。
    t.unref?.()
    this.timer = t
    this.log('debug', `下次评估在 ${Math.round(wait / 1000)}s 后（触发原因：${why}）。`)
  }

  // ── 队列 ───────────────────────────────────────────────────────────────

  private enqueue(instanceIndex: number, accountId: string, task: PlanTask, reason: string): void {
    const key = keyOf(accountId, task.id)
    const list = this.queues.get(instanceIndex) ?? []
    if (list.some((i) => i.key === key)) return
    const rt = this.runtimeOf(accountId, task.id)
    const now = Date.now()
    rt.phase = 'queued'
    rt.queuedAt = now
    rt.deadline = now + this.config.queueWaitMs
    rt.holdUntil = null
    list.push({ key, accountId, taskId: task.id, priority: task.priority })
    // 优先级大的在前；同优先级按入队先后。执行中的那个始终在队首，排序时不会被挤走
    // （它已经开跑了，pump 只看 active）。
    list.sort((a, b) => b.priority - a.priority)
    this.queues.set(instanceIndex, list)
    this.log('info', `[实例${instanceIndex}] 任务入队：${task.scriptId}（${reason}）。`)
  }

  private dequeue(accountId: string, taskId: string): void {
    const key = keyOf(accountId, taskId)
    for (const [instanceIndex, items] of this.queues) {
      const idx = items.findIndex((i) => i.key === key)
      if (idx < 0) continue
      const active = this.active.get(instanceIndex)
      if (active?.key === key) return // 正在跑，交给 cancel() 停执行，不能直接从队列抹掉
      items.splice(idx, 1)
      if (items.length === 0) this.queues.delete(instanceIndex)
      const rt = this.runtimeOf(accountId, taskId)
      if (rt.phase === 'queued') {
        rt.phase = 'idle'
        rt.queuedAt = null
        rt.deadline = null
      }
      return
    }
  }

  /** 实例空闲就发下一个。整条链是 fire-and-forget，异常全部在 execute 内部消化。 */
  private pump(instanceIndex: number): void {
    if (this.stopping) return
    if (this.active.has(instanceIndex)) return
    const list = this.queues.get(instanceIndex)
    if (!list || list.length === 0) return
    const now = Date.now()
    const item = list.find((i) => {
      const rt = this.runtimeOf(i.accountId, i.taskId)
      return rt.holdUntil == null || rt.holdUntil <= now
    })
    if (!item) return
    this.active.set(instanceIndex, item)
    void this.execute(instanceIndex, item)
  }

  // ── 执行 ───────────────────────────────────────────────────────────────

  private async execute(instanceIndex: number, item: QueueItem): Promise<void> {
    const deps = this.requireDeps()
    const rt = this.runtimeOf(item.accountId, item.taskId)
    const plan = this.plans.get(item.accountId)
    const task = plan?.tasks.find((t) => t.id === item.taskId)

    const done = (): void => {
      this.active.delete(instanceIndex)
      const list = this.queues.get(instanceIndex)
      if (list) {
        const idx = list.findIndex((i) => i.key === item.key)
        if (idx >= 0) list.splice(idx, 1)
        if (list.length === 0) this.queues.delete(instanceIndex)
      }
      this.publish()
      this.armTimer('执行结束')
      this.pump(instanceIndex)
    }

    if (!plan || !task) {
      rt.phase = 'idle'
      done()
      return
    }

    rt.phase = 'running'
    rt.lastRunAt = Date.now()
    rt.queuedAt = null
    rt.deadline = null
    rt.runs += 1
    this.publish()

    // ★ 铁律 1：先让采集调度器让路，再启动脚本。
    let restore: (() => void) | null = null
    try {
      restore = await deps.suspendScheduler(
        instanceIndex,
        this.config.preemptGraceMs,
        `执行脚本 ${task.scriptId}`
      )
    } catch (e) {
      this.log(
        'warn',
        `[实例${instanceIndex}] 让路失败，仍然继续启动脚本：${AppError.from(e).message}`
      )
    }

    try {
      const handle = await deps.startRun({
        scriptId: task.scriptId,
        instanceIndex,
        accountId: item.accountId,
        params: task.params
      })
      rt.runId = handle.runId
      this.publish()
      const snapshot = await this.awaitRun(handle.runId, task.maxRunMinutes)
      this.settle(rt, item, snapshot)
    } catch (e) {
      const err = AppError.from(e)
      if (err.code === 'CONCURRENCY_LIMIT') {
        // 全局并发满了 / 实例被别的链占着：不算失败，等一会儿原地重试（保留队列位置）。
        rt.phase = 'queued'
        rt.runId = null
        rt.queuedAt = rt.queuedAt ?? Date.now()
        rt.holdUntil = Date.now() + BUSY_RETRY_MS
        rt.runs = Math.max(0, rt.runs - 1)
        rt.lastRunAt = null
        this.log('info', `[实例${instanceIndex}] ${err.message} 稍后自动重试。`)
        // ★ 不在这里调 restore —— finally 里统一放回，两处都调会让调度器被放回两次。
        // 队列项要留着，所以这里不走 done() 的清理，只放开 active。
        this.active.delete(instanceIndex)
        this.publish()
        this.armTimer('并发退避')
        return
      }
      if (SKIP_CODES.has(err.code)) {
        rt.phase = 'skipped'
        rt.lastError = err.message
        rt.lastEndedAt = Date.now()
        rt.runId = null
        this.log('warn', `[实例${instanceIndex}] 这一轮跳过：${err.message}`)
      } else {
        rt.phase = 'failed'
        rt.lastResult = 'failed'
        rt.lastError = err.message
        rt.lastEndedAt = Date.now()
        rt.fails += 1
        rt.runId = null
        this.log('error', `[实例${instanceIndex}] 启动脚本失败：${err.message}`)
        this.scheduleRetry(rt, item)
      }
    } finally {
      restore?.()
      await this.persist().catch(() => undefined)
    }
    done()
  }

  /**
   * 等这次执行走到终态；超过 maxRunMinutes 就停掉它（防一个卡死的脚本霸占实例）。
   *
   * ★ 必须先查 recentTerminal：startRun 返回之后、这里注册 waiter 之前的那几毫秒里，
   *   执行完全可能已经结束（脚本第一步就失败）。只等事件的话会白等到时间上限才醒。
   */
  private async awaitRun(runId: string, maxRunMinutes: number): Promise<RunSnapshot | null> {
    const deps = this.requireDeps()
    const already = this.recentTerminal.get(runId)
    if (already) {
      this.recentTerminal.delete(runId)
      return already
    }
    const finished = new Promise<RunSnapshot>((resolve) => {
      this.waiters.set(runId, resolve)
    })
    try {
      if (maxRunMinutes <= 0) return await finished
      const limitMs = maxRunMinutes * 60_000
      const timeout = delay(limitMs).then(() => null)
      const first = await Promise.race([finished, timeout])
      if (first) return first
      this.log('warn', `执行 ${runId} 超过 ${maxRunMinutes} 分钟上限，正在停止。`)
      await deps.stopRun(runId).catch((e: unknown) => {
        this.log('warn', `停止超时执行失败：${AppError.from(e).message}`)
      })
      // 停止指令发出后仍等它真的收尾，最多再给 30 秒。
      return await Promise.race([finished, delay(30_000).then(() => null)])
    } finally {
      this.waiters.delete(runId)
    }
  }

  /** 执行结束后记账。 */
  private settle(rt: TaskRuntime, item: QueueItem, snapshot: RunSnapshot | null): void {
    rt.runId = null
    rt.lastEndedAt = Date.now()
    if (!snapshot) {
      rt.phase = 'failed'
      rt.lastResult = 'aborted'
      rt.lastError = '执行超过时间上限被停止（或执行器没有回报终态）。'
      rt.fails += 1
      this.scheduleRetry(rt, item)
      return
    }
    if (snapshot.status === 'succeeded') {
      rt.phase = 'done'
      rt.lastResult = 'succeeded'
      rt.lastError = null
      rt.retryLeft = 0
      return
    }
    rt.phase = 'failed'
    rt.lastResult = snapshot.status === 'aborted' ? 'aborted' : 'failed'
    rt.lastError = snapshot.error ?? '执行未成功，原因见运行日志。'
    rt.fails += 1
    // 手动停掉的不重试 —— 用户按了停，就是不想让它再跑。
    if (snapshot.status !== 'aborted') this.scheduleRetry(rt, item)
  }

  private scheduleRetry(rt: TaskRuntime, item: QueueItem): void {
    if (rt.retryLeft <= 0) return
    rt.retryLeft -= 1
    rt.holdUntil = Date.now() + Math.max(MIN_RETRY_DELAY_MS, this.config.retryDelayMs)
    // lastRunAt 回退成 null 会让 interval 触发立刻重排，所以这里靠 holdUntil 控制节奏，
    // 由下一轮 tick 的 dueReason 决定要不要再入队；daily 任务这一轮已经算跑过了，不会重复补跑。
    this.log(
      'info',
      `[${item.accountId}/${item.taskId}] ${Math.round(this.config.retryDelayMs / 1000)}s 后重试（还剩 ${rt.retryLeft} 次）。`
    )
    const plan = this.plans.get(item.accountId)
    const task = plan?.tasks.find((t) => t.id === item.taskId)
    if (!plan || !task) return
    const account = this.accounts.find((a) => a.id === item.accountId)
    if (!account || account.instanceIndex == null) return
    const at = rt.holdUntil
    const t = setTimeout(
      () => {
        if (this.stopping) return
        const cur = this.runtimeOf(item.accountId, item.taskId)
        if (cur.phase === 'running' || cur.phase === 'queued') return
        cur.holdUntil = null
        this.enqueue(account.instanceIndex as number, item.accountId, task, '失败重试')
        this.pump(account.instanceIndex as number)
        this.publish()
      },
      Math.max(0, at - Date.now())
    )
    t.unref?.()
  }

  private onRunChange(s: RunSnapshot): void {
    if (s.status !== 'succeeded' && s.status !== 'failed' && s.status !== 'aborted') return
    const w = this.waiters.get(s.runId)
    if (w) {
      this.waiters.delete(s.runId)
      w(s)
      return
    }
    // 还没人等 = 终态比 awaitRun 的注册快了一步。先留着，awaitRun 一进来就能取走。
    // 也可能是别处（「脚本」页手点）启动的执行，那种留一会儿自然被挤掉，不会无限长。
    this.recentTerminal.set(s.runId, s)
    while (this.recentTerminal.size > MAX_TERMINAL_KEPT) {
      const oldest = this.recentTerminal.keys().next().value
      if (oldest === undefined) break
      this.recentTerminal.delete(oldest)
    }
  }

  // ── 落盘 ───────────────────────────────────────────────────────────────

  private async persist(): Promise<void> {
    const deps = this.deps
    if (!deps) return
    const runtime: PersistedTaskRuntime[] = []
    for (const [k, rt] of this.rt) {
      const [accountId, taskId] = k.split('::')
      if (!accountId || !taskId) continue
      if (rt.lastRunAt == null && rt.runs === 0 && rt.fails === 0) continue
      runtime.push({
        accountId,
        taskId,
        lastRunAt: rt.lastRunAt,
        lastEndedAt: rt.lastEndedAt,
        lastResult: rt.lastResult,
        lastError: rt.lastError,
        runs: rt.runs,
        fails: rt.fails
      })
    }
    await savePlanFile(deps.dataDir(), {
      version: 1,
      config: this.config,
      plans: [...this.plans.values()],
      runtime
    })
  }

  /** 账号与脚本列表每轮现取：用户可能刚改完绑定就到点了。 */
  private async refreshRefs(): Promise<void> {
    const deps = this.requireDeps()
    try {
      this.accounts = await deps.listAccounts()
    } catch (e) {
      this.log('warn', `读账号列表失败，沿用上一次的：${AppError.from(e).message}`)
    }
    try {
      this.scripts = await deps.listScripts()
    } catch (e) {
      this.log('warn', `读脚本列表失败，沿用上一次的：${AppError.from(e).message}`)
    }
  }

  // ── IPC ────────────────────────────────────────────────────────────────

  private registerHandlers(): void {
    handlePlan('plan:state', async () => {
      await this.refreshRefs()
      return this.state()
    })
    handlePlan('plan:get', (accountId) => this.getPlan(accountId))
    handlePlan('plan:save', (plan) => this.savePlan(plan))
    handlePlan('plan:setTaskEnabled', (a, t, e) => this.setTaskEnabled(a, t, e))
    handlePlan('plan:setAccountEnabled', (a, e) => this.setAccountEnabled(a, e))
    handlePlan('plan:runNow', (a, t) => this.runNow(a, t))
    handlePlan('plan:cancel', (a, t) => this.cancel(a, t))
    handlePlan('plan:config', () => this.getConfig())
    handlePlan('plan:saveConfig', (patch) => this.saveConfig(patch))
  }
}

let singleton: PlanRunnerImpl | null = null

/** 主进程只有一个计划器。 */
export function getPlanRunner(): PlanRunnerImpl {
  if (!singleton) singleton = new PlanRunnerImpl()
  return singleton
}

/**
 * 新开一个独立的计划器。**只给离线自检用**：一个进程里跑多组互不干扰的剧本，
 * 单例做不到（init 有 started 守卫）。正式代码一律用 getPlanRunner()。
 * ★ 每个实例都会注册一遍 plan:* 通道，所以自检在两组剧本之间要 resetPlanIpc()。
 */
export function createPlanRunner(): PlanRunnerImpl {
  return new PlanRunnerImpl()
}

export type PlanRunner = PlanRunnerImpl
