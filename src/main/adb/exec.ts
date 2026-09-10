/**
 * adb 子进程的**唯一**入口。整个工程里除了本文件，任何地方都不许直接 spawn adb。
 *
 * ★ 三条实测得来的硬约束，改动前先读完：
 *
 * 1) 必须 `child_process.spawn` + `Buffer.concat`，**禁止 exec / execFile**。
 *    exec 会把 stdout 按 utf8 解码：实测 14,745,616 字节的裸截图被膨胀成 26,421,018 字节，
 *    且没有任何报错，帧数据彻底损坏。类型上已经用 `AdbResult.stdout: Uint8Array` 封死，
 *    本文件里也不存在任何返回 string 的 stdout 路径（要文本请显式 decodeText）。
 *
 * 2) adb 的退出码语义**不统一**，三处要单独处理：
 *    a. `adb connect` 连一个死端口时退出码仍为 0，只在文本里写 `failed to connect to ...`
 *       —— 判成败只能匹配 `/connected to/`（见 connection.ts）。
 *    b. `adb exec-out` **不透传远端退出码，还会把远端 stderr 并进 stdout**。
 *       实测 `exec-out "echo O; echo E 1>&2; exit 7"` -> 本地 exit 0、
 *       本地 stdout = "O\nE\n"、本地 stderr 为空；换成 `shell` 才是 exit 7 且两股流分开。
 *       两个后果：想判断远端命令成败只能用 `shell`；exec-out 里跟截图同管线的命令
 *       **必须把自己的输出全部重定向掉**（见 input.ts 的 tapAndCapture），
 *       否则一行报错文本就会插在帧数据前面，把整帧毁掉。
 *    c. `-s <不存在的 serial>` 时退出码 1，stderr 是 `device 'xxx' not found`。
 *
 * 3) 超时一律 SIGKILL。adb 卡在 screencap 上时 SIGTERM 经常收不掉。
 *
 * 本文件是纯 Node，不 import electron —— utilityProcess（模块 d）会直接 import 它。
 */

import { spawn } from 'node:child_process'
import { ADB_TIMEOUT_MS, DEFAULT_ADB_PATH } from '@shared/constants'
import type { AdbResult } from '@shared/domain'
import { AppError } from '@shared/errors'

// ── adb 可执行文件路径 ─────────────────────────────────────────────────────

let adbPath: string = DEFAULT_ADB_PATH

/** 由主进程在读取设置后调用一次；worker 侧由 attach 消息里的 paths.adbPath 调用。 */
export function setAdbPath(p: string): void {
  const next = (p ?? '').trim()
  if (!next) {
    throw new AppError('INVALID_ARGUMENT', 'adb 路径不能为空。')
  }
  adbPath = next
}

export function getAdbPath(): string {
  return adbPath
}

// ── 底层执行 ──────────────────────────────────────────────────────────────

/**
 * 执行一次 adb，**永远返回 Buffer**。这是整个 adb 模块的地基。
 *
 * 不做退出码判断（不同子命令语义不一样，交给调用方），只负责：
 *   · 收全 stdout / stderr
 *   · 超时 SIGKILL 并抛 ADB_TIMEOUT
 *   · adb 本身找不到 / 起不来时抛 ADB_NOT_FOUND
 *
 * ⚠️ 除了 connect / disconnect / devices / start-server 这类不针对单台设备的子命令，
 *    其余一律走 adb()，因为不带 `-s` 会因「同一台模拟器有两个 transport」而报
 *    `more than one device`。
 */
export function run(args: string[], timeoutMs: number = ADB_TIMEOUT_MS): Promise<AdbResult> {
  return new Promise<AdbResult>((resolve, reject) => {
    const startedAt = Date.now()
    const bin = adbPath

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      reject(
        new AppError('ADB_NOT_FOUND', `无法启动 adb（${bin}）：${(e as Error).message}`, {
          adbPath: bin,
          args
        })
      )
      return
    }

    const outChunks: Buffer[] = []
    let outLen = 0
    const errChunks: Buffer[] = []
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      // ★ SIGTERM 收不掉卡死的 screencap，直接 KILL。
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout?.on('data', (c: Buffer) => {
      outChunks.push(c)
      outLen += c.length
    })
    child.stderr?.on('data', (c: Buffer) => {
      errChunks.push(c)
    })

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        reject(
          new AppError(
            'ADB_NOT_FOUND',
            `找不到 adb 可执行文件：${bin}。请在「设置」里指定 MuMu 自带的 adb（系统 PATH 里没有 adb）。`,
            { adbPath: bin }
          )
        )
      } else {
        reject(
          new AppError('ADB_COMMAND_FAILED', `adb 进程启动失败：${err.message}`, {
            adbPath: bin,
            args
          })
        )
      }
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const elapsedMs = Date.now() - startedAt

      if (timedOut) {
        reject(
          new AppError(
            'ADB_TIMEOUT',
            `adb 命令超时（已超过 ${timeoutMs}ms，进程被强制结束）：adb ${args.join(' ')}`,
            { args, timeoutMs, elapsedMs }
          )
        )
        return
      }

      resolve({
        stdout: outChunks.length === 1 ? outChunks[0]! : Buffer.concat(outChunks, outLen),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        code: code ?? (signal ? -1 : 0),
        elapsedMs
      })
    })
  })
}

/**
 * 带 `-s <serial>` 的便捷封装。**所有针对具体设备的调用都必须走它**。
 */
export async function adb(
  serial: string,
  args: string[],
  timeoutMs: number = ADB_TIMEOUT_MS
): Promise<AdbResult> {
  if (!serial || !serial.trim()) {
    throw new AppError(
      'INVALID_ARGUMENT',
      '缺少设备 serial：adb 调用必须带 -s，否则会报 more than one device。',
      {
        args
      }
    )
  }
  return run(['-s', serial, ...args], timeoutMs)
}

// ── 文本 / 二进制两条路 ────────────────────────────────────────────────────

/** Buffer -> utf8 文本。顺手把 \r\n 归一成 \n（adb shell 偶尔会带 \r）。 */
export function decodeText(u8: Uint8Array): string {
  const buf = Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)
  return buf.toString('utf8').replace(/\r\n/g, '\n')
}

/** shell 的原始结果，**不抛错**。用于 pidof / pm path 这类「非 0 也是正常答案」的探测。 */
export interface ShellOutcome {
  code: number
  text: string
  stderr: string
  elapsedMs: number
}

export async function shellRaw(
  serial: string,
  cmd: string,
  timeoutMs: number = ADB_TIMEOUT_MS
): Promise<ShellOutcome> {
  const res = await adb(serial, ['shell', cmd], timeoutMs)
  return {
    code: res.code,
    text: decodeText(res.stdout),
    stderr: res.stderr.replace(/\r\n/g, '\n'),
    elapsedMs: res.elapsedMs
  }
}

/**
 * 执行一条文本 shell 命令并返回 stdout（已 trimEnd）。
 * 远端退出码非 0 会抛 AppError —— 这是 `shell` 相对 `exec-out` 的唯一价值。
 */
export async function shell(
  serial: string,
  cmd: string,
  timeoutMs: number = ADB_TIMEOUT_MS
): Promise<string> {
  const r = await shellRaw(serial, cmd, timeoutMs)
  if (r.code !== 0) {
    throw classifyFailure(serial, cmd, r.code, r.stderr || r.text)
  }
  return r.text.trimEnd()
}

/**
 * 执行一条命令并拿回**裸二进制** stdout（screencap 走这条）。
 *
 * ⚠️ exec-out 不透传远端退出码，这里的 code 只反映本地 adb 自身是否出错
 *    （例如 `device 'xxx' not found`）。要判断远端命令成败请改用 shell。
 * ⚠️ 远端 stderr 会被并进这里的 stdout，所以同管线里的其它命令必须自行重定向输出。
 */
export async function execOut(
  serial: string,
  cmd: string,
  timeoutMs: number = ADB_TIMEOUT_MS
): Promise<Uint8Array> {
  const res = await adb(serial, ['exec-out', cmd], timeoutMs)
  if (res.code !== 0) {
    // 失败时 stdout 通常是空的；但万一是半截帧，也只取前 2KB 去拼错误信息，
    // 免得把 14MB 的二进制解码成字符串。
    throw classifyFailure(
      serial,
      cmd,
      res.code,
      res.stderr || decodeText(res.stdout.subarray(0, 2048))
    )
  }
  return res.stdout
}

/** 面板启动时跑一次，保证 adb server 在 127.0.0.1:5037 上。 */
export async function startServer(): Promise<void> {
  // start-server 会打印 "daemon not running; starting now at ..." 到 stderr，属正常输出。
  const res = await run(['start-server'], 30_000)
  if (res.code !== 0) {
    throw new AppError(
      'ADB_COMMAND_FAILED',
      `启动 adb server 失败（退出码 ${res.code}）：${res.stderr.trim() || decodeText(res.stdout).trim() || '无输出'}`,
      { adbPath, code: res.code }
    )
  }
}

/** 把 adb 的失败输出翻译成带中文说明的 AppError。 */
export function classifyFailure(
  serial: string,
  cmd: string,
  code: number,
  message: string
): AppError {
  const text = (message ?? '').trim()
  const detail = { serial, cmd, code, output: text }

  if (/not found|no devices\/emulators found|device offline|device still connecting/i.test(text)) {
    return new AppError(
      'ADB_DEVICE_OFFLINE',
      `设备 ${serial} 未连接或已离线：${text || '无输出'}。请在面板里重新连接该实例。`,
      detail
    )
  }
  if (/more than one device/i.test(text)) {
    // 理论上不会出现：本模块所有调用都强制带 -s。出现了说明有人绕过了 adb()。
    return new AppError(
      'ADB_COMMAND_FAILED',
      `adb 命中了多个 transport（${serial}）：${text}。这通常是某处调用漏了 -s。`,
      detail
    )
  }
  if (/unauthorized/i.test(text)) {
    return new AppError('ADB_DEVICE_OFFLINE', `设备 ${serial} 未授权 adb 调试：${text}`, detail)
  }
  if (/INJECT_EVENTS|Injecting to another application/i.test(text)) {
    // 实测遇到过：前台是受保护应用时，`input swipe` 被 InputManagerService 拒绝。
    // 完整 Java 异常留在 detail 里，面板上只显示这一句。
    return new AppError(
      'ADB_COMMAND_FAILED',
      `设备 ${serial} 拒绝了输入注入：当前前台应用不允许 adb 模拟点击（INJECT_EVENTS）。` +
        `请确认模拟器已开启「允许模拟点击 / USB 调试（安全设置）」，或先把该应用切到前台再试。`,
      detail
    )
  }

  // 异常堆栈可能很长，消息里只留前 300 字，完整内容在 detail.output 里。
  const brief = text.length > 300 ? `${text.slice(0, 300)}…（完整输出见日志）` : text
  return new AppError(
    'ADB_COMMAND_FAILED',
    `adb 命令执行失败（退出码 ${code}）：${cmd}${brief ? ` —— ${brief}` : ''}`,
    detail
  )
}

/** 内部小工具：延时。 */
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}
