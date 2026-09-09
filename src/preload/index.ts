/**
 * preload —— 渲染进程与主进程之间唯一的桥。
 *
 * ★ 构建约定：本文件被 electron.vite.config.ts 强制编译成 **CommonJS** 的 out/preload/index.cjs。
 *   原因：sandbox:true 时 Electron 只能加载 CJS preload，加载 .mjs 会报
 *   "Cannot use import statement outside a module"，症状是 window.api === undefined。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { WORKER_PORT_CHANNEL } from '@shared/worker'
import type { IpcApi, IpcArgs, IpcChannel, IpcEventChannel, IpcEvents } from '@shared/ipc'

const api: IpcApi = {
  invoke: <K extends IpcChannel>(channel: K, ...args: IpcArgs<K>) =>
    ipcRenderer.invoke(channel, ...args),

  on: <K extends IpcEventChannel>(channel: K, cb: (payload: IpcEvents[K]) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: IpcEvents[K]): void => cb(payload)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.off(channel, handler)
    }
  },

  env: {
    isDev: process.env.NODE_ENV === 'development',
    platform: process.platform,
    versions: {
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? ''
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

/**
 * ★ MessagePort 不能穿 contextBridge —— 会被克隆成失去方法的代理对象，
 *   渲染进程里调用 port.start() 会报 "port.start is not a function"。
 *   所以这里只做**转发**：把 port 通过 window.postMessage 丢进主世界，
 *   渲染进程用 window.addEventListener('message') 自己接真 MessagePort。
 */
ipcRenderer.on(WORKER_PORT_CHANNEL, (e, meta: { runId: string; instanceIndex: number }) => {
  window.postMessage({ __wlPort: WORKER_PORT_CHANNEL, ...meta }, '*', e.ports)
})
