/**
 * 「实例列表」里的一键采集控制：把调度器（scheduler:*）与告警（alerts:*）两个仓库的订阅、
 * 开关忙态与批量操作收拢成一个 hook，InstancesView 只管渲染。
 *
 * 语义与「采集总览」页的卡片**完全一致**（别再发明第三套）：
 *   · 开/关采集 = scheduler:setAuto —— 打开的瞬间先读一次「部队管理」面板（十几张截图，几秒钟），
 *     之后在队列释放时自动唤醒去派下一轮；关掉只保留倒计时展示，不再主动操作模拟器。
 *   · 采样 = scheduler:sample —— 真的去开一次面板读当前队列状态，不派兵。
 *   · 被异常暂停（pause.paused）的实例只能走 alerts:resume 恢复：那条路会同时清掉暂停记录
 *     与推送冷却，直接扳开关不会。
 *
 * 批量操作并发执行：调度器本来就是按实例各持一把锁，多个实例同时采样与用户在总览页
 * 连着扳几个开关是同一回事。每个实例的成败分别记录，一个失败不影响别的。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { InstancePauseState } from '@shared/alerts'
import type { InstanceQueueState } from '@shared/scheduler'
import { pauseOf, subscribeAlerts, useAlertStore } from '@/features/alerts'
import { emptyQueueState, subscribeScheduler, useMarchStore } from './marchStore'

/** 一次批量操作的结果：成功的实例编号 + 失败的实例编号与中文原因。 */
export interface BatchOutcome {
  ok: number[]
  failed: Array<{ index: number; reason: string }>
}

export interface InstanceGatherApi {
  /** 调度状态是否已经拉过一次（不管成功失败）。 */
  loaded: boolean
  /** 调度通道拉取/订阅失败的中文原因；正常为 null。 */
  error: string | null
  /** 正在采样的实例（按钮转圈 + 防连点）。 */
  samplingMap: Record<number, boolean>
  /** 正在切换开关的实例。 */
  autoBusy: Record<number, boolean>
  /** 正在恢复的实例。 */
  resumingMap: Record<number, boolean>
  /** 取某实例的队列状态；没有调度记录时给占位，界面才好统一渲染。 */
  stateOf: (index: number, accountId: string | null) => InstanceQueueState
  /** 取某实例的暂停态；没有记录时给「未暂停」占位。 */
  pauseFor: (index: number) => InstancePauseState
  /** 开/关一个实例的自动采集。失败返回中文原因，成功返回 null。 */
  toggleAuto: (index: number, enabled: boolean) => Promise<string | null>
  /** 立即采样一个实例。失败返回中文原因，成功返回 null。 */
  sample: (index: number) => Promise<string | null>
  /** 恢复一个被异常暂停的实例。失败返回中文原因，成功返回 null。 */
  resume: (index: number) => Promise<string | null>
  /** 批量开/关自动采集（并发）。 */
  setAutoMany: (indexes: readonly number[], enabled: boolean) => Promise<BatchOutcome>
  /** 批量采样（并发）。 */
  sampleMany: (indexes: readonly number[]) => Promise<BatchOutcome>
}

export function useInstanceGather(): InstanceGatherApi {
  const byInstance = useMarchStore((s) => s.byInstance)
  const samplingMap = useMarchStore((s) => s.sampling)
  const error = useMarchStore((s) => s.error)
  const loaded = useMarchStore((s) => s.loaded)
  const load = useMarchStore((s) => s.load)
  const sampleOne = useMarchStore((s) => s.sampleOne)
  const setAuto = useMarchStore((s) => s.setAuto)

  const pauses = useAlertStore((s) => s.pauses)
  const resumingMap = useAlertStore((s) => s.resuming)
  const loadAlerts = useAlertStore((s) => s.load)
  const resumeOne = useAlertStore((s) => s.resume)

  const [autoBusy, setAutoBusy] = useState<Record<number, boolean>>({})
  // 回调里判「是否正忙」用 ref，避免闭包拿到旧的 autoBusy 放行了连点。
  const autoBusyRef = useRef(autoBusy)
  autoBusyRef.current = autoBusy

  useEffect(() => {
    void load()
    return subscribeScheduler()
  }, [load])

  useEffect(() => {
    void loadAlerts()
    return subscribeAlerts()
  }, [loadAlerts])

  const stateOf = useCallback(
    (index: number, accountId: string | null): InstanceQueueState =>
      byInstance[index] ?? emptyQueueState(index, accountId),
    [byInstance]
  )

  const pauseFor = useCallback((index: number) => pauseOf(pauses, index), [pauses])

  const toggleAuto = useCallback(
    async (index: number, enabled: boolean): Promise<string | null> => {
      if (autoBusyRef.current[index]) return '这个实例的开关正在切换，等它完成再点。'
      setAutoBusy((b) => ({ ...b, [index]: true }))
      try {
        return await setAuto(index, enabled)
      } finally {
        setAutoBusy((b) => {
          const next = { ...b }
          delete next[index]
          return next
        })
      }
    },
    [setAuto]
  )

  const sample = useCallback((index: number) => sampleOne(index), [sampleOne])
  const resume = useCallback((index: number) => resumeOne(index), [resumeOne])

  const setAutoMany = useCallback(
    async (indexes: readonly number[], enabled: boolean): Promise<BatchOutcome> => {
      const results = await Promise.all(
        indexes.map(async (index) => ({ index, reason: await toggleAuto(index, enabled) }))
      )
      return collect(results)
    },
    [toggleAuto]
  )

  const sampleMany = useCallback(
    async (indexes: readonly number[]): Promise<BatchOutcome> => {
      const results = await Promise.all(
        indexes.map(async (index) => ({ index, reason: await sampleOne(index) }))
      )
      return collect(results)
    },
    [sampleOne]
  )

  return {
    loaded,
    error,
    samplingMap,
    autoBusy,
    resumingMap,
    stateOf,
    pauseFor,
    toggleAuto,
    sample,
    resume,
    setAutoMany,
    sampleMany
  }
}

function collect(results: ReadonlyArray<{ index: number; reason: string | null }>): BatchOutcome {
  const out: BatchOutcome = { ok: [], failed: [] }
  for (const r of results) {
    if (r.reason === null) out.ok.push(r.index)
    else out.failed.push({ index: r.index, reason: r.reason })
  }
  return out
}

/** 把批量结果拼成一句可直接弹出的中文。 */
export function describeBatchOutcome(verb: string, out: BatchOutcome): string {
  const parts: string[] = []
  if (out.ok.length > 0) parts.push(`已${verb} ${out.ok.length} 个实例（#${out.ok.join('、#')}）`)
  if (out.failed.length > 0) {
    parts.push(
      `${out.failed.length} 个失败：` + out.failed.map((f) => `#${f.index} ${f.reason}`).join('；')
    )
  }
  return parts.join('。') + '。'
}
