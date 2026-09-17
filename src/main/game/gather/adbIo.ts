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
import { isRunning, launchViaMonkey } from '@main/adb/apps'
import { ensureGameForeground, type GamePresence } from '../launch'
import { GatherHalt, type GatherIo } from './session'

export interface AdbGatherIoOptions {
  serial: string
  /** 参考分辨率。默认取全局常量 2560x1440。 */
  refWidth?: number
  refHeight?: number
  /** 已知的设备分辨率。不传则从 adb 缓存 / 第一帧截图里学。 */
  deviceWidth?: number
  deviceHeight?: number
  signal?: AbortSignal
}

/** 基于 @main/adb 的 GatherIo 实现。 */
export class AdbGatherIo implements GatherIo {
  private readonly serial: string
  private readonly refWidth: number
  private readonly refHeight: number
  private size: { width: number; height: number } | null
  private readonly signal?: AbortSignal

  constructor(opts: AdbGatherIoOptions) {
    this.signal = opts.signal
    this.serial = opts.serial
    this.refWidth = opts.refWidth ?? REF_WIDTH
    this.refHeight = opts.refHeight ?? REF_HEIGHT
    this.size =
      opts.deviceWidth && opts.deviceHeight
        ? { width: opts.deviceWidth, height: opts.deviceHeight }
        : null
  }

  async capture(): Promise<RawFrame> {
    this.check()
    const raw = await captureRaw(this.serial)
    // 每帧都顺手校准一次设备分辨率 —— 这是唯一可信来源。
    this.size = { width: raw.width, height: raw.height }
    return raw
  }

  async tap(x: number, y: number): Promise<void> {
    const p = await this.toDevice(x, y)
    this.check()
    await adbTap(this.serial, p.x, p.y)
  }

  async tapMany(points: [number, number][], gapMs = 0): Promise<void> {
    const out: [number, number][] = []
    for (const [x, y] of points) {
      const p = await this.toDevice(x, y)
      out.push([p.x, p.y])
    }
    this.check()
    await adbTapMany(this.serial, out, gapMs)
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    const a = await this.toDevice(x1, y1)
    const b = await this.toDevice(x2, y2)
    this.check()
    await adbSwipe(this.serial, a.x, a.y, b.x, b.y, durationMs)
  }

  async key(k: AndroidKey): Promise<void> {
    this.check()
    await adbKey(this.serial, k)
  }

  async launchApp(packageName: string, cold = false): Promise<void> {
    this.check()
    await launch(this.serial, packageName, cold)
  }

  /**
   * 冷启动恢复：确认游戏在前台，不在就用 **monkey** 拉起并等到它到前台。
   * ★ 不能用上面的 launchApp（`am start`）：对《万龙觉醒》它返回成功但进程起不来，
   *   模拟器刚开机时老写法会白等一分钟然后判失败。
   */
  async ensureGameForeground(packageName: string): Promise<GamePresence> {
    return ensureGameForeground(
      {
        foreground: () => {
          this.check()
          return foregroundPackage(this.serial)
        },
        launch: () => {
          this.check()
          return launchViaMonkey(this.serial, packageName)
        },
        isRunning: () => {
          this.check()
          return isRunning(this.serial, packageName)
        }
      },
      { packageName }
    )
  }

  async stopApp(packageName: string): Promise<void> {
    this.check()
    await forceStop(this.serial, packageName)
  }

  async foregroundPackage(): Promise<string | null> {
    this.check()
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
    this.check()
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

  private check(): void {
    if (this.signal?.aborted) throw new GatherHalt('cancelled', '自动采集已被中止。')
  }
}

/** 便捷工厂。 */
export function createAdbGatherIo(opts: AdbGatherIoOptions): AdbGatherIo {
  return new AdbGatherIo(opts)
}
