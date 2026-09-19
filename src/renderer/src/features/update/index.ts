/**
 * 「版本与更新」模块的对外入口。
 *
 * 两个落点：
 *   · 侧栏左下角  `import { SidebarUpdate } from './features/update'`（App.tsx，常驻）
 *   · 设置页右栏  `import UpdateCard from '../features/update/UpdateCard'`（SettingsView）
 * 两边共用 updateStore 一份状态与 UpdatePanel 一份正文，不会出现「卡片在下载、侧栏说已最新」。
 *
 * 契约在 `@shared/update`（update:* 通道）；主进程实现在 src/main/update/。
 */

export { default as UpdateCard } from './UpdateCard'
export { SidebarUpdate, type SidebarUpdateProps } from './SidebarUpdate'
export { default as UpdatePanel, CheckUpdateButton, type UpdatePanelProps } from './UpdatePanel'
export { useUpdateStore, useUpdateFeed, hasPendingUpdate, UPDATE_TONE } from './updateStore'
