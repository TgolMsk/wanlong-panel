/**
 * 机器人模块自己的一小组 IPC 通道（bot:*），给设置页「在面板内测试机器人动作」用。
 *
 * ★ 与 src/main/alerts/ipc.ts 同一套包装（IpcRoutes 已冻结，不能往里加通道），只服务 bot:*。
 *   错误编码方式与 @main/ipc 完全一致，渲染进程的 normalizeError() 能原样解出 code。
 * ★ 没有推送：机器人动作都是请求-应答。
 * ★ 'bot:perform' 直接调同一个 BotActionPort —— 面板测的就是 Telegram 里点按钮真正会跑的那条路。
 *   BotPhoto.jpeg 是 ArrayBuffer，结构化克隆直接搬字节。
 * ★ 凭据纪律：动作层拿不到 botToken，抛到这里的异常 message 里天然没有 token。
 */

import { ipcMain } from 'electron'
import { serializeError } from '@shared/errors'
import type { SerializedError } from '@shared/errors'
import { BOT_CH, type BotActionPort, type BotArgs, type BotChannel, type BotResult } from '@shared/bot'

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

export function handleBot<K extends BotChannel>(
  channel: K,
  fn: (...args: BotArgs<K>) => Promise<BotResult<K>> | BotResult<K>
): void {
  if (registered.has(channel)) throw new Error(`IPC 通道重复注册: ${channel}`)
  registered.add(channel)
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...(args as BotArgs<K>))
    } catch (e) {
      // ★ 必须是 throw new Error(JSON.stringify(...))，理由见 src/main/ipc.ts 的实测注释。
      throw new Error(encodeForBridge(serializeError(e)))
    }
  })
}

/** 退出/重启时清掉全部 bot:* handler。 */
export function resetBotIpc(): void {
  for (const ch of registered) ipcMain.removeHandler(ch)
  registered.clear()
}

/** 排障用：当前已注册了哪几条 bot:* 通道。 */
export function registeredBotChannels(): string[] {
  return [...registered]
}

/** 把动作执行器挂到 bot:* 通道上。index.ts 在造好 BotActionPort 之后调一次。 */
export function registerBotHandlers(port: BotActionPort): void {
  handleBot(BOT_CH.perform, (action, instanceIndex) => port.perform(action, instanceIndex))
  handleBot(BOT_CH.instances, () => port.listInstances())
}
