/**
 * 自动采集 —— **真机**验证脚本（会真的驱动游戏、真的派兵）。
 *
 * 跑法（见 package.json）：
 *     npm run live:probe                 # 只截图 + 模板打分，不点任何东西（含负样本对照）
 *     npm run live:panel                 # 开一次「部队管理」面板读队列/倒计时/坐标/耐力，读完关掉
 *     npm run live:run                   # ★ 跑一整轮 runGatherCycle：会真的派出一支采集队
 *     npm run live:recheck -- 120        # 采样 → 等 120 秒 → 再采样，校验本地 ETA 递推误差
 *
 * 安全边界（写死在代码里）：
 *   · 只用 adb（screencap / input），**绝不**调 mumutool 的 create/clone/delete/open/close/restart。
 *   · **绝不**安装或卸载应用、不改设备设置。
 *   · 结束时不 adb disconnect，保持进入时的连接状态。
 *   · 世界地图上不盲按 BACK（会弹「退出游戏」确认框），关面板的策略由 navigation.ts 统一负责。
 *
 * 所有留痕落在 <工程根>/docs/live/ 下，日志同时写 docs/live/<命令>-<时间戳>.ndjson。
 */

import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { LogLevel } from '@shared/script'
import type { RawFrame, Rect } from '@shared/vision'
import { listInstances } from '@main/mumu/index'
import { attach, initAdb } from '@main/adb/index'
import { matchIn, prepareFrame, setTemplatesDir } from '@vision/index'
import { sharp } from '@vision/cv'

import {
  createAdbGatherIo,
  createRuntimeState,
  loadGatherTemplates,
  normalizeGatherConfig,
  openTroopPanel,
  readTroopPanel,
  closeTroopPanel,
  runGatherCycle,
  toMarchRecords,
  planWake,
  GatherSession,
  GAME_PACKAGE,
  TPL,
  TROOP_STATUS_LABEL,
  type GatherRuntimeState,
  type GatherTemplates,
  type TroopPanelReading
} from '@main/game/gather'
import { scheduleWake, getWake, cancelAllWakes } from '@main/scheduler/timers'

const PROJECT_ROOT = process.cwd()
const DATA_DIR = join(PROJECT_ROOT, '.wl-data')
const TEMPLATES_DIR = join(DATA_DIR, 'templates')
const OUT_DIR = join(PROJECT_ROOT, 'docs', 'live')

const STATE_FILE = join(OUT_DIR, 'runtime-state.json')

function ts(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function hhmmss(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── 留痕 ────────────────────────────────────────────────────────────────────

let logPath = ''
let shotSeq = 0

async function jot(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  const tag = level === 'error' ? '❌' : level === 'warn' ? '⚠️ ' : '  '
  console.log(`${tag} [${hhmmss(Date.now())}] ${message}${data ? ' ' + JSON.stringify(data) : ''}`)
  if (logPath) {
    await appendFile(
      logPath,
      JSON.stringify({ at: Date.now(), level, message, data }) + '\n',
      'utf8'
    ).catch(() => undefined)
  }
}

/** 把裸帧存成 jpg（缩到 1280 宽，方便直接看）。 */
async function saveShot(label: string, raw: RawFrame, dir: string): Promise<string> {
  shotSeq += 1
  const name = `${String(shotSeq).padStart(3, '0')}-${label}.jpg`
  const file = join(dir, name)
  const bytes = raw.width * raw.height * 4
  await sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, bytes), {
    raw: { width: raw.width, height: raw.height, channels: 4 }
  })
    .resize(1280)
    .jpeg({ quality: 72 })
    .toFile(file)
  return file
}

// ── 引导：连设备 + 载模板 ───────────────────────────────────────────────────

interface Boot {
  serial: string
  templates: GatherTemplates
}

async function boot(): Promise<Boot> {
  const instances = await listInstances()
  const target = instances.find((i) => i.state === 'running' && i.adbPort !== null)
  if (!target || target.adbPort === null) {
    throw new Error('没有 running 且带 adb_port 的 MuMu 实例。请先在 MuMu 里启动实例。')
  }
  await initAdb({ adbPath: undefined })
  const dev = await attach(target.index, target.adbPort)
  await jot(
    'info',
    `已连接实例 index=${target.index}「${target.name}」serial=${dev.serial}，` +
      `screencap 实测 ${dev.screenWidth}x${dev.screenHeight}，前台=${dev.foregroundPackage ?? '未知'}`
  )

  setTemplatesDir(TEMPLATES_DIR)
  const templates = await loadGatherTemplates({
    templatesDir: TEMPLATES_DIR,
    packageName: GAME_PACKAGE,
    onWarn: (m) => void jot('warn', `模板：${m}`)
  })
  await jot(
    'info',
    `模板集 ${templates.setId}：界面模板 ${templates.ui.size} 张，字形集 ${templates.glyphSets.size} 套` +
      (templates.missing.length
        ? `，缺 ${templates.missing.length} 张：${templates.missing.join(',')}`
        : '')
  )
  return { serial: dev.serial, templates }
}

async function loadState(): Promise<GatherRuntimeState> {
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(STATE_FILE, 'utf8')
    return JSON.parse(raw) as GatherRuntimeState
  } catch {
    return createRuntimeState()
  }
}

async function saveState(s: GatherRuntimeState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2), 'utf8')
}

// ═══════════════════════════════════════════════════════════════════════════
// 命令 1：probe —— 真机单帧模板打分（含负样本对照），不点任何东西
// ═══════════════════════════════════════════════════════════════════════════

interface ProbeItem {
  id: string
  roi?: Rect
  /** 期望在「当前画面」上命中还是不命中。null = 只报分数不判定。 */
  expect: boolean | null
  note: string
}

async function cmdProbe(): Promise<void> {
  const { serial, templates } = await boot()
  const io = createAdbGatherIo({ serial })

  const t0 = Date.now()
  const raw = await io.capture()
  const capMs = Date.now() - t0
  const prepared = await prepareFrame(raw, { refW: 2560, refH: 1440, shrink: 2 })
  const shot = await saveShot('probe-frame', raw, OUT_DIR)
  await jot('info', `截图 ${raw.width}x${raw.height} 耗时 ${capMs}ms，留痕 ${shot}`)

  // 正样本：世界地图上一定看得到的东西；负样本：只在别的界面才有的东西。
  const items: ProbeItem[] = [
    // ★ 放大镜镜片半透明，分数随镜片底下的地形漂移（草地 0.98 / 压着伐木场 0.79），
    //   所以它只报分数、不做判定；世界地图的硬判据是不透明的回城城堡按钮。
    {
      id: TPL.worldSearchIcon,
      expect: null,
      note: '参考 世界地图放大镜（半透明，分数随地形漂移）'
    },
    { id: TPL.navCityToggle, expect: true, note: '★正样本 世界地图回城按钮（不透明，硬判据）' },
    {
      id: TPL.titleCreateTroop,
      expect: false,
      note: '★负样本 创建部队页标题（世界地图上绝不该有）'
    },
    { id: TPL.btnMarch, expect: false, note: '★负样本 行军按钮' },
    { id: TPL.panelTitleTroop, expect: false, note: '★负样本 部队管理面板标题' },
    { id: TPL.btnSearch, expect: false, note: '★负样本 搜索面板搜索按钮' },
    { id: TPL.btnGather, expect: false, note: '★负样本 资源点卡片采集按钮' },
    { id: TPL.dlgTitleNotice, expect: false, note: '★负样本 退出游戏确认框（收尾干净态的证据）' },
    { id: TPL.navMapToggle, expect: null, note: '参考 城内切地图按钮（在世界地图上应不命中）' }
  ]

  let ok = 0
  let bad = 0
  console.log('\n模板 id                          期望   命中   分数     位置        判定')
  console.log('─'.repeat(84))
  for (const it of items) {
    const tpl = templates.get(it.id)
    if (!tpl) {
      console.log(`${it.id.padEnd(32)} —      模板缺失`)
      continue
    }
    const roi = it.roi ?? tpl.defaultRoi
    const m = await matchIn(prepared, tpl, { roi })
    const verdict = it.expect === null ? '—' : m.found === it.expect ? '✅ 符合' : '❌ 不符'
    if (it.expect !== null) {
      if (m.found === it.expect) ok++
      else bad++
    }
    console.log(
      `${it.id.padEnd(32)} ${(it.expect === null ? '—' : it.expect ? '命中' : '不中').padEnd(6)} ` +
        `${(m.found ? '是' : '否').padEnd(6)} ${m.score.toFixed(4)}  ` +
        `${`(${m.centerX},${m.centerY})`.padEnd(12)}${verdict}   ${it.note}`
    )
  }
  console.log('─'.repeat(84))
  console.log(
    `判定：符合 ${ok} 项，不符 ${bad} 项。（阈值 0.85，method=TM_CCOEFF_NORMED，shrink=2）`
  )
  if (bad > 0) process.exitCode = 1
}

// ═══════════════════════════════════════════════════════════════════════════
// 命令 2：panel —— 开一次部队管理面板，读队列/倒计时/坐标/耐力，读完关掉
// ═══════════════════════════════════════════════════════════════════════════

async function samplePanel(
  serial: string,
  templates: GatherTemplates,
  keepOpen = false
): Promise<TroopPanelReading> {
  const io = createAdbGatherIo({ serial })
  const cfg = normalizeGatherConfig({})
  const s = new GatherSession({
    io,
    templates,
    config: cfg,
    log: (l, m, d) => void jot(l, m, d),
    onShot: (label, raw) => void saveShot(label, raw, OUT_DIR)
  })
  await openTroopPanel(s)
  const reading = await readTroopPanel(s)
  await saveShot('panel', (await s.frame()).raw, OUT_DIR)
  if (!keepOpen) await closeTroopPanel(s)
  return reading
}

function printPanel(r: TroopPanelReading): void {
  console.log(`\n行军队列 ${r.queueUsed}/${r.queueTotal}   采样时刻 ${hhmmss(r.sampledAt)}`)
  if (r.rows.length === 0) console.log('  （没有在外的队伍）')
  for (const row of r.rows) {
    console.log(
      `  行${row.index}  ${TROOP_STATUS_LABEL[row.status].padEnd(6)}  ` +
        `剩余 ${row.remainingSec === null ? '读不出' : `${row.remainingSec}s`}`.padEnd(16) +
        `坐标 ${(row.coord ?? '读不出').padEnd(10)} ` +
        `耐力 ${row.stamina ? `${row.stamina[0]}/${row.stamina[1]}` : '读不出'}`
    )
  }
  for (const w of r.warnings) console.log(`  ⚠️  ${w}`)
}

async function cmdPanel(): Promise<void> {
  const { serial, templates } = await boot()
  const r = await samplePanel(serial, templates)
  printPanel(r)
}

// ═══════════════════════════════════════════════════════════════════════════
// 命令 3：run —— 跑一整轮 runGatherCycle（★ 会真的派兵）
// ═══════════════════════════════════════════════════════════════════════════

async function cmdRun(): Promise<void> {
  const { serial, templates } = await boot()
  const io = createAdbGatherIo({ serial })
  const state = await loadState()

  // 真机一轮：只派 1 支，够验证链路；其余全用默认值（默认值本身就是要验证的对象）。
  const config = normalizeGatherConfig({
    enabled: true,
    resources: [
      { type: 'wood', enabled: true, priority: 1, queues: 1 },
      { type: 'gold', enabled: false, priority: 2, queues: 0 },
      { type: 'iron', enabled: false, priority: 3, queues: 0 },
      { type: 'mana', enabled: false, priority: 4, queues: 0 }
    ]
  })

  await jot('info', `配置：等级策略=${JSON.stringify(config.levelPolicy)}`)
  await jot(
    'info',
    `上一轮运行期状态：maxLevel=${state.maxLevel ?? '未探测'}，在途 ${state.inFlight.length} 支`
  )

  const t0 = Date.now()
  const r = await runGatherCycle({
    io,
    templates,
    config,
    state,
    log: (l, m, d) => void jot(l, m, d),
    onShot: async (label, raw) => {
      await saveShot(label, raw, OUT_DIR)
    }
  })
  const cost = Date.now() - t0

  await saveState(r.state)

  console.log('\n' + '═'.repeat(78))
  console.log(
    `一轮结束：outcome=${r.outcome}  耗时 ${(cost / 1000).toFixed(1)}s  截图 ${r.captures} 张`
  )
  console.log(`说明：${r.message}`)
  console.log(`队列：${r.queue ? `${r.queue.used}/${r.queue.total}` : '未读到'}`)
  console.log(`探测到的等级上限：${r.state.maxLevel ?? '未探测'}`)
  for (const d of r.dispatched) {
    console.log(
      `派出：${d.resource} 搜索下限=${d.searchFloor} → 实际点等级=${d.level ?? '?'} ` +
        `坐标=${d.coord ?? '?'} 储量=${d.storage ?? '?'} 单程=${d.travelTimeSec ?? '?'}s 兵力=${d.troops ?? '?'}`
    )
  }
  for (const m of r.state.inFlight) {
    console.log(
      `在途：行${m.rowIndex} ${TROOP_STATUS_LABEL[m.status]} 坐标=${m.coord ?? '?'} ` +
        `剩余=${m.remainingSec ?? '?'}s etaAt=${m.etaAt ? hhmmss(m.etaAt) : '?'} ` +
        `freeAt=${m.freeAt ? hhmmss(m.freeAt) : '?'}（= etaAt + 单程 ${m.travelTimeSec ?? '?'}s）`
    )
  }
  console.log(
    `下次唤醒：${r.nextWakeAt ? hhmmss(r.nextWakeAt) : '不唤醒'}` +
      `${r.nextWakeAt ? `（${((r.nextWakeAt - Date.now()) / 1000).toFixed(0)} 秒后）` : ''}  理由：${r.nextWakeReason}`
  )
  for (const w of r.warnings) console.log(`⚠️  ${w}`)
  if (r.error) console.log(`错误：${JSON.stringify(r.error)}`)
  console.log('═'.repeat(78))

  // ── 真的注册一个定时唤醒，并证明定时器设施是活的 ────────────────────────
  if (r.nextWakeAt) {
    scheduleWake(
      { key: 0, dueAt: r.nextWakeAt, reason: r.nextWakeReason, backoffStep: 0 },
      () => undefined
    )
    const got = getWake(0)
    console.log(
      `定时唤醒已注册：key=${got?.key} dueAt=${got ? hhmmss(got.dueAt) : '—'} ` +
        `理由=${got?.reason ?? '—'}`
    )
    // 同一套设施跑一个 3 秒的短程唤醒，证明它真的会触发（长程那个等不起）。
    const fired = await new Promise<number>((resolve) => {
      const due = Date.now() + 3000
      scheduleWake({ key: 99, dueAt: due, reason: '设施自检', backoffStep: 0 }, () =>
        resolve(Date.now() - due)
      )
    })
    console.log(`定时器设施自检：3 秒短程唤醒已触发，偏差 ${fired}ms`)
    cancelAllWakes()
  }

  if (r.outcome === 'error') process.exitCode = 1
}

// ═══════════════════════════════════════════════════════════════════════════
// 命令 4：recheck —— 采样 → 等待 → 再采样，校验本地 ETA 递推
// ═══════════════════════════════════════════════════════════════════════════

async function cmdRecheck(waitSec: number): Promise<void> {
  const { serial, templates } = await boot()
  const cfg = normalizeGatherConfig({})
  const state = await loadState()

  console.log(`\n【第 1 次采样】`)
  const a = await samplePanel(serial, templates)
  printPanel(a)
  const recA = toMarchRecords(a, state, cfg)
  const plan = planWake(cfg, Date.now(), recA, 0)
  for (const m of recA) {
    console.log(
      `  递推：坐标 ${m.coord ?? '?'} ${TROOP_STATUS_LABEL[m.status]} ` +
        `etaAt=${m.etaAt ? hhmmss(m.etaAt) : '?'} freeAt=${m.freeAt ? hhmmss(m.freeAt) : '?'}` +
        `（单程 ${m.travelTimeSec ?? '未记账'}s）`
    )
  }
  console.log(`  唤醒计划：${hhmmss(plan.at)}  ${plan.reason}`)

  console.log(`\n等待 ${waitSec} 秒（期间不碰模拟器，纯本地递推）…`)
  await sleep(waitSec * 1000)

  console.log(`\n【第 2 次采样】`)
  const b = await samplePanel(serial, templates)
  printPanel(b)

  console.log('\n【递推 vs 实测】（按坐标配对；预测值 = 第 1 次剩余 − 实际间隔）')
  console.log('坐标        状态      第1次剩余  间隔     预测剩余  实测剩余  误差')
  console.log('─'.repeat(76))
  let worst = 0
  for (const rb of b.rows) {
    const ra = a.rows.find((x) => x.coord && x.coord === rb.coord) ?? a.rows[rb.index - 1]
    if (!ra || ra.remainingSec === null || rb.remainingSec === null) {
      console.log(
        `${(rb.coord ?? '?').padEnd(12)}${TROOP_STATUS_LABEL[rb.status].padEnd(10)}读不出，跳过`
      )
      continue
    }
    const gap = (rb.sampledAt - ra.sampledAt) / 1000
    const pred = ra.remainingSec - gap
    const err = pred - rb.remainingSec
    worst = Math.max(worst, Math.abs(err))
    const same = ra.status === rb.status
    console.log(
      `${(rb.coord ?? '?').padEnd(12)}${TROOP_STATUS_LABEL[rb.status].padEnd(10)}` +
        `${String(ra.remainingSec).padEnd(11)}${gap.toFixed(1).padEnd(9)}` +
        `${pred.toFixed(1).padEnd(10)}${String(rb.remainingSec).padEnd(10)}` +
        `${err.toFixed(1)}s${same ? '' : '（阶段已切换，误差不可比）'}`
    )
  }
  console.log('─'.repeat(76))
  console.log(`最大绝对误差 ${worst.toFixed(1)} 秒（识别精度就是 1 秒，误差 ≤ 2s 即认为递推正确）`)
}

// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'probe'
  await mkdir(OUT_DIR, { recursive: true })
  logPath = join(OUT_DIR, `${cmd}-${ts()}.ndjson`)
  console.log(`万龙 · 自动采集真机验证  命令=${cmd}  留痕目录=${OUT_DIR}`)

  switch (cmd) {
    case 'probe':
      await cmdProbe()
      break
    case 'panel':
      await cmdPanel()
      break
    case 'run':
      await cmdRun()
      break
    case 'recheck':
      await cmdRecheck(Number(process.argv[3] ?? 120))
      break
    default:
      console.error(`未知命令「${cmd}」。可用：probe / panel / run / recheck <秒>`)
      process.exitCode = 2
  }
}

main().then(
  () => {
    // adb 队列里可能还挂着空闲计时器，显式退出。
    setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref()
  },
  (e) => {
    console.error(`\n❌ 失败：${e instanceof Error ? e.stack : String(e)}`)
    process.exit(1)
  }
)
