/**
 * 「每日数据统计」在渲染进程侧的仓库。
 *
 * 数据来源是 `@shared/stats` 的统计通道（与 alerts:* / scheduler:* 同一条 Electron 桥，
 * 自带一小组 stats:* 通道，没有登记进已冻结的 IpcRoutes）：
 *   · 首屏 `stats:daily`（今天 + 选中的那天）与 `stats:range`（近 RECENT_DAYS 天）各拉一次
 *   · 之后 `stats:today` 推送（主进程 ≥1s 节流；跨北京 0 点时推的是新一天的空桶，这里据此换日）
 *   · 「读一次资源统计」按钮走 `stats:snapshotNow`（会抢实例锁，脚本在跑时主进程会拒绝）
 *
 * ★ 日期只在 DateKey（北京日期 `YYYY-MM-DD`）上运算：cstDateKey / shiftDateKey 来自 @shared/stats，
 *   **绝不**用 dayjs / Date.getDate() 按本机时区算 —— 宿主机是洛杉矶时区，游戏按北京时间跑。
 * ★ 主进程还没接线时 `callStats` 会 reject。那不是崩溃，是「功能还没接上」，
 *   所以这里把它翻译成一句中文放进 `error`，界面照常渲染空桶。**绝不静默吞异常**。
 *   写法与 features/gather/marchStore.ts 完全一致。
 */

import { create } from 'zustand'
import {
  callStats,
  cstDateKey,
  describeStatsError,
  emptyDailyStats,
  onStatsEvent,
  shiftDateKey,
  type DailyStats,
  type DateKey
} from '@shared/stats'

/** 页面底部「近 N 天」表格覆盖的天数（含今天）。 */
export const RECENT_DAYS = 14

/** 今天的北京日期键。 */
export function todayKey(): DateKey {
  return cstDateKey(Date.now())
}

interface StatsStoreState {
  /** 今天（北京）的日桶；还没拉到为 null。 */
  today: DailyStats | null
  /** 页面当前选中的日期。默认今天。 */
  selectedKey: DateKey
  /** 选中那天的日桶；还没拉到为 null。 */
  selected: DailyStats | null
  /** 近 RECENT_DAYS 天（升序，最后一项是今天）。 */
  recent: DailyStats[]
  /** 首屏是否已经拉过一次（不管成功失败）。 */
  loaded: boolean
  /** 正在拉取（首屏或换日）。 */
  loading: boolean
  /** 拉取/订阅失败的中文原因；正常为 null。 */
  error: string | null
  /** 正在为哪些实例读资源统计（按钮转圈 + 防连点）。 */
  snapshotting: Record<number, boolean>

  setError: (msg: string | null) => void
  /** 主进程推来今天的日桶（含跨 0 点换日）。 */
  applyToday: (s: DailyStats) => void

  /** 首屏拉今天 + 选中日 + 近 N 天。失败只记 error，不抛。 */
  load: () => Promise<void>
  /** 换一天看。失败只记 error。 */
  selectDay: (key: DateKey) => Promise<void>
  /** 立刻对某实例读一次资源统计。成功返回 null，失败返回中文原因。 */
  snapshotNow: (instanceIndex: number) => Promise<string | null>
}

export const useStatsStore = create<StatsStoreState>()((set, get) => ({
  today: null,
  selectedKey: todayKey(),
  selected: null,
  recent: [],
  loaded: false,
  loading: false,
  error: null,
  snapshotting: {},

  setError: (msg) => set({ error: msg }),

  applyToday: (s) => {
    const st = get()
    const prevTodayKey = st.today?.dateKey ?? null
    const crossed = prevTodayKey !== null && prevTodayKey !== s.dateKey
    const patch: Partial<StatsStoreState> = { today: s }

    // 选中的正是今天 ⇒ 同步刷新选中桶；跨 0 点且之前停在「今天」⇒ 自动跟到新的一天。
    if (st.selectedKey === s.dateKey) {
      patch.selected = s
    } else if (crossed && st.selectedKey === prevTodayKey) {
      patch.selectedKey = s.dateKey
      patch.selected = s
    }

    // 近 N 天表里同一天的那一行也更新；新的一天则追加并裁掉最旧的一天。
    const idx = st.recent.findIndex((d) => d.dateKey === s.dateKey)
    if (idx >= 0) {
      const next = st.recent.slice()
      next[idx] = s
      patch.recent = next
    } else if (crossed) {
      patch.recent = [...st.recent, s].slice(-RECENT_DAYS)
    }
    set(patch)
  },

  load: async () => {
    set({ loading: true })
    const tk = todayKey()
    const sk = get().selectedKey
    try {
      const today = await callStats('stats:daily')
      const patch: Partial<StatsStoreState> = { today, error: null }
      if (sk === today.dateKey) patch.selected = today
      set(patch)
    } catch (e) {
      set({ error: describeStatsError(e), today: emptyDailyStats(tk) })
    }

    if (sk !== tk) {
      try {
        const selected = await callStats('stats:daily', sk)
        set({ selected })
      } catch (e) {
        // 今天那一条已经把「没接线」说清楚了；这里只在今天成功、选中日失败时才覆盖 error。
        if (get().error === null) set({ error: describeStatsError(e) })
        set({ selected: emptyDailyStats(sk) })
      }
    } else if (get().selected === null) {
      set({ selected: get().today })
    }

    try {
      const recent = await callStats('stats:range', shiftDateKey(tk, -(RECENT_DAYS - 1)), tk)
      set({ recent })
    } catch {
      // 同上：近 N 天拉不到不影响其余功能，error 已由上面记录。
    }

    set({ loaded: true, loading: false })
  },

  selectDay: async (key) => {
    const st = get()
    set({ selectedKey: key })
    // 今天与近 N 天里已经有的桶直接复用，不再往主进程跑一趟。
    if (st.today && st.today.dateKey === key) {
      set({ selected: st.today })
      return
    }
    const cached = st.recent.find((d) => d.dateKey === key)
    if (cached) {
      set({ selected: cached })
      return
    }
    set({ loading: true, selected: null })
    try {
      const selected = await callStats('stats:daily', key)
      // 用户在等待期间又换了一天，这份结果就过期了，别覆盖。
      if (get().selectedKey === key) set({ selected, error: null })
    } catch (e) {
      if (get().selectedKey === key) set({ selected: emptyDailyStats(key), error: describeStatsError(e) })
    } finally {
      set({ loading: false })
    }
  },

  snapshotNow: async (instanceIndex) => {
    if (get().snapshotting[instanceIndex]) return '这个实例正在读资源统计，等它完成再点。'
    set((st) => ({ snapshotting: { ...st.snapshotting, [instanceIndex]: true } }))
    try {
      await callStats('stats:snapshotNow', instanceIndex)
      // 快照已由主进程写进今天的日桶并经 stats:today 推回来；这里不用手动塞。
      return null
    } catch (e) {
      return describeStatsError(e)
    } finally {
      set((st) => {
        const next = { ...st.snapshotting }
        delete next[instanceIndex]
        return { snapshotting: next }
      })
    }
  }
}))

/**
 * 订阅统计推送。返回退订函数，直接 `useEffect(() => subscribeStats(), [])` 即可。
 * 通道尚未注册时 `onStatsEvent` 可能抛（window.api 不在），这里兜住并记下中文原因。
 */
export function subscribeStats(): () => void {
  const offs: Array<() => void> = []
  try {
    offs.push(
      onStatsEvent('stats:today', (s) => {
        useStatsStore.getState().applyToday(s)
      })
    )
  } catch (e) {
    useStatsStore.getState().setError(describeStatsError(e))
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
