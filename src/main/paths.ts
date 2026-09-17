/**
 * 运行时路径解析。
 *
 * 只做「算路径 + 建目录」，不读写业务数据。所有需要绝对路径的地方都从这里取，
 * 禁止在别处用 join(app.getPath('userData'), ...) 自己拼，否则开发/生产两套目录会对不上。
 *
 * 目录约定见 ARCHITECTURE.md 第 6 节：
 *   <dataDir>/settings.json
 *   <dataDir>/accounts/accounts.json
 *   <dataDir>/scripts/<scriptId>.json
 *   <dataDir>/templates/<setId>/{manifest.json, <templateId>.png}
 *   <dataDir>/shots/<runId>/<seq>-<stepId>.jpg
 *   <dataDir>/logs/{app.ndjson, <runId>.ndjson}
 */

import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { app } from 'electron'
import {
  DATA_DIRS,
  DEFAULT_ADB_PATH,
  DEFAULT_MUMUTOOL_PATH,
  SETTINGS_FILE
} from '@shared/constants'
import type { AppSettings, ResolvedPaths } from '@shared/domain'

/** 是否是 `npm run dev` 起的未打包进程。 */
export function isDev(): boolean {
  return !app.isPackaged
}

/**
 * 运行数据根目录的**默认值**。
 *   生产 = app.getPath('userData')（macOS: ~/Library/Application Support/wanlong-panel）
 *   开发 = <工程根>/.wl-data（已 gitignore，方便随时 rm -rf 重来）
 */
export function defaultDataDir(): string {
  return isDev() ? join(app.getAppPath(), '.wl-data') : app.getPath('userData')
}

/**
 * 随包分发的静态资源目录（内置模板、ADBKeyboard.apk）。
 *   生产 = <Contents/Resources>/resources
 *   开发 = <工程根>/resources
 */
export function resourcesDir(): string {
  return isDev() ? join(app.getAppPath(), 'resources') : join(process.resourcesPath, 'resources')
}

/**
 * 设置文件的绝对路径。
 *
 * ★ 注意这里有个先有鸡还是先有蛋的问题：dataDir 本身是一条设置。
 *   解法是「设置文件永远存放在**默认**数据目录」，而 settings.dataDir 只影响
 *   模板/日志/截图/账号这些**运行数据**的落点。绝大多数情况两者相同，
 *   与 ARCHITECTURE.md 的磁盘布局一致；只有用户特意把数据目录搬到外置盘时才会分开。
 */
export function settingsFilePath(): string {
  return join(defaultDataDir(), SETTINGS_FILE)
}

/** 由当前设置推导出全部绝对路径。纯函数，随时可以重算。 */
export function resolvePaths(settings: AppSettings, contextDir?: string): ResolvedPaths {
  const root = settings.dataDir?.trim() ? settings.dataDir : defaultDataDir()
  const dataDir = contextDir ?? root
  return {
    dataDir,
    templatesDir: join(root, DATA_DIRS.templates),
    shotsDir: join(dataDir, DATA_DIRS.shots),
    logsDir: join(dataDir, DATA_DIRS.logs),
    accountsDir: join(dataDir, DATA_DIRS.accounts),
    scriptsDir: join(root, DATA_DIRS.scripts),
    resourcesDir: resourcesDir(),
    adbPath: settings.adbPath?.trim() ? settings.adbPath : DEFAULT_ADB_PATH,
    mumutoolPath: settings.mumutoolPath?.trim() ? settings.mumutoolPath : DEFAULT_MUMUTOOL_PATH
  }
}

/** ResolvedPaths 里哪些键是「目录」（其余是可执行文件）。app:openPath 要靠它决定打开方式。 */
export const DIRECTORY_PATH_KEYS = [
  'dataDir',
  'templatesDir',
  'shotsDir',
  'logsDir',
  'accountsDir',
  'scriptsDir',
  'resourcesDir'
] as const satisfies readonly (keyof ResolvedPaths)[]

/** 建齐所有运行数据目录（幂等）。启动时调一次即可。 */
export async function ensureDirs(paths: ResolvedPaths): Promise<void> {
  const targets = [
    paths.dataDir,
    paths.templatesDir,
    paths.shotsDir,
    paths.logsDir,
    paths.accountsDir,
    paths.scriptsDir
  ]
  for (const dir of targets) {
    await mkdir(dir, { recursive: true })
  }
  // 设置文件可能不在 dataDir 里（见 settingsFilePath 的说明），单独兜一次底。
  await mkdir(defaultDataDir(), { recursive: true })
}
