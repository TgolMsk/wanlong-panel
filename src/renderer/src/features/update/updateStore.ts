/**
 * 更新状态在渲染进程侧的唯一仓库。
 *
 * 为什么要有它：更新现在有**两个**落点 —— 侧栏左下角的版本号（SidebarUpdate）与
 * 设置页的「版本与更新」卡（UpdateCard）。两处各自 useState + 各自订阅的话，
 * 会出现「卡片里在下载、侧栏还显示已是最新」这种自相矛盾的画面；
 * phase → 色调、phase → 中文说法也必然随时间漂移（本工程有「三镜像默认值打架」的教训）。
 * 所以状态、色调映射、动作封装全部收在这里，界面文件只负责摆。
 *
 * 数据来源：`@shared/update` 的 update:* 通道。首屏 `update:state` 拉一次，
 * 之后 `update:changed` 推送（下载进度也是推的，**绝不轮询**）。
 */

import { useEffect } from 'react'
import { create } from 'zustand'
import { callUpdate, onUpdateEvent, type UpdatePhase, type UpdateState } from '@shared/update'
import { normalizeError, toast } from '../../ipc/useIpc'

/** phase → 语义色调。SemanticTag / 徽标点 / Alert 类型都从这里取，只有一份。 */
export const UPDATE_TONE: Record<
  UpdatePhase,
  'success' | 'warning' | 'danger' | 'info' | 'neutral'
> = {
  idle: 'neutral',
  checking: 'info',
  latest: 'success',
  available: 'warning',
  downloading: 'info',
  downloaded: 'success',
  error: 'danger',
  unsupported: 'neutral'
}

/**
 * 侧栏那个小红点要不要亮。
 *
 * ★ 只有「真的有新版本」才亮：available（可下载）/ downloading（下载中）/ downloaded（等重启装）。
 *   检查失败（error）**不亮** —— 挂机机器常年断网或 GitHub 限流，那会让红点天天挂着，
 *   角标就彻底失去「有事」的含义了。检查失败的说明在弹层和设置页卡片里照实写。
 */
export function hasPendingUpdate(state: UpdateState | null): boolean {
  if (!state) return false
  return (
    state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded'
  )
}

interface UpdateStoreState {
  /** 主进程给的最新快照；还没拉到时是 null。 */
  state: UpdateState | null
  /** 正在执行某个动作（检查 / 下载 / 安装），用于按钮转圈与防连点。 */
  busy: boolean

  setState: (s: UpdateState) => void
  /** 首屏拉一次。失败只弹一次 toast，不抛 —— 读不到版本号不该让整个侧栏白掉。 */
  load: () => Promise<void>
  /** 包一层：转圈 + 中文错误提示。真正的拦截在主进程（有任务在跑时它会拒绝安装）。 */
  run: (fn: () => Promise<unknown>) => Promise<void>
}

export const useUpdateStore = create<UpdateStoreState>((set, get) => ({
  state: null,
  busy: false,

  setState: (s) => set({ state: s }),

  load: async () => {
    try {
      set({ state: await callUpdate('update:state') })
    } catch (e) {
      toast().error(normalizeError(e).message)
    }
  },

  run: async (fn) => {
    if (get().busy) return
    set({ busy: true })
    try {
      await fn()
    } catch (e) {
      toast().error(normalizeError(e).message)
    } finally {
      set({ busy: false })
    }
  }
}))

// ── 订阅的引用计数 ──────────────────────────────────────────────────────────
// 侧栏常驻、设置页来来去去，两边都调 useUpdateFeed()。
// 计数保证：第一个挂载的人拉全量 + 订阅，最后一个卸载的人才退订，
// 中间不会重复订阅（重复订阅会让同一次进度推送被处理多遍）。
let feedRefs = 0
let feedOff: (() => void) | null = null

/** 把本仓库接到主进程推送上。两个落点都能安全地调，重复调用不会重复订阅。 */
export function useUpdateFeed(): void {
  useEffect(() => {
    feedRefs += 1
    if (feedRefs === 1) {
      void useUpdateStore.getState().load()
      try {
        feedOff = onUpdateEvent('update:changed', (s) => useUpdateStore.getState().setState(s))
      } catch {
        // 通道没接线时订阅会抛。状态停在 load() 拿到的那一份，界面照常渲染。
        feedOff = null
      }
    }
    return () => {
      feedRefs -= 1
      if (feedRefs === 0 && feedOff) {
        try {
          feedOff()
        } catch {
          /* 退订失败无所谓，页面已经卸载了 */
        }
        feedOff = null
      }
    }
  }, [])
}
