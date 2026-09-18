/**
 * 计划模块自己的一小组 IPC 通道。
 *
 * ★ 为什么不用 @main/ipc 的 handle/emit：那两个函数的通道名被 IpcRoutes / IpcEvents 约束，
 *   而这两张表在 src/shared/ipc.ts 里**已经冻结**（52 条请求 + 6 条推送），不属于本模块
 *   可以改动的范围。所以这里复制了一份等价的包装，只服务 plan:* 这几条 ——
 *   与 src/main/scheduler/ipc.ts 是同一套做法，错误编码方式也完全一致，
 *   渲染进程的 normalizeError() 能原样解出 code。
 *
 *   将来契约层解冻，把 PlanRoutes / PlanEvents 并进 IpcRoutes / IpcEvents，
 *   本文件就可以整体删掉，调用点一行都不用改。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { serializeError } from '@shared/errors'
import type { SerializedError } from '@shared/errors'
import type { PlanArgs, PlanChannel, PlanEventChannel, PlanEvents, PlanResult } from '@shared/plan'

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

export function handlePlan<K extends PlanChannel>(
  channel: K,
  fn: (...args: PlanArgs<K>) => Promise<PlanResult<K>> | PlanResult<K>
): void {
  if (registered.has(channel)) throw new Error(`IPC 通道重复注册: ${channel}`)
  registered.add(channel)
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...(args as PlanArgs<K>))
    } catch (e) {
      // ★ 必须是 throw new Error(JSON.stringify(...))，别改成 throw 纯对象或 throw AppError，
      //   原因见 src/main/ipc.ts 里那段实测注释。
      throw new Error(encodeForBridge(serializeError(e)))
    }
  })
}

export function emitPlan<K extends PlanEventChannel>(channel: K, payload: PlanEvents[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function resetPlanIpc(): void {
  for (const ch of registered) ipcMain.removeHandler(ch)
  registered.clear()
}
