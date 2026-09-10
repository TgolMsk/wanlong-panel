/**
 * 「异常检测 / 自动暂停 / Telegram 推送」模块在渲染进程侧的对外入口。
 *
 * 给接线的人：
 *   · 设置页：`import { AlertSettingsCard } from '@/features/alerts'`，当成一张卡片直接放进去，
 *     不需要传任何 props（数据从本模块自己的 alertStore 取）。
 *   · 实例卡片：`import { PauseBanner, pauseOf, useAlertStore } from '@/features/alerts'`。
 *   · 页面挂载时记得 `useEffect(() => subscribeAlerts(), [])`，否则暂停态不会实时更新。
 *
 * 契约全部来自 @shared/alerts（事件模型 / 配置 / 暂停态 / alerts:* 通道）。
 * 主进程还没注册这些通道时，页面照常渲染并把中文原因显示出来，不会白屏也不会假装有数据。
 */

export { default as AlertSettingsCard } from './AlertSettingsCard'
export { default as PauseBanner, type PauseBannerProps } from './PauseBanner'

export { useAlertStore, subscribeAlerts, pauseOf, pausedIndexes } from './alertStore'
