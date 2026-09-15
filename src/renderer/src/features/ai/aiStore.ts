/**
 * AI 顾问在渲染进程侧的仓库。写法与 features/alerts/alertStore.ts 完全一致：
 *   · 首屏 ai:config / ai:status / ai:history 各拉一次
 *   · 之后 ai:configChanged / ai:consulted 增量推送
 *   · 「测试连接与视觉能力」走 ai:test
 *
 * ★ 凭据纪律：本仓库里永远不会出现 apiKey。主进程给的是 AiConfigView（类型上没有 apiKey 这个键）。
 *   用户新填的 Key 只在表单组件里存在一瞬间，随 saveConfig 的补丁送走后即丢弃。
 */

import { create } from 'zustand'
import {
  AI_HISTORY_LIMIT,
  callAi,
  defaultAiConfig,
  describeAiError,
  onAiEvent,
  toAiConfigView,
  type AiConfigPatch,
  type AiConfigView,
  type AiConsultRecord,
  type AiStatus,
  type AiTestResult
} from '@shared/ai'

interface AiStoreState {
  configView: AiConfigView
  status: AiStatus | null
  history: AiConsultRecord[]
  loaded: boolean
  configFromMain: boolean
  error: string | null
  saving: boolean
  testing: boolean
  testResult: AiTestResult | null

  load: () => Promise<void>
  saveConfig: (patch: AiConfigPatch) => Promise<string | null>
  test: () => Promise<AiTestResult | null>
  clearTestResult: () => void
  setConfigView: (v: AiConfigView) => void
  prependRecord: (r: AiConsultRecord) => void
}

export const useAiStore = create<AiStoreState>()((set, get) => ({
  configView: toAiConfigView(defaultAiConfig()),
  status: null,
  history: [],
  loaded: false,
  configFromMain: false,
  error: null,
  saving: false,
  testing: false,
  testResult: null,

  setConfigView: (v) => set({ configView: v, configFromMain: true }),

  prependRecord: (r) => set((st) => ({ history: [r, ...st.history].slice(0, AI_HISTORY_LIMIT) })),

  clearTestResult: () => set({ testResult: null }),

  load: async () => {
    try {
      const view = await callAi('ai:config')
      set({ configView: view, configFromMain: true, error: null })
    } catch (e) {
      set({ error: describeAiError(e) })
    }
    try {
      set({ status: await callAi('ai:status') })
    } catch {
      /* 配置那一条已经把原因说清楚了 */
    }
    try {
      set({ history: await callAi('ai:history', AI_HISTORY_LIMIT) })
    } catch {
      /* 同上 */
    }
    set({ loaded: true })
  },

  saveConfig: async (patch) => {
    set({ saving: true })
    try {
      const view = await callAi('ai:saveConfig', patch)
      set({ configView: view, configFromMain: true, error: null })
      try {
        set({ status: await callAi('ai:status') })
      } catch {
        /* 状态刷新失败不影响保存结果 */
      }
      return null
    } catch (e) {
      const msg = describeAiError(e)
      set({ error: msg })
      return msg
    } finally {
      set({ saving: false })
    }
  },

  test: async () => {
    if (get().testing) return null
    set({ testing: true, testResult: null })
    try {
      const r = await callAi('ai:test')
      set({ testResult: r, error: null })
      return r
    } catch (e) {
      set({ error: describeAiError(e) })
      return null
    } finally {
      set({ testing: false })
    }
  }
}))

/** 订阅推送。返回退订函数，直接 `useEffect(() => subscribeAi(), [])`。 */
export function subscribeAi(): () => void {
  const offs: Array<() => void> = []
  try {
    offs.push(onAiEvent('ai:configChanged', (v) => useAiStore.getState().setConfigView(v)))
    offs.push(
      onAiEvent('ai:consulted', (r) => {
        useAiStore.getState().prependRecord(r)
        void callAi('ai:status')
          .then((s) => useAiStore.setState({ status: s }))
          .catch(() => undefined)
      })
    )
  } catch (e) {
    useAiStore.setState({ error: describeAiError(e) })
  }
  return () => {
    for (const off of offs) {
      try {
        off()
      } catch {
        /* 页面已卸载 */
      }
    }
  }
}
