/**
 * 应用 / 系统通道：设置读写、路径、打开目录、文件选择、环境自检。
 */

import { BrowserWindow, dialog, shell } from 'electron'
import { AppError } from '@shared/errors'
import { CH } from '@shared/ipc'
import type { ResolvedPaths } from '@shared/domain'
import { emit, handle } from '@main/ipc'
import { runHealthCheck } from '@main/health'
import { DIRECTORY_PATH_KEYS, ensureDirs } from '@main/paths'
import { getRuntimeSettings } from '@main/config'
import type { MainDeps } from './index'

const DIR_KEYS = new Set<string>(DIRECTORY_PATH_KEYS)

export function registerAppHandlers(deps: MainDeps): void {
  handle(CH.appSettings, () => deps.settings())

  handle(CH.appSaveSettings, async (patch) => {
    const next = await deps.saveSettings(patch)
    // dataDir 可能被改到一个全新的位置，先把目录建好再让别的模块去写。
    await ensureDirs(deps.paths())
    return next
  })

  handle(CH.appPaths, () => deps.paths())

  handle(CH.appOpenPath, async (key) => {
    const paths = deps.paths()
    const target = paths[key as keyof ResolvedPaths]
    if (typeof target !== 'string' || !target) {
      throw new AppError('NOT_FOUND', `没有名为 ${String(key)} 的路径。`)
    }
    if (DIR_KEYS.has(key as string)) {
      const err = await shell.openPath(target)
      if (err) throw new AppError('IO_ERROR', `无法打开目录 ${target}：${err}`)
    } else {
      // adbPath / mumutoolPath 是可执行文件，直接 open 会把它跑起来，只能定位到访达。
      shell.showItemInFolder(target)
    }
  })

  handle(CH.appHealth, async () => {
    const report = await runHealthCheck(getRuntimeSettings())
    emit('app:health', report)
    return report
  })

  handle(CH.appPickFile, async (filters) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      title: '选择文件',
      properties: ['openFile' as const],
      filters: filters ?? []
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
