/**
 * 日志落盘与回查：<dataDir>/logs/<runId>.ndjson + <dataDir>/logs/app.ndjson
 *
 * 为什么是 ndjson：一行一条 LogEntry，追加成本 O(1)，坏一行不影响其他行，
 * 回查时可以从文件尾部反向读，不用把整个文件 JSON.parse。
 *
 * ★ 只有主进程写日志文件。worker 通过 WorkerToMain('persistLogs') 把批次交过来，
 *   否则多个 utilityProcess 会抢同一个文件句柄，写出交错的半截行。
 *
 * 本模块不注册 IPC handler（那是模块 e 的事），只导出纯函数，目录由调用方传入。
 */

import { appendFile, mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@shared/errors'
import type { LogEntry, LogLevel, LogQuery } from '@shared/script'

/** app.ndjson：不属于任何一次执行的面板级日志。 */
export const APP_LOG_FILE = 'app.ndjson'

/** 回查时最多从文件尾部读这么多字节，避免一个跑了一整天的 run 把内存撑爆。 */
const MAX_TAIL_BYTES = 4 * 1024 * 1024
/** 不传 limit 时默认返回多少条。 */
const DEFAULT_LIMIT = 500

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

const SAFE_RUN_ID = /^[A-Za-z0-9_.-]+$/

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new AppError('INVALID_ARGUMENT', `runId 含非法字符：${runId}`)
  }
}

function fileOf(logsDir: string, runId: string | undefined): string {
  if (!runId) return join(logsDir, APP_LOG_FILE)
  assertSafeRunId(runId)
  return join(logsDir, `${runId}.ndjson`)
}

/** 按文件串行化写入，避免同一文件上的并发 append 交错。 */
const chains = new Map<string, Promise<unknown>>()
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  )
  return next
}

function encode(entries: readonly LogEntry[]): string {
  const lines: string[] = []
  for (const e of entries) {
    try {
      lines.push(JSON.stringify(e))
    } catch {
      // data 里塞了循环引用之类的东西。丢掉 data 也要把这条日志留下来。
      lines.push(
        JSON.stringify({
          ts: e.ts,
          level: e.level,
          runId: e.runId,
          instanceIndex: e.instanceIndex,
          scope: e.scope,
          stepId: e.stepId,
          message: e.message,
          shot: e.shot,
          data: { __serializeFailed: true }
        })
      )
    }
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

// ── 写 ────────────────────────────────────────────────────────────────────

/** 追加一批执行日志。worker 每 100ms 攒一批过来，这里不再做二次缓冲。 */
export async function appendLogs(
  logsDir: string,
  runId: string,
  entries: readonly LogEntry[]
): Promise<void> {
  if (entries.length === 0) return
  const path = fileOf(logsDir, runId)
  const text = encode(entries)
  return serialize(path, async () => {
    try {
      await mkdir(logsDir, { recursive: true })
      await appendFile(path, text, 'utf8')
    } catch (e) {
      throw new AppError('IO_ERROR', `写入运行日志失败：${path}`, { cause: String(e) })
    }
  })
}

/** 追加一条面板级日志（app.ndjson）。 */
export async function appendAppLog(logsDir: string, entry: LogEntry): Promise<void> {
  const path = fileOf(logsDir, undefined)
  const text = encode([entry])
  return serialize(path, async () => {
    try {
      await mkdir(logsDir, { recursive: true })
      await appendFile(path, text, 'utf8')
    } catch (e) {
      throw new AppError('IO_ERROR', `写入面板日志失败：${path}`, { cause: String(e) })
    }
  })
}

// ── 读 ────────────────────────────────────────────────────────────────────

/**
 * 回查历史日志。
 * 从文件尾部反向读（最多 MAX_TAIL_BYTES），按 level/since/instanceIndex 过滤，
 * 取最近的 limit 条，最后按时间正序返回（面板日志面板是自上而下读的）。
 *
 * 实时日志不走这里，走 MessagePort（worker 直连渲染进程）。
 */
export async function queryLogs(logsDir: string, q: LogQuery): Promise<LogEntry[]> {
  const path = fileOf(logsDir, q.runId)
  const limit = Math.max(1, q.limit ?? DEFAULT_LIMIT)
  const minLevel = q.minLevel ? LEVEL_ORDER[q.minLevel] : 0

  let text: string
  try {
    const st = await stat(path)
    const start = Math.max(0, st.size - MAX_TAIL_BYTES)
    const len = st.size - start
    if (len === 0) return []
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.allocUnsafe(len)
      await fh.read(buf, 0, len, start)
      text = buf.toString('utf8')
    } finally {
      await fh.close()
    }
    // 从中间截断时，第一行大概率是半截，丢掉它。
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new AppError('IO_ERROR', `读取日志失败：${path}`, { cause: String(e) })
  }

  const lines = text.split('\n')
  const out: LogEntry[] = []
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let e: LogEntry
    try {
      e = JSON.parse(line) as LogEntry
    } catch {
      continue // 半截行/手改坏的行，跳过即可，不值得让整次查询失败
    }
    if (typeof e?.ts !== 'number' || typeof e?.message !== 'string') continue
    if (LEVEL_ORDER[e.level] < minLevel) continue
    if (q.since !== undefined && e.ts <= q.since) continue
    if (q.instanceIndex !== undefined && e.instanceIndex !== q.instanceIndex) continue
    out.push(e)
  }
  out.reverse()
  return out
}

/** 列出磁盘上有日志的 runId（按修改时间倒序），面板的「历史执行」用。 */
export async function listRunLogs(
  logsDir: string
): Promise<{ runId: string; size: number; updatedAt: number }[]> {
  let files: string[]
  try {
    files = await readdir(logsDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new AppError('IO_ERROR', `读取日志目录失败：${logsDir}`, { cause: String(e) })
  }
  const out: { runId: string; size: number; updatedAt: number }[] = []
  for (const f of files) {
    if (!f.endsWith('.ndjson') || f === APP_LOG_FILE) continue
    try {
      const st = await stat(join(logsDir, f))
      out.push({ runId: f.slice(0, -'.ndjson'.length), size: st.size, updatedAt: st.mtimeMs })
    } catch {
      continue
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

/** 删除某次执行的日志文件。 */
export async function deleteRunLogs(logsDir: string, runId: string): Promise<void> {
  const path = fileOf(logsDir, runId)
  await rm(path, { force: true }).catch((e) => {
    throw new AppError('IO_ERROR', `删除日志失败：${path}`, { cause: String(e) })
  })
}

/** 只保留最近 keep 次执行的日志，其余删掉。返回被删掉的 runId。 */
export async function pruneRunLogs(logsDir: string, keep: number): Promise<string[]> {
  const all = await listRunLogs(logsDir)
  const doomed = all.slice(Math.max(0, keep))
  for (const d of doomed) await deleteRunLogs(logsDir, d.runId)
  return doomed.map((d) => d.runId)
}
