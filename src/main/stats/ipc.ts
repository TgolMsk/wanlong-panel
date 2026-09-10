/**
 * 统计模块自己的一小组 IPC 通道（stats:*）。
 *
 * ★ 为什么不用 @main/ipc 的 handle/emit：那两个函数的通道名被 IpcRoutes / IpcEvents 约束，
 *   而这两张表在 src/shared/ipc.ts 里**已经冻结**。所以这里照抄 src/main/alerts/ipc.ts 的等价包装，
 *   只服务 stats:*。错误编码方式与 @main/ipc 完全一致，渲染进程的 normalizeError() 能原样解出 code。
 *
 * ★ 本文件**只提供包装，不注册任何 handler**；注册在 StatsCenter.registerHandlers()。
 *   registered 集合有重复注册检查，重复会在启动时立刻抛出来，不会静默覆盖。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { serializeError } from '@shared/errors'
import type { SerializedError } from '@shared/errors'
import type {
  StatsArgs,
  StatsChannel,
  StatsPushChannel,
  StatsPushEvents,
  StatsResult
} from '@shared/stats'

const registered = new Set<string>()

/** 与 @main/ipc 的 encodeForBridge 同一份实现：detail 不可序列化时降级，但保住 code 与中文消息。 */
function encodeForBridge(payload: SerializedError): string {
  try {
    return JSON.stringify(payload)
  } catch {
    return JSON.stringify({
      __wlError: true,
      code: payload.code,
      message: payload.message,
      detail: { note: 'detail 含不可 JSON 序列化的值，已丢弃' }
    } satisfies SerializedError)
  }
}

export function handleStats<K extends StatsChannel>(
  channel: K,
  fn: (...args: StatsArgs<K>) => Promise<StatsResult<K>> | StatsResult<K>
): void {
  if (registered.has(channel)) throw new Error(`IPC 通道重复注册: ${channel}`)
  registered.add(channel)
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...(args as StatsArgs<K>))
    } catch (e) {
      // ★ 必须是 throw new Error(JSON.stringify(...))，原因见 src/main/ipc.ts 的实测注释。
      throw new Error(encodeForBridge(serializeError(e)))
    }
  })
}

export function emitStats<K extends StatsPushChannel>(channel: K, payload: StatsPushEvents[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** 退出/重启时清掉全部 stats:* handler。与 resetAlertsIpc / resetSchedulerIpc 互不影响。 */
export function resetStatsIpc(): void {
  for (const ch of registered) ipcMain.removeHandler(ch)
  registered.clear()
}

/** 排障用：当前已注册了哪几条 stats:* 通道。 */
export function registeredStatsChannels(): string[] {
  return [...registered]
}
