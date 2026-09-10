/**
 * worker（utilityProcess）与渲染进程之间的 MessagePort 直连。
 *
 * ★ 全工程最容易写错的一处，先读这段再动手：
 *   MessagePort **不能穿 contextBridge** —— 过去之后会变成一个失去原型方法的克隆代理，
 *   调用 port.start() 直接报 "port.start is not a function"。
 *   所以 preload 只做转发：ipcRenderer.on(WORKER_PORT_CHANNEL) -> window.postMessage(meta, '*', e.ports)。
 *   渲染进程必须在**主世界**用 window.addEventListener('message') 去接 e.ports[0]，
 *   那个才是真的 MessagePort，并且**必须显式调用 port.start()**，否则 onmessage 永远不触发。
 *
 * 这条链路只跑高频数据：实时日志批、预览帧（Transferable ArrayBuffer）、tick 状态、匹配框。
 * 低频的请求-响应一律走 window.api.invoke。
 */

import { useEffect, useRef } from 'react'
import { WORKER_PORT_CHANNEL } from '@shared/worker'
import type { RendererToWorker, WorkerToRenderer } from '@shared/worker'
import type { LogEntry, RunSnapshot } from '@shared/script'
import type { MatchResult } from '@shared/vision'

export type WorkerFrame = Extract<WorkerToRenderer, { type: 'frame' }>

export interface WorkerPortHandlers {
  onLogs?: (runId: string, entries: LogEntry[]) => void
  onFrame?: (frame: WorkerFrame) => void
  onStatus?: (snapshot: RunSnapshot) => void
  onMatches?: (runId: string, results: MatchResult[]) => void
  /** worker 那端主动关闭（执行结束 / 崩溃）。 */
  onClosed?: (runId: string, reason: string) => void
  /** 新端口接入，UI 可借此自动切到这次执行。 */
  onOpened?: (runId: string, instanceIndex: number) => void
}

interface PortRecord {
  port: MessagePort
  instanceIndex: number
}

const ports = new Map<string, PortRecord>()
const subscribers = new Set<WorkerPortHandlers>()

function fanout(fn: (h: WorkerPortHandlers) => void): void {
  // 复制一份再遍历：回调里可能同步取消订阅。
  for (const h of Array.from(subscribers)) {
    try {
      fn(h)
    } catch (e) {
      // 一个订阅者出错不能连累其他人，也不能把异常吞得无影无踪。
      console.error('[workerPort] 订阅者回调异常', e)
    }
  }
}

function dropPort(runId: string): void {
  const rec = ports.get(runId)
  if (!rec) return
  ports.delete(runId)
  rec.port.onmessage = null
  try {
    rec.port.close()
  } catch {
    /* 已经关掉了就算了 */
  }
}

function attachPort(runId: string, instanceIndex: number, port: MessagePort): void {
  // 同一个 runId 重复接入（worker 重启）时，先把旧的收掉。
  dropPort(runId)

  port.onmessage = (ev: MessageEvent<WorkerToRenderer>): void => {
    const msg = ev.data
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'logs':
        fanout((h) => h.onLogs?.(msg.runId, msg.entries))
        break
      case 'frame':
        fanout((h) => h.onFrame?.(msg))
        break
      case 'status':
        fanout((h) => h.onStatus?.(msg.snapshot))
        break
      case 'matches':
        fanout((h) => h.onMatches?.(msg.runId, msg.results))
        break
      case 'closed':
        fanout((h) => h.onClosed?.(msg.runId, msg.reason))
        dropPort(msg.runId)
        break
      default:
        break
    }
  }
  port.start() // ★ 不调这行，后面什么都收不到
  ports.set(runId, { port, instanceIndex })
  fanout((h) => h.onOpened?.(runId, instanceIndex))
}

let installed = false

/** 安装 window message 监听。模块加载即执行，保证不会漏掉早于组件挂载到达的端口。 */
function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { __wlPort?: string; runId?: string; instanceIndex?: number } | null
    if (!data || data.__wlPort !== WORKER_PORT_CHANNEL) return
    // preload 用 window.postMessage 转发，源必然是本窗口自己。
    if (e.source !== null && e.source !== window) return
    const port = e.ports?.[0]
    if (!port || typeof data.runId !== 'string') {
      console.error('[workerPort] 收到的端口信封不完整，已忽略', data)
      return
    }
    attachPort(data.runId, typeof data.instanceIndex === 'number' ? data.instanceIndex : -1, port)
  })
}

install()

// ── 对外 API ──────────────────────────────────────────────────────────────

/** 订阅 worker 直连数据。handlers 用 ref 存，改回调不会重新订阅。 */
export function useWorkerPort(handlers: WorkerPortHandlers): void {
  const ref = useRef(handlers)
  ref.current = handlers

  useEffect(() => {
    const proxy: WorkerPortHandlers = {
      onLogs: (runId, entries) => ref.current.onLogs?.(runId, entries),
      onFrame: (frame) => ref.current.onFrame?.(frame),
      onStatus: (snapshot) => ref.current.onStatus?.(snapshot),
      onMatches: (runId, results) => ref.current.onMatches?.(runId, results),
      onClosed: (runId, reason) => ref.current.onClosed?.(runId, reason),
      onOpened: (runId, instanceIndex) => ref.current.onOpened?.(runId, instanceIndex)
    }
    subscribers.add(proxy)
    install()
    return () => {
      subscribers.delete(proxy)
    }
  }, [])
}

/** 某次执行是否已经有直连端口（没有的话预览只能走 device:capture 轮询）。 */
export function hasWorkerPort(runId: string | null | undefined): boolean {
  return !!runId && ports.has(runId)
}

export function listWorkerPorts(): { runId: string; instanceIndex: number }[] {
  return Array.from(ports.entries()).map(([runId, rec]) => ({
    runId,
    instanceIndex: rec.instanceIndex
  }))
}

/** 给某次执行的 worker 发指令（开关预览、调帧率、开关匹配框）。 */
export function postToWorker(runId: string | null | undefined, msg: RendererToWorker): boolean {
  if (!runId) return false
  const rec = ports.get(runId)
  if (!rec) return false
  try {
    rec.port.postMessage(msg)
    return true
  } catch (e) {
    console.error('[workerPort] 发送失败，端口可能已失效', e)
    dropPort(runId)
    return false
  }
}

/** 广播给所有 worker（例如窗口隐藏时统一关预览流）。 */
export function postToAllWorkers(msg: RendererToWorker): void {
  for (const runId of Array.from(ports.keys())) postToWorker(runId, msg)
}

/** 主动关闭某次执行的端口（执行已结束、面板不再需要）。 */
export function closeWorkerPort(runId: string): void {
  dropPort(runId)
}
