/**
 * 视觉引擎的统一出口。
 *
 * 三级流水线（一次 tick 的典型耗时，2560x1440 / shrink=2）：
 *   ① adb exec-out screencap 抓裸帧      ~280ms   ← 瓶颈在这里，别在别处优化
 *   ② prepareFrame 灰度+降采样            ~1.5ms（本机实测中位数）
 *   ③ matchIn 逐模板匹配                  1ms（单键 ROI）/ 2ms（导航条 ROI）/ 18ms（全屏）
 *
 * 另：首次调用会同步等 OpenCV(WASM) 就绪，本机实测 182ms，之后为 0。
 * shrink 的取舍（同一目标，实测得分几乎不变，耗时差一个数量级）：
 *   shrink=1  全屏 115ms  得分 0.9733      shrink=2  全屏 18ms  得分 0.9699
 *   shrink=4  全屏 4ms    得分 0.9691   ← 再快就要牺牲定位精度（±shrink 像素）了
 *
 * 用法（worker 里的典型写法）：
 *   setTemplatesDir(paths.templatesDir)
 *   const tpls = await loadPrepared(setId, { refW, shrink })
 *   const frame = await prepareFrame(raw, { refW, refH, shrink })
 *   const results = await detect(frame, specs, (id) => tpls.get(id)!)
 *   const p = toDevice(frame, results[0].centerX, results[0].centerY)  // 再拿去 adb input tap
 *
 * 三条铁律：
 *   · 匹配算法只用 TM_CCOEFF_NORMED；
 *   · 每个 Mat 必须走 withMats 释放；
 *   · 低方差模板一律拒绝（MIN_TEMPLATE_STD）。
 *
 * ⚠️ 本目录不 import electron，主进程与 utilityProcess 都能直接 import。
 */

export { getCv, isCvReady, withMats, asBuffer, clampShrink } from './cv'
export type { Cv } from './cv'

export { grayShrink, stdDev, stdDevMasked, prepareFrame } from './preprocess'

export { buildDiffAlpha, applyAlpha, renderAlphaPreview } from './alpha'
export type { DiffAlphaOptions, DiffAlphaResult } from './alpha'

export { prepareTemplate, clearTemplateCache, templateCacheSize } from './template'
export type { PrepareTemplateOptions } from './template'

export { matchIn, detect, toDevice } from './matcher'

export {
  setTemplatesDir,
  getTemplatesDir,
  listSets,
  createSet,
  readSet,
  deleteSet,
  listTemplates,
  saveTemplate,
  deleteTemplate,
  readTemplateImage,
  loadPrepared
} from './store'
