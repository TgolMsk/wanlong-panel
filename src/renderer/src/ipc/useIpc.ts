/**
 * 渲染进程访问主进程的唯一入口封装。
 *
 * 规矩（别绕开）：
 *  1. 渲染进程**永远不直接碰 adb / mumutool / fs**，sandbox 下也碰不到。所有能力都从这里过。
 *  2. 主进程 reject 过来的错误，经 Electron 桥接后**一定**不再是 SerializedError 实例。
 *     实测（electron 44.3.0，见下）：ipcMain.handle 里抛出的东西会被 `error.toString()` 掉，
 *     renderer 拿到的永远是 `new Error("Error invoking remote method '<ch>': " + <那个字符串>)`：
 *       · 抛纯对象      -> "…: [object Object]"                      ← code / detail 全丢
 *       · 抛 Error 实例 -> "…: Error: 中文消息"                        ← 只剩消息
 *       · 抛 new Error(JSON.stringify(serializeError(e)))
 *                       -> "…: Error: {\"__wlError\":true,\"code\":…}"  ← 全部保住 ✔
 *     所以主进程侧必须走第三种；normalizeError() 负责在渲染侧把这三种都尽量还原成
 *     { code, message, detail }，否则像 TEMPLATE_LOW_VARIANCE 这种要做专门 UI 的错误码会丢。
 *  3. 高频数据（实时日志、预览帧）不走这里，走 MessagePort（见 useWorkerPort.ts）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { message as staticMessage } from 'antd'
import { ERROR_CODES, isSerializedError } from '@shared/errors'
import type { ErrorCode, SerializedError } from '@shared/errors'
import type { IpcArgs, IpcChannel, IpcEventChannel, IpcEvents, IpcResult } from '@shared/ipc'

// ── 提示通道 ──────────────────────────────────────────────────────────────
// 默认用 antd 静态 message；App.tsx 挂载后会把 <App> 上下文里的实例注册进来，
// 这样弹窗才能继承 ConfigProvider 的主题与中文 locale。

/** 只用到这四个方法，故意不依赖 antd 内部类型路径，避免深层 import 被 exports 字段挡住。 */
export interface Toaster {
  success(content: string): unknown
  error(content: string): unknown
  warning(content: string): unknown
  info(content: string): unknown
}

let toaster: Toaster = staticMessage

/** App.tsx 在挂载时调用，把带上下文的 message 实例接进来。 */
export function bindToaster(api: Toaster): void {
  toaster = api
}

export function toast(): Toaster {
  return toaster
}

// ── 错误归一化 ────────────────────────────────────────────────────────────

const CODE_SET = new Set<string>(ERROR_CODES)

/** 从 Electron 包装过的错误里尽力还原出 SerializedError。 */
export function normalizeError(e: unknown): SerializedError {
  if (isSerializedError(e)) return e

  const raw = e instanceof Error ? e.message : String(e)

  // Electron 的格式：Error invoking remote method 'instance:list': <原始错误文本>
  // 里层往往还套一层 "Error: "（因为主进程抛的是 Error 实例，被 toString 了一次）。
  const stripped = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')

  // 主进程抛了一个纯对象（不是 Error），被 toString 成了 [object Object]。
  // 这时候什么信息都没有，只能给一句能指向修复方向的提示。
  if (stripped === '[object Object]') {
    return {
      __wlError: true,
      code: 'UNKNOWN',
      message:
        '主进程报错了，但错误内容在 IPC 桥上丢失了（收到 [object Object]）。' +
        '主进程的 ipcMain.handle 必须抛 new Error(JSON.stringify(serializeError(e)))，' +
        '直接抛纯对象会被 Electron 的 error.toString() 吃掉。'
    }
  }

  // 主进程若把 SerializedError 原样 JSON 化了，这里能捞回完整信息。
  const braceAt = stripped.indexOf('{')
  if (braceAt >= 0) {
    const maybe = stripped.slice(braceAt)
    try {
      const parsed: unknown = JSON.parse(maybe)
      if (isSerializedError(parsed)) return parsed
    } catch {
      /* 不是 JSON，继续走下面的兜底 */
    }
  }

  // 兜底：从文本里扫一个已知错误码出来，至少让 UI 能按 code 分支。
  let code: ErrorCode = 'UNKNOWN'
  for (const token of stripped.split(/[^A-Z_]+/)) {
    if (token.length > 3 && CODE_SET.has(token)) {
      code = token as ErrorCode
      break
    }
  }
  return { __wlError: true, code, message: stripped || '未知错误' }
}

/** 取一句可以直接显示给用户的中文错误说明。 */
export function describeError(e: unknown): string {
  return normalizeError(e).message
}

// ── 调用 ──────────────────────────────────────────────────────────────────

/** 静默调用：不弹提示，reject 出来的是归一化后的 SerializedError。 */
export async function silentCall<K extends IpcChannel>(
  channel: K,
  ...args: IpcArgs<K>
): Promise<IpcResult<K>> {
  try {
    return await window.api.invoke(channel, ...args)
  } catch (e) {
    throw normalizeError(e)
  }
}

/** 常规调用：失败时弹中文提示，并继续把归一化错误抛出去（调用方可按 code 分支）。 */
export async function call<K extends IpcChannel>(
  channel: K,
  ...args: IpcArgs<K>
): Promise<IpcResult<K>> {
  try {
    return await window.api.invoke(channel, ...args)
  } catch (e) {
    const err = normalizeError(e)
    toaster.error(err.message)
    throw err
  }
}

/** 宽容调用：失败时弹提示并返回 undefined，绝不抛。UI 事件回调里用这个最省心。 */
export async function tryCall<K extends IpcChannel>(
  channel: K,
  ...args: IpcArgs<K>
): Promise<IpcResult<K> | undefined> {
  try {
    return await window.api.invoke(channel, ...args)
  } catch (e) {
    toaster.error(describeError(e))
    return undefined
  }
}

/** 常见套路：调用成功弹一条成功提示，失败弹错误提示，返回是否成功。 */
export async function callWithToast<K extends IpcChannel>(
  okText: string,
  channel: K,
  ...args: IpcArgs<K>
): Promise<boolean> {
  try {
    await window.api.invoke(channel, ...args)
    toaster.success(okText)
    return true
  } catch (e) {
    toaster.error(describeError(e))
    return false
  }
}

// ── Hooks ─────────────────────────────────────────────────────────────────

export interface IpcQueryState<K extends IpcChannel> {
  data?: IpcResult<K>
  loading: boolean
  error?: string
  reload: () => void
}

/**
 * 请求-响应型数据的读取 hook。
 * args 直接写字面量数组即可（内部用 ref 读取，不参与依赖比较）；
 * 真正决定何时重新请求的是 deps。
 */
export function useIpc<K extends IpcChannel>(
  channel: K,
  args: IpcArgs<K>,
  deps: unknown[] = []
): IpcQueryState<K> {
  const [data, setData] = useState<IpcResult<K> | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [tick, setTick] = useState(0)

  const argsRef = useRef(args)
  argsRef.current = args

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(undefined)
    window.api
      .invoke(channel, ...argsRef.current)
      .then((v) => {
        if (!alive) return
        setData(v)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setError(describeError(e))
        setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, tick, ...deps])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, loading, error, reload }
}

/** 订阅主进程推送。回调用 ref 存，改回调不会重新订阅。 */
export function useIpcEvent<K extends IpcEventChannel>(
  channel: K,
  cb: (payload: IpcEvents[K]) => void
): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    return window.api.on(channel, (payload) => ref.current(payload))
  }, [channel])
}

// ── 二进制辅助 ────────────────────────────────────────────────────────────

/**
 * ArrayBuffer -> blob: URL。二进制一律走这条路，**不要 base64**。
 * 调用方负责在不用时 URL.revokeObjectURL()。
 */
export function bufferToObjectUrl(buf: ArrayBuffer, mime = 'image/jpeg'): string {
  return URL.createObjectURL(new Blob([buf], { type: mime }))
}
