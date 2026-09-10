/**
 * 输入注入：点击、滑动、长按、按键、文本、点击后立即截图。
 *
 * ★ 入参一律是**设备真实像素**。参考分辨率 -> 设备像素的换算由调用方
 *   （模块 d 脚本引擎 / 模块 e 的 IPC handler）用 shared 的 refToDevice() 完成，
 *   本模块不碰坐标系，免得两边都换算一次。
 *
 * ★ 三条实测得来的硬约束：
 *
 * 1) 单次 adb 往返 17~20ms，其中 ~14ms 是进程启动。**能合并进一次 shell 就合并**
 *    （5 次点击分开发 103ms，合并 34ms）。
 *
 * 2) **长按绝不用 `input swipe`** —— 它全程阻塞，duration=500 实测占用 532ms。
 *    必须把 `motionevent DOWN / sleep / motionevent UP` 发进**同一次** shell；
 *    拆成两次 adb 调用的话按下状态不可靠（中间 transport 可能被复用）。
 *
 * 3) **`input text` 对中文是静默丢弃**（退出码 0、无 stderr、耗时等于 0 事件基线）。
 *    所有文本一律走 ADBKeyboard 的 base64 广播；连 ASCII 也走这条，
 *    这样能省掉一整套 shell 转义（空格 / & / < / | / 引号都要转义，很脏）。
 *    `cmd clipboard` 在这台 Android 12 上不存在，别想走剪贴板。
 *
 * 纯 Node，不 import electron。
 */

import {
  ADB_KEYBOARD_BROADCAST,
  ADB_KEYBOARD_IME,
  ADB_KEYBOARD_PACKAGE,
  ADB_TIMEOUT_MS,
  CAPTURE_TIMEOUT_MS
} from '@shared/constants'
import { AppError } from '@shared/errors'
import type { AndroidKey } from '@shared/script'
import type { RawFrame } from '@shared/vision'
import { installApk, isPackageInstalled } from './apps'
import { markCaptured, parseScreencap, waitCaptureSlot } from './capture'
import { execOut, shell, shellRaw } from './exec'
import { enqueue } from './queue'

// ── 坐标 / 数值校验 ────────────────────────────────────────────────────────

function px(v: number, what: string): number {
  if (!Number.isFinite(v)) {
    throw new AppError('INVALID_ARGUMENT', `${what} 不是合法数值：${v}`)
  }
  const n = Math.round(v)
  if (n < 0) {
    throw new AppError('INVALID_ARGUMENT', `${what} 不能为负数：${n}（入参必须是设备真实像素）`)
  }
  return n
}

/** 秒数字符串，给设备端 sleep 用（toybox sleep 支持小数）。 */
function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(2)
}

// ── 点击 / 滑动 / 长按 ─────────────────────────────────────────────────────

export async function tap(serial: string, x: number, y: number): Promise<void> {
  const cx = px(x, 'tap.x')
  const cy = px(y, 'tap.y')
  await enqueue(serial, () => shell(serial, `input tap ${cx} ${cy}`))
}

/**
 * 连点多处。合并成一条 shell，省下每次 ~14ms 的进程启动。
 * @param gapMs 每两次点击之间的设备端等待，默认 0（不等）。
 */
export async function tapMany(serial: string, pts: [number, number][], gapMs = 0): Promise<void> {
  if (pts.length === 0) return
  const cmds = pts.map(([x, y], i) => {
    const one = `input tap ${px(x, `tapMany[${i}].x`)} ${px(y, `tapMany[${i}].y`)}`
    return gapMs > 0 && i < pts.length - 1 ? `${one}; sleep ${seconds(gapMs)}` : one
  })

  // 命令行别拼太长，分批发（同时也控制单次 shell 的阻塞时长）。
  const CHUNK = 32
  await enqueue(serial, async () => {
    for (let i = 0; i < cmds.length; i += CHUNK) {
      const batch = cmds.slice(i, i + CHUNK)
      const budget = ADB_TIMEOUT_MS + batch.length * (gapMs + 200)
      await shell(serial, batch.join('; '), budget)
    }
  })
}

export async function swipe(
  serial: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs = 300
): Promise<void> {
  const ax = px(x1, 'swipe.x1')
  const ay = px(y1, 'swipe.y1')
  const bx = px(x2, 'swipe.x2')
  const by = px(y2, 'swipe.y2')
  const dur = Math.max(1, Math.round(durationMs))
  // input swipe 会在设备端阻塞整个 duration，超时预算要加上去。
  await enqueue(serial, () =>
    shell(serial, `input swipe ${ax} ${ay} ${bx} ${by} ${dur}`, ADB_TIMEOUT_MS + dur)
  )
}

/**
 * 长按。**不用 input swipe**（见文件头注释），而是 DOWN / sleep / UP 三段发进同一次 shell。
 */
export async function longPress(
  serial: string,
  x: number,
  y: number,
  durationMs: number
): Promise<void> {
  const cx = px(x, 'longPress.x')
  const cy = px(y, 'longPress.y')
  const dur = Math.max(50, Math.round(durationMs))
  const cmd =
    `input motionevent DOWN ${cx} ${cy}; ` +
    `sleep ${seconds(dur)}; ` +
    `input motionevent UP ${cx} ${cy}`
  await enqueue(serial, () => shell(serial, cmd, ADB_TIMEOUT_MS + dur))
}

// ── 按键 ──────────────────────────────────────────────────────────────────

const KEYCODES: Record<AndroidKey, string> = {
  BACK: 'KEYCODE_BACK',
  HOME: 'KEYCODE_HOME',
  ENTER: 'KEYCODE_ENTER',
  MENU: 'KEYCODE_MENU',
  APP_SWITCH: 'KEYCODE_APP_SWITCH',
  DEL: 'KEYCODE_DEL',
  ESCAPE: 'KEYCODE_ESCAPE',
  VOLUME_UP: 'KEYCODE_VOLUME_UP',
  VOLUME_DOWN: 'KEYCODE_VOLUME_DOWN'
}

export async function key(serial: string, k: AndroidKey): Promise<void> {
  const code = KEYCODES[k]
  if (!code) {
    throw new AppError('INVALID_ARGUMENT', `不支持的按键：${k}`, { key: k })
  }
  await enqueue(serial, () => shell(serial, `input keyevent ${code}`))
}

// ── 文本输入（ADBKeyboard 广播）─────────────────────────────────────────────

/** 已确认「ADBKeyboard 已装好且已被设为当前输入法」的设备，避免每次输入都探测。 */
const imeReady = new Set<string>()

/** 设备断开时清掉。 */
export function clearImeCache(serial: string): void {
  imeReady.delete(serial)
}

async function currentIme(serial: string): Promise<string> {
  const r = await shellRaw(serial, 'settings get secure default_input_method')
  return r.text.trim()
}

async function ensureImeReady(serial: string): Promise<void> {
  if (imeReady.has(serial)) return

  if (!(await isPackageInstalled(serial, ADB_KEYBOARD_PACKAGE))) {
    throw new AppError(
      'ADB_COMMAND_FAILED',
      '设备上没有安装 ADBKeyboard 中文输入法，无法输入文本。请在面板里点击「安装中文输入法」后重试。',
      { serial, packageName: ADB_KEYBOARD_PACKAGE }
    )
  }

  let cur = await currentIme(serial)
  if (!cur.startsWith(ADB_KEYBOARD_PACKAGE)) {
    await shell(serial, `ime enable ${ADB_KEYBOARD_IME}; ime set ${ADB_KEYBOARD_IME}`)
    cur = await currentIme(serial)
  }
  if (!cur.startsWith(ADB_KEYBOARD_PACKAGE)) {
    throw new AppError(
      'ADB_COMMAND_FAILED',
      `切换到 ADBKeyboard 输入法失败，当前输入法是「${cur || '未知'}」。请在面板里重新执行「安装中文输入法」。`,
      { serial, current: cur }
    )
  }
  imeReady.add(serial)
}

/**
 * 输入一段文本（中英文都走这条路）。
 * 文本先 base64，再用 `am broadcast --es msg <b64>` 交给 ADBKeyboard 注入 ——
 * base64 字符集是 A-Za-z0-9+/=，在 shell 里没有一个是特殊字符，天然免转义。
 */
export async function typeText(serial: string, text: string): Promise<void> {
  if (!text) return
  await enqueue(serial, async () => {
    await ensureImeReady(serial)
    const b64 = Buffer.from(text, 'utf8').toString('base64')
    const out = await shell(
      serial,
      `am broadcast -a ${ADB_KEYBOARD_BROADCAST} --es msg '${b64}'`,
      ADB_TIMEOUT_MS
    )
    if (!/Broadcast completed/i.test(out)) {
      throw new AppError(
        'ADB_COMMAND_FAILED',
        `文本输入广播没有被接收：${out.trim() || '无输出'}。请确认 ADBKeyboard 已是当前输入法。`,
        { serial, output: out }
      )
    }
  })
}

/**
 * 安装并启用 ADBKeyboard。面板的「安装中文输入法」按钮走这里。
 * @returns 最终 ADBKeyboard 是否已成为当前输入法。安装环节失败会直接抛错（带中文原因）。
 */
export async function setupChineseIme(serial: string, apkPath: string): Promise<boolean> {
  return enqueue(serial, async () => {
    imeReady.delete(serial)
    if (!(await isPackageInstalled(serial, ADB_KEYBOARD_PACKAGE))) {
      await installApk(serial, apkPath)
    }
    await shell(serial, `ime enable ${ADB_KEYBOARD_IME}; ime set ${ADB_KEYBOARD_IME}`)
    const cur = await currentIme(serial)
    const ok = cur.startsWith(ADB_KEYBOARD_PACKAGE)
    if (ok) imeReady.add(serial)
    return ok
  })
}

/** 还原成系统默认输入法（跑完脚本或调试完手动点一下）。 */
export async function resetIme(serial: string): Promise<void> {
  imeReady.delete(serial)
  await enqueue(serial, () => shell(serial, 'ime reset'))
}

// ── 点击 + 截图融合 ───────────────────────────────────────────────────────

/**
 * 点一下、等一会儿、抓一帧，**全部塞进一次 exec-out 往返**。
 * 实测 297ms —— 相对单纯截图的 280ms，点击几乎是免费的（省下一次 ~17ms 往返）。
 *
 * ★ `input tap ... >/dev/null 2>&1` 这段重定向是**必需的，不是防御性的**：
 *   实测 exec-out 会把远端 stderr 并进 stdout，而 `input` 失败时会吐一大段 Java 异常
 *   （例如前台是受保护应用时的 SecurityException: Injecting to another application
 *   requires INJECT_EVENTS permission）。不重定向的话那段文本会插在帧头前面，
 *   整帧作废且报错信息面目全非。
 *
 * ★ 代价：exec-out 不透传远端退出码，所以这条路**无法感知点击是否被拒**。
 *   脚本引擎本来就要在点击后用模板匹配确认结果，让画面来当裁判即可；
 *   需要「点击本身必须成功」的语义时请改用 tap()（走 shell，退出码会抛错）。
 */
export async function tapAndCapture(
  serial: string,
  x: number,
  y: number,
  waitMs = 300
): Promise<RawFrame> {
  const cx = px(x, 'tapAndCapture.x')
  const cy = px(y, 'tapAndCapture.y')
  const wait = Math.max(0, Math.round(waitMs))
  return enqueue(serial, async () => {
    await waitCaptureSlot(serial)
    const cmd = `input tap ${cx} ${cy} >/dev/null 2>&1; sleep ${seconds(wait)}; screencap`
    const buf = await execOut(serial, cmd, CAPTURE_TIMEOUT_MS + wait)
    markCaptured(serial)
    if (buf.byteLength === 0) {
      throw new AppError(
        'CAPTURE_BAD_FRAME',
        `点击后截图返回了 0 字节（${serial}），设备可能已离线。`,
        { serial, x: cx, y: cy }
      )
    }
    return parseScreencap(buf)
  })
}
