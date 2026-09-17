import type { AppSettings } from '@shared/domain'

/** 这些设置改变设备身份或在内存中持有的文件位置，统一在重启时生效。 */
export const RESTART_SETTINGS = [
  'emulator',
  'adbPath',
  'mumutoolPath',
  'dataDir',
  'refWidth',
  'refHeight'
] as const

export function settingsForRuntime(saved: AppSettings, active: AppSettings): AppSettings {
  return {
    ...saved,
    ...Object.fromEntries(RESTART_SETTINGS.map((key) => [key, active[key]])),
    restartRequired: undefined
  }
}

export function settingsNeedRestart(saved: AppSettings, active: AppSettings): boolean {
  return RESTART_SETTINGS.some((key) => saved[key] !== active[key])
}
