/**
 * 「AI 顾问」模块在渲染进程侧的对外入口。
 * 设置页：`import { AiSettingsCard } from '@/features/ai'`，当成一张卡片直接放进去。
 */

export { default as AiSettingsCard } from './AiSettingsCard'
export { default as AiView } from './AiView'
export { useAiStore, subscribeAi } from './aiStore'
