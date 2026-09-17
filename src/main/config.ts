/**
 * 面板设置的加载与保存。
 *
 * 已保存设置供表单显示；运行设置固定本次启动的设备身份和数据目录，普通选项即时生效。
 * 磁盘上损坏或缺字段的设置**不会让应用起不来**——缺什么补什么，整体不合法就整体回退到默认值，
 * 同时把问题写进日志并给面板推一条提示。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { LD_CLI_EXE, MUMU_WIN_CLI_EXE } from '@shared/constants'
import { defaultSettings } from '@shared/defaults'
import { appSettingsSchema } from '@shared/schemas'
import { AppError } from '@shared/errors'
import type { AppSettings } from '@shared/domain'
import { defaultDataDir, settingsFilePath, ensureDirs, resolvePaths } from '@main/paths'
import { selectDataContext } from './dataContext'
import { emit } from '@main/ipc'
import { detectLdInstall } from '@main/mumu/ldplayer/detect'
import { detectMumuWinInstall } from '@main/mumu/mumuwin/detect'
import { settingsForRuntime, settingsNeedRestart } from './runtimeSettings'

let current: AppSettings | null = null
let runtime: AppSettings | null = null
let saveChain: Promise<unknown> = Promise.resolve()

type Listener = (settings: AppSettings) => void
const listeners = new Set<Listener>()

/** 未加载就调用属于接线顺序写错了，直接抛，而不是悄悄返回默认值掩盖问题。 */
export function getSettings(): AppSettings {
  if (!current) {
    throw new AppError('UNKNOWN', '设置尚未加载，loadSettings() 必须在任何 handler 注册之前调用')
  }
  return {
    ...current,
    restartRequired: runtime ? settingsNeedRestart(current, runtime) : false,
    runtimeEmulator: runtime?.emulator ?? current.emulator
  }
}

export function getRuntimeSettings(): AppSettings {
  if (!runtime) throw new AppError('UNKNOWN', '运行设置尚未加载。')
  return { ...runtime }
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
  const fallback = defaultSettings(defaultDataDir(), process.platform)
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

  current = await autofillEmulatorPaths(current)

  // 只在「文件不存在 / 被补过字段 / 被修正过」时才写回，避免每次启动都白改一次 mtime。
  if (serialize(current) !== onDisk) await persist(current)
  runtime = { ...current }
  return current
}

/**
 * Windows 上按模拟器种类探测安装目录并回填 adb / 管理 CLI 路径（启动与保存设置时都会跑）。
 * 触发条件：路径为空、还是 Mac 时代的 /Applications/... 路径（从 Mac 拷来的 settings.json）、
 * 或文件名与当前模拟器对不上（例如从雷电切到 MuMu 后 mumutoolPath 还指着 ldconsole.exe）。
 * 管理 CLI 需要重探时 adb 也一起重探（两家的 adb 版本不同，混用会互相杀 adb server）。
 * 探不到就原样返回，由自检项给出中文指引。macOS 上不做任何事。
 */
export async function autofillEmulatorPaths(s: AppSettings): Promise<AppSettings> {
  if (process.platform !== 'win32') return s
  const isLd = s.emulator === 'ldplayer'
  const cliExe = isLd ? LD_CLI_EXE : MUMU_WIN_CLI_EXE
  const wantCli = needsDetect(s.mumutoolPath, cliExe)
  const wantAdb = wantCli || needsDetect(s.adbPath, 'adb.exe')
  if (!wantAdb && !wantCli) return s

  const label = isLd ? '雷电模拟器' : 'MuMu 模拟器'
  const hit = isLd ? await detectLdInstall() : await detectMumuWinInstall()
  if (!hit) {
    console.warn(
      `[config] 没有探测到${label}安装目录，请到「设置」页手动指定 ${cliExe} 与 adb.exe。`
    )
    return s
  }
  console.log(`[config] 已探测到${label}安装目录（${hit.source}）：${hit.dir}`)
  return {
    ...s,
    adbPath: wantAdb ? hit.adbPath : s.adbPath,
    mumutoolPath: wantCli ? hit.cliPath : s.mumutoolPath
  }
}

/** 空串、一条 POSIX 绝对路径（Mac 的默认值）、或文件名不是期望的可执行文件，都视为「还没配对」。 */
function needsDetect(p: string, expectExe: string): boolean {
  const t = (p ?? '').trim()
  if (!t || t.startsWith('/')) return true
  return basename(t).toLowerCase() !== expectExe.toLowerCase()
}

/**
 * 增量保存。只传要改的字段。
 * 保存成功后通知所有订阅者（模块 a/b 靠它更新可执行文件路径），并推给渲染进程。
 */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const snapshot = { ...patch }
  const next = saveChain.then(
    () => saveSettingsSerial(snapshot),
    () => saveSettingsSerial(snapshot)
  )
  saveChain = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

async function saveSettingsSerial(patch: Partial<AppSettings>): Promise<AppSettings> {
  const base = getSettings()
  const next = appSettingsSchema.safeParse({ ...base, ...patch })
  if (!next.success) {
    throw new AppError('INVALID_ARGUMENT', '设置内容不合法，请检查填写的数值范围', {
      issues: next.error.issues
    })
  }
  // 换了模拟器种类 / 把路径清空 -> 顺手按注册表补上路径，用户不必手动找 exe。
  const saved = await autofillEmulatorPaths(next.data)
  if (!isAbsolute(saved.dataDir))
    throw new AppError('INVALID_ARGUMENT', '数据目录请填写完整的绝对路径。')
  const nextContext = await selectDataContext(saved)
  await ensureDirs(resolvePaths(saved, nextContext))
  await persist(saved)
  current = saved
  runtime = settingsForRuntime(saved, runtime ?? saved)

  for (const cb of listeners) {
    try {
      cb(getRuntimeSettings())
    } catch (e) {
      console.error('[config] 设置变更回调抛错', e)
    }
  }
  const result = getSettings()
  emit('app:settingsChanged', result)
  return result
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
  runtime = null
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
