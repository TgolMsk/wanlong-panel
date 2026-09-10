/**
 * 类型安全的 IPC 包装。这就是全部 —— 不引 trpc 之类的重框架。
 *
 * handle() 保证：通道名、参数个数与类型、返回值类型全部被 IpcRoutes 约束，
 * 改一处签名两端同时报错。
 * 同时统一把抛出的错误 serialize 成 SerializedError，否则过 IPC 桥会丢掉 code。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { serializeError } from '@shared/errors'
import type { SerializedError } from '@shared/errors'
import type { IpcArgs, IpcChannel, IpcEventChannel, IpcEvents, IpcResult } from '@shared/ipc'

const registered = new Set<string>()

/**
 * 把 SerializedError 编码成能安全穿过 Electron IPC 桥的字符串。
 *
 * detail 由各模块自由填充（argv、stderr、Java 堆栈…），理论上应该是可结构化克隆的，
 * 但真混进循环引用 / BigInt 时 JSON.stringify 会抛 —— 那样 catch 块自己炸掉，
 * renderer 只会收到一句莫名其妙的 TypeError。所以降级：宁可丢 detail，
 * 也要保住 code 和面向用户的中文消息。
 */
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
      // ★ 这里的写法是实测定下来的，别"顺手"改回 throw 纯对象或 throw AppError。
      //
      //   Electron（实测 44.3.0，sandbox+contextIsolation）会把 ipcMain.handle 抛出的东西
      //   `toString()` 掉，renderer 侧永远只收到一个字符串：
      //     · throw serializeError(e)            -> "…: [object Object]"      ← code/detail 全丢 ✘
      //     · throw new AppError(...)            -> "…: Error: 中文消息"       ← 只剩消息   ✘
      //     · throw new Error(JSON.stringify(…)) -> "…: Error: {"__wlError":…}" ← 全保住   ✔
      //
      //   渲染进程的 normalizeError()（src/renderer/src/ipc/useIpc.ts）就是按第三种写法
      //   从消息里 JSON.parse 还原 { code, message, detail } 的。面板上所有按错误码分支的
      //   中文提示（TEMPLATE_LOW_VARIANCE、CONCURRENCY_LIMIT、MUMU_API_UNSUPPORTED …）
      //   都依赖这一行。
      throw new Error(encodeForBridge(serializeError(e)))
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
