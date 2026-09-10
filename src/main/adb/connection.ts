/**
 * 连接管理与设备信息。
 *
 * ★ serial 永远是 `127.0.0.1:<adb_port>`（serialOf 生成）。
 *   adb 自动发现的 `emulator-5554` 当作**不存在**：它和前者是同一台机器的两个 transport
 *   （实测 boot_id 相同），disconnect 也清不掉（3 秒内自动扫回），别浪费时间去清。
 *   代价是：不带 -s 的命令必然报 `more than one device` —— 所以本模块强制带 -s。
 *
 * ★ 端口来自 `mumutool info`（模块 a）动态返回，**绝不能推算**（实例 0 = 16384 只是巧合）。
 *
 * 纯 Node，不 import electron。
 */

import { ADB_TIMEOUT_MS, serialOf } from '@shared/constants'
import type { AdbLinkState, DeviceInfo } from '@shared/domain'
import { AppError } from '@shared/errors'
import { foregroundPackage } from './apps'
import { captureRaw } from './capture'
import { adb, decodeText, delay, run, shellRaw } from './exec'
import { dropDevice, enqueue } from './queue'

// ── 连接状态表 ────────────────────────────────────────────────────────────

const links = new Map<string, AdbLinkState>()

export function linkState(serial: string): AdbLinkState {
  return links.get(serial) ?? 'disconnected'
}

/** 由 index.ts / 模块 e 在感知到设备变化时同步状态用。 */
export function setLinkState(serial: string, state: AdbLinkState): void {
  links.set(serial, state)
}

/** 当前所有已知设备的连接状态快照。 */
export function linkStates(): Record<string, AdbLinkState> {
  return Object.fromEntries(links)
}

// ── 连接 / 断开 ───────────────────────────────────────────────────────────

/** `adb -s x get-state` -> 我们的状态枚举。 */
async function transportState(serial: string): Promise<AdbLinkState> {
  const res = await adb(serial, ['get-state'], ADB_TIMEOUT_MS)
  const text = `${decodeText(res.stdout)} ${res.stderr}`.trim().toLowerCase()
  if (/^device\b/.test(text)) return 'connected'
  if (/unauthorized/.test(text)) return 'unauthorized'
  if (/offline|still connecting/.test(text)) return 'connecting'
  if (/not found|no devices/.test(text)) return 'disconnected'
  return 'error'
}

/**
 * 连接某个实例的 adb 端口，返回规范 serial。
 *
 * 幂等：`connected to` 与 `already connected to` 都算成功。
 * ★ 失败时 adb 的退出码**仍然是 0**，只在文本里写 `failed to connect to ...`，
 *   所以判定只能匹配 `/connected to/`。
 */
export async function connect(adbPort: number): Promise<string> {
  if (!Number.isInteger(adbPort) || adbPort <= 0 || adbPort > 65535) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `非法的 adb 端口：${adbPort}。端口应来自 mumutool info 的 adb_port 字段。`,
      { adbPort }
    )
  }
  const serial = serialOf(adbPort)
  setLinkState(serial, 'connecting')

  try {
    const state = await enqueue(serial, () => doConnect(serial))
    setLinkState(serial, state)

    if (state === 'unauthorized') {
      throw new AppError(
        'ADB_CONNECT_FAILED',
        `设备 ${serial} 未授权 adb 调试。请在模拟器里确认授权弹窗。`,
        { serial }
      )
    }
    if (state !== 'connected') {
      throw new AppError(
        'ADB_CONNECT_FAILED',
        `连接 ${serial} 后设备仍不可用（状态：${state}）。实例可能未启动完成，请稍后重试。`,
        { serial, state }
      )
    }
    return serial
  } catch (e) {
    setLinkState(serial, 'error')
    throw AppError.from(e, 'ADB_CONNECT_FAILED')
  }
}

async function doConnect(serial: string): Promise<AdbLinkState> {
  const res = await run(['connect', serial], ADB_TIMEOUT_MS)
  const text = `${decodeText(res.stdout)}\n${res.stderr}`.trim()

  if (!/connected to/i.test(text)) {
    throw new AppError(
      'ADB_CONNECT_FAILED',
      `连接模拟器失败（${serial}）：${text || '无输出'}。实例可能未启动完成，请稍后重试。`,
      { serial, output: text }
    )
  }

  let state = await transportState(serial)
  if (state === 'connecting' || state === 'disconnected') {
    // transport 刚建立时偶尔是 offline，断开重连一次通常就好。
    await run(['disconnect', serial], ADB_TIMEOUT_MS)
    await delay(400)
    await run(['connect', serial], ADB_TIMEOUT_MS)
    await delay(400)
    state = await transportState(serial)
  }
  return state
}

/**
 * 断开设备。先清空该设备的操作队列（还在排队的任务立刻以 CANCELLED 失败），
 * 再执行 adb disconnect。
 *
 * 「设备本来就没连」时 adb 会以非 0 退出并打印 `no such device` —— 那不是错误，忽略；
 * 但 adb 可执行文件本身找不到（ADB_NOT_FOUND）必须往外抛，否则用户永远发现不了路径配错了。
 */
export async function disconnect(serial: string): Promise<void> {
  dropDevice(serial)
  try {
    await run(['disconnect', serial], ADB_TIMEOUT_MS)
  } catch (e) {
    const err = AppError.from(e)
    if (err.code === 'ADB_NOT_FOUND') throw err
    // 其余（超时 / 本来就没连）不影响「已断开」这个结果。
  }
  setLinkState(serial, 'disconnected')
}

// ── 就绪探测 ──────────────────────────────────────────────────────────────

/** sys.boot_completed === '1'。设备离线时返回 false 而不是抛错（这是个探针）。 */
export async function isBooted(serial: string): Promise<boolean> {
  const r = await enqueue(serial, () => shellRaw(serial, 'getprop sys.boot_completed'))
  return r.code === 0 && r.text.trim() === '1'
}

/** 轮询等待开机完成。 */
export async function waitUntilBooted(serial: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await isBooted(serial)) return
    if (Date.now() >= deadline) {
      throw new AppError(
        'DEVICE_NOT_READY',
        `等待 ${serial} 开机完成超时（${Math.round(timeoutMs / 1000)} 秒）。`,
        { serial, timeoutMs }
      )
    }
    await delay(1500)
  }
}

// ── 设备信息 ──────────────────────────────────────────────────────────────

const PROP_KEYS = [
  'ro.product.model',
  'ro.build.version.release',
  'ro.build.version.sdk',
  'ro.product.cpu.abi',
  'ro.sf.lcd_density',
  'sys.boot_completed'
] as const

/**
 * 采集设备信息。
 *
 * ★ screenWidth / screenHeight **只能来自一次 screencap 的头部**。
 *   实测 `wm size` 报 1440x2560（物理竖屏），而实际画面是 2560x1440（ROTATION_90），
 *   照用会让所有模板匹配整体错位 —— 这是本项目踩过最贵的坑之一。
 *   代价是每次 attach 要花 ~300ms 抓一帧，可以接受（只在连接时做一次）。
 *
 * 其余属性用一次合并的 shell 批量取（6 个 getprop + wm density 一趟往返）。
 */
export async function getDeviceInfo(
  serial: string,
  instanceIndex: number | null
): Promise<DeviceInfo> {
  return enqueue(serial, async () => {
    // 用 `key=$(getprop key)` 的形式，属性为空时也能保住行对应关系。
    const cmd =
      PROP_KEYS.map((k) => `echo "${k}=$(getprop ${k})"`).join('; ') +
      '; echo "wm.density=$(wm density 2>/dev/null)"'

    const r = await shellRaw(serial, cmd)
    if (r.code !== 0) {
      throw new AppError(
        'ADB_DEVICE_OFFLINE',
        `读取设备属性失败（${serial}）：${(r.stderr || r.text).trim() || '无输出'}`,
        { serial, code: r.code }
      )
    }

    const props = new Map<string, string>()
    for (const line of r.text.split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) props.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
    }

    // ★ 分辨率的唯一可信来源。
    const frame = await captureRaw(serial, { throttle: false })

    let foreground: string | null = null
    try {
      foreground = await foregroundPackage(serial)
    } catch {
      // 取前台包名是锦上添花，失败不该让整个 attach 挂掉。
      foreground = null
    }

    const info: DeviceInfo = {
      serial,
      instanceIndex,
      model: props.get('ro.product.model') || '未知机型',
      androidVersion: props.get('ro.build.version.release') || '未知',
      sdkInt: toInt(props.get('ro.build.version.sdk'), 0),
      abi: props.get('ro.product.cpu.abi') || '未知',
      screenWidth: frame.width,
      screenHeight: frame.height,
      density: resolveDensity(props),
      booted: props.get('sys.boot_completed') === '1',
      foregroundPackage: foreground
    }
    setLinkState(serial, 'connected')
    return info
  })
}

function toInt(v: string | undefined, fallback: number): number {
  const n = Number.parseInt((v ?? '').trim(), 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 优先 ro.sf.lcd_density；MuMu 上它可能是空的，退回 `wm density` 的输出。
 * `wm density` 形如 `Physical density: 360`，被设过覆盖值时还会多一段
 * `Override density: 480` —— 取最后一个数字正好命中生效值。
 */
function resolveDensity(props: Map<string, string>): number {
  const direct = toInt(props.get('ro.sf.lcd_density'), 0)
  if (direct > 0) return direct
  const nums = (props.get('wm.density') ?? '').match(/\d+/g)
  return nums && nums.length > 0 ? toInt(nums[nums.length - 1], 0) : 0
}
