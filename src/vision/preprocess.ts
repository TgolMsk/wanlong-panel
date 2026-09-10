/**
 * 每帧一次的预处理：把设备裸帧（RGBA_8888）归一化到参考分辨率并降采样成灰度图。
 *
 * 这是全链路最烫的一段代码 —— 一次抓图 280ms、匹配 5ms，中间的预处理如果写成
 * `sharp.resize().greyscale()` 就是 64ms，占比高得离谱；自写一次遍历只要 2.1ms。
 * 所以设备分辨率 == 参考分辨率时**必须**走自写快路，sharp 只作为异分辨率的兜底。
 */

import { DEFAULT_SHRINK } from '@shared/constants'
import { AppError } from '@shared/errors'
import type { PreparedFrame, RawFrame } from '@shared/vision'
import { asBuffer, clampShrink, sharp } from './cv'

/**
 * 灰度 + 整数点采样降采样，一次遍历完成。
 *
 * ★ 实测 2560x1440 RGBA -> 1280x720 灰度只要 2.1ms，
 *   而 `sharp.resize(cubic).greyscale()` 是 64.1ms —— 快 30 倍。
 *   差距来自：没有色彩空间转换、没有插值卷积、没有 Buffer 往返。
 *
 * ★ 为什么用点采样，而不是「更讲究」的 2x2 均值 —— 这里有个反直觉的实测结论，
 *   前期调研建议「余量吃紧时换 2x2 均值，多 7.5ms 换 +0.013 分」，**实测是反的**：
 *
 *   合成 UI 画面（抗锯齿矢量图形+文字，2560x1440，shrink=2，模板固定 cubic 缩放），
 *   把模板裁剪起点在 x/y 上各偏移 0~1 像素，取四种相位里的最差分：
 *       帧的降采样核              最差得分          每帧成本
 *       点采样（当前实现）        0.9219            1.45ms
 *       2x2 均值                  0.8085 ← 漏检     7.65ms
 *       点采样 + 模板也点采样     0.7519 ← 漏检     1.45ms
 *   2x2 均值在相位对齐时确实更高（0.9977 vs 0.9261），但错相位时崩到 0.8085。
 *   我们要的是**下限**不是峰值：漏检会让脚本卡死，多 0.07 的峰值一分钱不值。
 *   所以点采样不是「凑合能用」，而是三种组合里下限最高且最便宜的那个。别改。
 *
 * ★ 已知边界：模板若裁在「逐像素级」的高频内容上（点阵噪声、抖动纹理、密集小字的
 *   亚像素细节），帧的点采样与模板的 cubic 低通会彻底对不上，得分掉到 0.4 以下。
 *   实测这只发生在逐像素随机噪声这种病态内容上，正常游戏 UI（按钮/图标/文字）在
 *   0.92~0.96；真遇到了，换一块有明确边缘和色块的区域重截模板即可。
 *
 * 灰度公式用 BT.601 的整数近似：(r*77 + g*151 + b*28) >> 8，避免浮点乘法。
 *
 * @param px 必须是 RGBA_8888 紧密排列、无行填充的像素，长度 >= W*H*4
 * @param f  降采样倍率，>=1 的整数
 */
export function grayShrink(
  px: Uint8Array,
  W: number,
  H: number,
  f: number
): { data: Uint8Array; w: number; h: number } {
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) {
    throw new AppError('CAPTURE_BAD_FRAME', `帧尺寸非法：${W}x${H}`)
  }
  const factor = clampShrink(f)
  const need = W * H * 4
  if (px.length < need) {
    throw new AppError(
      'CAPTURE_BAD_FRAME',
      `像素数据长度不足：期望 ${need} 字节（${W}x${H}x4），实得 ${px.length} 字节`,
      { width: W, height: H, expected: need, actual: px.length }
    )
  }

  const w = Math.floor(W / factor)
  const h = Math.floor(H / factor)
  if (w < 1 || h < 1) {
    throw new AppError('INVALID_ARGUMENT', `降采样倍率 ${factor} 对 ${W}x${H} 的帧过大`)
  }

  const out = new Uint8Array(w * h)
  const rowStride = W * 4
  const colStride = factor * 4
  let o = 0
  for (let y = 0; y < h; y++) {
    let i = y * factor * rowStride
    for (let x = 0; x < w; x++) {
      out[o++] = (px[i] * 77 + px[i + 1] * 151 + px[i + 2] * 28) >> 8
      i += colStride
    }
  }
  return { data: out, w, h }
}

/**
 * 灰度图的标准差。模板方差守卫（见 template.ts）与面板的模板质量提示都用它。
 * 单遍 sum / sumSq，921600 个像素时 sumSq 最大约 6e10，double 精度绰绰有余。
 */
export function stdDev(d: Uint8Array): number {
  const n = d.length
  if (n === 0) return 0
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const v = d[i]
    sum += v
    sumSq += v * v
  }
  const mean = sum / n
  // 数值误差可能让方差算出极小的负数，夹一下。
  const variance = Math.max(0, sumSq / n - mean * mean)
  return Math.sqrt(variance)
}

/** 只统计 mask 非 0 位置的灰度标准差（透明底模板用）。mask 全 0 返回 0。 */
export function stdDevMasked(d: Uint8Array, mask: Uint8Array): number {
  const n = Math.min(d.length, mask.length)
  let sum = 0
  let sumSq = 0
  let k = 0
  for (let i = 0; i < n; i++) {
    if (mask[i] === 0) continue
    const v = d[i]
    sum += v
    sumSq += v * v
    k++
  }
  if (k === 0) return 0
  const mean = sum / k
  return Math.sqrt(Math.max(0, sumSq / k - mean * mean))
}

/**
 * 一帧只做一次，产物喂给 N 个模板的 matchIn，**不要每次匹配都重新预处理**。
 *
 * 快路（设备分辨率 == 参考分辨率，MuMu 默认实例就是这种）：自写 grayShrink，2.1ms。
 * 慢路（异分辨率实例）：sharp cubic 缩放到参考分辨率/shrink，约 64ms。
 */
export async function prepareFrame(
  raw: RawFrame,
  opts: { refW: number; refH: number; shrink?: number }
): Promise<PreparedFrame> {
  const shrink = clampShrink(opts.shrink ?? DEFAULT_SHRINK)
  const W = raw.width
  const H = raw.height

  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) {
    throw new AppError('CAPTURE_BAD_FRAME', `截图尺寸非法：${W}x${H}`, { format: raw.format })
  }
  // 不信任 screencap 头部的 format 字段，直接用长度反推通道数：
  // 只要是 4 字节/像素（RGBA_8888 或 RGBX_8888）就能按 RGB 取前三通道。
  const channels = raw.data.length / (W * H)
  if (channels !== 4) {
    throw new AppError(
      'CAPTURE_BAD_FRAME',
      `截图数据长度 ${raw.data.length} 字节与 ${W}x${H}x4 = ${W * H * 4} 不符（format=${raw.format}），` +
        '本引擎只支持 4 字节/像素的 RGBA_8888 / RGBX_8888 裸帧。',
      { width: W, height: H, format: raw.format, byteLength: raw.data.length }
    )
  }

  if (W === opts.refW && H === opts.refH) {
    const g = grayShrink(raw.data, W, H, shrink)
    return {
      gray: g.data,
      w: g.w,
      h: g.h,
      refWidth: opts.refW,
      refHeight: opts.refH,
      shrink,
      deviceWidth: W,
      deviceHeight: H,
      capturedAt: raw.capturedAt
    }
  }

  // ── 慢路：异分辨率，交给 sharp 做带插值的缩放 ──────────────────────────
  const tw = Math.max(1, Math.floor(opts.refW / shrink))
  const th = Math.max(1, Math.floor(opts.refH / shrink))

  // ★ sharp 陷阱：raw buffer 经 .resize() 后通道数会被静默提升到 3，
  //   随后 cv.Mat.data.set() 会抛 "RangeError: offset is out of bounds"。
  //   必须在 resize 之后补 .greyscale().toColourspace('b-w') 强制回到单通道，
  //   并且下面还要再校验一次 info.channels，绝不放过静默变形。
  const { data, info } = await sharp(asBuffer(raw.data), {
    raw: { width: W, height: H, channels: 4 }
  })
    .resize(tw, th, { kernel: 'cubic', fit: 'fill' })
    .greyscale()
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true })

  if (info.channels !== 1 || data.length !== tw * th) {
    throw new AppError(
      'CAPTURE_BAD_FRAME',
      `帧缩放输出异常：期望 ${tw}x${th} 单通道共 ${tw * th} 字节，实得 ${info.width}x${info.height} ${info.channels} 通道共 ${data.length} 字节`,
      { expected: tw * th, actual: data.length, channels: info.channels }
    )
  }

  return {
    gray: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    w: tw,
    h: th,
    refWidth: opts.refW,
    refHeight: opts.refH,
    shrink,
    deviceWidth: W,
    deviceHeight: H,
    capturedAt: raw.capturedAt
  }
}
