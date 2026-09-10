/**
 * 资源统计识别模块的统一出口。
 *
 *   · readResourceStatsPanel —— 完整流程（预检 → 打开弹窗 → 读表 → 还原），★必须在 scheduler.exclusive 锁内调
 *   · readResourceStatsFromFrame —— 纯识别，离线自检 / 面板测试用
 *   · seedResourceTemplates —— 把 docs/game/shots/resources/*.png 裁成模板入库
 *   · RESOURCE_STATS_LAYOUT / rowRoi —— 表格几何
 */

export { RESOURCE_STATS_LAYOUT, rowRoi } from './layout'
export type { ResourceStatsColumn, ResourceStatsLayout } from './layout'
export {
  RES_GLYPH,
  RES_LABEL_TPL,
  RES_TPL,
  RES_UNIT_CHAR,
  invalidateResourceUnitTemplates,
  loadResourceUnitTemplates,
  seedResourceTemplates
} from './templates'
export type { ResourceUnitTemplates, SeedResourceTemplatesOptions } from './templates'
export { mergeSnapshots, readResourceStatsFromFrame, readResourceStatsPanel } from './read'
export type { ReadFromFrameOptions, ReadResourceStatsOptions } from './read'
