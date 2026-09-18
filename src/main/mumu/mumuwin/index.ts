/**
 * MuMu 模拟器驱动（Windows，MuMuManager.exe）。实现 driver.ts 的 EmulatorDriver。
 *
 * 职责边界与另外两个驱动一致：**只**通过 MuMuManager 管实例的「生老病死」。装 apk / 起应用 / 点屏幕 / 截图
 * 一律走 adb 层（模块 b）—— MuMuManager 虽然有 `control app` / `adb` / `sh` 子命令，但每次都要多起一个进程，
 * 而且我们已经有一条 adb 通道，没必要用，不写 fallback。
 *
 * ★ 与雷电 / Mac 版 mumutool 的差异（真机实测 6.6.4.0，2026-09-14），改代码时别混：
 *   1. 输出是 JSON（UTF-8）：`info -v all` 是「以 index 字符串为键」的对象，`info -v N` 是单个对象（parse.ts）。
 *   2. 业务错误 errcode 非 0 且退出码 = errcode；不存在的实例 errcode -200（cli.ts 翻译成 MUMU_INSTANCE_MISSING）。
 *   3. adb 端口只有进程起来后才出现在 info 里（实例 0 = 16384），每次现读，不推算。
 *   4. 就绪信号是 is_android_started：`launch` 1.8s 返回、约 8 秒后就绪。
 *   5. 配置**读写都可用**：`setting -v N -k 键 -val 值`（可多组）；分辨率要走 custom 模式的四个键（见 MUMU_WIN_SETTING_KEYS）。
 *   6. 新建 / 克隆不报新 index，用列表差集确认（与另外两家一样）。克隆出来的实例名是「<原名>-<序号>」。
 *
 * 命令一览（实测 6.6.4.0 的用法文本）：
 *   info -v all|N / control -v N launch|shutdown|restart / create [-n K] / clone -v N [-n K] / delete -v N /
 *   rename -v N -n 名字 / setting -v N|all [-k 键 -val 值]… [-a|-aw] /
 *   control -v N hide_window|show_window|layout_window [-px -py -sw -sh]（窗口摆放，2026-09-18 实测）
 */

import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { INSTANCE_DISK_COST_BYTES } from '@shared/constants'
import type {
  CreateInstanceOptions,
  DriverWindowCommand,
  MumuInstance,
  MumuWinInstanceRaw
} from '@shared/domain'
import { AppError } from '@shared/errors'
import type { EmulatorDriver } from '../driver'
import { getMumuWinCliPath, judgeMumuWinOutput, mumuWinExec, setMumuWinCliPath } from './cli'
import {
  mumuWinRawToInstance,
  parseMumuWinInfo,
  parseMumuWinResolutions,
  type MumuWinResolution
} from './parse'

/** info 实测 ~75ms。 */
const INFO_TIMEOUT_MS = 15_000
/** launch / shutdown / restart 只是下发命令，launch 实测 1.8s 返回。 */
const LIFECYCLE_TIMEOUT_MS = 60_000
/** create / clone 要复制约 3.7GB 虚拟磁盘，给足时间。 */
const PROVISION_TIMEOUT_MS = 15 * 60_000
/** delete 默认会等删完。 */
const DELETE_TIMEOUT_MS = 10 * 60_000
const SETTING_TIMEOUT_MS = 30_000
const READY_POLL_INTERVAL_MS = 600
/** create / clone 之后等新实例出现在 info 里的最长时间。 */
const PROVISION_SETTLE_MS = 20_000
/** 分辨率是配置项，很少变；缓存一会儿，免得每次 3 秒轮询都多起一个进程。 */
const RESOLUTION_CACHE_MS = 30_000
const RESOLUTION_KEYS = ['resolution_width', 'resolution_height', 'resolution_dpi'] as const

type Pair = [key: string, value: string]

/**
 * 友好键 -> MuMuManager setting 键值对。面板「写入配置」与「新建实例」的 settings JSON 用这些键，
 * 与雷电的 LD_MODIFY_KEYS 同名同义，用户不用记两套。
 * ★ 分辨率必须把 resolution_mode 切成 custom，只改 *.custom 三个值是不生效的（实测实例 0 的 mode 是 tablet.1）。
 */
export const MUMU_WIN_SETTING_KEYS: Record<
  string,
  { describe: string; toPairs: (v: unknown) => Pair[] }
> = {
  resolution: {
    describe: '"宽,高,DPI"（如 "2560,1440,360"）或 {"width":2560,"height":1440,"dpi":360}',
    toPairs: (v) => {
      const r = parseResolution(v)
      return [
        ['resolution_mode', 'custom'],
        ['resolution_width.custom', String(r.width)],
        ['resolution_height.custom', String(r.height)],
        ['resolution_dpi.custom', String(r.dpi)]
      ]
    }
  },
  cpu: {
    describe: 'CPU 核数（整数 1~32）',
    toPairs: (v) => [
      ['performance_mode', 'custom'],
      ['performance_cpu.custom', formatInt(v, 'cpu', 1, 32)]
    ]
  },
  memory: {
    describe: '内存 MB（整数 512~65536；MuMu 按 GB 存，会自动换算）',
    toPairs: (v) => {
      const mb = Number(formatInt(v, 'memory', 512, 65536))
      return [
        ['performance_mode', 'custom'],
        ['performance_mem.custom', (mb / 1024).toFixed(6)]
      ]
    }
  },
  manufacturer: {
    describe: '厂商字符串（phone_brand）',
    toPairs: (v) => [['phone_brand', formatString(v)]]
  },
  model: {
    describe: '机型字符串（phone_model）',
    toPairs: (v) => [['phone_model', formatString(v)]]
  },
  pnumber: {
    describe: '手机号（phone_number）',
    toPairs: (v) => [['phone_number', formatString(v)]]
  },
  imei: { describe: '15 位数字（phone_imei）', toPairs: (v) => [['phone_imei', formatString(v)]] },
  autorotate: {
    describe: 'true/false（window_auto_rotate）',
    toPairs: (v) => [['window_auto_rotate', formatBool(v)]]
  },
  lockwindow: {
    describe: 'true/false（window_size_fixed）',
    toPairs: (v) => [['window_size_fixed', formatBool(v)]]
  },
  root: {
    describe: 'true/false（root_permission）',
    toPairs: (v) => [['root_permission', formatBool(v)]]
  }
}

/** MuMuManager 原始键的样子：小写字母开头，只含字母数字、下划线、点，且至少带一个下划线或点。 */
const RAW_KEY_RE = /^[a-z][a-z0-9_.]*$/

/**
 * settings JSON -> `setting` 的 `-k 键 -val 值` 参数串。友好键按 MUMU_WIN_SETTING_KEYS 展开；
 * 长得像 MuMuManager 原始键的（如 performance_mode）原样透传；其余键报错列出可用键，不静默忽略。
 * 同一个原始键出现多次时后者覆盖（cpu 与 memory 都会写 performance_mode=custom）。
 */
export function buildMumuWinSettingArgs(settings: Record<string, unknown>): string[] {
  const keys = Object.keys(settings)
  if (keys.length === 0) {
    throw new AppError('INVALID_ARGUMENT', '没有要写入的配置项')
  }
  const pairs = new Map<string, string>()
  for (const k of keys) {
    const spec = MUMU_WIN_SETTING_KEYS[k]
    if (spec) {
      for (const [pk, pv] of spec.toPairs(settings[k])) pairs.set(pk, pv)
      continue
    }
    if (RAW_KEY_RE.test(k) && (k.includes('_') || k.includes('.'))) {
      pairs.set(k, formatRaw(settings[k], k))
      continue
    }
    throw new AppError(
      'INVALID_ARGUMENT',
      `MuMu 不支持配置键「${k}」。可用的友好键：${Object.keys(MUMU_WIN_SETTING_KEYS).join('、')}；` +
        '或直接写 MuMuManager setting 的原始键（如 performance_mode）。',
      { key: k }
    )
  }
  const args: string[] = []
  for (const [k, v] of pairs) args.push('-k', k, '-val', v)
  return args
}

export function createMumuWinDriver(): EmulatorDriver {
  return {
    kind: 'mumu',
    label: 'MuMu 模拟器',
    setCliPath: setMumuWinCliPath,
    getCliPath: getMumuWinCliPath,
    list: listMumuWinInstances,
    open: openInstance,
    close: closeInstance,
    restart: restartInstance,
    create: createInstances,
    clone: cloneInstance,
    remove: deleteInstance,
    config: configInstance,
    waitReady: waitInstanceReady,
    setWindow
  }
}

// ── 列表 ──────────────────────────────────────────────────────────────────

async function listRaw(): Promise<MumuWinInstanceRaw[]> {
  const argv = ['info', '-v', 'all']
  const r = await mumuWinExec(argv, { timeoutMs: INFO_TIMEOUT_MS })
  return parseMumuWinInfo(judgeMumuWinOutput(r, argv, '列出实例') ?? {})
}

export async function listMumuWinInstances(): Promise<MumuInstance[]> {
  const raws = await listRaw()
  const res = await resolutionsFor(raws.map((r) => r.index))
  return raws.map((r) => mumuWinRawToInstance(r, res.get(r.index) ?? null))
}

/** 取单个实例；不存在时 MuMuManager 报 errcode -200，cli.ts 已翻译成 MUMU_INSTANCE_MISSING。 */
async function getRaw(index: number): Promise<MumuWinInstanceRaw> {
  assertIndex(index)
  const argv = ['info', '-v', String(index)]
  const r = await mumuWinExec(argv, { timeoutMs: INFO_TIMEOUT_MS })
  const raw = parseMumuWinInfo(judgeMumuWinOutput(r, argv, `读取实例 ${index}`) ?? {}).find(
    (x) => x.index === index
  )
  if (!raw) {
    throw new AppError('MUMU_INSTANCE_MISSING', `实例 ${index} 不存在，请刷新实例列表后重试。`, {
      index
    })
  }
  return raw
}

// ── 分辨率（配置项，缓存）─────────────────────────────────────────────────

let resolutionCache: { at: number; map: Map<number, MumuWinResolution> } = {
  at: 0,
  map: new Map()
}

async function resolutionsFor(indices: number[]): Promise<Map<number, MumuWinResolution>> {
  if (indices.length === 0) return new Map()
  const fresh = Date.now() - resolutionCache.at < RESOLUTION_CACHE_MS
  if (fresh && indices.every((i) => resolutionCache.map.has(i))) return resolutionCache.map
  try {
    const argv = ['setting', '-v', 'all', ...RESOLUTION_KEYS.flatMap((k) => ['-k', k])]
    const r = await mumuWinExec(argv, { timeoutMs: INFO_TIMEOUT_MS })
    const map = parseMumuWinResolutions(
      judgeMumuWinOutput(r, argv, '读取实例分辨率'),
      indices.length === 1 ? indices[0] : undefined
    )
    resolutionCache = { at: Date.now(), map }
    return map
  } catch {
    // 分辨率只是提示信息，读不到不影响列表；过一个缓存周期再试。
    resolutionCache = { at: Date.now(), map: resolutionCache.map }
    return resolutionCache.map
  }
}

function invalidateResolutions(): void {
  resolutionCache = { at: 0, map: resolutionCache.map }
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

/**
 * 启动实例。`control launch` 约 1.8s 返回，此时进程已起、Android 还没好；
 * 调用方要么接 waitReady()，要么靠轮询看状态，**别把返回当作可以截图**。
 */
async function openInstance(index: number): Promise<void> {
  const raw = await getRaw(index)
  if (raw.processStarted) return
  await control(index, 'launch', `启动实例 ${index}`)
}

async function closeInstance(index: number): Promise<void> {
  const raw = await getRaw(index)
  if (!raw.processStarted) return
  await control(index, 'shutdown', `关闭实例 ${index}`)
}

async function restartInstance(index: number): Promise<void> {
  const raw = await getRaw(index)
  if (!raw.processStarted) {
    await control(index, 'launch', `重启实例 ${index}`)
    return
  }
  await control(index, 'restart', `重启实例 ${index}`)
}

async function control(index: number, action: string, what: string): Promise<void> {
  const argv = ['control', '-v', String(index), action]
  const r = await mumuWinExec(argv, { timeoutMs: LIFECYCLE_TIMEOUT_MS })
  judgeMumuWinOutput(r, argv, what)
}

/**
 * 摆放窗口：`control -v N hide_window | show_window | layout_window -px -py -sw -sh`。
 *
 * ★ 实例没起来时直接报中文错，别让 MuMu 返回一句 errcode 让用户猜。
 * ★ 尺寸不一定照给的来：2026-09-18 实测传 480×270，一次被夹成 718×404，一次得到 479×269。
 *   所以调用方**不要**拿传进去的值当作最终窗口尺寸，要用就从 `control` 的返回里读。
 * ★ 窗口状态与自动化无关：Android 离屏渲染，隐藏/缩小之后 screencap 照常是实例配置的分辨率。
 */
async function setWindow(index: number, cmd: DriverWindowCommand): Promise<void> {
  const raw = await getRaw(index)
  if (!raw.processStarted) {
    throw new AppError('MUMU_API_ERROR', `实例 ${index} 没有在运行，没有窗口可以摆放。`, { index })
  }
  if (cmd.kind === 'hide') {
    await control(index, 'hide_window', `隐藏实例 ${index} 的窗口`)
    return
  }
  if (cmd.kind === 'show') {
    await control(index, 'show_window', `显示实例 ${index} 的窗口`)
    return
  }
  // layout：先确保窗口是显示的，否则「缩到角落」在隐藏状态下等于什么都没发生。
  await control(index, 'show_window', `显示实例 ${index} 的窗口`)
  const argv = [
    'control',
    '-v',
    String(index),
    'layout_window',
    '-px',
    String(Math.round(cmd.x)),
    '-py',
    String(Math.round(cmd.y)),
    '-sw',
    String(Math.round(cmd.width)),
    '-sh',
    String(Math.round(cmd.height))
  ]
  const r = await mumuWinExec(argv, { timeoutMs: LIFECYCLE_TIMEOUT_MS })
  judgeMumuWinOutput(r, argv, `摆放实例 ${index} 的窗口`)
}

/**
 * 新建实例：`create [-n K]`，建完用「列表差集」确认新 index，再按 settings 写配置。
 * 新实例的默认分辨率不一定是 2560×1440 —— 面板「新建实例」对 Windows 两家驱动默认都填 {"resolution":"2560,1440,360"}。
 * opts.type（手机 / 平板）对 MuMu 没有意义：分辨率已经显式写了。
 */
async function createInstances(opts: CreateInstanceOptions = {}): Promise<number[]> {
  const count = opts.count ?? 1
  if (!Number.isInteger(count) || count < 1 || count > 16) {
    throw new AppError('INVALID_ARGUMENT', '要创建的实例数量必须是 1~16 的整数', { count })
  }
  await assertDiskSpace(count)
  const argv = ['create']
  if (count >= 2) argv.push('-n', String(count))
  const fresh = await runProvision(argv, '创建', count)
  if (opts.settings && Object.keys(opts.settings).length > 0) {
    const args = buildMumuWinSettingArgs(opts.settings)
    for (const idx of fresh) await writeSetting(idx, args)
  }
  return fresh
}

/**
 * 克隆实例：`clone -v N`，新实例名是「<原名>-<序号>」，配置（含分辨率）随源实例。
 * 源实例正在运行时 MuMu 是否照样复制未实测，这里不强制停机。
 */
async function cloneInstance(index: number): Promise<number[]> {
  await getRaw(index)
  await assertDiskSpace(1)
  return runProvision(['clone', '-v', String(index)], '克隆', 1)
}

/** 删除实例。**不可撤销**。正在运行的实例先拒绝，免得 MuMu 把它半删不删。 */
async function deleteInstance(index: number): Promise<void> {
  const raw = await getRaw(index)
  if (raw.processStarted) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `实例 ${index}「${raw.name}」正在运行，请先关闭再删除。`,
      { index }
    )
  }
  const argv = ['delete', '-v', String(index)]
  const r = await mumuWinExec(argv, { timeoutMs: DELETE_TIMEOUT_MS })
  judgeMumuWinOutput(r, argv, `删除实例 ${index}`)
  invalidateResolutions()
}

/** 写入实例配置。键见 MUMU_WIN_SETTING_KEYS；分辨率等配置要重启实例才生效。 */
async function configInstance(index: number, settings: Record<string, unknown>): Promise<void> {
  await getRaw(index)
  await writeSetting(index, buildMumuWinSettingArgs(settings))
}

async function writeSetting(index: number, args: string[]): Promise<void> {
  const argv = ['setting', '-v', String(index), ...args]
  const r = await mumuWinExec(argv, { timeoutMs: SETTING_TIMEOUT_MS })
  judgeMumuWinOutput(r, argv, `写入实例 ${index} 的配置`)
  invalidateResolutions()
}

/** 等实例真正可用（is_android_started=true）。 */
async function waitInstanceReady(index: number, timeoutMs: number): Promise<MumuInstance> {
  assertIndex(index)
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let lastState = '未知'
  for (;;) {
    let raw: MumuWinInstanceRaw | undefined
    try {
      raw = await getRaw(index)
    } catch (e) {
      // 实例不存在是永久失败；其它偶发失败（MuMu 服务正忙）到期前继续等。
      if (AppError.from(e).code === 'MUMU_INSTANCE_MISSING' || Date.now() >= deadline) throw e
    }
    if (raw) {
      lastState = raw.playerState ?? (raw.processStarted ? 'starting' : 'stopped')
      if (raw.processStarted && raw.androidStarted) {
        const res = await resolutionsFor([index])
        return mumuWinRawToInstance(raw, res.get(index) ?? null)
      }
      if (!raw.processStarted && raw.launchErrCode !== 0) {
        throw new AppError(
          'MUMU_API_ERROR',
          `实例 ${index}「${raw.name}」启动失败（launch_err_code ${raw.launchErrCode}）：${raw.launchErrMsg || '无说明'}。请在 MuMu 多开器里手动检查该实例。`,
          { index, launchErrCode: raw.launchErrCode, launchErrMsg: raw.launchErrMsg }
        )
      }
    }
    if (Date.now() >= deadline) {
      throw new AppError(
        'TIMEOUT',
        raw
          ? `等待实例 ${index} 就绪超时（${timeoutMs}ms），当前状态：${lastState}${
              raw.processStarted && !raw.androidStarted ? '（进程已起，Android 尚未启动完成）' : ''
            }。可在 MuMu 多开器里手动查看该实例。`
          : `等待实例 ${index} 就绪超时（${timeoutMs}ms），实例始终读不到。`,
        { index, timeoutMs, lastState }
      )
    }
    await sleep(READY_POLL_INTERVAL_MS)
  }
}

// ── 内部工具 ──────────────────────────────────────────────────────────────

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new AppError('INVALID_ARGUMENT', `实例序号非法：${String(index)}（必须是非负整数）`, {
      index
    })
  }
}

/**
 * create / clone 的公共流程：记录创建前的 index 集合 -> 执行 -> 用列表差集确认新实例。
 * MuMuManager 的 create / clone 成功时只回 {"errcode":0}，不报新 index，差集是唯一可靠来源。
 */
async function runProvision(argv: string[], verb: string, expect: number): Promise<number[]> {
  const before = new Set((await listRaw()).map((r) => r.index))
  const r = await mumuWinExec(argv, { timeoutMs: PROVISION_TIMEOUT_MS })
  judgeMumuWinOutput(r, argv, `${verb}实例`)
  invalidateResolutions()

  const deadline = Date.now() + PROVISION_SETTLE_MS
  for (;;) {
    const fresh = (await listRaw())
      .map((x) => x.index)
      .filter((i) => !before.has(i))
      .sort((a, b) => a - b)
    if (fresh.length >= expect || (fresh.length > 0 && Date.now() >= deadline)) return fresh
    if (Date.now() >= deadline) break
    await sleep(500)
  }
  throw new AppError(
    'MUMU_BAD_OUTPUT',
    `${verb}实例的命令已执行，但 ${PROVISION_SETTLE_MS / 1000} 秒内没在列表里看到新实例。请到 MuMu 多开器里手动确认。`,
    { argv, output: r.stdout.slice(0, 300), exitCode: r.code }
  )
}

/**
 * 创建前的磁盘余量检查：每个实例约 INSTANCE_DISK_COST_BYTES。检查目标是 MuMuManager.exe 所在的卷
 * （实例磁盘在 <安装目录>\vms\，与它同卷）。检查本身失败时**不阻断创建**，只是放弃这层保护。
 */
async function assertDiskSpace(count: number): Promise<void> {
  const need = count * INSTANCE_DISK_COST_BYTES
  let free: number
  try {
    const st = await statfs(dirname(getMumuWinCliPath()))
    free = Number(st.bavail) * Number(st.bsize)
  } catch {
    return
  }
  if (!Number.isFinite(free) || free <= 0) return
  if (free < need) {
    throw new AppError(
      'IO_ERROR',
      `磁盘空间不足：新建 ${count} 个实例约需 ${gb(need)}，当前可用 ${gb(free)}。请清理磁盘或删除不用的实例后重试。`,
      { needBytes: need, freeBytes: free, count }
    )
  }
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`
}

function parseResolution(v: unknown): { width: number; height: number; dpi: number } {
  if (typeof v === 'string') {
    const m = /^\s*(\d+)\s*[,x×]\s*(\d+)\s*[,@]\s*(\d+)\s*$/i.exec(v)
    if (m) return { width: Number(m[1]), height: Number(m[2]), dpi: Number(m[3]) }
  } else if (v && typeof v === 'object') {
    const o = v as { width?: unknown; height?: unknown; dpi?: unknown }
    if (isPosInt(o.width) && isPosInt(o.height) && isPosInt(o.dpi)) {
      return { width: o.width, height: o.height, dpi: o.dpi }
    }
  }
  throw new AppError(
    'INVALID_ARGUMENT',
    `resolution 的格式应为 "宽,高,DPI"（如 "2560,1440,360"），收到：${JSON.stringify(v)}`
  )
}

function formatInt(v: unknown, key: string, min: number, max: number): string {
  const n = typeof v === 'string' ? Number(v) : v
  if (!isPosInt(n) || n < min || n > max) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `${key} 必须是 ${min}~${max} 的整数，收到：${JSON.stringify(v)}`
    )
  }
  return String(n)
}

function formatString(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new AppError('INVALID_ARGUMENT', `配置值必须是非空字符串，收到：${JSON.stringify(v)}`)
  }
  return v.trim()
}

/** MuMuManager 的布尔配置值是字符串 "true" / "false"。 */
function formatBool(v: unknown): string {
  if (v === true || v === 1 || v === '1' || v === 'true') return 'true'
  if (v === false || v === 0 || v === '0' || v === 'false') return 'false'
  throw new AppError(
    'INVALID_ARGUMENT',
    `开关值必须是 true/false 或 1/0，收到：${JSON.stringify(v)}`
  )
}

function formatRaw(v: unknown, key: string): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string' && v.trim()) return v.trim()
  throw new AppError(
    'INVALID_ARGUMENT',
    `配置键「${key}」的值必须是非空字符串、数字或布尔，收到：${JSON.stringify(v)}`
  )
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
