/**
 * GatherIo 的真实实现：接到本工程的 adb 层上。
 *
 * 唯一的职责是**坐标换算**：流程层给的一律是参考分辨率（2560x1440）坐标，
 * 到了这里才按设备真实分辨率换算成像素再交给 `adb input`（铁律一）。
 *
 * 设备真实分辨率只信 screencap 头部，绝不用 `wm size`（它报的是物理竖屏 1440x2560）。
 */

import { REF_HEIGHT, REF_WIDTH } from '@shared/constants'
import type { AndroidKey } from '@shared/script'
import type { RawFrame } from '@shared/vision'
import {
  captureRaw,
  forceStop,
  foregroundPackage,
  getCached,
  key as adbKey,
  launch,
  swipe as adbSwipe,
  tap as adbTap,
  tapMany as adbTapMany
} from '@main/adb/index'
import type { GatherIo } from './session'

export interface AdbGatherIoOptions {
  serial: string
  /** 参考分辨率。默认取全局常量 2560x1440。 */
  refWidth?: number
  refHeight?: number
  /** 已知的设备分辨率。不传则从 adb 缓存 / 第一帧截图里学。 */
  deviceWidth?: number
  deviceHeight?: number
}

/** 基于 @main/adb 的 GatherIo 实现。 */
export class AdbGatherIo implements GatherIo {
  private readonly serial: string
  private readonly refWidth: number
  private readonly refHeight: number
  private size: { width: number; height: number } | null

  constructor(opts: AdbGatherIoOptions) {
    this.serial = opts.serial
    this.refWidth = opts.refWidth ?? REF_WIDTH
    this.refHeight = opts.refHeight ?? REF_HEIGHT
    this.size =
      opts.deviceWidth && opts.deviceHeight
        ? { width: opts.deviceWidth, height: opts.deviceHeight }
        : null
  }

  async capture(): Promise<RawFrame> {
    const raw = await captureRaw(this.serial)
    // 每帧都顺手校准一次设备分辨率 —— 这是唯一可信来源。
    this.size = { width: raw.width, height: raw.height }
    return raw
  }

  async tap(x: number, y: number): Promise<void> {
    const p = await this.toDevice(x, y)
    await adbTap(this.serial, p.x, p.y)
  }

  async tapMany(points: [number, number][], gapMs = 0): Promise<void> {
    const out: [number, number][] = []
    for (const [x, y] of points) {
      const p = await this.toDevice(x, y)
      out.push([p.x, p.y])
    }
    await adbTapMany(this.serial, out, gapMs)
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    const a = await this.toDevice(x1, y1)
    const b = await this.toDevice(x2, y2)
    await adbSwipe(this.serial, a.x, a.y, b.x, b.y, durationMs)
  }

  async key(k: AndroidKey): Promise<void> {
    await adbKey(this.serial, k)
  }

  async launchApp(packageName: string, cold = false): Promise<void> {
    await launch(this.serial, packageName, cold)
  }

  async stopApp(packageName: string): Promise<void> {
    await forceStop(this.serial, packageName)
  }

  async foregroundPackage(): Promise<string | null> {
    return foregroundPackage(this.serial)
  }

  /** 参考坐标 -> 设备像素。设备分辨率未知时先截一帧学一下（只会发生一次）。 */
  private async toDevice(x: number, y: number): Promise<{ x: number; y: number }> {
    const size = await this.ensureSize()
    return {
      x: Math.round((x * size.width) / this.refWidth),
      y: Math.round((y * size.height) / this.refHeight)
    }
  }

  private async ensureSize(): Promise<{ width: number; height: number }> {
    if (this.size) return this.size
    const cached = getCached(this.serial)
    if (cached && cached.screenWidth > 0 && cached.screenHeight > 0) {
      this.size = { width: cached.screenWidth, height: cached.screenHeight }
      return this.size
    }
    const raw = await captureRaw(this.serial)
    this.size = { width: raw.width, height: raw.height }
    return this.size
  }
}

/** 便捷工厂。 */
export function createAdbGatherIo(opts: AdbGatherIoOptions): AdbGatherIo {
  return new AdbGatherIo(opts)
}
