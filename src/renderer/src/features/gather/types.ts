/**
 * 本模块的本地类型与常量。
 *
 * ★ 在途队伍 / 队列状态的**权威契约是 `@shared/scheduler`**（MarchState / InstanceQueueState /
 *   deriveMarchView / callScheduler / onSchedulerEvent），本模块直接消费它，不再另起一套。
 *   这里只放两样契约里没有、纯属界面表现的东西：
 *     1. 资源类型的中文名与配色（配置表单与倒计时行的彩色徽章都要用）
 *     2. 从 MarchState 上「尽力而为」地读资源类型的兼容读法（见下）
 */

// ── 资源类型 ────────────────────────────────────────────────────────────────

/** 与 gather-config.schema.json 的 definitions.resourceType 严格一致。 */
export type GatherResourceType = 'wood' | 'gold' | 'iron' | 'mana'

export const GATHER_RESOURCE_TYPES: readonly GatherResourceType[] = [
  'wood',
  'gold',
  'iron',
  'mana'
] as const

export interface GatherResourceMeta {
  /** 资源名（背包里的叫法）。 */
  resource: string
  /** 世界地图搜索面板里的分类名。 */
  category: string
  /** 分类栏点击 x（参考分辨率 2560x1440，y 固定 1310）。仅作展示与排障参考。 */
  categoryTapX: number
  /** 一个字的简写，用作彩色徽章（没有原画时的退路）。 */
  glyph: string
  /** 取 tokens.css 的多序列色，不自己编颜色。 */
  colorVar: string
  /** 资源原画（透明底 PNG 的 URL）。由 assets/resources/<type>.png 自动接入，缺文件就是 undefined。 */
  icon?: string
}

/**
 * 资源原画：resources/icons/raw 里的白底原图经 `node scripts/resource-icons.mjs` 抠成透明底后
 * 落在 assets/resources/<type>.png。这里按文件名取用，缺哪张哪张退回文字徽章，不会让构建失败。
 */
const RESOURCE_ICONS = import.meta.glob('../../assets/resources/*.png', {
  eager: true,
  import: 'default'
}) as Record<string, string>

function iconOf(type: GatherResourceType): string | undefined {
  const key = Object.keys(RESOURCE_ICONS).find((k) => k.endsWith(`/${type}.png`))
  return key ? RESOURCE_ICONS[key] : undefined
}

/** 资源元信息表。数值来自 gather-config.schema.json 的 x-labels，改那边就要改这里。 */
export const GATHER_RESOURCE_META: Record<GatherResourceType, GatherResourceMeta> = {
  wood: {
    resource: '木材',
    category: '伐木场',
    categoryTapX: 1276,
    glyph: '木',
    colorVar: 'var(--wl-series-2)',
    icon: iconOf('wood')
  },
  gold: {
    resource: '金币',
    category: '金矿',
    categoryTapX: 874,
    glyph: '金',
    colorVar: 'var(--wl-series-4)',
    icon: iconOf('gold')
  },
  iron: {
    resource: '铁矿石',
    category: '铁矿',
    categoryTapX: 1686,
    glyph: '铁',
    colorVar: 'var(--wl-series-1)',
    icon: iconOf('iron')
  },
  mana: {
    resource: '魔水',
    category: '魔水池',
    categoryTapX: 2088,
    glyph: '魔',
    colorVar: 'var(--wl-series-3)',
    icon: iconOf('mana')
  }
}

function isResourceType(v: unknown): v is GatherResourceType {
  return typeof v === 'string' && (GATHER_RESOURCE_TYPES as readonly string[]).includes(v)
}

/**
 * 从一行队伍状态里读出它在采什么资源。
 *
 * ★ `@shared/scheduler` 的 `MarchState` 目前**没有**资源类型字段 —— 「部队管理」面板每一行
 *   只给状态词、坐标、兵力、耐力，采的是木头还是铁矿要靠派兵时记下来。
 *   所以这里做成「有就用、没有就显示未知」的兼容读法：调度器哪天在 MarchState 上补了
 *   `resourceType`（或者在派兵记账里带上），界面立刻就能显示彩色徽章，不用改渲染代码。
 *   在那之前徽章是灰色问号，并在 tooltip 里说清楚原因 —— 不猜、也不留白。
 */
export function readResourceType(m: unknown): GatherResourceType | null {
  if (!m || typeof m !== 'object') return null
  const v = (m as Record<string, unknown>).resourceType
  return isResourceType(v) ? v : null
}
