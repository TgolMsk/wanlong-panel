/**
 * 全模块共用的「每秒一跳」时钟。
 *
 * 设计要点：
 *  1. **全局只有一个 setInterval**。哪怕屏幕上有 20 张卡片、100 行倒计时，
 *     也共用同一个定时器与同一个 now，不会出现各行秒数不同步的抖动。
 *  2. **窗口不可见时停表**。面板最小化 / 切到别的窗口时 document.hidden = true，
 *     此时停掉 interval；重新可见时立刻补一次 now 再启动，避免后台空转掉帧。
 *  3. 完全不碰 adb：这只是一个时钟，倒计时是 eta.ts 用绝对时刻减出来的。
 */

import { useEffect, useState } from 'react'

type Listener = (now: number) => void

const listeners = new Set<Listener>()
let timer: ReturnType<typeof setInterval> | null = null
let visibilityBound = false

function broadcast(): void {
  const now = Date.now()
  for (const fn of listeners) fn(now)
}

function startTimer(): void {
  if (timer !== null) return
  if (typeof document !== 'undefined' && document.hidden) return
  // 对齐到下一个整秒附近再起跳，倒计时数字看起来更稳。
  timer = setInterval(broadcast, 1000)
}

function stopTimer(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

function onVisibilityChange(): void {
  if (document.hidden) {
    stopTimer()
    return
  }
  // 回到前台先立刻补一次，别让用户看到一秒钟的旧数字。
  broadcast()
  if (listeners.size > 0) startTimer()
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === 'undefined') return
  document.addEventListener('visibilitychange', onVisibilityChange)
  visibilityBound = true
}

/**
 * 返回当前时刻（毫秒），每秒更新一次。
 * @param enabled 传 false 可以让某个页面暂时不订阅（例如面板切走了）。
 */
export function useCountdownTick(enabled = true): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled) return
    bindVisibility()
    const fn: Listener = (t) => setNow(t)
    listeners.add(fn)
    startTimer()
    // 挂载瞬间先给一个最新值，避免首帧显示的是 useState 初值。
    setNow(Date.now())
    return () => {
      listeners.delete(fn)
      if (listeners.size === 0) stopTimer()
    }
  }, [enabled])

  return now
}
