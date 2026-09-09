/**
 * 类型安全的 IPC 包装。这就是全部 —— 不引 trpc 之类的重框架。
 *
 * handle() 保证：通道名、参数个数与类型、返回值类型全部被 IpcRoutes 约束，
 * 改一处签名两端同时报错。
 * 同时统一把抛出的错误 serialize 成 SerializedError，否则过 IPC 桥会丢掉 code。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { serializeError } from '@shared/errors'
import type { IpcArgs, IpcChannel, IpcEventChannel, IpcEvents, IpcResult } from '@shared/ipc'

const registered = new Set<string>()

export function handle<K extends IpcChannel>(
  channel: K,
  fn: (...args: IpcArgs<K>) => Promise<IpcResult<K>> | IpcResult<K>
): void {
  if (registered.has(channel)) {
    throw new Error(`IPC 通道重复注册: ${channel}`)
  }
  registered.add(channel)
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...(args as IpcArgs<K>))
    } catch (e) {
      // ★ 必须转成纯数据。直接 throw Error 过桥后 renderer 只能拿到一个字符串消息，
      //   code / detail 全丢，面板就没法做针对性的中文提示。
      throw serializeError(e)
    }
  })
}

/** 向所有窗口推送一个事件。 */
export function emit<K extends IpcEventChannel>(channel: K, payload: IpcEvents[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** 单元测试或热重载时清空注册表。 */
export function resetIpc(): void {
  for (const ch of registered) ipcMain.removeHandler(ch)
  registered.clear()
}
