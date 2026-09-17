import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AppError } from '@shared/errors'
import type { GatherRuntimeState } from './gather/types'

type StateFile = Record<string, GatherRuntimeState>
const chains = new Map<string, Promise<unknown>>()

export async function loadGatherStates(dataDir: string): Promise<StateFile> {
  const file = join(dataDir, 'gather-state.json')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new AppError('IO_ERROR', `读取采集状态失败：${file}`, { cause: String(e) })
  }
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid object')
    return data
  } catch {
    throw new AppError('IO_ERROR', `采集状态文件损坏，原文件已保留且不会被覆盖：${file}`)
  }
}

export function saveGatherState(
  dataDir: string,
  index: number,
  state: GatherRuntimeState
): Promise<void> {
  const absolute = resolve(dataDir)
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const snapshot = structuredClone(state)
  const write = async (): Promise<void> => {
    await mkdir(absolute, { recursive: true })
    const all = await loadGatherStates(absolute)
    all[String(index)] = snapshot
    const file = join(absolute, 'gather-state.json')
    const tmp = `${file}.tmp-${randomUUID()}`
    try {
      await writeFile(tmp, JSON.stringify(all, null, 2) + '\n', 'utf8')
      await rename(tmp, file)
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
  }
  const next = (chains.get(key) ?? Promise.resolve()).then(write, write)
  const settled = next.then(
    () => undefined,
    () => undefined
  )
  chains.set(key, settled)
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key)
  })
  return next
}
