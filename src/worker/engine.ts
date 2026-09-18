/**
 * 脚本执行引擎。
 *
 * 执行语义（这一段就是整个 DSL 的行为规范，改之前先想清楚）：
 *  · when 不成立 → **跳过，不算失败**。
 *  · 步骤失败 → 按 retry / retryDelayMs 重试；重试耗尽后按 onFail 处置：
 *      abort（默认）中止整个执行 / continue 忽略继续 / goto 跳到 label / restartApp 冷启动后回脚本开头。
 *  · goto 用 maxTimes 防死循环，loop 用 maxIterations（默认 1000）防死循环，超限则整个执行失败。
 *  · goto 只能跳到**同级或外层**的 label（跳不进 if/loop 的内部），跳不到就是脚本错误。
 *  · script.loop === true 时走完 steps 会按 loopIntervalMs 再来一轮，iteration++。
 *  · 判定节奏按 **3fps** 设计（一次 screencap 就要 ~300ms），不要写需要 10fps 反应的逻辑。
 *  · shotPolicy 决定平时是否留痕；**失败的步骤总是留一张**（除非 shotPolicy=never 或 step.capture=false）。
 */

import { AppError } from '@shared/errors'
import type { Condition, FailPolicy, RunStatus, ScriptStep } from '@shared/script'
import type { WorkerToMain, WorkerToRenderer } from '@shared/worker'
import { execStep } from './actions'
import { describeCondition, evalCondition } from './conditions'
import type { RunContext } from './context'

/** loop 的默认硬上限。 */
const DEFAULT_MAX_ITERATIONS = 1000
/** goto 的默认硬上限。 */
const DEFAULT_MAX_GOTO = 1000
/** 单个 block 内允许执行的步骤次数上限，用来兜住 label + goto 构成的死循环。 */
const MAX_BLOCK_STEPS = 200_000
/** 重试之间的默认间隔。 */
const DEFAULT_RETRY_DELAY_MS = 800
/** onFail=restartApp 允许触发的最大次数，超过说明这个脚本根本跑不通。 */
const MAX_RESTARTS = 10
/** 冷启动后等应用起来的固定时间。 */
const RESTART_SETTLE_MS = 8000

type StepOutcome =
  | { type: 'next' }
  | { type: 'goto'; label: string; fromStepId: string }
  | { type: 'stop' }
  | { type: 'restart'; fromStepId: string }

type BlockOutcome = Exclude<StepOutcome, { type: 'next' }> | { type: 'done' }

export class Engine {
  private stopping = false
  private finished = false
  private readonly gotoCounts = new Map<string, number>()

  constructor(
    private readonly ctx: RunContext,
    private readonly emit: (m: WorkerToRenderer) => void,
    private readonly report: (m: WorkerToMain) => void
  ) {}

  // ── 外部控制 ────────────────────────────────────────────────────────────

  pause(): void {
    if (this.finished || this.stopping) return
    this.ctx.paused = true
    this.setStatus('paused')
    this.ctx.log('info', '已暂停（当前步骤跑完后挂起）。')
  }

  resume(): void {
    if (this.finished || this.stopping || !this.ctx.paused) return
    this.ctx.paused = false
    this.setStatus('running')
    this.ctx.log('info', '已继续。')
  }

  /** 优雅停止：跑完当前步骤就退出。主进程会在超时后 kill() 兜底。 */
  stop(): void {
    if (this.finished || this.stopping) return
    this.stopping = true
    this.ctx.paused = false
    this.ctx.aborted = true // 让所有 sleep / 取帧立刻返回
    this.setStatus('stopping')
    this.ctx.log('info', '收到停止指令，正在收尾。')
  }

  // ── 主流程 ──────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    const ctx = this.ctx
    ctx.snapshot.startedAt = Date.now()
    this.setStatus('running')
    ctx.log(
      'info',
      `开始执行脚本「${ctx.script.name}」v${ctx.script.version}（实例 ${ctx.instanceIndex} / ${ctx.serial}）` +
        `${ctx.snapshot.accountName ? `，账号：${ctx.snapshot.accountName}` : ''}`,
      { scriptId: ctx.script.id, params: ctx.params }
    )

    let restarts = 0
    try {
      for (;;) {
        this.gotoCounts.clear()
        ctx.snapshot.stepDone = 0
        const outcome = await this.runBlock(ctx.script.steps, true)

        if (outcome.type === 'stop') break

        if (outcome.type === 'restart') {
          restarts += 1
          if (restarts > MAX_RESTARTS) {
            throw new AppError(
              'STEP_FAILED',
              `已按 onFail=restartApp 重启应用 ${MAX_RESTARTS} 次仍然过不去，判定为脚本或环境有问题，停止执行。`,
              { fromStepId: outcome.fromStepId }
            )
          }
          await this.restartApp(restarts)
          continue // 回脚本开头重跑本轮
        }

        if (outcome.type === 'goto') {
          throw new AppError(
            'SCRIPT_INVALID',
            `步骤「${outcome.fromStepId}」要跳到 label「${outcome.label}」，但顶层脚本里没有这个 label（goto 只能跳到同级或外层）。`,
            { stepId: outcome.fromStepId, label: outcome.label }
          )
        }

        // 本轮正常跑完
        if (!ctx.script.loop || this.stopping) break
        ctx.snapshot.iteration += 1
        const gap = ctx.script.loopIntervalMs ?? 0
        ctx.log('info', `第 ${ctx.snapshot.iteration} 轮结束，${gap}ms 后开始下一轮。`)
        this.setStatus('running')
        await ctx.sleep(gap)
        if (this.stopping) break
      }

      this.finish(this.stopping ? 'aborted' : 'succeeded', null)
    } catch (e) {
      const err = AppError.from(e, 'UNKNOWN')
      // 停止过程中抛出来的取消异常不算失败。
      if (this.stopping && (err.code === 'CANCELLED' || err.code === 'RUN_ABORTED')) {
        this.finish('aborted', null)
      } else {
        ctx.log('error', `执行失败：${err.message}`, { code: err.code, ...(err.detail ?? {}) })
        this.finish('failed', err.message)
      }
    }
  }

  // ── 块与步骤 ────────────────────────────────────────────────────────────

  /**
   * 执行一段步骤序列。
   * @param top 是否是脚本顶层（顶层才计入 stepDone 进度）
   */
  private async runBlock(steps: readonly ScriptStep[], top: boolean): Promise<BlockOutcome> {
    let i = 0
    let guard = 0

    while (i < steps.length) {
      if (this.stopping) return { type: 'stop' }
      if (++guard > MAX_BLOCK_STEPS) {
        throw new AppError(
          'STEP_FAILED',
          `单个步骤序列已执行 ${MAX_BLOCK_STEPS} 次仍未结束，判定为死循环（多半是 goto 跳回了自己前面）。`
        )
      }

      const step = steps[i]
      const outcome = await this.runStep(step)

      if (outcome.type === 'next') {
        if (top) {
          this.ctx.snapshot.stepDone += 1
          this.ctx.publishStatus()
        }
        i += 1
        continue
      }
      if (outcome.type === 'stop' || outcome.type === 'restart') return outcome

      // goto：先在本层找 label，找不到就冒泡给外层。
      const idx = steps.findIndex((s) => s.kind === 'label' && s.label === outcome.label)
      if (idx < 0) return outcome
      this.ctx.log('info', `跳转到 label「${outcome.label}」`, undefined, {
        stepId: outcome.fromStepId
      })
      i = idx
    }
    return { type: 'done' }
  }

  private async runStep(step: ScriptStep): Promise<StepOutcome> {
    const ctx = this.ctx
    if (this.stopping) return { type: 'stop' }
    await ctx.waitWhilePaused()
    if (this.stopping) return { type: 'stop' }

    const t0 = Date.now()
    ctx.snapshot.currentStepId = step.id
    ctx.snapshot.currentStepName = step.name ?? step.kind
    ctx.publishStatus()

    // ── when：不成立就跳过，不算失败 ──
    if (step.when) {
      const r = await evalCondition(ctx, step.when)
      if (!r.ok) {
        ctx.log(
          'debug',
          `跳过步骤（when 不成立：${describeCondition(step.when)}${r.reason ? ` —— ${r.reason}` : ''}）`,
          undefined,
          { stepId: step.id }
        )
        return { type: 'next' }
      }
    }

    // ── 控制流 ──
    switch (step.kind) {
      case 'label':
        return { type: 'next' }

      case 'goto': {
        const n = (this.gotoCounts.get(step.id) ?? 0) + 1
        this.gotoCounts.set(step.id, n)
        const max = step.maxTimes ?? DEFAULT_MAX_GOTO
        if (n > max) {
          throw new AppError(
            'STEP_FAILED',
            `goto「${step.label}」已经跳了 ${max} 次（maxTimes 上限），判定为死循环，停止执行。`,
            { stepId: step.id }
          )
        }
        return { type: 'goto', label: step.label, fromStepId: step.id }
      }

      case 'if': {
        const r = await evalCondition(ctx, step.cond)
        ctx.log(
          'debug',
          `if 条件${r.ok ? '成立' : '不成立'}：${describeCondition(step.cond)}`,
          undefined,
          {
            stepId: step.id
          }
        )
        const branch = r.ok ? step.then : (step.else ?? [])
        const o = await this.runBlock(branch, false)
        return o.type === 'done' ? { type: 'next' } : o
      }

      case 'loop': {
        const maxIter = step.maxIterations ?? DEFAULT_MAX_ITERATIONS
        for (let n = 0; ; n++) {
          if (this.stopping) return { type: 'stop' }
          if (step.repeat !== undefined && n >= step.repeat) break
          if (n >= maxIter) {
            throw new AppError(
              'STEP_FAILED',
              `循环步骤「${step.name ?? step.id}」达到硬上限 ${maxIter} 次仍未结束，停止执行。` +
                '请给它设置 repeat 或一个迟早会不成立的 while 条件。',
              { stepId: step.id }
            )
          }
          if (step.while) {
            ctx.invalidateFrame()
            const r = await evalCondition(ctx, step.while)
            if (!r.ok) {
              ctx.log(
                'debug',
                `循环结束（while 不成立：${r.reason ?? ''}），共 ${n} 轮。`,
                undefined,
                {
                  stepId: step.id
                }
              )
              break
            }
          }
          const o = await this.runBlock(step.steps, false)
          if (o.type !== 'done') return o
        }
        return { type: 'next' }
      }

      default:
        break
    }

    // ── 普通动作：执行 + 重试 ──
    const retry = Math.max(0, step.retry ?? 0)
    let lastErr: AppError | null = null

    for (let attempt = 0; attempt <= retry; attempt++) {
      try {
        await withTimeout(execStep(ctx, step), step.timeoutMs, step)
        lastErr = null
        break
      } catch (e) {
        if (this.stopping || ctx.aborted) return { type: 'stop' }
        lastErr = AppError.from(e, 'STEP_FAILED')
        if (attempt < retry) {
          ctx.snapshot.stats.retries += 1
          ctx.log(
            'warn',
            `步骤「${step.name ?? step.id}」第 ${attempt + 1} 次失败：${lastErr.message} —— 准备重试（还剩 ${retry - attempt} 次）。`,
            undefined,
            { stepId: step.id }
          )
          await ctx.sleep(step.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
          ctx.invalidateFrame()
          if (this.stopping || ctx.aborted) return { type: 'stop' }
        }
      }
    }

    // ── AI 兜底：重试都用完了，让顾问看一眼再决定要不要判失败 ──
    //   onFail=continue 的步骤跳过：作者已经明说了「这一步失败就算了」，
    //   为它去问一次视觉大模型既费钱又费时间。
    if (
      lastErr &&
      ctx.consultAi &&
      (step.onFail?.kind ?? 'abort') !== 'continue' &&
      !this.stopping &&
      !ctx.aborted
    ) {
      const assisted = await this.consultAndRetry(step, lastErr)
      if (assisted.retried) {
        lastErr = assisted.error
        if (!lastErr) {
          // AI 清掉障碍后这一步成功了，按正常成功收尾。
          ctx.snapshot.stats.lastTickMs = Date.now() - t0
          if (step.afterDelayMs) await ctx.sleep(step.afterDelayMs)
          return { type: 'next' }
        }
      }
    }

    if (lastErr) return this.handleFailure(step, lastErr)

    // ── 成功收尾 ──
    if (
      step.capture === true ||
      (step.capture === undefined && ctx.settings.shotPolicy === 'always')
    ) {
      const shot = await ctx.shot(`${step.id}-ok`)
      ctx.log('debug', `步骤完成留痕`, undefined, { stepId: step.id, shot: shot ?? undefined })
    }
    if (step.afterDelayMs) await ctx.sleep(step.afterDelayMs)

    ctx.snapshot.stats.lastTickMs = Date.now() - t0
    return { type: 'next' }
  }

  /**
   * ★ AI 介入：某一步重试耗尽 → 请主进程的视觉大模型看一眼当前画面 →
   * 它把挡路的东西（多半是活动弹窗）关掉了，就再给这一步一次机会。
   *
   * 三条边界：
   *   · 每一步只问一次。问完还不行就老老实实按 onFail 处置 —— 顾问是兜底，不是无限续命。
   *   · 顾问说「需要人处理」（风险过高 / 游戏在更新）时不再重试，直接带着原因判失败。
   *   · 顾问端口**不抛异常**（runner 的适配层保证），所以这里不用 try/catch 兜底也不会炸；
   *     真抛了也只是让这一步按原错误失败，不会比没有 AI 更糟。
   */
  private async consultAndRetry(
    step: ScriptStep,
    err: AppError
  ): Promise<{ retried: boolean; error: AppError | null }> {
    const ctx = this.ctx
    if (!ctx.consultAi) return { retried: false, error: err }

    const stepName = step.name ?? step.id
    // ★ 这条是 debug：AI 没开时每个失败步骤都会走一遍这里（主进程那边才知道开没开），
    //   打成 info 会把运行日志刷满没用的「正在请 AI…」。
    ctx.log('debug', `步骤「${stepName}」重试耗尽，问一下 AI 顾问…`, undefined, {
      stepId: step.id
    })

    const res = await ctx.consultAi({
      stepId: step.id,
      reason: `步骤「${stepName}」重试 ${Math.max(0, step.retry ?? 0)} 次后仍然失败：${err.message}`,
      expectTemplateIds: expectedTemplateIds(step)
    })

    if (res.requiresAttention) {
      ctx.log('error', `AI 顾问判定需要人工处理：${res.message}`, undefined, { stepId: step.id })
      return { retried: false, error: AppError.from(new Error(res.message), 'AI_RISK_BLOCKED') }
    }
    if (!res.handled) {
      // 同理：没介入是常态（AI 没开、限频、没有低风险动作可做），别刷屏。
      ctx.log('debug', `AI 顾问没有介入：${res.message}`, undefined, { stepId: step.id })
      return { retried: false, error: err }
    }

    ctx.log(
      'info',
      `AI 顾问已处理：${res.message}${res.harvestedTemplateId ? `（并学到模板「${res.harvestedTemplateId}」）` : ''} —— 重试这一步。`,
      undefined,
      { stepId: step.id }
    )
    // 画面被主进程动过，缓存的那一帧一定过期了。
    ctx.invalidateFrame()
    if (this.stopping || ctx.aborted) return { retried: false, error: err }

    try {
      await withTimeout(execStep(ctx, step), step.timeoutMs, step)
      ctx.log('info', `AI 介入后步骤「${stepName}」成功。`, undefined, { stepId: step.id })
      return { retried: true, error: null }
    } catch (e) {
      const again = AppError.from(e, 'STEP_FAILED')
      ctx.log('warn', `AI 介入后重试仍然失败：${again.message}`, undefined, { stepId: step.id })
      return { retried: true, error: again }
    }
  }

  /** 重试耗尽后的处置。 */
  private async handleFailure(step: ScriptStep, err: AppError): Promise<StepOutcome> {
    const ctx = this.ctx
    const policy: FailPolicy = step.onFail ?? { kind: 'abort' }

    // 失败现场比什么日志都值钱：除非显式关掉，否则总留一张。
    let shot: string | null = null
    if (ctx.settings.shotPolicy !== 'never' && step.capture !== false) {
      shot = await ctx.shot(`fail-${step.id}`)
    }
    ctx.log(
      'error',
      `步骤「${step.name ?? step.id}」失败：${err.message}`,
      { code: err.code, ...(err.detail ?? {}) },
      { stepId: step.id, shot: shot ?? undefined }
    )

    switch (policy.kind) {
      case 'continue':
        ctx.log('warn', '按 onFail=continue 忽略该失败，继续下一步。', undefined, {
          stepId: step.id
        })
        return { type: 'next' }
      case 'goto':
        ctx.log('warn', `按 onFail=goto 跳到 label「${policy.label}」。`, undefined, {
          stepId: step.id
        })
        return { type: 'goto', label: policy.label, fromStepId: step.id }
      case 'restartApp':
        ctx.log('warn', '按 onFail=restartApp 冷启动应用后回到脚本开头。', undefined, {
          stepId: step.id
        })
        return { type: 'restart', fromStepId: step.id }
      case 'abort':
      default:
        throw err
    }
  }

  /** onFail=restartApp：强停 + 冷启动 + 等它起来。 */
  private async restartApp(nth: number): Promise<void> {
    const ctx = this.ctx
    const pkg = ctx.script.packageName
    if (!pkg) {
      throw new AppError(
        'SCRIPT_INVALID',
        'onFail=restartApp 需要脚本头部设置 packageName，否则不知道该重启哪个应用。'
      )
    }
    ctx.log('warn', `第 ${nth} 次重启应用 ${pkg}…`)
    await ctx.device.stopApp(ctx.serial, pkg)
    await ctx.sleep(2000)
    await ctx.device.launchApp(ctx.serial, pkg, true)
    ctx.invalidateFrame()
    ctx.invalidateForeground()
    await ctx.sleep(RESTART_SETTLE_MS)
  }

  // ── 收尾 ────────────────────────────────────────────────────────────────

  private setStatus(status: RunStatus): void {
    this.ctx.snapshot.status = status
    this.ctx.publishStatus()
  }

  private finish(status: RunStatus, error: string | null): void {
    if (this.finished) return
    this.finished = true
    const ctx = this.ctx
    ctx.snapshot.status = status
    ctx.snapshot.endedAt = Date.now()
    ctx.snapshot.error = error
    ctx.snapshot.currentStepId = null
    ctx.snapshot.currentStepName = null

    const secs = Math.round((ctx.snapshot.endedAt - ctx.snapshot.startedAt) / 1000)
    const s = ctx.snapshot.stats
    ctx.log(
      status === 'failed' ? 'error' : 'info',
      `执行${statusText(status)}，耗时 ${secs}s：截图 ${s.captures} 次（均 ${s.avgCaptureMs}ms）、` +
        `匹配 ${s.matches} 次命中 ${s.matchHits} 次、点击 ${s.taps} 次、重试 ${s.retries} 次。`
    )
    // 先把日志发出去，再发终态，保证面板拿到的最后一条日志不丢。
    ctx.logger.flush()

    const snapshot = ctx.snapshotCopy()
    this.emit({ type: 'status', snapshot })
    this.report({ type: 'status', snapshot })
    this.report({ type: 'finished', snapshot })
    this.emit({ type: 'closed', runId: ctx.runId, reason: statusText(status) })
  }
}

/**
 * 这一步「本来在等什么模板出现」。交给 AI 顾问当复验判据：
 * 它关掉弹窗之后这些模板出现了，才算真的回到了脚本要的界面。
 * 取不出来（tap 固定坐标、swipe 之类）就给空数组 —— 顾问会退化成只看画面有没有变。
 */
function expectedTemplateIds(step: ScriptStep): string[] {
  const out: string[] = []
  const fromCond = (c: Condition): void => {
    switch (c.kind) {
      case 'template':
        if (c.present !== false) out.push(c.templateId)
        break
      case 'anyTemplate':
        out.push(...c.templateIds)
        break
      case 'and':
        for (const sub of c.all) fromCond(sub)
        break
      case 'or':
        for (const sub of c.any) fromCond(sub)
        break
      default:
        // not / foreground / always / never 里没有「该出现的模板」，跳过。
        break
    }
  }
  if (step.kind === 'tapTemplate') out.push(step.templateId)
  else if (step.kind === 'waitFor') fromCond(step.cond)
  return [...new Set(out)]
}

function statusText(s: RunStatus): string {
  switch (s) {
    case 'succeeded':
      return '成功结束'
    case 'failed':
      return '失败'
    case 'aborted':
      return '已被手动停止'
    default:
      return s
  }
}

/**
 * 步骤级超时。
 * 注意：超时只是让引擎不再等下去，底层那次 adb 调用仍会自己跑完
 * （adb 子进程有自己的超时），不会留下僵尸进程。
 */
function withTimeout<T>(p: Promise<T>, ms: number | undefined, step: ScriptStep): Promise<T> {
  if (!ms || ms <= 0) return p
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AppError('TIMEOUT', `步骤「${step.name ?? step.id}」超过 ${ms}ms 仍未完成。`, {
          stepId: step.id
        })
      )
    }, ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}
