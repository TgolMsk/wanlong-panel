/**
 * adb 模块统一出口 + 「实例 index ⇄ serial ⇄ DeviceInfo」的运行时注册表。
 *
 * 模块 e 的 IPC handler 收到的都是实例 index（见 shared/ipc.ts 的 device:* 路由），
 * 而 adb 层只认 serial，中间这层映射就落在这里。
 *
 * 注册表是**内存态**：面板重启后要重新 attach。这是有意的 ——
 * adb 端口每次开实例都可能变（由 mumutool info 动态返回），缓存到磁盘只会读到过期值。
 *
 * 本文件同样不 import electron，所以 utilityProcess（模块 d）可以直接用整套能力。
 */

import type { DeviceInfo } from '@shared/domain'
import { AppError } from '@shared/errors'
import { clearAppCache } from './apps'
import { forgetCapture, setMinCaptureInterval } from './capture'
import { disconnect as rawDisconnect, connect, getDeviceInfo, setLinkState } from './connection'
import { getAdbPath, setAdbPath, startServer } from './exec'
import { clearImeCache } from './input'
import { dropDevice, setGlobalConcurrency } from './queue'

export * from './apps'
export * from './capture'
export * from './connection'
export * from './exec'
export * from './input'
export * from './queue'

// ── 注册表 ────────────────────────────────────────────────────────────────

const infoBySerial = new Map<string, DeviceInfo>()
const serialByIndex = new Map<number, string>()

/** 初始化 adb 层：路径、并发、截图节流，并确保 adb server 在跑。面板启动时调一次。 */
export async function initAdb(opts: {
  adbPath?: string
  globalConcurrency?: number
  minCaptureIntervalMs?: number
}): Promise<void> {
  if (opts.adbPath) setAdbPath(opts.adbPath)
  if (opts.globalConcurrency !== undefined) setGlobalConcurrency(opts.globalConcurrency)
  if (opts.minCaptureIntervalMs !== undefined) setMinCaptureInterval(opts.minCaptureIntervalMs)
  await startServer()
}

/**
 * 连接实例并采集设备信息，登记进注册表。
 * @param index    MuMu 实例 index
 * @param adbPort  来自 `mumutool info` 的 adb_port，**不要自己推算**
 */
export async function attach(index: number, adbPort: number): Promise<DeviceInfo> {
  const serial = await connect(adbPort)

  // 同一个 index 换了端口（实例重启过）时，先把旧 serial 清干净。
  const previous = serialByIndex.get(index)
  if (previous && previous !== serial) {
    await detach(previous)
  }

  const info = await getDeviceInfo(serial, index)
  serialByIndex.set(index, serial)
  infoBySerial.set(serial, info)
  return info
}

/** 断开设备并清空它的所有缓存（队列 / 截图节流 / 输入法 / 启动入口）。 */
export async function detach(serial: string): Promise<void> {
  for (const [index, s] of [...serialByIndex.entries()]) {
    if (s === serial) serialByIndex.delete(index)
  }
  infoBySerial.delete(serial)
  forgetCapture(serial)
  clearImeCache(serial)
  clearAppCache(serial)
  await rawDisconnect(serial)
}

/** 按实例 index 断开；没连过则静默返回。 */
export async function detachByIndex(index: number): Promise<void> {
  const serial = serialByIndex.get(index)
  if (!serial) return
  await detach(serial)
}

/** 断开全部（面板退出 / 切换 adb 路径时调）。 */
export async function detachAll(): Promise<void> {
  for (const serial of [...infoBySerial.keys()]) {
    await detach(serial)
  }
}

// ── 查询 ──────────────────────────────────────────────────────────────────

export function getCached(serial: string): DeviceInfo | null {
  return infoBySerial.get(serial) ?? null
}

export function getCachedByIndex(index: number): DeviceInfo | null {
  const serial = serialByIndex.get(index)
  return serial ? (infoBySerial.get(serial) ?? null) : null
}

export function serialForIndex(index: number): string | null {
  return serialByIndex.get(index) ?? null
}

export function listAttached(): DeviceInfo[] {
  return [...infoBySerial.values()].sort(
    (a, b) => (a.instanceIndex ?? 1e9) - (b.instanceIndex ?? 1e9)
  )
}

/** 取 serial，没连接就抛一个带中文说明的错误 —— IPC handler 直接用它开头即可。 */
export function requireSerial(index: number): string {
  const serial = serialByIndex.get(index)
  if (!serial) {
    throw new AppError(
      'DEVICE_NOT_READY',
      `实例 ${index} 尚未连接 adb。请先在面板里启动该实例并点击「连接」。`,
      { instanceIndex: index }
    )
  }
  return serial
}

/** 取已缓存的设备信息（含分辨率，坐标换算要用），没有就抛错。 */
export function requireDevice(index: number): DeviceInfo {
  const serial = requireSerial(index)
  const info = infoBySerial.get(serial)
  if (!info) {
    throw new AppError('DEVICE_NOT_READY', `实例 ${index} 的设备信息尚未采集，请重新连接。`, {
      instanceIndex: index,
      serial
    })
  }
  return info
}

/** 重新采集一次设备信息（分辨率会随实例设置变化，改完设置要刷新）。 */
export async function refreshDeviceInfo(serial: string): Promise<DeviceInfo> {
  const previous = infoBySerial.get(serial)
  const info = await getDeviceInfo(serial, previous?.instanceIndex ?? null)
  infoBySerial.set(serial, info)
  if (info.instanceIndex !== null) serialByIndex.set(info.instanceIndex, serial)
  return info
}

/**
 * 把某台设备标记为掉线：清注册表和队列，但不发 adb disconnect
 * （用于「mumutool 说实例已经关了」这种外部感知到的情况）。
 */
export function markOffline(serial: string): void {
  dropDevice(serial)
  forgetCapture(serial)
  clearImeCache(serial)
  clearAppCache(serial)
  infoBySerial.delete(serial)
  for (const [index, s] of [...serialByIndex.entries()]) {
    if (s === serial) serialByIndex.delete(index)
  }
  setLinkState(serial, 'disconnected')
}

/** 当前生效的 adb 路径，健康自检页要显示。 */
export function currentAdbPath(): string {
  return getAdbPath()
}
