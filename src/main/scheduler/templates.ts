/**
 * 调度器用到的模板：两套编译产物 + 若干字形集，编译一次长期复用。
 *
 * 为什么要两套：
 *   · 界面模板（面板标题、状态词、图标）按 shrink=2 编译 —— 全屏 18ms→单键 1ms，够用且快；
 *   · 数字字形按 shrink=1 编译 —— 数字只有 18~25px 高，降采样后 1/7、3/8 会混。
 * matchIn 里有硬校验：tpl.shrink !== frame.shrink 直接抛 INVALID_ARGUMENT，
 * 所以两套帧、两套模板必须严格配对，不能混用。
 */

import { REF_WIDTH } from '@shared/constants'
import { AppError } from '@shared/errors'
import type { PreparedTemplate } from '@shared/vision'
import { listSets, loadPrepared } from '@vision/index'
import { buildGlyphSet, type GlyphSet } from './digits'

/** 目标游戏包名。模板集没显式指定时按它自动挑。 */
export const SAMO_PACKAGE = 'com.lilithgames.samo.android.cn'

// ── 界面模板 id（与 .wl-data 里已裁好的模板库一一对应，改名要同步改这里）──────

export const TPL = {
  /** 部队管理面板标题，判定面板是否已经打开。 */
  panelTitle: 'tpl_panel_title_troop',
  /** 面板表头的队列图标，右侧就是 N/M。 */
  queueIcon: 'tpl_queue_icon_panel',
  /**
   * 世界地图左下角的放大镜。
   * ★ 真机实测：它的镜片是**半透明**的，整块模板的分数会随镜片底下的地形漂移（草地 0.981，压着伐木场只有 0.794）。
   *   2026-09-10 起改为透明底模板（兽族 3 帧 + 法师 2 帧跨阵营差分去底，只留金属圈和手柄），
   *   两个阵营的地图上都稳定 0.96~0.98；但仍与回城按钮 A/B 组成 anyTemplate，不单独扛。
   */
  worldSearchIcon: 'tpl_world_search_icon',
  /** 世界地图左下角的回城城堡按钮 —— 不透明，实测稳定 0.985~0.987，是更可靠的世界地图判据。 */
  navCityToggle: 'tpl_nav_city_toggle',
  /** 城内左下角的地图按钮，用来从城内切回世界地图。 */
  navMapToggle: 'tpl_nav_map_toggle',
  /**
   * ★ 阵营变体 B（兽族）。游戏有三套 UI 美术：法师（主号，A）、兽族（huadong 小号，B）、精灵（暂不适配）。
   *   城内↔世界地图两态按钮每个阵营各一套，主号模板打在兽族号上只有 0.2~0.6，判据必须 anyTemplate。
   *   兽族城内按钮的圆环里透着会变的地形，所以它是**透明底**模板（多帧差分去底，vision/alpha.ts）。
   */
  navMapToggleB: 'tpl_nav_map_toggle_b',
  /** 世界地图回城按钮的兽族变体（主号模板打小号只有 0.20）。 */
  navCityToggleB: 'tpl_nav_city_toggle_b',
  /** 行内「坐标:」标签，既用于读坐标，也用于判断这一行到底有没有内容。 */
  coordLabel: 'tpl_label_coord_row',
  /**
   * 「采集中」行进度条左端菱形图标里的白镐。菱形描边是转圈高光动画，所以只框中间静止的镐。
   * 状态词「采集中」压在进度条上、会被绿灰边界盖字，这个图标是第二判据（anyTemplate）。
   */
  statusIconGathering: 'tpl_status_icon_gathering',
  /**
   * 行左侧目标资源点缩略图的模板 id 前缀：tpl_row_res_<wood|gold|iron|mana>[_变体]。
   * 采集中的行显示资源点，行军中/返回中的行显示部队图（认不出资源，靠派兵记账）。
   */
  rowResourcePrefix: 'tpl_row_res_',
  /** 指挥官耐力的水滴图标，右侧就是 105/105。 */
  staminaDrop: 'tpl_stamina_drop',
  /** 退出游戏确认框标题 —— 认出它只为了点「取消」，**绝不能点确定**。 */
  exitDialogTitle: 'tpl_dlg_title_notice',
  /** 对话框「取消」。 */
  btnCancel: 'tpl_btn_cancel',
  /**
   * 活动弹窗右上角的「×」。可选：认不出界面时先在右上半屏找它，找到就点，找不到才盲按 BACK。
   * 弹窗不可复现，模板要等它再出现时用面板裁（ID 填 tpl_btn_close_popup）。
   */
  btnClosePopup: 'tpl_btn_close_popup',
  /**
   * 世界地图右侧的「部队管理」入口图标。
   * ★ 它**只在有队伍在野外时才出现**：一支队都没派时右侧栏是空的，入口不存在。
   *   实测小号刚开号时采样器盲点 (2522,592) 三次无反应，被误判成「掉线」。
   *   所以在世界地图上必须先看它在不在：不在 ⇒ 判定 0 支队在外，直接返回空样本。
   */
  queueIconMap: 'tpl_queue_icon_map'
} as const

/**
 * 状态词模板 -> 语义。
 *
 * ★「采集中」为什么有两张：行在采集时会出现一条载重进度条，左段绿右段灰，
 *   边界随进度右移会先后盖过「采」「集」「中」。实测灰底模板打绿底行只有 0.864，
 *   所以必须两张一起做 anyTemplate，取分高的那张。
 * ★ tpl_status_marching 是上一轮遗留、语义存疑（59 帧 0 命中），**故意不列在这里**。
 */
export const STATUS_TEMPLATES = [
  { id: 'tpl_status_gathering', status: 'gathering', text: '采集中', onProgressBar: true },
  { id: 'tpl_status_gathering_green', status: 'gathering', text: '采集中', onProgressBar: true },
  {
    id: 'tpl_status_gather_marching',
    status: 'gatherMarching',
    text: '采集行军中',
    onProgressBar: false
  },
  { id: 'tpl_status_returning', status: 'returning', text: '返回中', onProgressBar: false }
] as const

export interface SchedulerTemplates {
  setId: string
  /** shrink=2，界面模板用。 */
  ui: Map<string, PreparedTemplate>
  /** shrink=1，数字字形用。 */
  digits: Map<string, PreparedTemplate>
  /** 通用深字浅底 21x29：队列 N/M、去程/返回倒计时、兵力。 */
  dark: GlyphSet
  /** 白字深底 16x25：采集中进度条上的倒计时。 */
  light: GlyphSet
  /** 坐标专用（浅底灰字 ~20x34）。2026-09-10 起 0-9 齐全（0、4 是从小号/huadong 的面板行补的）。 */
  coord: GlyphSet | null
  /** 指挥官耐力（白字蓝底带黑描边）。目前只有 0 1 5 /。 */
  stamina: GlyphSet | null
}

let cache: SchedulerTemplates | null = null
let cacheKey = ''

/** 模板库变了（重裁/换集）时调它，下次取用会重新编译。 */
export function invalidateTemplates(): void {
  cache = null
  cacheKey = ''
}

/** 按配置或包名挑出「万龙觉醒」那套模板集。 */
async function resolveSetId(preferred: string): Promise<string> {
  const sets = await listSets()
  if (preferred) {
    const hit = sets.find((s) => s.id === preferred)
    if (hit) return hit.id
    throw new AppError(
      'TEMPLATE_NOT_FOUND',
      `调度器配置里指定的模板集「${preferred}」不存在。\n` +
        `当前可用的模板集：${sets.map((s) => `${s.name}(${s.id})`).join('、') || '（一个都没有）'}。\n` +
        '请到「模板」页确认，或把调度配置里的 templateSetId 清空让它自动挑。',
      { preferred }
    )
  }
  const byPackage = sets.filter((s) => s.packageName === SAMO_PACKAGE)
  if (byPackage.length === 1) return byPackage[0].id
  if (byPackage.length > 1) {
    // 多套同包名时挑模板最多的那套（通常是一直在补的那一套）。
    return byPackage.sort((a, b) => b.templates.length - a.templates.length)[0].id
  }
  const byName = sets.find((s) => s.name.includes('万龙'))
  if (byName) return byName.id
  throw new AppError(
    'TEMPLATE_NOT_FOUND',
    '找不到《万龙觉醒》的模板集。\n' +
      `请先在「模板」页新建一个包名为 ${SAMO_PACKAGE} 的模板集并裁好部队管理面板的模板，` +
      '否则队列状态无法识别。',
    { sets: sets.map((s) => s.id) }
  )
}

/** 载入（并缓存）调度器要用的全部模板。 */
export async function getTemplates(opts: {
  templateSetId: string
  refWidth: number
}): Promise<SchedulerTemplates> {
  const key = `${opts.templateSetId}|${opts.refWidth}`
  if (cache && cacheKey === key) return cache

  const setId = await resolveSetId(opts.templateSetId)
  const refW = opts.refWidth > 0 ? opts.refWidth : REF_WIDTH

  // loadPrepared 对单个模板编译失败只 warn 跳过，所以 map.size 可能小于 manifest 条数，
  // 缺哪个由下面的 requireUi 逐个报出来，不要在这里笼统地判「数量不够」。
  const ui = await loadPrepared(setId, { refW, shrink: 2 })
  const digits = await loadPrepared(setId, { refW, shrink: 1 })

  const dark = buildGlyphSet('dig_dark20', '通用数字(浅底深字)', 'dark', digits)
  const light = buildGlyphSet('dig_light16', '进度条数字(深底白字)', 'light', digits)

  const built: SchedulerTemplates = {
    setId,
    ui,
    digits,
    dark,
    light,
    coord: tryBuild('dig_card_coord', '坐标数字', 'dark', digits),
    stamina: tryBuild('dig_stamina', '指挥官耐力数字', 'light', digits)
  }

  cache = built
  cacheKey = key
  return built
}

function tryBuild(
  prefix: string,
  label: string,
  polarity: 'dark' | 'light',
  tpls: Map<string, PreparedTemplate>
): GlyphSet | null {
  try {
    return buildGlyphSet(prefix, label, polarity, tpls)
  } catch {
    // 这两套是可选字段用的，缺了只影响坐标/耐力显示，不该拖垮整次采样。
    return null
  }
}

/** 取一个必需的界面模板；缺了就抛带修复建议的中文错误。 */
export function requireUi(t: SchedulerTemplates, id: string): PreparedTemplate {
  const tpl = t.ui.get(id)
  if (!tpl) {
    throw new AppError(
      'TEMPLATE_NOT_FOUND',
      `模板集「${t.setId}」里没有可用的模板「${id}」。\n` +
        '可能是它没被裁出来、图片文件丢了，或方差过低（std<12）被视觉层拒绝了。\n' +
        '请到「模板」页补裁这一张，否则部队管理面板读不出来。',
      { setId: t.setId, templateId: id }
    )
  }
  return tpl
}

/** 取一个可选的界面模板；缺了返回 null，由调用方降级处理。 */
export function optionalUi(t: SchedulerTemplates, id: string): PreparedTemplate | null {
  return t.ui.get(id) ?? null
}
