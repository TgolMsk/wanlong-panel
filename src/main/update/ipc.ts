/**
 * 更新模块自己的一小组 IPC 通道。
 *
 * 做法与 src/main/scheduler/ipc.ts、src/main/plan/ipc.ts 完全一致（新模块自带通道组，
 * 不去改 shared/ipc.ts 那两张大表），错误编码方式也一致，渲染进程的 normalizeError() 能原样解出 code。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { serializeError } from '@shared/errors'
import type { SerializedError } from '@shared/errors'
import type {
  UpdateArgs,
  UpdateChannel,
  UpdateEventChannel,
  UpdateEvents,
  UpdateResult
} from '@shared/update'

const registered = new Set<string>()

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

export function handleUpdate<K extends UpdateChannel>(
  channel: K,
  fn: (...args: UpdateArgs<K>) => Promise<UpdateResult<K>> | UpdateResult<K>
): void {
  if (registered.has(channel)) throw new Error(`IPC 通道重复注册: ${channel}`)
  registered.add(channel)
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...(args as UpdateArgs<K>))
    } catch (e) {
      // ★ 必须 throw new Error(JSON.stringify(...))，原因见 src/main/ipc.ts 的实测注释。
      throw new Error(encodeForBridge(serializeError(e)))
    }
  })
}

export function emitUpdate<K extends UpdateEventChannel>(
  channel: K,
  payload: UpdateEvents[K]
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function resetUpdateIpc(): void {
  for (const ch of registered) ipcMain.removeHandler(ch)
  registered.clear()
}
