/**
 * 「群控倒计时 + 采集配置」模块的对外入口。
 *
 * 给接线的人（负责 App.tsx / 左侧导航的那位）：
 *   import GatherOverviewView from '@/features/gather/GatherOverviewView'
 * 它是默认导出的整页组件，直接当成 ViewKey 的一个分支渲染即可，
 * 不需要传任何 props（数据从 appStore 与本模块自己的 marchStore 里取）。
 *
 * 接线要做的事只有两件（都在 App.tsx 里，不在本模块）：
 *   1. ViewKey 只加 'gatherOverview'（采集配置不再是页面，是总览页 / 实例列表里就地展开的抽屉）
 *   2. 导航加一条菜单，switch 里加一个 case
 *
 * GatherConfigView 现在通常由 GatherConfigDrawer 包着用（传 index / embedded）；
 * 不传 props 的整页用法仍然支持，只是导航里已经没有入口了。
 *
 * 数据来源：`@shared/scheduler` 的调度器通道（scheduler:state / :sample / :setAuto /
 * :config / :saveConfig 与 scheduler:changed 推送）。主进程还没注册这些通道时，
 * 页面照常渲染占位卡片并把中文原因显示出来，不会白屏也不会假装有数据。
 */

export { default as GatherOverviewView } from './GatherOverviewView'
export { default as GatherConfigView } from './GatherConfigView'
export type { GatherConfigViewProps } from './GatherConfigView'
export { default as GatherConfigDrawer } from './GatherConfigDrawer'
export type { GatherConfigDrawerProps } from './GatherConfigDrawer'
export {
  useGatherConfigBadges,
  describeGatherConfigBadge,
  type GatherConfigBadge,
  type GatherConfigBadges
} from './useGatherConfigBadges'

export { InstanceMarchCard, QueueBadge } from './InstanceMarchCard'
export {
  InstanceDiagnosticsBadge,
  type InstanceDiagnosticsBadgeProps
} from './InstanceDiagnosticsBadge'
export {
  collectDiagnostics,
  worstLevel,
  attentionCount,
  type DiagnosticItem,
  type DiagnosticLevel
} from './diagnostics'
export { InstanceGatherControls } from './InstanceGatherControls'
export { useInstanceGather, describeBatchOutcome } from './useInstanceGather'
export type { InstanceGatherApi, BatchOutcome } from './useInstanceGather'
export { MarchRow } from './MarchRow'
export { ResourceBadge } from './ResourceBadge'
export { ConfigField, ConfigSection } from './ConfigField'

export {
  useMarchStore,
  subscribeScheduler,
  emptyQueueState,
  describeSchedulerError
} from './marchStore'

export { useCountdownTick } from './useCountdownTick'

export {
  presentMarch,
  summarizeQueues,
  formatAgo,
  formatClock,
  formatShort,
  type MarchTone,
  type MarchPresentation,
  type PresentOptions,
  type QueueSummary
} from './present'

export {
  defaultGatherConfig,
  defaultLevelPolicy,
  normalizeGatherConfig,
  validateGatherConfig,
  hasBlockingIssue,
  describeLevelPolicy,
  formatStorage,
  formatSeconds,
  type GatherConfig,
  type LevelPolicy,
  type RelativeLevelPolicy,
  type AbsoluteLevelPolicy,
  type ResourceEntry,
  type GatherThresholds,
  type QueuePlan,
  type SearchRetry,
  type GatherSchedule,
  type GatherSafety,
  type AllianceTerritory,
  type ConfigIssue
} from './config'

export {
  loadGatherConfig,
  saveGatherConfig,
  hasLocalGatherConfig,
  migrateLocalConfigToAccount,
  exportGatherConfig,
  importGatherConfig,
  GATHER_PARAM_SCOPE,
  GATHER_PARAM_KEY,
  type LoadedGatherConfig,
  type GatherConfigOrigin,
  type SaveResult
} from './configStorage'

export {
  GATHER_RESOURCE_TYPES,
  GATHER_RESOURCE_META,
  readResourceType,
  type GatherResourceType,
  type GatherResourceMeta
} from './types'
