/**
 * 模块 a：模拟器驱动层 + 实例注册表。
 *
 * 命名说明：目录叫 mumu 是历史原因（工程最初只对接 macOS 的 MuMu Pro）。现在这里有三个驱动
 * （driver.ts 的 EmulatorDriver）：雷电（ldplayer/，Windows）、MuMu（mumuwin/，Windows 的 MuMuManager.exe）
 * 与 MuMu Pro（instances.ts，macOS 的 mumutool）。AppSettings.emulator 只有 ldplayer / mumu 两个值，
 * `mumu` 在 Windows 上落到 mumuwin/、在 macOS 上落到 instances.ts。上层（注册表 / IPC handler / 脚本）
 * 只通过 getEmulatorDriver() 或本文件导出的 listInstances() 使用，不直接 import 某个驱动。
 *
 * 注册表：面板里「实例列表」这份**唯一真相**。
 *   1. 一份实例记录由三个来源拼起来 —— 驱动给硬件事实（state / adb_port / pid），
 *      adb 层（模块 b）给连接态，编排层（模块 d）给账号绑定与当前 runId。
 *      注册表负责把三者合并，并保证轮询刷新时**不会把上层填的字段冲掉**。
 *   2. 轮询要做内容 diff。实测 `mumutool info all` 25~35ms、`ldconsole list2` 15ms，3 秒一次开销可以忽略，
 *      但如果每次轮询都往渲染进程推一遍列表，面板会无谓重渲染。所以只在内容真变了时才触发。
 *
 * 本文件不注册任何 IPC handler（那是模块 e 的事），只导出函数。纯 Node，不 import electron。
 */

import { DEFAULT_ADB_PATH, DEFAULT_MUMUTOOL_PATH } from '@shared/constants'
import type { EmulatorKind, MumuInstance } from '@shared/domain'
import { AppError } from '@shared/errors'
import type { EmulatorDriver } from './driver'
import { createMumuDriver } from './instances'
import { detectLdInstall } from './ldplayer/detect'
import { createLdDriver } from './ldplayer/index'
import { detectMumuWinInstall } from './mumuwin/detect'
import { createMumuWinDriver } from './mumuwin/index'

export type { EmulatorDriver } from './driver'
export * from './cli'
export * from './instances'
export { createLdDriver, LD_MODIFY_KEYS } from './ldplayer/index'
export { detectLdInstall, ldPathsOf } from './ldplayer/detect'
export type { LdInstall } from './ldplayer/detect'
export { parseLdList2, ldRawToInstance } from './ldplayer/parse'
export {
  createMumuWinDriver,
  MUMU_WIN_SETTING_KEYS,
  buildMumuWinSettingArgs
} from './mumuwin/index'
export { detectMumuWinInstall, mumuWinPathsOf } from './mumuwin/detect'
export type { MumuWinInstall } from './mumuwin/detect'
export { parseMumuWinInfo, mumuWinRawToInstance, parseMumuWinResolutions } from './mumuwin/parse'

// ── 驱动选择 ─────────────────────────────────────────────────────────────

/** `mumu` 按平台落到不同实现：Windows = MuMuManager.exe（mumuwin/），macOS = mumutool（instances.ts）。 */
const drivers: Record<EmulatorKind, EmulatorDriver> = {
  ldplayer: createLdDriver(),
  mumu: process.platform === 'win32' ? createMumuWinDriver() : createMumuDriver()
}

/** 未配置前的默认驱动是 MuMu（两个平台都是）；雷电要由设置显式选。 */
let current: EmulatorDriver = drivers.mumu

/**
 * 切换驱动 / 覆盖 CLI 路径。主进程在设置加载与每次设置变更时调用。
 * kind 先于 cliPath 生效：即使路径为空（抛 INVALID_ARGUMENT），驱动种类也已经切过去了。
 */
export function configureEmulator(opts: { kind?: EmulatorKind; cliPath?: string }): EmulatorDriver {
  if (opts.kind !== undefined) {
    const next = drivers[opts.kind]
    if (!next) {
      throw new AppError('INVALID_ARGUMENT', `不认识的模拟器种类：${String(opts.kind)}`, {
        kind: opts.kind
      })
    }
    current = next
  }
  if (opts.cliPath !== undefined) current.setCliPath(opts.cliPath)
  return current
}

export function getEmulatorDriver(): EmulatorDriver {
  return current
}

/** 按当前驱动列出实例（脚本与冒烟用；面板走注册表）。 */
export function listInstances(): Promise<MumuInstance[]> {
  return current.list()
}

// ── 命令行脚本的引导 ─────────────────────────────────────────────────────

export interface ScriptEmulatorEnv {
  kind: EmulatorKind
  cliPath: string
  adbPath: string
  /** 路径是怎么来的，打进日志方便排障。 */
  source: string
}

/**
 * 命令行脚本（smoke / live:* / tplkit，不经过 Electron 的设置文件）用：
 * 按环境变量与平台解析驱动和两个可执行文件路径，并把驱动配置好。调用方拿返回值去 initAdb。
 *
 *   WL_EMULATOR      ldplayer | mumu（**默认 mumu**；用雷电要显式设 WL_EMULATOR=ldplayer）
 *   WL_LDPLAYER_DIR  雷电安装目录（默认读注册表 / 扫常见目录）
 *   WL_MUMU_DIR      Windows 版 MuMu 安装目录（默认读卸载注册表 / 扫常见目录 / 看正在跑的 MuMu 进程）
 *   WL_EMULATOR_CLI  直接指定 ldconsole.exe / MuMuManager.exe / mumutool 路径
 *   WL_ADB           直接指定 adb 路径
 */
export async function bootstrapEmulatorForScripts(): Promise<ScriptEmulatorEnv> {
  const env = process.env
  const kindRaw = (env['WL_EMULATOR'] ?? '').trim()
  const kind: EmulatorKind = kindRaw === 'ldplayer' || kindRaw === 'mumu' ? kindRaw : 'mumu'

  let cliPath = (env['WL_EMULATOR_CLI'] ?? '').trim()
  let adbPath = (env['WL_ADB'] ?? '').trim()
  let source = '环境变量'

  if (kind === 'ldplayer') {
    if (!cliPath || !adbPath) {
      const hit = await detectLdInstall()
      if (!hit) {
        throw new AppError(
          'NOT_FOUND',
          '没有找到雷电模拟器的安装目录。请设置环境变量 WL_LDPLAYER_DIR=<雷电安装目录>（目录下要有 ldconsole.exe 与 adb.exe）。',
          {
            tried: ['WL_LDPLAYER_DIR', '注册表 HKCU/HKLM\\SOFTWARE\\leidian\\LDPlayer*', '常见目录']
          }
        )
      }
      cliPath = cliPath || hit.cliPath
      adbPath = adbPath || hit.adbPath
      source = `雷电安装目录 ${hit.dir}（${hit.source === 'registry' ? '注册表' : hit.source === 'env' ? 'WL_LDPLAYER_DIR' : '常见目录扫描'}）`
    }
  } else if (process.platform === 'win32') {
    if (!cliPath || !adbPath) {
      const hit = await detectMumuWinInstall()
      if (!hit) {
        throw new AppError(
          'NOT_FOUND',
          '没有找到 MuMu 模拟器的安装目录。请设置环境变量 WL_MUMU_DIR=<MuMu 安装目录>（目录下的 nx_main 或 shell 里要有 MuMuManager.exe 与 adb.exe）。',
          {
            tried: [
              'WL_MUMU_DIR',
              '卸载注册表 Uninstall\\MuMuPlayer\\InstallLocation',
              '常见目录',
              '正在运行的 MuMu 进程'
            ]
          }
        )
      }
      cliPath = cliPath || hit.cliPath
      adbPath = adbPath || hit.adbPath
      source = `MuMu 安装目录 ${hit.dir}（${describeMumuSource(hit.source)}）`
    }
  } else {
    cliPath = cliPath || DEFAULT_MUMUTOOL_PATH
    adbPath = adbPath || DEFAULT_ADB_PATH
    source = cliPath === DEFAULT_MUMUTOOL_PATH ? 'MuMu 默认路径' : '环境变量'
  }

  configureEmulator({ kind, cliPath })
  return { kind, cliPath, adbPath, source }
}

function describeMumuSource(s: 'env' | 'registry' | 'scan' | 'process'): string {
  if (s === 'registry') return '卸载注册表'
  if (s === 'env') return 'WL_MUMU_DIR'
  if (s === 'process') return '正在运行的 MuMu 进程'
  return '常见目录扫描'
}

// ── 注册表 ───────────────────────────────────────────────────────────────

/** 上层可以回填的字段。驱动层自己永远不写这三个。 */
export type InstanceOverlay = Pick<MumuInstance, 'adb' | 'accountId' | 'runId'>

export interface InstanceRegistry {
  /** 开始轮询。重复调用会用新的间隔重启轮询。 */
  start(pollIntervalMs: number): void
  stop(): void
  /** 缓存的实例列表（含上层合并进来的 adb/account/run 字段），按 index 升序。 */
  snapshot(): MumuInstance[]
  /** 按 index 取单个实例；不存在返回 undefined。 */
  get(index: number): MumuInstance | undefined
  /** 强制立刻拉一次，返回最新列表。并发调用共享同一次请求。 */
  refresh(): Promise<MumuInstance[]>
  /** 单实例字段合并，模块 b/d 用它回填 adb 连接态、绑定账号、当前 runId。 */
  patch(index: number, patch: Partial<InstanceOverlay>): void
  /** 列表变化时触发（内容 diff，不是每次轮询都触发）。返回取消订阅函数。 */
  onChange(cb: (list: MumuInstance[]) => void): () => void
  /** 轮询期间的错误出口。不订阅的话错误只会打到 console，不会中断轮询。 */
  onError(cb: (err: AppError) => void): () => void
}

/** 轮询间隔下限。比这更密没有意义，只会白白占用模拟器的服务进程。 */
const MIN_POLL_INTERVAL_MS = 500

export function createRegistry(): InstanceRegistry {
  let cache: MumuInstance[] = []
  let signature = ''
  /** 上层回填的字段，按 index 存。轮询时用它覆盖驱动给的初始值。 */
  const overlays = new Map<number, Partial<InstanceOverlay>>()
  /** 上一轮看到的 adb 端口，用来发现「实例重启后端口变了」。 */
  const lastPorts = new Map<number, number | null>()

  const changeCbs = new Set<(list: MumuInstance[]) => void>()
  const errorCbs = new Set<(err: AppError) => void>()

  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let intervalMs = 3000
  let inflight: Promise<MumuInstance[]> | null = null

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** 只包含会影响 UI 的字段；顺序固定，可以直接当 diff 用的签名。 */
  const signatureOf = (list: MumuInstance[]): string =>
    list
      .map((i) =>
        [
          i.index,
          i.name,
          i.state,
          i.adbPort ?? '-',
          i.pid ?? '-',
          i.screenReady ? 1 : 0,
          i.serial ?? '-',
          i.adb,
          i.accountId ?? '-',
          i.runId ?? '-',
          i.resolution ? `${i.resolution.width}x${i.resolution.height}@${i.resolution.dpi}` : '-'
        ].join('')
      )
      .join('')

  const emitChange = (): void => {
    const list = snapshot()
    for (const cb of changeCbs) {
      try {
        cb(list)
      } catch (e) {
        // 订阅方自己炸了不该影响其它订阅方，更不该中断轮询。
        console.error('[mumu] onChange 回调抛错：', e)
      }
    }
  }

  const emitError = (e: unknown): void => {
    const err = AppError.from(e)
    if (errorCbs.size === 0) {
      console.error(`[mumu] 实例轮询失败：${err.message}`)
      return
    }
    for (const cb of errorCbs) {
      try {
        cb(err)
      } catch (inner) {
        console.error('[mumu] onError 回调抛错：', inner)
      }
    }
  }

  /** 把驱动给的硬件事实与上层 overlay 合并成最终视图。 */
  const merge = (base: MumuInstance): MumuInstance => {
    const ov = overlays.get(base.index)
    if (!ov) return base
    return {
      ...base,
      adb: ov.adb ?? base.adb,
      accountId: ov.accountId ?? base.accountId,
      runId: ov.runId ?? base.runId
    }
  }

  const doRefresh = async (): Promise<MumuInstance[]> => {
    const bases = await current.list()
    const alive = new Set<number>()

    const next = bases
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((base) => {
        alive.add(base.index)

        // ★ adb_port 变了（MuMu 实例重启会重新分配；雷电固定但停机后是 null）说明旧的 serial 已经失效，
        //   必须把连接态打回 disconnected，让模块 b 重新 connect，
        //   否则面板会一直显示「已连接」而所有 adb 命令都打在一个死 serial 上。
        const prevPort = lastPorts.get(base.index)
        if (prevPort !== undefined && prevPort !== base.adbPort) {
          const ov = overlays.get(base.index)
          if (ov) ov.adb = 'disconnected'
        }
        lastPorts.set(base.index, base.adbPort)

        // 实例已经不在 running 了，连接态同样作废。
        if (!base.screenReady) {
          const ov = overlays.get(base.index)
          if (ov && ov.adb !== 'disconnected') ov.adb = 'disconnected'
        }

        return merge(base)
      })

    // 实例被删掉了，清掉它的残留状态，避免 index 复用时读到上一个实例的账号绑定。
    for (const idx of [...overlays.keys()]) if (!alive.has(idx)) overlays.delete(idx)
    for (const idx of [...lastPorts.keys()]) if (!alive.has(idx)) lastPorts.delete(idx)

    cache = next
    const sig = signatureOf(next)
    if (sig !== signature) {
      signature = sig
      emitChange()
    }
    return next
  }

  const schedule = (): void => {
    if (!running) return
    timer = setTimeout(() => {
      void tick()
    }, intervalMs)
    // 别让轮询定时器把 Electron 主进程钉住不退出。
    timer.unref?.()
  }

  const tick = async (): Promise<void> => {
    try {
      await refresh()
    } catch (e) {
      emitError(e)
    } finally {
      schedule()
    }
  }

  // ── 对外 ────────────────────────────────────────────────────────────────

  function snapshot(): MumuInstance[] {
    // 返回副本：调用方（渲染进程 / zustand）拿到后可能会长期持有，不能让它改到内部状态。
    return cache.map((i) => ({ ...i }))
  }

  function refresh(): Promise<MumuInstance[]> {
    // 并发的 refresh 合并成一次真实调用：面板上「刷新」按钮被连点时不该打出 N 条 CLI。
    if (inflight) return inflight
    inflight = doRefresh().finally(() => {
      inflight = null
    })
    return inflight
  }

  return {
    start(pollIntervalMs: number): void {
      intervalMs = Math.max(MIN_POLL_INTERVAL_MS, Math.floor(pollIntervalMs) || 3000)
      if (running) {
        // 已经在跑：只换间隔，不重复起第二条定时器链。
        if (timer) clearTimeout(timer)
        schedule()
        return
      }
      running = true
      void tick()
    },

    stop(): void {
      running = false
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },

    snapshot,
    get: (index: number) => cache.find((i) => i.index === index),
    refresh,

    patch(index: number, patch: Partial<InstanceOverlay>): void {
      const ov = overlays.get(index) ?? {}
      if (patch.adb !== undefined) ov.adb = patch.adb
      if (patch.accountId !== undefined) ov.accountId = patch.accountId
      if (patch.runId !== undefined) ov.runId = patch.runId
      overlays.set(index, ov)

      // 立刻反映到缓存，不必等下一轮轮询 —— 点「连接」后面板应当马上变成「连接中」。
      const at = cache.findIndex((i) => i.index === index)
      if (at >= 0) {
        const merged = merge(cache[at]!)
        cache = [...cache.slice(0, at), merged, ...cache.slice(at + 1)]
        const sig = signatureOf(cache)
        if (sig !== signature) {
          signature = sig
          emitChange()
        }
      }
    },

    onChange(cb): () => void {
      changeCbs.add(cb)
      return () => changeCbs.delete(cb)
    },

    onError(cb): () => void {
      errorCbs.add(cb)
      return () => errorCbs.delete(cb)
    }
  }
}
