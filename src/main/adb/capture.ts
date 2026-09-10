/**
 * 截图管线：`adb exec-out screencap`（裸 RGBA），**绝不加 -p**。
 *
 * 实测对比（2560x1440，MuMu / Android 12）：
 *   raw screencap ......... 280~300ms   ← 用这个
 *   screencap -p (PNG) .... ~1100ms     ← 慢 4 倍，禁用
 *   设备端 gzip ........... 302ms       ← 游戏画面熵高，压不动，比不压还慢
 *
 * 帧格式：header + 像素。header 里三个小端 uint32：width / height / format。
 *   · header 长度 Android 10+ 是 16 字节（多一个 colorSpace），Android 9- 是 12 字节。
 *     **必须用「总长度 - w*h*4」反推**，别写死 16。
 *   · format 必须是 1（RGBA_8888），字节序实测就是 R,G,B,A，
 *     可以直接喂 OpenCV 的 CV_8UC4，**不需要 BGRA 交换**。
 *   · stride 用 (len-header)/h/4 算出来再和 w 比对：本机实测 padding=0，但别假设。
 *
 * 纯 Node，不 import electron。
 */

import {
  CAPTURE_TIMEOUT_MS,
  MIN_CAPTURE_INTERVAL_MS,
  PIXEL_FORMAT_RGBA_8888,
  SCREENCAP_HEADER_LENS
} from '@shared/constants'
import { AppError } from '@shared/errors'
import type { RawFrame } from '@shared/vision'
import { delay, execOut } from './exec'
import { enqueue } from './queue'

// ── 截图节流 ──────────────────────────────────────────────────────────────
// 模拟器 screencap 吞吐硬上限 ≈4.3 帧/秒，抓得更快只会排队变慢。
// 节流在设备车道内部等待，所以等待期间该设备的其它操作也不会插队 —— 这是有意的。

let minIntervalMs: number = MIN_CAPTURE_INTERVAL_MS
const lastCaptureAt = new Map<string, number>()

export function setMinCaptureInterval(ms: number): void {
  minIntervalMs = Math.max(0, Math.floor(ms))
}

/** 等到距上次截图满足最小间隔。tapAndCapture 之类的自定义管线也要调它。 */
export async function waitCaptureSlot(serial: string): Promise<void> {
  const last = lastCaptureAt.get(serial)
  if (last === undefined) return
  const wait = minIntervalMs - (Date.now() - last)
  if (wait > 0) await delay(wait)
}

/** 记一次截图时间戳。自己拼 exec-out 管线（tapAndCapture）时必须调。 */
export function markCaptured(serial: string): void {
  lastCaptureAt.set(serial, Date.now())
}

/** 设备断开时清掉节流记录。 */
export function forgetCapture(serial: string): void {
  lastCaptureAt.delete(serial)
}

export interface CaptureOpts {
  /** 默认 true。只有明确知道自己在做什么（例如 attach 时取一次分辨率）才关掉。 */
  throttle?: boolean
  timeoutMs?: number
}

/** 抓一帧裸 RGBA。 */
export async function captureRaw(serial: string, opts: CaptureOpts = {}): Promise<RawFrame> {
  const { throttle = true, timeoutMs = CAPTURE_TIMEOUT_MS } = opts
  return enqueue(serial, async () => {
    if (throttle) await waitCaptureSlot(serial)
    const buf = await execOut(serial, 'screencap', timeoutMs)
    markCaptured(serial)
    if (buf.byteLength === 0) {
      throw new AppError(
        'CAPTURE_BAD_FRAME',
        `截图返回了 0 字节（${serial}）。设备可能已离线，或屏幕尚未就绪。`,
        { serial }
      )
    }
    return parseScreencap(buf)
  })
}

/**
 * 解析 screencap 裸输出。纯函数，可单测。
 * 解析失败一律抛 CAPTURE_BAD_FRAME —— 绝不返回半成品帧，否则模板匹配会在垃圾数据上乱点。
 */
export function parseScreencap(buf: Uint8Array): RawFrame {
  const len = buf.byteLength
  const minHeader = Math.min(...SCREENCAP_HEADER_LENS)
  if (len < minHeader) {
    throw new AppError(
      'CAPTURE_BAD_FRAME',
      `截图数据过短（${len} 字节，至少要 ${minHeader} 字节头部），设备可能已离线。`,
      { len }
    )
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const width = view.getUint32(0, true)
  const height = view.getUint32(4, true)
  const format = view.getUint32(8, true)

  if (width <= 0 || height <= 0 || width > 20000 || height > 20000) {
    throw new AppError(
      'CAPTURE_BAD_FRAME',
      `截图头部声明了不合理的尺寸 ${width}x${height}（数据 ${len} 字节）。`,
      { width, height, len }
    )
  }

  // ★ 头长靠总长度反推，不写死。先找无行填充的精确匹配，再找有填充的。
  let headerLen = -1
  let stride = width
  for (const hl of SCREENCAP_HEADER_LENS) {
    if (len - hl === width * height * 4) {
      headerLen = hl
      stride = width
      break
    }
  }
  if (headerLen < 0) {
    for (const hl of SCREENCAP_HEADER_LENS) {
      const body = len - hl
      if (body <= 0) continue
      const rowBytes = height * 4
      if (body % rowBytes !== 0) continue
      const s = body / rowBytes
      if (s >= width) {
        headerLen = hl
        stride = s
        break
      }
    }
  }
  if (headerLen < 0) {
    throw new AppError(
      'CAPTURE_BAD_FRAME',
      `截图长度与头部不匹配：共 ${len} 字节，头部声明 ${width}x${height}（期望 ${width * height * 4 + 16} 或 ${width * height * 4 + 12} 字节）。`,
      { len, width, height, tried: [...SCREENCAP_HEADER_LENS] }
    )
  }

  if (format !== PIXEL_FORMAT_RGBA_8888) {
    throw new AppError(
      'CAPTURE_BAD_FRAME',
      `不支持的像素格式 ${format}，只支持 RGBA_8888（format=1）。`,
      { format, width, height }
    )
  }

  const rowBytes = width * 4
  let data: Uint8Array
  if (stride === width) {
    // 无填充：零拷贝切片。
    data = buf.subarray(headerLen, headerLen + rowBytes * height)
  } else {
    // 有行填充：逐行裁掉。
    const strideBytes = stride * 4
    data = new Uint8Array(rowBytes * height)
    for (let y = 0; y < height; y++) {
      const from = headerLen + y * strideBytes
      data.set(buf.subarray(from, from + rowBytes), y * rowBytes)
    }
  }

  if (data.byteLength !== rowBytes * height) {
    throw new AppError(
      'CAPTURE_BAD_FRAME',
      `截图像素数据不完整：期望 ${rowBytes * height} 字节，实得 ${data.byteLength} 字节。`,
      { width, height, got: data.byteLength }
    )
  }

  return { width, height, format, data, capturedAt: Date.now() }
}
