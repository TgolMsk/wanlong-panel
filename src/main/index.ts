/**
 * Electron 主进程入口。
 *
 * 职责边界（务必遵守）：主进程只做 **窗口 + 编排 + IPC 转发**。
 * 绝不在这里跑截图循环、模板匹配、脚本执行 —— 那些一律进 utilityProcess（out/main/runner.js）。
 * 实测在主线程跑一次 matchTemplate 会让事件循环卡 71.8ms，面板肉眼可见掉帧。
 *
 * ⚠️ 当前是可启动的骨架，业务接线由「模块 e」补齐。
 */

import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: '万龙控制面板',
    autoHideMenuBar: true,
    webPreferences: {
      // ★ 路径必须是 .cjs：sandbox 下 Electron 只能加载 CommonJS preload
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.wanlong.panel')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // TODO(模块 e): 在这里初始化 settings / 日志 / mumu 轮询 / adb / orchestrator，并注册全部 IPC handler。

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
