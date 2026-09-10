/**
 * 离线自检专用的 electron 假实现。
 *
 * 为什么需要它：`src/main/alerts/ipc.ts` 与 `src/main/scheduler/ipc.ts` 在模块顶层
 * `import { BrowserWindow, ipcMain } from 'electron'`。而离线自检脚本是在**纯 node**
 * 里跑的（`node out/check/xxx.mjs`），此时 `require('electron')` 只会返回 electron
 * 可执行文件的路径字符串，取不到 ipcMain / BrowserWindow 这两个具名导出，
 * 模块一加载就炸。
 *
 * 所以打包离线自检时用 esbuild 的 `--alias:electron=` 把它换成这个壳。
 * 这里只提供自检真正会碰到的那几个 API，**不模拟任何真实行为**：
 *   · ipcMain.handle / removeHandler —— 把 handler 记在 Map 里，自检可以直接调出来验证
 *   · BrowserWindow.getAllWindows() —— 永远返回空数组，于是 emit* 是个安全的空操作
 *
 * ★ 这个文件只服务离线自检，**绝不会**被打进 out/main 的正式产物
 *   （electron.vite.config.ts 里没有这条 alias）。
 */

/** 已注册的 IPC handler：通道名 -> 处理函数。自检可以 `ipcMain._handlers.get(ch)` 直接调。 */
const handlers = new Map()

export const ipcMain = {
  _handlers: handlers,
  handle(channel, fn) {
    handlers.set(channel, fn)
  },
  removeHandler(channel) {
    handlers.delete(channel)
  },
  /** 自检辅助：像渲染进程那样调一次某条通道。 */
  async _invoke(channel, ...args) {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`离线自检：通道 ${channel} 还没有注册 handler`)
    return fn(null, ...args)
  }
}

export const BrowserWindow = {
  getAllWindows: () => []
}

export const app = {
  getPath: () => '/tmp',
  getName: () => 'wanlong-panel-offline'
}

export const shell = {}
export const net = {}
export const dialog = {}
export default { ipcMain, BrowserWindow, app, shell, net, dialog }
