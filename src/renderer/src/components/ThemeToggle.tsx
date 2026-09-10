/**
 * 暗/亮外观切换。顶栏与「设置 → 外观」共用这一个组件，切换逻辑只有一份（见 hooks/useThemeMode）。
 * 默认暗色；选择会记在 localStorage，下次启动沿用。
 */

import { Button, Tooltip } from 'antd'
import { MoonOutlined, SunOutlined } from '@ant-design/icons'
import { useThemeMode } from '../hooks/useThemeMode'

export interface ThemeToggleProps {
  /** 顶栏用图标按钮（默认），设置页用带文字的按钮。 */
  showLabel?: boolean
}

export default function ThemeToggle({ showLabel = false }: ThemeToggleProps): React.JSX.Element {
  const [mode, toggle] = useThemeMode()
  const dark = mode === 'dark'
  const next = dark ? '切换到亮色' : '切换到暗色'

  const btn = (
    <Button
      type="text"
      shape={showLabel ? 'default' : 'circle'}
      aria-label={next}
      icon={dark ? <SunOutlined /> : <MoonOutlined />}
      onClick={toggle}
    >
      {showLabel ? (dark ? '暗色' : '亮色') : null}
    </Button>
  )

  return showLabel ? btn : <Tooltip title={next}>{btn}</Tooltip>
}
