/**
 * 模板匹配。三级流水线的最后一级（抓图 -> 预处理 -> 匹配）。
 *
 * ★ 只允许 TM_CCOEFF_NORMED，代码里不暴露 method 选项。
 *   实测负样本得分：TM_CCORR_NORMED 0.986~0.9998、TM_SQDIFF_NORMED 0.967~0.992，
 *   两者对「完全不相干的画面」都给高分，**没有任何判别力**；
 *   而 TM_CCOEFF_NORMED 正样本 0.975~0.985、负样本 0.452~0.535，间隔干净。
 *
 * ★ 也不需要边缘匹配 / 多尺度金字塔：
 *   · 抗光照 —— 模板压暗到 60% 仍得 0.9998，提亮 25% 得 0.9959，高斯噪声 σ≈12 得 0.9991；
 *   · 抗尺度 —— 参考分辨率归一化已经把尺度差异消掉了。
 *   加这些只会让每帧多花几十毫秒还引入新的失配来源。
 */

import { DEFAULT_MATCH_THRESHOLD } from '@shared/constants'
import { AppError } from '@shared/errors'
import type {
  DetectSpec,
  MatchOptions,
  MatchResult,
  PreparedFrame,
  PreparedTemplate,
  Rect
} from '@shared/vision'
import { getCv, withMats } from './cv'

/** 降采样空间里的整数矩形。 */
interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 在一帧里找一个模板。
 *
 * ROI 是最划算的加速手段（2560x1440 / shrink=2，本机实测中位数）：
 *   全屏 18ms -> 导航条 1360x290 区域 2ms -> 单个按钮 460x340 区域 1ms。
 *   （不降采样时差距更夸张：全屏 115ms -> 按钮 3ms，38 倍。）
 * 所以强烈建议每个模板都配 defaultRoi —— saveTemplate 在用户没指定时会自动推一个。
 *
 * 命中坐标量化到 shrink 的整数倍，即**定位精度 ±shrink 像素**（原因见 template.ts 里
 * 关于缩放核相位的说明）。点击按钮完全够用，但别拿它做像素级测量。
 *
 * @param opts.roi 参考分辨率坐标；不传则用 tpl.defaultRoi；再不传才全屏搜。
 */
export async function matchIn(
  frame: PreparedFrame,
  tpl: PreparedTemplate,
  opts?: MatchOptions
): Promise<MatchResult> {
  const t0 = Date.now()
  const threshold = clamp01(opts?.threshold ?? tpl.threshold ?? DEFAULT_MATCH_THRESHOLD)

  if (tpl.shrink !== frame.shrink) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `模板「${tpl.name}」是按 shrink=${tpl.shrink} 编译的，与当前帧的 shrink=${frame.shrink} 不一致，` +
        '请用相同的降采样倍率重新编译模板（loadPrepared 的 opts.shrink）。',
      { templateId: tpl.id, templateShrink: tpl.shrink, frameShrink: frame.shrink }
    )
  }
  if (tpl.gray.length !== tpl.w * tpl.h) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `模板「${tpl.name}」像素长度 ${tpl.gray.length} 与声明尺寸 ${tpl.w}x${tpl.h} 不符`,
      { templateId: tpl.id }
    )
  }
  if (tpl.mask && tpl.mask.length !== tpl.w * tpl.h) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `模板「${tpl.name}」透明底掩码长度 ${tpl.mask.length} 与声明尺寸 ${tpl.w}x${tpl.h} 不符`,
      { templateId: tpl.id }
    )
  }

  const roiRef = opts?.roi ?? tpl.defaultRoi
  const region = toPixelRect(frame, roiRef)

  if (region.w <= 0 || region.h <= 0) {
    return miss(tpl, threshold, t0, 0, 'ROI 超出画面范围')
  }
  if (region.w < tpl.w || region.h < tpl.h) {
    return miss(
      tpl,
      threshold,
      t0,
      0,
      `ROI 小于模板（搜索区 ${region.w * frame.shrink}x${region.h * frame.shrink}，` +
        `模板 ${tpl.refW}x${tpl.refH}，均为参考分辨率坐标）`
    )
  }

  const cv = await getCv()

  const { score, locX, locY } = await withMats(async (keep) => {
    // 只把 ROI 那几行拷进 WASM 堆，而不是先建全屏 Mat 再 .roi()。
    // 后者每次匹配都要 memcpy 整帧（shrink=2 时 921600 字节），10 个模板就是 9MB 无谓拷贝。
    const src = keep(new cv.Mat(region.h, region.w, cv.CV_8UC1))
    copyRegion(frame, region, src.data as Uint8Array)

    const tplMat = keep(new cv.Mat(tpl.h, tpl.w, cv.CV_8UC1))
    ;(tplMat.data as Uint8Array).set(tpl.gray)

    const dst = keep(new cv.Mat())
    if (tpl.mask) {
      // 透明底模板：掩码为 0 的像素不参与相关系数（OpenCV ≥4.3 六种方法都支持 mask，本工程的
      // WASM 构建实测可用）。兽族城内按钮的圆环里透着地形，整块匹配换个背景只有 0.79~0.89，
      // 掩码后同一批帧 0.97~0.98，负样本仍 ≤0.63。
      const maskMat = keep(new cv.Mat(tpl.h, tpl.w, cv.CV_8UC1))
      ;(maskMat.data as Uint8Array).set(tpl.mask)
      cv.matchTemplate(src, tplMat, dst, cv.TM_CCOEFF_NORMED, maskMat)
      // ★ 带掩码时，搜索区里某个窗口在掩码范围内是纯色，该位置会算出 NaN/±Inf（分母为 0），
      //   minMaxLoc 的 maxVal 会被这种垃圾值顶掉，把别处真正的命中淹没（实测「创建部队」页出过 +Inf）。
      //   非有限值和明显 >1 的都清成 0；略超 1 的浮点误差夹回 1。
      const d = dst.data32F as Float32Array
      for (let i = 0; i < d.length; i++) {
        const v = d[i]
        if (!Number.isFinite(v) || v > 1.01) d[i] = 0
        else if (v > 1) d[i] = 1
      }
    } else {
      cv.matchTemplate(src, tplMat, dst, cv.TM_CCOEFF_NORMED)
    }
    const mm = cv.minMaxLoc(dst)
    return { score: mm.maxVal as number, locX: mm.maxLoc.x as number, locY: mm.maxLoc.y as number }
  })

  if (!Number.isFinite(score)) {
    // 搜索区域是纯色时相关系数的分母为 0，OpenCV 会给出 NaN/Inf。
    // 这不是命中，是「这块画面没纹理」。
    return miss(tpl, threshold, t0, 0, '匹配得分非有限值：搜索区域可能是纯色，无法用相关系数判别')
  }

  // 带掩码的归一化相关系数会因浮点误差略超过 1，夹回来。
  const rounded = Math.round(Math.min(1, score) * 10000) / 10000
  if (rounded < threshold) {
    return miss(
      tpl,
      threshold,
      t0,
      rounded,
      `最高分 ${rounded.toFixed(4)} 低于阈值 ${threshold}` + describeRoi(roiRef)
    )
  }

  // 降采样空间 -> 参考分辨率空间。
  const x = (region.x + locX) * frame.shrink
  const y = (region.y + locY) * frame.shrink
  return {
    templateId: tpl.id,
    found: true,
    score: rounded,
    x,
    y,
    w: tpl.refW,
    h: tpl.refH,
    centerX: Math.round(x + tpl.refW / 2),
    centerY: Math.round(y + tpl.refH / 2),
    threshold,
    elapsedMs: Date.now() - t0
  }
}

/**
 * 一帧内批量匹配多个模板，复用同一个 PreparedFrame。
 * 结果与 specs **顺序一一对应**，单个模板出问题不会拖垮整批。
 *
 * @param resolve 由调用方提供的模板查找函数（通常是 loadPrepared 返回的 Map 的 get 包装）。
 */
export async function detect(
  frame: PreparedFrame,
  specs: DetectSpec[],
  resolve: (id: string) => PreparedTemplate
): Promise<MatchResult[]> {
  const out: MatchResult[] = []
  for (const spec of specs) {
    const t0 = Date.now()
    let tpl: PreparedTemplate | undefined
    try {
      tpl = resolve(spec.templateId)
    } catch (e) {
      out.push(
        notFoundResult(
          spec,
          t0,
          `模板「${spec.templateId}」查找失败：${e instanceof Error ? e.message : String(e)}`
        )
      )
      continue
    }
    if (!tpl) {
      out.push(notFoundResult(spec, t0, `模板「${spec.templateId}」不在已加载的模板集里`))
      continue
    }
    try {
      out.push(await matchIn(frame, tpl, { roi: spec.roi, threshold: spec.threshold }))
    } catch (e) {
      // 单个模板的异常（尺寸不符等）降级成一条 found:false 的结果，
      // 否则一个坏模板会让整个脚本 tick 失败。原因照实写进 reason，不吞。
      out.push(notFoundResult(spec, t0, e instanceof Error ? e.message : String(e)))
    }
  }
  return out
}

/**
 * 参考分辨率坐标 -> 设备真实像素。真正要 `adb input tap` 时才用。
 *
 * 注意这里用 frame 自带的 refWidth/refHeight，而不是 shared 里的全局常量 —
 * 万一某个实例是按别的参考分辨率跑的，用全局常量会算错。
 */
export function toDevice(frame: PreparedFrame, x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round((x * frame.deviceWidth) / frame.refWidth),
    y: Math.round((y * frame.deviceHeight) / frame.refHeight)
  }
}

// ── 内部 ──────────────────────────────────────────────────────────────────

/** 参考坐标的 ROI -> 降采样空间的整数矩形，并夹到画面内。不传 ROI 就是全屏。 */
function toPixelRect(frame: PreparedFrame, roi?: Rect): PixelRect {
  if (!roi) return { x: 0, y: 0, w: frame.w, h: frame.h }
  const s = frame.shrink
  // 向外取整，宁可多搜几个像素也不要把目标切掉。
  const x0 = Math.max(0, Math.min(frame.w, Math.floor(roi.x / s)))
  const y0 = Math.max(0, Math.min(frame.h, Math.floor(roi.y / s)))
  const x1 = Math.max(0, Math.min(frame.w, Math.ceil((roi.x + roi.w) / s)))
  const y1 = Math.max(0, Math.min(frame.h, Math.ceil((roi.y + roi.h) / s)))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** 把帧里的一块矩形逐行拷进目标缓冲（目标是 WASM 堆上的视图）。 */
function copyRegion(frame: PreparedFrame, r: PixelRect, dst: Uint8Array): void {
  if (r.x === 0 && r.w === frame.w) {
    // 整行连续，一次拷完。
    dst.set(frame.gray.subarray(r.y * frame.w, (r.y + r.h) * frame.w))
    return
  }
  for (let row = 0; row < r.h; row++) {
    const from = (r.y + row) * frame.w + r.x
    dst.set(frame.gray.subarray(from, from + r.w), row * r.w)
  }
}

function miss(
  tpl: PreparedTemplate,
  threshold: number,
  t0: number,
  score: number,
  reason: string
): MatchResult {
  return {
    templateId: tpl.id,
    found: false,
    score,
    x: -1,
    y: -1,
    w: tpl.refW,
    h: tpl.refH,
    centerX: -1,
    centerY: -1,
    threshold,
    elapsedMs: Date.now() - t0,
    reason
  }
}

function notFoundResult(spec: DetectSpec, t0: number, reason: string): MatchResult {
  return {
    templateId: spec.templateId,
    found: false,
    score: 0,
    x: -1,
    y: -1,
    w: 0,
    h: 0,
    centerX: -1,
    centerY: -1,
    threshold: clamp01(spec.threshold ?? DEFAULT_MATCH_THRESHOLD),
    elapsedMs: Date.now() - t0,
    reason
  }
}

function describeRoi(roi?: Rect): string {
  return roi ? `（搜索区 ${roi.x},${roi.y} ${roi.w}x${roi.h}，若目标不在此区内请检查 ROI）` : ''
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_MATCH_THRESHOLD
  return Math.min(1, Math.max(0, v))
}
