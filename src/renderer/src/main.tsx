/**
 * 渲染进程入口。
 *
 * 这里只做四件事：载入设计令牌、定好主题模式、套上 antd 的中文 locale 与 App 上下文、挂载根组件。
 * 业务一律在 App.tsx 及各视图里，不在这。
 *
 * 注：工程刻意不引 Tailwind —— v4 的 preflight 会把 antd 的基础样式重置掉，收益为负。
 * 全局样式（reset、渐变底、字体、滚动条、工具类）全部收在 styles/tokens.css，
 * 原先在本文件里用 <style> 注入的那一小段已经并进去了，别再往这加样式。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles/tokens.css'
import { applyThemeMode, getAntdTheme, readStoredThemeMode } from './styles/antd-theme'
import { useAppStore } from './store/appStore'

// 挂载前先把 <html data-theme> 定下来，避免首帧闪一下默认色。
// tokens.css 的亮色分支、antd 的 ThemeConfig 都以此为准。
applyThemeMode(readStoredThemeMode())

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 挂载点，index.html 被改坏了')
}

/**
 * antd 的 ThemeConfig 必须跟着 store 里的 themeMode 走，
 * 否则切主题时 CSS 变量变了、antd 的 CSS-in-JS 还停在旧色。
 */
function Root(): React.JSX.Element {
  const mode = useAppStore((s) => s.themeMode)
  return (
    <ConfigProvider locale={zhCN} theme={getAntdTheme(mode)}>
      <AntApp style={{ height: '100%' }}>
        <App />
      </AntApp>
    </ConfigProvider>
  )
}

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
