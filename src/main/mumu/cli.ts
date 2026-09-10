/**
 * mumutool CLI 的唯一出口。
 *
 * 本文件是整个 MuMu 实例管理层与外部进程之间的**唯一边界**：上层任何地方都不允许再出现
 * spawn / exec mumutool 的代码。把边界收在一个函数里，是为了让下面这套「实测得来的」
 * 错误语义只需要实现一次：
 *
 *   · CLI 用法错误  -> 退出码 64，stderr 是**非 JSON** 的英文文本
 *                     例：`Error: Unexpected argument 'frobnicate'`
 *                         `Error: The value 'abc' is invalid for '<device>'`
 *   · 业务错误      -> **退出码仍然是 0**，stdout 是 {"errcode":42001,"message":"..."}
 *                     例：info 一个不存在的 index -> errcode 42001 invalidParams
 *   · 接口未实现    -> 退出码 0，errcode 42000 invalidApi
 *                     Mac 版的 `control` 子命令族与 `config` 的**读取端**全部命中这一条，
 *                     属于永久性失败，禁止重试、禁止写 fallback 分支。
 *
 * 也就是说：**只看退出码会把业务错误当成功**，必须两条路都走。
 */

import { spawn } from 'node:child_process'
import { DEFAULT_MUMUTOOL_PATH } from '@shared/constants'
import { AppError } from '@shared/errors'
import { parseMumuEnvelope } from '@shared/schemas'

export interface MumuCliOptions {
  /** mumutool 可执行文件绝对路径。 */
  mumutoolPath: string
  /** 默认超时（ms）。单次调用可以用 mumuExec 的第二个参数覆盖。 */
  timeoutMs?: number
}

/**
 * 默认超时。
 * 实测：`info all` ≈ 25~35ms，`open <n>` ≈ 1.5s。
 * 20s 对这些「快命令」足够宽松；create / clone 这类要拷贝几个 GB 的慢命令
 * 由调用方在 instances.ts 里显式传更大的值，不要把默认值调大来迁就它们，
 * 否则 mumutool 真的卡死时面板会干等 20 分钟。
 */
const MUMU_DEFAULT_TIMEOUT_MS = 20_000

const options: Required<MumuCliOptions> = {
  mumutoolPath: DEFAULT_MUMUTOOL_PATH,
  timeoutMs: MUMU_DEFAULT_TIMEOUT_MS
}

/** 覆盖 CLI 配置（面板设置里改了 mumutool 路径时调用）。 */
export function setMumuCliOptions(opts: Partial<MumuCliOptions>): void {
  if (opts.mumutoolPath !== undefined) {
    const p = opts.mumutoolPath.trim()
    if (!p) {
      throw new AppError('INVALID_ARGUMENT', 'mumutool 路径不能为空')
    }
    options.mumutoolPath = p
  }
  if (opts.timeoutMs !== undefined) {
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
      throw new AppError('INVALID_ARGUMENT', 'mumutool 超时时间必须是正数（毫秒）')
    }
    options.timeoutMs = opts.timeoutMs
  }
}

/** 读取当前生效的 CLI 配置（自检面板用）。 */
export function getMumuCliOptions(): Required<MumuCliOptions> {
  return { ...options }
}

export interface MumuExecOptions {
  /** 覆盖本次调用的超时。create / clone 这类慢命令必须传。 */
  timeoutMs?: number
}

/**
 * 执行一条 mumutool 子命令，返回信封里的 `return` 字段。
 *
 * 用 spawn 而不是 exec：exec 会把 stdout 按 utf8 解码进一个字符串缓冲，
 * 且对超时的处理是 SIGTERM（mumutool 卡在网络 IO 时不一定响应）。这里统一用
 * spawn + 手动 Buffer 拼接 + SIGKILL。
 *
 * @throws AppError('NOT_FOUND')            mumutool 可执行文件不存在 / 无执行权限
 * @throws AppError('TIMEOUT')              超时（已 SIGKILL）
 * @throws AppError('MUMU_CLI_USAGE')       退出码非 0（参数拼错了，属于程序 bug）
 * @throws AppError('MUMU_BAD_OUTPUT')      stdout 不是合法信封
 * @throws AppError('MUMU_API_ERROR')       errcode != 0
 * @throws AppError('MUMU_API_UNSUPPORTED') errcode == 42000，Mac 版没实现，别重试
 */
export async function mumuExec<T>(args: string[], opts: MumuExecOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? options.timeoutMs
  const bin = options.mumutoolPath
  const startedAt = Date.now()

  const { stdout, stderr, code, signal } = await new Promise<{
    stdout: string
    stderr: string
    code: number | null
    signal: NodeJS.Signals | null
  }>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
      // SIGKILL 而不是 SIGTERM：mumutool 卡在与 MuMu 服务端（:21000）的 HTTP 请求上时
      // 不一定处理 TERM，留下僵尸进程会让后续调用一起排队。
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

    child.on('close', (exitCode, sig) => {
      finish(() => {
        if (timedOut) {
          reject(
            new AppError(
              'TIMEOUT',
              `mumutool ${args[0] ?? ''} 执行超时（${timeoutMs}ms），已强制结束。请确认 MuMu 模拟器主程序正在运行。`,
              { argv: args, timeoutMs }
            )
          )
          return
        }
        resolve({
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
          code: exitCode,
          signal: sig
        })
      })
    })
  })

  const elapsedMs = Date.now() - startedAt

  // ── 第一条路：退出码非 0 = CLI 用法错误 ──
  // stderr 是英文文本，直接透给用户没有意义，所以外层给一句中文，原文塞进 detail 供排查。
  if (code !== 0) {
    throw new AppError(
      'MUMU_CLI_USAGE',
      `mumutool 命令调用失败（退出码 ${code ?? 'null'}）：${firstLine(stderr) || firstLine(stdout) || '无输出'}`,
      { argv: args, exitCode: code, signal, stderr: stderr.slice(0, 1000), elapsedMs }
    )
  }

  // ── 第二条路：退出码 0 仍可能是业务错误 ──
  // parseMumuEnvelope 负责 JSON 解析 + errcode 判定（含 42000 -> MUMU_API_UNSUPPORTED）。
  try {
    return parseMumuEnvelope(stdout) as T
  } catch (e) {
    // 补上 argv，否则「errcode=42001 invalidParams」这种消息完全看不出是哪条命令炸的。
    const err = AppError.from(e, 'MUMU_BAD_OUTPUT')
    throw new AppError(err.code, err.message, { ...err.detail, argv: args, elapsedMs })
  }
}

/** spawn 本身失败（文件不存在 / 没有执行权限）。 */
function spawnFailure(e: unknown, bin: string, args: string[]): AppError {
  const errno = (e as NodeJS.ErrnoException | undefined)?.code
  if (errno === 'ENOENT') {
    return new AppError(
      'NOT_FOUND',
      `找不到 mumutool，请在「设置」里确认 MuMu 模拟器的安装路径：${bin}`,
      { path: bin, argv: args }
    )
  }
  if (errno === 'EACCES') {
    return new AppError('IO_ERROR', `mumutool 没有执行权限：${bin}`, { path: bin, argv: args })
  }
  return new AppError('IO_ERROR', `启动 mumutool 失败：${(e as Error)?.message ?? String(e)}`, {
    path: bin,
    argv: args,
    errno
  })
}

function firstLine(s: string): string {
  return s.split('\n')[0]?.trim() ?? ''
}
