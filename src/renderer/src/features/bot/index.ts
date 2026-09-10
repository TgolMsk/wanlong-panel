/**
 * 「Telegram 机器人 · 在面板内测试动作」模块在渲染进程侧的对外入口。
 *
 * 给接线的人（设置页）：
 *   import { BotTestCard } from '@/features/bot'
 * 当成一张卡片直接放进去，不需要传任何 props。
 *
 * 契约全部来自 @shared/bot（动作枚举 / 回调数据 / bot:* 通道）。
 * 主进程还没注册 bot:* 通道时，卡片照常渲染并把中文原因显示出来。
 */

export { default as BotTestCard } from './BotTestCard'
