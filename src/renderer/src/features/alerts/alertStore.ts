/**
 * 异常告警 / 自动暂停 / Telegram 推送在渲染进程侧的仓库。
 *
 * 数据来源是 `@shared/alerts` 的告警通道（与 scheduler:* 同一条 Electron 桥，
 * 但自带一小组 alerts:* 通道，没有登记进已冻结的 IpcRoutes）：
 *   · 首屏 `alerts:config` / `alerts:pauses` / `alerts:history` 各拉一次
 *   · 之后 `alerts:pauseChanged` / `alerts:raised` / `alerts:configChanged` 增量推送
 *   · 「测试推送」按钮走 `alerts:test`，「恢复」按钮走 `alerts:resume`
 *
 * ★ 凭据纪律：本仓库里**永远不会**出现完整的 bot token。
 *   主进程给的是 AlertsConfigView（token 已打码，只留后 4 位，类型上根本没有 botToken 这个键）。
 *   用户新填的 token 只在表单组件的局部 state 里存在一瞬间，随 saveConfig 的补丁送走后即丢弃，
 *   不写进本仓库、不写进 localStorage、不打日志。
 *
 * ★ 主进程还没接线时 `callAlerts` 会 reject。那不是崩溃，是「功能还没接上」，
 *   所以这里把它翻译成一句中文放进 `error`，界面照常渲染。**绝不静默吞异常**。
 *   写法与 features/gather/marchStore.ts 完全一致。
 */

import { create } from 'zustand'
import {
  ALERT_HISTORY_LIMIT,
  callAlerts,
  defaultAlertsConfig,
  describeAlertError,
  emptyPauseState,
  onAlertEvent,
  toAlertsConfigView,
  type AlertRecord,
  type AlertsConfigPatch,
  type AlertsConfigView,
  type InstancePauseState,
  type NotifyResult
} from '@shared/alerts'

/**
 * 首屏还没拿到主进程配置时用的占位视图。
 * ★ 默认值只有一个权威来源 `defaultAlertsConfig()`，这里绝不另写一份字面量。
 */
function placeholderConfigView(): AlertsConfigView {
  return toAlertsConfigView(defaultAlertsConfig())
}

interface AlertStoreState {
  /** 打码后的配置视图（token 不过桥）。 */
  configView: AlertsConfigView
  /** instanceIndex -> 暂停态。没有条目 = 该实例没被暂停。 */
  pauses: Record<number, InstancePauseState>
  /** 最近告警，新的在前。 */
  history: AlertRecord[]
  /** 首屏是否已经拉过一次（不管成功失败）。 */
  loaded: boolean
  /** 配置是否真的来自主进程（false 时界面上要说明「显示的是默认值」）。 */
  configFromMain: boolean
  /** 拉取/订阅失败的中文原因；正常为 null。 */
  error: string | null
  /** 正在保存配置。 */
  saving: boolean
  /** 正在测试推送。 */
  testing: boolean
  /** 最近一次测试推送的结果（中文原因已在主进程分好类）。 */
  testResult: NotifyResult | null
  /** 正在恢复哪些实例（按钮转圈 + 防连点）。 */
  resuming: Record<number, boolean>

  setError: (msg: string | null) => void
  upsertPause: (p: InstancePauseState) => void
  prependRecord: (r: AlertRecord) => void
  setConfigView: (v: AlertsConfigView) => void
  clearTestResult: () => void

  /** 首屏拉配置 + 暂停态 + 历史。三条互相独立，一条失败不拖累另外两条。 */
  load: () => Promise<void>
  /** 保存部分配置。成功返回 null，失败返回中文原因。 */
  saveConfig: (patch: AlertsConfigPatch) => Promise<string | null>
  /** 测试推送。返回结果对象；通道本身不通时返回 null 并把原因写进 error。 */
  testPush: () => Promise<NotifyResult | null>
  /** 恢复一个被暂停的实例。成功返回 null，失败返回中文原因。 */
  resume: (instanceIndex: number) => Promise<string | null>
}

export const useAlertStore = create<AlertStoreState>()((set, get) => ({
  configView: placeholderConfigView(),
  pauses: {},
  history: [],
  loaded: false,
  configFromMain: false,
  error: null,
  saving: false,
  testing: false,
  testResult: null,
  resuming: {},

  setError: (msg) => set({ error: msg }),

  upsertPause: (p) => set((st) => ({ pauses: { ...st.pauses, [p.instanceIndex]: p } })),

  prependRecord: (r) =>
    set((st) => ({ history: [r, ...st.history].slice(0, ALERT_HISTORY_LIMIT) })),

  setConfigView: (v) => set({ configView: v, configFromMain: true }),

  clearTestResult: () => set({ testResult: null }),

  load: async () => {
    try {
      const view = await callAlerts('alerts:config')
      set({ configView: view, configFromMain: true, error: null })
    } catch (e) {
      set({ error: describeAlertError(e) })
    }

    try {
      const list = await callAlerts('alerts:pauses')
      const next: Record<number, InstancePauseState> = {}
      for (const p of list) next[p.instanceIndex] = p
      set({ pauses: next })
    } catch {
      // 配置那一条已经把原因说清楚了，不再覆盖一遍 error。
    }

    try {
      const rows = await callAlerts('alerts:history', ALERT_HISTORY_LIMIT)
      set({ history: rows })
    } catch {
      // 同上：历史拉不到不影响其余功能。
    }

    set({ loaded: true })
  },

  saveConfig: async (patch) => {
    set({ saving: true })
    try {
      const view = await callAlerts('alerts:saveConfig', patch)
      set({ configView: view, configFromMain: true, error: null })
      return null
    } catch (e) {
      const msg = describeAlertError(e)
      set({ error: msg })
      return msg
    } finally {
      set({ saving: false })
    }
  },

  testPush: async () => {
    if (get().testing) return null
    set({ testing: true, testResult: null })
    try {
      const r = await callAlerts('alerts:test')
      set({ testResult: r, error: null })
      return r
    } catch (e) {
      const msg = describeAlertError(e)
      set({ error: msg })
      return null
    } finally {
      set({ testing: false })
    }
  },

  resume: async (instanceIndex) => {
    if (get().resuming[instanceIndex]) return '这个实例正在恢复，等它完成再点。'
    set((st) => ({ resuming: { ...st.resuming, [instanceIndex]: true } }))
    try {
      const p = await callAlerts('alerts:resume', instanceIndex)
      get().upsertPause(p)
      return null
    } catch (e) {
      return describeAlertError(e)
    } finally {
      set((st) => {
        const next = { ...st.resuming }
        delete next[instanceIndex]
        return { resuming: next }
      })
    }
  }
}))

/**
 * 订阅告警推送。返回退订函数，直接 `useEffect(() => subscribeAlerts(), [])` 即可。
 * 通道尚未注册时 `onAlertEvent` 可能抛（window.api 不在），这里兜住并记下中文原因。
 */
export function subscribeAlerts(): () => void {
  const offs: Array<() => void> = []
  try {
    offs.push(
      onAlertEvent('alerts:pauseChanged', (p) => {
        useAlertStore.getState().upsertPause(p)
      })
    )
    offs.push(
      onAlertEvent('alerts:raised', (r) => {
        useAlertStore.getState().prependRecord(r)
      })
    )
    offs.push(
      onAlertEvent('alerts:configChanged', (v) => {
        useAlertStore.getState().setConfigView(v)
      })
    )
  } catch (e) {
    useAlertStore.getState().setError(describeAlertError(e))
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

/**
 * 取某个实例的暂停态；没有记录时给一条「未暂停」的占位，界面才好统一渲染。
 * ★ 判据是 `paused === true`，**不是 `!auto`** —— 用户自己手动关掉自动调度也会让 auto 为 false，
 *   那是正常操作，不该标红。
 */
export function pauseOf(
  pauses: Record<number, InstancePauseState>,
  instanceIndex: number
): InstancePauseState {
  return pauses[instanceIndex] ?? emptyPauseState(instanceIndex)
}

/** 当前被异常暂停的实例编号（升序）。 */
export function pausedIndexes(pauses: Record<number, InstancePauseState>): number[] {
  return Object.values(pauses)
    .filter((p) => p.paused)
    .map((p) => p.instanceIndex)
    .sort((a, b) => a - b)
}
