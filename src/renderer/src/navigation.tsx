import {
  AppstoreOutlined,
  BarChartOutlined,
  ClockCircleOutlined,
  RobotOutlined,
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

/**
 * 保留原有页面 key，让旧的页面记忆和页面间跳转继续生效。
 *
 * ★ 一个 ViewKey 在整个数组里**只能出现一次** —— sectionForView 取首个命中，
 *   留两处会让菜单高亮跑到旧的那一组去。删页面入口时记得同步 appStore 的 RETIRED_VIEWS。
 */
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
    description: '查看队伍进度，在卡片上就地展开每个账号的采集配置',
    icon: <ClockCircleOutlined />,
    views: [{ key: 'gatherOverview', label: '采集总览' }]
  },
  {
    key: 'activity',
    label: '运行记录',
    description: '排定定时任务，查看正在执行的任务、日志与画面',
    icon: <ThunderboltOutlined />,
    views: [
      { key: 'plans', label: '任务计划' },
      { key: 'runs', label: '执行监控' }
    ]
  },
  {
    key: 'stats',
    label: '数据统计',
    description: '按北京日期看派兵、预计采集量、失败熔断与暂停时长',
    icon: <BarChartOutlined />,
    views: [{ key: 'stats', label: '数据统计' }]
  },
  {
    key: 'ai',
    label: 'AI 处理',
    description: '认不出界面时问视觉大模型，低风险的关闭 / 取消可自动处理',
    icon: <RobotOutlined />,
    views: [{ key: 'ai', label: 'AI 处理' }]
  },
  {
    key: 'tools',
    label: '脚本与模板',
    description: '编排脚本与维护识别模板',
    icon: <ToolOutlined />,
    views: [
      { key: 'scripts', label: '脚本' },
      { key: 'templates', label: '模板库' }
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
