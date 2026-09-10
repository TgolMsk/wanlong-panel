/**
 * 外观（暗/亮）读写。
 *
 * 真正的状态在 appStore 的 `themeMode` 上：
 *   · `setThemeMode` 内部会调 `applyThemeMode`，把 <html data-theme> 与 localStorage 一起写掉；
 *   · antd 的 ThemeConfig 在 main.tsx 里跟着同一个字段走。
 * 所以这里只是一层薄封装，**不要**在别处再写一份切换逻辑。
 */

import { useCallback } from 'react'
import { useAppStore } from '../store/appStore'
import type { WlThemeMode } from '../styles/antd-theme'

export type UseThemeMode = [
  mode: WlThemeMode,
  toggle: () => void,
  setMode: (m: WlThemeMode) => void
]

export function useThemeMode(): UseThemeMode {
  const mode = useAppStore((s) => s.themeMode)
  const setMode = useAppStore((s) => s.setThemeMode)
  const toggle = useCallback(() => {
    setMode(mode === 'dark' ? 'light' : 'dark')
  }, [mode, setMode])
  return [mode, toggle, setMode]
}

export default useThemeMode
