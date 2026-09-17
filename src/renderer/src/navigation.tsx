import {
  AppstoreOutlined,
  ClockCircleOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  ToolOutlined
} from '@ant-design/icons'
import type { ReactNode } from 'react'
import type { ViewKey } from './store/appStore'

interface NavigationSection {
  key: string
  label: string
  description: string
  icon: ReactNode
  views: { key: ViewKey; label: string }[]
}

/** 保留原有页面 key，让旧的页面记忆和页面间跳转继续生效。 */
export const NAVIGATION: NavigationSection[] = [
  {
    key: 'devices',
    label: '设备与账号',
    description: '管理模拟器、连接设备与绑定账号',
    icon: <AppstoreOutlined />,
    views: [
      { key: 'instances', label: '模拟器实例' },
      { key: 'accounts', label: '账号管理' }
    ]
  },
  {
    key: 'gather',
    label: '自动采集',
    description: '查看队伍进度，设置每个账号的采集策略',
    icon: <ClockCircleOutlined />,
    views: [
      { key: 'gatherOverview', label: '采集总览' },
      { key: 'gatherConfig', label: '采集配置' }
    ]
  },
  {
    key: 'activity',
    label: '运行记录',
    description: '查看正在执行的任务与每日采集统计',
    icon: <ThunderboltOutlined />,
    views: [
      { key: 'runs', label: '执行监控' },
      { key: 'stats', label: '数据统计' }
    ]
  },
  {
    key: 'tools',
    label: '高级工具',
    description: '编排脚本、维护识别模板与处理未知界面',
    icon: <ToolOutlined />,
    views: [
      { key: 'scripts', label: '脚本' },
      { key: 'templates', label: '模板库' },
      { key: 'ai', label: 'AI 处理' }
    ]
  },
  {
    key: 'settings',
    label: '设置',
    description: '管理运行环境、外观与通知',
    icon: <SettingOutlined />,
    views: [{ key: 'settings', label: '面板设置' }]
  }
]

export function sectionForView(view: ViewKey): NavigationSection {
  return (
    NAVIGATION.find((section) => section.views.some((item) => item.key === view)) ?? NAVIGATION[0]
  )
}
