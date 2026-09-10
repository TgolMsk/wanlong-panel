/**
 * OpenCV(WASM) 与 sharp 的运行时接入层。
 *
 * 本文件是整个 vision 模块唯一直接碰 `@techstark/opencv-js` 和 `sharp` 的地方，
 * 其余文件一律通过这里拿 cv 句柄与 sharp 实例，好处有二：
 *   1. sharp 的全局配置（并发/缓存）只在一个地方设置，不会被某个文件漏掉；
 *   2. 将来若要换 OpenCV 发行版，改动被收敛在这一个文件里。
 *
 * ⚠️ 纯 Node 模块：不得 import electron。主进程与 utilityProcess 都要 import 它。
 */

import sharpLib from 'sharp'
import { AppError } from '@shared/errors'

// ── sharp 全局配置（模块加载即生效）────────────────────────────────────────
//
// ★ 为什么必须在这里设：本项目会同时跑多个 utilityProcess（一个实例一个进程），
//   libvips 默认会按 CPU 核数开线程池，N 个进程各开 10 条线程会互相抢核，
//   截图预处理的实测耗时会剧烈抖动。每进程锁死 1 条线程后总吞吐反而更稳。
//   cache(false) 是因为我们每帧的图都是一次性的，libvips 的算子缓存只会白占内存。
sharpLib.concurrency(1)
sharpLib.cache(false)

/** 全模块统一使用的 sharp（已配置好并发与缓存），不要在别处再 `import 'sharp'`。 */
export const sharp = sharpLib

// ── OpenCV 就绪 ───────────────────────────────────────────────────────────

/**
 * opencv.js 的类型定义只覆盖了一小部分 API，且 Mat 的 data 视图、minMaxLoc 的返回值
 * 在不同发行版之间签名不一致。这里统一按 any 用，靠本文件的封装 + 上层的窄类型来保证安全。
 */
export type Cv = any

/** 载入 WASM 的兜底超时。老写法（onRuntimeInitialized）一旦回调不来就是永久挂起，必须有上限。 */
const CV_INIT_TIMEOUT_MS = 60_000

let cvSingleton: Cv | null = null
let cvPending: Promise<Cv> | null = null

/**
 * 取得已就绪的 OpenCV 句柄（单例，重复调用零成本）。
 *
 * ★ @techstark/opencv-js v5 的 default export 是一个 **Promise**，不是老版那个需要
 *   挂 `onRuntimeInitialized` 回调的 Module 对象；而 CJS 的 `require()` 在 WASM 编译完成前
 *   拿到的是一个永远为空的对象。网上绝大多数教程写的
 *       `const cv = require('opencv.js'); cv.onRuntimeInitialized = () => {...}`
 *   在这个版本上会**永久挂起**（回调永远不触发）。
 *   所以下面做三态兼容：Promise / 已就绪对象 / 老式回调，并给回调路径加超时。
 *
 * 实测就绪耗时：Node 151ms、Electron 主进程 231ms、utilityProcess 160ms。
 */
export async function getCv(): Promise<Cv> {
  if (cvSingleton) return cvSingleton
  if (cvPending) return cvPending

  cvPending = initCv()
  try {
    cvSingleton = await cvPending
    return cvSingleton
  } finally {
    // 失败时清空，允许调用方重试（例如用户修好了 asarUnpack 配置后再试一次）。
    cvPending = null
  }
}

/** OpenCV 是否已经就绪（同步查询，用于面板的健康检查，不会触发加载）。 */
export function isCvReady(): boolean {
  return cvSingleton !== null
}

async function initCv(): Promise<Cv> {
  let mod: unknown
  try {
    // 动态 import：主进程如果只是开个窗口、没做识别，就不必付 WASM 的初始化成本。
    mod = await import('@techstark/opencv-js')
  } catch (e) {
    throw new AppError(
      'CV_INIT_FAILED',
      'OpenCV(WASM) 模块加载失败。打包后若报此错，多半是 asarUnpack 没包含 @techstark/opencv-js。',
      { cause: e instanceof Error ? e.message : String(e) }
    )
  }

  const entry = (mod as { default?: unknown }).default ?? mod
  let cv: Cv

  if (entry instanceof Promise) {
    // v5 的正常路径。
    cv = await entry
  } else if (entry && typeof (entry as Cv).Mat === 'function') {
    // 已经就绪的对象（例如被别的模块先初始化过）。
    cv = entry
  } else if (entry && typeof entry === 'object') {
    // 老式 emscripten Module，挂回调等它自己 ready，并加超时兜底。
    cv = await new Promise<Cv>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new AppError(
            'CV_INIT_FAILED',
            `OpenCV(WASM) 初始化超过 ${CV_INIT_TIMEOUT_MS / 1000} 秒仍未就绪（onRuntimeInitialized 未触发）。`
          )
        )
      }, CV_INIT_TIMEOUT_MS)
      ;(entry as Cv).onRuntimeInitialized = (): void => {
        clearTimeout(timer)
        resolve(entry as Cv)
      }
    })
  } else {
    throw new AppError('CV_INIT_FAILED', 'OpenCV(WASM) 导出形态无法识别，无法初始化。', {
      typeofEntry: typeof entry
    })
  }

  if (!cv || typeof cv.Mat !== 'function' || typeof cv.matchTemplate !== 'function') {
    throw new AppError('CV_INIT_FAILED', 'OpenCV(WASM) 已加载但缺少 Mat / matchTemplate 接口。')
  }
  // 冗余但廉价的自检：算法常量必须存在，否则后面 matchTemplate 会传 undefined 而静默出错。
  if (typeof cv.TM_CCOEFF_NORMED !== 'number') {
    throw new AppError('CV_INIT_FAILED', 'OpenCV(WASM) 缺少 TM_CCOEFF_NORMED 常量。')
  }
  return cv
}

// ── Mat 生命周期 ──────────────────────────────────────────────────────────

interface Deletable {
  delete(): void
}

/**
 * ★ 强制释放 Mat 的作用域封装。**所有创建 Mat 的代码都必须走它。**
 *
 * 为什么这么严：opencv.js 的 Mat 活在 WASM 线性内存里，GC 管不着，漏一个就是永久泄漏。
 * 全屏 2560x1440 在 shrink=2 下做一次 matchTemplate，结果 Mat 是 float32 的
 * (1280-w+1)×(720-h+1)，约 3.5MB；不降采样时是 12.3MB。脚本每秒跑几次匹配，
 * 漏释放几分钟就能把内存吃光。
 *
 * 用法：
 *   await withMats(async (keep) => {
 *     const src = keep(new cv.Mat(...))
 *     ...
 *   })
 */
export async function withMats<T>(
  fn: (keep: <M extends Deletable>(mat: M) => M) => Promise<T> | T
): Promise<T> {
  const owned: Deletable[] = []
  const keep = <M extends Deletable>(mat: M): M => {
    owned.push(mat)
    return mat
  }
  try {
    return await fn(keep)
  } finally {
    // 逆序释放（与 C++ 栈语义一致），单个失败不影响其它释放。
    for (let i = owned.length - 1; i >= 0; i--) {
      try {
        owned[i].delete()
      } catch {
        // Mat 可能已被提前 delete 或已失效，这里不需要报错。
      }
    }
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────────

/**
 * Uint8Array -> Buffer，零拷贝（共享底层 ArrayBuffer）。
 * sharp 只吃 Buffer，而管线里到处是 Uint8Array；截图是 14MB 级别的，能不拷就不拷。
 */
export function asBuffer(u8: Uint8Array): Buffer {
  if (Buffer.isBuffer(u8)) return u8
  return Buffer.from(u8.buffer as ArrayBuffer, u8.byteOffset, u8.byteLength)
}

/** 降采样倍率必须是 1~8 的整数（与 appSettingsSchema 的约束保持一致）。 */
export function clampShrink(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.min(8, Math.max(1, Math.floor(v)))
}
