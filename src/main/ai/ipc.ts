/**
 * AI 顾问模块自己的一小组 IPC 通道（ai:*）。
 *
 * 与 src/main/alerts/ipc.ts 同一套写法、同一个理由：契约层的 IpcRoutes 已冻结，
 * 本模块自带通道表（@shared/ai 的 AiRoutes / AiPushEvents），错误编码方式与 @main/ipc 完全一致。
 *
 * ★★ 凭据纪律：这里会把 serializeError(e) 原样编码过桥，所以抛到这里的异常 message / detail
 *    里都不许含 apiKey —— advisor.ts / client.ts 的每一处出口都已先过 scrubAiSecret()。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { serializeError } from '@shared/errors'
import type { SerializedError } from '@shared/errors'
import { AI_CH } from '@shared/ai'
import type { AiArgs, AiChannel, AiPushChannel, AiPushEvents, AiResult } from '@shared/ai'
import type { AiAdvisor } from './advisor'

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

export function handleAi<K extends AiChannel>(
  channel: K,
  fn: (...args: AiArgs<K>) => Promise<AiResult<K>> | AiResult<K>
): void {
  if (registered.has(channel)) throw new Error(`IPC 通道重复注册: ${channel}`)
  registered.add(channel)
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...(args as AiArgs<K>))
    } catch (e) {
      // 与 @main/ipc 一致：必须 throw new Error(JSON.stringify(...))，渲染侧才解得出 code。
      throw new Error(encodeForBridge(serializeError(e)))
    }
  })
}

export function emitAi<K extends AiPushChannel>(channel: K, payload: AiPushEvents[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** 注册全部 ai:* 通道。只能调一次。 */
export function registerAiHandlers(advisor: AiAdvisor): void {
  handleAi(AI_CH.config, () => advisor.getConfigView())
  handleAi(AI_CH.saveConfig, (patch) => advisor.saveConfig(patch))
  handleAi(AI_CH.test, () => advisor.test())
  handleAi(AI_CH.status, () => advisor.status())
  handleAi(AI_CH.history, (limit) => advisor.history(limit))
}

export function resetAiIpc(): void {
  for (const ch of registered) ipcMain.removeHandler(ch)
  registered.clear()
}
