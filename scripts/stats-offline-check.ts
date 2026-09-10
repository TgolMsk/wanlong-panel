/**
 * 数据统计模块（src/main/stats）的**离线**自检。
 *
 * ★★ 全程不碰模拟器、不发 adb、不发网络请求：
 *     · 时钟是假的（deps.now 注入），日切靠事件时间与 checkRollover(假时间) 触发
 *     · 数据目录是 os.tmpdir() 下的临时目录，跑完就扔
 *     · electron 被 esbuild 换成 scripts/stubs/electron-offline.mjs
 *
 * 跑法（工程根目录）：
 *     npm run check:stats
 *
 * 覆盖：
 *   一、北京日切边界：23:59 与 00:00 落不同桶；宿主 TZ=America/Los_Angeles 与 Asia/Shanghai 结果一致
 *   二、reducer：七种事件各自的算术、暂停→恢复的时长、重复 paused 幂等、储量未知计数
 *   三、rolloverDay：23:50 起的暂停切成 10 分 + 次日续算
 *   四、金额格式化（万/亿）与 renderDailyStatsText 文案
 *   五、落盘往返：save → load 一致；坏 JSON 被 normalizeDailyStats 兜住；清理旧文件
 *   六、StatsCenter：record 跨 0 点自动换桶并写出昨天；早于今天的事件补记进旧文件；
 *       stats:daily / stats:range / stats:snapshotNow 通道走通；非法参数抛可解出 code 的中文错误
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isSerializedError, type SerializedError } from '@shared/errors'
import { formatCnAmount, emptyResourceSnapshot, type ResourceSnapshot } from '@shared/resources'
import {
  STATS_CH,
  cstDateKey,
  cstDayStart,
  cstNextDayStart,
  dateKeyToDayStart,
  emptyDailyStats,
  formatPausedDuration,
  renderDailyStatsText,
  shiftDateKey,
  type DailyStats,
  type StatsEvent
} from '@shared/stats'

import {
  applyStatsEvent,
  getStatsCenter,
  isDayEmpty,
  listDailyKeys,
  loadDailyStats,
  pruneDailyStats,
  resetStatsCenterForTest,
  rolloverDay,
  saveDailyStats,
  statsFileOf
} from '@main/stats/index'

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 把 handleStats 抛过桥的 Error 解回 SerializedError（与渲染进程 normalizeError 同一思路）。 */
function decodeBridgeError(e: unknown): SerializedError | null {
  if (!(e instanceof Error)) return null
  try {
    const parsed: unknown = JSON.parse(e.message)
    return isSerializedError(parsed) ? parsed : null
  } catch {
    return null
  }
}

const MIN = 60_000
const HOUR = 3_600_000

// 北京 2026-09-09 23:59 = UTC 15:59
const T_2359 = Date.UTC(2026, 8, 9, 15, 59)
const T_0000 = T_2359 + MIN
const DAY_A = '2026-09-09'
const DAY_B = '2026-09-10'

// ── 一、日切边界 ──────────────────────────────────────────────────────────

function checkBoundary(): void {
  section('一、北京日切边界（与宿主时区无关）')
  ok('北京 23:59 → 2026-09-09', cstDateKey(T_2359) === DAY_A, cstDateKey(T_2359))
  ok('北京 00:00 → 2026-09-10', cstDateKey(T_0000) === DAY_B, cstDateKey(T_0000))
  ok('cstDayStart(23:59) 是当天 0 点', cstDayStart(T_2359) === Date.UTC(2026, 8, 8, 16))
  ok('cstNextDayStart(23:59) === 00:00 那一刻', cstNextDayStart(T_2359) === T_0000)
  ok('dateKeyToDayStart 与 cstDayStart 互逆', dateKeyToDayStart(DAY_A) === cstDayStart(T_2359))
  ok('shiftDateKey 跨月', shiftDateKey('2026-09-30', 1) === '2026-10-01' && shiftDateKey('2026-10-01', -1) === '2026-09-30')

  // 宿主时区切换实测：Node 允许运行时改 process.env.TZ（会重新 tzset）。
  const results: Record<string, string> = {}
  const localHours: Record<string, number> = {}
  for (const tz of ['America/Los_Angeles', 'Asia/Shanghai', 'UTC']) {
    process.env.TZ = tz
    results[tz] = `${cstDateKey(T_2359)}|${cstDateKey(T_0000)}`
    localHours[tz] = new Date(T_2359).getHours()
  }
  process.env.TZ = 'America/Los_Angeles'
  ok(
    '三个宿主时区下 cstDateKey 结果完全一致',
    results['America/Los_Angeles'] === results['Asia/Shanghai'] && results['Asia/Shanghai'] === results['UTC'],
    JSON.stringify(results)
  )
  console.log(
    `     （本地小时随 TZ 变化的证据：LA=${localHours['America/Los_Angeles']} 上海=${localHours['Asia/Shanghai']} UTC=${localHours['UTC']}）`
  )
}

// ── 二、reducer ───────────────────────────────────────────────────────────

function checkReducer(): void {
  section('二、reducer：七种事件')
  const ctx = { accountName: '主号', warn: (m: string) => warnings.push(m) }
  const warnings: string[] = []
  const t0 = dateKeyToDayStart(DAY_A) + 8 * HOUR // 北京 08:00

  let d = emptyDailyStats(DAY_A)
  const orig = structuredClone(d)
  d = applyStatsEvent(
    d,
    { kind: 'dispatch', at: t0, instanceIndex: 0, resource: 'wood', storage: 1_260_000, coord: 'X:100 Y:200', level: 5, travelTimeSec: 300 },
    ctx
  )
  ok('输入对象不被改动（返回新对象）', orig.dispatches === 0 && d.dispatches === 1)
  d = applyStatsEvent(
    d,
    { kind: 'dispatch', at: t0 + MIN, instanceIndex: 0, resource: 'wood', storage: null, coord: 'X:101 Y:201', level: 5, travelTimeSec: 300 },
    ctx
  )
  d = applyStatsEvent(
    d,
    { kind: 'dispatch', at: t0 + 2 * MIN, instanceIndex: 1, resource: 'mana', storage: 420_000, coord: 'X:1 Y:2', level: 4, travelTimeSec: 100 },
    { accountName: '小号' }
  )
  ok('派兵次数：全局 3、木材 2、魔水 1', d.dispatches === 3 && d.byResource.wood.dispatches === 2 && d.byResource.mana.dispatches === 1)
  ok('预计采集量 = Σ 储量（null 计 0）', d.byResource.wood.estimatedAmount === 1_260_000 && d.byResource.mana.estimatedAmount === 420_000)
  ok('储量未知计数', d.byResource.wood.unknownStorageDispatches === 1 && d.byInstance['0'].byResource.wood.unknownStorageDispatches === 1)
  ok('实例分桶与账号名', d.byInstance['0'].accountName === '主号' && d.byInstance['1'].accountName === '小号' && d.byInstance['1'].dispatches === 1)

  d = applyStatsEvent(d, { kind: 'cycleFailed', at: t0 + 3 * MIN, instanceIndex: 0, outcome: 'error', message: 'x', step: null, errorCode: null }, ctx)
  d = applyStatsEvent(d, { kind: 'cycleFailed', at: t0 + 4 * MIN, instanceIndex: 0, outcome: 'circuitBroken', message: 'y', step: 'S', errorCode: 'STEP_FAILED' }, ctx)
  ok('失败 1 / 熔断 1', d.failures === 1 && d.circuitBreaks === 1 && d.byInstance['0'].failures === 1 && d.byInstance['0'].circuitBreaks === 1)

  d = applyStatsEvent(d, { kind: 'tripCompleted', at: t0 + 5 * MIN, instanceIndex: 0, coord: 'X:100 Y:200', resource: 'wood' }, ctx)
  ok('完成趟数（自带类型）', d.byResource.wood.completed === 1)
  d = applyStatsEvent(
    d,
    { kind: 'tripCompleted', at: t0 + 6 * MIN, instanceIndex: 0, coord: 'X:101 Y:201', resource: null },
    { ...ctx, resourceOfCoord: (_i, c) => (c === 'X:101 Y:201' ? 'wood' : null) }
  )
  ok('完成趟数（resourceOfCoord 反查）', d.byResource.wood.completed === 2)
  d = applyStatsEvent(d, { kind: 'tripCompleted', at: t0 + 7 * MIN, instanceIndex: 0, coord: null, resource: null }, ctx)
  ok('完成趟数（查不到 → 按该实例派兵最多的资源归类并 warn）', d.byResource.wood.completed === 3 && warnings.some((w) => w.includes('归类')))
  const empty = applyStatsEvent(emptyDailyStats(DAY_A), { kind: 'tripCompleted', at: t0, instanceIndex: 3, coord: null, resource: null }, ctx)
  ok('今天没派过兵的回城不凭空计入', Object.values(empty.byResource).every((r) => r.completed === 0))

  d = applyStatsEvent(d, { kind: 'alertRaised', at: t0 + 8 * MIN, instanceIndex: 0, alertType: 'kicked' }, ctx)
  ok('告警计数', d.alerts === 1 && d.byInstance['0'].alerts === 1)

  d = applyStatsEvent(d, { kind: 'paused', at: t0 + 10 * MIN, instanceIndex: 0, reason: '机器人手动暂停' }, ctx)
  d = applyStatsEvent(d, { kind: 'paused', at: t0 + 12 * MIN, instanceIndex: 0, reason: '重复' }, ctx)
  ok('重复 paused 幂等（起点不被后移）', d.byInstance['0'].pausedSince === t0 + 10 * MIN)
  d = applyStatsEvent(d, { kind: 'resumed', at: t0 + 25 * MIN, instanceIndex: 0 }, ctx)
  ok('暂停时长 = 恢复 − 暂停 = 15 分', d.byInstance['0'].pausedMs === 15 * MIN && d.pausedMs === 15 * MIN && d.byInstance['0'].pausedSince === null)
  d = applyStatsEvent(d, { kind: 'resumed', at: t0 + 26 * MIN, instanceIndex: 0 }, ctx)
  ok('没在暂停中的 resumed 被忽略', d.pausedMs === 15 * MIN)

  const snap: ResourceSnapshot = { ...emptyResourceSnapshot(0, t0 + 30 * MIN), warnings: [] }
  d = applyStatsEvent(d, { kind: 'snapshot', at: snap.at, instanceIndex: 0, snapshot: snap }, ctx)
  ok('快照入桶', d.snapshots.length === 1 && d.snapshots[0].at === snap.at)
  let many = d
  for (let i = 0; i < 60; i++) {
    many = applyStatsEvent(many, { kind: 'snapshot', at: snap.at + i * MIN, instanceIndex: 0, snapshot: { ...snap, at: snap.at + i * MIN } }, ctx)
  }
  ok('快照裁到每天上限 48 张（保留最新）', many.snapshots.length === 48 && many.snapshots[47].at === snap.at + 59 * MIN)
  ok('updatedAt 跟最后一条事件', d.updatedAt === snap.at)

  const wrongDay = applyStatsEvent(d, { kind: 'alertRaised', at: T_0000, instanceIndex: 0, alertType: 'x' }, ctx)
  ok('日期不符的事件被拒绝（不弄脏桶）', wrongDay.alerts === d.alerts && warnings.some((w) => w.includes('不符')))
  ok('isDayEmpty：空桶 true / 有事件 false', isDayEmpty(emptyDailyStats(DAY_A)) && !isDayEmpty(d))
}

// ── 三、rolloverDay ───────────────────────────────────────────────────────

function checkRollover(): void {
  section('三、rolloverDay：暂停跨日切分')
  const ctx = { accountName: '主号' }
  let d = emptyDailyStats(DAY_A)
  d = applyStatsEvent(d, { kind: 'paused', at: T_0000 - 10 * MIN, instanceIndex: 0, reason: '连续失败' }, ctx) // 23:50
  const { closed, opened } = rolloverDay(d, T_0000 + 5_000)
  ok('前一天收口：暂停 10 分', closed.pausedMs === 10 * MIN && closed.byInstance['0'].pausedMs === 10 * MIN && closed.byInstance['0'].pausedSince === null)
  ok('新的一天从 0 点续算暂停', opened.dateKey === DAY_B && opened.byInstance['0'].pausedSince === T_0000 && opened.byInstance['0'].accountName === '主号')
  ok('新桶其他计数为 0', opened.dispatches === 0 && opened.pausedMs === 0 && opened.snapshots.length === 0)
  const next = applyStatsEvent(opened, { kind: 'resumed', at: T_0000 + 5 * MIN, instanceIndex: 0 }, ctx)
  ok('次日 00:05 恢复 → 次日暂停 5 分', next.pausedMs === 5 * MIN && next.byInstance['0'].pausedSince === null)
  ok('没有暂停的实例日切后是空桶（不落盘）', isDayEmpty(rolloverDay(emptyDailyStats(DAY_A), T_0000).opened))
}

// ── 四、格式化与文案 ──────────────────────────────────────────────────────

function checkFormat(): void {
  section('四、金额格式化与今日统计文案')
  ok('formatCnAmount 亿', formatCnAmount(1_110_000_000) === '11.1亿', formatCnAmount(1_110_000_000))
  ok('formatCnAmount 万', formatCnAmount(91_290_000) === '9129万', formatCnAmount(91_290_000))
  ok('formatCnAmount 万以下千分位', formatCnAmount(9_999) === '9,999' && formatCnAmount(59_677) === '6万', `${formatCnAmount(9_999)} / ${formatCnAmount(59_677)}`)
  ok('formatCnAmount null → —', formatCnAmount(null) === '—')
  ok('formatPausedDuration', formatPausedDuration(0) === '0分' && formatPausedDuration(15 * MIN) === '15分' && formatPausedDuration(3 * HOUR + 12 * MIN) === '3小时12分')

  const t0 = dateKeyToDayStart(DAY_A) + 8 * HOUR
  let d = emptyDailyStats(DAY_A)
  for (let i = 0; i < 6; i++) {
    d = applyStatsEvent(
      d,
      { kind: 'dispatch', at: t0 + i * MIN, instanceIndex: 0, resource: 'wood', storage: 1_260_000, coord: `X:${i} Y:0`, level: 5, travelTimeSec: 100 },
      { accountName: '主号' }
    )
  }
  d = applyStatsEvent(d, { kind: 'dispatch', at: t0 + 7 * MIN, instanceIndex: 0, resource: 'gold', storage: null, coord: 'X:9 Y:9', level: 3, travelTimeSec: 100 }, { accountName: '主号' })
  const text = renderDailyStatsText(d, { now: t0 + HOUR, formatClock: (at) => new Date(at + 8 * HOUR).toISOString().slice(11, 16) })
  console.log(text.split('\n').map((l) => '     | ' + l).join('\n'))
  ok('文案含「派兵 7 次」', text.includes('派兵 7 次'))
  ok('文案含木材预计量 756万', text.includes('木材 6 次 ≈ 756万'))
  ok('文案提示储量未知', text.includes('有 1 趟储量没读出来'))
  ok('文案含实例行与账号名', text.includes('实例 0「主号」'))
  ok('文案标注北京时间', text.includes('北京时间'))
}

// ── 五、落盘往返 ──────────────────────────────────────────────────────────

async function checkStore(dataDir: string): Promise<void> {
  section('五、落盘往返与容错')
  const t0 = dateKeyToDayStart(DAY_A) + 8 * HOUR
  let d = emptyDailyStats(DAY_A)
  d = applyStatsEvent(d, { kind: 'dispatch', at: t0, instanceIndex: 2, resource: 'iron', storage: 2_000_000, coord: 'X:5 Y:5', level: 6, travelTimeSec: 200 }, { accountName: '铁号' })
  await saveDailyStats(dataDir, d)
  const back = await loadDailyStats(dataDir, DAY_A)
  ok('save → load 一致', JSON.stringify(back) === JSON.stringify(d))
  ok('不存在的日期 → null', (await loadDailyStats(dataDir, '2020-01-01')) === null)

  const warns: string[] = []
  await writeFile(statsFileOf(dataDir, '2026-09-01'), '{ 这不是 JSON', 'utf8')
  const broken = await loadDailyStats(dataDir, '2026-09-01', (m) => warns.push(m))
  ok('坏 JSON 被兜成空桶并 warn', broken !== null && broken.dateKey === '2026-09-01' && broken.dispatches === 0 && warns.length === 1)

  await writeFile(
    statsFileOf(dataDir, '2026-09-02'),
    JSON.stringify({ dateKey: '2026-09-02', dispatches: 'abc', byInstance: { x: {}, '1': { dispatches: 4, pausedSince: 'no' } }, snapshots: [1, 2] }),
    'utf8'
  )
  const partial = await loadDailyStats(dataDir, '2026-09-02', (m) => warns.push(m))
  ok(
    '字段坏一个只回退一个（normalizeDailyStats）',
    partial !== null && partial.dispatches === 0 && partial.byInstance['1']?.dispatches === 4 && partial.byInstance['1'].pausedSince === null && !('x' in partial.byInstance) && partial.snapshots.length === 0
  )
  await writeFile(statsFileOf(dataDir, 'notes.txt'), 'x', 'utf8')
  await mkdir(join(dataDir, 'stats', 'sub'), { recursive: true })
  const keys = await listDailyKeys(dataDir)
  ok('listDailyKeys 只认 YYYY-MM-DD.json 且升序', JSON.stringify(keys) === JSON.stringify(['2026-09-01', '2026-09-02', DAY_A]), JSON.stringify(keys))
  const removed = await pruneDailyStats(dataDir, 7, { now: t0 })
  ok('pruneDailyStats 删掉 7 天前的', JSON.stringify(removed) === JSON.stringify(['2026-09-01', '2026-09-02']) && (await listDailyKeys(dataDir)).length === 1, JSON.stringify(removed))
  try {
    await loadDailyStats(dataDir, '2026/09/09')
    ok('非法日期键抛错', false)
  } catch (e) {
    ok('非法日期键抛中文错误', e instanceof Error && e.message.includes('YYYY-MM-DD'))
  }
}

// ── 六、StatsCenter ───────────────────────────────────────────────────────

async function checkCenter(): Promise<void> {
  section('六、StatsCenter：跨 0 点换桶、补记、IPC')
  const dataDir = await mkdtemp(join(tmpdir(), 'wl-stats-center-'))
  const logs: string[] = []
  const pushed: DailyStats[] = []
  let now = T_2359 - 30 * MIN // 北京 23:29
  const names: Record<number, string | null> = { 0: '主号', 1: null }
  let snapshotCalls = 0

  resetStatsCenterForTest()
  const center = getStatsCenter()
  await center.init({
    dataDir: () => dataDir,
    accountNameOf: async (i) => names[i] ?? null,
    now: () => now,
    log: (level, message) => logs.push(`[${level}] ${message}`),
    onToday: (s) => pushed.push(s),
    snapshotNow: async (i) => {
      snapshotCalls += 1
      return { ...emptyResourceSnapshot(i, now), rows: emptyResourceSnapshot(i, now).rows.map((r) => ({ ...r, itemTotal: 290_000_000, rawItem: '2.9亿' })) }
    }
  })
  center.registerHandlers()
  ok('init 后今天是 2026-09-09', center.today().dateKey === DAY_A)

  center.record({ kind: 'dispatch', at: now, instanceIndex: 0, resource: 'wood', storage: 1_260_000, coord: 'X:1 Y:1', level: 5, travelTimeSec: 100 })
  center.record({ kind: 'paused', at: now + MIN, instanceIndex: 0, reason: '连续失败' })
  ok('record 同步生效', center.today().dispatches === 1 && center.today().byInstance['0'].pausedSince === now + MIN)
  ok('today() 是克隆', (() => { const t = center.today(); t.dispatches = 99; return center.today().dispatches === 1 })())
  await sleep(50)
  ok('账号名异步刷新后补进桶', center.today().byInstance['0'].accountName === '主号')

  // 跨 0 点：事件时间已是次日 00:05
  now = T_0000 + 5 * MIN
  center.record({ kind: 'tripCompleted', at: now, instanceIndex: 0, coord: 'X:1 Y:1', resource: null })
  ok('跨 0 点自动换到 2026-09-10', center.today().dateKey === DAY_B)
  ok('昨天派兵的队伍今天回城 → 反查记账表归到木材', center.today().byResource.wood.completed === 1)
  ok('暂停跨日续算（pausedSince = 0 点）', center.today().byInstance['0'].pausedSince === T_0000)
  center.record({ kind: 'resumed', at: now + MIN, instanceIndex: 0 })
  ok('次日暂停 6 分', center.today().pausedMs === 6 * MIN)
  await sleep(1300)
  const yesterday = await loadDailyStats(dataDir, DAY_A)
  ok('昨天的文件已写出：派兵 1、暂停 30 分（23:30→00:00）', yesterday !== null && yesterday.dispatches === 1 && yesterday.pausedMs === 30 * MIN, yesterday ? `pausedMs=${yesterday.pausedMs / MIN}分` : 'null')
  const todayFile = await loadDailyStats(dataDir, DAY_B)
  ok('今天的文件已落盘（防抖后）', todayFile !== null && todayFile.pausedMs === 6 * MIN)
  ok('stats:today 至少推过一次且是新一天', pushed.length >= 1 && pushed[pushed.length - 1].dateKey === DAY_B)

  // 早于今天的事件：补记进昨天的文件，不影响 current
  center.record({ kind: 'alertRaised', at: T_2359, instanceIndex: 1, alertType: 'kicked' })
  await sleep(100)
  const yesterday2 = await loadDailyStats(dataDir, DAY_A)
  ok('早于今天的事件补记进旧文件', yesterday2 !== null && yesterday2.alerts === 1 && yesterday2.dispatches === 1 && center.today().alerts === 0)

  // 时钟推进但没有事件：checkRollover 手动触发（正式环境由 unref 定时器调）
  now = T_0000 + 25 * HOUR
  center.checkRollover(now)
  ok('定时器路径的日切换到 2026-09-11', center.today().dateKey === '2026-09-11' && isDayEmpty(center.today()))
  ok('日切前的一天已写出', (await loadDailyStats(dataDir, DAY_B)) !== null)

  // IPC 通道
  const { ipcMain } = (await import('electron')) as unknown as {
    ipcMain: { _invoke(channel: string, ...args: unknown[]): Promise<unknown> }
  }
  const viaDaily = (await ipcMain._invoke(STATS_CH.daily, DAY_A)) as DailyStats
  ok('stats:daily 读旧日', viaDaily.dateKey === DAY_A && viaDaily.dispatches === 1)
  const viaToday = (await ipcMain._invoke(STATS_CH.daily)) as DailyStats
  ok('stats:daily 不传参 = 今天', viaToday.dateKey === '2026-09-11')
  const viaRange = (await ipcMain._invoke(STATS_CH.range, '2026-09-08', '2026-09-11')) as DailyStats[]
  ok('stats:range 逐日 4 天（无数据的天是空桶）', viaRange.length === 4 && viaRange[0].dateKey === '2026-09-08' && viaRange[0].dispatches === 0 && viaRange[1].dispatches === 1)
  try {
    await ipcMain._invoke(STATS_CH.range, DAY_B, DAY_A)
    ok('stats:range from>to 抛错', false)
  } catch (e) {
    const se = decodeBridgeError(e)
    ok('stats:range from>to 抛 INVALID_ARGUMENT（可解出 code 的中文）', se?.code === 'INVALID_ARGUMENT' && se.message.includes('晚于'), se?.message ?? String(e))
  }
  try {
    await ipcMain._invoke(STATS_CH.daily, '20260909')
    ok('stats:daily 非法格式抛错', false)
  } catch (e) {
    const se = decodeBridgeError(e)
    ok('stats:daily 非法格式抛 INVALID_ARGUMENT', se?.code === 'INVALID_ARGUMENT' && se.message.includes('YYYY-MM-DD'))
  }
  const snap = (await ipcMain._invoke(STATS_CH.snapshotNow, 0)) as ResourceSnapshot
  ok('stats:snapshotNow 调了接线方并记成快照', snapshotCalls === 1 && snap.instanceIndex === 0 && center.today().snapshots.length === 1)

  // record 绝不抛
  let threw = false
  try {
    center.record({ kind: 'dispatch', at: Number.NaN, instanceIndex: 0, resource: 'gold', storage: 1, coord: null, level: null, travelTimeSec: null })
    center.record({ kind: 'bogus' } as unknown as StatsEvent)
  } catch {
    threw = true
  }
  ok('record 收到坏事件不抛（NaN 时间按 now 记，未知种类只 warn）', !threw && center.today().byResource.gold.dispatches === 1 && logs.some((l) => l.includes('未知事件')))

  await center.stop()
  ok('stop 后今天已落盘（含快照）', ((await loadDailyStats(dataDir, '2026-09-11'))?.snapshots.length ?? 0) === 1)
  ok('日志里没有 error 级别', !logs.some((l) => l.startsWith('[error]')), logs.filter((l) => l.startsWith('[error]')).join(' | '))

  // 重启还原：init 读回今天
  resetStatsCenterForTest()
  const again = getStatsCenter()
  await again.init({ dataDir: () => dataDir, accountNameOf: async () => null, now: () => now, log: () => undefined })
  ok('重启后读回今天的桶', again.today().dateKey === '2026-09-11' && again.today().snapshots.length === 1 && again.today().byResource.gold.dispatches === 1)
  await again.stop()

  // 引擎没跑就 stats:snapshotNow 的错误话术
  resetStatsCenterForTest()
  const noSnap = getStatsCenter()
  await noSnap.init({ dataDir: () => dataDir, accountNameOf: async () => null, now: () => now, log: () => undefined })
  noSnap.registerHandlers()
  try {
    await ipcMain._invoke(STATS_CH.snapshotNow, 0)
    ok('未接线 snapshotNow 抛错', false)
  } catch (e) {
    const se = decodeBridgeError(e)
    ok('未接线 snapshotNow 抛中文「未接线」', se !== null && se.message.includes('未接线'))
  }
  await noSnap.stop()
  console.log(`     （日志 ${logs.length} 行；文件目录 ${dataDir}）`)
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.env.TZ = 'America/Los_Angeles'
  console.log('===== 数据统计模块 离线自检（不碰模拟器）=====')
  checkBoundary()
  checkReducer()
  checkRollover()
  checkFormat()
  const dataDir = await mkdtemp(join(tmpdir(), 'wl-stats-store-'))
  await checkStore(dataDir)
  await checkCenter()

  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
  if (fail > 0) process.exitCode = 1
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
