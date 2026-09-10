/**
 * 日志 ring buffer。
 *
 * ★ 为什么不用 zustand / useState 存日志：
 *   一次执行几分钟就能刷出几万行，全量塞进 React state 会让每来一批日志就重建一次大数组、
 *   触发一次全树 diff，面板必卡。这里用「模块级环形缓冲 + useSyncExternalStore + 节流通知」：
 *   - 只保留最近 LOG_RING_CAPACITY(2000) 行，超出丢最旧的；
 *   - 快照是一个自增的 version 数字（引用稳定），组件靠 useMemo 按 version 重新筛；
 *   - 通知按 NOTIFY_INTERVAL_MS 合并，worker 每 100ms 推一批，这里再压一层。
 */

import { useMemo, useSyncExternalStore } from 'react'
import { LOG_RING_CAPACITY } from '@shared/constants'
import type { LogEntry, LogLevel } from '@shared/script'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** 通知合并窗口。比 worker 的 LOG_FLUSH_INTERVAL_MS(100) 略大，避免一比一透传。 */
const NOTIFY_INTERVAL_MS = 150

// ── 缓冲区 ────────────────────────────────────────────────────────────────

let buffer: LogEntry[] = []
let version = 0
/** 自面板启动以来收到的总行数（含已被挤出缓冲的），用于提示「已丢弃 N 行」。 */
let received = 0

const listeners = new Set<() => void>()
let notifyTimer: ReturnType<typeof setTimeout> | null = null

function scheduleNotify(): void {
  if (notifyTimer !== null) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    version += 1
    for (const l of Array.from(listeners)) l()
  }, NOTIFY_INTERVAL_MS)
}

function notifyNow(): void {
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer)
    notifyTimer = null
  }
  version += 1
  for (const l of Array.from(listeners)) l()
}

function trim(): void {
  if (buffer.length > LOG_RING_CAPACITY) {
    buffer = buffer.slice(buffer.length - LOG_RING_CAPACITY)
  }
}

// ── 写入 ──────────────────────────────────────────────────────────────────

/** 实时日志入口（MessagePort 推来的批）。 */
export function pushLogs(entries: LogEntry[]): void {
  if (!entries || entries.length === 0) return
  received += entries.length
  buffer = buffer.concat(entries)
  trim()
  scheduleNotify()
}

export function pushLog(entry: LogEntry): void {
  pushLogs([entry])
}

/**
 * 合并一批历史日志（run:logs 读回来的）。
 * 与缓冲区里已有的实时日志按 (ts + runId + message) 去重，再按时间排序。
 */
export function mergeHistory(entries: LogEntry[]): number {
  if (!entries || entries.length === 0) return 0
  const seen = new Set(buffer.map((e) => `${e.ts}|${e.runId ?? ''}|${e.message}`))
  const fresh = entries.filter((e) => !seen.has(`${e.ts}|${e.runId ?? ''}|${e.message}`))
  if (fresh.length === 0) {
    notifyNow()
    return 0
  }
  buffer = buffer.concat(fresh).sort((a, b) => a.ts - b.ts)
  trim()
  notifyNow()
  return fresh.length
}

/** 清空；传 runId 则只清这一次执行的。 */
export function clearLogs(runId?: string): void {
  buffer = runId ? buffer.filter((e) => e.runId !== runId) : []
  if (!runId) received = 0
  notifyNow()
}

// ── 读取 ──────────────────────────────────────────────────────────────────

export interface LogFilter {
  /** null / undefined = 全部；'__panel__' = 只看不属于任何执行的面板日志。 */
  runId?: string | null
  minLevel?: LogLevel
  /** 对 message / scope / stepId 做不区分大小写的包含匹配。 */
  keyword?: string
  instanceIndex?: number | null
}

export const PANEL_LOG_KEY = '__panel__'

function match(e: LogEntry, f: LogFilter): boolean {
  if (f.runId === PANEL_LOG_KEY) {
    if (e.runId !== null) return false
  } else if (f.runId) {
    if (e.runId !== f.runId) return false
  }
  if (typeof f.instanceIndex === 'number' && e.instanceIndex !== f.instanceIndex) return false
  if (f.minLevel && LEVEL_ORDER[e.level] < LEVEL_ORDER[f.minLevel]) return false
  if (f.keyword) {
    const k = f.keyword.toLowerCase()
    const hay = `${e.message} ${e.scope} ${e.stepId ?? ''}`.toLowerCase()
    if (!hay.includes(k)) return false
  }
  return true
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getVersion(): number {
  return version
}

/** 订阅缓冲区变化，返回过滤后的日志数组（引用只在真正变化时改变）。 */
export function useLogs(filter: LogFilter): LogEntry[] {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion)
  const { runId, minLevel, keyword, instanceIndex } = filter
  return useMemo(
    () => buffer.filter((e) => match(e, { runId, minLevel, keyword, instanceIndex })),
    // v 变化即代表缓冲区变了，必须参与依赖。
    [v, runId, minLevel, keyword, instanceIndex]
  )
}

export interface LogCounters {
  total: number
  received: number
  dropped: number
  error: number
  warn: number
}

export function useLogCounters(): LogCounters {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion)
  return useMemo(() => {
    let error = 0
    let warn = 0
    for (const e of buffer) {
      if (e.level === 'error') error += 1
      else if (e.level === 'warn') warn += 1
    }
    return {
      total: buffer.length,
      received,
      dropped: Math.max(0, received - buffer.length),
      error,
      warn
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v])
}

/** 非 React 场景下直接取当前缓冲（例如导出）。 */
export function snapshotLogs(): LogEntry[] {
  return buffer.slice()
}
