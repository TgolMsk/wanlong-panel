/**
 * 应用相关：列表、前台包名、启动入口解析、启停、安装。
 *
 * 一条通用原则：**能合并进一次 shell 就合并**。
 * 实测单次 adb 往返 17~20ms，其中 ~14ms 纯粹是 adb 进程启动开销；
 * 5 条命令分开发是 103ms，合并成一条 shell 是 34ms。
 *
 * 纯 Node，不 import electron。
 */

import { access } from 'node:fs/promises'
import { ADB_TIMEOUT_MS } from '@shared/constants'
import type { AppInfo } from '@shared/domain'
import { AppError } from '@shared/errors'
import { adb, decodeText, shell, shellRaw } from './exec'
import { enqueue } from './queue'

/** 安装大包可能很慢，单独给一个宽松超时。 */
const INSTALL_TIMEOUT_MS = 300_000

/** `pkg` -> `pkg/.Activity` 的解析结果缓存，key 是 `${serial}|${pkg}`。 */
const launchComponents = new Map<string, string>()

/** 包名合法性校验，顺带挡掉命令注入（这些字符串会被拼进 shell 命令行）。 */
const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/

function assertPackage(pkg: string): string {
  const p = (pkg ?? '').trim()
  if (!PKG_RE.test(p)) {
    throw new AppError('INVALID_ARGUMENT', `不是合法的包名：「${pkg}」`, { packageName: pkg })
  }
  return p
}

/** 断开设备时清掉该设备的解析缓存。 */
export function clearAppCache(serial: string): void {
  for (const key of [...launchComponents.keys()]) {
    if (key.startsWith(`${serial}|`)) launchComponents.delete(key)
  }
}

// ── 列表 ──────────────────────────────────────────────────────────────────

const PS_MARKER = '===WL-PS==='

/**
 * 列出第三方应用（pm list packages -3），并顺带标出哪些正在跑。
 * 一次 shell 往返搞定：包列表 + 进程名列表（应用进程名默认等于包名）。
 * label / versionName 需要逐包 dumpsys，太贵，这里不取；需要时用 describeApp。
 */
export async function listUserApps(serial: string): Promise<AppInfo[]> {
  const text = await enqueue(serial, () =>
    shell(serial, `pm list packages -3; echo '${PS_MARKER}'; ps -A -o NAME 2>/dev/null`)
  )

  const [pkgPart = '', psPart = ''] = text.split(PS_MARKER)
  const running = new Set(
    psPart
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  )

  const apps: AppInfo[] = []
  for (const line of pkgPart.split('\n')) {
    const m = /^package:(\S+)$/.exec(line.trim())
    if (!m) continue
    const packageName = m[1]!
    apps.push({ packageName, running: running.has(packageName) })
  }
  apps.sort((a, b) => a.packageName.localeCompare(b.packageName))
  return apps
}

/** 某个包是否已安装（pm path 找不到时退出码非 0，属正常答案，不抛错）。 */
export async function isPackageInstalled(serial: string, pkg: string): Promise<boolean> {
  const p = assertPackage(pkg)
  const r = await enqueue(serial, () => shellRaw(serial, `pm path ${p}`))
  return r.code === 0 && /package:/.test(r.text)
}

/** 取单个应用的详细信息（版本号 + 启动入口 + 是否在跑）。 */
export async function describeApp(serial: string, pkg: string): Promise<AppInfo> {
  const p = assertPackage(pkg)
  return enqueue(serial, async () => {
    // 用 shellRaw：grep / pidof 找不到东西时退出码非 0，那是正常答案不是错误。
    const r = await shellRaw(
      serial,
      `dumpsys package ${p} | grep -m1 versionName; echo '${PS_MARKER}'; pidof ${p} 2>/dev/null`
    )
    const [verPart = '', pidPart = ''] = r.text.split(PS_MARKER)
    const versionName = /versionName=(\S+)/.exec(verPart)?.[1]
    let launchComponent: string | undefined
    try {
      launchComponent = await resolveLaunchComponent(serial, p)
    } catch {
      // 没有启动入口（纯服务/库应用）不算错误，留空即可。
      launchComponent = undefined
    }
    return {
      packageName: p,
      versionName,
      launchComponent,
      running: pidPart.trim().length > 0
    }
  })
}

// ── 前台包名 ──────────────────────────────────────────────────────────────

/** 从 `mCurrentFocus=Window{... u0 com.foo/com.foo.MainActivity}` 里抠包名。 */
const FOCUS_RE = /\bu0\s+([A-Za-z0-9_.]+)\//

/**
 * 当前前台包名，取不到返回 null（锁屏 / 桌面切换瞬间都可能取不到，不算错误）。
 */
export async function foregroundPackage(serial: string): Promise<string | null> {
  return enqueue(serial, async () => {
    const a = await shellRaw(serial, 'dumpsys window displays | grep -m1 mCurrentFocus')
    const hit = FOCUS_RE.exec(a.text)
    if (hit) return hit[1]!

    // 兜底：部分场景 mCurrentFocus 是 null（例如刚亮屏），改看 mResumedActivity。
    // ★ Android 14（雷电 14）的 dumpsys 里已经没有 mResumedActivity 这一行了，只有 topResumedActivity，
    //   两个都匹配；主路径 mCurrentFocus 在 Android 12 / 14 上都实测可用。
    const b = await shellRaw(
      serial,
      'dumpsys activity activities | grep -m1 -E "mResumedActivity|topResumedActivity"'
    )
    const hit2 = FOCUS_RE.exec(b.text)
    return hit2 ? hit2[1]! : null
  })
}

// ── 启动入口 ──────────────────────────────────────────────────────────────

const COMPONENT_RE = /^[A-Za-z][A-Za-z0-9_.]*\/[A-Za-z0-9_.$]+$/

/**
 * 解析冷启动用的 `pkg/Activity`。结果按 serial+pkg 缓存（应用不重装就不会变）。
 */
export async function resolveLaunchComponent(serial: string, pkg: string): Promise<string> {
  const p = assertPackage(pkg)
  const key = `${serial}|${p}`
  const cached = launchComponents.get(key)
  if (cached) return cached

  const out = await enqueue(serial, () =>
    shell(serial, `cmd package resolve-activity --brief ${p}`)
  )
  // 典型输出两行：第一行是 priority=... 之类的元信息，最后一行才是 component。
  const last = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()

  if (!last || !COMPONENT_RE.test(last) || last.startsWith('android/')) {
    throw new AppError(
      'NOT_FOUND',
      `找不到 ${p} 的启动入口（应用可能未安装，或它没有 LAUNCHER 界面）。adb 返回：${out.trim() || '空'}`,
      { serial, packageName: p, output: out }
    )
  }
  launchComponents.set(key, last)
  return last
}

// ── 启停 ──────────────────────────────────────────────────────────────────

/** 冷启动：先 force-stop 保证是全新进程，再 am start。两条命令合并成一次往返。 */
export async function coldStart(serial: string, pkg: string): Promise<void> {
  const p = assertPackage(pkg)
  await enqueue(serial, async () => {
    const comp = await resolveLaunchComponent(serial, p)
    const out = await shell(
      serial,
      `am force-stop ${p}; am start -W -n ${comp}`,
      ADB_TIMEOUT_MS * 2
    )
    assertAmOk(serial, p, out)
  })
}

/** 启动应用。cold=true 走冷启动；否则把已有任务拉到前台。 */
export async function launch(serial: string, pkg: string, cold = false): Promise<void> {
  const p = assertPackage(pkg)
  if (cold) {
    await coldStart(serial, p)
    return
  }
  await enqueue(serial, async () => {
    const comp = await resolveLaunchComponent(serial, p)
    const out = await shell(serial, `am start -n ${comp}`, ADB_TIMEOUT_MS * 2)
    assertAmOk(serial, p, out)
  })
}

/** am start 即使失败退出码也可能是 0，只能看输出里有没有 Error。 */
function assertAmOk(serial: string, pkg: string, out: string): void {
  if (/^\s*Error:/m.test(out) || /Activity not started/i.test(out)) {
    throw new AppError('ADB_COMMAND_FAILED', `启动 ${pkg} 失败：${out.trim()}`, {
      serial,
      packageName: pkg,
      output: out
    })
  }
}

/**
 * 用 monkey 拉起应用。
 * ★ 《万龙觉醒》实测：`am start -n …` 返回成功但进程根本起不来；
 *   `mumutool control --action open_app` 本版本不可用（errcode 42000）；只有 monkey 有效。
 *   需要「顶号后重启游戏」这类恢复动作时一律走这里，不要用 launch()/coldStart()。
 */
export async function launchViaMonkey(serial: string, pkg: string): Promise<void> {
  const p = assertPackage(pkg)
  const out = await shell(
    serial,
    `monkey -p ${p} -c android.intent.category.LAUNCHER 1`,
    ADB_TIMEOUT_MS * 3
  )
  if (/No activities found|Error|Exception/i.test(out)) {
    throw new AppError('ADB_COMMAND_FAILED', `monkey 启动 ${p} 失败：${out.trim().slice(0, 200)}`, {
      packageName: p
    })
  }
}

export async function forceStop(serial: string, pkg: string): Promise<void> {
  const p = assertPackage(pkg)
  await enqueue(serial, () => shell(serial, `am force-stop ${p}`))
}

/** 进程在不在。pidof 找不到时退出码非 0，属正常答案。 */
export async function isRunning(serial: string, pkg: string): Promise<boolean> {
  const p = assertPackage(pkg)
  const r = await enqueue(serial, () => shellRaw(serial, `pidof ${p}`))
  return r.code === 0 && r.text.trim().length > 0
}

// ── 安装 ──────────────────────────────────────────────────────────────────

/**
 * 安装 apk（-r 覆盖安装，-g 预授权运行时权限）。
 * 走 `adb install`（不是 shell pm install），apk 路径作为独立 argv 传给 spawn，
 * 所以路径里有空格也不用转义。
 */
export async function installApk(serial: string, apkPath: string): Promise<void> {
  const p = (apkPath ?? '').trim()
  if (!p) throw new AppError('INVALID_ARGUMENT', 'apk 路径不能为空。')
  try {
    await access(p)
  } catch {
    throw new AppError('NOT_FOUND', `找不到安装包文件：${p}`, { apkPath: p })
  }

  await enqueue(serial, async () => {
    const first = await adb(serial, ['install', '-r', '-g', p], INSTALL_TIMEOUT_MS)
    if (isInstallOk(first.code, installText(first.stdout, first.stderr))) return

    // 有些 apk 不接受 -g（老 targetSdk），退回不带 -g 再试一次。
    const second = await adb(serial, ['install', '-r', p], INSTALL_TIMEOUT_MS)
    const text = installText(second.stdout, second.stderr)
    if (isInstallOk(second.code, text)) return

    throw new AppError('ADB_COMMAND_FAILED', `安装 apk 失败：${text.trim() || '无输出'}`, {
      serial,
      apkPath: p,
      code: second.code,
      output: text
    })
  })
}

function installText(stdout: Uint8Array, stderr: string): string {
  return `${decodeText(stdout)}\n${stderr}`.trim()
}

/** adb install 老版本会「退出码 0 但输出 Failure」，两边都要看。 */
function isInstallOk(code: number, text: string): boolean {
  if (/Failure|INSTALL_FAILED|Error:/i.test(text)) return false
  return code === 0 && /Success/i.test(text)
}
