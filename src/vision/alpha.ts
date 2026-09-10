/**
 * 透明底（掩码）模板的两个纯函数。
 *
 * 为什么需要：有些控件不是实心的 —— 兽族城内左下角的「切世界地图」按钮，圆环里透着城内地形，
 * 城一拖动/缩放，圆环里的内容就变了；整块裁下来的模板换个背景只剩 0.79~0.89（阈值 0.85，随缘漏检）。
 * 把会变的像素抠成透明（掩码 0），只拿控件本体去算相关系数，同一批帧稳定 0.97~0.98。
 *
 *   · buildDiffAlpha —— 多帧差分去底：同一位置、不同背景的几帧里「没变」的像素才是控件本体，
 *     会变的就是透出来的背景。不需要人手抠图，抓两三帧（把地图拖开一点再截）就够。
 *   · applyAlpha —— 把单通道 α 图并进模板 PNG 的第 4 通道；prepareTemplate 看到 α 就会生成掩码。
 *
 * ⚠️ 纯 Node（只依赖 sharp），不 import electron；主进程、utilityProcess、脚本都能用。
 */

import { DEFAULT_ALPHA_DIFF_TOLERANCE } from '@shared/constants'
import { AppError } from '@shared/errors'
import type { Rect } from '@shared/vision'
import { asBuffer, sharp } from './cv'

export interface DiffAlphaOptions {
  /** RGB 任一通道差值 ≤ 容差视为「没变」。默认 DEFAULT_ALPHA_DIFF_TOLERANCE。 */
  tolerance?: number
  /** 3x3 多数滤波去掉孤立噪点（默认开）。 */
  smooth?: boolean
}

export interface DiffAlphaResult {
  /** 与裁剪区同尺寸的单通道 PNG：255 参与匹配，0 忽略。可直接作为 TemplateSaveInput.alpha。 */
  alphaPng: Buffer
  /** 不透明像素占比 0~1。太低（<0.1）说明几帧之间连控件本体都对不上，多半是位置没对齐。 */
  coverage: number
  width: number
  height: number
}

/**
 * 多帧差分去底。
 *
 * @param frames 至少两张**整帧** PNG（同一控件在同一位置、背景不同），第一张是模板取色的那帧
 * @param crop   在 frames 上的裁剪区（帧自己的像素坐标，与 TemplateSaveInput.crop 同口径）
 */
export async function buildDiffAlpha(
  frames: Uint8Array[],
  crop: Rect,
  opts: DiffAlphaOptions = {}
): Promise<DiffAlphaResult> {
  if (frames.length < 2) {
    throw new AppError('INVALID_ARGUMENT', '差分去底至少需要两帧（同一控件、不同背景）', {
      frames: frames.length
    })
  }
  const tol = Math.min(255, Math.max(0, Math.round(opts.tolerance ?? DEFAULT_ALPHA_DIFF_TOLERANCE)))
  const x = Math.round(crop.x)
  const y = Math.round(crop.y)
  const w = Math.round(crop.w)
  const h = Math.round(crop.h)
  if (!(w > 0) || !(h > 0)) {
    throw new AppError('INVALID_ARGUMENT', `差分去底的裁剪区尺寸非法：${w}x${h}`, { crop })
  }

  // 差分帧必须与主帧同尺寸，否则「同一位置」无从谈起（面板里换了分辨率开关再抓就会撞上）。
  let refSize: { w: number; h: number } | null = null
  for (const [i, f] of frames.entries()) {
    const meta = await sharp(asBuffer(f)).metadata()
    const fw = meta.width ?? 0
    const fh = meta.height ?? 0
    if (!refSize) refSize = { w: fw, h: fh }
    else if (fw !== refSize.w || fh !== refSize.h) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `差分去底：第 ${i + 1} 帧尺寸 ${fw}x${fh} 与主帧 ${refSize.w}x${refSize.h} 不一致。` +
          '请在同一实例、同一分辨率设置下重新抓差分帧。',
        { frame: i, size: { w: fw, h: fh }, ref: refSize }
      )
    }
  }

  const rgbs: Buffer[] = []
  for (const [i, f] of frames.entries()) {
    let data: Buffer
    let info: { width: number; height: number; channels: number }
    try {
      ;({ data, info } = await sharp(asBuffer(f))
        .extract({ left: x, top: y, width: w, height: h })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true }))
    } catch (e) {
      throw new AppError(
        'TEMPLATE_DECODE_FAILED',
        `差分去底：第 ${i + 1} 帧裁剪失败（裁剪区 ${x},${y} ${w}x${h} 可能超出画面）：${
          e instanceof Error ? e.message : String(e)
        }`,
        { frame: i, crop }
      )
    }
    if (info.channels !== 3 || data.length !== w * h * 3) {
      throw new AppError(
        'TEMPLATE_DECODE_FAILED',
        `差分去底：第 ${i + 1} 帧解码异常，期望 ${w}x${h} 3 通道，实得 ${info.width}x${info.height} ${info.channels} 通道`,
        { frame: i }
      )
    }
    rgbs.push(data)
  }

  const n = w * h
  const raw = new Uint8Array(n)
  const ref = rgbs[0]
  for (let i = 0; i < n; i++) {
    let d = 0
    for (let k = 1; k < rgbs.length; k++) {
      const o = rgbs[k]
      for (let c = 0; c < 3; c++) {
        const v = Math.abs(ref[i * 3 + c] - o[i * 3 + c])
        if (v > d) d = v
      }
    }
    raw[i] = d <= tol ? 255 : 0
  }
  const mask = opts.smooth === false ? raw : majority3x3(raw, w, h)

  let opaque = 0
  for (let i = 0; i < n; i++) if (mask[i]) opaque++

  const alphaPng = await sharp(mask, { raw: { width: w, height: h, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
  return { alphaPng, coverage: opaque / n, width: w, height: h }
}

/**
 * 把单通道 α 图并进模板 PNG 的第 4 通道，输出 RGBA PNG。
 * α 图尺寸必须与模板一致；多通道的 α 图取第一个通道。
 */
export async function applyAlpha(png: Uint8Array, alphaPng: Uint8Array): Promise<Buffer> {
  const base = await sharp(asBuffer(png))
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  const a = await sharp(asBuffer(alphaPng))
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true })
  const w = base.info.width
  const h = base.info.height
  if (a.info.width !== w || a.info.height !== h) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `透明底 α 图尺寸 ${a.info.width}x${a.info.height} 与模板 ${w}x${h} 不一致`,
      { alpha: { w: a.info.width, h: a.info.height }, template: { w, h } }
    )
  }
  const bc = base.info.channels
  const ac = a.info.channels
  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    // 灰度模板（1 通道）三份复制成 RGB；正常模板是 3 通道。
    rgba[i * 4] = base.data[i * bc]
    rgba[i * 4 + 1] = base.data[i * bc + (bc >= 3 ? 1 : 0)]
    rgba[i * 4 + 2] = base.data[i * bc + (bc >= 3 ? 2 : 0)]
    rgba[i * 4 + 3] = a.data[i * ac]
  }
  return sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/**
 * 去底预览：主帧裁剪区并上差分 α，压在洋红底上放大（洋红 = 抠掉）。面板与 tplkit 共用。
 * 返回值里的 width/height 是裁剪区原尺寸；previewPng 已按 previewWidth 缩放。
 */
export async function renderAlphaPreview(
  frames: Uint8Array[],
  crop: Rect,
  opts: DiffAlphaOptions & { previewWidth?: number } = {}
): Promise<{ coverage: number; width: number; height: number; previewPng: Buffer }> {
  const r = await buildDiffAlpha(frames, crop, opts)
  const cropPng = await sharp(asBuffer(frames[0]))
    .extract({
      left: Math.round(crop.x),
      top: Math.round(crop.y),
      width: r.width,
      height: r.height
    })
    .png()
    .toBuffer()
  const rgba = await applyAlpha(new Uint8Array(cropPng), new Uint8Array(r.alphaPng))
  const width = Math.max(16, Math.min(opts.previewWidth ?? 360, r.width * 4))
  const previewPng = await sharp(rgba)
    .flatten({ background: '#ff00ff' })
    .resize({ width, kernel: 'nearest' })
    .png()
    .toBuffer()
  return { coverage: r.coverage, width: r.width, height: r.height, previewPng }
}

/** 3x3 多数滤波：9 个邻居里 ≥5 个不透明才算不透明。去掉差分产生的孤立噪点和毛边。 */
function majority3x3(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let cnt = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          if (src[yy * w + xx]) cnt++
        }
      }
      out[y * w + x] = cnt >= 5 ? 255 : 0
    }
  }
  return out
}
