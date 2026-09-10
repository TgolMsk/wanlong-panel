/**
 * 「每日数据统计」模块在渲染进程侧的对外入口。
 *
 * 给接线的人（App.tsx / 左侧导航）：
 *   import StatsView from '@/features/stats/StatsView'
 * 默认导出的整页组件，不需要传任何 props（数据从本模块自己的 statsStore 与 appStore 取）。
 *
 * 数据来源：`@shared/stats` 的统计通道（stats:daily / stats:range / stats:snapshotNow 与
 * stats:today 推送）。主进程还没注册这些通道时，页面照常渲染空桶并把中文原因显示出来。
 */

export { default as StatsView } from './StatsView'
export { default as ResourceSnapshotTable, type ResourceSnapshotTableProps } from './ResourceSnapshotTable'
export { useStatsStore, subscribeStats, todayKey, RECENT_DAYS } from './statsStore'
