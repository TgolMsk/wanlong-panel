/**
 * ldconsole.exe 的唯一出口。雷电驱动里任何地方都不许再 spawn ldconsole。
 *
 * ★ 真机实测（雷电 14.0.26.1，Windows 11，2026-09-14），改代码前先读完：
 *
 *   1. **退出码不可靠，输出文本也不可靠，两条路必须一起看。**
 *        · `quit / reboot / rename --index 99`  打 `player don't exist!`，退出码 -1001
 *        · `runapp --index 99`                  同样打 `player don't exist!`，退出码却是 0
 *        · `modify --index 99 --cpu 4`          什么都不打，退出码 0（**静默无效**）
 *        · `launch --index 99`                  打印整段用法文本，退出码 -1001
 *        · 命令名拼错                           打印整段用法文本，退出码 -1000
 *        · `isrunning --index abc`              答 `stop`，退出码 0
 *        · `add` / `copy --from N`              **退出码 = 新实例的 index**（建出 3 号就退出 3），输出为空
 *        · `remove --index N`                   成功退出码 0，输出为空；`copy --from 99` 打 `player don't exist!` 退出码 0
 *      所以：涉及具体实例的命令，调用前先用 list2 确认实例存在（driver 层做）；
 *      调用后由 assertLdOk 同时检查退出码与几种已知的错误文本；add / copy 只能用 assertLdTextOk。
 *
 *   2. **输出是系统 ANSI 编码（中文 Windows = GBK），不是 UTF-8。**
 *      实例名「万龙1号」按 utf8 解码是一串 U+FFFD。这里先按 utf8 严格解码，失败再按 gbk 解码
 *      （Node 自带 full-icu，TextDecoder('gbk') 可用）。
 *
 *   3. 命令本身很快（list2 15ms，getprop 55ms）。慢的是 launch / quit 之后状态收敛，
 *      那由 driver 轮询 list2，不在这里等。
 *
 *   4. Windows 的退出码是无符号 32 位：-1001 在 Node 里是 4294966295。报错时换算回有符号数。
 *
 * 纯 Node，不 import electron（命令行脚本会直接用）。
 */

import { spawn } from 'node:child_process'
import { AppError } from '@shared/errors'
import { decodeConsoleText, firstLine, normalizeNewlines, toSigned32 } from '../console'

// 解码器搬到了 ../console.ts（与 MuMu 驱动共用），这里保留导出，detect.ts 与离线自检照旧从本文件 import。
export { decodeConsoleText }

const LD_DEFAULT_TIMEOUT_MS = 20_000

let cliPath = ''

/** 覆盖 ldconsole 路径（面板设置变更 / 脚本引导时调用）。 */
export function setLdCliPath(p: string): void {
  const next = (p ?? '').trim()
  if (!next) {
    throw new AppError('INVALID_ARGUMENT', 'ldconsole.exe 路径不能为空')
  }
  cliPath = next
}

export function getLdCliPath(): string {
  return cliPath
}

export interface LdExecResult {
  /** 已解码、已把 \r\n 归一成 \n 的 stdout。 */
  stdout: string
  stderr: string
  /** 有符号退出码；被 SIGKILL 时为 null。 */
  code: number | null
  elapsedMs: number
}

/**
 * 执行一条 ldconsole 子命令。**不判成败**（语义见文件头），只负责收全输出、超时 SIGKILL、
 * 可执行文件找不到时给出中文指引。
 */
export async function ldExec(
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<LdExecResult> {
  const timeoutMs = opts.timeoutMs ?? LD_DEFAULT_TIMEOUT_MS
  const bin = cliPath
  if (!bin) {
    throw new AppError(
      'NOT_FOUND',
      '还没有配置雷电模拟器的 ldconsole.exe 路径。请到「设置」页选择雷电安装目录下的 ldconsole.exe' +
        '（本机默认在 D:\\leidian\\LDPlayer14）。',
      { argv: args }
    )
  }
  const startedAt = Date.now()

  return new Promise<LdExecResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      // windowsHide：ldconsole 是控制台程序，从 Electron 主进程起它会闪一个黑窗，3 秒一次轮询就是 3 秒一闪。
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
              `ldconsole ${args[0] ?? ''} 执行超时（${timeoutMs}ms），已强制结束。请确认雷电模拟器程序没有卡死。`,
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

/** 已知的「实例不存在 / 用法错误」文本。ldconsole 的英文原话，别改。 */
const PLAYER_MISSING_RE = /player don't exist/i
const USAGE_RE = /Command Line Management Interface|^Usage:/im

/** 输出是不是整段用法文本（命令拼错 / 参数缺失 / launch 了不存在的实例都会打它）。 */
export function isLdUsageText(text: string): boolean {
  return USAGE_RE.test(text)
}

/**
 * 只看**输出文本**的成败判定：打印了 `player don't exist!` 或整段用法文本才算失败，**不看退出码**。
 *
 * ★ 给 add / copy 用。实测（2026-09-14）它们的退出码是**新实例的 index**，不是错误码：
 *   `copy --from 0` 建出实例 3 就退出 3，`add` 建出实例 4 就退出 4，输出都是空的。
 *   拿退出码当错误会把一次成功的克隆报成「克隆实例失败（ldconsole 退出码 3）」—— 这个 bug 真机上踩过。
 *   新实例到底是几号以 list2 的列表差集为准，退出码只当提示。
 * @param what 中文动作名，例如「克隆实例」，用于拼错误信息
 */
export function assertLdTextOk(res: LdExecResult, argv: string[], what: string): void {
  const text = `${res.stdout}\n${res.stderr}`.trim()
  if (PLAYER_MISSING_RE.test(text)) {
    throw new AppError(
      'MUMU_INSTANCE_MISSING',
      `${what}失败：雷电说这个实例不存在。请刷新实例列表后重试。`,
      {
        argv,
        output: text.slice(0, 500),
        exitCode: res.code
      }
    )
  }
  if (isLdUsageText(text)) {
    throw new AppError(
      'MUMU_CLI_USAGE',
      `${what}失败：ldconsole 不认识这条命令的参数（打印了用法说明）。这通常是雷电版本与本面板适配的版本不同。`,
      { argv, output: firstLine(text), exitCode: res.code }
    )
  }
}

/**
 * 完整判定：文本判据 + 退出码非 0 也算失败。
 * 给 launch / quit / reboot / modify / remove 用 —— 实测它们成功时退出码都是 0。
 * add / copy **不能**用它（见 assertLdTextOk）。
 * @param what 中文动作名，例如「启动实例 1」，用于拼错误信息
 */
export function assertLdOk(res: LdExecResult, argv: string[], what: string): void {
  assertLdTextOk(res, argv, what)
  const text = `${res.stdout}\n${res.stderr}`.trim()
  if (res.code !== 0) {
    throw new AppError(
      'MUMU_API_ERROR',
      `${what}失败（ldconsole 退出码 ${res.code ?? 'null'}）：${firstLine(text) || '无输出'}`,
      { argv, output: text.slice(0, 500), exitCode: res.code }
    )
  }
}

function spawnFailure(e: unknown, bin: string, args: string[]): AppError {
  const errno = (e as NodeJS.ErrnoException | undefined)?.code
  if (errno === 'ENOENT') {
    return new AppError(
      'NOT_FOUND',
      `找不到 ldconsole.exe：${bin}。请到「设置」页确认雷电模拟器的安装目录（本机默认 D:\\leidian\\LDPlayer14）。`,
      { path: bin, argv: args }
    )
  }
  if (errno === 'EACCES' || errno === 'EPERM') {
    return new AppError('IO_ERROR', `没有权限执行 ldconsole.exe：${bin}`, { path: bin, argv: args })
  }
  return new AppError(
    'IO_ERROR',
    `启动 ldconsole.exe 失败：${(e as Error)?.message ?? String(e)}`,
    {
      path: bin,
      argv: args,
      errno
    }
  )
}
