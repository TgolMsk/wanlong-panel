/**
 * adb 调用的并发调度：**每设备一条串行车道 + 一个全局上限**。
 *
 * 为什么同设备必须串行（实测）：
 *   模拟器的 screencap 总吞吐恒定在 ≈4.3 帧/秒，同一台设备并发发两个 screencap
 *   不会更快，只会让两个请求都变慢、还可能互相抢 adb transport。
 *   输入事件同理，乱序发 tap 会点错地方。所以每台设备 concurrency = 1。
 *
 * 全局上限（GLOBAL_ADB_CONCURRENCY）挡的是另一件事：4 个实例同时截图时，
 * 4 份 14MB 的 Buffer 加上 4 个 adb 进程会把内存和 CPU 顶起来。
 *
 * ★ 重入保护：
 *   像 getDeviceInfo 这种「组合动作」内部会再调 captureRaw / foregroundPackage，
 *   而它们各自也 enqueue。如果不做处理，外层任务占着 concurrency=1 的位子等内层，
 *   内层永远排不进来 —— 自锁。这里用 AsyncLocalStorage 记住「当前正在哪条车道上跑」，
 *   同车道的嵌套调用直接内联执行。所以**任何层级都可以放心 enqueue**。
 *
 * 纯 Node，不 import electron。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import PQueue from 'p-queue'
import { GLOBAL_ADB_CONCURRENCY } from '@shared/constants'
import { AppError } from '@shared/errors'

interface Lane {
  queue: PQueue
  /** dropDevice 时 abort，让还在排队的任务立刻以 CANCELLED 失败，而不是永远挂着。 */
  abort: AbortController
}

const lanes = new Map<string, Lane>()
const globalQueue = new PQueue({ concurrency: GLOBAL_ADB_CONCURRENCY })

/** 当前 async 上下文正占用着哪条车道（serial）。 */
const laneContext = new AsyncLocalStorage<string>()

function laneOf(serial: string): Lane {
  let lane = lanes.get(serial)
  if (!lane) {
    lane = { queue: new PQueue({ concurrency: 1 }), abort: new AbortController() }
    lanes.set(serial, lane)
  }
  return lane
}

/**
 * 把一次设备操作排进该设备的串行队列。
 * 同设备的嵌套调用（同一条 async 链上）会直接内联执行，不会自锁。
 */
export async function enqueue<T>(serial: string, fn: () => Promise<T>): Promise<T> {
  if (!serial || !serial.trim()) {
    throw new AppError('INVALID_ARGUMENT', 'enqueue 需要一个非空的设备 serial。')
  }

  // 重入：已经在这条车道上跑了，直接执行。
  if (laneContext.getStore() === serial) {
    return fn()
  }

  const lane = laneOf(serial)
  const signal = lane.abort.signal

  try {
    return await lane.queue.add(
      () => globalQueue.add(() => laneContext.run(serial, fn), { signal, throwOnTimeout: true }),
      { signal, throwOnTimeout: true }
    )
  } catch (e) {
    if (signal.aborted) {
      throw new AppError(
        'CANCELLED',
        `设备 ${serial} 的操作队列已被清空（通常是断开连接或停止执行导致）。`,
        { serial }
      )
    }
    throw e
  }
}

/** 调整全局 adb 并发上限（设置页改 maxConcurrentInstances 时联动）。 */
export function setGlobalConcurrency(n: number): void {
  if (!Number.isFinite(n) || n < 1) {
    throw new AppError('INVALID_ARGUMENT', `全局 adb 并发数必须 ≥ 1，收到 ${n}。`)
  }
  globalQueue.concurrency = Math.floor(n)
}

/**
 * 丢弃某台设备的车道：取消所有还没开始的任务，删除队列。
 * 已经在跑的那一个不会被打断（adb 子进程该跑完还是跑完），但它之后不会再有新任务。
 */
export function dropDevice(serial: string): void {
  const lane = lanes.get(serial)
  if (!lane) return
  lane.abort.abort()
  lane.queue.clear()
  lanes.delete(serial)
}

/** 面板退出时清空所有车道。 */
export function dropAllDevices(): void {
  for (const serial of [...lanes.keys()]) dropDevice(serial)
}

/** 队列水位，面板的性能/排障面板可以显示。 */
export function queueStats(): {
  globalConcurrency: number
  globalPending: number
  globalRunning: number
  lanes: { serial: string; pending: number; running: number }[]
} {
  return {
    globalConcurrency: globalQueue.concurrency,
    globalPending: globalQueue.size,
    globalRunning: globalQueue.pending,
    lanes: [...lanes.entries()].map(([serial, lane]) => ({
      serial,
      pending: lane.queue.size,
      running: lane.queue.pending
    }))
  }
}
