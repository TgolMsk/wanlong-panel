/**
 * Windows 版 MuMu 模拟器安装目录探测。
 *
 * 顺序：
 *   1. 环境变量 WL_MUMU_DIR（命令行脚本 / 多份安装并存时手动指定）
 *   2. 卸载注册表 HKLM/HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MuMuPlayer[-12.0]\InstallLocation
 *      （实测本机：HKLM\...\Uninstall\MuMuPlayer -> InstallLocation = D:\tool\MuMuPlayer；
 *        HKCU\SOFTWARE\Netease\MuMuPlayer 底下只有 uuid / 版本号，没有路径）
 *   3. constants.ts 里的常见目录逐个试
 *   4. 正在运行的 MuMu 进程（MuMuNxMain.exe / MuMuPlayer.exe）的可执行文件位置往上找一级
 * 每个候选目录都要求 nx_main\ 或 shell\ 下同时有 MuMuManager.exe 与 adb.exe 才算数
 * （新一代 6.x 是 nx_main，MuMu 12 是 shell）；用户直接指到 nx_main 本身也接受。
 *
 * 用 `reg.exe query` / `powershell.exe` 而不是原生模块：多一个原生依赖就多一份 Electron 重编译的麻烦。
 * 纯 Node，不 import electron。
 */

import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  MUMU_WIN_ADB_EXE,
  MUMU_WIN_BIN_SUBDIRS,
  MUMU_WIN_CLI_EXE,
  MUMU_WIN_COMMON_INSTALL_DIRS
} from '@shared/constants'
import { decodeConsoleText } from '../console'

export interface MumuWinInstall {
  /** 安装目录（无尾部反斜杠），例如 D:\tool\MuMuPlayer。 */
  dir: string
  /** 放可执行文件的子目录，例如 D:\tool\MuMuPlayer\nx_main。 */
  binDir: string
  cliPath: string
  adbPath: string
  source: 'env' | 'registry' | 'scan' | 'process'
}

const REG_UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MuMuPlayer',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MuMuPlayer',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MuMuPlayer',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MuMuPlayer-12.0',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MuMuPlayer-12.0',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MuMuPlayer-12.0'
] as const
const PROCESS_NAMES = ['MuMuNxMain', 'MuMuNxService', 'MuMuPlayer', 'MuMuVMMHeadless'] as const
const PROBE_TIMEOUT_MS = 5_000

/** 探测 MuMu 安装目录；探不到返回 null（不抛，调用方决定怎么提示）。 */
export async function detectMumuWinInstall(): Promise<MumuWinInstall | null> {
  if (process.platform !== 'win32') return null

  const fromEnv = (process.env['WL_MUMU_DIR'] ?? '').trim()
  if (fromEnv) {
    const hit = await verifyDir(fromEnv, 'env')
    if (hit) return hit
  }

  for (const dir of await registryCandidates()) {
    const hit = await verifyDir(dir, 'registry')
    if (hit) return hit
  }

  for (const dir of MUMU_WIN_COMMON_INSTALL_DIRS) {
    const hit = await verifyDir(dir, 'scan')
    if (hit) return hit
  }

  const exe = await runningProcessPath()
  if (exe) {
    // D:\tool\MuMuPlayer\nx_main\MuMuNxMain.exe -> 安装目录是可执行文件所在目录的上一级
    const hit =
      (await verifyDir(dirname(dirname(exe)), 'process')) ??
      (await verifyDir(dirname(exe), 'process'))
    if (hit) return hit
  }
  return null
}

/**
 * 安装目录 -> 候选的可执行文件位置（给设置页「选择文件」后自动补另一个、以及探测用）。
 * 顺序：<dir>\nx_main、<dir>\shell、<dir> 本身（用户直接指到了 nx_main）。
 */
export function mumuWinPathsOf(
  dir: string
): { binDir: string; cliPath: string; adbPath: string }[] {
  const clean = stripTrailingSlash(dir)
  const binDirs = [...MUMU_WIN_BIN_SUBDIRS.map((s) => join(clean, s)), clean]
  return binDirs.map((binDir) => ({
    binDir,
    cliPath: join(binDir, MUMU_WIN_CLI_EXE),
    adbPath: join(binDir, MUMU_WIN_ADB_EXE)
  }))
}

/**
 * 从 `reg query <key> /v InstallLocation` 的输出里抠出目录（纯函数，离线自检用）。输出形如：
 *   HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MuMuPlayer
 *       InstallLocation    REG_SZ    D:\tool\MuMuPlayer
 */
export function parseRegInstallLocations(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const m = /^\s*InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i.exec(raw.trimEnd())
    if (m) {
      const dir = stripTrailingSlash(m[1]!.trim().replace(/^"|"$/g, ''))
      if (dir) out.push(dir)
    }
  }
  return [...new Set(out)]
}

// ── 内部 ─────────────────────────────────────────────────────────────────

async function verifyDir(
  dir: string,
  source: MumuWinInstall['source']
): Promise<MumuWinInstall | null> {
  const clean = stripTrailingSlash(dir)
  if (!clean) return null
  for (const c of mumuWinPathsOf(clean)) {
    try {
      await access(c.cliPath, constants.F_OK)
      await access(c.adbPath, constants.F_OK)
    } catch {
      continue
    }
    // 用户直接指到 nx_main 时，安装目录取它的上一级，方便文案显示。
    const installDir = c.binDir === clean ? dirname(clean) : clean
    return { dir: installDir, binDir: c.binDir, cliPath: c.cliPath, adbPath: c.adbPath, source }
  }
  return null
}

async function registryCandidates(): Promise<string[]> {
  const found: string[] = []
  for (const key of REG_UNINSTALL_KEYS) {
    const text = await runProbe('reg.exe', ['query', key, '/v', 'InstallLocation'])
    if (!text) continue
    found.push(...parseRegInstallLocations(text))
  }
  return [...new Set(found)]
}

/** 正在跑的 MuMu 进程的可执行文件路径；没有就空串。 */
async function runningProcessPath(): Promise<string> {
  const script =
    `Get-Process ${PROCESS_NAMES.join(',')} -ErrorAction SilentlyContinue | ` +
    'Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path'
  const text = await runProbe('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ])
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /\.exe$/i.test(l))
  return line ?? ''
}

function runProbe(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      resolve('')
      return
    }
    const chunks: Buffer[] = []
    let settled = false
    const done = (s: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(s)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done('')
    }, PROBE_TIMEOUT_MS)
    child.stdout?.on('data', (c: Buffer) => chunks.push(c))
    child.on('error', () => done(''))
    // 键不存在时 reg 退出码 1、输出为空；这里只关心拿到了什么文本。
    child.on('close', () => done(decodeConsoleText(Buffer.concat(chunks)).replace(/\r\n/g, '\n')))
  })
}

function stripTrailingSlash(p: string): string {
  return p.replace(/[\\/]+$/, '')
}
