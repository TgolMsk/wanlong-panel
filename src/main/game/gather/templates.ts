/**
 * 自动采集用到的模板 id 常量与模板集加载。
 *
 * 一个模板集里同时住着两类模板，**编译时的 shrink 不同，绝不能混**：
 *   · 界面模板（tpl_*）：shrink=2，与运行期的 PreparedFrame 一致，走 matchIn。
 *   · 字形模板（dig_*）：shrink=1，走 matchAllInCrop + grayCropRef 裁出的 ROI 灰度块。
 * matchIn 会硬性拒绝 shrink 不一致的组合（src/vision/matcher.ts），所以这里分两档编译。
 *
 * 字形集靠 tags 归类：manifest 里每张字形模板都带 ['digit', '<字形集名>']，
 * 字符本身从 id 后缀取（`dig_dark20_7` -> '7'，`_colon` -> ':'）。
 */

import { DEFAULT_SHRINK, REF_WIDTH } from '@shared/constants'
import { AppError } from '@shared/errors'
import type { PreparedTemplate, TemplateSet } from '@shared/vision'
import { listSets, prepareTemplate, readSet, readTemplateImage, setTemplatesDir } from '@vision/index'
import type { Glyph, GlyphSet } from '../vision/digits'

/** 界面模板 id。改名前先确认模板库里也一起改了，两边对不上会在运行期报「模板不在模板集里」。 */
export const TPL = {
  /** 世界地图-放大镜：判定在世界地图 + 点它开搜索面板 */
  worldSearchIcon: 'tpl_world_search_icon',
  /** 城内-切到世界地图按钮 */
  navMapToggle: 'tpl_nav_map_toggle',
  /** 世界地图-回城内按钮 */
  navCityToggle: 'tpl_nav_city_toggle',

  /** ★搜索面板唯一锚点：面板随分类左右平移，所有按钮坐标都由它推 */
  btnSearch: 'tpl_btn_search',
  /** 搜索面板-等级标签（★随滑杆手柄移动，必须宽带 ROI 定位） */
  labelLevel: 'tpl_label_level',
  /** 搜索面板-自动按钮（黑暗灵部队页专属，用作「选错分类」的否定判据） */
  autoBtn: 'tpl_auto_btn',

  /** ★资源点卡片锚点 */
  btnGather: 'tpl_btn_gather',
  resWoodTitle: 'tpl_res_wood_title',
  resGoldTitle: 'tpl_res_gold_title',
  resIronTitle: 'tpl_res_iron_title',
  resManaTitle: 'tpl_res_mana_title',
  labelStorage: 'tpl_label_storage',
  labelGatherer: 'tpl_label_gatherer',
  labelAlliance: 'tpl_label_alliance',
  /** ★「无」：采集者是否空闲的核心判据，兼作所属联盟的中立判据 */
  valueNone: 'tpl_value_none',
  /** 本方联盟缩写（★按账号一张，公共模板集里通常没有，缺失时降级为「只接受中立」） */
  allianceOwn: 'tpl_alliance_own',
  labelAutoUntilEmpty: 'tpl_label_auto_until_empty',
  checkboxAutoOn: 'tpl_checkbox_auto_on',
  checkboxAutoOff: 'tpl_checkbox_auto_off',
  labelCoordCard: 'tpl_label_coord_card',

  btnCreateTroop: 'tpl_btn_create_troop',
  titleCreateTroop: 'tpl_title_create_troop',
  btnPresetGather: 'tpl_btn_preset_gather',
  /** ★创建部队页锚点：行军按钮，下方就是行军耗时 */
  btnMarch: 'tpl_btn_march',
  labelTroops: 'tpl_label_troops',
  labelLoad: 'tpl_label_load',

  panelTitleTroop: 'tpl_panel_title_troop',
  queueIconPanel: 'tpl_queue_icon_panel',
  /** 世界地图右侧的部队管理入口。★ 只在有队伍在野外时出现；不在 ⇒ 判定 0 支队在外，不要去点。 */
  queueIconMap: 'tpl_queue_icon_map',
  /**
   * ★ 阵营变体 B（兽族）。游戏有三套 UI 美术：法师（主号 A）、兽族（huadong 小号 B）、精灵（暂不适配）。
   *   城内↔世界地图两态按钮每个阵营各一套，主号模板打在兽族号上只有 0.2~0.6，判据必须 anyTemplate。
   *   世界地图回城按钮 B：主号模板打小号 0.20，2026-09-10 从小号帧裁出。
   */
  navCityToggleB: 'tpl_nav_city_toggle_b',
  /**
   * 城内切世界地图按钮 B（兽族）。圆环里透着城内地形、城一拖动就变，所以是**透明底**模板
   * （多帧差分去底，vision/alpha.ts）：整块匹配换个背景只有 0.79~0.89，掩码后 0.97~0.98。
   */
  navMapToggleB: 'tpl_nav_map_toggle_b',
  staminaDrop: 'tpl_stamina_drop',
  labelCoordRow: 'tpl_label_coord_row',
  statusGathering: 'tpl_status_gathering',
  statusGatheringGreen: 'tpl_status_gathering_green',
  statusGatherMarching: 'tpl_status_gather_marching',
  statusReturning: 'tpl_status_returning',

  btnBackGeneric: 'tpl_btn_back_generic',
  /**
   * 活动弹窗右上角的「×」（「光明精铸-自选宝物」这类带「前往」的推送弹窗）。可选：
   * 认不出界面时先在右上半屏找它，找到就点，找不到才盲按 BACK。
   * 弹窗不可复现，模板要等它再出现时用面板裁（ID 填 tpl_btn_close_popup，两帧去底更稳）。
   */
  btnClosePopup: 'tpl_btn_close_popup',
  dlgTitleNotice: 'tpl_dlg_title_notice',
  btnCancel: 'tpl_btn_cancel',
  btnConfirm: 'tpl_btn_confirm'
} as const

/** 字形集名。 */
export const GLYPH = {
  /** 通用深字浅底 21x29：卡片储量 / 队列 N/M / 行军·返回倒计时 / 兵力 / 负载量 */
  dark20: 'dig_dark20',
  /** 白字深底 16x25：部队管理「采集中」进度条上的倒计时（ETA 数据源） */
  light16: 'dig_light16',
  /** 搜索面板「等级 N」 */
  panelLevel: 'dig_panel_level',
  /** 卡片/行内坐标 */
  cardCoord: 'dig_card_coord',
  /** 行军按钮上的行军耗时（白字金底） */
  marchBtn: 'dig_march_btn',
  /** 指挥官耐力 N/M */
  stamina: 'dig_stamina',
  /** 卡片标题里的等级数字 */
  cardTitle: 'dig_card_title'
} as const

/**
 * 少了这几张，自动采集根本跑不起来（gather-templates.json 的 criticalPath）。
 * 加载时缺一张就直接报错，别等到跑到一半才在某个状态里失败。
 */
const CRITICAL_TEMPLATES: string[] = [
  TPL.worldSearchIcon,
  TPL.btnSearch,
  TPL.labelLevel,
  TPL.btnGather,
  TPL.valueNone,
  TPL.btnCreateTroop,
  TPL.btnMarch,
  TPL.panelTitleTroop,
  TPL.queueIconPanel
]

/** 缺了会明显降低容错、但还能跑的模板。加载时只告警。 */
const OPTIONAL_TEMPLATES: string[] = [
  TPL.navMapToggle,
  TPL.navMapToggleB,
  TPL.queueIconMap,
  TPL.navCityToggleB,
  TPL.autoBtn,
  TPL.labelAutoUntilEmpty,
  TPL.labelCoordCard,
  TPL.labelCoordRow,
  TPL.btnPresetGather,
  TPL.labelTroops,
  TPL.labelLoad,
  TPL.staminaDrop,
  TPL.statusGathering,
  TPL.statusGatheringGreen,
  TPL.statusGatherMarching,
  TPL.statusReturning,
  TPL.dlgTitleNotice,
  TPL.btnCancel,
  TPL.btnClosePopup,
  TPL.allianceOwn
]

/** id 后缀 -> 字符。数字直接用后缀本身。 */
const SUFFIX_TO_CHAR: Record<string, string> = {
  colon: ':',
  slash: '/',
  comma: ',',
  dot: '.',
  percent: '%'
}

export interface GatherTemplates {
  setId: string
  refWidth: number
  refHeight: number
  /** 界面模板（shrink=2）。 */
  ui: Map<string, PreparedTemplate>
  /** 字形集（shrink=1）。 */
  glyphSets: Map<string, GlyphSet>
  /** 编译失败或根本没裁的模板 id。 */
  missing: string[]
  /** 取界面模板，缺失时抛中文错误。 */
  require(id: string): PreparedTemplate
  /** 取界面模板，缺失返回 undefined（用于可选判据）。 */
  get(id: string): PreparedTemplate | undefined
  has(id: string): boolean
  /** 取字形集，缺失时抛中文错误。 */
  requireGlyphs(name: string): GlyphSet
  hasGlyphs(name: string): boolean
}

export interface LoadGatherTemplatesOptions {
  /** 模板集 id。不传则按包名自动找。 */
  setId?: string
  /** 模板库根目录。传了就先 setTemplatesDir（主进程里通常已经设过，可省略）。 */
  templatesDir?: string
  /** 按包名自动找模板集时用。 */
  packageName?: string
  /** 界面模板的降采样倍率，必须与运行期 PreparedFrame 一致。 */
  shrink?: number
  refWidth?: number
  /** 告警回调（模板编译失败 / 可选模板缺失）。 */
  onWarn?: (message: string, detail?: Record<string, unknown>) => void
}

/** 按包名找模板集。多个匹配时取模板数最多的那个。 */
export async function resolveGatherSetId(packageName: string): Promise<string> {
  const sets = await listSets()
  const hit = sets
    .filter((s) => s.packageName === packageName)
    .sort((a, b) => b.templates.length - a.templates.length)[0]
  if (!hit) {
    throw new AppError(
      'TEMPLATE_NOT_FOUND',
      `没有找到包名为「${packageName}」的模板集。请先在「模板」页新建模板集并裁出采集流程需要的模板。`,
      { packageName, available: sets.map((s) => ({ id: s.id, packageName: s.packageName })) }
    )
  }
  return hit.id
}

/**
 * 加载采集流程用到的全部模板：界面模板按 shrink=2 编译，字形模板按 shrink=1 编译。
 *
 * 单张模板编译失败只记进 missing 并告警（与 loadPrepared 的策略一致），
 * 但**关键模板缺失会直接抛错** —— 与其让流程跑到一半在某个状态里超时，不如启动时就说清楚缺什么。
 */
export async function loadGatherTemplates(
  opts: LoadGatherTemplatesOptions = {}
): Promise<GatherTemplates> {
  if (opts.templatesDir) setTemplatesDir(opts.templatesDir)

  const setId =
    opts.setId ??
    (await resolveGatherSetId(opts.packageName ?? 'com.lilithgames.samo.android.cn'))
  const set: TemplateSet = await readSet(setId)

  const refWidth = opts.refWidth ?? set.refWidth ?? REF_WIDTH
  const uiShrink = opts.shrink ?? DEFAULT_SHRINK

  const ui = new Map<string, PreparedTemplate>()
  const glyphBuckets = new Map<string, Glyph[]>()
  const missing: string[] = []

  for (const def of set.templates) {
    const glyphSetName = def.tags?.includes('digit')
      ? def.tags.find((t) => t !== 'digit')
      : undefined
    try {
      const png = await readTemplateImage(setId, def.id)
      const prepared = await prepareTemplate(png, {
        id: def.id,
        name: def.name,
        refW: refWidth,
        authoredWidth: def.authoredWidth,
        // ★字形一律 shrink=1，界面模板 shrink=2。
        shrink: glyphSetName ? 1 : uiShrink,
        threshold: def.threshold,
        defaultRoi: def.defaultRoi
      })
      if (glyphSetName) {
        const char = charOf(def.id, glyphSetName)
        if (!char) {
          opts.onWarn?.(`字形模板「${def.id}」的 id 后缀无法解析成字符，已跳过`, { id: def.id })
          continue
        }
        const bucket = glyphBuckets.get(glyphSetName) ?? []
        bucket.push({ char, tpl: prepared })
        glyphBuckets.set(glyphSetName, bucket)
      } else {
        ui.set(def.id, prepared)
      }
    } catch (e) {
      missing.push(def.id)
      opts.onWarn?.(`模板「${def.name}」(${def.id}) 编译失败，已跳过：${errMsg(e)}`, {
        templateId: def.id
      })
    }
  }

  const glyphSets = new Map<string, GlyphSet>()
  for (const [name, glyphs] of glyphBuckets) {
    glyphs.sort((a, b) => a.char.localeCompare(b.char))
    glyphSets.set(name, { name, glyphs, medianGlyphW: medianWidth(glyphs) })
  }

  const absentCritical = CRITICAL_TEMPLATES.filter((id) => !ui.has(id))
  if (absentCritical.length > 0) {
    throw new AppError(
      'TEMPLATE_NOT_FOUND',
      `模板集「${set.name}」缺少自动采集必需的模板：${absentCritical.join('、')}。` +
        '请先在「模板」页把它们裁出来（裁剪要点见 resources/game-data/gather-templates.json）。',
      { setId, missing: absentCritical }
    )
  }
  const absentOptional = OPTIONAL_TEMPLATES.filter((id) => !ui.has(id))
  if (absentOptional.length > 0) {
    missing.push(...absentOptional)
    opts.onWarn?.(
      `以下可选模板缺失，相关判据会降级（不影响主流程）：${absentOptional.join('、')}`,
      { setId, missing: absentOptional }
    )
  }

  return {
    setId,
    refWidth,
    refHeight: set.refHeight,
    ui,
    glyphSets,
    missing,
    require(id) {
      const t = ui.get(id)
      if (!t) {
        throw new AppError(
          'TEMPLATE_NOT_FOUND',
          `模板「${id}」不在已加载的模板集「${set.name}」里，无法继续。`,
          { setId, templateId: id }
        )
      }
      return t
    },
    get: (id) => ui.get(id),
    has: (id) => ui.has(id),
    requireGlyphs(name) {
      const g = glyphSets.get(name)
      if (!g || g.glyphs.length === 0) {
        throw new AppError(
          'TEMPLATE_NOT_FOUND',
          `字形集「${name}」不存在或为空，读不了对应的数字。请先裁出该套 0-9 字形。`,
          { setId, glyphSet: name }
        )
      }
      return g
    },
    hasGlyphs: (name) => (glyphSets.get(name)?.glyphs.length ?? 0) > 0
  }
}

function charOf(templateId: string, glyphSetName: string): string | null {
  const suffix = templateId.startsWith(`${glyphSetName}_`)
    ? templateId.slice(glyphSetName.length + 1)
    : templateId.split('_').pop()
  if (!suffix) return null
  if (SUFFIX_TO_CHAR[suffix]) return SUFFIX_TO_CHAR[suffix]
  if (/^[0-9]$/.test(suffix)) return suffix
  return null
}

function medianWidth(glyphs: Glyph[]): number {
  if (glyphs.length === 0) return 20
  const ws = glyphs.map((g) => g.tpl.refW).sort((a, b) => a - b)
  return ws[Math.floor(ws.length / 2)]
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
