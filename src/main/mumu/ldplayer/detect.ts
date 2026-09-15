/**
 * 雷电模拟器安装目录探测（只在 Windows 上有意义）。
 *
 * 顺序：
 *   1. 环境变量 WL_LDPLAYER_DIR（命令行脚本 / 多份安装并存时手动指定）
 *   2. 注册表 HKCU\SOFTWARE\leidian\LDPlayer<N>\InstallDir，再看 HKLM 同路径
 *      （实测本机：HKCU\SOFTWARE\leidian\LDPlayer14 -> InstallDir = D:\leidian\LDPlayer14\，
 *        同级还有 ldmultiplay / wujie 两个键，它们的 InstallDir 不是模拟器目录，要按键名过滤）
 *   3. constants.ts 里的常见目录逐个试
 * 每个候选都要求目录下同时有 ldconsole.exe 与 adb.exe 才算数。
 *
 * 用 `reg.exe query` 而不是原生模块：多一个原生依赖就多一份 Electron 重编译的麻烦。
 * 纯 Node，不 import electron。
 */

import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { LD_ADB_EXE, LD_CLI_EXE, LD_COMMON_INSTALL_DIRS } from '@shared/constants'
import { decodeConsoleText } from './cli'

export interface LdInstall {
  /** 安装目录（无尾部反斜杠）。 */
  dir: string
  cliPath: string
  adbPath: string
  source: 'env' | 'registry' | 'scan'
}

const REG_ROOTS = ['HKCU\\SOFTWARE\\leidian', 'HKLM\\SOFTWARE\\leidian'] as const
const REG_TIMEOUT_MS = 5_000

/** 探测雷电安装目录；探不到返回 null（不抛，调用方决定怎么提示）。 */
export async function detectLdInstall(): Promise<LdInstall | null> {
  if (process.platform !== 'win32') return null

  const fromEnv = (process.env['WL_LDPLAYER_DIR'] ?? '').trim()
  if (fromEnv) {
    const hit = await verifyDir(fromEnv, 'env')
    if (hit) return hit
  }

  for (const dir of await registryCandidates()) {
    const hit = await verifyDir(dir, 'registry')
    if (hit) return hit
  }

  for (const dir of LD_COMMON_INSTALL_DIRS) {
    const hit = await verifyDir(dir, 'scan')
    if (hit) return hit
  }
  return null
}

/** 安装目录 -> 两个可执行文件路径（给设置页「选择文件」后自动补另一个用）。 */
export function ldPathsOf(dir: string): { cliPath: string; adbPath: string } {
  const clean = stripTrailingSlash(dir)
  return { cliPath: join(clean, LD_CLI_EXE), adbPath: join(clean, LD_ADB_EXE) }
}

// ── 内部 ─────────────────────────────────────────────────────────────────

async function verifyDir(dir: string, source: LdInstall['source']): Promise<LdInstall | null> {
  const clean = stripTrailingSlash(dir)
  const { cliPath, adbPath } = ldPathsOf(clean)
  try {
    await access(cliPath, constants.F_OK)
    await access(adbPath, constants.F_OK)
  } catch {
    return null
  }
  return { dir: clean, cliPath, adbPath, source }
}

/**
 * 读注册表里所有 leidian\LDPlayer* 子键的 InstallDir，按版本号从高到低排。
 * `reg query <root> /s /v InstallDir` 的输出形如：
 *   HKEY_CURRENT_USER\SOFTWARE\leidian\LDPlayer14
 *       InstallDir    REG_SZ    D:\leidian\LDPlayer14\
 */
async function registryCandidates(): Promise<string[]> {
  const found: { dir: string; version: number }[] = []
  for (const root of REG_ROOTS) {
    const text = await regQuery(root)
    if (!text) continue
    let currentKey = ''
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd()
      if (/^HKEY_/i.test(line)) {
        currentKey = line.trim()
        continue
      }
      const m = /^\s*InstallDir\s+REG_SZ\s+(.+)$/i.exec(line)
      if (!m || !currentKey) continue
      const keyName = currentKey.split('\\').pop() ?? ''
      const v = /^ldplayer(\d*)$/i.exec(keyName)
      if (!v) continue // ldmultiplay / wujie 等不是模拟器本体
      found.push({ dir: m[1]!.trim(), version: Number.parseInt(v[1] || '0', 10) || 0 })
    }
  }
  found.sort((a, b) => b.version - a.version)
  return [...new Set(found.map((f) => stripTrailingSlash(f.dir)))]
}

function regQuery(root: string): Promise<string> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('reg.exe', ['query', root, '/s', '/v', 'InstallDir'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      })
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
    }, REG_TIMEOUT_MS)
    child.stdout?.on('data', (c: Buffer) => chunks.push(c))
    child.on('error', () => done(''))
    // 键不存在时 reg 退出码 1，输出为空；这里只关心拿到了什么文本。
    child.on('close', () => done(decodeConsoleText(Buffer.concat(chunks)).replace(/\r\n/g, '\n')))
  })
}

function stripTrailingSlash(p: string): string {
  return p.replace(/[\\/]+$/, '')
}
