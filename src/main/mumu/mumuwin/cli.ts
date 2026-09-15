/**
 * MuMuManager.exe 的唯一出口（Windows 版 MuMu 驱动）。驱动里任何地方都不许再 spawn 它。
 *
 * ★ 真机实测（MuMu 模拟器 6.6.4.0「nx」，Windows 11，2026-09-14），改代码前先读完：
 *
 *   1. 输出是 **JSON、UTF-8**（雷电是 GBK 文本；这里仍走 decodeConsoleText 兜底）。
 *   2. 业务错误：stdout 是 {"errcode":-200,"errmsg":"player index not found"}，**退出码 = errcode**（-200）。
 *      `setting -v 99` 的文案不同（`player index not exists in vms`），errcode 同样 -200。
 *   3. 命令名拼错：打整段用法文本（OVERVIEW: / USAGE: / SUBCOMMANDS:），退出码 -1。
 *   4. 成功：`info` 直接给对象（没有 errcode 键）；`control … launch` 给 {"errcode":0,"errmsg":""}；
 *      个别命令可能什么都不打、退出 0。三种都算成功。
 *   5. Windows 退出码是无符号 32 位，-200 在 Node 里是 4294967096，要换算回来。
 *   6. `info -v all` 实测 ~75ms；`control -v 0 launch` 1.8s 返回，约 8 秒后 Android 就绪。
 *
 * 纯 Node，不 import electron（命令行脚本会直接用）。
 */

import { spawn } from 'node:child_process'
import { AppError } from '@shared/errors'
import { decodeConsoleText, firstLine, normalizeNewlines, toSigned32 } from '../console'

const DEFAULT_TIMEOUT_MS = 20_000

let cliPath = ''

/** 覆盖 MuMuManager.exe 路径（面板设置变更 / 脚本引导时调用）。 */
export function setMumuWinCliPath(p: string): void {
  const next = (p ?? '').trim()
  if (!next) {
    throw new AppError('INVALID_ARGUMENT', 'MuMuManager.exe 路径不能为空')
  }
  cliPath = next
}

export function getMumuWinCliPath(): string {
  return cliPath
}

export interface MumuWinExecResult {
  /** 已解码、已把 \r\n 归一成 \n 的 stdout。 */
  stdout: string
  stderr: string
  /** 有符号退出码；被 SIGKILL 时为 null。 */
  code: number | null
  elapsedMs: number
}

/**
 * 执行一条 MuMuManager 子命令。**不判成败**（交给 judgeMumuWinOutput），只负责收全输出、超时 SIGKILL、
 * 可执行文件找不到时给出中文指引。
 */
export async function mumuWinExec(
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<MumuWinExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const bin = cliPath
  if (!bin) {
    throw new AppError(
      'NOT_FOUND',
      '还没有配置 MuMu 模拟器的 MuMuManager.exe 路径。请到「设置」页选择 <MuMu 安装目录>\\nx_main\\MuMuManager.exe' +
        '（MuMu 12 是 \\shell\\MuMuManager.exe；本机是 D:\\tool\\MuMuPlayer\\nx_main）。',
      { argv: args }
    )
  }
  const startedAt = Date.now()

  return new Promise<MumuWinExecResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      // windowsHide：MuMuManager 是控制台程序，从 Electron 主进程起它会闪一个黑窗，3 秒一次轮询就是 3 秒一闪。
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      reject(spawnFailure(e, bin, args))
      return
    }

    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    child.stdout?.on('data', (c: Buffer) => outChunks.push(c))
    child.stderr?.on('data', (c: Buffer) => errChunks.push(c))
    child.on('error', (e) => finish(() => reject(spawnFailure(e, bin, args))))
    child.on('close', (exitCode) => {
      finish(() => {
        if (timedOut) {
          reject(
            new AppError(
              'TIMEOUT',
              `MuMuManager ${args[0] ?? ''} 执行超时（${timeoutMs}ms），已强制结束。请确认 MuMu 模拟器程序没有卡死。`,
              { argv: args, timeoutMs }
            )
          )
          return
        }
        resolve({
          stdout: normalizeNewlines(decodeConsoleText(Buffer.concat(outChunks))),
          stderr: normalizeNewlines(decodeConsoleText(Buffer.concat(errChunks))),
          code: exitCode === null ? null : toSigned32(exitCode),
          elapsedMs: Date.now() - startedAt
        })
      })
    })
  })
}

const USAGE_RE = /^\s*(OVERVIEW|USAGE|SUBCOMMANDS):/m
/** 不存在的实例：`info/control/rename` 说 not found，`setting` 说 not exists in vms。errcode 都是 -200。 */
const MISSING_RE = /player index not (found|exists)/i
const MISSING_ERRCODE = -200

/** 输出是不是整段用法文本（命令拼错 / 参数缺失都会打它）。 */
export function isMumuWinUsageText(text: string): boolean {
  return USAGE_RE.test(text)
}

/**
 * 成败判定 + 解析。成功时返回解析出的 JSON（命令没有输出时返回 null）。
 *
 *   · 用法文本                       -> MUMU_CLI_USAGE
 *   · JSON 且 errcode 非 0           -> -200 / "player index not …" = MUMU_INSTANCE_MISSING，其余 MUMU_API_ERROR
 *   · 不是 JSON 且退出码非 0         -> MUMU_API_ERROR
 *   · 其余（含空输出 + 退出码 0）    -> 成功
 * @param what 中文动作名，例如「启动实例 0」，用于拼错误信息
 */
export function judgeMumuWinOutput(res: MumuWinExecResult, argv: string[], what: string): unknown {
  const text = `${res.stdout}\n${res.stderr}`.trim()
  if (isMumuWinUsageText(text)) {
    throw new AppError(
      'MUMU_CLI_USAGE',
      `${what}失败：MuMuManager 不认识这条命令的参数（打印了用法说明）。这通常是 MuMu 版本与本面板适配的版本（6.6.4）不同。`,
      { argv, output: firstLine(text), exitCode: res.code }
    )
  }

  const json = tryParseJson(res.stdout)
  if (isRecord(json) && 'errcode' in json) {
    const errcode = Number(json['errcode'])
    const errmsg = typeof json['errmsg'] === 'string' ? json['errmsg'] : ''
    if (errcode !== 0) {
      if (errcode === MISSING_ERRCODE || MISSING_RE.test(errmsg)) {
        throw new AppError(
          'MUMU_INSTANCE_MISSING',
          `${what}失败：MuMu 说这个实例不存在（${errmsg || `errcode ${errcode}`}）。请刷新实例列表后重试。`,
          { argv, errcode, errmsg, exitCode: res.code }
        )
      }
      throw new AppError(
        'MUMU_API_ERROR',
        `${what}失败（MuMuManager errcode ${errcode}）：${errmsg || '无说明'}`,
        { argv, errcode, errmsg, exitCode: res.code }
      )
    }
    return json
  }

  if (res.code !== 0 && res.code !== null) {
    throw new AppError(
      'MUMU_API_ERROR',
      `${what}失败（MuMuManager 退出码 ${res.code}）：${firstLine(text) || '无输出'}`,
      { argv, output: text.slice(0, 500), exitCode: res.code }
    )
  }
  return json === undefined ? null : json
}

function tryParseJson(s: string): unknown {
  const t = s.trim()
  if (!t || !(t.startsWith('{') || t.startsWith('['))) return undefined
  try {
    return JSON.parse(t) as unknown
  } catch {
    return undefined
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function spawnFailure(e: unknown, bin: string, args: string[]): AppError {
  const errno = (e as NodeJS.ErrnoException | undefined)?.code
  if (errno === 'ENOENT') {
    return new AppError(
      'NOT_FOUND',
      `找不到 MuMuManager.exe：${bin}。请到「设置」页确认 MuMu 模拟器的安装目录（本机默认 D:\\tool\\MuMuPlayer\\nx_main）。`,
      { path: bin, argv: args }
    )
  }
  if (errno === 'EACCES' || errno === 'EPERM') {
    return new AppError('IO_ERROR', `没有权限执行 MuMuManager.exe：${bin}`, {
      path: bin,
      argv: args
    })
  }
  return new AppError(
    'IO_ERROR',
    `启动 MuMuManager.exe 失败：${(e as Error)?.message ?? String(e)}`,
    { path: bin, argv: args, errno }
  )
}
