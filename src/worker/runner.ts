/**
 * utilityProcess 入口 —— 每个正在跑脚本的模拟器实例一个。
 *
 * 它被 electron.vite.config.ts 作为 main 段的第二个 rollup 入口打成 out/main/runner.js，
 * 由 src/main/orchestrator 用 utilityProcess.fork(join(__dirname,'runner.js')) 拉起。
 *
 * 这里是纯 Node 环境：有 sharp / opencv-js / child_process，但**没有 DOM、没有 WebCodecs**，
 * 也**不能碰 electron 的 app / BrowserWindow**，与主进程的唯一通道是 process.parentPort。
 *
 * 生命周期：
 *   fork → 预热 opencv → ready → attach(带 MessagePort) → start → …(status/logs/frame)… → finished → shutdown
 */

import sharp from 'sharp'
// 只导入类型：`import type` 在编译期就被擦除，不会在 utilityProcess 里 require('electron')。
import type { MessagePortMain } from 'electron'
import { AppError, serializeError } from '@shared/errors'
import type { DetectSpec, PreparedTemplate } from '@shared/vision'
import type { MainToWorker, RendererToWorker, WorkerToMain, WorkerToRenderer } from '@shared/worker'
import type { WorkerAttachPayload } from '@shared/worker'
import { Engine } from './engine'
import { RunContext } from './context'
import type { DeviceIo, VisionIo } from './context'

// ═══════════════════════════════════════════════════════════════════════════
// ★ 模块 b（adb）/ 模块 c（视觉）适配层
//
// 这是**全工程唯一**与 adb 层和视觉层耦合的地方。引擎、动作、条件都只认识
// DeviceIo / VisionIo 两个接口（见 context.ts），所以将来换实现
// （transport 换 adbkit、预览换 scrcpy）只需要改这一段，引擎一行不用动。
//
// 两个模块都不 import electron，所以在 utilityProcess 里可以直接用。
// ═══════════════════════════════════════════════════════════════════════════
import {
  captureRaw,
  forceStop,
  foregroundPackage,
  key as adbKey,
  launch,
  longPress,
  swipe,
  tap,
  typeText
} from '@main/adb/index'
import { getCv, loadPrepared, matchIn, prepareFrame, setTemplatesDir } from '@vision/index'

const deviceIo: DeviceIo = {
  // captureRaw 内部已按设备做了最小间隔节流（4.3 帧/秒是模拟器硬上限）。
  // RunContext 那边的等待是按同一个 lastCaptureAt 算的，两者叠加不会翻倍，
  // 只是把抖动错峰提前到了排队之前。
  capture: (serial) => captureRaw(serial),
  tap: (serial, x, y) => tap(serial, x, y),
  swipe: (serial, x1, y1, x2, y2, durationMs) => swipe(serial, x1, y1, x2, y2, durationMs),
  longPress: (serial, x, y, durationMs) => longPress(serial, x, y, durationMs),
  // 中文走 ADBKeyboard 的 base64 广播，模块 b 已经封好了。
  inputText: (serial, text) => typeText(serial, text),
  keyEvent: (serial, k) => adbKey(serial, k),
  launchApp: (serial, pkg, cold) => launch(serial, pkg, cold),
  stopApp: (serial, pkg) => forceStop(serial, pkg),
  foregroundPackage: (serial) => foregroundPackage(serial)
}

const visionIo: VisionIo = {
  // 端口用 refWidth/refHeight，模块 c 用 refW/refH，命名差异在这里抹平。
  prepareFrame: (raw, opts) =>
    prepareFrame(raw, { refW: opts.refWidth, refH: opts.refHeight, shrink: opts.shrink }),
  matchIn: (frame, template, opts) => matchIn(frame, template, opts)
}

/** 载入脚本依赖的模板集，编译成可直接匹配的 PreparedTemplate。 */
async function loadTemplates(payload: WorkerAttachPayload): Promise<Map<string, PreparedTemplate>> {
  const setId = payload.script.templateSetId
  if (!setId) return new Map()

  // 模板库是模块 c 的模块级单例，用之前必须先告诉它模板根目录在哪。
  setTemplatesDir(payload.paths.templatesDir)
  const map = await loadPrepared(setId, {
    refW: payload.settings.refWidth,
    shrink: payload.settings.shrink
  })

  if (map.size === 0) {
    throw new AppError(
      'TEMPLATE_NOT_FOUND',
      `模板集「${setId}」里一张可用模板都没有（编译失败的模板会被跳过，详见 stderr）。` +
        '请先在模板工具里截图保存模板；注意纯色/渐变这类低方差模板会被拒绝。',
      { templateSetId: setId, templatesDir: payload.paths.templatesDir }
    )
  }
  return map
}

// ═══════════════════════════════════════════════════════════════════════════
// 进程状态
// ═══════════════════════════════════════════════════════════════════════════

// 多个 utilityProcess 同时跑时，libvips 的线程池会互相抢核；每个进程只给一条线程。
sharp.concurrency(1)
sharp.cache(false)

const parentPort = process.parentPort
const t0 = Date.now()

let ctx: RunContext | null = null
let engine: Engine | null = null
let rendererPort: MessagePortMain | null = null
let attaching = false
/** finished 之后的兜底自杀定时器：主进程若没来收尸，自己退，别占着 100MB WASM 堆。 */
let selfDestruct: NodeJS.Timeout | null = null

function send(msg: WorkerToMain): void {
  try {
    parentPort.postMessage(msg)
  } catch (e) {
    console.error(`[runner] 向主进程发送消息失败：${String(e)}`)
  }
}

function emitToRenderer(msg: WorkerToRenderer): void {
  // 面板没连上（或已关闭）时静默丢弃：日志照样会通过 persistLogs 落盘。
  rendererPort?.postMessage(msg)
}

function fail(e: unknown, fallbackMessage: string): void {
  const err = AppError.from(e, 'UNKNOWN')
  console.error(`[runner] ${fallbackMessage}：${err.message}`)
  send({ type: 'error', error: serializeError(err) })
}

// ═══════════════════════════════════════════════════════════════════════════
// 消息处理
// ═══════════════════════════════════════════════════════════════════════════

async function onAttach(
  payload: WorkerAttachPayload,
  port?: MessagePortMain
): Promise<void> {
  if (ctx) throw new AppError('INVALID_ARGUMENT', '该执行器已经绑定过一次执行，不能重复 attach。')
  if (attaching) return
  attaching = true

  try {
    if (port) {
      rendererPort = port
      // ★ 必须 start()，否则消息一直排队，面板既收不到日志也收不到预览。
      port.start()
      port.on('message', (e) => {
        const m = e.data as RendererToWorker
        try {
          handleRendererMessage(m)
        } catch (err) {
          console.error(`[runner] 处理面板消息失败：${String(err)}`)
        }
      })
      port.on('close', () => {
        rendererPort = null
      })
    }

    const templates = await loadTemplates(payload)
    ctx = new RunContext({
      payload,
      templates,
      device: deviceIo,
      vision: visionIo,
      emit: emitToRenderer,
      report: send
    })
    engine = new Engine(ctx, emitToRenderer, send)

    ctx.log(
      'info',
      `执行器就绪：模板 ${templates.size} 张，参考分辨率 ${payload.settings.refWidth}x${payload.settings.refHeight}，降采样 1/${payload.settings.shrink}。`,
      undefined,
      { scope: 'runner' }
    )
    send({ type: 'attached', runId: payload.runId })
  } finally {
    attaching = false
  }
}

function handleRendererMessage(m: RendererToWorker): void {
  if (!ctx) return
  switch (m.type) {
    case 'preview':
      ctx.setPreview(m.enabled)
      break
    case 'previewFps':
      ctx.setPreviewFps(m.fps)
      break
    case 'debugMatches':
      ctx.setDebugMatches(m.enabled)
      break
    default:
      break
  }
}

function startRun(): void {
  if (!engine || !ctx) {
    fail(new AppError('RUN_NOT_FOUND', '还没有 attach 就收到了 start 指令。'), '启动失败')
    return
  }
  void engine
    .run()
    .catch((e: unknown) => fail(e, '脚本执行意外中断'))
    .finally(() => {
      ctx?.logger.flush()
      // 给消息一点排出时间，然后等主进程来 shutdown；等不到就自己退。
      if (!selfDestruct) {
        selfDestruct = setTimeout(() => shutdown(0), 15_000)
        selfDestruct.unref?.()
      }
    })
}

async function detectOnce(requestId: string, specs: readonly DetectSpec[]): Promise<void> {
  if (!ctx) throw new AppError('RUN_NOT_FOUND', '还没有 attach，无法做检测。')
  // 「立即验证」要看当前画面，不能拿缓存帧糊弄。
  ctx.invalidateFrame()
  const results = await ctx.detect(specs)
  send({ type: 'detectResult', requestId, results })
}

function shutdown(code: number): void {
  try {
    engine?.stop()
    ctx?.dispose()
    rendererPort?.close()
  } catch {
    // 收尾阶段的异常没有意义，别盖住真正的退出原因。
  }
  // 留一点时间把最后一批消息推出去。
  setTimeout(() => process.exit(code), 120)
}

parentPort.on('message', (e) => {
  const msg = e.data as MainToWorker
  try {
    switch (msg.type) {
      case 'attach':
        void onAttach(msg.payload, e.ports[0]).catch((err: unknown) => fail(err, '绑定执行失败'))
        break
      case 'start':
        startRun()
        break
      case 'pause':
        engine?.pause()
        break
      case 'resume':
        engine?.resume()
        break
      case 'stop':
        engine?.stop()
        break
      case 'shutdown':
        shutdown(0)
        break
      case 'preview':
        ctx?.setPreview(msg.enabled)
        break
      case 'detectOnce':
        void detectOnce(msg.requestId, msg.specs).catch((err: unknown) => fail(err, '单次检测失败'))
        break
      default:
        break
    }
  } catch (err) {
    fail(err, '处理主进程指令失败')
  }
})

// 绝不静默死掉：任何未捕获异常都要让主进程知道，否则面板只会看到一个永远 running 的执行。
process.on('uncaughtException', (e) => {
  fail(e, '执行器发生未捕获异常')
  shutdown(1)
})
process.on('unhandledRejection', (e) => {
  fail(e, '执行器发生未处理的 Promise 拒绝')
  shutdown(1)
})

// 预热 opencv（约 1 秒的 WASM 初始化），完成后才敢说 ready。
void getCv().then(
  () => send({ type: 'ready', pid: process.pid, initMs: Date.now() - t0 }),
  (e: unknown) => {
    fail(e, '视觉引擎初始化失败')
    shutdown(1)
  }
)
