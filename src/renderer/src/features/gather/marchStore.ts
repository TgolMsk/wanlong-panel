/**
 * 队列 / 在途队伍状态在渲染进程侧的仓库。
 *
 * 数据来源是 `@shared/scheduler` 的调度器通道：
 *   · 首屏 `scheduler:state` 拉全量
 *   · 之后 `scheduler:changed` 增量推送（采样完成、开关自动、排期变化都会推）
 *   · 面板上的「立即采样」按钮走 `scheduler:sample`
 *
 * ★ 这里存的是**采样快照**，不是每秒变的倒计时。
 *   界面上跳动的秒数由 present.ts 调 `@shared/scheduler.deriveMarchView` 本地推算，
 *   不写回仓库 —— 否则每秒一次全量 setState，几十行队伍会把渲染进程拖垮。
 *
 * ★ 主进程还没注册调度器通道时，`callScheduler` 会 reject。
 *   那不是崩溃，是「功能还没接线」，所以这里把它翻译成一句中文说明放进 `error`，
 *   界面照常渲染占位卡片。**绝不静默吞异常**。
 */

import { create } from 'zustand'
import {
  callScheduler,
  onSchedulerEvent,
  defaultSchedulerConfig,
  type InstanceQueueState,
  type SchedulerConfig
} from '@shared/scheduler'

/** 把任意异常翻译成一句能指向修复方向的中文。 */
export function describeSchedulerError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const stripped = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
  if (/No handler registered|no handler/i.test(stripped)) {
    return (
      '主进程还没有注册调度器通道（scheduler:*）。ETA 调度模块接线之后本页会自动可用，' +
      '在此之前显示的是占位数据。'
    )
  }
  return stripped || '未知错误'
}

interface MarchStoreState {
  /** instanceIndex -> 队列状态。 */
  byInstance: Record<number, InstanceQueueState>
  config: SchedulerConfig
  /** 首屏是否已经拉过一次（不管成功失败）。 */
  loaded: boolean
  /** 拉取/订阅失败的中文原因；正常为 null。 */
  error: string | null
  /** 正在为哪些实例采样（用于按钮转圈与防连点）。 */
  sampling: Record<number, boolean>

  upsert: (s: InstanceQueueState) => void
  replaceAll: (list: readonly InstanceQueueState[]) => void
  setConfig: (c: SchedulerConfig) => void
  setError: (msg: string | null) => void

  /** 首屏拉全量 + 调度配置。失败只记 error，不抛。 */
  load: () => Promise<void>
  /** 手动采样一个实例。失败返回中文原因，成功返回 null。 */
  sampleOne: (instanceIndex: number) => Promise<string | null>
  /** 开/关某个实例的自动调度。失败返回中文原因。 */
  setAuto: (instanceIndex: number, enabled: boolean) => Promise<string | null>
  /** 保存部分调度配置。失败返回中文原因。 */
  saveConfig: (patch: Partial<SchedulerConfig>) => Promise<string | null>
}

export const useMarchStore = create<MarchStoreState>()((set, get) => ({
  byInstance: {},
  config: defaultSchedulerConfig(),
  loaded: false,
  error: null,
  sampling: {},

  upsert: (s) => set((st) => ({ byInstance: { ...st.byInstance, [s.instanceIndex]: s } })),

  replaceAll: (list) =>
    set(() => {
      const next: Record<number, InstanceQueueState> = {}
      for (const s of list) next[s.instanceIndex] = s
      return { byInstance: next }
    }),

  setConfig: (c) => set({ config: c }),
  setError: (msg) => set({ error: msg }),

  load: async () => {
    try {
      const list = await callScheduler('scheduler:state')
      get().replaceAll(list)
      set({ error: null })
    } catch (e) {
      set({ error: describeSchedulerError(e) })
    } finally {
      set({ loaded: true })
    }
    // 配置单独拉：状态拉失败不代表配置也拉不到，反之亦然。
    try {
      const cfg = await callScheduler('scheduler:config')
      set({ config: cfg })
    } catch {
      // 配置拉不到就用默认值，上面的 error 已经把原因说清楚了，不再重复弹一遍。
    }
  },

  sampleOne: async (instanceIndex) => {
    if (get().sampling[instanceIndex]) return '这个实例正在采样，等它完成再点。'
    set((st) => ({ sampling: { ...st.sampling, [instanceIndex]: true } }))
    try {
      const s = await callScheduler('scheduler:sample', instanceIndex)
      get().upsert(s)
      return null
    } catch (e) {
      return describeSchedulerError(e)
    } finally {
      set((st) => {
        const next = { ...st.sampling }
        delete next[instanceIndex]
        return { sampling: next }
      })
    }
  },

  setAuto: async (instanceIndex, enabled) => {
    try {
      const s = await callScheduler('scheduler:setAuto', instanceIndex, enabled)
      get().upsert(s)
      return null
    } catch (e) {
      return describeSchedulerError(e)
    }
  },

  saveConfig: async (patch) => {
    try {
      const cfg = await callScheduler('scheduler:saveConfig', patch)
      set({ config: cfg })
      return null
    } catch (e) {
      return describeSchedulerError(e)
    }
  }
}))

/**
 * 订阅调度器推送。返回退订函数，直接 `useEffect(() => subscribeScheduler(), [])` 即可。
 * 通道尚未注册时 `onSchedulerEvent` 可能抛（window.api 不在），这里兜住并记下中文原因。
 */
export function subscribeScheduler(): () => void {
  const offs: Array<() => void> = []
  try {
    offs.push(
      onSchedulerEvent('scheduler:changed', (s) => {
        useMarchStore.getState().upsert(s)
      })
    )
    offs.push(
      onSchedulerEvent('scheduler:configChanged', (c) => {
        useMarchStore.getState().setConfig(c)
      })
    )
  } catch (e) {
    useMarchStore.getState().setError(describeSchedulerError(e))
  }
  return () => {
    for (const off of offs) {
      try {
        off()
      } catch {
        /* 退订失败无所谓，页面已经卸载了 */
      }
    }
  }
}

/** 给一个还没有任何调度记录的实例造一条占位，界面才好统一渲染。 */
export function emptyQueueState(
  instanceIndex: number,
  accountId: string | null
): InstanceQueueState {
  return {
    instanceIndex,
    accountId,
    queueUsed: null,
    queueTotal: null,
    marches: [],
    lastSampledAt: 0,
    lastSampleOk: false,
    error: null,
    warnings: [],
    auto: false,
    sampling: false,
    nextWakeAt: null,
    nextWakeReason: null,
    backoffStep: 0
  }
}
