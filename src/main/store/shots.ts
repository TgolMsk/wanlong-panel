/**
 * 截图留痕：<dataDir>/shots/<runId>/<seq>-<label>.jpg
 *
 * ★ 只有主进程写截图文件。worker 通过 WorkerToMain('persistShot') 把 jpeg 交过来。
 * ★ 截图非常占磁盘（一张 720p jpeg 约 40KB，always 策略下一小时能上千张），
 *   所以这里提供了按 runId 清理和按保留份数清理的函数，面板应定期调用。
 *
 * 本模块不注册 IPC handler（那是模块 e 的事），只导出纯函数，目录由调用方传入。
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@shared/errors'

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/

function assertSafe(what: string, v: string): void {
  if (!SAFE_SEGMENT.test(v) || v === '.' || v === '..') {
    throw new AppError('INVALID_ARGUMENT', `${what} 含非法字符（可能是路径穿越）：${v}`)
  }
}

/**
 * 把 LogEntry.shot 里存的相对路径拆成 runId + 文件名。
 * 兼容两种写法：`<runId>/<file>.jpg` 和裸 `<file>.jpg`（后者需调用方给 runId）。
 */
export function splitShotPath(runId: string, shot: string): { runId: string; file: string } {
  const parts = shot.split(/[/\\]/).filter((p) => p.length > 0)
  if (parts.length > 2 || parts.some((p) => p === '.' || p === '..')) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `截图路径非法（只接受 <runId>/<文件名> 或裸文件名）：${shot}`
    )
  }
  const file = parts.length > 1 ? parts[1] : parts[0]
  const dir = parts.length > 1 ? parts[0] : runId
  if (!file) throw new AppError('INVALID_ARGUMENT', `截图路径为空：${shot}`)
  assertSafe('runId', dir)
  assertSafe('截图文件名', file)
  return { runId: dir, file }
}

function toBuffer(data: ArrayBuffer | Uint8Array): Buffer {
  return data instanceof Uint8Array
    ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    : Buffer.from(data)
}

/** 保存一张留痕截图，返回相对 shots 目录的路径（就是 LogEntry.shot 的值）。 */
export async function saveShot(
  shotsDir: string,
  runId: string,
  file: string,
  jpeg: ArrayBuffer | Uint8Array
): Promise<string> {
  assertSafe('runId', runId)
  assertSafe('截图文件名', file)
  const dir = join(shotsDir, runId)
  const path = join(dir, file)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, toBuffer(jpeg))
  } catch (e) {
    throw new AppError('IO_ERROR', `保存截图失败：${path}`, { cause: String(e) })
  }
  return `${runId}/${file}`
}

/** 读一张留痕截图给面板显示。 */
export async function readShot(
  shotsDir: string,
  runId: string,
  shot: string
): Promise<ArrayBuffer> {
  const { runId: dir, file } = splitShotPath(runId, shot)
  const path = join(shotsDir, dir, file)
  try {
    const buf = await readFile(path)
    // 必须复制成独立 ArrayBuffer：Buffer 可能只是内存池的一个切片，
    // 直接把 buf.buffer 丢过 IPC 会把整块池子（甚至别人的数据）带过去。
    const ab = new ArrayBuffer(buf.byteLength)
    new Uint8Array(ab).set(buf)
    return ab
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('NOT_FOUND', `截图不存在（可能已被清理）：${path}`)
    }
    throw new AppError('IO_ERROR', `读取截图失败：${path}`, { cause: String(e) })
  }
}

/** 列出某次执行的全部留痕（按文件名排序，文件名带自增序号所以就是时间序）。 */
export async function listRunShots(shotsDir: string, runId: string): Promise<string[]> {
  assertSafe('runId', runId)
  try {
    const files = await readdir(join(shotsDir, runId))
    return files.filter((f) => f.endsWith('.jpg')).sort()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new AppError('IO_ERROR', `读取截图目录失败：${join(shotsDir, runId)}`, {
      cause: String(e)
    })
  }
}

/** 删除某次执行的全部截图。 */
export async function deleteRunShots(shotsDir: string, runId: string): Promise<void> {
  assertSafe('runId', runId)
  const dir = join(shotsDir, runId)
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (e) {
    throw new AppError('IO_ERROR', `删除截图目录失败：${dir}`, { cause: String(e) })
  }
}

/** 只保留最近 keep 次执行的截图目录，其余删掉。返回被清理的 runId。 */
export async function pruneShots(shotsDir: string, keep: number): Promise<string[]> {
  let dirs: string[]
  try {
    dirs = await readdir(shotsDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new AppError('IO_ERROR', `读取截图根目录失败：${shotsDir}`, { cause: String(e) })
  }

  const entries: { runId: string; updatedAt: number }[] = []
  for (const d of dirs) {
    try {
      const st = await stat(join(shotsDir, d))
      if (st.isDirectory()) entries.push({ runId: d, updatedAt: st.mtimeMs })
    } catch {
      continue
    }
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt)
  const doomed = entries.slice(Math.max(0, keep))
  for (const d of doomed) await deleteRunShots(shotsDir, d.runId)
  return doomed.map((d) => d.runId)
}

/** 统计截图占用的磁盘（面板设置页显示，提醒用户清理）。 */
export async function shotsDiskUsage(shotsDir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  let dirs: string[]
  try {
    dirs = await readdir(shotsDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { files: 0, bytes: 0 }
    throw new AppError('IO_ERROR', `读取截图根目录失败：${shotsDir}`, { cause: String(e) })
  }
  for (const d of dirs) {
    let inner: string[]
    try {
      inner = await readdir(join(shotsDir, d))
    } catch {
      continue
    }
    for (const f of inner) {
      try {
        const st = await stat(join(shotsDir, d, f))
        if (st.isFile()) {
          files += 1
          bytes += st.size
        }
      } catch {
        continue
      }
    }
  }
  return { files, bytes }
}
