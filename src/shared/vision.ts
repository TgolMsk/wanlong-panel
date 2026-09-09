/**
 * 视觉引擎的公共契约：帧、模板、匹配结果。
 *
 * 坐标系约定（全工程唯一，务必遵守）：
 *   · 模板像素、ROI、脚本里写的所有 x/y/w/h 都在 **参考分辨率** 空间（REF_WIDTH x REF_HEIGHT）。
 *   · PreparedFrame 内部另有一个「降采样空间」（参考分辨率 / shrink），那是实现细节，不外泄。
 *   · 只有真正要 `adb input tap` 时才用 refToDevice() 换算到设备真实像素。
 */

export interface Point {
  x: number
  y: number
}

/** 参考分辨率空间的矩形。 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// ── 帧 ────────────────────────────────────────────────────────────────────

/** 从 `adb exec-out screencap` 解析出的裸帧（RGBA_8888，无行填充）。 */
export interface RawFrame {
  width: number
  height: number
  /** screencap 头部的 format 字段，1 = RGBA_8888。 */
  format: number
  /** 长度必然等于 width * height * 4。 */
  data: Uint8Array
  /** 抓取完成的时间戳。 */
  capturedAt: number
}

/**
 * 每帧预处理一次的产物：归一化到参考分辨率并降采样后的灰度图。
 * 一帧只做一次，然后喂给 N 个模板的 matchIn，别每次匹配都重新解码。
 */
export interface PreparedFrame {
  /** 灰度像素，尺寸 = w * h。 */
  gray: Uint8Array
  /** 降采样后的宽高 = ref / shrink。 */
  w: number
  h: number
  refWidth: number
  refHeight: number
  shrink: number
  /** 原始设备分辨率，toDevice 换算要用。 */
  deviceWidth: number
  deviceHeight: number
  capturedAt: number
}

// ── 模板 ──────────────────────────────────────────────────────────────────

/** 模板在磁盘上的元数据（写进 manifest.json）。 */
export interface TemplateDef {
  id: string
  /** 中文显示名，例如「联盟按钮」。 */
  name: string
  /** 相对于模板集目录的 png 文件名。 */
  file: string
  /** 截取这张模板时的画面宽度。用于把模板归一化到参考分辨率。 */
  authoredWidth: number
  authoredHeight: number
  /** 模板在原画面里的位置（参考分辨率空间），用来自动推导默认 ROI。 */
  bounds: Rect
  /**
   * 默认搜索区域（参考分辨率空间）。强烈建议每个模板都填：
   * 实测全屏 62ms -> 导航条 5.2ms -> 单键 1.45ms，ROI 是最划算的加速（43 倍）。
   */
  defaultRoi?: Rect
  /** 覆盖全局阈值。 */
  threshold?: number
  /** prepareTemplate 时算出的灰度标准差，< MIN_TEMPLATE_STD 会被拒绝。存下来便于面板提示。 */
  std?: number
  tags?: string[]
  note?: string
  createdAt: number
  updatedAt: number
}

/** 一组模板（通常一个游戏一组，或一个游戏的一个界面一组）。 */
export interface TemplateSet {
  id: string
  name: string
  /** 归属游戏包名，脚本按包名筛选可用模板集。 */
  packageName?: string
  refWidth: number
  refHeight: number
  templates: TemplateDef[]
  updatedAt: number
}

/** 保存模板时渲染进程传给主进程的输入。 */
export interface TemplateSaveInput {
  /** 不传则新建；传了则覆盖同 id 模板。 */
  id?: string
  name: string
  /** 整帧 PNG/JPEG 的原始字节，主进程按 bounds 裁剪；或直接给已裁好的小图并省略 bounds。 */
  image: ArrayBuffer
  /** image 对应的画面宽高（截取时的设备分辨率）。 */
  authoredWidth: number
  authoredHeight: number
  /** 在 image 上的裁剪区域（**image 自己的像素坐标**，不是参考坐标）。省略表示 image 已是裁好的模板。 */
  crop?: Rect
  defaultRoi?: Rect
  threshold?: number
  tags?: string[]
  note?: string
}

/** 启动时编译一次、永久复用的模板。 */
export interface PreparedTemplate {
  id: string
  name: string
  /** 降采样空间的灰度像素，尺寸 w * h。 */
  gray: Uint8Array
  w: number
  h: number
  /** 参考分辨率空间下的模板尺寸，匹配结果的 w/h 用它。 */
  refW: number
  refH: number
  shrink: number
  std: number
  threshold: number
  defaultRoi?: Rect
}

// ── 匹配 ──────────────────────────────────────────────────────────────────

export interface MatchOptions {
  /** 搜索区域（参考分辨率空间）。不传则全屏搜。 */
  roi?: Rect
  /** 覆盖模板/全局阈值。 */
  threshold?: number
}

/** 匹配结果。x/y/w/h/centerX/centerY 全部是**参考分辨率**坐标。 */
export interface MatchResult {
  templateId: string
  found: boolean
  /** TM_CCOEFF_NORMED 的 maxVal，保留 4 位小数。 */
  score: number
  /** 未命中时为 -1。 */
  x: number
  y: number
  w: number
  h: number
  centerX: number
  centerY: number
  /** 实际生效的阈值。 */
  threshold: number
  /** 本次匹配耗时。 */
  elapsedMs: number
  /** 未命中或无法匹配时的中文原因，例如「ROI 小于模板」。 */
  reason?: string
}

/** 一次多模板检测请求（一帧内批量匹配）。 */
export interface DetectSpec {
  templateId: string
  roi?: Rect
  threshold?: number
}

export interface DetectResponse {
  capturedAt: number
  deviceWidth: number
  deviceHeight: number
  /** 与请求的 specs 顺序一一对应。 */
  results: MatchResult[]
  /** 分段耗时，面板的性能面板会显示。 */
  timing: {
    captureMs: number
    prepareMs: number
    matchMs: number
  }
}
