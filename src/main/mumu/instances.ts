/**
 * MuMu 实例的生命周期操作。
 *
 * 职责边界：本文件**只**通过 mumutool 管实例的「生老病死」（列出 / 开 / 关 / 重启 / 增 / 删 / 改配置）。
 * 一切与 Android 内部有关的事情 —— 装 apk、起应用、点屏幕、截图 —— 都不归这里，由 adb 层（模块 b）负责。
 *
 * ★ 两条不可违背的规则：
 *   1. **不要给 `mumutool control` 写任何封装。** Mac 版的 open_app / close_app / install_apk /
 *      uninstall_app / app_status / run_cmd / run_tool 实测**全部**返回 errcode 42000 invalidApi
 *      （`RemoteWebServerError.invalidApi("/app")`）。这是永久性失败，写 fallback 分支只会让
 *      调用方以为「重试一下也许就好了」。
 *   2. **adb_port 每次从 info 现读，绝不缓存推算。** 实例 0 的端口是 16384 而不是 5555，
 *      而且实例重启后端口可能变。任何「基准端口 + index * 步长」的推算都是错的。
 */

import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { INSTANCE_DISK_COST_BYTES, serialOf } from '@shared/constants'
import type { CreateInstanceOptions, MumuInstance, MumuInstanceRaw } from '@shared/domain'
import { AppError } from '@shared/errors'
import { mumuInfoReturnSchema, mumuInstanceRawSchema, parseOrThrow } from '@shared/schemas'
import { getMumuCliOptions, mumuExec, setMumuCliOptions } from './cli'
import type { EmulatorDriver } from './driver'

/**
 * 把本文件的函数包成 driver.ts 的 EmulatorDriver（MuMu / macOS 驱动）。
 * 函数本身原样保留，仍可单独 import（脚本与旧调用方不受影响）。
 */
export function createMumuDriver(): EmulatorDriver {
  return {
    kind: 'mumu',
    label: 'MuMu 模拟器',
    setCliPath: (p) => setMumuCliOptions({ mumutoolPath: p }),
    getCliPath: () => getMumuCliOptions().mumutoolPath,
    list: listMumuInstances,
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

// ── 各类命令的超时（实测标定，不要写死在 cli.ts 的默认值里）────────────────────

/** info：实测 25~35ms。 */
const INFO_TIMEOUT_MS = 15_000
/** open / close / restart：实测 open 一个已运行实例 1.5s；冷启动会久一些。 */
const LIFECYCLE_TIMEOUT_MS = 180_000
/** create / clone / delete：每个实例约 3.6GB 磁盘拷贝，必须给足时间。 */
const PROVISION_TIMEOUT_MS = 30 * 60_000
/** config 写入。 */
const CONFIG_TIMEOUT_MS = 30_000

/** waitInstanceReady 的轮询间隔。 */
const READY_POLL_INTERVAL_MS = 600
/** create / clone 之后等待实例出现在列表里的最长时间。 */
const PROVISION_SETTLE_MS = 8_000

// ── 列表与映射 ────────────────────────────────────────────────────────────

/** `mumutool info all` 的原样结果，已过 zod 校验。 */
export async function listRaw(): Promise<MumuInstanceRaw[]> {
  const ret = await mumuExec<unknown>(['info', 'all'], { timeoutMs: INFO_TIMEOUT_MS })
  const parsed = parseOrThrow(
    mumuInfoReturnSchema,
    ret,
    'mumutool info all 返回',
    'MUMU_BAD_OUTPUT'
  )
  return parsed.results
}

/** 面板用的驼峰视图列表，按 index 升序。（驱动无关的 listInstances 在 index.ts，按当前驱动分发。） */
export async function listMumuInstances(): Promise<MumuInstance[]> {
  const raw = await listRaw()
  return raw.map(toInstance).sort((a, b) => a.index - b.index)
}

/**
 * MumuInstanceRaw -> MumuInstance。
 *
 * `adb` / `accountId` / `runId` 三个字段本模块一律填初始值：
 * 真实的 adb 连接态由模块 b 通过 registry.patch() 回填，账号与运行 id 由模块 d 回填。
 * 这里若擅自猜一个值，会在每次轮询时把上层的真实状态冲掉。
 */
export function toInstance(raw: MumuInstanceRaw): MumuInstance {
  const adbPort = raw.adb_port ?? null
  return {
    index: raw.index,
    name: raw.name,
    state: raw.state,
    adbPort,
    pid: raw.pid ?? null,
    screenReady: isScreenReady(raw),
    bundlePath: raw.bundle_path ?? null,
    serial: adbPort === null ? null : serialOf(adbPort),
    adb: 'disconnected',
    accountId: null,
    runId: null,
    // mumutool 的配置读取端是坏的（errcode 42000），拿不到分辨率。
    resolution: null
  }
}

/**
 * 四重就绪判定的**前两重**（后两重 —— adb connect 成功、sys.boot_completed==1 ——
 * 由模块 b 的 adb 层补）。
 * 只有 running 是不够的：实例进程起来了但画面还没出来的窗口期里，
 * screencap 会返回全黑帧，模板匹配就会莫名其妙全部落空。
 */
export function isScreenReady(raw: MumuInstanceRaw): boolean {
  return raw.state === 'running' && raw.state_detail?.enableScreen === true
}

/** 取单个实例的原样信息；不存在时 mumutool 返回 errcode 42001，这里翻译成明确的中文错误。 */
export async function getRaw(index: number): Promise<MumuInstanceRaw> {
  assertIndex(index)
  try {
    const ret = await mumuExec<unknown>(['info', String(index)], { timeoutMs: INFO_TIMEOUT_MS })
    return parseSingleOrFirst(ret, `mumutool info ${index} 返回`)
  } catch (e) {
    throw translateMissing(e, index)
  }
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

/**
 * 启动实例。
 * ★ 实测 `open` 会**立刻**返回一个 state 已经是 running 的对象，但此时画面（enableScreen）
 *   往往还没就绪。所以调用方要么接着 await waitInstanceReady()，要么靠轮询看状态，
 *   **绝不能把 open 返回当作「可以开始截图了」**。
 */
export async function openInstance(index: number): Promise<void> {
  assertIndex(index)
  try {
    await mumuExec<unknown>(['open', String(index)], { timeoutMs: LIFECYCLE_TIMEOUT_MS })
  } catch (e) {
    throw translateMissing(e, index)
  }
}

export async function closeInstance(index: number): Promise<void> {
  assertIndex(index)
  try {
    await mumuExec<unknown>(['close', String(index)], { timeoutMs: LIFECYCLE_TIMEOUT_MS })
  } catch (e) {
    throw translateMissing(e, index)
  }
}

export async function restartInstance(index: number): Promise<void> {
  assertIndex(index)
  try {
    await mumuExec<unknown>(['restart', String(index)], { timeoutMs: LIFECYCLE_TIMEOUT_MS })
  } catch (e) {
    throw translateMissing(e, index)
  }
}

/**
 * 新建实例，返回新实例的 index 列表。
 *
 * ★ `--count` 实测要求 **>= 2**（`Count of Android Device to create (>=2)`），
 *   所以只建一个时必须**省略**该参数，不能传 `--count 1`。
 */
export async function createInstances(opts: CreateInstanceOptions = {}): Promise<number[]> {
  const count = opts.count ?? 1
  if (!Number.isInteger(count) || count < 1) {
    throw new AppError('INVALID_ARGUMENT', '要创建的实例数量必须是不小于 1 的整数', { count })
  }
  await assertDiskSpace(count)

  const args = ['create']
  // 只有 >=2 才允许带 --count；传 1 会被 CLI 判为非法参数（退出码 64）。
  if (count >= 2) args.push('--count', String(count))
  if (opts.type) args.push('--type', opts.type)
  if (opts.settings && Object.keys(opts.settings).length > 0) {
    args.push('-s', JSON.stringify(opts.settings))
  }

  return runProvision(args, count, '创建')
}

/** 克隆一个已有实例，返回新实例的 index 列表。 */
export async function cloneInstance(index: number): Promise<number[]> {
  assertIndex(index)
  await assertDiskSpace(1)
  try {
    return await runProvision(['clone', String(index)], 1, '克隆')
  } catch (e) {
    throw translateMissing(e, index)
  }
}

/**
 * 删除实例。**不可撤销**，调用方（面板 UI）必须先做二次确认。
 * 注意 `<device>` 支持 `all`，本函数只接受单个数字 index，避免误传字符串把所有实例删光。
 */
export async function deleteInstance(index: number): Promise<void> {
  assertIndex(index)
  try {
    await mumuExec<unknown>(['delete', String(index)], { timeoutMs: PROVISION_TIMEOUT_MS })
  } catch (e) {
    throw translateMissing(e, index)
  }
}

/**
 * 修改实例配置（分辨率、CPU、内存等）。
 *
 * ★ 只实现写入端。`mumutool config <n>` 的**读取端**实测返回
 *   errcode 42000 `invalidApi("/setting")`，Mac 版根本没实现，所以面板要展示当前配置
 *   只能自己记账，不要指望从 mumutool 读回来。
 *
 * 多数配置项（尤其是分辨率）需要实例重启才生效，调用方按需接 restartInstance。
 */
export async function configInstance(
  index: number,
  settings: Record<string, unknown>
): Promise<void> {
  assertIndex(index)
  if (!settings || Object.keys(settings).length === 0) {
    throw new AppError('INVALID_ARGUMENT', '没有要写入的配置项')
  }
  try {
    await mumuExec<unknown>(['config', String(index), '-s', JSON.stringify(settings)], {
      timeoutMs: CONFIG_TIMEOUT_MS
    })
  } catch (e) {
    throw translateMissing(e, index)
  }
}

/**
 * 等实例真正可用（state=running 且 enableScreen=true）。
 *
 * ★ 按「异步 + 轮询」实现，不依赖 open 的返回：实测 open 返回时 state 已经写成 running，
 *   但画面还没出来，直接拿它当就绪信号会截到全黑帧。
 */
export async function waitInstanceReady(index: number, timeoutMs: number): Promise<MumuInstance> {
  assertIndex(index)
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let lastState = '未知'

  for (;;) {
    let raw: MumuInstanceRaw | undefined
    try {
      raw = (await listRaw()).find((r) => r.index === index)
    } catch (e) {
      // 轮询期间的偶发失败（例如 MuMu 服务端正忙）不该直接判死；
      // 但接口级的永久失败（42000）没有重试价值，立即抛出。
      if (AppError.from(e).code === 'MUMU_API_UNSUPPORTED') throw e
      if (Date.now() >= deadline) throw e
    }

    if (raw) {
      lastState = raw.state
      if (isScreenReady(raw)) return toInstance(raw)
      if (raw.state === 'error') {
        throw new AppError(
          'MUMU_API_ERROR',
          `实例 ${index}「${raw.name}」启动失败（状态 error），请在 MuMu 模拟器里手动检查该实例。`,
          { index, state: raw.state }
        )
      }
    }

    if (Date.now() >= deadline) {
      throw new AppError(
        'TIMEOUT',
        raw
          ? `等待实例 ${index} 就绪超时（${timeoutMs}ms），当前状态：${lastState}${
              raw.state === 'running' ? '（进程已起，但画面尚未就绪）' : ''
            }。可尝试重启该实例。`
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
 * mumutool 对不存在的 index 返回 errcode 42001（invalidParams），
 * 原文是 `RemoteWebServerError.invalidParams(...)` 这种没法给用户看的东西。
 * 统一翻译成 MUMU_INSTANCE_MISSING + 中文说明。
 */
function translateMissing(e: unknown, index: number): unknown {
  const err = AppError.from(e)
  if (err.code === 'MUMU_API_ERROR' && err.detail?.['errcode'] === 42001) {
    return new AppError('MUMU_INSTANCE_MISSING', `实例 ${index} 不存在，请刷新实例列表后重试。`, {
      ...err.detail,
      index
    })
  }
  return e
}

/**
 * 不同子命令的 `return` 形状不一样（实测）：
 *   · info all       -> { count, results: [...] }
 *   · info <n> / open -> 单个实例对象
 * 这里两种都吃。
 */
function parseSingleOrFirst(ret: unknown, what: string): MumuInstanceRaw {
  const single = mumuInstanceRawSchema.safeParse(ret)
  if (single.success) return single.data
  const list = mumuInfoReturnSchema.safeParse(ret)
  if (list.success && list.data.results[0]) return list.data.results[0]
  throw new AppError('MUMU_BAD_OUTPUT', `${what} 的结构无法识别`, { issues: single.error.issues })
}

/** 从 create / clone 的返回里尽量捞出新实例的 index（形状未在本机验证过，所以只当参考）。 */
function extractIndices(ret: unknown): number[] {
  const out: number[] = []
  const push = (v: unknown): void => {
    const i = (v as { index?: unknown } | null)?.index
    if (typeof i === 'number' && Number.isInteger(i) && i >= 0) out.push(i)
  }
  if (Array.isArray(ret)) ret.forEach(push)
  else if (ret && typeof ret === 'object') {
    const results = (ret as { results?: unknown }).results
    if (Array.isArray(results)) results.forEach(push)
    else push(ret)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

/**
 * create / clone 的公共流程：记录创建前的 index 集合 -> 执行 -> 用「列表差集」确认新实例。
 *
 * 为什么以差集为准而不是信任返回值：create/clone 的返回结构本机没有真机验证过
 * （跑一次要吃 3.6GB 磁盘），而差集是无论返回什么形状都成立的事实来源。
 */
async function runProvision(args: string[], expect: number, verb: string): Promise<number[]> {
  const before = new Set((await listRaw()).map((r) => r.index))
  const ret = await mumuExec<unknown>(args, { timeoutMs: PROVISION_TIMEOUT_MS })

  const deadline = Date.now() + PROVISION_SETTLE_MS
  for (;;) {
    const after = (await listRaw()).map((r) => r.index)
    const fresh = after.filter((i) => !before.has(i)).sort((a, b) => a - b)
    if (fresh.length >= expect || (fresh.length > 0 && Date.now() >= deadline)) return fresh
    if (Date.now() >= deadline) break
    await sleep(500)
  }

  // 差集没捞到（列表刷新有延迟？），退回去看返回值里报了什么。
  const reported = extractIndices(ret).filter((i) => !before.has(i))
  if (reported.length > 0) return reported

  throw new AppError(
    'MUMU_BAD_OUTPUT',
    `${verb}实例的命令已执行，但没能确认新实例。请手动刷新实例列表查看结果。`,
    { argv: args, ret }
  )
}

/**
 * 创建前的磁盘余量检查。每个实例约 INSTANCE_DISK_COST_BYTES（3.6GB 起）。
 * 检查目标优先取现有实例的 bundle 所在卷，取不到就退回用户主目录。
 * 检查本身失败（例如 statfs 不支持该卷）时**不阻断创建**，只是放弃这层保护。
 */
async function assertDiskSpace(count: number): Promise<void> {
  const need = count * INSTANCE_DISK_COST_BYTES
  let free: number
  try {
    const target = await bundleVolume()
    const st = await statfs(target)
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

async function bundleVolume(): Promise<string> {
  try {
    const withBundle = (await listRaw()).find((r) => r.bundle_path)
    if (withBundle?.bundle_path) return dirname(withBundle.bundle_path)
  } catch {
    // 列不出来就用主目录兜底
  }
  return homedir()
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
