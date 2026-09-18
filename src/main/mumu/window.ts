/**
 * 「缩到角落」的位置计算。**纯函数**，不 import electron（屏幕尺寸由调用方传进来），所以能被离线自检直接跑。
 *
 * ★ 这是纯显示功能，与自动化无关：Android 按实例配置的分辨率**离屏渲染**，
 *   2026-09-18 在 MuMu 6.6.4 实测过正常 / 718×404 / 完全隐藏三种状态，
 *   `screencap` 一律输出 2560×1440 且画面统计值一致 —— 缩小或隐藏窗口不影响截图与模板匹配。
 *   也别指望省 CPU（实测 5.2% → 5.1%）：它解决的是 16 开时屏幕被占满。
 */

/** 屏幕可用区域（Electron 的 workArea：已经扣掉任务栏）。 */
export interface ScreenArea {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 小窗尺寸。★ 只是**请求值**：MuMu 有时会按自己的最小窗口夹一下 ——
 * 2026-09-18 实测两次结果不同（一次请求 480×270 得到 718×404，一次得到 479×269，
 * 与当时窗口所处的状态有关）。所以**别把请求值当成最终尺寸**去算布局，
 * 要知道真实几何只能事后去问系统（GetWindowRect）或读 MuMu 的返回。
 */
export const CORNER_WINDOW_SIZE = { width: 480, height: 270 } as const
/** 离屏幕边缘留一点，免得贴边压住任务栏或被圆角切掉。 */
export const CORNER_MARGIN = 12
/** 多个实例都缩到角落时的错位量，否则它们会叠成一摞，只看得见最上面那个。 */
export const CORNER_CASCADE = 28
/** 错位这么多次之后回到原点，免得实例多了一路铺到屏幕中间。 */
export const CORNER_CASCADE_WRAP = 6

/**
 * 实例 index → 右下角小窗的位置。按 index 错开，超过 WRAP 个就绕回来。
 *
 * 屏幕特别小时（笔记本竖屏、缩放很大）夹回可用区左上角，绝不把窗口摆到屏幕外面 ——
 * 那会让用户以为「点了没反应」，实际是窗口跑到看不见的地方去了。
 */
export function cornerWindowRect(index: number, area: ScreenArea): WindowRect {
  const step = (Math.max(0, Math.trunc(index)) % CORNER_CASCADE_WRAP) * CORNER_CASCADE
  const x = area.x + area.width - CORNER_WINDOW_SIZE.width - CORNER_MARGIN - step
  const y = area.y + area.height - CORNER_WINDOW_SIZE.height - CORNER_MARGIN - step
  return {
    x: Math.max(area.x, Math.round(x)),
    y: Math.max(area.y, Math.round(y)),
    width: CORNER_WINDOW_SIZE.width,
    height: CORNER_WINDOW_SIZE.height
  }
}
