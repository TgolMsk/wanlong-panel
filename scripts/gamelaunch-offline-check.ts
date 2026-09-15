/**
 * 冷启动恢复（`src/main/game/launch.ts`）的离线自检：不碰模拟器、不起进程，
 * 用假的 adb 能力 + 虚拟时钟验证 ensureGameForeground 的每一条分支——
 *   · 游戏已在前台 -> 'foreground'，且**一次都不拉起**（这条最重要：误拉会把玩家正在看的界面顶掉）
 *   · 游戏没跑 / 退到后台 -> 拉起并等到前台 -> 'launched'
 *   · 拉起失败、等不到前台 -> 'failed'，且**不抛异常**（它被写在兜底阶梯里，自己炸掉只会更糟）
 *   · 查询类能力（前台包名 / 进程存活）抛错时照样能继续
 *   · 超时按注入的时钟精确判定，不做真实等待
 *
 *   npm run check:launch
 */

import {
  DEFAULT_FOREGROUND_POLL_MS,
  DEFAULT_FOREGROUND_TIMEOUT_MS,
  ensureGameForeground,
  type GameLaunchIo,
  type GamePresence
} from '@main/game/launch'

const PKG = 'com.lilithgames.samo.android.cn'
const LAUNCHER = 'app.lawnchair'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

interface FakeOpts {
  /** 每次调 foreground() 依次返回这些值；用完后一直返回最后一个。 */
  foregrounds: (string | null)[]
  /** isRunning() 的答案；'throw' 表示抛错；undefined 表示压根不接这个能力。 */
  running?: boolean | 'throw'
  /** foreground() 第几次调用抛错（1 起）。 */
  foregroundThrowsAt?: number
  launchThrows?: boolean
}

interface Fake {
  io: GameLaunchIo
  launches: number
  elapsedMs: () => number
  logs: string[]
}

/** 虚拟时钟：sleep 只推进时间，不真等；整个自检瞬间跑完。 */
function makeFake(o: FakeOpts): Fake {
  let clock = 1_000_000
  let fgCalls = 0
  const state = { launches: 0 }
  const logs: string[] = []
  const io: GameLaunchIo = {
    foreground: async () => {
      fgCalls += 1
      if (o.foregroundThrowsAt === fgCalls) throw new Error('dumpsys 挂了')
      return o.foregrounds[Math.min(fgCalls - 1, o.foregrounds.length - 1)] ?? null
    },
    launch: async () => {
      state.launches += 1
      if (o.launchThrows) throw new Error('monkey: No activities found')
    },
    isRunning:
      o.running === undefined
        ? undefined
        : async () => {
            if (o.running === 'throw') throw new Error('pidof 挂了')
            return o.running as boolean
          },
    log: (level, message) => logs.push(`${level}:${message}`),
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock
  }
  return {
    io,
    get launches() {
      return state.launches
    },
    elapsedMs: () => clock - 1_000_000,
    logs
  }
}

async function run(o: FakeOpts, opts = {}): Promise<{ r: GamePresence; f: Fake }> {
  const f = makeFake(o)
  const r = await ensureGameForeground(f.io, { packageName: PKG, ...opts })
  return { r, f }
}

// ── 1. 游戏已经在前台 ────────────────────────────────────────────────────

console.log('【一、游戏已在前台：什么都不做】')
{
  const { r, f } = await run({ foregrounds: [PKG] })
  check('返回 foreground', r === 'foreground', r)
  check(
    '★ 一次都没拉起（误拉会把玩家正在看的界面顶掉）',
    f.launches === 0,
    `launches=${f.launches}`
  )
  check('没有白等', f.elapsedMs() === 0, `${f.elapsedMs()}ms`)
  check('没有 isRunning 能力时也照常判定', (await run({ foregrounds: [PKG] })).r === 'foreground')
}

// ── 2. 游戏没跑 / 退到后台 ───────────────────────────────────────────────

console.log('【二、拉起并等到前台】')
{
  // 桌面 -> 拉起 -> 第 2 次轮询才到前台
  const { r, f } = await run({ foregrounds: [LAUNCHER, LAUNCHER, PKG], running: false })
  check('返回 launched', r === 'launched', r)
  check('拉起了一次', f.launches === 1, `launches=${f.launches}`)
  check(
    '等到前台才返回（两轮轮询）',
    f.elapsedMs() === DEFAULT_FOREGROUND_POLL_MS * 2,
    `${f.elapsedMs()}ms`
  )
  check(
    '进程不在时日志说「用 monkey 拉起」',
    f.logs.some((l) => l.includes('monkey')),
    f.logs[0] ?? ''
  )

  // 进程还在、只是退到了后台：措辞不同，动作一样
  const back = await run({ foregrounds: [LAUNCHER, PKG], running: true })
  check('后台 -> launched', back.r === 'launched' && back.f.launches === 1)
  check(
    '进程还在时日志说「切到前台」',
    back.f.logs.some((l) => l.includes('切到前台')),
    back.f.logs[0] ?? ''
  )

  // 前台包名读不出来（null）也照样拉
  const unknown = await run({ foregrounds: [null, PKG], running: false })
  check('前台未知 -> 照样拉起', unknown.r === 'launched' && unknown.f.launches === 1)
}

// ── 3. 失败分支 ──────────────────────────────────────────────────────────

console.log('【三、失败时不抛异常】')
{
  const { r, f } = await run({ foregrounds: [LAUNCHER], launchThrows: true, running: false })
  check('拉起抛错 -> failed（不抛出去）', r === 'failed', r)
  check('不再轮询等待', f.elapsedMs() === 0, `${f.elapsedMs()}ms`)
  check(
    '日志记下了原因',
    f.logs.some((l) => l.includes('拉起游戏失败')),
    f.logs.join(' | ').slice(0, 80)
  )

  // 拉起成功但前台一直回不来
  const stuck = await run({ foregrounds: [LAUNCHER], running: false })
  check('等不到前台 -> failed', stuck.r === 'failed', stuck.r)
  check(
    '正好等到超时为止',
    stuck.f.elapsedMs() >= DEFAULT_FOREGROUND_TIMEOUT_MS &&
      stuck.f.elapsedMs() < DEFAULT_FOREGROUND_TIMEOUT_MS + DEFAULT_FOREGROUND_POLL_MS,
    `${stuck.f.elapsedMs()}ms / 上限 ${DEFAULT_FOREGROUND_TIMEOUT_MS}ms`
  )
  check(
    '超时日志带上了当前前台',
    stuck.f.logs.some((l) => l.includes(LAUNCHER)),
    stuck.f.logs.at(-1) ?? ''
  )
}

// ── 4. 查询类能力抛错时的韧性 ────────────────────────────────────────────

console.log('【四、查询抛错不影响恢复】')
{
  // 第一次 foreground() 就抛：按「未知」处理，照样拉起
  const { r, f } = await run({ foregrounds: [PKG], foregroundThrowsAt: 1, running: false })
  check('首次查前台抛错 -> 仍然拉起', r === 'launched' && f.launches === 1, r)

  // isRunning 抛错：只影响日志措辞
  const ir = await run({ foregrounds: [LAUNCHER, PKG], running: 'throw' })
  check('isRunning 抛错 -> 仍然 launched', ir.r === 'launched' && ir.f.launches === 1, ir.r)

  // 轮询中途 foreground() 抛错：那一轮当作没到前台，继续等
  const mid = await run({
    foregrounds: [LAUNCHER, LAUNCHER, PKG],
    foregroundThrowsAt: 2,
    running: false
  })
  check('轮询中途抛错 -> 继续等到前台', mid.r === 'launched', mid.r)
}

// ── 5. 参数 ──────────────────────────────────────────────────────────────

console.log('【五、超时与轮询间隔可配】')
{
  const f = makeFake({ foregrounds: [LAUNCHER], running: false })
  const r = await ensureGameForeground(f.io, {
    packageName: PKG,
    foregroundTimeoutMs: 10_000,
    pollMs: 1_000
  })
  check(
    '自定义超时生效',
    r === 'failed' && f.elapsedMs() >= 10_000 && f.elapsedMs() <= 11_000,
    `${f.elapsedMs()}ms`
  )

  // 轮询间隔有下限，传 0 不会变成死循环
  const z = makeFake({ foregrounds: [LAUNCHER], running: false })
  await ensureGameForeground(z.io, { packageName: PKG, foregroundTimeoutMs: 1_000, pollMs: 0 })
  check('pollMs 有下限（不会空转）', z.elapsedMs() >= 1_000, `${z.elapsedMs()}ms`)
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
if (fail > 0) process.exitCode = 1
