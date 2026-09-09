/**
 * 默认值工厂。放在 shared 是为了让 main / renderer 用同一份默认设置，
 * 避免「面板显示的默认值」和「主进程实际用的默认值」对不上。
 */

import {
  DEFAULT_ADB_PATH,
  DEFAULT_MATCH_THRESHOLD,
  DEFAULT_MUMUTOOL_PATH,
  DEFAULT_SHRINK,
  MAX_CONCURRENT_INSTANCES,
  MIN_CAPTURE_INTERVAL_MS,
  REF_HEIGHT,
  REF_WIDTH
} from './constants'
import type { AppSettings } from './domain'
import type { ScriptDef } from './script'

/** dataDir 由主进程填（app.getPath('userData') 或 <工程根>/.wl-data），这里给空串占位。 */
export function defaultSettings(dataDir = ''): AppSettings {
  return {
    adbPath: DEFAULT_ADB_PATH,
    mumutoolPath: DEFAULT_MUMUTOOL_PATH,
    dataDir,
    refWidth: REF_WIDTH,
    refHeight: REF_HEIGHT,
    shrink: DEFAULT_SHRINK,
    matchThreshold: DEFAULT_MATCH_THRESHOLD,
    maxConcurrentInstances: MAX_CONCURRENT_INSTANCES,
    minCaptureIntervalMs: MIN_CAPTURE_INTERVAL_MS,
    shotPolicy: 'onFail',
    instancePollIntervalMs: 3000,
    locale: 'zh-CN'
  }
}

export function emptyScript(id: string, name: string): ScriptDef {
  return {
    id,
    name,
    version: '0.1.0',
    refWidth: REF_WIDTH,
    refHeight: REF_HEIGHT,
    steps: [],
    updatedAt: Date.now()
  }
}

/** 生成一个短 id（不引第三方 uuid 包）。 */
export function makeId(prefix: string): string {
  const t = Date.now().toString(36)
  const r = Math.floor(Math.random() * 0x10000)
    .toString(36)
    .padStart(4, '0')
  return `${prefix}_${t}${r}`
}
