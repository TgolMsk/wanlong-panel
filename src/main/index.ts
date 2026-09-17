/**
 * Electron 主进程入口。
 *
 * 职责边界（务必遵守）：主进程只做 **窗口 + 编排 + IPC 转发**。
 * 绝不在这里跑截图循环、模板匹配、脚本执行 —— 那些一律进 utilityProcess（out/main/runner.js）。
 * 实测在主线程跑一次 matchTemplate 会让事件循环卡 71.8ms，面板肉眼可见掉帧。
 *
 * 启动顺序（不要随意调换）：
 *   loadSettings -> resolvePaths + ensureDirs -> 把路径推给模块 a/b/c/d
 *   -> initAdb（含 adb start-server）-> 实例轮询开跑 -> 注册全部 IPC handler
 *   -> 建窗口 -> 渲染进程加载完后异步跑一次环境自检
 */

import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'

import { GLOBAL_ADB_CONCURRENCY } from '@shared/constants'
import { AppError } from '@shared/errors'
import type { AppSettings, ResolvedPaths } from '@shared/domain'
import type { LogLevel, RunSnapshot, RunStatus } from '@shared/script'

import { emit, resetIpc } from '@main/ipc'
import {
  getRuntimeSettings as getSettings,
  getSettings as getSavedSettings,
  loadSettings,
  onSettingsChanged,
  saveSettings
} from '@main/config'
import { selectDataContext } from '@main/dataContext'
import { ensureDirs, resolvePaths, resourcesDir } from '@main/paths'
import { runHealthCheck } from '@main/health'
import { registerAllHandlers } from '@main/handlers/index'
import { ensureDevice, rawFrameToShot, toArrayBuffer, toDevicePoint } from '@main/handlers/device'
import type {
  AccountStorePort,
  AdbPort,
  LogStorePort,
  MainDeps,
  MumuPort,
  OrchestratorPort,
  ScriptStorePort,
  VisionPort
} from '@main/handlers/index'

// ── 模块 a：模拟器驱动（雷电 / MuMu）+ 实例注册表 ─────────────────────────
import { configureEmulator, createRegistry, getEmulatorDriver } from '@main/mumu/index'

// ── 模块 b：adb 通道 ──────────────────────────────────────────────────────
import {
  attach as adbAttach,
  captureRaw,
  detachAll,
  detachByIndex,
  forceStop,
  foregroundPackage,
  getCachedByIndex,
  initAdb,
  installApk,
  key as adbKey,
  launch,
  listUserApps,
  refreshDeviceInfo,
  setAdbPath,
  setMinCaptureInterval,
  setupChineseIme,
  swipe,
  tap,
  typeText
} from '@main/adb/index'

// ── 模块 c：视觉引擎 ──────────────────────────────────────────────────────
import {
  createSet as visionCreateSet,
  deleteTemplate as visionDeleteTemplate,
  listSets as visionListSets,
  listTemplates as visionListTemplates,
  loadPrepared,
  matchIn,
  prepareFrame,
  readTemplateImage,
  renderAlphaPreview,
  saveTemplate as visionSaveTemplate,
  setTemplatesDir
} from '@vision/index'

// ── 模块 d：磁盘存储 ──────────────────────────────────────────────────────
import {
  bindAccount,
  completeLoginAccount,
  deleteAccount,
  listAccounts,
  prepareLoginAccount,
  saveAccount
} from '@main/store/accounts'
import { InstanceProvisioner } from '@main/instanceProvisioner'
import { AccountLoginCoordinator } from '@main/login/coordinator'
import { verifyGameHome } from '@main/login/verify'
import { executePhoneCommand } from '@main/login/phoneDriver'
import { inputLoginDigits } from '@main/login/nativeUi'
import { applyBindings } from '@main/handlers/account'
import {
  deleteScript,
  getScript,
  listScripts,
  saveScript,
  validateScript
} from '@main/store/scripts'
import { queryLogs } from '@main/store/logs'
import { readShot, saveShot } from '@main/store/shots'

// ── 模块 d：执行编排 ──────────────────────────────────────────────────────
import { getOrchestrator } from '@main/orchestrator/index'
import type { RunDeps } from '@main/orchestrator/index'

// ── ETA 调度：队列状态采样 + 定时唤醒 ─────────────────────────────────────
import { getScheduler } from '@main/scheduler/index'
import type { SchedulerDeps } from '@main/scheduler/index'

// ── 自动采集：队列有空位时的派遣流程 ──────────────────────────────────────
import {
  FAILURE_SHOT_LABELS,
  createQueueFreeHook,
  invalidateGatherTemplates,
  readGatherConfigFromAccount,
  type GatherRunnerDeps,
  getGatherTemplates
} from '@main/game/gatherRunner'

// ── AI 顾问：认不出界面时问视觉大模型，点掉弹窗并把关闭按钮自学成模板 ──────
import { aiRecoverUnknownScreen, getAiAdvisor, type RecoverIo } from '@main/ai/index'
import { emitAi, registerAiHandlers, resetAiIpc } from '@main/ai/ipc'
import {
  closePopupTemplates,
  isRecognizableScreen,
  type UnknownScreenAdvisor
} from '@main/game/gather/index'
import { invalidateTemplates as invalidateSchedulerTemplates } from '@main/scheduler/templates'

// ── 异常检测 + 自动暂停 + 告警推送 ────────────────────────────────────────
import type { RawFrame } from '@shared/vision'
import { pausesInstance, makeAlertEvent } from '@shared/alerts'
import { isRunning, launchViaMonkey } from '@main/adb/apps'
import { TelegramBot } from '@main/alerts/telegramBot'
import { GAME_PACKAGE, createAdbGatherIo } from '@main/game/gather/index'
import { getAlertCenter } from '@main/alerts/center'
import { FailureTracker } from '@main/alerts/detect'
import { probeKickedOnRawFrame } from '@main/alerts/kicked'
import { getNotifyHub } from '@main/alerts/notifier'

// ── Telegram 机器人动作 + 面板测试通道 ────────────────────────────────────
import { BOT_PHOTO_JPEG_QUALITY, BOT_PHOTO_MAX_WIDTH, shotFilename } from '@shared/bot'
import { createBotActions } from '@main/bot/actions'
import { registerBotHandlers, resetBotIpc } from '@main/bot/ipc'

// ── 每日数据统计（北京时间日桶）+ 游戏「资源统计」表识别 ──────────────────
import type { ResourceSnapshot } from '@shared/resources'
import { getStatsCenter } from '@main/stats/index'
import { readResourceStatsPanel } from '@main/game/resources/index'

// ══════════════════════════════════════════════════════════════════════════
// 接线区：把各模块的导出适配成 MainDeps 声明的窄接口
// ══════════════════════════════════════════════════════════════════════════

const registry = createRegistry()

// 驱动**每次现取**：用户在设置页把雷电切成 MuMu（或反过来）后，下一次操作就该打到新驱动上。
const mumu: MumuPort = {
  list: () => registry.snapshot(),
  refresh: () => registry.refresh(),
  get: (index) => registry.get(index),
  open: (index) => getEmulatorDriver().open(index),
  close: (index) => getEmulatorDriver().close(index),
  restart: (index) => getEmulatorDriver().restart(index),
  create: (opts) => getEmulatorDriver().create(opts),
  clone: (index) => getEmulatorDriver().clone(index),
  remove: (index) => getEmulatorDriver().remove(index),
  config: (index, settings) => getEmulatorDriver().config(index, settings),
  patch: (index, overlay) => registry.patch(index, overlay)
}

const adb: AdbPort = {
  attach: (index, adbPort) => adbAttach(index, adbPort),
  detach: (index) => detachByIndex(index),
  cached: (index) => getCachedByIndex(index),
  refreshInfo: (serial) => refreshDeviceInfo(serial),
  capture: (serial) => captureRaw(serial),
  tap: (serial, x, y) => tap(serial, x, y),
  swipe: (serial, x1, y1, x2, y2, durationMs) => swipe(serial, x1, y1, x2, y2, durationMs),
  text: (serial, text) => typeText(serial, text),
  key: (serial, k) => adbKey(serial, k),
  apps: (serial) => listUserApps(serial),
  foreground: (serial) => foregroundPackage(serial),
  launchApp: (serial, pkg, cold) => launch(serial, pkg, cold),
  stopApp: (serial, pkg) => forceStop(serial, pkg),
  installApk: (serial, apkPath) => installApk(serial, apkPath),
  setupIme: (serial, apkPath) => setupChineseIme(serial, apkPath)
}

const vision: VisionPort = {
  listSets: () => visionListSets(),
  createSet: (name, packageName) => visionCreateSet(name, packageName),
  listTemplates: (setId) => visionListTemplates(setId),
  saveTemplate: (setId, input) => visionSaveTemplate(setId, input),
  deleteTemplate: (setId, templateId) => visionDeleteTemplate(setId, templateId),
  templateImage: async (setId, templateId) =>
    toArrayBuffer(await readTemplateImage(setId, templateId)),

  // 「再抓一帧去底」预览：多帧差分（vision/alpha.ts），纯计算、不碰设备，几十毫秒。
  alphaPreview: async (req) => {
    const frames = [new Uint8Array(req.image), ...req.diffFrames.map((b) => new Uint8Array(b))]
    const r = await renderAlphaPreview(frames, req.crop, {
      tolerance: req.tolerance,
      previewWidth: req.previewWidth
    })
    return {
      coverage: r.coverage,
      width: r.width,
      height: r.height,
      previewPng: toArrayBuffer(r.previewPng)
    }
  },

  /**
   * 模板编辑器的「立即验证」：一次性、由用户显式触发，所以允许在主进程里跑。
   *
   * ★ 代价说明：这会把 OpenCV 的 WASM 堆（约 100MB）加载进主进程，首次约 180ms。
   *   之所以没走 utilityProcess，是因为 worker.ts 的 detectOnce 协议不带帧数据，
   *   而这里必须让「用于匹配的帧」和「回给面板画框的预览帧」是**同一帧**，
   *   否则用户会看到框画在另一个画面上。将来给 detectOnce 加上帧载荷后可以搬过去。
   */
  matchOnce: async (setId, templateId, frame, opts) => {
    const s = getSettings()
    const prepared = await loadPrepared(setId, { refW: s.refWidth, shrink: s.shrink })
    const tpl = prepared.get(templateId)
    if (!tpl) {
      throw new AppError(
        'TEMPLATE_NOT_FOUND',
        `模板集「${setId}」里没有可用的模板 ${templateId}。\n` +
          '可能是它的图片文件丢了，或方差过低被引擎拒绝了（纯色/渐变的模板不能用）。',
        { setId, templateId }
      )
    }
    const pf = await prepareFrame(frame, {
      refW: s.refWidth,
      refH: s.refHeight,
      shrink: s.shrink
    })
    return matchIn(pf, tpl, opts)
  }
}

const scripts: ScriptStorePort = {
  list: () => listScripts(paths().scriptsDir),
  get: (scriptId) => getScript(paths().scriptsDir, scriptId),
  save: (def) => saveScript(paths().scriptsDir, def),
  remove: (scriptId) => deleteScript(paths().scriptsDir, scriptId),
  validate: async (def) => {
    // 带上模板集里实际存在的模板 id，校验才能报出「引用了不存在的模板」这类问题。
    let availableTemplateIds: string[] | undefined
    if (def.templateSetId) {
      try {
        availableTemplateIds = (await visionListTemplates(def.templateSetId)).map((t) => t.id)
      } catch {
        // 模板集不存在时跳过这项检查，由 validateScript 自己给出更贴切的提示。
      }
    }
    const s = getSettings()
    return validateScript(def, {
      availableTemplateIds,
      settingsRefWidth: s.refWidth,
      settingsRefHeight: s.refHeight
    })
  }
}

const accounts: AccountStorePort = {
  list: () => listAccounts(paths().accountsDir),
  save: (account) => saveAccount(paths().accountsDir, account),
  remove: (accountId) => deleteAccount(paths().accountsDir, accountId),
  bind: (accountId, instanceIndex) => bindAccount(paths().accountsDir, accountId, instanceIndex)
}

const logs: LogStorePort = {
  query: (query) => queryLogs(paths().logsDir, query),
  readShot: (runId, shot) => readShot(paths().shotsDir, runId, shot)
}

// ── 模块 d：执行编排 ──────────────────────────────────────────────────────

const orchImpl = getOrchestrator()

/**
 * 编排器每次启动执行时向主进程索取的东西。
 * 注意 settings / paths 是**每次 start 时现取**的，不能在这里提前算好存起来 ——
 * 用户可能刚在设置页改完数据目录就点了启动。
 */
function runDeps(): RunDeps {
  return {
    loadScript: (scriptId) => scripts.get(scriptId),
    settings: getSettings(),
    paths: paths(),
    // 连接由主进程负责：worker 里不做 attach，进去时 serial 必须已经可用。
    resolveSerial: async (instanceIndex) => {
      await assertInstanceAutomationReady(instanceIndex)
      return (await ensureDevice(deps, instanceIndex)).serial
    },
    loadAccount: async (accountId) =>
      (await accounts.list()).find((a) => a.id === accountId) ?? null
  }
}

const orchestrator: OrchestratorPort = {
  // 窗口是 MessagePort 的另一端要送达的地方；没窗口时编排器会退化成「只回状态、不推流」。
  start: (req) => orchImpl.start(mainWindow, req, runDeps()),
  stop: (runId) => orchImpl.stop(runId),
  pause: (runId) => orchImpl.pause(runId),
  resume: (runId) => orchImpl.resume(runId),
  list: () => orchImpl.list()
}

// ── ETA 调度 ─────────────────────────────────────────────────────────────

const scheduler = getScheduler()

/**
 * 调度器要的东西全部在这里注入。
 *
 * ★ busyRunIdOf 是调度器与执行器之间**唯一**的互斥手段：
 *   主进程与每个 utilityProcess 各持一份 adb 队列单例，跨进程不共享，
 *   所以实例上有脚本在跑时调度器绝不能去动它。
 */
function schedulerDeps(): SchedulerDeps {
  return {
    dataDir: () => paths().dataDir,
    refSize: () => {
      const s = getSettings()
      return { refWidth: s.refWidth, refHeight: s.refHeight }
    },
    ensureAutomationReady: assertInstanceAutomationReady,
    resolveDevice: async (index) => {
      await assertInstanceAutomationReady(index)
      return ensureDevice(deps, index)
    },
    busyRunIdOf: (index) => orchImpl.runIdOfInstance(index),
    accountIdOf: async (index) =>
      (await accounts.list()).find((a) => a.instanceIndex === index)?.id ?? null,
    adb: {
      capture: (serial) => captureRaw(serial),
      tap: (serial, x, y) => tap(serial, x, y),
      key: (serial, k) => adbKey(serial, k),
      foregroundPackage: (serial) => foregroundPackage(serial),
      isRunning: (serial, pkg) => isRunning(serial, pkg),
      // ★ 冷启动恢复必须走 monkey：am start 对本游戏返回成功但进程起不来（adb/apps.ts 实测）。
      launchApp: (serial, pkg) => launchViaMonkey(serial, pkg)
    },
    gamePackage: () => GAME_PACKAGE,
    log: (level, message) => {
      if (level === 'error' || level === 'warn') console.warn(`[scheduler] ${message}`)
      else console.log(`[scheduler] ${message}`)
    },
    // 上次在外的队伍这次从面板上消失了 → 数据统计记「完成趟数」（资源类型由统计模块按坐标反查）。
    onMarchGone: (index, gone, at) => {
      for (const g of gone) {
        statsCenter.record({
          kind: 'tripCompleted',
          at,
          instanceIndex: index,
          coord: g.coord,
          resource: null
        })
      }
    },
    // 自动调度开关翻转 → 数据统计记「暂停 / 恢复」。
    // ★ 唯一来源：面板开关（scheduler:setAuto）、告警中心异常暂停、机器人 /pause /resume 都经 setAuto 到这里。
    onAutoChanged: (index, enabled, at) => {
      statsCenter.record(
        enabled
          ? { kind: 'resumed', at, instanceIndex: index }
          : { kind: 'paused', at, instanceIndex: index, reason: null }
      )
    },
    // 连续采样失败 = 模拟器或游戏掉线。★ 这是同步回调，不能 await，
    //   raiseAlertQuietly 会把 setAuto(false) 放到下一个微任务里跑（不抢锁，安全）。
    onSampleResult: (index, ok, message) => {
      if (ok) {
        failureTracker.noteSampleOk(index)
        return
      }
      // 已经被（比如顶号探针）暂停的实例，不再累计、不再二次推送。
      if (alertCenter.isPaused(index)) return
      const event = failureTracker.noteSampleFailed(index, message ?? '原因未知')
      if (event) raiseAlertQuietly(event)
    },

    // ★ 采样器认不出界面时，用同一帧跑顶号探针 —— 零额外截图，第一次采样就能判定。
    //   以前顶号只能走「连续 3 次采样失败」的慢路径（还夹着 30s/60s 退避），
    //   而且被归类成「掉线」而不是「疑似顶号」。
    //   返回是否命中：命中了采样器就不再盲按 BACK 关弹窗（顶号弹窗按 BACK 没意义）。
    // 先跑顶号 / 掉线探针（命中 ⇒ true，告警中心接管）；没命中再问 AI 顾问（点掉弹窗 ⇒ 'recovered'）。
    onUnrecognizedFrame: async (index, raw, signal) => {
      if (await probeFrameForAlerts(index, raw, '采样时')) return true
      return aiRecoverForScheduler(index, raw, signal)
    },

    // ★ 健康探针：只截一帧不开面板。给「顶号 / 游戏退出」的发现延迟设上限（默认 3 分钟）。
    onHealthProbe: async (index, raw, ctx) => {
      const hit = await probeFrameForAlerts(index, raw, '健康探针')
      if (hit) return
      if (ctx.running === false && !alertCenter.isPaused(index)) {
        const shotPath = await saveAlertShot(index, 'health-probe', raw)
        raiseAlertQuietly(
          makeAlertEvent({
            type: 'deviceOffline',
            instanceIndex: index,
            reason:
              `健康探针发现游戏进程已退出（当前前台：${ctx.foreground ?? '未知'}）。` +
              '顶号后点了「确定」游戏会直接退出，这也是它最常见的成因。',
            shotPath,
            detail: { 前台包名: ctx.foreground ?? '未知', 游戏进程: '不在' }
          })
        )
      }
    }
  }
}

/**
 * 对一帧跑顶号/维护/更新精确探针；命中就留痕 + 抛告警（会暂停实例并推送）。
 * 返回是否命中。已暂停的实例直接跳过，避免重复推送。
 */
async function probeFrameForAlerts(index: number, raw: RawFrame, where: string): Promise<boolean> {
  if (!alertCenter.detectConfig().kickedProbeEnabled) return false
  if (alertCenter.isPaused(index)) return false
  const templates = await getGatherTemplates(paths().templatesDir, (level, message, data) =>
    alertLog(level, `[实例${index}] ${message}`, data)
  )
  const hit = await probeKickedOnRawFrame(raw, {
    templates,
    log: (level, message, data) => alertLog(level, `[实例${index}] ${message}`, data)
  })
  if (!hit) return false
  const shotPath = await saveAlertShot(index, 'kicked', raw)
  raiseAlertQuietly(
    makeAlertEvent({
      type: hit.type,
      instanceIndex: index,
      reason: `${where}命中：${hit.reason}`,
      shotPath,
      detail: hit.detail
    })
  )
  return true
}

// ── 异常检测与自动暂停 ───────────────────────────────────────────────────
//
// 三件东西的分工：
//   FailureTracker（detect.ts）  只数数：连续几轮采集失败、连续几次采样失败、多久没派出队
//   AlertCenter   （center.ts）  只做动作：暂停实例、落盘暂停态、推给面板、交给推送模块
//   NotifyHub     （notifier.ts）只管推送：订阅过滤、冷却去重、Telegram 重试（a 组交付）
// 阈值一律来自 <dataDir>/alerts.json（AlertDetectConfig），本文件不写死任何数字。

const notifyHub = getNotifyHub()
const alertCenter = getAlertCenter()
/** AI 顾问：只在认不出界面时被问到；关掉或没配 Key 时 isActive() 为 false，一切照旧。 */
const aiAdvisor = getAiAdvisor()

/**
 * 采集流程（G0 兜底阶梯）用的顾问端口：把 gather 模块的上下文原样交给 recover.ts。
 * 它只会执行「点关闭 / 点取消」并复验；back / none 交回 navigation.ts 自己的 BACK 阶梯。
 */
const gatherAdvisor: UnknownScreenAdvisor = {
  handleUnknownScreen: async (ctx) => {
    if (!aiAdvisor.isActive()) return false
    const r = await aiRecoverUnknownScreen(aiAdvisor, {
      instanceIndex: ctx.instanceIndex,
      context: 'gather-g0',
      raw: ctx.raw,
      io: ctx.io,
      refWidth: ctx.refWidth,
      refHeight: ctx.refHeight,
      setId: ctx.setId,
      attempt: ctx.attempt,
      recognize: ctx.recognize,
      existingCloseTemplates: ctx.existingCloseTemplates,
      log: ctx.log
    })
    return r.handled
  }
}

/**
 * 调度器采样时的 AI 恢复：采样器认不出界面、顶号探针也没命中时调用。
 * 返回 'recovered' 让采样器重新截图（不按 BACK）；false 让它按原阶梯继续。绝不抛。
 */
async function aiRecoverForScheduler(
  index: number,
  raw: RawFrame,
  signal?: AbortSignal
): Promise<false | 'recovered'> {
  if (!aiAdvisor.isActive()) return false
  try {
    const dev = await ensureDevice(deps, index)
    const templates = await getGatherTemplates(paths().templatesDir, (l, m, d) =>
      alertLog(l, `[实例${index}] ${m}`, d)
    )
    const io: RecoverIo = {
      capture: () => {
        signal?.throwIfAborted()
        return captureRaw(dev.serial)
      },
      tap: async (x, y) => {
        signal?.throwIfAborted()
        const p = toDevicePoint(dev, { x, y })
        await tap(dev.serial, p.x, p.y)
      },
      key: (k) => {
        signal?.throwIfAborted()
        return adbKey(dev.serial, k)
      }
    }
    const r = await aiRecoverUnknownScreen(aiAdvisor, {
      instanceIndex: index,
      context: 'scheduler-sample',
      raw,
      io,
      refWidth: templates.refWidth,
      refHeight: templates.refHeight,
      setId: templates.setId,
      attempt: 1,
      recognize: (f) =>
        isRecognizableScreen(templates, f, {
          refWidth: templates.refWidth,
          refHeight: templates.refHeight
        }),
      existingCloseTemplates: closePopupTemplates(templates),
      log: (l, m, d) => alertLog(l, `[实例${index}][AI] ${m}`, d)
    })
    return r.handled ? 'recovered' : false
  } catch (e) {
    alertLog(
      'warn',
      `[实例${index}] AI 顾问在采样链路上出错，按未处理继续：${AppError.from(e).message}`
    )
    return false
  }
}
/** 每日数据统计：所有事件源（派兵 / 失败 / 回城 / 告警 / 暂停恢复 / 快照）都汇到它的 record()。 */
const statsCenter = getStatsCenter()

function alertLog(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  const line = `[alerts] ${message}${data ? ' ' + JSON.stringify(data) : ''}`
  if (level === 'error' || level === 'warn') console.warn(line)
  else console.log(line)
}

const failureTracker = new FailureTracker({
  config: () => alertCenter.detectConfig(),
  log: alertLog
})

// ── Telegram 机器人：手机上点按钮 / 发命令远程操作 ───────────────────────
//
// 动作在 src/main/bot/actions.ts 里实现（Electron 无关、deps 注入），机器人本身（telegramBot.ts）
// 只负责收发；这里只做接线：把动作层要的能力接到调度器 / 告警中心 / 账号库 / adb 上。
// ★ 「重启游戏并恢复」「截图」「读资源统计」都要驱动模拟器：动作层会把它们包进
//   scheduler.exclusive()（与采样/派遣抢同一把实例锁），本文件里的 recoverGame 自己不加锁。

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const KICK_CONFIRM_REF = { x: 1275, y: 965 } // 顶号弹窗「确定」（参考分辨率 2560x1440）
const NETWORK_CONFIRM_REF = { x: 1272, y: 899 } // 网络断开弹窗「确定」

/**
 * 顶号/断线后的游戏恢复序列（实测链路，见 docs/game 流程文档）：
 *   顶号弹窗 →点确定→ 游戏进程退出 →monkey 重启→ 「网络不稳定」弹窗 →点确定→ 自动回主城
 * 返回做了哪些步骤的中文描述；任何一步校验不过都抛中文错误（不会盲点）。
 */
async function recoverGame(index: number): Promise<string> {
  const dev = await ensureDevice(deps, index)
  const serial = dev.serial
  const steps: string[] = []
  const tlog = (l: LogLevel, m: string, d?: Record<string, unknown>): void =>
    alertLog(l, `[实例${index}] ${m}`, d)
  const templates = await getGatherTemplates(paths().templatesDir, tlog)

  const seen = async (templateId: string, raw: RawFrame): Promise<boolean> => {
    const tpl = templates.get(templateId)
    if (!tpl) return false
    const frame = await prepareFrame(raw, {
      refW: templates.refWidth,
      refH: templates.refHeight,
      shrink: tpl.shrink
    })
    return (await matchIn(frame, tpl, { roi: tpl.defaultRoi })).found
  }
  const tapRef = async (p: { x: number; y: number }): Promise<void> => {
    const d = toDevicePoint(dev, { x: p.x, y: p.y })
    await tap(serial, d.x, d.y)
  }

  // ① 顶号弹窗还挂着 → 点确定（游戏会随之退出）
  let raw = await captureRaw(serial)
  if (await probeKickedOnRawFrame(raw, { templates, log: tlog })) {
    await tapRef(KICK_CONFIRM_REF)
    steps.push('点掉顶号弹窗')
    await sleepMs(6000)
  }

  // ② 进程不在 → monkey 拉起（am start 对本游戏无效）
  if (!(await isRunning(serial, GAME_PACKAGE))) {
    await launchViaMonkey(serial, GAME_PACKAGE)
    steps.push('用 monkey 重启游戏')
    for (let i = 0; i < 30; i += 1) {
      if ((await foregroundPackage(serial)) === GAME_PACKAGE) break
      await sleepMs(2000)
    }
    await sleepMs(20000)
  }

  // ③ 「网络不稳定，连接已断开」→ 点确定重连（最多两轮）
  for (let i = 0; i < 2; i += 1) {
    raw = await captureRaw(serial)
    if (!(await seen('tpl_dlg_network_lost', raw))) break
    await tapRef(NETWORK_CONFIRM_REF)
    steps.push('点掉网络重连提示')
    await sleepMs(15000)
  }

  // ④ 校验：前台是游戏、且顶号弹窗没有再次出现
  raw = await captureRaw(serial)
  const fg = await foregroundPackage(serial)
  if (fg !== GAME_PACKAGE) {
    throw new AppError('NOT_FOUND', `游戏没有回到前台（当前前台：${fg ?? '未知'}），未恢复调度。`)
  }
  if (await probeKickedOnRawFrame(raw, { templates, log: tlog })) {
    throw new AppError(
      'NOT_FOUND',
      '重启后顶号弹窗又出现了 —— 对方设备可能还在线。请先退出另一台设备再试。'
    )
  }
  return steps.length > 0 ? steps.join(' → ') : '游戏本来就在正常运行，没有需要处理的弹窗'
}

/**
 * 机器人「📷 截图」：截一帧 → 降采样成宽 ≤1280 的 JPEG（约 150KB）→ 附前台包名与进程存活。
 * ★ 由动作层在 scheduler.exclusive() 内调用；这里不加锁、不点任何东西。
 */
async function captureShotForBot(index: number): Promise<{
  jpeg: ArrayBuffer
  at: number
  foreground: string | null
  gameRunning: boolean | null
}> {
  const dev = await ensureDevice(deps, index)
  const raw = await captureRaw(dev.serial)
  const shot = await rawFrameToShot(
    raw,
    { width: BOT_PHOTO_MAX_WIDTH, quality: BOT_PHOTO_JPEG_QUALITY },
    0
  )
  let foreground: string | null = null
  let gameRunning: boolean | null = null
  try {
    foreground = await foregroundPackage(dev.serial)
  } catch {
    foreground = null
  }
  try {
    gameRunning = await isRunning(dev.serial, GAME_PACKAGE)
  } catch {
    gameRunning = null
  }
  return { jpeg: shot.jpeg, at: raw.capturedAt || Date.now(), foreground, gameRunning }
}

/**
 * 读游戏「道具 → 资源统计」表（机器人「💰 资源」/ 面板「读一次资源统计」共用）。
 * ★ 由调用方包进 scheduler.exclusive()；readResourceStatsPanel 自己负责导航、读表与还原到主界面。
 */
async function readResourceStatsForInstance(index: number): Promise<ResourceSnapshot> {
  const dev = await ensureDevice(deps, index)
  const log = (level: LogLevel, message: string, data?: Record<string, unknown>): void =>
    alertLog(level, `[实例${index}][资源统计] ${message}`, data)
  const templates = await getGatherTemplates(paths().templatesDir, log)
  return readResourceStatsPanel({
    io: createAdbGatherIo({ serial: dev.serial }),
    templates,
    instanceIndex: index,
    log,
    onShot: async (label, raw) => {
      await saveAlertShot(index, label, raw)
    }
  })
}

/** 机器人截图的留痕目录（相对 <dataDir>/shots）。 */
const BOT_SHOT_DIR = 'bot'

const botActions = createBotActions({
  gamePackage: GAME_PACKAGE,
  accounts: () => accounts.list(),
  instances: async () => registry.snapshot(),
  schedulerState: (i) => scheduler.getState(i),
  pauseOf: (i) => alertCenter.getPause(i),
  // 手动暂停走调度器的 setAuto(false)（不抢锁）；统计事件由动作层自己记（带「机器人手动暂停」原因）。
  setAuto: (i, enabled) => scheduler.setAuto(i, enabled),
  // 恢复走告警中心：清暂停态 + setAuto(true)（会采样、抢锁）→ 动作层保证只在锁外调它。
  resumeInstance: (i) => alertCenter.resume(i),
  recoverGame,
  exclusive: (i, what, fn) => scheduler.exclusive(i, what, fn),
  captureShot: captureShotForBot,
  readResourceStats: (i) => readResourceStatsForInstance(i),
  todayStats: () => statsCenter.today(),
  recordStats: (e) => statsCenter.record(e),
  // 截图留痕跟随 shotPolicy：never 时不存；其余都存（这是用户主动要的一张，不算过程留痕）。
  saveShot: async (i, jpeg, at) => {
    if (getSettings().shotPolicy === 'never') return null
    return saveShot(paths().shotsDir, BOT_SHOT_DIR, shotFilename(i, at), jpeg)
  },
  log: (l, m) => alertLog(l, `[机器人] ${m}`)
})

const telegramBot = new TelegramBot({
  config: () => notifyHub.currentTelegramConfig(),
  actions: botActions,
  log: (l, m) => alertLog(l, `[机器人] ${m}`)
})

/** 告警是"顺带"的事：它自己出问题绝不能连累采集与调度，所以统一从这里进。 */
function raiseAlertQuietly(event: Parameters<typeof alertCenter.raise>[0]): void {
  statsCenter.record({
    kind: 'alertRaised',
    at: event.at,
    instanceIndex: event.instanceIndex,
    alertType: event.type
  })
  void alertCenter.raise(event).catch((e: unknown) => {
    alertLog('error', `处理告警时出错：${AppError.from(e).message}`)
  })
}

/** 告警留痕目录（相对 <dataDir>/shots）。saveShot 只接受 [A-Za-z0-9_.-]，中文和冒号会被拒。 */
const ALERT_SHOT_DIR = 'alerts'

/** 把标签收成合法文件名片段。 */
function safeLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40)
  return cleaned.length > 0 ? cleaned : 'shot'
}

/**
 * 采集流程的现场留痕。
 *
 * ★ 拿到的是 RawFrame（RGBA8888 裸帧，720p 就有 14.7MB），**绝不能直接写盘**，
 *   必须先用 rawFrameToShot 压成 jpeg（约 40KB）。
 * ★ 落盘策略跟随 AppSettings.shotPolicy：
 *     never  一张都不存
 *     onFail 只存失败现场（g0-failed / cycle-error）—— 默认，也正是告警要的那张
 *     always 过程留痕（g0-unknown-N 等）也一并存下来，排障用，但很占磁盘
 */
async function saveAlertShot(
  instanceIndex: number,
  label: string,
  raw: Parameters<typeof rawFrameToShot>[0]
): Promise<string | null> {
  const policy = getSettings().shotPolicy
  if (policy === 'never') return null
  const isFailure = FAILURE_SHOT_LABELS.has(label)
  if (!isFailure && policy !== 'always') return null

  const shot = await rawFrameToShot(raw, undefined, 0)
  const file = `inst${instanceIndex}-${safeLabel(label)}-${Date.now()}.jpg`
  return saveShot(paths().shotsDir, ALERT_SHOT_DIR, file, shot.jpeg)
}

// ── 自动采集派遣 ─────────────────────────────────────────────────────────

/**
 * 采集流程要的东西全部在这里注入。
 *
 * 配置来源是**该实例绑定的账号**：采集配置页把整份配置 JSON 存进
 * `Account.scriptParams.gather.configJson`（scriptParams 只允许 string|number|boolean，
 * 存不了嵌套结构，所以序列化成一段字符串）。没绑账号 / 没存过就用默认配置。
 */
function gatherRunnerDeps(): GatherRunnerDeps {
  return {
    // 认不出界面时的 AI 顾问（未启用时 handleUnknownScreen 立刻返回 false，零开销）。
    advisor: gatherAdvisor,
    dataDir: () => paths().dataDir,
    templatesDir: () => paths().templatesDir,
    resolveSerial: async (index) => (await ensureDevice(deps, index)).serial,
    loadConfig: async (index) => {
      const account = (await accounts.list()).find((a) => a.instanceIndex === index)
      if (!account) return null
      return readGatherConfigFromAccount(account)
    },
    noteDispatch: (index, info) => scheduler.noteDispatch(index, info),
    log: (level, message, data) => {
      const line = `[gather] ${message}${data ? ' ' + JSON.stringify(data) : ''}`
      if (level === 'error' || level === 'warn') console.warn(line)
      else console.log(line)
    },

    // ★ 生产环境以前一张截图都不落盘（GatherSession.shot() 见没有 onShot 就直接 return），
    //   所以"暂停时记录现场截图"这件事必须从这条接线开始。
    onShot: (index, label, raw) => saveAlertShot(index, label, raw),

    // 第二层「顶号」精确识别。模板没采集时 probeKickedOnRawFrame 会立刻返回 null，
    // 连预处理都不做 —— 静默降级到第一层通用兜底，绝不报错、绝不中止。
    probeKicked: async (index, raw, templates) => {
      if (!alertCenter.detectConfig().kickedProbeEnabled) return null
      return probeKickedOnRawFrame(raw, {
        templates,
        log: (level, message, data) => alertLog(level, `[实例${index}] ${message}`, data)
      })
    },

    // 一轮采集的事实 -> 判定 -> 该暂停就暂停。
    // ★ 这里是在调度器的实例锁内跑的：raise() 内部只会调 setAuto(false)（不抢锁），安全；
    //   绝不能在这条路上 await sampleNow / setAuto(true)，那会死锁。
    onCycleResult: async (index, fact) => {
      // 数据统计：失败轮数 / 熔断次数。record 是同步且绝不抛的。
      if (fact.outcome === 'error' || fact.outcome === 'circuitBroken') {
        statsCenter.record({
          kind: 'cycleFailed',
          at: Date.now(),
          instanceIndex: index,
          outcome: fact.outcome,
          message: fact.message,
          step: fact.step,
          errorCode: fact.errorCode
        })
      }
      const event = failureTracker.noteCycle(index, fact)
      if (!event) return
      if (pausesInstance(event.type)) {
        // 会暂停的事件必须等它做完再返回：调度器接下来就要 rearm，
        // 那时候 auto 已经是 false，才不会又排一次唤醒。
        statsCenter.record({
          kind: 'alertRaised',
          at: event.at,
          instanceIndex: index,
          alertType: event.type
        })
        await alertCenter.raise(event)
      } else {
        // 不暂停的事件（例如「长时间派不出队」）没必要占着实例锁等一次网络请求。
        raiseAlertQuietly(event)
      }
    },

    // 派兵记账 → 数据统计（主数据源：储量精确到个位，勾「自动采集至清空」时一趟 ≈ 储量）。
    onDispatched: (index, records, at) => {
      for (const d of records) {
        statsCenter.record({
          kind: 'dispatch',
          at: d.at || at,
          instanceIndex: index,
          resource: d.resource,
          storage: d.storage,
          coord: d.coord,
          level: d.level,
          travelTimeSec: d.travelTimeSec
        })
      }
    }
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────

let activeContextDir: string | undefined
function paths(): ResolvedPaths {
  return resolvePaths(getSettings(), activeContextDir)
}

const provisioner = new InstanceProvisioner(mumu, () => paths().dataDir)

async function assertInstanceAutomationReady(index: number): Promise<void> {
  const [base, list] = await Promise.all([provisioner.getBase(), accounts.list()])
  if (base?.index === index)
    throw new AppError('INVALID_ARGUMENT', '基础实例用于克隆，请在副本中配置自动任务。')
  const account = list.find((a) => a.instanceIndex === index)
  if (!account?.setup) return // 旧账号沿用原有流程。
  const instance = mumu.get(index)
  if (
    account.setup.status !== 'ready' ||
    (account.setup.instanceIdentity &&
      account.setup.instanceIdentity !== (instance?.identity ?? instance?.bundlePath ?? null))
  ) {
    throw new AppError(
      'DEVICE_NOT_READY',
      '此账号尚未完成登录检查，或绑定实例已改变。请在账号登录向导中继续。'
    )
  }
}

const login = new AccountLoginCoordinator({
  command: executePhoneCommand,
  base: () => provisioner.getBase(),
  instances: () => mumu.refresh(),
  open: (index) => mumu.open(index),
  device: (index) => ensureDevice(deps, index),
  maxInstances: () => getSettings().maxConcurrentInstances,
  pauseAuto: (index) => scheduler.setAuto(index, false),
  prepare: (input, identity) =>
    prepareLoginAccount(paths().accountsDir, {
      ...input,
      name: input.newAccountName,
      identity,
      packageName: GAME_PACKAGE
    }),
  complete: (id, index, identity) => completeLoginAccount(paths().accountsDir, id, index, identity),
  launch: async (serial) => {
    await launchViaMonkey(serial, GAME_PACKAGE)
  },
  input: async (device, input) => {
    if (input.kind === 'text') return inputLoginDigits(device.serial, input.text)
    if (input.kind === 'key') return adbKey(device.serial, input.key)
    const at = toDevicePoint(device, input.at)
    if (input.kind === 'tap') return tap(device.serial, at.x, at.y)
    const to = toDevicePoint(device, input.to)
    return swipe(device.serial, at.x, at.y, to.x, to.y, input.durationMs)
  },
  verify: (serial) =>
    verifyGameHome(serial, paths().templatesDir, getSettings().refWidth, getSettings().refHeight),
  changed: (session) => emit('login:changed', session),
  accountsChanged: () => {
    void accounts
      .list()
      .then((list) => {
        applyBindings(deps, list)
        emit('account:changed', list)
      })
      .catch(() => console.warn('[login] 刷新账号列表失败。'))
  }
})

const deps: MainDeps = {
  provisioner,
  login,
  mumu,
  adb,
  vision,
  scripts,
  accounts,
  logs,
  orchestrator,
  settings: getSavedSettings,
  paths,
  saveSettings
}

/** 已结束的执行不再占着实例，把 runId 覆盖清掉。 */
const FINISHED: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'aborted'])

/** 把最新的路径与设置推给各模块。启动时一次，之后每次设置变更再来一次。 */
let appliedAdbPath = ''
function applyConfigToModules(settings: AppSettings, resolved: ResolvedPaths): void {
  // 先切驱动种类再设路径：路径为空会抛（Windows 上没探测到雷电时），但种类必须已经切过去，
  // 自检才能给出「找不到雷电」而不是「找不到 mumutool」的提示。
  safely('切换模拟器驱动', () =>
    configureEmulator({ kind: settings.emulator, cliPath: resolved.mumutoolPath })
  )
  safely('推送模板目录', () => setTemplatesDir(resolved.templatesDir))
  safely('推送截图节流参数', () => setMinCaptureInterval(settings.minCaptureIntervalMs))
  safely('推送 adb 路径', () => {
    if (resolved.adbPath === appliedAdbPath) return
    appliedAdbPath = resolved.adbPath
    setAdbPath(resolved.adbPath)
    // 换了 adb 可执行文件，之前那条 adb server 上的连接全部作废，重连一次更干净。
    void detachAll().catch(() => undefined)
  })
}

function safely(what: string, run: () => unknown): void {
  try {
    run()
  } catch (e) {
    console.error(`[main] ${what}失败：`, e)
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 窗口与生命周期
// ══════════════════════════════════════════════════════════════════════════

const unsubscribers: (() => void)[] = []
let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: '万龙控制面板',
    icon: join(
      resourcesDir(),
      'brand',
      process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png'
    ),
    autoHideMenuBar: true,
    webPreferences: {
      // ★ 路径必须是 .cjs：sandbox 下 Electron 只能加载 CommonJS preload
      preload: join(__dirname, '../preload/index.cjs'),
      // 下面三项显式写出来，防止后来者顺手改掉：改了等于把 node 能力交给渲染进程。
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 渲染进程加载完再推自检结果，早了没人接。
  win.webContents.once('did-finish-load', () => {
    void refreshHealth()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  mainWindow = win
  return win
}

async function refreshHealth(): Promise<void> {
  try {
    const report = await runHealthCheck(getSettings())
    emit('app:health', report)
    if (!report.ok) {
      const bad = report.items.filter((i) => !i.ok).map((i) => i.label)
      emit('app:toast', {
        level: 'warning',
        message: `环境自检发现 ${bad.length} 个问题：${bad.join('、')}。请到「设置」页查看修复建议。`
      })
    }
  } catch (e) {
    console.error('[main] 环境自检失败：', e)
  }
}

async function bootstrap(): Promise<void> {
  const settings = await loadSettings()
  activeContextDir = await selectDataContext(settings)
  const resolved = resolvePaths(settings, activeContextDir)
  await ensureDirs(resolved)

  applyConfigToModules(settings, resolved)
  unsubscribers.push(
    onSettingsChanged((s) => {
      const p = resolvePaths(s, activeContextDir)
      applyConfigToModules(s, p)
      // 轮询间隔也可能被改了；start 在已运行时只换间隔，不会起第二条定时器链。
      safely('调整实例轮询间隔', () => registry.start(s.instancePollIntervalMs))
    })
  )

  // adb server 起不来不该阻塞面板启动 —— 自检会把原因和修复建议显示给用户。
  try {
    await initAdb({
      adbPath: resolved.adbPath,
      globalConcurrency: GLOBAL_ADB_CONCURRENCY,
      minCaptureIntervalMs: settings.minCaptureIntervalMs
    })
  } catch (e) {
    console.error('[main] adb 初始化失败：', e)
  }

  // 实例状态变化 -> 推给面板。注册表内部做过内容 diff，不会每轮都推。
  unsubscribers.push(registry.onChange((list) => emit('instance:changed', list)))
  unsubscribers.push(
    registry.onError((err) => {
      console.error('[main] 实例轮询失败：', err.message)
      emit('app:toast', { level: 'error', message: `读取模拟器实例失败：${err.message}` })
    })
  )
  registry.start(settings.instancePollIntervalMs)

  // 执行状态变化 -> run:changed。
  unsubscribers.push(
    orchImpl.onChange((snapshot: RunSnapshot) => {
      emit('run:changed', snapshot)
      // 执行结束就把实例的 runId 覆盖清掉，实例卡片才会从「执行中」变回空闲。
      if (FINISHED.has(snapshot.status)) registry.patch(snapshot.instanceIndex, { runId: null })
    })
  )

  registerAllHandlers(deps)
  // 设置页「在面板内测试机器人动作」：与 Telegram 里点按钮走同一个 BotActionPort。
  registerBotHandlers(botActions)

  // ── 告警：推送模块 + 告警中心。必须在调度器 init 之前起来 ──
  //   调度器 init 会立刻按上次的记账重排唤醒，唤醒回调里就可能产生告警。
  //   ★ 这两步任何一步失败都**不阻断面板启动**：顶多是不推送、不自动暂停，
  //     采集本身照常跑（把「通知模块坏了」升级成「面板起不来」是最糟的处理方式）。
  try {
    await notifyHub.init({ dataDir: () => paths().dataDir, log: (l, m) => alertLog(l, m) })
    notifyHub.registerConfigHandlers()
    // 机器人：按当前配置决定跑不跑；设置页改了配置就按新配置重启一次。
    await telegramBot.start()
    unsubscribers.push(
      notifyHub.onConfigChanged(() => {
        void telegramBot.restart().catch((e: unknown) => {
          alertLog('warn', `[机器人] 按新配置重启失败：${AppError.from(e).message}`)
        })
      })
    )
  } catch (e) {
    console.error('[main] 告警推送模块初始化失败：', e)
  }
  // ── AI 顾问：读 <dataDir>/ai.json，注册 ai:* 通道。起不来不阻断面板（顶多是认不出界面时不问 AI）──
  try {
    await aiAdvisor.init({
      dataDir: () => paths().dataDir,
      log: (l, m) => alertLog(l, `[AI] ${m}`),
      emit: emitAi,
      // 自学出新模板后让两份模板缓存失效，下一轮采样 / 采集就能用上。
      onTemplateHarvested: () => {
        invalidateGatherTemplates()
        invalidateSchedulerTemplates()
      }
    })
    registerAiHandlers(aiAdvisor)
  } catch (e) {
    console.error('[main] AI 顾问模块初始化失败：', e)
  }

  // ── 数据统计：在告警中心之前起来（告警中心的暂停/恢复要往它里面记事件）──
  //   起不来同样不阻断面板：顶多是没统计。
  try {
    await statsCenter.init({
      dataDir: () => paths().dataDir,
      accountNameOf: async (index) =>
        (await accounts.list()).find((a) => a.instanceIndex === index)?.name ?? null,
      log: (l, m) => alertLog(l, `[统计] ${m}`),
      // 面板「读一次资源统计」：与机器人同一条路，抢同一把实例锁。
      snapshotNow: (index) =>
        scheduler.exclusive(index, '读资源统计', () => readResourceStatsForInstance(index))
    })
    statsCenter.registerHandlers()
  } catch (e) {
    console.error('[main] 数据统计模块初始化失败：', e)
  }
  try {
    await alertCenter.init({
      dataDir: () => paths().dataDir,
      notify: () => notifyHub,
      // 暂停/恢复直接复用调度器的 setAuto —— 它已经是幂等的、会取消 timer、会落盘。
      // 数据统计的「暂停 / 恢复」事件由调度器的 onAutoChanged 统一通报，这里不再记。
      setAuto: (index, enabled) => scheduler.setAuto(index, enabled),
      accountOf: async (index) => {
        const account = (await accounts.list()).find((a) => a.instanceIndex === index)
        return account ? { id: account.id, name: account.name } : null
      },
      resetCounters: (index) => failureTracker.reset(index),
      log: alertLog
    })
  } catch (e) {
    console.error('[main] 告警中心初始化失败：', e)
  }

  // ★ 队列有空位时由采集流程接管。必须在 init 之前挂 ——
  //   init 会立刻按上次的记账重排唤醒，唤醒回调里就要用到这个钩子。
  scheduler.setQueueFreeHook(createQueueFreeHook(gatherRunnerDeps()))

  // ETA 调度器：恢复上次的记账并重排唤醒。起不来不该阻塞面板（顶多是不自动派兵）。
  try {
    await scheduler.init(schedulerDeps())
  } catch (e) {
    console.error('[main] ETA 调度器初始化失败：', e)
    emit('app:toast', {
      level: 'warning',
      message: `采集调度器没能启动：${e instanceof Error ? e.message : String(e)}。自动派遣不可用，其余功能不受影响。`
    })
  }

  createWindow()
}

/** 退出前收尾：停轮询、退订、关掉所有 utilityProcess 和 adb 连接，别留孤儿进程。 */
async function shutdown(): Promise<void> {
  await login.shutdown()
  safely('停止实例轮询', () => registry.stop())
  // 调度器的定时器虽然都 unref 过（不会钉住进程），但状态要趁还活着落盘。
  try {
    await scheduler.stop()
  } catch (e) {
    console.error('[main] 关闭 ETA 调度器失败：', e)
  }
  // 数据统计：把还没落盘的今日日桶写下去（调度器停了之后就不会再有新事件）。
  try {
    await statsCenter.stop()
  } catch (e) {
    console.error('[main] 关闭数据统计模块失败：', e)
  }
  // 告警：先停掉机器人的长轮询，再让推送模块把冷却快照写下去，最后告警中心落盘。
  try {
    await telegramBot.stop()
  } catch (e) {
    console.error('[main] 关闭 Telegram 机器人失败：', e)
  }
  try {
    await notifyHub.stop()
  } catch (e) {
    console.error('[main] 关闭告警推送模块失败：', e)
  }
  try {
    await alertCenter.stop()
  } catch (e) {
    console.error('[main] 关闭告警中心失败：', e)
  }
  try {
    await aiAdvisor.stop()
  } catch (e) {
    console.error('[main] 关闭 AI 顾问失败：', e)
  }
  for (const unsubscribe of unsubscribers.splice(0)) {
    try {
      unsubscribe()
    } catch {
      // 退订失败无所谓，进程马上就没了
    }
  }
  try {
    await orchImpl.shutdownAll()
  } catch (e) {
    console.error('[main] 关闭脚本执行进程失败：', e)
  }
  try {
    await detachAll()
  } catch {
    // adb 断连失败不影响退出
  }
  resetBotIpc()
  resetAiIpc()
  resetIpc()
}

// ── 单实例锁：两个面板同时轮询 mumutool、同时驱动 adb 会互相打架 ────────────
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.wanlong.panel')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    try {
      await bootstrap()
    } catch (e) {
      console.error('[main] 启动失败：', e)
      // 起不来也要给用户一个窗口，至少能看到设置页和自检结果。
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      emit('app:toast', {
        level: 'error',
        message: `面板初始化失败：${e instanceof Error ? e.message : String(e)}`
      })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  void shutdown().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
