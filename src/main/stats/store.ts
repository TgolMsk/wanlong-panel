/**
 * 日统计的磁盘读写：<dataDir>/stats/<dateKey>.json，一天一个文件。
 *
 * 写法照抄 src/main/store/accounts.ts：临时文件 + rename、进程内写串行化、读取一律容错。
 *   · 读：文件不存在 → null；JSON 坏了 → 用 normalizeDailyStats 兜出一个能用的桶并 warn（不整体作废）。
 *   · 写：mkdir -p + tmp + rename，断电/崩溃不会留下半截 JSON。
 *   · 清理：按文件名里的日期键判断，只删 STATS_DIR 下形如 YYYY-MM-DD.json 的文件，别的一概不碰。
 *
 * 本文件不注册 IPC，也不知道"今天"是哪天（那是 StatsCenter 的事）。
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@shared/errors'
import {
  STATS_DIR,
  isDateKey,
  normalizeDailyStats,
  shiftDateKey,
  cstDateKey,
  type DailyStats,
  type DateKey
} from '@shared/stats'

/** 进程内写串行化：日切保存与防抖保存同时到来时不会互相踩掉半个文件。 */
let chain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

export function statsDirOf(dataDir: string): string {
  return join(dataDir, STATS_DIR)
}

export function statsFileOf(dataDir: string, key: DateKey): string {
  return join(statsDirOf(dataDir), `${key}.json`)
}

/** 读取失败时的说明出口（可选），中文；ENOENT 不算失败。 */
export type StoreWarn = (message: string) => void

/**
 * 读某一天的日桶。文件不存在 → null；内容损坏 → 逐字段容错归一化后返回（并 warn）。
 * 读盘 I/O 本身出错（权限等）抛 AppError('IO_ERROR')。
 */
export async function loadDailyStats(
  dataDir: string,
  key: DateKey,
  warn?: StoreWarn
): Promise<DailyStats | null> {
  if (!isDateKey(key)) throw new AppError('INVALID_ARGUMENT', `日期格式应为 YYYY-MM-DD，收到：${key}`)
  const path = statsFileOf(dataDir, key)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new AppError('IO_ERROR', `读取统计文件失败：${path}`, { cause: String(e) })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    warn?.(`[统计] 文件不是合法 JSON，本日按空桶处理（原文件会在下次写入时被覆盖）：${path}`)
    return normalizeDailyStats(null, key)
  }
  const normalized = normalizeDailyStats(raw, key)
  if (normalized.dateKey !== key) {
    warn?.(`[统计] 文件 ${path} 里的日期键（${String((raw as { dateKey?: unknown })?.dateKey)}）与文件名不符，已按文件名 ${key} 归一化。`)
    normalized.dateKey = key
  }
  return normalized
}

/** 落盘一天的日桶（临时文件 + rename）。 */
export async function saveDailyStats(dataDir: string, stats: DailyStats): Promise<void> {
  if (!isDateKey(stats.dateKey)) {
    throw new AppError('INVALID_ARGUMENT', `统计日桶的日期键非法，拒绝落盘：${stats.dateKey}`)
  }
  return serialize(async () => {
    const dir = statsDirOf(dataDir)
    const path = statsFileOf(dataDir, stats.dateKey)
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(tmp, `${JSON.stringify(stats, null, 2)}\n`, 'utf8')
      await rename(tmp, path)
    } catch (e) {
      await unlink(tmp).catch(() => undefined)
      throw new AppError('IO_ERROR', `写入统计文件失败：${path}`, { cause: String(e) })
    }
  })
}

/** 列出已落盘的日期键（升序）。目录不存在 → []。 */
export async function listDailyKeys(dataDir: string): Promise<DateKey[]> {
  let names: string[]
  try {
    names = await readdir(statsDirOf(dataDir))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new AppError('IO_ERROR', `读取统计目录失败：${statsDirOf(dataDir)}`, { cause: String(e) })
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .filter(isDateKey)
    .sort()
}

/**
 * 清理早于 keepDays 天的日桶文件，返回被删掉的日期键。
 * 以 `now`（默认当前时刻）的北京日期为基准：保留 [today - keepDays + 1, today]。
 * 单个文件删不掉只 warn，不中断。
 */
export async function pruneDailyStats(
  dataDir: string,
  keepDays: number,
  opts: { now?: number; warn?: StoreWarn } = {}
): Promise<DateKey[]> {
  const days = Math.max(1, Math.floor(keepDays))
  const today = cstDateKey(opts.now ?? Date.now())
  const oldest = shiftDateKey(today, -(days - 1))
  const keys = await listDailyKeys(dataDir)
  const removed: DateKey[] = []
  for (const key of keys) {
    if (key >= oldest) continue
    try {
      await unlink(statsFileOf(dataDir, key))
      removed.push(key)
    } catch (e) {
      opts.warn?.(`[统计] 清理旧统计文件失败：${statsFileOf(dataDir, key)}（${String(e)}）`)
    }
  }
  return removed
}
