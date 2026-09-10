/**
 * Telegram 机器人**动作层**（src/main/bot/actions.ts）与 bot:* 通道的离线自检。
 *
 * ★★ 全程不碰模拟器、不发一条 adb 命令、不发一个网络请求：
 *     · 账号库 / 实例注册表 / 调度器状态 / 告警中心 / 截图 / 读资源统计 全部是假 deps
 *     · exclusive 只计数（并可切换成「有脚本在跑」模式抛 CONCURRENCY_LIMIT）
 *     · electron 用 scripts/stubs/electron-offline.mjs 顶替，bot:* 通道用 ipcMain._invoke 直调
 *
 * 跑法（工程根目录）：
 *     npm run check:bot
 *
 * 覆盖的东西：
 *   一、账号列表：绑定 / 未绑定 / 实例运行态 / 暂停原因 都渲染出来了
 *   二、状态：status:all 覆盖全部可用实例；单实例校验；暂停行
 *   三、截图：走了 exclusive；photo 文件名形状；caption 带北京时间与队列；留痕钩子被调
 *   四、资源统计：走了 exclusive；触发 snapshot 统计事件；文本含四种资源
 *   五、暂停 / 恢复 / 重启：setAuto(false)+统计事件；resume 在锁外；relaunch 先锁内 recover 再锁外 resume
 *   六、错误：required 动作没给实例号抛中文；未知实例抛「没有这个实例」；exclusive 拒绝时原样上抛「稍后再试」
 *   七、bot:* 通道：ipcMain._invoke 走通；错误过桥后能解出 code
 */

import { emptyPauseState, formatCst } from '@shared/alerts'
import type { InstancePauseState } from '@shared/alerts'
import { BOT_CH, parseCallbackData } from '@shared/bot'
import type { Account, MumuInstance } from '@shared/domain'
import { AppError } from '@shared/errors'
import { emptyResourceSnapshot, type ResourceSnapshot } from '@shared/resources'
import type { InstanceQueueState } from '@shared/scheduler'
import { cstDateKey, emptyDailyStats, type StatsEvent } from '@shared/stats'

import { buildAccountRows, createBotActions, describeInstanceText, type BotActionDeps } from '@main/bot/actions'
import { registerBotHandlers, registeredBotChannels, resetBotIpc } from '@main/bot/ipc'
import { emptyInstanceState } from '@main/scheduler/state'

/** electron 桩（esbuild --alias:electron=./scripts/stubs/electron-offline.mjs）里自检专用的 _invoke。 */
interface OfflineIpcMain {
  _invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

async function offlineIpc(): Promise<OfflineIpcMain> {
  const mod = (await import('electron')) as unknown as { ipcMain: OfflineIpcMain }
  return mod.ipcMain
}

// ── 断言小工具 ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n【${title}】`)
}

async function rejects(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  }
}

// ── 假世界 ─────────────────────────────────────────────────────────────────

/** 固定「现在」：2026-09-09 21:22:33 北京时间。 */
const NOW = Date.UTC(2026, 8, 9, 13, 22, 33)

function account(id: string, name: string, instanceIndex: number | null, enabled = true): Account {
  return { id, name, instanceIndex, enabled, createdAt: NOW - 1000, updatedAt: NOW - 1000 }
}

function instance(index: number, name: string, state: string): MumuInstance {
  return {
    index,
    name,
    state,
    adbPort: state === 'running' ? 16384 + index * 32 : null,
    pid: null,
    screenReady: state === 'running',
    bundlePath: null,
    serial: state === 'running' ? `127.0.0.1:${16384 + index * 32}` : null,
    adb: state === 'running' ? 'connected' : 'disconnected',
    accountId: null,
    runId: null
  }
}

function unpaused(index: number): InstancePauseState {
  return emptyPauseState(index)
}

function pausedState(index: number, reason: string): InstancePauseState {
  return {
    ...unpaused(index),
    paused: true,
    type: 'suspectedKicked',
    severity: 'critical',
    reason,
    pausedAt: NOW - 60_000
  }
}

interface World {
  accounts: Account[]
  instances: MumuInstance[]
  states: Map<number, InstanceQueueState>
  pauses: Map<number, InstancePauseState>
  /** exclusive 的调用记录（实例号 + 动作名）。 */
  exclusiveCalls: Array<{ index: number; what: string }>
  /** 切成 true 时 exclusive 假装实例上有脚本在跑。 */
  busy: boolean
  /** 顺序日志：记录 recover / resume / setAuto / capture 的先后。 */
  trace: string[]
  events: StatsEvent[]
  savedShots: string[]
  logs: string[]
}

function makeWorld(): World {
  const s0 = emptyInstanceState(0)
  s0.auto = true
  s0.queueUsed = 4
  s0.queueTotal = 5
  s0.lastSampledAt = NOW - 120_000
  s0.lastSampleOk = true
  s0.nextWakeAt = NOW + 8 * 60_000
  s0.nextWakeReason = '队列释放校验'
  s0.marches = [
    {
      slot: 1,
      status: 'gathering',
      statusText: '采集中',
      targetCoord: '615,535',
      troopCount: 31500,
      commanders: [],
      remainingMs: 600_000,
      timerEndsAt: NOW + 600_000,
      gatherDoneAt: NOW + 600_000,
      freeAt: NOW + 660_000,
      travelTimeMs: 60_000,
      travelTimeSource: 'dispatch',
      sampledAt: NOW - 120_000
    }
  ]
  const s2 = emptyInstanceState(2)
  s2.auto = false
  return {
    accounts: [account('a1', '主号', 0), account('a2', '小号', null, false), account('a3', '三号', 2)],
    instances: [instance(0, 'MuMu-0', 'running'), instance(2, 'MuMu-2', 'stopped')],
    states: new Map([
      [0, s0],
      [2, s2]
    ]),
    pauses: new Map([[2, pausedState(2, '疑似被顶号')]]),
    exclusiveCalls: [],
    busy: false,
    trace: [],
    events: [],
    savedShots: [],
    logs: []
  }
}

function fakeJpeg(bytes: number): ArrayBuffer {
  const ab = new ArrayBuffer(bytes)
  const u8 = new Uint8Array(ab)
  // JPEG 魔数，其余随便填。
  u8[0] = 0xff
  u8[1] = 0xd8
  for (let i = 2; i < bytes; i += 1) u8[i] = i & 0xff
  return ab
}

function fakeSnapshot(index: number): ResourceSnapshot {
  const snap = emptyResourceSnapshot(index, NOW, 'panel')
  const values: Record<string, [number, number, string, string]> = {
    gold: [290_000_000, 1_110_000_000, '2.9亿', '11.1亿'],
    wood: [320_000_000, 410_000_000, '3.2亿', '4.1亿'],
    iron: [200_000_000, 2_240_000_000, '2.0亿', '22.4亿'],
    mana: [620_000_000, 720_000_000, '6.2亿', '7.2亿']
  }
  for (const row of snap.rows) {
    const v = values[row.type]
    row.itemTotal = v[0]
    row.total = v[1]
    row.rawItem = v[2]
    row.rawTotal = v[3]
  }
  return snap
}

function depsOf(w: World): BotActionDeps {
  return {
    now: () => NOW,
    gamePackage: 'com.lilithgames.samo.android.cn',
    accounts: async () => w.accounts,
    instances: async () => w.instances,
    schedulerState: (i) => w.states.get(i) ?? emptyInstanceState(i),
    pauseOf: (i) => w.pauses.get(i) ?? unpaused(i),
    setAuto: async (i, enabled) => {
      w.trace.push(`setAuto:${i}:${enabled}`)
      const st = w.states.get(i) ?? emptyInstanceState(i)
      st.auto = enabled
      w.states.set(i, st)
    },
    resumeInstance: async (i) => {
      w.trace.push(`resume:${i}`)
      w.pauses.delete(i)
      const st = w.states.get(i) ?? emptyInstanceState(i)
      st.auto = true
      w.states.set(i, st)
    },
    recoverGame: async (i) => {
      w.trace.push(`recover:${i}`)
      return '点掉顶号弹窗 → 用 monkey 重启游戏'
    },
    exclusive: async (i, what, fn) => {
      w.exclusiveCalls.push({ index: i, what })
      if (w.busy) {
        throw new AppError('CONCURRENCY_LIMIT', `实例 ${i} 上正有脚本在跑（run_x），${what}稍后再试。`, {
          instanceIndex: i
        })
      }
      w.trace.push(`lock:${i}:${what}`)
      try {
        return await fn()
      } finally {
        w.trace.push(`unlock:${i}:${what}`)
      }
    },
    captureShot: async (i) => {
      w.trace.push(`capture:${i}`)
      return { jpeg: fakeJpeg(2048), at: NOW, foreground: 'com.lilithgames.samo.android.cn', gameRunning: true }
    },
    readResourceStats: async (i) => {
      w.trace.push(`readres:${i}`)
      return fakeSnapshot(i)
    },
    todayStats: () => emptyDailyStats(cstDateKey(NOW), NOW),
    recordStats: (e) => {
      w.events.push(e)
    },
    saveShot: async (i, jpeg, at) => {
      const rel = `bot/inst${i}-${at}.jpg`
      w.savedShots.push(`${rel}:${jpeg.byteLength}`)
      return rel
    },
    log: (level, message) => {
      w.logs.push(`[${level}] ${message}`)
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════

async function checkAccounts(): Promise<void> {
  section('一、账号列表')
  const w = makeWorld()
  const port = createBotActions(depsOf(w))

  const rows = buildAccountRows(w.accounts, w.instances, (i) => w.states.get(i) ?? emptyInstanceState(i), (i) =>
    w.pauses.get(i) ?? unpaused(i)
  )
  ok('buildAccountRows 每个账号一行', rows.length === 3)
  ok('绑定实例 0 的行带实例名与运行态', rows[0].instanceName === 'MuMu-0' && rows[0].instanceState === 'running')
  ok('绑定行带队列与自动调度', rows[0].queueUsed === 4 && rows[0].queueTotal === 5 && rows[0].auto === true)
  ok('未绑定的账号全字段 null', rows[1].instanceIndex === null && rows[1].auto === null && rows[1].lastSampledAt === null)
  ok('被暂停的实例带暂停原因', rows[2].pausedReason === '疑似被顶号')
  ok('没读过面板的实例 lastSampledAt 为 null', rows[2].lastSampledAt === null && rows[2].lastSampleOk === null)

  const r = await port.perform('accounts', null)
  ok('accounts 文案含两个账号名', r.text.includes('主号') && r.text.includes('小号'))
  ok('accounts 文案含「未绑定实例」', r.text.includes('未绑定实例'))
  ok('accounts 文案含「运行中」与「未运行」', r.text.includes('运行中') && r.text.includes('未运行'))
  ok('accounts 文案含暂停原因', r.text.includes('疑似被顶号'))
  ok('accounts 文案含北京时间 21:22:33', r.text.includes('21:22:33'), r.text.split('\n')[0])
  ok('accounts 不带图片、不带菜单', r.photo === undefined && !r.showMenu)

  const list = await port.listInstances()
  ok(
    'listInstances 只列绑定了实例的账号、升序、带账号名',
    list.length === 2 && list[0].index === 0 && list[0].name === '主号' && list[1].index === 2 && list[1].name === '三号'
  )
  const empty = createBotActions({ ...depsOf(w), accounts: async () => [] })
  const l2 = await empty.listInstances()
  ok('没有任何账号时 listInstances 回落到实例 0', l2.length === 1 && l2[0].index === 0 && l2[0].name === null)
}

async function checkStatus(): Promise<void> {
  section('二、状态')
  const w = makeWorld()
  const port = createBotActions(depsOf(w))

  const all = await port.perform('status', null)
  ok('status:all 覆盖全部可用实例', all.text.includes('实例 0「主号」') && all.text.includes('实例 2「三号」'))
  ok('status 含队列与在途', all.text.includes('队列 4/5，在途 1 支'))
  ok('status 下次唤醒用北京时间并带相对分钟', all.text.includes('下次唤醒：21:30:33（约 8 分钟后）'), all.text)
  ok('status 上次读面板 21:20:33', all.text.includes('上次读面板：21:20:33'))
  ok('status 暂停实例带 ⛔ 行', all.text.includes('⛔ 已暂停：疑似被顶号'))
  ok('status 尾行北京时间', all.text.endsWith('（北京时间 21:22:33）'))

  const one = await port.perform('status', 2)
  ok('status:2 只有实例 2', one.text.includes('实例 2') && !one.text.includes('实例 0'))

  const err = await rejects(() => port.perform('status', 7))
  ok('status 未知实例抛「没有这个实例」', !!err && err.message.includes('没有这个实例') && err.message.includes('0, 2'), err?.message)

  const text = describeInstanceText(0, w.states.get(0)!, unpaused(0), null, NOW)
  ok('describeInstanceText 没绑账号时不带「」', text.startsWith('实例 0\n'))
}

async function checkShot(): Promise<void> {
  section('三、截图')
  const w = makeWorld()
  const port = createBotActions(depsOf(w))

  const r = await port.perform('shot', 0)
  ok('shot 走了 exclusive（实例 0，动作名「截图」）', w.exclusiveCalls.some((c) => c.index === 0 && c.what === '截图'))
  ok('截图发生在锁内', w.trace.indexOf('lock:0:截图') < w.trace.indexOf('capture:0') && w.trace.indexOf('capture:0') < w.trace.indexOf('unlock:0:截图'))
  ok('返回了 photo 且 text 为空', !!r.photo && r.text === '')
  ok('photo.jpeg 原样带回（2048 字节）', r.photo?.jpeg.byteLength === 2048)
  ok('photo.filename 形状 inst0-YYYYMMDD-HHMMSS.jpg', /^inst0-20260909-212233\.jpg$/.test(r.photo?.filename ?? ''), r.photo?.filename)
  ok('caption 含实例、账号、北京时间', !!r.photo && r.photo.caption.includes('实例 0「主号」截图') && r.photo.caption.includes(formatCst(NOW)))
  ok('caption 含前台=游戏 与 进程存活', !!r.photo && r.photo.caption.includes('前台：游戏（') && r.photo.caption.includes('游戏进程：存活'))
  ok('caption 含队列 N/M 与自动调度', !!r.photo && r.photo.caption.includes('队列 4/5｜自动调度 开'))
  ok('caption ≤ 1024 字', !!r.photo && r.photo.caption.length <= 1024)
  ok('留痕钩子被调且拿到同一份字节', w.savedShots.length === 1 && w.savedShots[0].endsWith(':2048'))

  // 留痕失败不影响发图
  const w2 = makeWorld()
  const port2 = createBotActions({
    ...depsOf(w2),
    saveShot: async () => {
      throw new Error('磁盘满了')
    }
  })
  const r2 = await port2.perform('shot', 0)
  ok('留痕失败时图片照常返回并记 warn', !!r2.photo && w2.logs.some((l) => l.startsWith('[warn]') && l.includes('磁盘满了')))

  // 暂停中的实例截图：caption 带暂停原因
  const r3 = await port.perform('shot', 2)
  ok('暂停实例的 caption 带 ⛔ 暂停原因', !!r3.photo && r3.photo.caption.includes('⛔ 已暂停：疑似被顶号'))
}

async function checkResources(): Promise<void> {
  section('四、资源统计')
  const w = makeWorld()
  const port = createBotActions(depsOf(w))

  const r = await port.perform('resources', 0)
  ok('resources 走了 exclusive（动作名「读资源统计」）', w.exclusiveCalls.some((c) => c.index === 0 && c.what === '读资源统计'))
  ok('读表发生在锁内', w.trace.indexOf('lock:0:读资源统计') < w.trace.indexOf('readres:0') && w.trace.indexOf('readres:0') < w.trace.indexOf('unlock:0:读资源统计'))
  const snapEvents = w.events.filter((e) => e.kind === 'snapshot')
  ok('触发了一条 snapshot 统计事件', snapEvents.length === 1 && snapEvents[0].instanceIndex === 0 && snapEvents[0].at === NOW)
  ok('文本含四种资源', ['金币', '木材', '铁矿石', '魔水'].every((n) => r.text.includes(n)))
  ok('文本含 11.1亿 / 22.4亿', r.text.includes('11.1亿') && r.text.includes('22.4亿'))
  ok('文本含账号名与北京时间', r.text.includes('「主号」') && r.text.includes(formatCst(NOW)))
  ok('文本含精度尾注', r.text.includes('精度 0.1亿'))

  // 统计模块记事件抛错 → 动作照常成功
  const w2 = makeWorld()
  const port2 = createBotActions({
    ...depsOf(w2),
    recordStats: () => {
      throw new Error('统计炸了')
    }
  })
  const r2 = await port2.perform('resources', 0)
  ok('recordStats 抛错不影响结果并记 warn', r2.text.includes('金币') && w2.logs.some((l) => l.includes('统计炸了')))

  // 没接 recordStats 也能跑
  const w3 = makeWorld()
  const port3 = createBotActions({ ...depsOf(w3), recordStats: undefined })
  const r3 = await port3.perform('resources', 0)
  ok('没有 recordStats 时 resources 照常返回', r3.text.includes('魔水'))
}

async function checkPauseResumeRelaunch(): Promise<void> {
  section('五、暂停 / 恢复 / 重启')
  const w = makeWorld()
  const port = createBotActions(depsOf(w))

  const p = await port.perform('pause', 0)
  ok('pause 调了 setAuto(0,false)', w.trace.includes('setAuto:0:false'))
  // ★ 「暂停」统计事件的唯一来源是调度器 setAuto 翻转时的 onAutoChanged（见 SchedulerDeps），动作层不重复记，
  //   否则面板开关 / 告警暂停 / 机器人暂停三条路会记出三种口径。
  ok('pause 不自己记 paused 事件（由调度器 onAutoChanged 统一通报）', !w.events.some((e) => e.kind === 'paused'))
  ok('pause 不抢锁', w.exclusiveCalls.length === 0)
  ok('pause 文案提示 /resume 0', p.text.includes('/resume 0'))

  const r = await port.perform('resume', 2)
  ok('resume 调了 resumeInstance(2)', w.trace.includes('resume:2'))
  ok('resume 不抢锁', w.exclusiveCalls.length === 0)
  ok('resume 文案带恢复后的状态', r.text.includes('已恢复实例 2') && r.text.includes('自动调度：开'))

  w.trace.length = 0
  const rl = await port.perform('relaunch', 0)
  const i = (s: string): number => w.trace.indexOf(s)
  ok('relaunch：recoverGame 在锁内', i('lock:0:重启游戏') < i('recover:0') && i('recover:0') < i('unlock:0:重启游戏'))
  ok('relaunch：resume 在锁外、在 recover 之后', i('unlock:0:重启游戏') < i('resume:0'))
  ok('relaunch 文案含处理步骤', rl.text.includes('点掉顶号弹窗') && rl.text.includes('已恢复实例 0'))

  const m = await port.perform('menu', null)
  ok('menu 返回 showMenu', m.showMenu === true && m.text.length > 0)

  const s = await port.perform('stats', null)
  ok('stats 文案含「派兵 0 次」与今天的北京日期', s.text.includes('派兵 0 次') && s.text.includes('2026-09-09'))
}

async function checkErrors(): Promise<void> {
  section('六、错误')
  const w = makeWorld()
  const port = createBotActions(depsOf(w))

  for (const a of ['shot', 'resources', 'resume', 'relaunch', 'pause'] as const) {
    const err = await rejects(() => port.perform(a, null))
    ok(`${a} 没给实例号抛中文「请先选择」`, !!err && err.message.includes('请先选择') && AppError.from(err).code === 'INVALID_ARGUMENT')
  }
  const unknown = await rejects(() => port.perform('shot', 5))
  ok('shot 未知实例抛「没有这个实例，可用：0, 2」', !!unknown && unknown.message.includes('没有这个实例，可用：0, 2'), unknown?.message)
  ok('校验失败时没有抢锁、没有截图', w.exclusiveCalls.length === 0 && !w.trace.some((t) => t.startsWith('capture')))

  w.busy = true
  const busyErr = await rejects(() => port.perform('shot', 0))
  ok('exclusive 拒绝时 perform 原样抛出（含「稍后再试」）', !!busyErr && busyErr.message.includes('稍后再试'), busyErr?.message)
  ok('拒绝的错误码是 CONCURRENCY_LIMIT', !!busyErr && AppError.from(busyErr).code === 'CONCURRENCY_LIMIT')
  ok('被拒绝时没有截图', !w.trace.some((t) => t.startsWith('capture')))
  const busyRes = await rejects(() => port.perform('resources', 0))
  ok('读资源统计同样被拒绝', !!busyRes && busyRes.message.includes('读资源统计稍后再试'))
  w.busy = false

  // 回调数据 → 动作，与 perform 的实例语义对得上
  const cb = parseCallbackData('res:2')
  ok('res:2 解析成 resources/2', cb?.action === 'resources' && cb?.instanceIndex === 2)
  const viaCb = await port.perform(cb!.action, cb!.instanceIndex)
  ok('按回调解析结果执行 resources 成功', viaCb.text.includes('实例 2「三号」资源统计'))
}

async function checkIpc(): Promise<void> {
  section('七、bot:* 通道')
  const w = makeWorld()
  const port = createBotActions(depsOf(w))
  resetBotIpc()
  registerBotHandlers(port)
  const ipcMain = await offlineIpc()
  const chans = registeredBotChannels()
  ok('两条 bot:* 通道都注册上了', chans.includes(BOT_CH.perform) && chans.includes(BOT_CH.instances) && chans.length === 2)

  const list = (await ipcMain._invoke(BOT_CH.instances)) as Array<{ index: number }>
  ok('bot:instances 走通', Array.isArray(list) && list.length === 2 && list[0].index === 0)

  const r = (await ipcMain._invoke(BOT_CH.perform, 'accounts', null)) as { text: string }
  ok('bot:perform accounts 走通', typeof r.text === 'string' && r.text.includes('主号'))

  const shot = (await ipcMain._invoke(BOT_CH.perform, 'shot', 0)) as { photo?: { jpeg: ArrayBuffer } }
  ok('bot:perform shot 过桥后 jpeg 仍是 ArrayBuffer', shot.photo?.jpeg instanceof ArrayBuffer && shot.photo.jpeg.byteLength === 2048)

  let bridged: Error | null = null
  try {
    await ipcMain._invoke(BOT_CH.perform, 'shot', null)
  } catch (e) {
    bridged = e as Error
  }
  let decoded: { code?: string; message?: string } | null = null
  try {
    decoded = JSON.parse(bridged?.message ?? '') as { code?: string; message?: string }
  } catch {
    decoded = null
  }
  ok('错误过桥后能解出 code 与中文', decoded?.code === 'INVALID_ARGUMENT' && !!decoded?.message?.includes('请先选择'), bridged?.message)

  let dup: Error | null = null
  try {
    registerBotHandlers(port)
  } catch (e) {
    dup = e as Error
  }
  ok('重复注册会立刻抛出', !!dup && dup.message.includes('重复注册'))
  resetBotIpc()
  ok('resetBotIpc 清空', registeredBotChannels().length === 0)
}

// ══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('★ 本自检不碰模拟器、不发任何网络请求（机器人动作层 + bot:* 通道）。')
  await checkAccounts()
  await checkStatus()
  await checkShot()
  await checkResources()
  await checkPauseResumeRelaunch()
  await checkErrors()
  await checkIpc()
  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
  if (fail > 0) process.exitCode = 1
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
