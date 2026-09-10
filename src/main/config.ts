/**
 * 面板设置的加载与保存。
 *
 * 单一实例：整个主进程只有一份 AppSettings，靠 getSettings() 同步取。
 * 磁盘上损坏或缺字段的设置**不会让应用起不来**——缺什么补什么，整体不合法就整体回退到默认值，
 * 同时把问题写进日志并给面板推一条提示。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defaultSettings } from '@shared/defaults'
import { appSettingsSchema } from '@shared/schemas'
import { AppError } from '@shared/errors'
import type { AppSettings } from '@shared/domain'
import { defaultDataDir, settingsFilePath } from '@main/paths'
import { emit } from '@main/ipc'

let current: AppSettings | null = null

type Listener = (settings: AppSettings) => void
const listeners = new Set<Listener>()

/** 未加载就调用属于接线顺序写错了，直接抛，而不是悄悄返回默认值掩盖问题。 */
export function getSettings(): AppSettings {
  if (!current) {
    throw new AppError('UNKNOWN', '设置尚未加载，loadSettings() 必须在任何 handler 注册之前调用')
  }
  return current
}

/** 是否已经加载过（健康检查等旁路逻辑用，避免抛错）。 */
export function isSettingsLoaded(): boolean {
  return current !== null
}

/**
 * 从 <默认数据目录>/settings.json 读取设置。
 * 文件不存在 -> 用默认值并立刻落盘一份，方便用户直接改文件。
 */
export async function loadSettings(): Promise<AppSettings> {
  const fallback = defaultSettings(defaultDataDir())
  const file = settingsFilePath()

  let raw: unknown = null
  let onDisk = ''
  try {
    onDisk = await readFile(file, 'utf8')
    raw = JSON.parse(onDisk)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err?.code !== 'ENOENT') {
      console.warn(`[config] 设置文件读取失败，改用默认设置：${file}`, err?.message ?? e)
    }
  }

  // 逐字段合并：磁盘上多出来的键忽略，缺的键用默认值补。
  const merged = { ...fallback, ...(isPlainObject(raw) ? raw : {}) }
  const parsed = appSettingsSchema.safeParse(merged)
  if (!parsed.success) {
    console.warn('[config] 设置内容不合法，已整体回退到默认设置', parsed.error.issues)
    current = fallback
  } else {
    current = parsed.data
  }

  // dataDir 允许为空串（defaultSettings 的占位），这里补实。
  if (!current.dataDir.trim()) current = { ...current, dataDir: defaultDataDir() }

  // 只在「文件不存在 / 被补过字段 / 被修正过」时才写回，避免每次启动都白改一次 mtime。
  if (serialize(current) !== onDisk) await persist(current)
  return current
}

/**
 * 增量保存。只传要改的字段。
 * 保存成功后通知所有订阅者（模块 a/b 靠它更新可执行文件路径），并推给渲染进程。
 */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const base = getSettings()
  const next = appSettingsSchema.safeParse({ ...base, ...patch })
  if (!next.success) {
    throw new AppError('INVALID_ARGUMENT', '设置内容不合法，请检查填写的数值范围', {
      issues: next.error.issues
    })
  }
  current = next.data
  await persist(current)

  for (const cb of listeners) {
    try {
      cb(current)
    } catch (e) {
      console.error('[config] 设置变更回调抛错', e)
    }
  }
  emit('app:settingsChanged', current)
  return current
}

/** 订阅设置变化。返回退订函数。 */
export function onSettingsChanged(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 测试/热重载用：清空内存态。 */
export function resetSettings(): void {
  current = null
  listeners.clear()
}

// ── 内部 ─────────────────────────────────────────────────────────────────

function serialize(settings: AppSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`
}

/** 先写临时文件再 rename，避免写到一半断电留下半截 JSON。 */
async function persist(settings: AppSettings): Promise<void> {
  const file = settingsFilePath()
  try {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await writeFile(tmp, serialize(settings), 'utf8')
    await rename(tmp, file)
  } catch (e) {
    throw new AppError('IO_ERROR', `设置写入失败：${file}。请确认该目录有写权限。`, {
      cause: String(e)
    })
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
