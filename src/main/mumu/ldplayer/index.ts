/**
 * 雷电模拟器驱动（Windows）。实现 driver.ts 的 EmulatorDriver。
 *
 * 职责边界与 MuMu 驱动一致：**只**通过 ldconsole 管实例的「生老病死」。
 * 装 apk、起应用、点屏幕、截图一律走 adb 层（模块 b）——雷电虽然有 runapp / installapp / adb 子命令，
 * 但走 ldconsole 每次都要多起一个进程，而且输出编码、退出码都不可靠（见 cli.ts），没必要用。
 *
 * ★ 雷电与 MuMu 的三点差异，改代码时别混：
 *   1. 没有 JSON：list2 是 CSV，成败靠退出码 + 文本（cli.ts）；对不存在的 index，`modify` 会静默成功，
 *      所以每个针对实例的操作都先 list2 确认实例存在。
 *   2. 端口固定按 5555 + 2·index 推算（constants.ts 有实测依据），停机实例给 null。
 *   3. 就绪信号只有 android_started 一个布尔量：pid 有效但 android_started=0 就是「启动中」，
 *      此时 adb 能连上但 screencap 是黑帧，与 MuMu 的 enableScreen 语义相同。
 *
 * 命令一览（实测 14.0.26.1 的 `ldconsole` 用法文本）：
 *   list2 / launch --index N / quit --index N / reboot --index N / add [--name X] /
 *   copy --from N [--name X] / remove --index N / modify --index N --resolution w,h,dpi --cpu C --memory M …
 */

import type { CreateInstanceOptions, MumuInstance } from '@shared/domain'
import { AppError } from '@shared/errors'
import type { EmulatorDriver } from '../driver'
import {
  assertLdOk,
  assertLdTextOk,
  getLdCliPath,
  isLdUsageText,
  ldExec,
  setLdCliPath
} from './cli'
import { ldRawToInstance, parseLdList2 } from './parse'

/** list2 实测 15ms。 */
const LIST_TIMEOUT_MS = 15_000
/** launch / quit / reboot 只是下发命令，本身瞬间返回。 */
const LIFECYCLE_TIMEOUT_MS = 60_000
/** add / copy 要复制虚拟磁盘，给足时间。 */
const PROVISION_TIMEOUT_MS = 10 * 60_000
const MODIFY_TIMEOUT_MS = 30_000
const READY_POLL_INTERVAL_MS = 600
/** add / copy 之后等新实例出现在 list2 里的最长时间。 */
const PROVISION_SETTLE_MS = 15_000

/**
 * `ldconsole modify` 支持的键 -> 参数映射。面板「写入配置」与「新建实例」的 settings JSON 用这些键。
 * 用法文本里 --cpu 写的是 1|2|3|4、--memory 是固定档位，但雷电 14 的图形界面允许更大值
 * （本机实例就是 cpu=4 / memory=4096），这里只做基本校验，超出范围由雷电自己拒绝。
 */
export const LD_MODIFY_KEYS: Record<
  string,
  { flag: string; describe: string; format: (v: unknown) => string }
> = {
  resolution: {
    flag: '--resolution',
    describe: '"宽,高,DPI"（如 "2560,1440,360"）或 {"width":2560,"height":1440,"dpi":360}',
    format: formatResolution
  },
  cpu: { flag: '--cpu', describe: 'CPU 核数（整数）', format: (v) => formatInt(v, 'cpu', 1, 32) },
  memory: {
    flag: '--memory',
    describe: '内存 MB（整数，如 4096）',
    format: (v) => formatInt(v, 'memory', 256, 65536)
  },
  manufacturer: { flag: '--manufacturer', describe: '厂商字符串', format: formatString },
  model: { flag: '--model', describe: '机型字符串', format: formatString },
  pnumber: { flag: '--pnumber', describe: '手机号', format: formatString },
  imei: { flag: '--imei', describe: '"auto" 或 15 位数字', format: formatString },
  imsi: { flag: '--imsi', describe: '"auto" 或 15 位数字', format: formatString },
  simserial: { flag: '--simserial', describe: '"auto" 或 20 位数字', format: formatString },
  androidid: { flag: '--androidid', describe: '"auto" 或 16 位十六进制', format: formatString },
  mac: { flag: '--mac', describe: '"auto" 或 12 位十六进制', format: formatString },
  autorotate: { flag: '--autorotate', describe: 'true/false 或 1/0', format: formatBool },
  lockwindow: { flag: '--lockwindow', describe: 'true/false 或 1/0', format: formatBool },
  root: { flag: '--root', describe: 'true/false 或 1/0', format: formatBool }
}

export function createLdDriver(): EmulatorDriver {
  return {
    kind: 'ldplayer',
    label: '雷电模拟器',
    setCliPath: setLdCliPath,
    getCliPath: getLdCliPath,
    list: listInstances,
    open: openInstance,
    close: closeInstance,
    restart: restartInstance,
    create: createInstances,
    clone: cloneInstance,
    remove: deleteInstance,
    config: configInstance,
    waitReady: waitInstanceReady
  }
}

// ── 列表 ──────────────────────────────────────────────────────────────────

export async function listInstances(): Promise<MumuInstance[]> {
  const argv = ['list2']
  const r = await ldExec(argv, { timeoutMs: LIST_TIMEOUT_MS })
  assertLdOk(r, argv, '列出实例')
  if (isLdUsageText(r.stdout)) {
    throw new AppError('MUMU_BAD_OUTPUT', 'ldconsole list2 返回的是用法说明而不是实例列表', {
      stdout: r.stdout.slice(0, 500)
    })
  }
  const raws = parseLdList2(r.stdout)
  if (raws.length === 0 && r.stdout.trim().length > 0) {
    throw new AppError('MUMU_BAD_OUTPUT', 'ldconsole list2 的输出无法解析（列数与预期不符）', {
      stdout: r.stdout.slice(0, 500)
    })
  }
  return raws.map(ldRawToInstance).sort((a, b) => a.index - b.index)
}

async function requireInstance(index: number): Promise<MumuInstance> {
  assertIndex(index)
  const inst = (await listInstances()).find((i) => i.index === index)
  if (!inst) {
    throw new AppError('MUMU_INSTANCE_MISSING', `实例 ${index} 不存在，请刷新实例列表后重试。`, {
      index
    })
  }
  return inst
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

/**
 * 启动实例。`launch` 立刻返回，此时 pid 已有、android_started 还是 0；
 * 调用方要么接 waitReady()，要么靠轮询看状态，**别把返回当作可以截图**。
 */
async function openInstance(index: number): Promise<void> {
  const inst = await requireInstance(index)
  if (inst.state === 'running' || inst.state === 'starting') return
  const argv = ['launch', '--index', String(index)]
  const r = await ldExec(argv, { timeoutMs: LIFECYCLE_TIMEOUT_MS })
  assertLdOk(r, argv, `启动实例 ${index}`)
}

async function closeInstance(index: number): Promise<void> {
  const inst = await requireInstance(index)
  if (inst.state === 'stopped') return
  const argv = ['quit', '--index', String(index)]
  const r = await ldExec(argv, { timeoutMs: LIFECYCLE_TIMEOUT_MS })
  assertLdOk(r, argv, `关闭实例 ${index}`)
}

async function restartInstance(index: number): Promise<void> {
  const inst = await requireInstance(index)
  const argv =
    inst.state === 'stopped'
      ? ['launch', '--index', String(index)]
      : ['reboot', '--index', String(index)]
  const r = await ldExec(argv, { timeoutMs: LIFECYCLE_TIMEOUT_MS })
  assertLdOk(r, argv, `重启实例 ${index}`)
}

/**
 * 新建实例：`add` 一次建一个，建完用「列表差集」确认新 index，再按 settings 写配置。
 * ★ 真机实测（2026-09-14）：`add` 输出为空、退出码 = 新实例 index；新实例默认 **1280×720@280**，
 *   与本工程 2560×1440 的模板不匹配 —— 面板「新建实例」对雷电默认填 {"resolution":"2560,1440,360"}。
 */
async function createInstances(opts: CreateInstanceOptions = {}): Promise<number[]> {
  const count = opts.count ?? 1
  if (!Number.isInteger(count) || count < 1 || count > 16) {
    throw new AppError('INVALID_ARGUMENT', '要创建的实例数量必须是 1~16 的整数', { count })
  }
  const modifyArgs =
    opts.settings && Object.keys(opts.settings).length > 0 ? buildModifyArgs(opts.settings) : []

  const created: number[] = []
  for (let i = 0; i < count; i++) {
    const fresh = await runProvision(['add'], '创建')
    created.push(...fresh)
    if (modifyArgs.length > 0) {
      for (const idx of fresh) {
        const argv = ['modify', '--index', String(idx), ...modifyArgs]
        const r = await ldExec(argv, { timeoutMs: MODIFY_TIMEOUT_MS })
        assertLdOk(r, argv, `写入新实例 ${idx} 的配置`)
      }
    }
  }
  return created
}

/**
 * 克隆实例：`copy --from N`，新实例名是「<原名>-<新序号>」，配置（含分辨率）随源实例。
 * ★ 真机实测：源实例正在运行时雷电也照样复制（copy --from 1 建出「万龙1号-4」），
 *   但那是在复制一块正在写的磁盘，稳妥起见调用方最好先关掉源实例；这里不强制。
 */
async function cloneInstance(index: number): Promise<number[]> {
  await requireInstance(index)
  return runProvision(['copy', '--from', String(index)], '克隆')
}

/** 删除实例。**不可撤销**。正在运行的实例先拒绝，免得雷电把它半删不删。实测成功时退出码 0、无输出。 */
async function deleteInstance(index: number): Promise<void> {
  const inst = await requireInstance(index)
  if (inst.state !== 'stopped') {
    throw new AppError(
      'INVALID_ARGUMENT',
      `实例 ${index}「${inst.name}」正在运行，请先关闭再删除。`,
      {
        index,
        state: inst.state
      }
    )
  }
  const argv = ['remove', '--index', String(index)]
  const r = await ldExec(argv, { timeoutMs: PROVISION_TIMEOUT_MS })
  assertLdOk(r, argv, `删除实例 ${index}`)
}

/**
 * 写入实例配置。键见 LD_MODIFY_KEYS；不认识的键直接报错列出可用键，而不是像 MuMu 那样静默忽略——
 * 雷电对不存在的 index 都会静默成功，再放过错键就真的什么反馈都没有了。
 * 分辨率等配置要重启实例才生效。
 */
async function configInstance(index: number, settings: Record<string, unknown>): Promise<void> {
  await requireInstance(index)
  const args = buildModifyArgs(settings)
  const argv = ['modify', '--index', String(index), ...args]
  const r = await ldExec(argv, { timeoutMs: MODIFY_TIMEOUT_MS })
  assertLdOk(r, argv, `写入实例 ${index} 的配置`)
}

/** 等实例真正可用（android_started=1）。 */
async function waitInstanceReady(index: number, timeoutMs: number): Promise<MumuInstance> {
  assertIndex(index)
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let lastState = '未知'
  for (;;) {
    let inst: MumuInstance | undefined
    try {
      inst = (await listInstances()).find((i) => i.index === index)
    } catch (e) {
      if (Date.now() >= deadline) throw e
    }
    if (inst) {
      lastState = inst.state
      if (inst.screenReady) return inst
    }
    if (Date.now() >= deadline) {
      throw new AppError(
        'TIMEOUT',
        inst
          ? `等待实例 ${index} 就绪超时（${timeoutMs}ms），当前状态：${lastState}${
              inst.state === 'starting' ? '（进程已起，Android 尚未启动完成）' : ''
            }。可在雷电多开器里手动查看该实例。`
          : `等待实例 ${index} 就绪超时（${timeoutMs}ms），实例始终没有出现在列表里。`,
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
 * add / copy 的公共流程：记录创建前的 index 集合 -> 执行 -> 用列表差集确认新实例。
 * ★ 这两条命令的退出码是**新实例的 index**（实测 copy --from 0 退出 3、add 退出 4），绝不能当错误码；
 *   只按文本判错（assertLdTextOk），退出码只用来在差集里挑出「这次建的是哪个」。
 */
async function runProvision(argv: string[], verb: string): Promise<number[]> {
  const before = new Set((await listInstances()).map((i) => i.index))
  const r = await ldExec(argv, { timeoutMs: PROVISION_TIMEOUT_MS })
  assertLdTextOk(r, argv, `${verb}实例`)
  const hinted = typeof r.code === 'number' && r.code >= 0 && r.code < 1000 ? r.code : null

  const deadline = Date.now() + PROVISION_SETTLE_MS
  for (;;) {
    const fresh = (await listInstances())
      .map((i) => i.index)
      .filter((i) => !before.has(i))
      .sort((a, b) => a - b)
    if (fresh.length > 0) {
      // 退出码指的那个 index 若确实是新出现的，就精确返回它（并发点了两次时差集可能不止一个）。
      if (hinted !== null && fresh.includes(hinted)) return [hinted]
      return fresh
    }
    if (Date.now() >= deadline) break
    await sleep(500)
  }
  throw new AppError(
    'MUMU_BAD_OUTPUT',
    `${verb}实例的命令已执行，但 ${PROVISION_SETTLE_MS / 1000} 秒内没在列表里看到新实例。请到雷电多开器里手动确认。`,
    { argv, output: r.stdout.slice(0, 300), exitCode: r.code }
  )
}

function buildModifyArgs(settings: Record<string, unknown>): string[] {
  const keys = Object.keys(settings)
  if (keys.length === 0) {
    throw new AppError('INVALID_ARGUMENT', '没有要写入的配置项')
  }
  const unknown = keys.filter((k) => !(k in LD_MODIFY_KEYS))
  if (unknown.length > 0) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `雷电不支持这些配置键：${unknown.join('、')}。可用的键：${Object.keys(LD_MODIFY_KEYS).join('、')}`,
      { unknown }
    )
  }
  const args: string[] = []
  for (const k of keys) {
    const spec = LD_MODIFY_KEYS[k]!
    args.push(spec.flag, spec.format(settings[k]))
  }
  return args
}

function formatResolution(v: unknown): string {
  if (typeof v === 'string') {
    const m = /^\s*(\d+)\s*[,x×]\s*(\d+)\s*[,@]\s*(\d+)\s*$/i.exec(v)
    if (m) return `${m[1]},${m[2]},${m[3]}`
  } else if (v && typeof v === 'object') {
    const o = v as { width?: unknown; height?: unknown; dpi?: unknown }
    if (isPosInt(o.width) && isPosInt(o.height) && isPosInt(o.dpi)) {
      return `${o.width},${o.height},${o.dpi}`
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

function formatBool(v: unknown): string {
  if (v === true || v === 1 || v === '1' || v === 'true') return '1'
  if (v === false || v === 0 || v === '0' || v === 'false') return '0'
  throw new AppError(
    'INVALID_ARGUMENT',
    `开关值必须是 true/false 或 1/0，收到：${JSON.stringify(v)}`
  )
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
