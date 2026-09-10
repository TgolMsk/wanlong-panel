/**
 * 告警模块自己的一小组 IPC 通道（alerts:*）。
 *
 * ★ 为什么不用 @main/ipc 的 handle/emit：那两个函数的通道名被 IpcRoutes / IpcEvents 约束，
 *   而这两张表在 src/shared/ipc.ts 里**已经冻结**（52 条请求 + 6 条推送），不属于本模块
 *   可以改动的范围。所以这里照抄了 src/main/scheduler/ipc.ts 的等价包装，只服务 alerts:*。
 *   错误编码方式与 @main/ipc 完全一致，渲染进程的 normalizeError() 能原样解出 code。
 *
 *   将来契约层解冻，把 AlertRoutes / AlertPushEvents 并进 IpcRoutes / IpcEvents，
 *   本文件就可以整体删掉，调用点一行都不用改。
 *
 * ★ 本文件**只提供包装，不注册任何 handler**。谁注册见分工：
 *     alerts:config / alerts:saveConfig / alerts:test        → NotifyHub.registerConfigHandlers()
 *     alerts:pauses / alerts:resume / alerts:history         → AlertCenter.registerHandlers()
 *   下面的 registered 集合有重复注册检查，划错归属会在启动时立刻抛出来，不会静默覆盖。
 *
 * ★★ 凭据纪律：本文件会把 serializeError(e) 的结果原样编码过桥。
 *    所以**任何抛到这里的异常，其 message / detail 里都不许含 botToken** ——
 *    telegram.ts 里的每一处 catch 都已经先过 scrubSecret()，这里是最后一道，不做二次清洗
 *    （因为这一层拿不到 token，无从洗起）。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { serializeError } from '@shared/errors'
import type { SerializedError } from '@shared/errors'
import type {
  AlertArgs,
  AlertChannel,
  AlertPushChannel,
  AlertPushEvents,
  AlertResult
} from '@shared/alerts'

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

export function handleAlerts<K extends AlertChannel>(
  channel: K,
  fn: (...args: AlertArgs<K>) => Promise<AlertResult<K>> | AlertResult<K>
): void {
  if (registered.has(channel)) throw new Error(`IPC 通道重复注册: ${channel}`)
  registered.add(channel)
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...(args as AlertArgs<K>))
    } catch (e) {
      // ★ 必须是 throw new Error(JSON.stringify(...))，别改成 throw 纯对象或 throw AppError，
      //   原因见 src/main/ipc.ts 里那段实测注释（抛纯对象 → [object Object]；
      //   抛 AppError → 只剩消息，渲染侧解不出 code）。
      throw new Error(encodeForBridge(serializeError(e)))
    }
  })
}

export function emitAlerts<K extends AlertPushChannel>(
  channel: K,
  payload: AlertPushEvents[K]
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** 退出/重启时清掉全部 alerts:* handler。与 resetSchedulerIpc 互不影响。 */
export function resetAlertsIpc(): void {
  for (const ch of registered) ipcMain.removeHandler(ch)
  registered.clear()
}

/** 排障用：当前已注册了哪几条 alerts:* 通道。 */
export function registeredAlertChannels(): string[] {
  return [...registered]
}
