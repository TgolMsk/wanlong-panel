/**
 * 面板根组件：左侧导航 + 顶部状态条 + 内容区。
 *
 * 这里也是所有「主进程 -> 渲染进程」推送的落点：
 *   instance:changed / run:changed / log:line / app:toast / app:settingsChanged / app:health
 * 高频数据（实时日志、预览帧）不走这里，走 MessagePort（见 ipc/useWorkerPort.ts）。
 *
 * 外观：五个主入口 + 组内页面切换，侧栏和顶栏使用半透明底色。
 * 布局在 shell.css，颜色沿用 tokens.css 的 var(--wl-*)。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { App as AntApp, Alert, Button, Layout, Menu, Space, Tooltip } from 'antd'
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons'
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
import { NAVIGATION, sectionForView } from './navigation'
import appLogo from './assets/brand/app-icon.png'
import './styles/shell.css'

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
  const setAccounts = useAppStore((s) => s.setAccounts)
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
  useIpcEvent('account:changed', (list) => setAccounts(list))
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
  const section = sectionForView(view)
  const [collapsed, setCollapsed] = useState(false)
  const sectionViews = useRef<Record<string, ViewKey>>({})
  useEffect(() => {
    sectionViews.current[section.key] = view
  }, [section.key, view])

  return (
    <Layout className="wl-shell">
      <Layout.Sider
        width={208}
        collapsedWidth={72}
        collapsed={collapsed}
        className={`wl-sidebar ${collapsed ? 'wl-sidebar-collapsed' : ''}`}
      >
        <div className="wl-brand">
          <img src={appLogo} alt="万龙面板" />
          {!collapsed && (
            <div>
              <div className="wl-brand-name">万龙面板</div>
              <div className="wl-brand-caption">多账号自动化工作台</div>
            </div>
          )}
        </div>
        {!collapsed && <div className="wl-nav-caption">工作空间</div>}
        <Menu
          className="wl-main-menu"
          mode="inline"
          selectedKeys={[section.key]}
          items={NAVIGATION.map(({ key, label, icon }) => ({ key, label, icon }))}
          onClick={({ key }) => {
            const next = NAVIGATION.find((item) => item.key === key)
            if (next) setView(sectionViews.current[key] ?? next.views[0].key)
          }}
        />
        <div className="wl-sidebar-bottom">
          {!collapsed && <span className="wl-sidebar-note">万龙 · 控制面板</span>}
          <Tooltip title={collapsed ? '展开导航' : '收起导航'}>
            <Button
              type="text"
              aria-label={collapsed ? '展开导航' : '收起导航'}
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
            />
          </Tooltip>
        </div>
      </Layout.Sider>
      <Layout className="wl-workspace">
        <Layout.Header className="wl-workspace-header">
          <div>
            <h1 className="wl-section-title">{section.label}</h1>
            <div className="wl-section-description">{section.description}</div>
          </div>
          <Space size={10}>
            <SemanticTag tone={instancesFull ? 'warning' : 'info'} title="已开机实例数 / 并发上限">
              在线 {upCount}/{settings.maxConcurrentInstances}
            </SemanticTag>
            <SemanticTag tone={activeRuns > 0 ? 'accent' : 'neutral'} title="正在执行的任务数">
              执行中 {activeRuns}
            </SemanticTag>
            <HealthBadge />
            <ThemeToggle />
          </Space>
        </Layout.Header>
        {section.views.length > 1 && (
          <nav className="wl-section-nav" aria-label={`${section.label}页面`}>
            {section.views.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-current={view === item.key ? 'page' : undefined}
                onClick={() => setView(item.key)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        )}
        <Layout.Content className="wl-workspace-content wl-scroll-y">
          {bootstrapped && bootError && (
            <Alert
              type="warning"
              showIcon
              closable
              style={{ marginBottom: 'var(--wl-space-4)' }}
              message="部分数据没能载入"
              description={`${bootError} 请刷新当前页面，或到设置中检查运行环境。`}
            />
          )}
          <CurrentView view={view} />
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
