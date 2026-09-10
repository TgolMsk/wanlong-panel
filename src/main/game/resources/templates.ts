/**
 * 资源统计表用到的模板 id、单位字（亿/万）的 shrink=1 加载，以及把截图裁成模板入库的 seed 工具。
 *
 * 模板分三类，编译倍率不同，**绝不能混**：
 *   · 界面模板 tpl_*（弹窗标题、资源统计按钮、关闭 X、行标签、导航「道具」）：
 *     跟其它采集模板一样由 loadGatherTemplates 按 shrink=2 编入 ui 表，走 GatherSession.matchOptional。
 *   · 字形 dig_resstat_<0-9|dot|comma>（tags ['digit','dig_resstat']）：
 *     loadGatherTemplates 按 shrink=1 编成字形集 `dig_resstat`，走 readDigits。
 *   · 单位字 tpl_resstat_unit_yi / tpl_resstat_unit_wan（tags ['resstat_unit']，★没有 digit 标签）：
 *     loadGatherTemplates 会把它们当界面模板按 shrink=2 编一份（无害），但读表要的是**像素级**的 x 落点
 *     （数字 ROI 的右边界 = 单位字左边界），所以本模块自己再按 shrink=1 编一份并缓存。
 *     ★ 为什么单位字不进字形集：readDigits 是逐字形多峰匹配，「亿」的亻/乙两部分会被当成 1 或小数点的候选；
 *       用整字 matchIn 定位再把它切出 ROI 之外，是离线验证 8/8 读对的关键（见 resource-stats.json 的 segmentationHazard）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REF_HEIGHT, REF_WIDTH } from '@shared/constants'
import { AppError } from '@shared/errors'
import type { PreparedTemplate, Rect } from '@shared/vision'
import { prepareTemplate, readSet, readTemplateImage, saveTemplate, setTemplatesDir } from '@vision/index'
import { invalidateGatherTemplates } from '@main/game/gatherRunner'
import { GAME_PACKAGE } from '@main/game/gather/geometry'
import { resolveGatherSetId } from '@main/game/gather/templates'
import { invalidateTemplates } from '@main/scheduler/templates'

/** 界面模板 id。改名前先确认模板库与 resources/game-data/resource-stats.json 一起改。 */
export const RES_TPL = {
  /** 资源页右上「资源统计」按钮（必需：判定道具页已开 + 点击点） */
  btnResStats: 'tpl_btn_res_stats',
  /** 资源统计弹窗标题（必需：判定弹窗已开 / 已关） */
  titleResStats: 'tpl_title_res_stats',
  /** 弹窗右上关闭 X（可选：BACK 失效时的兜底） */
  btnCloseResStats: 'tpl_btn_close_res_stats',
  /** 道具页左上标题「资源」（可选） */
  titleItemsRes: 'tpl_title_items_res',
  /** 单位「亿」（shrink=1 单独编译，见文件头） */
  unitYi: 'tpl_resstat_unit_yi',
  /** 单位「万」（★现有截图里没有，待真机补裁） */
  unitWan: 'tpl_resstat_unit_wan',
  /** 世界地图底部导航「道具」（可选：缺失时按固定坐标点） */
  navItems: 'tpl_nav_items'
} as const

/** 行标签模板（可选：存在时顺手校验行序）。 */
export const RES_LABEL_TPL: Record<'gold' | 'wood' | 'iron' | 'mana', string> = {
  gold: 'tpl_label_res_gold',
  wood: 'tpl_label_res_wood',
  iron: 'tpl_label_res_iron',
  mana: 'tpl_label_res_mana'
}

/** 字形集名（loadGatherTemplates 按 tags 里的这个名字归类）。 */
export const RES_GLYPH = 'dig_resstat'

/** 单位字 → 字符。 */
export const RES_UNIT_CHAR: Record<string, '亿' | '万'> = {
  [RES_TPL.unitYi]: '亿',
  [RES_TPL.unitWan]: '万'
}

// ── 单位字（shrink=1）加载 ─────────────────────────────────────────────────

export interface ResourceUnitTemplates {
  setId: string
  /** id -> shrink=1 的模板；缺失的 id 不在表里。 */
  units: Map<string, PreparedTemplate>
  /** 缺失的单位字 id（中文说明用）。 */
  missing: string[]
}

let unitCache: ResourceUnitTemplates | null = null

/**
 * 按 shrink=1 编译单位字模板（只编这两张，不像 loadPrepared 那样把整集 95 张都编一遍）。
 * 缺失的单位字只记进 missing，不抛 —— 「万」在现有截图里本来就没有。
 */
export async function loadResourceUnitTemplates(
  setId: string,
  refWidth = REF_WIDTH
): Promise<ResourceUnitTemplates> {
  if (unitCache && unitCache.setId === setId) return unitCache
  const set = await readSet(setId)
  const units = new Map<string, PreparedTemplate>()
  const missing: string[] = []
  for (const id of [RES_TPL.unitYi, RES_TPL.unitWan]) {
    const def = set.templates.find((t) => t.id === id)
    if (!def) {
      missing.push(id)
      continue
    }
    try {
      const png = await readTemplateImage(setId, id)
      units.set(
        id,
        await prepareTemplate(png, {
          id,
          name: def.name,
          refW: refWidth,
          authoredWidth: def.authoredWidth,
          shrink: 1,
          threshold: def.threshold
        })
      )
    } catch (e) {
      missing.push(id)
      console.warn(`[resources] 单位字模板「${id}」编译失败，已跳过：${errMsg(e)}`)
    }
  }
  unitCache = { setId, units, missing }
  return unitCache
}

/** 模板库变了（重裁 / seed）时调一次。 */
export function invalidateResourceUnitTemplates(): void {
  unitCache = null
}

// ── seed：把截图按 json 的 bounds 裁成模板入库 ───────────────────────────

interface SpecTemplate {
  id: string
  name: string
  shot?: string | null
  status?: string
  bounds?: Rect
  roi?: Rect
  tags?: string[]
  purpose?: string
  cropNote?: string
  note?: string
}

interface SpecGlyph {
  char: string
  id: string
  shot?: string | null
  status?: string
  bounds?: Rect
  from?: string
  note?: string
}

interface ResourceStatsSpec {
  refWidth: number
  refHeight: number
  templates: SpecTemplate[]
  glyphs: { setName: string; tags: string[]; items: SpecGlyph[] }
}

export interface SeedResourceTemplatesOptions {
  /** 模板库根目录（会 setTemplatesDir）。 */
  templatesDir: string
  /** 目标模板集。不传则按包名挑「万龙觉醒」集。 */
  setId?: string
  /** 截图目录（docs/game/shots/resources）。 */
  shotsDir: string
  /** resource-stats.json 路径。不传则取 <cwd>/resources/game-data/resource-stats.json。 */
  specFile?: string
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
}

/**
 * 按 resource-stats.json 把 docs/game/shots/resources/*.png 裁成模板，走 saveTemplate 正式通道入库
 * （同 id 覆盖，幂等；std<12 守卫由 saveTemplate 负责）。json 里标 missing 的条目跳过并记进 skipped。
 * 完成后把三处模板缓存全部作废。
 */
export async function seedResourceTemplates(
  opts: SeedResourceTemplatesOptions
): Promise<{ setId: string; saved: string[]; skipped: string[] }> {
  setTemplatesDir(opts.templatesDir)
  const setId = opts.setId ?? (await resolveGatherSetId(GAME_PACKAGE))
  const specFile = opts.specFile ?? join(process.cwd(), 'resources', 'game-data', 'resource-stats.json')
  let spec: ResourceStatsSpec
  try {
    spec = JSON.parse(await readFile(specFile, 'utf8')) as ResourceStatsSpec
  } catch (e) {
    throw new AppError('IO_ERROR', `读取资源统计规格 ${specFile} 失败：${errMsg(e)}`, { specFile })
  }
  const authoredWidth = spec.refWidth || REF_WIDTH
  const authoredHeight = spec.refHeight || REF_HEIGHT

  const shotCache = new Map<string, ArrayBuffer>()
  const shotBytes = async (name: string): Promise<ArrayBuffer> => {
    const hit = shotCache.get(name)
    if (hit) return hit
    const file = join(opts.shotsDir, name)
    let buf: Buffer
    try {
      buf = await readFile(file)
    } catch (e) {
      throw new AppError('IO_ERROR', `读取截图 ${file} 失败：${errMsg(e)}`, { file })
    }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    shotCache.set(name, ab)
    return ab
  }

  const saved: string[] = []
  const skipped: string[] = []

  for (const t of spec.templates) {
    if (t.status === 'missing' || !t.shot || !t.bounds) {
      skipped.push(t.id)
      opts.log('warn', `模板「${t.id}」在现有截图里没有素材，跳过（${t.note ?? '待真机补裁'}）`)
      continue
    }
    await saveTemplate(setId, {
      id: t.id,
      name: t.name,
      image: await shotBytes(t.shot),
      authoredWidth,
      authoredHeight,
      crop: t.bounds,
      defaultRoi: t.roi,
      tags: t.tags,
      note: [t.purpose, t.cropNote].filter(Boolean).join(' ') || undefined
    })
    saved.push(t.id)
    opts.log('info', `模板「${t.id}」已入库（${t.shot} ${JSON.stringify(t.bounds)}）`)
  }

  for (const g of spec.glyphs.items) {
    if (g.status === 'missing' || !g.shot || !g.bounds) {
      skipped.push(g.id)
      opts.log('warn', `字形「${g.id}」(${g.char}) 在现有截图里没有素材，跳过（${g.note ?? '待真机补裁'}）`)
      continue
    }
    await saveTemplate(setId, {
      id: g.id,
      name: `资源统计数字-${g.char}`,
      image: await shotBytes(g.shot),
      authoredWidth,
      authoredHeight,
      crop: g.bounds,
      tags: spec.glyphs.tags,
      note: `资源统计表数字（浅底黑字，shrink=1）。来源：${g.from ?? g.shot}`
    })
    saved.push(g.id)
    opts.log('info', `字形「${g.id}」(${g.char}) 已入库`)
  }

  invalidateGatherTemplates()
  invalidateTemplates()
  invalidateResourceUnitTemplates()
  return { setId, saved, skipped }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
