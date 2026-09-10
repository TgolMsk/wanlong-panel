/**
 * 一次执行的运行时上下文（跑在 utilityProcess 里）。
 *
 * 它是脚本引擎与外部世界之间**唯一**的接口：
 *   · 取帧（带最小间隔限流 + 抖动错峰 + 同 tick 复用）
 *   · 模板匹配
 *   · 设备动作（转交 DeviceIo）
 *   · 日志 / 留痕 / 预览推流
 *
 * ★ 一次抓图两路消费：同一个 RawFrame 既喂 prepareFrame 做匹配，又喂 sharp 做预览 jpeg，
 *   **绝不为了预览再抓一次**（一次 screencap 就要 280ms，是全管线 96% 的开销）。
 *   两路在代码上是解耦的：二期把预览换成 scrcpy 时，只需要动 renderPreview()，匹配链路一行不用改。
 *
 * ★ 坐标约定：本文件对外暴露的 Point / Rect 一律是**脚本坐标空间**（script.refWidth x script.refHeight）。
 *   内部先换算到全局参考空间（settings.refWidth x settings.refHeight，模板与 PreparedFrame 所在的空间），
 *   真要点下去时再换算到设备像素。三个空间不要混。
 */

import sharp from 'sharp'
import {
  MIN_CAPTURE_INTERVAL_MS,
  PREVIEW_JPEG_QUALITY,
  PREVIEW_MAX_FPS,
  PREVIEW_WIDTH
} from '@shared/constants'
import { AppError } from '@shared/errors'
import type { AppSettings } from '@shared/domain'
import type { AndroidKey, LogLevel, RunSnapshot, ScriptDef } from '@shared/script'
import type {
  MatchOptions,
  MatchResult,
  Point,
  PreparedFrame,
  PreparedTemplate,
  RawFrame,
  Rect
} from '@shared/vision'
import type { WorkerAttachPayload, WorkerToMain, WorkerToRenderer } from '@shared/worker'
import { RunLogger } from './logger'

// ── 与模块 b / 模块 c 的接口（端口，不是实现）────────────────────────────
//
// 引擎只依赖这两个接口，不直接 import 模块 b/c。
// 真正的绑定在 runner.ts 的适配层里完成，那是全工程唯一与它们耦合的地方。

/** 设备侧能力（由模块 b 的 src/main/adb/* 提供实现）。坐标一律是**设备真实像素**。 */
export interface DeviceIo {
  /** raw RGBA screencap，宽高以 screencap 头部为准（绝不用 wm size）。 */
  capture(serial: string): Promise<RawFrame>
  tap(serial: string, x: number, y: number): Promise<void>
  swipe(
    serial: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number
  ): Promise<void>
  /** ★ 必须走同一次 shell 里的 motionevent DOWN/sleep/UP，不要用 swipe 假装长按。 */
  longPress(serial: string, x: number, y: number, durationMs: number): Promise<void>
  /** ★ 中文必须走 ADBKeyboard 的 base64 broadcast，input text 会静默丢弃非 ASCII。 */
  inputText(serial: string, text: string): Promise<void>
  keyEvent(serial: string, key: AndroidKey): Promise<void>
  launchApp(serial: string, packageName: string, cold: boolean): Promise<void>
  stopApp(serial: string, packageName: string): Promise<void>
  foregroundPackage(serial: string): Promise<string | null>
}

/** 视觉侧能力（由模块 c 的 src/vision/* 提供实现）。 */
export interface VisionIo {
  /** 归一化到参考分辨率 + 灰度 + 降采样。允许同步或异步实现。 */
  prepareFrame(
    raw: RawFrame,
    opts: { refWidth: number; refHeight: number; shrink: number }
  ): PreparedFrame | Promise<PreparedFrame>
  /** 单模板匹配。roi/threshold 都是**全局参考空间**。允许同步或异步实现。 */
  matchIn(
    frame: PreparedFrame,
    template: PreparedTemplate,
    opts?: MatchOptions
  ): MatchResult | Promise<MatchResult>
}

// ── 上下文 ────────────────────────────────────────────────────────────────

export interface RunContextInit {
  payload: WorkerAttachPayload
  templates: Map<string, PreparedTemplate>
  device: DeviceIo
  vision: VisionIo
  /** 直连渲染进程（MessagePort）。 */
  emit: (m: WorkerToRenderer) => void
  /** 回报主进程（parentPort）。 */
  report: (m: WorkerToMain) => void
}

/** 留痕截图的输出宽度。比预览大一些，出问题时要看得清按钮。 */
const SHOT_WIDTH = 1280
const SHOT_QUALITY = 72
/** 前台包名的缓存有效期：adb 一次查询约 20ms，同一个 tick 内没必要问两遍。 */
const FOREGROUND_CACHE_MS = 1000

export class RunContext {
  readonly runId: string
  readonly serial: string
  readonly instanceIndex: number
  readonly script: ScriptDef
  readonly params: Record<string, string | number | boolean>
  readonly settings: AppSettings
  readonly templates: Map<string, PreparedTemplate>
  readonly snapshot: RunSnapshot
  readonly logger: RunLogger
  readonly device: DeviceIo
  readonly vision: VisionIo

  /** 最近一帧的原始 RGBA（预览与留痕都复用它，不再重新抓）。 */
  lastRaw: RawFrame | null = null
  /** 引擎置 true 后，所有 sleep 会立刻返回、取帧会拒绝，用于优雅停止。 */
  aborted = false
  /** 暂停中（引擎在每步开始前会等它变 false）。 */
  paused = false

  private readonly emitFn: (m: WorkerToRenderer) => void
  private readonly reportFn: (m: WorkerToMain) => void
  private readonly minInterval: number
  /** 脚本坐标空间 -> 全局参考空间的缩放系数。 */
  private readonly sx: number
  private readonly sy: number

  private prepared: PreparedFrame | null = null
  private capturing: Promise<PreparedFrame> | null = null
  private lastCaptureAt = 0

  private previewEnabled = false
  private previewFps = PREVIEW_MAX_FPS
  private previewBusy = false
  private lastPreviewAt = 0
  private debugMatches = false

  private fgCache: { pkg: string | null; at: number } | null = null
  private shotSeq = 0
  private disposed = false

  constructor(init: RunContextInit) {
    const p = init.payload
    this.runId = p.runId
    this.serial = p.serial
    this.instanceIndex = p.instanceIndex
    this.script = p.script
    this.params = p.params
    this.settings = p.settings
    this.templates = init.templates
    this.device = init.device
    this.vision = init.vision
    this.emitFn = init.emit
    this.reportFn = init.report

    this.minInterval = Math.max(0, p.settings.minCaptureIntervalMs || MIN_CAPTURE_INTERVAL_MS)
    this.sx = p.settings.refWidth / (p.script.refWidth || p.settings.refWidth)
    this.sy = p.settings.refHeight / (p.script.refHeight || p.settings.refHeight)

    this.logger = new RunLogger(p.runId, p.instanceIndex, init.emit, init.report)

    this.snapshot = {
      runId: p.runId,
      scriptId: p.script.id,
      scriptName: p.script.name,
      instanceIndex: p.instanceIndex,
      serial: p.serial,
      accountId: p.accountId,
      accountName: p.accountName,
      status: 'pending',
      startedAt: Date.now(),
      endedAt: null,
      stepDone: 0,
      // loop 模式下总数没有意义（会一直跑），契约规定填 null。
      stepTotal: p.script.loop ? null : p.script.steps.length,
      currentStepId: null,
      currentStepName: null,
      iteration: 0,
      error: null,
      stats: {
        captures: 0,
        matches: 0,
        matchHits: 0,
        taps: 0,
        retries: 0,
        lastTickMs: 0,
        avgCaptureMs: 0
      }
    }
  }

  // ── 坐标换算 ────────────────────────────────────────────────────────────

  /** 脚本坐标 -> 全局参考坐标。 */
  pointToRef(p: Point): Point {
    return { x: Math.round(p.x * this.sx), y: Math.round(p.y * this.sy) }
  }

  /** 脚本坐标空间的矩形 -> 全局参考空间。 */
  rectToRef(r: Rect): Rect {
    return {
      x: Math.round(r.x * this.sx),
      y: Math.round(r.y * this.sy),
      w: Math.max(1, Math.round(r.w * this.sx)),
      h: Math.max(1, Math.round(r.h * this.sy))
    }
  }

  /**
   * 全局参考坐标 -> 设备真实像素。这是唯一允许把坐标交给 adb 的入口。
   * 设备分辨率取自最近一帧的 screencap 头部（铁律二：绝不信 wm size）。
   * 参考分辨率取默认值时，结果与 shared 的 refToDevice() 完全一致。
   */
  async refToDevicePoint(ref: Point): Promise<Point> {
    const { width, height } = await this.deviceSize()
    return {
      x: Math.round((ref.x * width) / this.settings.refWidth),
      y: Math.round((ref.y * height) / this.settings.refHeight)
    }
  }

  /** 脚本坐标 -> 设备真实像素（先归一化到参考空间，再落到设备像素）。 */
  async toDevice(p: Point): Promise<Point> {
    return this.refToDevicePoint(this.pointToRef(p))
  }

  /** 设备真实分辨率。没抓过帧就先抓一帧（分辨率只能从 screencap 头部拿）。 */
  async deviceSize(): Promise<{ width: number; height: number }> {
    if (this.lastRaw) return { width: this.lastRaw.width, height: this.lastRaw.height }
    const f = await this.frame()
    return { width: f.deviceWidth, height: f.deviceHeight }
  }

  // ── 取帧 ────────────────────────────────────────────────────────────────

  /**
   * 取一帧（已归一化 + 灰度 + 降采样）。
   * · 距上一帧不足 minCaptureIntervalMs 时直接复用上一帧（同一 tick 内多次匹配只抓一次图）。
   * · 并发调用共享同一个在途的抓图 Promise。
   * · force=true 强制抓新的（点击之后画面变了，必须 force）。
   */
  async frame(force = false): Promise<PreparedFrame> {
    if (this.aborted) throw new AppError('CANCELLED', '执行已停止，不再抓取新画面。')
    if (!force && this.prepared && Date.now() - this.prepared.capturedAt < this.minInterval) {
      return this.prepared
    }
    if (this.capturing) return this.capturing
    this.capturing = this.doCapture().finally(() => {
      this.capturing = null
    })
    return this.capturing
  }

  /** 让缓存的帧作废。任何会改变画面的动作（tap/swipe/key/launch）之后都要调。 */
  invalidateFrame(): void {
    this.prepared = null
  }

  private async doCapture(): Promise<PreparedFrame> {
    // 限流 + 抖动：多实例都过同一个 adb server(5037)，不错峰会互相排队排成一坨。
    const jitter = Math.floor(Math.random() * 120)
    const wait = this.lastCaptureAt + this.minInterval + jitter - Date.now()
    if (wait > 0) await this.sleep(wait)
    if (this.aborted) throw new AppError('CANCELLED', '执行已停止，不再抓取新画面。')

    const t0 = Date.now()
    let raw: RawFrame
    try {
      raw = await this.device.capture(this.serial)
    } catch (e) {
      throw AppError.from(e, 'ADB_COMMAND_FAILED')
    }
    const captureMs = Date.now() - t0
    this.lastCaptureAt = Date.now()
    this.lastRaw = raw

    const st = this.snapshot.stats
    st.captures += 1
    st.avgCaptureMs = Math.round(st.avgCaptureMs + (captureMs - st.avgCaptureMs) / st.captures)

    const prepared = await this.vision.prepareFrame(raw, {
      refWidth: this.settings.refWidth,
      refHeight: this.settings.refHeight,
      shrink: this.settings.shrink
    })
    this.prepared = prepared

    // 路 A：预览。fire-and-forget，绝不能挡住匹配链路。
    this.maybePreview(raw)
    return prepared
  }

  // ── 匹配 ────────────────────────────────────────────────────────────────

  /**
   * 匹配一个模板。roi 用**脚本坐标空间**（不传则用模板自带的 defaultRoi）。
   * 返回的 MatchResult 里的坐标是全局参考空间（由模块 c 保证）。
   */
  async matchTemplate(templateId: string, roi?: Rect, threshold?: number): Promise<MatchResult> {
    const tpl = this.templates.get(templateId)
    if (!tpl) {
      throw new AppError(
        'TEMPLATE_NOT_FOUND',
        `模板「${templateId}」不在模板集里。请检查脚本的 templateSetId 是否正确，或先在模板工具里截好这张模板。`,
        { templateId, templateSetId: this.script.templateSetId }
      )
    }
    const frame = await this.frame()
    const opts: MatchOptions = {}
    if (roi) opts.roi = this.rectToRef(roi)
    else if (tpl.defaultRoi) opts.roi = tpl.defaultRoi
    if (threshold !== undefined) opts.threshold = threshold

    let res: MatchResult
    try {
      res = await this.vision.matchIn(frame, tpl, opts)
    } catch (e) {
      throw AppError.from(e, 'UNKNOWN')
    }

    const st = this.snapshot.stats
    st.matches += 1
    if (res.found) st.matchHits += 1

    if (this.debugMatches) {
      this.emit({ type: 'matches', runId: this.runId, results: [res] })
    }
    return res
  }

  /** 一帧内批量匹配（模板编辑器的「立即验证」用）。 */
  async detect(
    specs: readonly { templateId: string; roi?: Rect; threshold?: number }[]
  ): Promise<MatchResult[]> {
    const out: MatchResult[] = []
    for (const s of specs) out.push(await this.matchTemplate(s.templateId, s.roi, s.threshold))
    return out
  }

  // ── 设备状态 ────────────────────────────────────────────────────────────

  /** 当前前台包名（1 秒内的结果直接复用）。 */
  async foregroundPackage(force = false): Promise<string | null> {
    if (!force && this.fgCache && Date.now() - this.fgCache.at < FOREGROUND_CACHE_MS) {
      return this.fgCache.pkg
    }
    const pkg = await this.device.foregroundPackage(this.serial)
    this.fgCache = { pkg, at: Date.now() }
    return pkg
  }

  invalidateForeground(): void {
    this.fgCache = null
  }

  /** 脚本里该操作哪个包：步骤上写的优先，否则用脚本头部的 packageName。 */
  resolvePackage(stepPackage: string | undefined, stepId: string): string {
    const pkg = stepPackage ?? this.script.packageName
    if (!pkg) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `步骤「${stepId}」要操作应用，但既没写 packageName，脚本头部也没设 packageName。`,
        { stepId }
      )
    }
    return pkg
  }

  // ── 参数插值 ────────────────────────────────────────────────────────────

  /** 把 `{{paramKey}}` 替换成实际参数值。找不到的键原样保留，方便一眼看出拼错了。 */
  interpolate(text: string): string {
    return text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, key: string) => {
      const v = this.params[key]
      return v === undefined ? whole : String(v)
    })
  }

  // ── 日志与留痕 ──────────────────────────────────────────────────────────

  log(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
    opts?: { stepId?: string; scope?: string; shot?: string }
  ): void {
    this.logger.push({
      level,
      scope: opts?.scope ?? 'engine',
      message,
      stepId: opts?.stepId,
      data,
      shot: opts?.shot
    })
  }

  /**
   * 留一张截图，返回相对 shots 目录的路径（写进 LogEntry.shot）。
   * 复用最近一帧，不额外抓图。任何失败都只降级成一条 warn —— 留痕失败不该让脚本挂掉。
   */
  async shot(label: string): Promise<string | null> {
    try {
      let raw = this.lastRaw
      if (!raw) {
        await this.frame()
        raw = this.lastRaw
      }
      if (!raw) return null

      const jpeg = await this.encodeJpeg(raw, SHOT_WIDTH, SHOT_QUALITY)
      this.shotSeq += 1
      const seq = String(this.shotSeq).padStart(4, '0')
      const file = `${seq}-${sanitizeLabel(label)}.jpg`
      this.report({ type: 'persistShot', runId: this.runId, file, jpeg })
      return `${this.runId}/${file}`
    } catch (e) {
      this.logger.push({
        level: 'warn',
        scope: 'engine',
        message: `留痕截图失败（不影响脚本继续）：${e instanceof Error ? e.message : String(e)}`
      })
      return null
    }
  }

  // ── 预览推流（与匹配链路解耦）──────────────────────────────────────────

  setPreview(enabled: boolean): void {
    this.previewEnabled = enabled
  }

  setPreviewFps(fps: number): void {
    this.previewFps = Math.max(0.2, Math.min(fps, PREVIEW_MAX_FPS))
  }

  setDebugMatches(enabled: boolean): void {
    this.debugMatches = enabled
  }

  private maybePreview(raw: RawFrame): void {
    if (!this.previewEnabled || this.previewBusy || this.disposed) return
    const minGap = 1000 / Math.max(0.2, Math.min(this.previewFps, PREVIEW_MAX_FPS))
    if (Date.now() - this.lastPreviewAt < minGap) return

    this.previewBusy = true
    this.lastPreviewAt = Date.now()
    void this.encodeJpeg(raw, PREVIEW_WIDTH, PREVIEW_JPEG_QUALITY)
      .then((jpeg) => {
        if (this.disposed) return
        this.emit({
          type: 'frame',
          runId: this.runId,
          jpeg,
          width: PREVIEW_WIDTH,
          height: Math.round((raw.height * PREVIEW_WIDTH) / raw.width),
          deviceWidth: raw.width,
          deviceHeight: raw.height,
          capturedAt: raw.capturedAt
        })
      })
      .catch((e: unknown) => {
        // 预览坏了就把它关掉，不要每帧刷一条错误日志。
        this.previewEnabled = false
        this.logger.push({
          level: 'warn',
          scope: 'preview',
          message: `预览编码失败，已自动关闭预览：${e instanceof Error ? e.message : String(e)}`
        })
      })
      .finally(() => {
        this.previewBusy = false
      })
  }

  /** RGBA 裸帧 -> jpeg。sharp 的 raw 输入必须显式给 width/height/channels。 */
  private async encodeJpeg(raw: RawFrame, width: number, quality: number): Promise<ArrayBuffer> {
    const buf = Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength)
    const out = await sharp(buf, {
      raw: { width: raw.width, height: raw.height, channels: 4 }
    })
      .resize({ width: Math.min(width, raw.width) })
      .jpeg({ quality })
      .toBuffer()
    // 必须复制成独立 ArrayBuffer：Buffer 可能是内存池的一个切片，
    // 直接传 out.buffer 会把整块池子（含别人的数据）带过端口。
    const ab = new ArrayBuffer(out.byteLength)
    new Uint8Array(ab).set(out)
    return ab
  }

  // ── 消息与节奏 ──────────────────────────────────────────────────────────

  emit(m: WorkerToRenderer): void {
    if (this.disposed) return
    try {
      this.emitFn(m)
    } catch {
      // 面板关了/端口断了，不该影响脚本继续跑。
    }
  }

  report(m: WorkerToMain): void {
    try {
      this.reportFn(m)
    } catch (e) {
      console.error(`[run ${this.runId}] 向主进程回报失败：${String(e)}`)
    }
  }

  /** 把当前 snapshot 同时推给主进程和面板。 */
  publishStatus(): void {
    this.report({ type: 'status', snapshot: this.snapshotCopy() })
    this.emit({ type: 'status', snapshot: this.snapshotCopy() })
  }

  /** 快照要过结构化克隆，给一份浅拷贝（stats 单独拷）避免后续改动影响已发出的消息。 */
  snapshotCopy(): RunSnapshot {
    return { ...this.snapshot, stats: { ...this.snapshot.stats } }
  }

  /** 可被 stop 立刻打断的睡眠。所有等待都必须走它，否则停不下来。 */
  async sleep(ms: number): Promise<void> {
    if (ms <= 0) return
    const end = Date.now() + ms
    while (!this.aborted) {
      const left = end - Date.now()
      if (left <= 0) return
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(left, 100)))
    }
  }

  /** 暂停时在这里挂住；stop 时立刻返回。 */
  async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.aborted) {
      await new Promise<void>((resolve) => setTimeout(resolve, 120))
    }
  }

  dispose(): void {
    this.disposed = true
    this.logger.dispose()
    this.prepared = null
    this.lastRaw = null
  }
}

function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '')
  return (cleaned || 'shot').slice(0, 40)
}
