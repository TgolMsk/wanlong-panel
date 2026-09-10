/**
 * 环境自检。
 *
 * 目标读者是**用户**，不是开发者：每一条失败都必须给出「我现在该做什么」的中文指引，
 * 而不是把 stderr 原样丢出来。
 *
 * 设计上刻意**不依赖模块 a/b/c**：自检要能在那些模块本身坏掉时照样跑出结论。
 * 所以这里自己 spawn adb / mumutool，自己探依赖是否可解析。
 */

import { spawn } from 'node:child_process'
import { access, constants, statfs, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { INSTANCE_DISK_COST_BYTES } from '@shared/constants'
import { parseMumuEnvelope, mumuInfoReturnSchema } from '@shared/schemas'
import type { AppSettings, HealthCheckItem, HealthReport } from '@shared/domain'
import { getSettings, isSettingsLoaded } from '@main/config'
import { defaultDataDir, resolvePaths } from '@main/paths'

const PROBE_TIMEOUT_MS = 10_000

/**
 * 跑一遍全部自检项。任何一项内部抛错都会被收敛成一条 ok:false 的结果，
 * 整个函数**永不抛异常**——自检自己挂掉是最没用的失败模式。
 */
export async function runHealthCheck(settings?: AppSettings): Promise<HealthReport> {
  const s = settings ?? (isSettingsLoaded() ? getSettings() : null)
  const adbPath = s?.adbPath ?? ''
  const mumutoolPath = s?.mumutoolPath ?? ''
  const dataDir = s ? resolvePaths(s).dataDir : defaultDataDir()

  // 顺序即面板上的显示顺序；后两项依赖前一项的结论，所以不能并发跑。
  const adbBinary = await checkAdbBinary(adbPath)
  const mumutoolBinary = await checkMumutoolBinary(mumutoolPath)
  const items: HealthCheckItem[] = [
    adbBinary,
    await checkAdbServer(adbPath, adbBinary.ok),
    mumutoolBinary,
    await checkMumuService(mumutoolPath, mumutoolBinary.ok),
    await checkDataDir(dataDir),
    checkOpencv(),
    await checkSharp(),
    await checkDiskSpace(dataDir)
  ]

  return {
    ok: items.every((i) => i.ok),
    checkedAt: Date.now(),
    items
  }
}

// ── 各检查项 ──────────────────────────────────────────────────────────────

async function checkAdbBinary(adbPath: string): Promise<HealthCheckItem> {
  const base = { key: 'adbBinary' as const, label: 'adb 可执行文件' }
  if (!adbPath) {
    return { ...base, ok: false, detail: '尚未配置 adb 路径。请到「设置」页填写 adb 的绝对路径。' }
  }
  try {
    await access(adbPath, constants.X_OK)
  } catch {
    return {
      ...base,
      ok: false,
      detail:
        `找不到或无法执行：${adbPath}\n` +
        '系统 PATH 里没有 adb，必须用 MuMu 自带的那一份。默认位置：\n' +
        '/Applications/MuMuPlayer.app/Contents/MacOS/MuMuEmulator.app/Contents/MacOS/tools/adb\n' +
        '如果你把 MuMu 装在别处，请到「设置」页改成实际路径。'
    }
  }
  const r = await run(adbPath, ['version'])
  if (r.code !== 0) {
    return {
      ...base,
      ok: false,
      detail: `adb version 执行失败（退出码 ${r.code}）：${r.stderr.trim() || '无输出'}`
    }
  }
  const line = r.stdout.split('\n')[0]?.trim() ?? ''
  return { ...base, ok: true, detail: `${line}（${adbPath}）` }
}

async function checkAdbServer(adbPath: string, binaryOk: boolean): Promise<HealthCheckItem> {
  const base = { key: 'adbServer' as const, label: 'adb 服务（127.0.0.1:5037）' }
  if (!binaryOk) {
    return { ...base, ok: false, detail: 'adb 可执行文件不可用，先解决上一项。' }
  }
  const r = await run(adbPath, ['start-server'])
  if (r.code !== 0) {
    return {
      ...base,
      ok: false,
      detail:
        `adb start-server 失败（退出码 ${r.code}）：${(r.stderr || r.stdout).trim() || '无输出'}\n` +
        '常见原因是 5037 端口被别的 adb（例如 Android Studio 自带的）占用且版本不一致。\n' +
        '可在终端执行 `adb kill-server` 后重开面板。'
    }
  }
  return { ...base, ok: true, detail: 'adb 服务已在运行。' }
}

async function checkMumutoolBinary(mumutoolPath: string): Promise<HealthCheckItem> {
  const base = { key: 'mumutoolBinary' as const, label: 'MuMu 多实例管理工具' }
  if (!mumutoolPath) {
    return { ...base, ok: false, detail: '尚未配置 mumutool 路径，请到「设置」页填写。' }
  }
  try {
    await access(mumutoolPath, constants.X_OK)
  } catch {
    return {
      ...base,
      ok: false,
      detail:
        `找不到或无法执行：${mumutoolPath}\n` +
        '默认位置：/Applications/MuMuPlayer.app/Contents/MacOS/mumutool\n' +
        '（同目录下的 mumu-cli 内容一致，填哪个都行。）'
    }
  }
  return { ...base, ok: true, detail: mumutoolPath }
}

async function checkMumuService(mumutoolPath: string, binaryOk: boolean): Promise<HealthCheckItem> {
  const base = { key: 'mumuService' as const, label: 'MuMu 实例服务' }
  if (!binaryOk) {
    return { ...base, ok: false, detail: 'mumutool 不可用，先解决上一项。' }
  }
  const r = await run(mumutoolPath, ['info', 'all'])
  if (r.code !== 0) {
    return {
      ...base,
      ok: false,
      detail:
        `mumutool info all 失败（退出码 ${r.code}）：${(r.stderr || r.stdout).trim() || '无输出'}\n` +
        '请先手动打开一次 MuMu 模拟器，让它的后台服务起来，再点重新检测。'
    }
  }
  try {
    // ★ mumutool 业务出错时退出码仍是 0，必须解析 errcode，见 schemas.parseMumuEnvelope。
    const ret = mumuInfoReturnSchema.parse(parseMumuEnvelope(r.stdout))
    const running = ret.results.filter((i) => i.state === 'running').length
    return {
      ...base,
      ok: true,
      detail: `共 ${ret.count} 个实例，其中 ${running} 个正在运行。`
    }
  } catch (e) {
    return {
      ...base,
      ok: false,
      detail:
        `mumutool 返回内容无法解析：${e instanceof Error ? e.message : String(e)}\n` +
        '这通常意味着 MuMu 版本与本面板适配的版本不同，请到「日志」页查看原始输出。'
    }
  }
}

async function checkDataDir(dataDir: string): Promise<HealthCheckItem> {
  const base = { key: 'dataDir' as const, label: '运行数据目录可写' }
  const probe = join(dataDir, '.wl-write-probe')
  try {
    await writeFile(probe, String(Date.now()), 'utf8')
    await unlink(probe)
    return { ...base, ok: true, detail: dataDir }
  } catch (e) {
    return {
      ...base,
      ok: false,
      detail:
        `无法写入：${dataDir}\n${e instanceof Error ? e.message : String(e)}\n` +
        '请到「设置」页换一个有写权限的目录，或修复该目录的权限。'
    }
  }
}

/**
 * 视觉引擎依赖检查。
 *
 * ★ 这里**故意只检查「能否解析到模块」，不去真的初始化 OpenCV**：
 *   getCv() 会把约 100MB 的 WASM 堆常驻进主进程，而主进程根本不做匹配。
 *   真正的初始化在每个 utilityProcess 里各自完成，跑第一个脚本时就会暴露问题。
 */
function checkOpencv(): HealthCheckItem {
  const base = { key: 'opencv' as const, label: '视觉引擎依赖（OpenCV WASM）' }
  try {
    const require_ = createRequire(import.meta.url)
    const entry = require_.resolve('@techstark/opencv-js')
    return {
      ...base,
      ok: true,
      detail: `模块已就位：${entry}\n（实际初始化在脚本执行进程里完成，主进程不加载 WASM。）`
    }
  } catch (e) {
    return {
      ...base,
      ok: false,
      detail:
        `解析 @techstark/opencv-js 失败：${e instanceof Error ? e.message : String(e)}\n` +
        '请在工程目录执行 `npm install` 重新安装依赖。'
    }
  }
}

async function checkSharp(): Promise<HealthCheckItem> {
  const base = { key: 'sharp' as const, label: '图像处理（sharp / libvips）' }
  try {
    const mod = await import('sharp')
    const sharp = (mod.default ?? mod) as unknown as { versions?: Record<string, string> }
    const vips = sharp.versions?.vips ?? '未知版本'
    return { ...base, ok: true, detail: `libvips ${vips}` }
  } catch (e) {
    return {
      ...base,
      ok: false,
      detail:
        `加载 sharp 失败：${e instanceof Error ? e.message : String(e)}\n` +
        '本机应使用 darwin-arm64 预编译包。请执行 `npm install` 重装；\n' +
        '若是打包后的应用报错，检查 electron-builder.yml 的 asarUnpack 是否包含 sharp 与 @img。'
    }
  }
}

async function checkDiskSpace(dataDir: string): Promise<HealthCheckItem> {
  const base = { key: 'diskSpace' as const, label: '磁盘余量' }
  try {
    const st = await statfs(dataDir)
    const available = Number(st.bavail) * Number(st.bsize)
    const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(1)} GB`
    const enough = available >= INSTANCE_DISK_COST_BYTES
    return {
      ...base,
      ok: enough,
      detail: enough
        ? `剩余 ${gb(available)}，够再克隆一个实例（每个约 ${gb(INSTANCE_DISK_COST_BYTES)}）。`
        : `仅剩 ${gb(available)}，不足以再克隆一个实例（每个约需 ${gb(INSTANCE_DISK_COST_BYTES)}）。\n` +
          '请清理磁盘，或删除不用的模拟器实例后重试。'
    }
  } catch (e) {
    return {
      ...base,
      ok: false,
      detail: `读取磁盘信息失败：${e instanceof Error ? e.message : String(e)}`
    }
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────────

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 跑一个外部命令，只用于**小段文本输出**（version / info）。
 * 二进制输出（截图）绝不能走这里，那是模块 b 的 spawn + Buffer.concat 的职责。
 */
function run(bin: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (r: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done({ code: -1, stdout, stderr: `${stderr}\n命令超时（${timeoutMs}ms）：${bin}` })
    }, timeoutMs)

    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString('utf8')
    })
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })
    child.on('error', (e) => done({ code: -1, stdout, stderr: `${stderr}${e.message}` }))
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }))
  })
}
