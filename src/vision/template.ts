/**
 * 模板编译：PNG 字节 -> 可直接喂给 matchTemplate 的 PreparedTemplate。
 *
 * 编译只在「启动时 / 保存模板时」做一次，之后永久复用。运行期的每次匹配都不该再碰这里。
 */

import {
  DEFAULT_MATCH_THRESHOLD,
  DEFAULT_SHRINK,
  MIN_MASK_COVERAGE,
  MIN_MASK_PIXELS,
  MIN_TEMPLATE_STD
} from '@shared/constants'
import { AppError } from '@shared/errors'
import type { PreparedTemplate, Rect } from '@shared/vision'
import { asBuffer, clampShrink, sharp } from './cv'
import { stdDev, stdDevMasked } from './preprocess'

export interface PrepareTemplateOptions {
  id: string
  /** 中文显示名，只用于报错文案。 */
  name: string
  /** 参考分辨率宽度。模板会先被归一化到这个宽度对应的尺度。 */
  refW: number
  /** 截取这张模板时的**画面宽度**（不是模板自身宽度）。缺省视为已经是参考分辨率下截的。 */
  authoredWidth?: number
  shrink?: number
  threshold?: number
  defaultRoi?: Rect
}

/** 缩放后小于这个边长的模板没有判别力，直接拒绝。 */
const MIN_PREPARED_EDGE = 3

/** 编译缓存上限。模板都很小（几 KB），256 个绰绰有余，超出按插入顺序淘汰。 */
const MAX_CACHE_ENTRIES = 256

const cache = new Map<string, PreparedTemplate>()

/**
 * 编译一个模板。
 *
 * 归一化（★ 必须做）：模板可能是在 1920 宽的画面上截的，而运行时画面是 2560 宽，
 * 直接拿来匹配实测只有 0.62 分且定位偏移；先按 refW/authoredWidth 缩放到参考分辨率后，
 * 分数回到 1.0000。缩放系数 k = refW / authoredWidth，再除以 shrink 落到降采样空间。
 *
 * @throws AppError('TEMPLATE_LOW_VARIANCE') 灰度标准差低于 MIN_TEMPLATE_STD
 * @throws AppError('TEMPLATE_DECODE_FAILED') PNG 无法解码或输出通道数异常
 * @throws AppError('TEMPLATE_TOO_LARGE') 归一化后比整个参考画面还宽
 */
export async function prepareTemplate(
  png: Uint8Array,
  opts: PrepareTemplateOptions
): Promise<PreparedTemplate> {
  const shrink = clampShrink(opts.shrink ?? DEFAULT_SHRINK)
  const threshold = clampThreshold(opts.threshold ?? DEFAULT_MATCH_THRESHOLD)

  // 缓存键带内容指纹，模板文件被改写后自然不会命中旧结果。
  const key = `${opts.id}|${opts.refW}|${opts.authoredWidth ?? 0}|${shrink}|${png.byteLength}|${fingerprint(png)}`
  const hit = cache.get(key)
  if (hit) {
    // 缓存只记「贵的那部分」= 解码+缩放后的灰度像素；threshold / defaultRoi 是廉价的表层字段，
    // 一律以本次 opts 为准（不能 `?? hit.xxx` 兜底：用户在面板上把某个模板的 ROI 清空后重新加载时，
    // 兜底会把已删除的旧 ROI 又贴回来，表现为「ROI 删不掉」）。
    return { ...hit, threshold, defaultRoi: opts.defaultRoi }
  }

  const buf = asBuffer(png)

  let w0: number
  let h0: number
  let hasAlpha = false
  try {
    const meta = await sharp(buf).metadata()
    if (!meta.width || !meta.height) {
      throw new AppError('TEMPLATE_DECODE_FAILED', `模板「${opts.name}」的图片缺少宽高信息`)
    }
    w0 = meta.width
    h0 = meta.height
    hasAlpha = Boolean(meta.hasAlpha)
  } catch (e) {
    if (e instanceof AppError) throw e
    throw new AppError(
      'TEMPLATE_DECODE_FAILED',
      `模板「${opts.name}」图片解码失败：${e instanceof Error ? e.message : String(e)}`,
      { templateId: opts.id }
    )
  }

  // k：把模板从「截取时的画面尺度」搬到「参考分辨率尺度」。
  const k =
    opts.authoredWidth && opts.authoredWidth > 0 && opts.authoredWidth !== opts.refW
      ? opts.refW / opts.authoredWidth
      : 1

  const refW = Math.max(1, Math.round(w0 * k))
  const refH = Math.max(1, Math.round(h0 * k))
  if (refW > opts.refW) {
    throw new AppError(
      'TEMPLATE_TOO_LARGE',
      `模板「${opts.name}」归一化后宽 ${refW} 超过参考分辨率宽度 ${opts.refW}，无法匹配`,
      { templateId: opts.id, refW, limit: opts.refW }
    )
  }

  const tw = Math.max(1, Math.round(refW / shrink))
  const th = Math.max(1, Math.round(refH / shrink))
  if (tw < MIN_PREPARED_EDGE || th < MIN_PREPARED_EDGE) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `模板「${opts.name}」降采样后只剩 ${tw}x${th} 像素，太小无法可靠匹配。` +
        '请截取更大的区域，或把降采样倍率调小。',
      { templateId: opts.id, tw, th, shrink }
    )
  }

  // 一条 sharp 管线搞定：解码 -> （必要时）缩放 -> 灰度 -> 单通道 raw。
  //
  // ★ 顺序：先缩放再灰度。反过来（先灰度得到单通道 raw 再 resize）会踩
  //   「单通道 raw 被 resize 静默提升成 3 通道」的坑。
  //
  // ★ 缩放核为什么用 cubic，而不是跟 prepareFrame 一样的点采样？
  //   帧是点采样的，模板若也点采样、且裁剪起点坐标恰好与帧的采样格点同相位，
  //   得分能到满分 1.0000；但裁剪起点是用户拖出来的，奇数坐标就错相位。
  //   在抗锯齿矢量 UI 上实测（shrink=2，同一画面同一目标，只改裁剪起点奇偶）：
  //       裁剪起点   点采样模板              cubic 模板
  //       偶,偶      1.0000                  0.9256
  //       奇,偶      0.8661                  0.9316
  //       偶,奇      0.8546                  0.9257
  //       奇,奇      0.7519  ← 低于 0.85，漏检   0.9222
  //   点采样是「一半概率满分、一半概率漏检」的相位彩票；cubic 做了低通，
  //   四种相位全在 0.92~0.96，最差也有 0.07 的阈值余量。要的是下限不是峰值，所以选 cubic。
  //
  //   顺带的代价：模板与帧的采样相位可能差一格，命中坐标会量化到 shrink 的整数倍，
  //   即**定位精度 ±shrink 像素（参考分辨率空间）**。按钮动辄几十上百像素，点击无影响。
  //
  // ★ 先 removeAlpha：透明通道单独走下面 buildMask 的掩码管线，灰度管线永远只出单通道
  //   （否则 RGBA 模板经 greyscale 会输出「灰+α」两通道，被当成解码异常拒绝）。
  let pipeline = sharp(buf).removeAlpha()
  if (tw !== w0 || th !== h0) {
    pipeline = pipeline.resize(tw, th, { kernel: 'cubic', fit: 'fill' })
  }
  const { data, info } = await pipeline
    .greyscale()
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true })

  if (info.channels !== 1 || data.length !== tw * th) {
    throw new AppError(
      'TEMPLATE_DECODE_FAILED',
      `模板「${opts.name}」灰度化输出异常：期望 ${tw}x${th} 单通道共 ${tw * th} 字节，` +
        `实得 ${info.width}x${info.height} ${info.channels} 通道共 ${data.length} 字节`,
      { templateId: opts.id }
    )
  }

  const gray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)

  // 透明底：PNG 带 α 通道时，α<128 的像素不参与匹配（走 OpenCV matchTemplate 的 mask 参数）。
  // 全不透明（普通截图恰好存成 RGBA）就退化成普通模板，不背掩码匹配的额外开销。
  const masked = hasAlpha ? await buildMask(buf, opts, tw, th, w0, h0) : null
  const std = masked ? stdDevMasked(gray, masked.mask) : stdDev(gray)

  // ★★★ 本模块最重要的一段代码 ★★★
  // 低方差模板会让 TM_CCOEFF_NORMED 彻底退化：
  //   · 两个纯白 160x160 模板对**任意画面**恒定返回 1.0000 @ (0,0)
  //   · 天空渐变块（std=7.5）对完全不同的界面也能返回 0.9601
  // 拦不住的话，脚本会在完全错误的位置疯狂点击，而且日志里全是「命中」，极难排查。
  // 真实游戏图标的 std 一般在 40~43，阈值 12 只会拦住纯色/渐变这类真正无纹理的选区。
  if (std < MIN_TEMPLATE_STD) {
    throw new AppError(
      'TEMPLATE_LOW_VARIANCE',
      `模板「${opts.name}」方差过低 std=${std.toFixed(1)} < ${MIN_TEMPLATE_STD}：` +
        'TM_CCOEFF_NORMED 会对它恒定给出高分导致必然误匹配，请改选纹理更丰富的区域',
      { templateId: opts.id, std, min: MIN_TEMPLATE_STD }
    )
  }

  const prepared: PreparedTemplate = {
    id: opts.id,
    name: opts.name,
    gray,
    w: tw,
    h: th,
    refW,
    refH,
    shrink,
    std,
    threshold,
    defaultRoi: opts.defaultRoi,
    ...(masked ? { mask: masked.mask, maskCoverage: masked.coverage } : {})
  }

  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, prepared)
  return prepared
}

/** 清空编译缓存。改了参考分辨率 / shrink 之后调一次，或者内存吃紧时手动调。 */
export function clearTemplateCache(): void {
  cache.clear()
}

/** 当前缓存条目数，面板的诊断信息用。 */
export function templateCacheSize(): number {
  return cache.size
}

/**
 * 从 PNG 的 α 通道生成降采样空间的掩码。与灰度管线用同一个 cubic 缩放，再按 128 二值化。
 * 全不透明返回 null（按普通模板处理）；抠得只剩零星像素则拒绝。
 */
async function buildMask(
  buf: Buffer,
  opts: PrepareTemplateOptions,
  tw: number,
  th: number,
  w0: number,
  h0: number
): Promise<{ mask: Uint8Array; coverage: number } | null> {
  let pipeline = sharp(buf).ensureAlpha().extractChannel('alpha')
  if (tw !== w0 || th !== h0) {
    pipeline = pipeline.resize(tw, th, { kernel: 'cubic', fit: 'fill' })
  }
  const { data, info } = await pipeline
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 1 || data.length !== tw * th) {
    throw new AppError(
      'TEMPLATE_DECODE_FAILED',
      `模板「${opts.name}」α 通道输出异常：期望 ${tw}x${th} 单通道共 ${tw * th} 字节，` +
        `实得 ${info.width}x${info.height} ${info.channels} 通道共 ${data.length} 字节`,
      { templateId: opts.id }
    )
  }
  const mask = new Uint8Array(tw * th)
  let opaque = 0
  for (let i = 0; i < mask.length; i++) {
    if (data[i] >= 128) {
      mask[i] = 255
      opaque++
    }
  }
  if (opaque === mask.length) return null
  const coverage = opaque / mask.length
  if (opaque < MIN_MASK_PIXELS || coverage < MIN_MASK_COVERAGE) {
    throw new AppError(
      'TEMPLATE_LOW_VARIANCE',
      `模板「${opts.name}」透明底抠得太狠：降采样后只剩 ${opaque} 个不透明像素` +
        `（${(coverage * 100).toFixed(0)}%），低于下限 ${MIN_MASK_PIXELS} 个 / ${MIN_MASK_COVERAGE * 100}%。` +
        '请放宽差分容差、多截一帧背景差异更大的画面，或改框图标里不透明的那部分。',
      { templateId: opts.id, opaque, coverage, minPixels: MIN_MASK_PIXELS, minCoverage: MIN_MASK_COVERAGE }
    )
  }
  return { mask, coverage: Math.round(coverage * 1000) / 1000 }
}

function clampThreshold(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_MATCH_THRESHOLD
  return Math.min(1, Math.max(0, v))
}

/** FNV-1a 32 位。模板 PNG 只有几 KB，全量哈希的开销可以忽略。 */
function fingerprint(b: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < b.length; i++) {
    h ^= b[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
