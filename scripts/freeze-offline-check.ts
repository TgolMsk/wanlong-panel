/**
 * 卡死看门狗（src/main/alerts/freeze.ts）+ 自动重启恢复（src/main/alerts/freezeRecovery.ts）的**离线**自检。
 *
 * ★★ 全程不碰模拟器、不发一条 adb 命令：帧是合成的，驱动 / adb 全是假的，时钟是虚拟的（sleep 只推进时间）。
 *
 *   npm run check:freeze
 *
 * 覆盖：
 *   一、帧指纹：一模一样 / 小块动画（倒计时数字跳动）/ 单像素抖动 / 整屏微小色差 / 分辨率变化
 *   二、看门狗判定（虚拟时钟）：完整阈值、降档门槛、截图失败、中途变化重置、熔断窗口、配置即时生效、reset
 *   三、恢复流程：正常链路、每一步的失败分支、拉起重试、未认出但游戏在前台、重启太快观察不到、中止
 *   四、与真·调度器的接线：取不到设备 → onCaptureFailed；异步 onSampleResult 被 await；锁内 exclusive 重入不死锁
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultAlertsConfig, type AlertDetectConfig } from '@shared/alerts'
import type { DeviceInfo } from '@shared/domain'
import { AppError } from '@shared/errors'
import type { RawFrame } from '@shared/vision'

import {
  DIGEST_COLS,
  DIGEST_ROWS,
  FreezeGuard,
  SAMPLE_FAIL_MIN_STATIC_MS,
  STATIC_MAX_CHANGED_CELLS,
  digestDelta,
  frameDigest,
  framesLookIdentical
} from '@main/alerts/freeze'
import {
  FREEZE_RECOVERY_DEFAULTS,
  recoverFrozenInstance,
  type FreezeRecoveryIo,
  type FreezeRecoveryResult,
  type InstanceProbe
} from '@main/alerts/freezeRecovery'
import { getScheduler } from '@main/scheduler/index'

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

const quiet = (): void => undefined
const MIN = 60_000

// ── 合成帧 ────────────────────────────────────────────────────────────────
//
// 640×360 就够了（指纹按比例采样，与分辨率无关）；一帧 0.9MB，整个自检也就几十帧。

const W = 640
const H = 360
const PKG = 'com.lilithgames.samo.android.cn'
const LAUNCHER = 'com.android.launcher3'

function makeFrame(seed = 1): RawFrame {
  const data = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      data[o] = (x * 3 + seed * 17) & 255
      data[o + 1] = (y * 5 + seed * 31) & 255
      data[o + 2] = ((x ^ y) + seed * 7) & 255
      data[o + 3] = 255
    }
  }
  return { width: W, height: H, format: 1, data, capturedAt: 0 }
}

function cloneFrame(f: RawFrame): RawFrame {
  return { ...f, data: new Uint8Array(f.data) }
}

/** 把一块区域的颜色改掉（模拟一个控件在动）。 */
function paint(f: RawFrame, x0: number, y0: number, w: number, h: number, delta: number): RawFrame {
  const g = cloneFrame(f)
  for (let y = y0; y < Math.min(H, y0 + h); y++) {
    for (let x = x0; x < Math.min(W, x0 + w); x++) {
      const o = (y * W + x) * 4
      g.data[o] = Math.min(255, g.data[o]! + delta)
      g.data[o + 1] = Math.min(255, g.data[o + 1]! + delta)
      g.data[o + 2] = Math.min(255, g.data[o + 2]! + delta)
    }
  }
  return g
}

/** 指纹网格第 (i, j) 格的采样点坐标（与 frameDigest 的取法一致）。 */
function samplePoint(i: number, j: number): { x: number; y: number } {
  return {
    x: Math.floor(((i + 0.5) * W) / DIGEST_COLS),
    y: Math.floor(((j + 0.5) * H) / DIGEST_ROWS)
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 一、帧指纹
// ══════════════════════════════════════════════════════════════════════════

function checkDigest(): void {
  section('一、帧指纹：一模一样才算「纹丝不动」')
  const A = makeFrame(1)
  const dA = frameDigest(A)
  ok('指纹是 96×54 的灰度网格', dA.cells.length === DIGEST_COLS * DIGEST_ROWS, `${dA.cells.length}`)
  ok('同一帧的拷贝：变化点数 = 0', digestDelta(dA, frameDigest(cloneFrame(A))) === 0)

  // 一块 60×40 的区域变了 —— 相当于面板上一个倒计时数字跳了一下
  const ticking = paint(A, 100, 100, 60, 40, 90)
  const delta = digestDelta(dA, frameDigest(ticking))
  ok(
    '★ 一块 60×40 的数字跳动 → 判为「画面在动」',
    delta > STATIC_MAX_CHANGED_CELLS && !framesLookIdentical(dA, frameDigest(ticking)),
    `变化点数 ${delta}`
  )

  // 只有一个被采样到的像素变了：容差内，仍算不动
  const p = samplePoint(48, 27)
  const onePixel = paint(A, p.x, p.y, 1, 1, 200)
  const d1 = digestDelta(dA, frameDigest(onePixel))
  ok(
    '单个像素抖动 → 仍算「纹丝不动」（容差 2 个采样点）',
    d1 === 1 && framesLookIdentical(dA, frameDigest(onePixel)),
    `变化点数 ${d1}`
  )

  // 整屏 +4 的微小色差（压缩 / 抗锯齿差异）：低于灰度容差 8
  const subtle = paint(A, 0, 0, W, H, 4)
  ok('整屏 +4 的微小色差 → 仍算「纹丝不动」', digestDelta(dA, frameDigest(subtle)) === 0)

  // 整屏 +20：几乎全变（已经接近 255 的像素会饱和，灰度差不足 8，所以不是严格的 100%）
  const bright = paint(A, 0, 0, W, H, 20)
  const dBright = digestDelta(dA, frameDigest(bright))
  ok(
    '整屏 +20 → 绝大多数采样点都变了',
    dBright > dA.cells.length * 0.9,
    `${dBright}/${dA.cells.length}`
  )

  ok('两张不同的帧 → 判为变化', !framesLookIdentical(dA, frameDigest(makeFrame(2))))

  const small: RawFrame = {
    ...makeFrame(1),
    width: 320,
    height: 180,
    data: makeFrame(1).data.subarray(0, 320 * 180 * 4)
  }
  ok(
    '分辨率变了 → 视为全变（不会拿两种尺寸硬比）',
    digestDelta(dA, frameDigest(small)) === dA.cells.length
  )
}

// ══════════════════════════════════════════════════════════════════════════
// 二、看门狗判定
// ══════════════════════════════════════════════════════════════════════════

function checkGuard(): void {
  section('二、看门狗判定（虚拟时钟，默认阈值：5 分钟 / 60 分钟内最多 3 次）')
  let clock = 10 * MIN
  const cfg: AlertDetectConfig = { ...defaultAlertsConfig().detect }
  const guard = new FreezeGuard({ config: () => cfg, log: quiet, now: () => clock })
  const F = makeFrame(1)
  const G = makeFrame(2)

  // ── 完整阈值：健康探针每 3 分钟一帧 ──
  ok('第一帧：算变化（没得比）', guard.observe(0, F).changed === true)
  ok('只有一帧时不判卡死', guard.assess(0) === null)
  clock += 3 * MIN
  const r2 = guard.observe(0, F)
  ok('3 分钟后同一画面：不动 3 分钟', r2.changed === false && r2.staticForMs === 3 * MIN)
  ok('不动 3 分钟 < 阈值 5 分钟 → 不判', guard.assess(0) === null)
  clock += 3 * MIN
  guard.observe(0, F)
  const v = guard.assess(0)
  ok(
    '★ 不动 6 分钟（3 帧一样）→ 判定卡死（static）',
    v?.kind === 'static' && v.count === 3,
    v?.reason ?? 'null'
  )
  ok(
    '原因是中文可懂的一句',
    !!v && v.reason.includes('分钟纹丝不动') && v.reason.includes('3 张图')
  )

  // ── 中途画面变了：计时重置 ──
  clock += MIN
  ok('画面变了 → changed=true', guard.observe(0, G).changed === true)
  ok('变化后不再判卡死', guard.assess(0) === null)
  clock += 3 * MIN
  guard.observe(0, G)
  ok('变化后重新计时：3 分钟不动仍不判', guard.assess(0) === null)
  ok(
    'evidence 里能看到静止时长与最后变化时刻',
    guard.evidence(0).staticForMs === 3 * MIN && guard.evidence(0).lastChangeAt === clock - 3 * MIN
  )

  // ── 降档门槛：采样已连续失败时 ──
  clock = 100 * MIN
  guard.observe(1, F)
  clock += 20_000
  guard.observe(1, F)
  ok('降档：2 帧一样、20s → 还不够', guard.assessAfterFailures(1) === null)
  clock += SAMPLE_FAIL_MIN_STATIC_MS
  guard.observe(1, F)
  const v1 = guard.assessAfterFailures(1)
  ok(
    '★ 降档：3 帧一样、跨 80s → 判定卡死（不用等满 5 分钟）',
    v1?.kind === 'static' && v1.count === 3,
    v1?.reason ?? 'null'
  )
  ok('同一份证据按完整阈值仍不够（80s < 5 分钟）', guard.assess(1) === null)

  // ── 截图失败 ──
  clock = 200 * MIN
  guard.noteCaptureFailed(2, 'adb 命令超时')
  ok('截图失败 1 次 → 降档也不判', guard.assessAfterFailures(2) === null)
  clock += 30_000
  guard.noteCaptureFailed(2, 'adb 命令超时（已超过 30000ms）')
  const v2 = guard.assessAfterFailures(2)
  ok(
    '★ 截图连续失败 2 次 → 降档判定卡死（capture）',
    v2?.kind === 'capture' && v2.count === 2,
    v2?.reason ?? 'null'
  )
  ok('原因带上最后一次的错误文本', !!v2 && v2.reason.includes('30000ms'))
  ok('完整阈值要持续满 5 分钟：30s 不够', guard.assess(2) === null)
  clock += 5 * MIN
  guard.noteCaptureFailed(2, 'adb 命令超时')
  ok('截图失败持续 5.5 分钟 → 完整阈值也判', guard.assess(2)?.kind === 'capture')
  guard.observe(2, F)
  ok(
    '截到一帧 → 失败计数清零',
    guard.evidence(2).captureFailures === 0 && guard.assessAfterFailures(2) === null
  )

  // ── 熔断窗口 ──
  clock = 300 * MIN
  let b = guard.restartBudget(3)
  ok('初始预算：0/3，允许', b.allowed && b.used === 0 && b.limit === 3 && b.windowMin === 60)
  guard.noteRestart(3)
  clock += 5 * MIN
  guard.noteRestart(3)
  clock += 5 * MIN
  guard.noteRestart(3)
  b = guard.restartBudget(3)
  ok('★ 60 分钟内重启 3 次 → 熔断（不再重启）', !b.allowed && b.used === 3)
  clock += 51 * MIN // 第一次重启距今 61 分钟，滑出窗口
  b = guard.restartBudget(3)
  ok('最早那次滑出窗口 → 又允许 1 次', b.allowed && b.used === 2)

  // ── reset：清画面计时与失败计数，但不清重启记录 ──
  guard.observe(3, F)
  clock += 6 * MIN
  guard.observe(3, F)
  guard.noteCaptureFailed(3, 'x')
  ok('reset 前：能判卡死', guard.assess(3) !== null || guard.evidence(3).staticFrames === 2)
  guard.reset(3)
  const e3 = guard.evidence(3)
  ok(
    'reset 后：画面计时与失败计数清零',
    e3.staticFrames === 0 && e3.captureFailures === 0 && guard.assess(3) === null
  )
  // 到这里时钟又走了 6 分钟：三次重启里只剩最后一次（第 310 分钟）还在 60 分钟窗口内。
  ok(
    'reset 不清重启记录（熔断要跨恢复生效）',
    guard.restartBudget(3).used === 1,
    `used=${guard.restartBudget(3).used}`
  )

  // ── 配置即时生效 ──
  clock = 400 * MIN
  guard.observe(4, F)
  clock += 3 * MIN
  guard.observe(4, F)
  ok('阈值 5 分钟：3 分钟不判', guard.assess(4) === null)
  cfg.freezeMinutes = 2
  ok(
    '★ 把阈值改成 2 分钟 → 同一份证据立刻判定（不用重建看门狗）',
    guard.assess(4)?.kind === 'static'
  )
  cfg.freezeMinutes = 5
  cfg.freezeRestartLimit = 1
  guard.noteRestart(4)
  ok('上限改成 1 → 重启 1 次后即熔断', !guard.restartBudget(4).allowed)

  ok('没见过的实例：不判、预算完整', guard.assess(99) === null && guard.restartBudget(99).allowed)
}

// ══════════════════════════════════════════════════════════════════════════
// 三、恢复流程
// ══════════════════════════════════════════════════════════════════════════

interface WorldOpts {
  restartThrows?: boolean
  /** 重启后多少 ms Android 就绪；Infinity = 永远起不来。 */
  readyAfterMs?: number
  /** 重启命令不改变任何可观察状态（重启太快 / 驱动没来得及报）。 */
  silentRestart?: boolean
  /** 前 N 次 attach 抛错；Infinity = 永远连不上。 */
  attachFailures?: number
  /** adb 连上后多少 ms boot_completed；Infinity = 永不。 */
  bootAfterMs?: number
  /** true = 每次拉起都抛；数字 = 前 N 次抛。 */
  launchThrows?: boolean | number
  /** 拉起后第几次查前台才是游戏；Infinity = 永远不是。 */
  foregroundAfterPolls?: number
  /** 第几帧认出主界面；Infinity = 永不。 */
  recognizeAtFrame?: number
  framesChange?: boolean
  /** 等主界面超时后前台是否仍是游戏。 */
  finalForegroundIsGame?: boolean
  /** 第 N 次 sleep 时触发中止。 */
  abortAfterSleeps?: number
  abortBeforeStart?: boolean
}

interface World {
  io: FreezeRecoveryIo
  logs: string[]
  counters: {
    restarts: number
    drops: number
    attaches: number
    launches: number
    frames: number
    sleeps: number
  }
  elapsedMs(): number
}

function makeWorld(o: WorldOpts = {}): World {
  const opt = {
    readyAfterMs: 8_000,
    attachFailures: 1,
    bootAfterMs: 3_000,
    foregroundAfterPolls: 2,
    recognizeAtFrame: 3,
    framesChange: true,
    finalForegroundIsGame: true,
    ...o
  }
  const t0 = 1_000_000
  let clock = t0
  let pid = 100
  let androidStarted = true
  let readyAt = -1
  let attachedAt = -1
  let launched = false
  let fgPolls = 0
  const base = makeFrame(1)
  const counters = { restarts: 0, drops: 0, attaches: 0, launches: 0, frames: 0, sleeps: 0 }
  const logs: string[] = []
  const controller = new AbortController()
  if (opt.abortBeforeStart) controller.abort()

  const io: FreezeRecoveryIo = {
    restartInstance: async () => {
      if (opt.restartThrows) throw new AppError('MUMU_API_ERROR', 'MuMuManager 报 errcode -200')
      counters.restarts += 1
      if (opt.silentRestart) return
      pid += 1
      androidStarted = false
      readyAt = opt.readyAfterMs === Infinity ? Infinity : clock + opt.readyAfterMs
    },
    instanceState: async (): Promise<InstanceProbe | null> => {
      if (!opt.silentRestart && readyAt >= 0 && clock >= readyAt) androidStarted = true
      return { processStarted: true, androidStarted, pid }
    },
    dropDevice: async () => {
      counters.drops += 1
    },
    attachDevice: async () => {
      counters.attaches += 1
      if (counters.attaches <= opt.attachFailures)
        throw new AppError('ADB_CONNECT_FAILED', '连接模拟器失败：connection refused')
      attachedAt = clock
      return '127.0.0.1:16416'
    },
    isBooted: async () =>
      opt.bootAfterMs !== Infinity && attachedAt >= 0 && clock >= attachedAt + opt.bootAfterMs,
    foreground: async () => {
      if (!launched) return LAUNCHER
      fgPolls += 1
      if (fgPolls < opt.foregroundAfterPolls) return LAUNCHER
      if (!opt.finalForegroundIsGame && counters.frames > 0) return LAUNCHER
      return PKG
    },
    launchGame: async () => {
      counters.launches += 1
      const throws =
        opt.launchThrows === true ||
        (typeof opt.launchThrows === 'number' && counters.launches <= opt.launchThrows)
      if (throws) throw new AppError('ADB_COMMAND_FAILED', 'monkey: No activities found to run')
      launched = true
    },
    isGameRunning: async () => launched,
    capture: async () => {
      counters.frames += 1
      return opt.framesChange ? makeFrame(counters.frames) : base
    },
    recognize: async () => counters.frames >= opt.recognizeAtFrame,
    log: (level, message) => logs.push(`${level}:${message}`),
    sleep: async (ms) => {
      counters.sleeps += 1
      clock += ms
      if (opt.abortAfterSleeps !== undefined && counters.sleeps >= opt.abortAfterSleeps)
        controller.abort()
    },
    now: () => clock,
    signal: controller.signal
  }
  return { io, logs, counters, elapsedMs: () => clock - t0 }
}

async function recover(o: WorldOpts = {}): Promise<{ r: FreezeRecoveryResult; w: World }> {
  const w = makeWorld(o)
  const r = await recoverFrozenInstance(w.io, { gamePackage: PKG })
  return { r, w }
}

async function checkRecovery(): Promise<void> {
  section(
    '三、恢复流程：重启 → 等 Android → 重连 adb → 等开机 → monkey 拉起 → 等主界面（虚拟时钟）'
  )

  // ── 正常链路 ──
  {
    const { r, w } = await recover()
    ok(
      '★ 正常链路：ok + 主界面已认出',
      r.ok && r.loaded && r.stage === 'done' && r.reason === null,
      JSON.stringify(r.steps)
    )
    ok(
      '步骤齐全（重启 / 启动 / adb / 开机 / 拉起 / 认出）',
      r.steps.length === 6 && r.steps[0] === '重启模拟器' && r.steps.at(-1) === '主界面已认出'
    )
    ok('只下发了一次重启', w.counters.restarts === 1)
    ok(
      '先断旧连接再重连；第 1 次连不上会重试（共 2 次）',
      w.counters.drops === 1 && w.counters.attaches === 2
    )
    ok('拉起走了一次 monkey', w.counters.launches === 1 && r.steps.includes('已用 monkey 拉起游戏'))
    ok('返回了重连后的 serial', r.serial === '127.0.0.1:16416')
    ok(
      '没撞上任何超时（总耗时 < 2 分钟）',
      r.elapsedMs < 120_000 && w.elapsedMs() === r.elapsedMs,
      `${Math.round(r.elapsedMs / 1000)}s`
    )
    ok(
      '观察到了重启生效（pid 变化 / 状态回落），没有走「没观察到」的告警',
      !w.logs.some((l) => l.includes('没观察到实例状态变化'))
    )
  }

  // ── 各步失败 ──
  {
    const { r } = await recover({ restartThrows: true })
    ok(
      '重启命令抛错 → 失败卡在 restart，带中文原因',
      !r.ok && r.stage === 'restart' && (r.reason ?? '').includes('errcode'),
      r.reason ?? ''
    )
  }
  {
    const { r, w } = await recover({ readyAfterMs: Infinity })
    ok(
      'Android 永远起不来 → 失败卡在 androidReady，等满了超时',
      !r.ok &&
        r.stage === 'androidReady' &&
        w.elapsedMs() >= FREEZE_RECOVERY_DEFAULTS.androidReadyTimeoutMs,
      `${Math.round(w.elapsedMs() / 1000)}s`
    )
    ok('原因说清了当前状态', (r.reason ?? '').includes('尚未启动完成'), r.reason ?? '')
  }
  {
    const { r, w } = await recover({ attachFailures: Infinity })
    ok(
      'adb 永远连不上 → 失败卡在 adb，重试到超时',
      !r.ok && r.stage === 'adb' && w.counters.attaches > 5,
      `attach ${w.counters.attaches} 次`
    )
    ok('原因带上最后一次的 adb 错误', (r.reason ?? '').includes('connection refused'))
  }
  {
    const { r } = await recover({ bootAfterMs: Infinity })
    ok('boot_completed 一直不是 1 → 失败卡在 boot', !r.ok && r.stage === 'boot')
  }
  {
    const { r, w } = await recover({ launchThrows: true })
    ok(
      '拉起每次都失败 → 重试一次后失败卡在 launch',
      !r.ok && r.stage === 'launch' && w.counters.launches === 2,
      `launches=${w.counters.launches}`
    )
  }
  {
    const { r, w } = await recover({ launchThrows: 1 })
    ok('★ 第一次 monkey 失败、第二次成功 → 仍然恢复', r.ok && r.loaded && w.counters.launches === 2)
  }
  {
    const { r } = await recover({ foregroundAfterPolls: Infinity })
    ok('拉起后前台一直不是游戏 → 失败卡在 launch', !r.ok && r.stage === 'launch')
  }

  // ── 主界面认不出 ──
  {
    const { r } = await recover({ recognizeAtFrame: Infinity, framesChange: true })
    ok(
      '★ 等满时限没认出主界面、但游戏在前台且画面在动 → 算成功（loaded=false，交给调度器的弹窗阶梯）',
      r.ok && !r.loaded && r.steps.some((s) => s.includes('画面在动')),
      r.steps.at(-1) ?? ''
    )
  }
  {
    const { r } = await recover({ recognizeAtFrame: Infinity, framesChange: false })
    ok(
      '没认出、画面也没动、但游戏仍在前台 → 也算成功（loaded=false），步骤里注明',
      r.ok && !r.loaded && r.steps.some((s) => s.includes('没变化'))
    )
  }
  {
    const { r } = await recover({ recognizeAtFrame: Infinity, finalForegroundIsGame: false })
    ok(
      '没认出且前台已经不是游戏 → 失败卡在 load',
      !r.ok && r.stage === 'load' && (r.reason ?? '').includes(LAUNCHER),
      r.reason ?? ''
    )
  }

  // ── 重启太快观察不到状态变化 ──
  {
    const { r, w } = await recover({ silentRestart: true })
    ok(
      '重启命令没带来可观察的状态变化 → 记一条警告后继续，最终仍恢复',
      r.ok &&
        w.logs.some((l) => l.includes('没观察到实例状态变化')) &&
        w.elapsedMs() >= FREEZE_RECOVERY_DEFAULTS.restartObserveMs
    )
  }

  // ── 中止 ──
  {
    let thrown: AppError | null = null
    try {
      await recover({ abortBeforeStart: true })
    } catch (e) {
      thrown = AppError.from(e)
    }
    ok('开始前已中止 → 抛 RUN_ABORTED，一步都不做', thrown?.code === 'RUN_ABORTED')
  }
  {
    let thrown: AppError | null = null
    let w: World | null = null
    try {
      w = makeWorld({ abortAfterSleeps: 3 })
      await recoverFrozenInstance(w.io, { gamePackage: PKG })
    } catch (e) {
      thrown = AppError.from(e)
    }
    ok(
      '★ 中途中止（面板退出）→ 立刻抛 RUN_ABORTED，不再往下等',
      thrown?.code === 'RUN_ABORTED' && w!.counters.sleeps === 3,
      `sleeps=${w?.counters.sleeps}`
    )
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 四、与真·调度器的接线
// ══════════════════════════════════════════════════════════════════════════

async function checkSchedulerWiring(): Promise<void> {
  section('四、与真·调度器的接线（假设备，不发一条 adb 命令）')
  const dataDir = await mkdtemp(join(tmpdir(), 'wl-freeze-check-'))
  const scheduler = getScheduler()

  const captureFailures: string[] = []
  const sampleResults: { ok: boolean; hasSignal: boolean }[] = []
  let exclusiveRan = false
  let awaited = false

  await scheduler.init({
    dataDir: () => dataDir,
    refSize: () => ({ refWidth: 2560, refHeight: 1440 }),
    resolveDevice: async (): Promise<DeviceInfo> => {
      throw new AppError('ADB_TIMEOUT', '离线自检：adb 命令超时（假的，这里没有真设备）。')
    },
    busyRunIdOf: () => null,
    adb: {
      capture: async () => {
        throw new Error('离线自检不该走到截图')
      },
      tap: async () => {
        throw new Error('离线自检不该走到点击')
      },
      key: async () => {
        throw new Error('离线自检不该走到按键')
      }
    },
    log: quiet,
    onCaptureFailed: (_index, err) => {
      captureFailures.push(err.code)
    },
    onSampleResult: async (index, okFlag, _message, ctx) => {
      sampleResults.push({ ok: okFlag, hasSignal: ctx?.signal instanceof AbortSignal })
      if (okFlag) return
      // 生产环境的卡死恢复就是这样在锁内调 exclusive 的：必须重入放行，否则这里会死锁。
      await scheduler.exclusive(index, '卡死重启', async () => {
        await new Promise((r) => setTimeout(r, 20))
        exclusiveRan = true
      })
      awaited = true
    }
  })

  await scheduler.setAuto(0, true)
  ok(
    '取不到设备 → onCaptureFailed 收到 ADB_TIMEOUT',
    captureFailures.includes('ADB_TIMEOUT'),
    captureFailures.join(',')
  )
  ok(
    'onSampleResult 收到失败通报，且带自动调度的中止信号',
    sampleResults.some((r) => !r.ok && r.hasSignal)
  )
  ok('★ 异步 onSampleResult 被 await（setAuto 返回时回调已经跑完）', awaited)
  ok('★ 回调里的 scheduler.exclusive 在锁内重入放行，没有死锁', exclusiveRan)
  ok(
    '失败后仍补排了唤醒（退避重试），不留僵尸态',
    scheduler.listWakes().some((w) => w.instanceIndex === 0)
  )

  await scheduler.setAuto(0, false)
  await scheduler.stop()
}

// ── 跑 ────────────────────────────────────────────────────────────────────

checkDigest()
checkGuard()
await checkRecovery()
await checkSchedulerWiring()

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
if (fail > 0) process.exitCode = 1
