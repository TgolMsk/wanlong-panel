/**
 * 环境自检。
 *
 * 目标读者是**用户**，不是开发者：每一条失败都必须给出「我现在该做什么」的中文指引，
 * 而不是把 stderr 原样丢出来。
 *
 * 设计上刻意**不依赖模块 a/b/c 的运行时对象**：自检要能在那些模块本身坏掉时照样跑出结论。
 * 所以这里自己 spawn adb / ldconsole / mumutool，自己探依赖是否可解析；
 * 只复用两个**纯函数**解析器（parseLdList2 / parseMumuEnvelope），它们不持有任何状态。
 *
 * 按 AppSettings.emulator 与平台分三套文案：Windows + 雷电（ldconsole.exe）、Windows + MuMu（MuMuManager.exe）、
 * macOS + MuMu（mumutool）。
 */

import { spawn } from 'node:child_process'
import { access, constants, statfs, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { INSTANCE_DISK_COST_BYTES } from '@shared/constants'
import { parseMumuEnvelope, mumuInfoReturnSchema } from '@shared/schemas'
import type { AppSettings, EmulatorKind, HealthCheckItem, HealthReport } from '@shared/domain'
import { getSettings, isSettingsLoaded } from '@main/config'
import { decodeConsoleText, isLdUsageText } from '@main/mumu/ldplayer/cli'
import { parseLdList2 } from '@main/mumu/ldplayer/parse'
import { isMumuWinUsageText } from '@main/mumu/mumuwin/cli'
import { parseMumuWinInfo, parseMumuWinResolutions } from '@main/mumu/mumuwin/parse'
import { defaultDataDir, resolvePaths } from '@main/paths'

const PROBE_TIMEOUT_MS = 10_000

const IS_WIN = process.platform === 'win32'

/**
 * 跑一遍全部自检项。任何一项内部抛错都会被收敛成一条 ok:false 的结果，
 * 整个函数**永不抛异常**——自检自己挂掉是最没用的失败模式。
 */
export async function runHealthCheck(settings?: AppSettings): Promise<HealthReport> {
  const s = settings ?? (isSettingsLoaded() ? getSettings() : null)
  const kind: EmulatorKind = s?.emulator ?? 'mumu'
  const adbPath = s?.adbPath ?? ''
  const cliPath = s?.mumutoolPath ?? ''
  const dataDir = s ? resolvePaths(s).dataDir : defaultDataDir()
  const ref = s ? { w: s.refWidth, h: s.refHeight } : null

  // 顺序即面板上的显示顺序；后两项依赖前一项的结论，所以不能并发跑。
  const adbBinary = await checkAdbBinary(adbPath, kind)
  const cliBinary = await checkCliBinary(cliPath, kind)
  const items: HealthCheckItem[] = [
    adbBinary,
    await checkAdbServer(adbPath, adbBinary.ok),
    cliBinary,
    kind === 'ldplayer'
      ? await checkLdService(cliPath, cliBinary.ok, ref)
      : IS_WIN
        ? await checkMumuWinService(cliPath, cliBinary.ok, ref)
        : await checkMumuService(cliPath, cliBinary.ok),
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

function adbHint(kind: EmulatorKind): string {
  if (kind === 'ldplayer') {
    return (
      '系统 PATH 里没有 adb，必须用雷电自带的那一份：<雷电安装目录>\\adb.exe（本机默认 D:\\leidian\\LDPlayer14\\adb.exe）。\n' +
      '面板启动时会按注册表 HKCU\\SOFTWARE\\leidian\\LDPlayer* 自动探测；探不到请到「设置」页手动选择。'
    )
  }
  if (IS_WIN) {
    return (
      '系统 PATH 里没有 adb，必须用 MuMu 自带的那一份：<MuMu 安装目录>\\nx_main\\adb.exe（MuMu 12 是 \\shell\\adb.exe；本机 D:\\tool\\MuMuPlayer\\nx_main\\adb.exe）。\n' +
      '面板启动时会按卸载注册表 Uninstall\\MuMuPlayer\\InstallLocation 自动探测；探不到请到「设置」页手动选择。'
    )
  }
  return (
    '系统 PATH 里没有 adb，必须用 MuMu 自带的那一份。默认位置：\n' +
    '/Applications/MuMuPlayer.app/Contents/MacOS/MuMuEmulator.app/Contents/MacOS/tools/adb\n' +
    '如果你把 MuMu 装在别处，请到「设置」页改成实际路径。'
  )
}

async function checkAdbBinary(adbPath: string, kind: EmulatorKind): Promise<HealthCheckItem> {
  const base = { key: 'adbBinary' as const, label: 'adb 可执行文件' }
  if (!adbPath) {
    return { ...base, ok: false, detail: `尚未配置 adb 路径。\n${adbHint(kind)}` }
  }
  try {
    await access(adbPath, constants.X_OK)
  } catch {
    return { ...base, ok: false, detail: `找不到或无法执行：${adbPath}\n${adbHint(kind)}` }
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
        '常见原因是 5037 端口被别的 adb（例如 Android Studio 自带的、或另一个模拟器的）占用且版本不一致。\n' +
        (IS_WIN
          ? '可在 PowerShell 里执行 `taskkill /F /IM adb.exe` 后重开面板。'
          : '可在终端执行 `adb kill-server` 后重开面板。')
    }
  }
  return { ...base, ok: true, detail: 'adb 服务已在运行。' }
}

async function checkCliBinary(cliPath: string, kind: EmulatorKind): Promise<HealthCheckItem> {
  const base = {
    key: 'mumutoolBinary' as const,
    label:
      kind === 'ldplayer'
        ? '雷电 ldconsole.exe'
        : IS_WIN
          ? 'MuMu MuMuManager.exe'
          : 'MuMu 多实例管理工具'
  }
  const hint =
    kind === 'ldplayer'
      ? '雷电的命令行管理工具在安装目录下：<雷电安装目录>\\ldconsole.exe（本机默认 D:\\leidian\\LDPlayer14\\ldconsole.exe）。\n' +
        '面板启动时会按注册表自动探测；探不到请到「设置」页手动选择。'
      : IS_WIN
        ? 'MuMu 的命令行管理工具在安装目录下：<MuMu 安装目录>\\nx_main\\MuMuManager.exe（MuMu 12 是 \\shell\\MuMuManager.exe；本机 D:\\tool\\MuMuPlayer\\nx_main）。\n' +
          '面板启动时会按卸载注册表自动探测；探不到请到「设置」页手动选择。'
        : '默认位置：/Applications/MuMuPlayer.app/Contents/MacOS/mumutool\n' +
          '（同目录下的 mumu-cli 内容一致，填哪个都行。）'
  if (!cliPath) {
    return { ...base, ok: false, detail: `尚未配置路径。\n${hint}` }
  }
  try {
    await access(cliPath, constants.X_OK)
  } catch {
    return { ...base, ok: false, detail: `找不到或无法执行：${cliPath}\n${hint}` }
  }
  return { ...base, ok: true, detail: cliPath }
}

/**
 * 雷电：跑一次 `ldconsole list2`。
 * ★ ldconsole 的退出码不可靠（见 ldplayer/cli.ts），这里只看输出：解析得出实例就算通；
 *   顺手对照参考分辨率，实例分辨率不一致时给出提醒（不判失败，只是提醒——可能是用户不用的实例）。
 */
async function checkLdService(
  cliPath: string,
  binaryOk: boolean,
  ref: { w: number; h: number } | null
): Promise<HealthCheckItem> {
  const base = { key: 'mumuService' as const, label: '雷电实例列表（ldconsole list2）' }
  if (!binaryOk) {
    return { ...base, ok: false, detail: 'ldconsole.exe 不可用，先解决上一项。' }
  }
  const r = await run(cliPath, ['list2'])
  const text = `${r.stdout}\n${r.stderr}`.trim()
  if (isLdUsageText(text)) {
    return {
      ...base,
      ok: false,
      detail:
        'ldconsole 不认识 list2 命令（打印了用法说明）。这意味着雷电版本与本面板适配的版本不同，\n' +
        '请到「日志」页查看原始输出。'
    }
  }
  const raws = parseLdList2(r.stdout)
  if (raws.length === 0) {
    return {
      ...base,
      ok: false,
      detail:
        `ldconsole list2 没有返回任何实例${text ? `：${text.slice(0, 200)}` : '（输出为空）'}\n` +
        '请先打开一次雷电多开器，确认里面至少有一个实例；或检查 ldconsole.exe 路径是否指向了正确的雷电版本。'
    }
  }
  const running = raws.filter((i) => i.pid !== null && i.androidStarted).length
  const starting = raws.filter((i) => i.pid !== null && !i.androidStarted).length
  const lines = [
    `共 ${raws.length} 个实例，${running} 个正在运行${starting ? `，${starting} 个启动中` : ''}。`
  ]
  if (ref) {
    const off = raws.filter(
      (i) => i.width !== null && i.height !== null && (i.width !== ref.w || i.height !== ref.h)
    )
    if (off.length > 0) {
      lines.push(
        `⚠ ${off.map((i) => `实例 ${i.index}「${i.title}」${i.width}×${i.height}`).join('、')} ` +
          `与参考分辨率 ${ref.w}×${ref.h} 不一致，模板在这些实例上会错位。` +
          '在雷电多开器里把分辨率改成自定义 2560×1440、DPI 360 再重启实例。'
      )
    }
  }
  return { ...base, ok: true, detail: lines.join('\n') }
}

/**
 * Windows 版 MuMu：跑一次 `MuMuManager.exe info -v all`（JSON），再顺手读一次分辨率对照参考分辨率。
 * 业务错误时 errcode 非 0 且退出码 = errcode（见 mumuwin/cli.ts）；MuMu 后台服务没起来也会在这里失败。
 */
async function checkMumuWinService(
  cliPath: string,
  binaryOk: boolean,
  ref: { w: number; h: number } | null
): Promise<HealthCheckItem> {
  const base = { key: 'mumuService' as const, label: 'MuMu 实例列表（MuMuManager info）' }
  if (!binaryOk) {
    return { ...base, ok: false, detail: 'MuMuManager.exe 不可用，先解决上一项。' }
  }
  const r = await run(cliPath, ['info', '-v', 'all'])
  const text = `${r.stdout}\n${r.stderr}`.trim()
  if (isMumuWinUsageText(text)) {
    return {
      ...base,
      ok: false,
      detail:
        'MuMuManager 不认识 info -v all（打印了用法说明）。这意味着 MuMu 版本与本面板适配的版本（6.6.4）不同，\n' +
        '请到「日志」页查看原始输出。'
    }
  }
  let json: unknown
  try {
    json = JSON.parse(r.stdout.trim() || '{}')
  } catch {
    return {
      ...base,
      ok: false,
      detail:
        `MuMuManager info 返回的不是 JSON（退出码 ${r.code}）：${text.slice(0, 200) || '无输出'}\n` +
        '请先手动打开一次 MuMu 多开器，让它的后台服务起来，再点重新检测。'
    }
  }
  const envelope = json as { errcode?: unknown; errmsg?: unknown } | null
  if (
    envelope &&
    typeof envelope === 'object' &&
    'errcode' in envelope &&
    Number(envelope.errcode) !== 0
  ) {
    return {
      ...base,
      ok: false,
      detail:
        `MuMuManager info 失败（errcode ${String(envelope.errcode)}）：${String(envelope.errmsg ?? '') || '无说明'}\n` +
        '请先手动打开一次 MuMu 多开器，让它的后台服务起来，再点重新检测。'
    }
  }
  let raws: ReturnType<typeof parseMumuWinInfo>
  try {
    raws = parseMumuWinInfo(json)
  } catch (e) {
    return {
      ...base,
      ok: false,
      detail:
        `MuMuManager 返回内容无法解析：${e instanceof Error ? e.message : String(e)}\n` +
        '这通常意味着 MuMu 版本与本面板适配的版本不同，请到「日志」页查看原始输出。'
    }
  }
  if (raws.length === 0) {
    return {
      ...base,
      ok: false,
      detail:
        'MuMuManager info 没有返回任何实例。请先打开一次 MuMu 多开器，确认里面至少有一个实例。'
    }
  }
  const running = raws.filter((i) => i.processStarted && i.androidStarted).length
  const starting = raws.filter((i) => i.processStarted && !i.androidStarted).length
  const lines = [
    `共 ${raws.length} 个实例，${running} 个正在运行${starting ? `，${starting} 个启动中` : ''}。`
  ]
  if (ref) {
    const rr = await run(cliPath, [
      'setting',
      '-v',
      'all',
      '-k',
      'resolution_width',
      '-k',
      'resolution_height',
      '-k',
      'resolution_dpi'
    ])
    let resJson: unknown = null
    try {
      resJson = JSON.parse(rr.stdout.trim() || '{}')
    } catch {
      // 读不到分辨率就不提示，不影响结论
    }
    const res = parseMumuWinResolutions(resJson, raws.length === 1 ? raws[0]!.index : undefined)
    const off = raws.filter((i) => {
      const x = res.get(i.index)
      return x !== undefined && (x.width !== ref.w || x.height !== ref.h)
    })
    if (off.length > 0) {
      lines.push(
        `⚠ ${off
          .map((i) => {
            const x = res.get(i.index)!
            return `实例 ${i.index}「${i.name}」${x.width}×${x.height}`
          })
          .join('、')} 与参考分辨率 ${ref.w}×${ref.h} 不一致，模板在这些实例上会错位。` +
          '在 MuMu 多开器里把分辨率改成自定义 2560×1440、DPI 360 再重启实例，或在实例页「写入配置」填 {"resolution":"2560,1440,360"}。'
      )
    }
  }
  return { ...base, ok: true, detail: lines.join('\n') }
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
        `本机应使用 ${process.platform}-${process.arch} 预编译包（@img/sharp-${process.platform}-${process.arch}）。请执行 \`npm install\` 重装；\n` +
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
 * 跑一个外部命令，只用于**小段文本输出**（version / info / list2）。
 * 二进制输出（截图）绝不能走这里，那是模块 b 的 spawn + Buffer.concat 的职责。
 * 输出用 decodeConsoleText 解码：ldconsole 是 GBK，adb / mumutool 是 UTF-8，它两种都认。
 */
function run(bin: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    const done = (code: number, extraErr = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        stdout: decodeConsoleText(Buffer.concat(out)).replace(/\r\n/g, '\n'),
        stderr: `${decodeConsoleText(Buffer.concat(err))}${extraErr}`.replace(/\r\n/g, '\n')
      })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done(-1, `\n命令超时（${timeoutMs}ms）：${bin}`)
    }, timeoutMs)

    child.stdout?.on('data', (b: Buffer) => out.push(b))
    child.stderr?.on('data', (b: Buffer) => err.push(b))
    child.on('error', (e) => done(-1, e.message))
    child.on('close', (code) => done(code ?? -1))
  })
}
