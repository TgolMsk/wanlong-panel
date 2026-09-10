/**
 * Telegram 机器人的**动作层**：实现 BotActionPort（shared/bot.ts）。
 *
 * 分层见 src/shared/bot.ts 顶部：通道层（telegramBot.ts）只管收发；本文件只管「做事」；
 * index.ts 把这里的 deps 接到调度器 / 告警中心 / 账号库 / adb 上。
 *
 * ★ 本文件 Electron 无关：不 import electron、不 import @main/adb，全部能力由 BotActionDeps 注入，
 *   离线自检（scripts/bot-offline-check.ts）用假 deps 直接跑。
 * ★ 凡要碰模拟器的动作（shot / resources / relaunch）**必须**走 deps.exclusive() ——
 *   它与调度器的采样 / 派遣抢同一把实例锁，实例上有脚本在跑时会直接拒绝。
 * ★ 恢复自动调度（resumeInstance → alertCenter.resume → scheduler.setAuto(true) → 采样）会抢锁，
 *   所以它**只能在锁外**调，relaunch 里的 recoverGame 与 resume 是分开的两步。
 * ★ 本层拿不到 botToken，抛出的任何中文错误都可以原样回给用户。
 */

import { formatCst, formatCstClock, type InstancePauseState } from '@shared/alerts'
import {
  BOT_ACTION_SPECS,
  TELEGRAM_CAPTION_MAX,
  renderAccountList,
  renderShotCaption,
  shotFilename,
  type BotAccountRow,
  type BotAction,
  type BotActionPort,
  type BotActionResult,
  type BotInstanceRef
} from '@shared/bot'
import type { Account, MumuInstance } from '@shared/domain'
import { AppError } from '@shared/errors'
import { renderResourceSnapshotText, type ResourceSnapshot } from '@shared/resources'
import type { InstanceQueueState } from '@shared/scheduler'
import { renderDailyStatsText, type DailyStats, type StatsEvent } from '@shared/stats'

// ── 依赖注入 ──────────────────────────────────────────────────────────────

/** 截一帧的结果（已在 index.ts 里降采样成 JPEG，宽 ≤ BOT_PHOTO_MAX_WIDTH）。 */
export interface BotCaptureResult {
  jpeg: ArrayBuffer
  /** 截图时刻。 */
  at: number
  /** 前台包名；读不到为 null。 */
  foreground: string | null
  /** 游戏进程是否存活；没查为 null。 */
  gameRunning: boolean | null
}

export type BotLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface BotActionDeps {
  /** 取「现在」，离线自检注入固定时刻用。 */
  now?(): number
  /** 游戏包名（截图说明里把前台包名翻译成「游戏」）。 */
  gamePackage: string
  /** 账号库（listAccounts(paths().accountsDir)）。 */
  accounts(): Promise<Account[]>
  /** MuMu 实例注册表快照（registry.snapshot()）。 */
  instances(): Promise<MumuInstance[]>
  /** 调度器状态（scheduler.getState）。 */
  schedulerState(index: number): InstanceQueueState
  /** 告警中心的暂停态（alertCenter.getPause）。 */
  pauseOf(index: number): InstancePauseState
  /** 开/关自动调度（pause 动作用 setAuto(i,false)；不抢锁）。 */
  setAuto(index: number, enabled: boolean): Promise<unknown>
  /** 恢复实例（alertCenter.resume）。★ 会抢实例锁，只能在锁外调。 */
  resumeInstance(index: number): Promise<unknown>
  /** 顶号/断线后的游戏恢复序列（index.ts 的 recoverGame），返回做了哪些步骤的中文描述。 */
  recoverGame(index: number): Promise<string>
  /** 借用实例独占权（scheduler.exclusive）：有脚本在跑抛 CONCURRENCY_LIMIT。 */
  exclusive<T>(index: number, what: string, fn: () => Promise<T>): Promise<T>
  /** 截一帧并降采样（★ 由本层在 exclusive 内调用）。 */
  captureShot(index: number): Promise<BotCaptureResult>
  /** 读游戏「道具 → 资源统计」表（★ 由本层在 exclusive 内调用；它自己负责导航与还原）。 */
  readResourceStats(index: number): Promise<ResourceSnapshot>
  /** 今日（北京）日桶（getStatsCenter().today()）。 */
  todayStats(): DailyStats
  /** 往数据统计记一条事件（resources 动作的 snapshot）。可选：没接统计模块也能跑。 */
  recordStats?(event: StatsEvent): void
  /** 截图留痕（可选）。返回落盘后的相对路径；失败只记日志。 */
  saveShot?(index: number, jpeg: ArrayBuffer, at: number): Promise<string | null>
  log(level: BotLogLevel, message: string): void
}

// ── 纯函数：账号列表 / 实例状态文案（离线自检直接调） ─────────────────────

/**
 * 把账号库 + 实例注册表 + 调度器 + 告警中心拼成账号列表的行。
 * 纯函数：stateOf / pauseOf 由调用方给（真实环境是 scheduler.getState / alertCenter.getPause）。
 */
export function buildAccountRows(
  accounts: Account[],
  instances: MumuInstance[],
  stateOf: (index: number) => InstanceQueueState,
  pauseOf: (index: number) => InstancePauseState
): BotAccountRow[] {
  return accounts.map((a) => {
    if (a.instanceIndex === null) {
      return {
        accountName: a.name,
        enabled: a.enabled,
        instanceIndex: null,
        instanceName: null,
        instanceState: null,
        auto: null,
        pausedReason: null,
        lastSampledAt: null,
        lastSampleOk: null,
        queueUsed: null,
        queueTotal: null
      }
    }
    const idx = a.instanceIndex
    const inst = instances.find((i) => i.index === idx) ?? null
    const st = stateOf(idx)
    const pause = pauseOf(idx)
    const sampled = st.lastSampledAt > 0
    return {
      accountName: a.name,
      enabled: a.enabled,
      instanceIndex: idx,
      instanceName: inst?.name ?? null,
      instanceState: inst?.state ?? null,
      auto: st.auto,
      pausedReason: pause.paused ? (pause.reason ?? '（无原因）') : null,
      lastSampledAt: sampled ? st.lastSampledAt : null,
      lastSampleOk: sampled ? st.lastSampleOk : null,
      queueUsed: st.queueUsed,
      queueTotal: st.queueTotal
    }
  })
}

/**
 * 一个实例的状态文案（/status 用）。从 index.ts 的 describeInstance 搬过来，时间一律北京时间。
 *
 *   实例 0「主号」
 *     队列 5/5，在途 5 支
 *     自动调度：开
 *     下次唤醒：21:30:00（约 8 分钟后）（队列释放校验）
 *     上次读面板：21:20:11
 *     ⛔ 已暂停：疑似被顶号
 */
export function describeInstanceText(
  index: number,
  state: InstanceQueueState,
  pause: InstancePauseState,
  accountName: string | null,
  now: number
): string {
  const who = accountName ? `「${accountName}」` : ''
  const inFlight = state.marches.filter((m) => m.status !== 'idle').length
  const lines: string[] = [
    `实例 ${index}${who}`,
    `  队列 ${state.queueUsed ?? '?'}/${state.queueTotal ?? '?'}，在途 ${inFlight} 支`,
    `  自动调度：${state.auto ? '开' : '关'}${state.sampling ? '（采样中）' : ''}`,
    state.nextWakeAt
      ? `  下次唤醒：${formatCstClock(state.nextWakeAt)}${describeUntil(state.nextWakeAt, now)}（${state.nextWakeReason ?? ''}）`
      : '  下次唤醒：未排'
  ]
  if (state.lastSampledAt > 0) {
    lines.push(`  上次读面板：${formatCstClock(state.lastSampledAt)}${state.lastSampleOk ? '' : '（失败）'}`)
  }
  if (pause.paused) lines.push(`  ⛔ 已暂停：${pause.reason ?? '（无原因）'}`)
  if (state.error) lines.push(`  ⚠️ ${state.error}`)
  return lines.join('\n')
}

function describeUntil(at: number, now: number): string {
  const ms = at - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return '（已到点）'
  const min = Math.round(ms / 60_000)
  return min < 1 ? '（1 分钟内）' : `（约 ${min} 分钟后）`
}

// ── 动作执行器 ────────────────────────────────────────────────────────────

export function createBotActions(deps: BotActionDeps): BotActionPort {
  const now = (): number => (deps.now ? deps.now() : Date.now())

  const accountNameOf = async (index: number): Promise<string | null> =>
    (await deps.accounts()).find((a) => a.instanceIndex === index)?.name ?? null

  const listInstances = async (): Promise<BotInstanceRef[]> => {
    const byIndex = new Map<number, string | null>()
    for (const a of await deps.accounts()) {
      if (typeof a.instanceIndex !== 'number') continue
      // 同一实例绑了多个账号（理论上不会）取第一个的名字。
      if (!byIndex.has(a.instanceIndex)) byIndex.set(a.instanceIndex, a.name)
    }
    if (byIndex.size === 0) return [{ index: 0, name: null }]
    return [...byIndex.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([index, name]) => ({ index, name }))
  }

  /** required 动作的实例号校验：没给 / 不在可用列表里都抛中文错误。 */
  const requireIndex = async (action: BotAction, index: number | null): Promise<number> => {
    if (index === null) {
      throw new AppError('INVALID_ARGUMENT', '请先选择账号/实例。', { action })
    }
    const known = (await listInstances()).map((i) => i.index)
    if (!known.includes(index)) {
      throw new AppError('NOT_FOUND', `没有这个实例，可用：${known.join(', ')}`, { action, index })
    }
    return index
  }

  const record = (event: StatsEvent): void => {
    if (!deps.recordStats) return
    try {
      deps.recordStats(event)
    } catch (e) {
      // 统计只是顺带的事，记不上绝不能让动作失败。
      deps.log('warn', `数据统计记事件失败（不影响动作）：${AppError.from(e).message}`)
    }
  }

  const status = async (index: number | null): Promise<BotActionResult> => {
    const targets = index === null ? (await listInstances()).map((i) => i.index) : [await requireIndex('status', index)]
    const t = now()
    const parts: string[] = []
    for (const i of targets) {
      parts.push(describeInstanceText(i, deps.schedulerState(i), deps.pauseOf(i), await accountNameOf(i), t))
    }
    return { text: `${parts.join('\n\n')}\n（北京时间 ${formatCstClock(t)}）` }
  }

  const accounts = async (): Promise<BotActionResult> => {
    const [list, insts] = await Promise.all([deps.accounts(), deps.instances()])
    const rows = buildAccountRows(list, insts, deps.schedulerState, deps.pauseOf)
    return { text: renderAccountList(rows, now()) }
  }

  const pause = async (index: number): Promise<BotActionResult> => {
    // 「暂停」事件由调度器 setAuto 翻转时统一通报给数据统计（SchedulerDeps.onAutoChanged），这里不重复记。
    await deps.setAuto(index, false)
    return {
      text: `已手动关闭实例 ${index} 的自动调度。需要时发 /resume ${index} 或点「恢复」。`
    }
  }

  const resume = async (index: number): Promise<BotActionResult> => {
    await deps.resumeInstance(index)
    const t = now()
    return {
      text:
        `已恢复实例 ${index} 的自动调度。\n` +
        describeInstanceText(index, deps.schedulerState(index), deps.pauseOf(index), await accountNameOf(index), t)
    }
  }

  const relaunch = async (index: number): Promise<BotActionResult> => {
    // ① 恢复序列要驱动模拟器 → 锁内；② 恢复调度会抢锁 → 锁外。
    const done = await deps.exclusive(index, '重启游戏', () => deps.recoverGame(index))
    await deps.resumeInstance(index)
    const t = now()
    return {
      text:
        `已处理：${done}。\n已恢复实例 ${index} 的自动调度。\n` +
        describeInstanceText(index, deps.schedulerState(index), deps.pauseOf(index), await accountNameOf(index), t)
    }
  }

  const shot = async (index: number): Promise<BotActionResult> => {
    const cap = await deps.exclusive(index, '截图', () => deps.captureShot(index))
    const accountName = await accountNameOf(index)
    const st = deps.schedulerState(index)
    const pauseState = deps.pauseOf(index)
    const extra = [
      `队列 ${st.queueUsed ?? '?'}/${st.queueTotal ?? '?'}｜自动调度 ${st.auto ? '开' : '关'}`,
      pauseState.paused ? `⛔ 已暂停：${pauseState.reason ?? '（无原因）'}` : ''
    ].filter(Boolean)
    const caption = [
      renderShotCaption({
        instanceIndex: index,
        accountName,
        at: cap.at,
        foreground: cap.foreground,
        gameRunning: cap.gameRunning,
        gamePackage: deps.gamePackage
      }),
      ...extra
    ]
      .join('\n')
      .slice(0, TELEGRAM_CAPTION_MAX)
    const filename = shotFilename(index, cap.at)
    if (deps.saveShot) {
      try {
        const saved = await deps.saveShot(index, cap.jpeg, cap.at)
        if (saved) deps.log('debug', `机器人截图已留痕：${saved}`)
      } catch (e) {
        deps.log('warn', `机器人截图留痕失败（图片照常发出）：${AppError.from(e).message}`)
      }
    }
    return { text: '', photo: { jpeg: cap.jpeg, caption, filename } }
  }

  const resources = async (index: number): Promise<BotActionResult> => {
    const snap = await deps.exclusive(index, '读资源统计', () => deps.readResourceStats(index))
    record({ kind: 'snapshot', at: snap.at, instanceIndex: index, snapshot: snap })
    const accountName = await accountNameOf(index)
    return { text: renderResourceSnapshotText(snap, { accountName, formatTime: formatCst }) }
  }

  const stats = async (): Promise<BotActionResult> => ({
    text: renderDailyStatsText(deps.todayStats(), { now: now(), formatClock: formatCstClock })
  })

  const perform = async (action: BotAction, instanceIndex: number | null): Promise<BotActionResult> => {
    const spec = BOT_ACTION_SPECS[action]
    if (!spec) {
      throw new AppError('INVALID_ARGUMENT', `不认识的机器人动作：${String(action)}`)
    }
    deps.log('info', `机器人动作 ${action}${instanceIndex === null ? '' : `（实例 ${instanceIndex}）`}`)
    switch (action) {
      case 'status':
        return status(instanceIndex)
      case 'accounts':
        return accounts()
      case 'stats':
        return stats()
      case 'menu':
        return { text: '菜单已刷新。', showMenu: true }
      case 'pause':
        return pause(await requireIndex(action, instanceIndex))
      case 'resume':
        return resume(await requireIndex(action, instanceIndex))
      case 'relaunch':
        return relaunch(await requireIndex(action, instanceIndex))
      case 'shot':
        return shot(await requireIndex(action, instanceIndex))
      case 'resources':
        return resources(await requireIndex(action, instanceIndex))
      default: {
        // BOT_ACTIONS 加了新值而这里没实现：TS 会在这里报错，别把它改成 return。
        const never: never = action
        throw new AppError('INVALID_ARGUMENT', `机器人动作 ${String(never)} 还没有实现。`)
      }
    }
  }

  return { perform, listInstances }
}
