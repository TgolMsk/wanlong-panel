/**
 * 「自动采集资源」模块的对外出口。
 *
 * 典型接线（ETA 调度器那边只需要这几行）：
 *
 *   import { loadGatherTemplates, createAdbGatherIo, runGatherCycle } from '@main/game/gather'
 *
 *   const templates = await loadGatherTemplates({ templatesDir: paths.templatesDir })
 *   const io = createAdbGatherIo({ serial })
 *   const r = await runGatherCycle({ io, templates, config, state, log, onShot, signal })
 *   saveState(r.state)                    // ★ 必须存回去：等级上限缓存 / 在途记账 / 退避档位都在里面
 *   if (r.nextWakeAt) scheduleWakeAt(r.nextWakeAt)
 *
 * 本模块**不注册 IPC、不写磁盘、不起定时器** —— 那些都属于调度器与主进程接线层。
 */

export { createAdbGatherIo, AdbGatherIo, type AdbGatherIoOptions } from './adbIo'
export {
  DEFAULT_GATHER_CONFIG,
  DEFAULT_LEVEL_POLICY,
  GATHER_CONFIG_VERSION,
  RESOURCE_LABEL,
  canRelaxFloor,
  computeSearchFloor,
  effectiveLevelPolicy,
  effectiveMaxTravelSeconds,
  effectiveMinStorage,
  normalizeGatherConfig,
  normalizeLevelPolicy,
  type AllianceTerritory,
  type GatherConfig,
  type GatherResourceType,
  type GatherSafety,
  type GatherSchedule,
  type GatherThresholds,
  type LevelPolicy,
  type QueuePlan,
  type ResourceEntry,
  type SearchRetry
} from './config'
export { runGatherCycle, type RunGatherCycleOptions } from './flow'
export {
  backoffSeconds,
  earliestFreeAt,
  hasUncertainEta,
  planWake,
  toMarchRecords,
  type WakePlan
} from './eta'
export {
  GLYPH,
  TPL,
  loadGatherTemplates,
  resolveGatherSetId,
  type GatherTemplates,
  type LoadGatherTemplatesOptions
} from './templates'
export { GatherHalt, GatherSession, type GatherIo, type GatherLogger } from './session'
export {
  createRuntimeState,
  TROOP_STATUS_LABEL,
  type DispatchRecord,
  type GatherCycleResult,
  type GatherOutcome,
  type GatherRuntimeState,
  type MarchRecord,
  type TroopPanelReading,
  type TroopRow,
  type TroopStatus
} from './types'
export { GAME_PACKAGE } from './geometry'

// 单个状态的入口也导出，便于排障工具/单测直接调某一段流程。
export { readCard, reconcileAutoGather, validateCard, waitForCard, type CardReading, type CardVerdict } from './card'
export { dispatchTroop, type DispatchResult } from './dispatch'
export { closeTroopPanel, dismissNoticeDialog, ensureWorldMap } from './navigation'
export {
  classifyCategory,
  initialSearchFloor,
  openSearchPanel,
  probeMaxLevel,
  readSliderLevel,
  relaxSearchFloor,
  selectCategory,
  setSearchFloor,
  tapSearch
} from './searchPanel'
export { maxStamina, openTroopPanel, readTroopPanel } from './troopPanel'
