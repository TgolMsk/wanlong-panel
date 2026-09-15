/**
 * 面板根组件：左侧导航 + 顶部状态条 + 内容区。
 *
 * 这里也是所有「主进程 -> 渲染进程」推送的落点：
 *   instance:changed / run:changed / log:line / app:toast / app:settingsChanged / app:health
 * 高频数据（实时日志、预览帧）不走这里，走 MessagePort（见 ipc/useWorkerPort.ts）。
 *
 * 外观：Layout 三层全透明，让 body 上的品牌渐变（#050517 → #4444A3）透上来；
 * 顶栏用 `.wl-blur-bar` 浮在渐变之上。颜色一律走 tokens.css 的 var(--wl-*)。
 */

import { useEffect, useMemo } from 'react'
import { App as AntApp, Alert, Layout, Menu, Space } from 'antd'
import {
  AppstoreOutlined,
  BarChartOutlined,
  ClockCircleOutlined,
  ControlOutlined,
  FileTextOutlined,
  PictureOutlined,
  RobotOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UserOutlined
} from '@ant-design/icons'
import { countRunningInstances, isRunActive, useAppStore, type ViewKey } from './store/appStore'
import { bindToaster, useIpcEvent } from './ipc/useIpc'
import { postToAllWorkers } from './ipc/useWorkerPort'
import { pushLog } from './store/logStore'
import HealthBadge from './components/HealthBadge'
import { SemanticTag } from './components/StatusTag'
import ThemeToggle from './components/ThemeToggle'
import InstancesView from './views/InstancesView'
import RunsView from './views/RunsView'
import TemplateEditor from './views/TemplateEditor'
import ScriptsView from './views/ScriptsView'
import AccountsView from './views/AccountsView'
import SettingsView from './views/SettingsView'
import GatherOverviewView from './features/gather/GatherOverviewView'
import GatherConfigView from './features/gather/GatherConfigView'
import StatsView from './features/stats/StatsView'
import { AiView } from './features/ai'

const MENU_ITEMS: { key: ViewKey; icon: React.ReactNode; label: string }[] = [
  { key: 'instances', icon: <AppstoreOutlined />, label: '实例管理' },
  { key: 'runs', icon: <ThunderboltOutlined />, label: '执行监控' },
  { key: 'gatherOverview', icon: <ClockCircleOutlined />, label: '采集总览' },
  { key: 'gatherConfig', icon: <ControlOutlined />, label: '采集配置' },
  { key: 'stats', icon: <BarChartOutlined />, label: '数据统计' },
  { key: 'ai', icon: <RobotOutlined />, label: 'AI 处理' },
  { key: 'templates', icon: <PictureOutlined />, label: '模板库' },
  { key: 'scripts', icon: <FileTextOutlined />, label: '脚本' },
  { key: 'accounts', icon: <UserOutlined />, label: '账号' },
  { key: 'settings', icon: <SettingOutlined />, label: '设置' }
]

function CurrentView({ view }: { view: ViewKey }): React.JSX.Element {
  switch (view) {
    case 'instances':
      return <InstancesView />
    case 'runs':
      return <RunsView />
    case 'gatherOverview':
      return <GatherOverviewView />
    case 'gatherConfig':
      return <GatherConfigView />
    case 'stats':
      return <StatsView />
    case 'ai':
      return <AiView />
    case 'templates':
      return <TemplateEditor />
    case 'scripts':
      return <ScriptsView />
    case 'accounts':
      return <AccountsView />
    case 'settings':
      return <SettingsView />
    default:
      return <InstancesView />
  }
}

export default function App(): React.JSX.Element {
  const { message } = AntApp.useApp()

  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const instances = useAppStore((s) => s.instances)
  const runs = useAppStore((s) => s.runs)
  const settings = useAppStore((s) => s.settings)
  const bootError = useAppStore((s) => s.bootError)
  const bootstrapped = useAppStore((s) => s.bootstrapped)
  const bootstrap = useAppStore((s) => s.bootstrap)
  const setInstances = useAppStore((s) => s.setInstances)
  const upsertRun = useAppStore((s) => s.upsertRun)
  const setSettings = useAppStore((s) => s.setSettings)
  const setHealth = useAppStore((s) => s.setHealth)

  // 把带 ConfigProvider 上下文的 message 实例接进 ipc 层，
  // 这样 call()/tryCall() 弹出来的错误提示才有正确的主题与中文 locale。
  useEffect(() => {
    bindToaster(message)
  }, [message])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  // ── 主进程推送 ──────────────────────────────────────────────────────────
  useIpcEvent('instance:changed', (list) => setInstances(list))
  useIpcEvent('run:changed', (snap) => upsertRun(snap))
  useIpcEvent('log:line', (entry) => pushLog(entry))
  useIpcEvent('app:settingsChanged', (s) => setSettings(s))
  useIpcEvent('app:health', (h) => setHealth(h))
  useIpcEvent('app:toast', (t) => {
    if (t.level === 'error') message.error(t.message)
    else if (t.level === 'warning') message.warning(t.message)
    else if (t.level === 'success') message.success(t.message)
    else message.info(t.message)
  })

  // 窗口被藏起来时统一关掉预览推流。一路 screencap 就是一路 280ms 的阻塞，白烧 CPU。
  useEffect(() => {
    const onVis = (): void => {
      if (document.hidden) postToAllWorkers({ type: 'preview', enabled: false })
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const upCount = useMemo(() => countRunningInstances(instances), [instances])
  const activeRuns = useMemo(() => runs.filter((r) => isRunActive(r.status)).length, [runs])
  const instancesFull = upCount >= settings.maxConcurrentInstances

  return (
    <Layout style={{ height: '100vh' }}>
      <Layout.Header
        className="wl-blur-bar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingInline: 'var(--wl-space-6)',
          height: 'var(--wl-layout-header-h)',
          lineHeight: 'normal',
          // 内联写一遍底色：antd 的 Layout.headerBg 与 .wl-blur-bar 都是单类选择器，
          // 注入顺序不保证，内联样式才能稳定压住 antd 默认的 #001529。
          background: 'var(--wl-bg-blur)'
        }}
      >
        <span className="wl-heading">万龙控制面板</span>
        <Space size={10}>
          <SemanticTag
            tone={instancesFull ? 'warning' : 'info'}
            title={instancesFull ? '已开机实例数达到并发上限' : '已开机实例数 / 并发上限'}
          >
            实例 {upCount}/{settings.maxConcurrentInstances}
          </SemanticTag>
          <SemanticTag tone={activeRuns > 0 ? 'accent' : 'neutral'} title="正在执行的任务数">
            执行中 {activeRuns}
          </SemanticTag>
          <HealthBadge />
          <ThemeToggle />
        </Space>
      </Layout.Header>

      <Layout>
        <Layout.Sider
          width={200}
          style={{ background: 'transparent', paddingBlock: 'var(--wl-space-3)' }}
        >
          <Menu
            mode="inline"
            selectedKeys={[view]}
            // 左右内缩交给主题里的 Menu.itemMarginInline，这里不要再叠一层 padding。
            style={{ height: '100%', background: 'transparent', borderInlineEnd: 'none' }}
            onClick={({ key }) => setView(key as ViewKey)}
            items={MENU_ITEMS}
          />
        </Layout.Sider>

        <Layout.Content
          className="wl-scroll-y"
          style={{
            padding: 'var(--wl-layout-content-pad)',
            paddingTop: 'var(--wl-space-3)',
            background: 'transparent'
          }}
        >
          {bootstrapped && bootError && (
            <Alert
              type="warning"
              showIcon
              closable
              style={{ marginBottom: 'var(--wl-space-4)' }}
              message="部分数据没能载入"
              description={`${bootError}\n面板本身可以正常使用，等主进程对应模块接线完成后点各页的「刷新」即可。`}
            />
          )}
          <CurrentView view={view} />
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
