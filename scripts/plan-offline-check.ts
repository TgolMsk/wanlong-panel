/**
 * 任务计划（账号勾选脚本 + 运行时间）的**离线**自检。
 *
 * ★★ 全程不碰模拟器、不发一条 adb 命令、不起一个 utilityProcess：
 *     · 编排器是假的（startRun 只记账，执行结束由剧本自己触发）
 *     · 采集调度器是假的（只记录「让路 / 放回」的调用顺序）
 *     · 数据目录是 os.tmpdir() 下的临时目录，跑完就扔
 *
 * 跑法（工程根目录）：
 *     npm run check:plan
 *
 * 覆盖的东西：
 *   一、触发时刻的纯函数（★ 北京时间，宿主机时区必须影响不了结果）
 *   二、plans.json 的容错读写（手改坏了也不能让面板起不来）
 *   三、端到端：到点 → 入队 → **先让路再启动** → 执行 → 记账 → 排下一次
 *   四、队列：每实例串行、按优先级、等太久跳过
 *   五、失败重试 / 并发退避 / 单次时间上限
 *   六、开关：总开关、账号开关、任务勾选框，关掉就不该再自动跑
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Account } from '@shared/domain'
import { AppError } from '@shared/errors'
import type { RunHandle, RunSnapshot, ScriptMeta, StartRunRequest } from '@shared/script'
import {
  PLAN_FILE,
  cstDayStartOf,
  describeTrigger,
  inClockWindow,
  nextFireAt,
  parseClock,
  previousFireAt,
  type AccountPlan,
  type PlanTask,
  type TaskTrigger
} from '@shared/plan'
import { createPlanRunner, type PlanDeps } from '@main/plan/index'
import { resetPlanIpc } from '@main/plan/ipc'
import { loadPlanFile, savePlanFile } from '@main/plan/store'

// ── 断言小工具 ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n【${title}】`)
}

const MIN = 60_000
const HOUR = 3_600_000

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 等某个条件成立；超时返回 false（让断言给出可读的失败，而不是整个自检挂住）。 */
async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (fn()) return true
    await delay(20)
  }
  return fn()
}

// ═══════════════════════════════════════════════════════════════════════════
// 一、触发时刻（纯函数）
// ═══════════════════════════════════════════════════════════════════════════

function checkTriggers(): void {
  section('一、触发时刻（北京时间，纯函数）')

  ok('parseClock 认得 08:30', parseClock('08:30') === 8 * HOUR + 30 * MIN)
  ok('parseClock 拒绝 24:00', parseClock('24:00') === null)
  ok('parseClock 拒绝 8:5', parseClock('8:5') === null)

  // ★ 时区实测：北京 08:00 = UTC 00:00。宿主机在洛杉矶也必须算出同一个绝对时刻。
  const utcNoon = Date.UTC(2026, 8, 18, 12, 0) // 北京 2026-09-18 20:00
  const daily: TaskTrigger = { kind: 'daily', at: ['08:00', '20:30'] }
  const next = nextFireAt(daily, utcNoon, null)
  ok(
    '每天 08:00/20:30：北京 20:00 时下一次是当天 20:30',
    next === Date.UTC(2026, 8, 18, 12, 30),
    next == null ? 'null' : new Date(next).toISOString()
  )
  const afterAll = nextFireAt(daily, Date.UTC(2026, 8, 18, 13, 0), null) // 北京 21:00
  ok(
    '当天时刻都过了就排明天最早那个',
    afterAll === Date.UTC(2026, 8, 19, 0, 0),
    afterAll == null ? 'null' : new Date(afterAll).toISOString()
  )
  ok(
    'previousFireAt 取今天已过的最晚一个',
    previousFireAt(daily, utcNoon) === Date.UTC(2026, 8, 18, 0, 0)
  )
  ok(
    '今天一个都没到时，previousFireAt 取昨天最后一个',
    previousFireAt(daily, Date.UTC(2026, 8, 17, 23, 0)) === Date.UTC(2026, 8, 17, 12, 30)
  )
  ok(
    'cstDayStartOf 落在北京 0 点',
    cstDayStartOf(utcNoon) === Date.UTC(2026, 8, 17, 16, 0),
    new Date(cstDayStartOf(utcNoon)).toISOString()
  )

  const every: TaskTrigger = { kind: 'interval', everyMinutes: 30 }
  ok('间隔触发：从没跑过就是现在', nextFireAt(every, utcNoon, null) === utcNoon)
  ok('间隔触发：上次 + 间隔', nextFireAt(every, utcNoon, utcNoon - 10 * MIN) === utcNoon + 20 * MIN)
  ok('间隔触发：早该跑了就立刻跑', nextFireAt(every, utcNoon, utcNoon - 5 * HOUR) === utcNoon)

  const windowed: TaskTrigger = {
    kind: 'interval',
    everyMinutes: 30,
    window: { from: '09:00', to: '23:00' }
  }
  // 北京 03:00（UTC 前一天 19:00）在窗口外，应推到当天 09:00。
  const nightly = Date.UTC(2026, 8, 17, 19, 0)
  ok('时段外的间隔任务推到窗口起点', nextFireAt(windowed, nightly, null) === Date.UTC(2026, 8, 18, 1, 0))
  ok('时段内照常跑', nextFireAt(windowed, utcNoon, null) === utcNoon)

  const overnight = { from: '22:00', to: '06:00' }
  ok('跨零点时段：北京 23:00 在内', inClockWindow(Date.UTC(2026, 8, 18, 15, 0), overnight))
  ok('跨零点时段：北京 03:00 在内', inClockWindow(Date.UTC(2026, 8, 17, 19, 0), overnight))
  ok('跨零点时段：北京 12:00 不在内', !inClockWindow(Date.UTC(2026, 8, 18, 4, 0), overnight))

  ok('中文描述：每天', describeTrigger(daily) === '每天 08:00、20:30')
  ok('中文描述：整小时间隔说「小时」', describeTrigger({ kind: 'interval', everyMinutes: 120 }) === '每 2 小时')
  ok('中文描述：仅手动', describeTrigger({ kind: 'manual' }) === '仅手动')
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、落盘容错
// ═══════════════════════════════════════════════════════════════════════════

async function checkStore(dataDir: string): Promise<void> {
  section('二、plans.json 的容错读写')

  const empty = await loadPlanFile(dataDir)
  ok('文件不存在时给默认配置', empty.plans.length === 0 && empty.config.enabled === false)

  await writeFile(join(dataDir, PLAN_FILE), '{ 这不是 JSON', 'utf8')
  const broken = await loadPlanFile(dataDir)
  ok(
    '坏 JSON 不抛异常，退回默认值并给中文原因',
    broken.plans.length === 0 && (broken.loadWarnings?.[0]?.includes('不是合法 JSON') ?? false)
  )

  await writeFile(
    join(dataDir, PLAN_FILE),
    JSON.stringify({
      version: 1,
      config: { enabled: true, retry: 999, preemptGraceMs: -5 },
      plans: [
        {
          accountId: 'acc-1',
          enabled: true,
          tasks: [
            { id: 't1', scriptId: 's1', enabled: true, trigger: { kind: 'daily', at: ['25:00'] } },
            { id: 't1', scriptId: 's2', enabled: true, trigger: { kind: 'manual' } },
            { id: 't2', scriptId: 's3', enabled: true, trigger: { kind: 'interval', everyMinutes: 99999 } },
            { scriptId: 's4' }
          ]
        },
        { accountId: 'acc-1', enabled: false, tasks: [] },
        { enabled: true, tasks: [] }
      ]
    }),
    'utf8'
  )
  const messy = await loadPlanFile(dataDir)
  const plan = messy.plans[0]
  ok('越界的 retry 被夹回上限', messy.config.retry === 5, `retry=${messy.config.retry}`)
  ok('负数的宽限期被夹回 0', messy.config.preemptGraceMs === 0)
  ok('重复的账号只留一份', messy.plans.length === 1)
  ok('重复的任务 id 只留一条', plan.tasks.filter((t) => t.id === 't1').length === 1)
  ok('缺 id 的任务被丢掉', plan.tasks.every((t) => t.id !== undefined && t.scriptId !== 's4'))
  ok(
    '非法时刻的「每天」退回仅手动（宁可不跑，也不按猜的时间乱跑）',
    plan.tasks.find((t) => t.id === 't1')?.trigger.kind === 'manual'
  )
  const interval = plan.tasks.find((t) => t.id === 't2')?.trigger
  ok(
    '越界的间隔被夹回 24 小时',
    interval?.kind === 'interval' && interval.everyMinutes === 24 * 60
  )

  await savePlanFile(dataDir, {
    version: 1,
    config: messy.config,
    plans: messy.plans,
    runtime: [
      {
        accountId: 'acc-1',
        taskId: 't2',
        lastRunAt: 1_700_000_000_000,
        lastEndedAt: 1_700_000_060_000,
        lastResult: 'succeeded',
        lastError: null,
        runs: 3,
        fails: 1
      }
    ]
  })
  const back = await loadPlanFile(dataDir)
  ok(
    '执行记账跨重启保留（补跑判定要靠它）',
    back.runtime?.[0]?.lastRunAt === 1_700_000_000_000 && back.runtime?.[0]?.runs === 3
  )
  const raw = await readFile(join(dataDir, PLAN_FILE), 'utf8')
  ok('写出来的是人能手改的 JSON', raw.includes('"accountId": "acc-1"'))
}

// ═══════════════════════════════════════════════════════════════════════════
// 三～六、计划器端到端（假编排器 + 假调度器）
// ═══════════════════════════════════════════════════════════════════════════

interface FakeWorld {
  deps: PlanDeps
  /** 每次 startRun 的记录。 */
  started: StartRunRequest[]
  /** 调用顺序流水，用来验证「先让路、再启动、最后放回」。 */
  trace: string[]
  stopped: string[]
  /** 让某次执行走到终态。 */
  finish(runId: string, status: RunSnapshot['status'], error?: string): void
  /** 下一次 startRun 抛这个错（模拟并发上限 / 设备没开机）。 */
  failNext(err: AppError | null): void
  /** 让下一次执行在 startRun **返回之前**就走到终态（模拟脚本第一步就失败）。 */
  finishInstantly(status: RunSnapshot['status']): void
}

function makeWorld(dataDir: string, accounts: Account[], scripts: ScriptMeta[]): FakeWorld {
  const started: StartRunRequest[] = []
  const trace: string[] = []
  const stopped: string[] = []
  const listeners = new Set<(s: RunSnapshot) => void>()
  let seq = 0
  let nextError: AppError | null = null
  let instant: RunSnapshot['status'] | null = null

  const snapshots = new Map<string, RunSnapshot>()

  const world: FakeWorld = {
    started,
    trace,
    stopped,
    failNext: (err) => {
      nextError = err
    },
    finishInstantly: (status) => {
      instant = status
    },
    finish: (runId, status, error) => {
      const s = snapshots.get(runId)
      if (!s) return
      const next: RunSnapshot = { ...s, status, endedAt: Date.now(), error: error ?? null }
      snapshots.set(runId, next)
      for (const cb of listeners) cb(next)
    },
    deps: {
      dataDir: () => dataDir,
      listAccounts: async () => accounts,
      listScripts: async () => scripts,
      startRun: async (req): Promise<RunHandle> => {
        if (nextError) {
          const e = nextError
          nextError = null
          trace.push(`start-rejected:${req.scriptId}`)
          throw e
        }
        const runId = `run-${++seq}`
        started.push(req)
        trace.push(`start:${req.scriptId}`)
        snapshots.set(runId, {
          runId,
          scriptId: req.scriptId,
          scriptName: req.scriptId,
          instanceIndex: req.instanceIndex,
          serial: '127.0.0.1:16384',
          accountId: req.accountId ?? null,
          accountName: null,
          status: 'running',
          startedAt: Date.now(),
          endedAt: null,
          stepDone: 0,
          stepTotal: 1,
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
        })
        if (instant) {
          const status = instant
          instant = null
          world.finish(runId, status, status === 'failed' ? '第一步就失败了' : undefined)
        }
        return { runId, instanceIndex: req.instanceIndex, scriptId: req.scriptId }
      },
      stopRun: async (runId) => {
        stopped.push(runId)
        trace.push(`stop:${runId}`)
        world.finish(runId, 'aborted')
      },
      onRunChange: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      suspendScheduler: async (index) => {
        trace.push(`yield:${index}`)
        return () => trace.push(`restore:${index}`)
      },
      log: () => undefined
    }
  }
  return world
}

function account(id: string, instanceIndex: number | null): Account {
  return {
    id,
    name: `账号${id}`,
    instanceIndex,
    enabled: true,
    createdAt: 0,
    updatedAt: 0
  }
}

function script(id: string): ScriptMeta {
  return {
    id,
    name: `脚本${id}`,
    version: '1.0.0',
    stepCount: 3,
    updatedAt: 0,
    builtin: false
  }
}

function task(id: string, scriptId: string, patch: Partial<PlanTask> = {}): PlanTask {
  return {
    id,
    scriptId,
    enabled: true,
    trigger: { kind: 'interval', everyMinutes: 60 },
    priority: 50,
    maxRunMinutes: 30,
    ...patch
  }
}

async function seed(dataDir: string, plans: AccountPlan[], enabled = true): Promise<void> {
  await savePlanFile(dataDir, {
    version: 1,
    config: {
      version: 1,
      enabled,
      preemptGraceMs: 0,
      catchUpMs: 30 * MIN,
      queueWaitMs: 30 * MIN,
      retry: 0,
      retryDelayMs: 0,
      aiAssist: true
    },
    plans,
    runtime: []
  })
}

/** 每组剧本都用全新的临时目录 + 全新的计划器实例，互不污染。 */
async function scenario(
  title: string,
  plans: AccountPlan[],
  accounts: Account[],
  scripts: ScriptMeta[],
  body: (w: FakeWorld, runner: ReturnType<typeof createPlanRunner>) => Promise<void>,
  enabled = true
): Promise<void> {
  section(title)
  const dir = await mkdtemp(join(tmpdir(), 'wl-plan-'))
  await seed(dir, plans, enabled)
  const world = makeWorld(dir, accounts, scripts)
  resetPlanIpc()
  const runner = createPlanRunner()
  await runner.init(world.deps)
  try {
    await body(world, runner)
  } finally {
    await runner.stop()
  }
}

async function checkEndToEnd(): Promise<void> {
  // ── 三、到点 → 让路 → 启动 → 记账 ──
  await scenario(
    '三、端到端：到点 → 先让路 → 启动 → 记账',
    [{ accountId: 'a1', enabled: true, tasks: [task('t1', 's1')], updatedAt: 0 }],
    [account('a1', 0)],
    [script('s1')],
    async (w, runner) => {
      ok('到点后自动启动了脚本', await waitFor(() => w.started.length === 1))
      ok(
        '★ 启动之前先让采集调度器让路',
        w.trace.indexOf('yield:0') >= 0 && w.trace.indexOf('yield:0') < w.trace.indexOf('start:s1'),
        w.trace.join(' → ')
      )
      ok('带上了账号 id（日志归档与参数取值要用）', w.started[0]?.accountId === 'a1')
      ok('执行中状态是 running', runner.state().tasks[0]?.phase === 'running')

      w.finish('run-1', 'succeeded')
      ok('跑完记成功', await waitFor(() => runner.state().tasks[0]?.phase === 'done'))
      ok(
        '★ 跑完把调度器放回去',
        w.trace.includes('restore:0'),
        w.trace.join(' → ')
      )
      const row = runner.state().tasks[0]
      ok('记了一次执行', row.runs === 1 && row.fails === 0)
      ok('按间隔排了下一次', row.nextRunAt != null && row.nextRunAt > Date.now())
    }
  )

  // ── 四、队列：每实例串行 + 优先级 ──
  await scenario(
    '四、队列：同一实例串行、按优先级',
    [
      {
        accountId: 'a1',
        enabled: true,
        tasks: [
          task('t-low', 's-low', { priority: 10 }),
          task('t-high', 's-high', { priority: 90 })
        ],
        updatedAt: 0
      }
    ],
    [account('a1', 0)],
    [script('s-low'), script('s-high')],
    async (w, runner) => {
      ok('先跑优先级高的', await waitFor(() => w.started[0]?.scriptId === 's-high'))
      await delay(120)
      ok('第一个没结束前绝不启动第二个', w.started.length === 1, `已启动 ${w.started.length} 个`)
      const queued = runner.state().tasks.find((t) => t.taskId === 't-low')
      ok('另一个在排队中', queued?.phase === 'queued')

      w.finish('run-1', 'succeeded')
      ok('前一个结束后才轮到下一个', await waitFor(() => w.started.length === 2))
      ok('第二个是低优先级那条', w.started[1]?.scriptId === 's-low')
      w.finish('run-2', 'succeeded')
      await waitFor(() => w.trace.filter((x) => x === 'restore:0').length === 2)
      ok(
        '两次执行各让路一次、各放回一次',
        w.trace.filter((x) => x === 'yield:0').length === 2 &&
          w.trace.filter((x) => x === 'restore:0').length === 2,
        w.trace.join(' → ')
      )
    }
  )

  // ── 五、两个实例互不排队 ──
  await scenario(
    '五、不同实例互不排队',
    [
      { accountId: 'a1', enabled: true, tasks: [task('t1', 's1')], updatedAt: 0 },
      { accountId: 'a2', enabled: true, tasks: [task('t2', 's2')], updatedAt: 0 }
    ],
    [account('a1', 0), account('a2', 1)],
    [script('s1'), script('s2')],
    async (w) => {
      ok('两个实例同时开跑', await waitFor(() => w.started.length === 2))
      ok('各自让各自实例的路', w.trace.includes('yield:0') && w.trace.includes('yield:1'))
    }
  )

  // ── 六、并发上限：不算失败，退避重试 ──
  await scenario(
    '六、撞上并发上限只退避，不判失败',
    [{ accountId: 'a1', enabled: true, tasks: [task('t1', 's1')], updatedAt: 0 }],
    [account('a1', 0)],
    [script('s1')],
    async (w, runner) => {
      w.failNext(new AppError('CONCURRENCY_LIMIT', '同时运行的实例已达上限 4 个。'))
      ok('被挡回来了', await waitFor(() => w.trace.includes('start-rejected:s1')))
      await delay(60)
      const row = runner.state().tasks[0]
      ok('仍然留在队列里', row.phase === 'queued', `phase=${row.phase}`)
      ok('不计失败次数', row.fails === 0)
      ok('让出去的路已经放回（不能占着不放）', w.trace.filter((x) => x === 'restore:0').length === 1)
    }
  )

  // ── 七、设备没开机：跳过这一轮，不算失败 ──
  await scenario(
    '七、实例没开机只跳过，不判失败',
    [{ accountId: 'a1', enabled: true, tasks: [task('t1', 's1')], updatedAt: 0 }],
    [account('a1', 0)],
    [script('s1')],
    async (w, runner) => {
      w.failNext(new AppError('DEVICE_NOT_READY', '设备尚未开机完成。'))
      ok(
        '记成「已跳过」',
        await waitFor(() => runner.state().tasks[0]?.phase === 'skipped'),
        runner.state().tasks[0]?.phase
      )
      ok('不计失败次数', runner.state().tasks[0]?.fails === 0)
      ok('中文原因写进了状态', runner.state().tasks[0]?.lastError?.includes('设备尚未开机') === true)
    }
  )

  // ── 八、执行失败 ──
  await scenario(
    '八、脚本执行失败会记账',
    [{ accountId: 'a1', enabled: true, tasks: [task('t1', 's1')], updatedAt: 0 }],
    [account('a1', 0)],
    [script('s1')],
    async (w, runner) => {
      ok('先跑起来', await waitFor(() => w.started.length === 1))
      w.finish('run-1', 'failed', '步骤「点联盟」失败：模板没找到')
      ok('记成失败', await waitFor(() => runner.state().tasks[0]?.phase === 'failed'))
      const row = runner.state().tasks[0]
      ok('失败次数 +1', row.fails === 1)
      ok('失败原因是中文的、能指导操作', row.lastError?.includes('模板没找到') === true)
    }
  )

  // ── 九、开关 ──
  await scenario(
    '九、总开关关掉就只剩手动',
    [{ accountId: 'a1', enabled: true, tasks: [task('t1', 's1')], updatedAt: 0 }],
    [account('a1', 0)],
    [script('s1')],
    async (w, runner) => {
      await delay(150)
      ok('总开关是关的，不会自动跑', w.started.length === 0)
      ok('面板上「下次运行」显示为空', runner.state().tasks[0]?.nextRunAt === null)

      await runner.runNow('a1', 't1')
      ok('★「立即运行」照样能跑（并且照样先让路）', await waitFor(() => w.started.length === 1))
      ok('手动这一次也先让路了', w.trace.indexOf('yield:0') < w.trace.indexOf('start:s1'))

      await runner.saveConfig({ enabled: true })
      w.finish('run-1', 'succeeded')
      ok('开了总开关后恢复排期', await waitFor(() => runner.state().tasks[0]?.nextRunAt != null))
    },
    false
  )

  await scenario(
    '十、任务勾选框与账号开关',
    [
      {
        accountId: 'a1',
        enabled: true,
        tasks: [task('t1', 's1', { enabled: false })],
        updatedAt: 0
      }
    ],
    [account('a1', 0)],
    [script('s1')],
    async (w, runner) => {
      await delay(150)
      ok('没勾选的任务不会自动跑', w.started.length === 0)
      await runner.setTaskEnabled('a1', 't1', true)
      ok('勾上就跑', await waitFor(() => w.started.length === 1))
      w.finish('run-1', 'succeeded')
      await waitFor(() => runner.state().tasks[0]?.phase === 'done')

      await runner.setAccountEnabled('a1', false)
      const row = runner.state().tasks[0]
      ok('账号开关关掉后不再排期', row.nextRunAt === null)
      ok('任务自己的勾选状态保留着', row.enabled === true)
    }
  )

  // ── 十一、没绑实例 ──
  await scenario(
    '十一、账号没绑实例',
    [{ accountId: 'a1', enabled: true, tasks: [task('t1', 's1')], updatedAt: 0 }],
    [account('a1', null)],
    [script('s1')],
    async (w, runner) => {
      await delay(150)
      ok('不会盲目启动', w.started.length === 0)
      let msg = ''
      try {
        await runner.runNow('a1', 't1')
      } catch (e) {
        msg = AppError.from(e).message
      }
      ok('手动运行给出能指导操作的中文提示', msg.includes('没绑定实例'), msg)
    }
  )

  // ── 十二、单次时间上限 ──
  await scenario(
    '十二、超过单次时间上限会被停掉',
    [
      {
        accountId: 'a1',
        enabled: true,
        tasks: [task('t1', 's1', { trigger: { kind: 'manual' } })],
        updatedAt: 0
      }
    ],
    [account('a1', 0)],
    [script('s1')],
    async (w, runner) => {
      // ★ maxRunMinutes 落盘时按分钟取整（产品语义就是分钟粒度），所以这里绕过读盘那一步，
      //   直接把一个亚分钟值塞进内存里的计划，专门验证「超时看门狗」这条路，不必真等一分钟。
      await runner.savePlan({
        accountId: 'a1',
        enabled: true,
        tasks: [task('t1', 's1', { trigger: { kind: 'manual' }, maxRunMinutes: 0.01 })],
        updatedAt: Date.now()
      })
      await runner.runNow('a1', 't1')
      ok('先跑起来', await waitFor(() => w.started.length === 1))
      ok('到点被停掉', await waitFor(() => w.stopped.length === 1, 4000), w.trace.join(' → '))
      ok(
        '停掉之后路也放回去了',
        await waitFor(() => w.trace.includes('restore:0')),
        w.trace.join(' → ')
      )
      ok(
        '状态不是永远卡在「执行中」',
        await waitFor(() => runner.state().tasks[0]?.phase !== 'running'),
        runner.state().tasks[0]?.phase
      )
    }
  )

  // ── 十二之二、终态比 awaitRun 还快 ──
  await scenario(
    '十二之二、执行结束得比登记还快也要记上账',
    [{ accountId: 'a1', enabled: true, tasks: [task('t1', 's1')], updatedAt: 0 }],
    [account('a1', 0)],
    [script('s1')],
    async (w, runner) => {
      w.finishInstantly('failed')
      ok(
        '★ 不会卡在「执行中」干等时间上限',
        await waitFor(() => runner.state().tasks[0]?.phase === 'failed'),
        runner.state().tasks[0]?.phase
      )
      ok('原因也记上了', runner.state().tasks[0]?.lastError?.includes('第一步就失败') === true)
      ok('路照样放回去了', w.trace.includes('restore:0'))
    }
  )

  // ── 十二之三、失败重试 ──
  await scenario(
    '十二之三、失败后按配置重试',
    [{ accountId: 'a1', enabled: true, tasks: [task('t1', 's1', { trigger: { kind: 'manual' } })], updatedAt: 0 }],
    [account('a1', 0)],
    [script('s1')],
    async (w, runner) => {
      await runner.saveConfig({ retry: 1, retryDelayMs: 0 })
      await runner.runNow('a1', 't1')
      ok('先跑一次', await waitFor(() => w.started.length === 1))
      w.finish('run-1', 'failed', '模板没找到')
      ok('★ 失败后自动重试了一次', await waitFor(() => w.started.length === 2), `共 ${w.started.length} 次`)
      w.finish('run-2', 'failed', '模板还是没找到')
      await delay(300)
      ok('重试次数用完就不再试', w.started.length === 2, `共 ${w.started.length} 次`)
      ok('失败计数是两次', runner.state().tasks[0]?.fails === 2)
    }
  )

  // ── 十三、补跑窗口 ──
  await scenario(
    '十三、错过太久的触发点不补跑',
    [
      {
        accountId: 'a1',
        enabled: true,
        tasks: [
          // 两小时前的北京时刻：超出默认 30 分钟的补跑窗口。
          task('t1', 's1', {
            trigger: { kind: 'daily', at: [clockOffsetFromNow(-2 * HOUR)] }
          })
        ],
        updatedAt: 0
      }
    ],
    [account('a1', 0)],
    [script('s1')],
    async (w, runner) => {
      await delay(150)
      ok('不补跑', w.started.length === 0)
      ok('直接排到下一次（明天同一时刻）', runner.state().tasks[0]?.nextRunAt != null)
    }
  )

  await scenario(
    '十四、刚错过一会儿的触发点会补跑',
    [
      {
        accountId: 'a1',
        enabled: true,
        tasks: [
          task('t1', 's1', { trigger: { kind: 'daily', at: [clockOffsetFromNow(-5 * MIN)] } })
        ],
        updatedAt: 0
      }
    ],
    [account('a1', 0)],
    [script('s1')],
    async (w) => {
      ok('5 分钟前错过的这一轮补跑了', await waitFor(() => w.started.length === 1))
    }
  )
}

/** 从现在往前/往后推一段时间，得到那一刻的北京 'HH:MM'。 */
function clockOffsetFromNow(deltaMs: number): string {
  const at = Date.now() + deltaMs
  const offset = at - cstDayStartOf(at)
  const h = Math.floor(offset / HOUR)
  const m = Math.floor((offset % HOUR) / MIN)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('===== 任务计划离线自检（不碰模拟器、不起执行器）=====')
  checkTriggers()
  const dir = await mkdtemp(join(tmpdir(), 'wl-plan-store-'))
  await checkStore(dir)
  await checkEndToEnd()

  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
  if (fail > 0) process.exitCode = 1
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
