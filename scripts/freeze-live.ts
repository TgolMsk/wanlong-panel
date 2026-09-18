/**
 * 卡死恢复链路 —— **真机**验证脚本（★ 会真的重启一个模拟器实例）。
 *
 *   npm run live:freeze -- <实例序号>          # 例：npm run live:freeze -- 0
 *
 * 做的事和面板里「卡死看门狗判定之后」做的一模一样（同一个 recoverFrozenInstance）：
 *   重启实例 → 等状态真的变化 → 等 Android 就绪 → 断旧 adb、按现读端口重连 → 等开机完成
 *   → monkey 拉起游戏（失败再试一次）→ 只看不点地等主界面
 * 只是「判定卡死」这一步由你来做 —— 你确认它现在确实卡死了、或者只是想验证这条链路能不能走通。
 *
 * 安全边界：只动指定的那一个实例；不 create / clone / delete；不装卸应用；
 * 开始前有 5 秒倒计时可以 Ctrl+C；跑到一半 Ctrl+C 会通过 AbortSignal 中止流程。
 * 模板从 <工程根>/.wl-data/templates 读（与 live:probe 一致），只用来判「主界面出现了没有」。
 */

import { join } from 'node:path'

import { AppError } from '@shared/errors'
import {
  attach,
  captureRaw,
  detachByIndex,
  foregroundPackage,
  initAdb,
  isBooted,
  isRunning,
  launchViaMonkey
} from '@main/adb/index'
import { bootstrapEmulatorForScripts, getEmulatorDriver, listInstances } from '@main/mumu/index'
import { GAME_PACKAGE, isRecognizableScreen, loadGatherTemplates } from '@main/game/gather'
import {
  FREEZE_STAGE_TEXT,
  recoverFrozenInstance,
  type FreezeRecoveryIo
} from '@main/alerts/freezeRecovery'

const TEMPLATES_DIR = join(process.cwd(), '.wl-data', 'templates')

function hhmmss(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function log(message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info'): void {
  const tag = level === 'error' ? '❌' : level === 'warn' ? '⚠️ ' : level === 'debug' ? ' ·' : '  '
  console.log(`${tag} [${hhmmss(Date.now())}] ${message}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  const arg = (process.argv[2] ?? process.env['WL_INSTANCE'] ?? '').trim()
  if (arg === '' || !Number.isInteger(Number(arg)) || Number(arg) < 0) {
    console.error('用法：npm run live:freeze -- <实例序号>    （★ 会真的重启这个实例）')
    process.exitCode = 2
    return
  }
  const index = Number(arg)

  const env = await bootstrapEmulatorForScripts()
  log(`模拟器驱动 ${env.kind}，CLI=${env.cliPath}，adb=${env.adbPath}（${env.source}）`)
  const driver = getEmulatorDriver()

  const instances = await listInstances()
  const target = instances.find((i) => i.index === index)
  if (!target) {
    throw new Error(
      `实例 ${index} 不存在（当前：${instances.map((i) => `${i.index}「${i.name}」${i.state}`).join('，') || '无实例'}）。`
    )
  }
  log(
    `目标实例 ${index}「${target.name}」：状态 ${target.state}，adb 端口 ${target.adbPort ?? '无'}，pid ${target.pid ?? '无'}`
  )
  if (target.state !== 'running') {
    throw new Error(
      '卡死恢复只处理「运行中」的实例（面板里也是这样：进程不在不算卡死）。要开机请用面板或 MuMu 多开器。'
    )
  }

  await initAdb({ adbPath: env.adbPath })
  const templates = await loadGatherTemplates({
    templatesDir: TEMPLATES_DIR,
    packageName: GAME_PACKAGE,
    onWarn: (m) => log(`模板：${m}`, 'warn')
  })
  log(`模板集 ${templates.setId}：界面模板 ${templates.ui.size} 张（用来判主界面）`)

  console.log(`\n★ 5 秒后开始重启实例 ${index}「${target.name}」，按 Ctrl+C 取消……\n`)
  await sleep(5000)

  const controller = new AbortController()
  process.on('SIGINT', () => {
    log('收到 Ctrl+C，正在中止恢复流程……', 'warn')
    controller.abort()
  })

  const io: FreezeRecoveryIo = {
    restartInstance: () => driver.restart(index),
    instanceState: async () => {
      const i = (await driver.list()).find((x) => x.index === index)
      if (!i) return null
      return {
        processStarted: i.state === 'running' || i.state === 'starting',
        androidStarted: i.screenReady,
        pid: i.pid
      }
    },
    dropDevice: () => detachByIndex(index),
    // ★ 端口按驱动现读（重启后可能变），绝不沿用重启前的。
    attachDevice: async () => {
      const i = (await driver.list()).find((x) => x.index === index)
      if (!i || i.adbPort === null) {
        throw new AppError(
          'ADB_DEVICE_OFFLINE',
          `实例 ${index} 还没有 adb 端口（状态 ${i?.state ?? '不存在'}）。`
        )
      }
      return (await attach(index, i.adbPort)).serial
    },
    isBooted: (serial) => isBooted(serial),
    foreground: (serial) => foregroundPackage(serial),
    // ★ 必须是 monkey：am start 对本游戏返回成功但进程起不来（adb/apps.ts 实测）。
    launchGame: (serial) => launchViaMonkey(serial, GAME_PACKAGE),
    isGameRunning: (serial) => isRunning(serial, GAME_PACKAGE),
    capture: (serial) => captureRaw(serial),
    recognize: (raw) =>
      isRecognizableScreen(templates, raw, {
        refWidth: templates.refWidth,
        refHeight: templates.refHeight
      }),
    log: (level, message) => log(message, level),
    signal: controller.signal
  }

  const r = await recoverFrozenInstance(io, { gamePackage: GAME_PACKAGE })

  console.log('\n===== 结果 =====')
  console.log(
    `  结果：${r.ok ? (r.loaded ? '✅ 恢复成功，主界面已认出' : '✅ 恢复成功，但主界面尚未认出（游戏在前台，面板里会交给采样时的弹窗阶梯）') : '❌ 失败'}`
  )
  if (!r.ok)
    console.log(
      `  卡在：${FREEZE_STAGE_TEXT[r.stage as keyof typeof FREEZE_STAGE_TEXT] ?? r.stage} —— ${r.reason ?? '原因未知'}`
    )
  console.log(`  步骤：${r.steps.join(' → ') || '（无）'}`)
  console.log(`  耗时：${Math.round(r.elapsedMs / 1000)}s；serial：${r.serial ?? '未连上'}`)
  process.exitCode = r.ok ? 0 : 1
}

main().catch((e: unknown) => {
  const err = AppError.from(e)
  log(err.code === 'RUN_ABORTED' ? '已中止。' : `出错：${err.message}`, 'error')
  process.exitCode = 1
})
