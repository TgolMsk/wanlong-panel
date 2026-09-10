/**
 * 「群控倒计时 + 采集配置」模块的对外入口。
 *
 * 给接线的人（负责 App.tsx / 左侧导航的那位）：
 *   import GatherOverviewView from '@/features/gather/GatherOverviewView'
 *   import GatherConfigView from '@/features/gather/GatherConfigView'
 * 两个都是默认导出的整页组件，直接当成 ViewKey 的一个分支渲染即可，
 * 不需要传任何 props（数据从 appStore 与本模块自己的 marchStore 里取）。
 *
 * 接线要做的事只有两件（都在 App.tsx 里，不在本模块）：
 *   1. ViewKey 联合类型加 'gatherOverview' | 'gatherConfig'
 *   2. MENU_ITEMS 加两条菜单，switch 里加两个 case
 *
 * 数据来源：`@shared/scheduler` 的调度器通道（scheduler:state / :sample / :setAuto /
 * :config / :saveConfig 与 scheduler:changed 推送）。主进程还没注册这些通道时，
 * 页面照常渲染占位卡片并把中文原因显示出来，不会白屏也不会假装有数据。
 */

export { default as GatherOverviewView } from './GatherOverviewView'
export { default as GatherConfigView } from './GatherConfigView'

export { InstanceMarchCard } from './InstanceMarchCard'
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
