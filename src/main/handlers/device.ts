/**
 * 设备通道 —— 转发给模块 b（adb 封装）。
 *
 * ★ 本文件是**全工程唯一做坐标换算的地方**（铁律一）。
 *   面板传进来的 ManualInput.at / to 一律是参考分辨率坐标（2560x1440 空间），
 *   在这里用 refToDevice() 换算成设备真实像素后才交给 adb。
 *   设备真实分辨率只信 screencap 头部（铁律二），由模块 b 的 DeviceInfo 提供。
 *
 * ★ 截图编码（RGBA -> JPEG）在主进程做是允许的：sharp 走 libvips 的异步线程池，
 *   不阻塞事件循环，而且这是**一次性**调用，不是循环。脚本运行期的连续截图在
 *   utilityProcess 里，永远不会经过这里。
 */

import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import {
  ADB_KEYBOARD_APK_REL,
  PREVIEW_JPEG_QUALITY,
  PREVIEW_WIDTH,
  refToDevice,
  serialOf
} from '@shared/constants'
import { AppError } from '@shared/errors'
import { CH } from '@shared/ipc'
import type { CaptureOptions, CaptureShot } from '@shared/ipc'
import type { DeviceInfo, MumuInstance } from '@shared/domain'
import type { Point, RawFrame } from '@shared/vision'
import { handle } from '@main/ipc'
import type { MainDeps } from './index'

// 主进程只做零星的一次性转码，把 libvips 的线程池压到 1，
// 把核留给真正干活的 utilityProcess（它们各自也会 sharp.concurrency(1)）。
sharp.concurrency(1)
sharp.cache(false)

export function registerDeviceHandlers(deps: MainDeps): void {
  handle(CH.deviceAttach, (index) => ensureDevice(deps, index, { force: true }))

  handle(CH.deviceDetach, async (index) => {
    await deps.adb.detach(index)
    deps.mumu.patch(index, { adb: 'disconnected' })
  })

  handle(CH.deviceInfo, async (index) => {
    // 主动查询就给最新的：分辨率会随实例配置变化，缓存值可能已经过期。
    const dev = await ensureDevice(deps, index)
    return deps.adb.refreshInfo(dev.serial)
  })

  handle(CH.deviceCapture, async (index, opts) => {
    const dev = await ensureDevice(deps, index)
    const t0 = Date.now()
    const frame = await deps.adb.capture(dev.serial)
    return rawFrameToShot(frame, opts, Date.now() - t0)
  })

  handle(CH.deviceTap, async (input) => {
    const dev = await ensureDevice(deps, input.instanceIndex)
    const p = toDevicePoint(dev, requirePoint(input.at, 'at'))
    await deps.adb.tap(dev.serial, p.x, p.y)
  })

  handle(CH.deviceSwipe, async (input) => {
    const dev = await ensureDevice(deps, input.instanceIndex)
    const a = toDevicePoint(dev, requirePoint(input.at, 'at'))
    const b = toDevicePoint(dev, requirePoint(input.to, 'to'))
    await deps.adb.swipe(dev.serial, a.x, a.y, b.x, b.y, input.durationMs ?? 300)
  })

  handle(CH.deviceText, async (input) => {
    const dev = await ensureDevice(deps, input.instanceIndex)
    if (typeof input.text !== 'string' || input.text.length === 0) {
      throw new AppError('INVALID_ARGUMENT', '要输入的文本为空。')
    }
    // 中文靠 ADBKeyboard 的 base64 广播，模块 b 内部会判断走哪条路，这里不做编码判断。
    await deps.adb.text(dev.serial, input.text)
  })

  handle(CH.deviceKey, async (input) => {
    const dev = await ensureDevice(deps, input.instanceIndex)
    if (!input.key) throw new AppError('INVALID_ARGUMENT', '未指定要按下的按键。')
    await deps.adb.key(dev.serial, input.key)
  })

  handle(CH.deviceApps, async (index) => {
    const dev = await ensureDevice(deps, index)
    return deps.adb.apps(dev.serial)
  })

  handle(CH.deviceForeground, async (index) => {
    const dev = await ensureDevice(deps, index)
    return deps.adb.foreground(dev.serial)
  })

  handle(CH.deviceLaunchApp, async (index, packageName, cold) => {
    const dev = await ensureDevice(deps, index)
    await deps.adb.launchApp(dev.serial, packageName, cold ?? false)
  })

  handle(CH.deviceStopApp, async (index, packageName) => {
    const dev = await ensureDevice(deps, index)
    await deps.adb.stopApp(dev.serial, packageName)
  })

  handle(CH.deviceInstallApk, async (index, apkPath) => {
    const dev = await ensureDevice(deps, index)
    await requireFile(apkPath, `安装包不存在：${apkPath}`)
    await deps.adb.installApk(dev.serial, apkPath)
  })

  handle(CH.deviceSetupIme, async (index) => {
    const dev = await ensureDevice(deps, index)
    const apk = join(deps.paths().resourcesDir, ADB_KEYBOARD_APK_REL)
    await requireFile(
      apk,
      `缺少中文输入法安装包：${apk}\n` +
        '请把 ADBKeyboard.apk 放到工程的 resources/apk/ 目录下再重试。\n' +
        '（Android 自带的 `input text` 会静默丢弃中文，必须靠这个输入法转发。）'
    )
    return deps.adb.setupIme(dev.serial, apk)
  })
}

// ── 供其它 handler 复用 ───────────────────────────────────────────────────

/**
 * 拿到一台**已连接且信息可用**的设备，必要时自动 attach。
 * DeviceInfo 里带着 serial 与画面真实宽高，坐标换算和后续 adb 调用都从它取。
 *
 * 失败信息一律写成「用户看得懂、知道下一步做什么」的中文。
 */
export async function ensureDevice(
  deps: MainDeps,
  index: number,
  opts: { force?: boolean } = {}
): Promise<DeviceInfo> {
  const inst = await requireInstance(deps, index)
  if (inst.adbPort == null) {
    throw new AppError(
      'ADB_DEVICE_OFFLINE',
      `实例 ${index}（${inst.name}）当前状态是「${inst.state}」，还没有 adb 端口。\n` +
        '请先在「实例」页启动它，等状态变成运行中再操作。',
      { index, state: inst.state }
    )
  }

  // ★ 铁律三：serial 永远由现读的 adb_port 拼出来，绝不推算、绝不缓存跨重启。
  const expected = serialOf(inst.adbPort)
  if (!opts.force) {
    const cached = deps.adb.cached(index)
    // 实例重启后端口会变，缓存里的 serial 就作废了 —— 必须比对，否则命令全打在死端口上。
    if (cached && cached.serial === expected && inst.adb === 'connected') return cached
  }

  const info = await deps.adb.attach(index, inst.adbPort)
  deps.mumu.patch(index, { adb: 'connected' })
  return info
}

/** 参考分辨率坐标 -> 设备真实像素。全工程只有这一个换算入口。 */
export function toDevicePoint(dev: DeviceInfo, at: Point): Point {
  if (!(dev.screenWidth > 0 && dev.screenHeight > 0)) {
    throw new AppError(
      'CAPTURE_BAD_FRAME',
      `无法确定设备 ${dev.serial} 的画面分辨率，坐标换算不能继续。请断开后重新连接该实例。`,
      { serial: dev.serial }
    )
  }
  return refToDevice(at.x, at.y, dev.screenWidth, dev.screenHeight)
}

/**
 * RawFrame(RGBA8888) -> CaptureShot(JPEG)。
 * jpeg 用 ArrayBuffer 回传（结构化克隆直接搬字节），**绝不 base64**。
 */
export async function rawFrameToShot(
  frame: RawFrame,
  opts: CaptureOptions | undefined,
  elapsedMs: number
): Promise<CaptureShot> {
  const expected = frame.width * frame.height * 4
  if (frame.data.byteLength !== expected) {
    throw new AppError(
      'CAPTURE_BAD_FRAME',
      `截图数据长度异常：期望 ${expected} 字节（${frame.width}x${frame.height} RGBA），实际 ${frame.data.byteLength} 字节。`,
      { width: frame.width, height: frame.height, length: frame.data.byteLength }
    )
  }

  const quality = clampInt(opts?.quality ?? PREVIEW_JPEG_QUALITY, 1, 100)
  // width 传 0 表示要原始分辨率（模板截取工具需要，但一张就是 MB 级，面板别乱用）。
  const targetWidth =
    opts?.width === 0 ? frame.width : clampInt(opts?.width ?? PREVIEW_WIDTH, 16, frame.width)

  // 零拷贝地把 Uint8Array 包成 Buffer 交给 sharp，避免多复制一份 14MB。
  const input = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)
  const pipeline = sharp(input, {
    raw: { width: frame.width, height: frame.height, channels: 4 }
  })
  if (targetWidth !== frame.width) pipeline.resize({ width: targetWidth, fit: 'inside' })

  const { data, info } = await pipeline.jpeg({ quality }).toBuffer({ resolveWithObject: true })

  return {
    width: frame.width,
    height: frame.height,
    jpeg: toArrayBuffer(data),
    jpegWidth: info.width,
    jpegHeight: info.height,
    capturedAt: frame.capturedAt,
    elapsedMs
  }
}

/** Buffer/Uint8Array -> 独立 ArrayBuffer（复制自己那一段，别把整个内存池带过桥）。 */
export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength)
  new Uint8Array(ab).set(u8)
  return ab
}

// ── 内部 ─────────────────────────────────────────────────────────────────

async function requireInstance(deps: MainDeps, index: number): Promise<MumuInstance> {
  let inst = deps.mumu.get(index)
  if (!inst) {
    // 缓存里没有可能只是还没轮询到（面板刚启动），强拉一次再说。
    await deps.mumu.refresh()
    inst = deps.mumu.get(index)
  }
  if (!inst) {
    throw new AppError(
      'MUMU_INSTANCE_MISSING',
      `找不到编号为 ${index} 的模拟器实例。请在「实例」页点刷新，确认它还存在。`,
      { index }
    )
  }
  return inst
}

function requirePoint(p: Point | undefined, field: string): Point {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new AppError('INVALID_ARGUMENT', `缺少坐标参数 ${field}（应为参考分辨率下的 x/y）。`)
  }
  return p
}

async function requireFile(path: string, message: string): Promise<void> {
  try {
    await access(path, constants.R_OK)
  } catch {
    throw new AppError('NOT_FOUND', message, { path })
  }
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)))
}
