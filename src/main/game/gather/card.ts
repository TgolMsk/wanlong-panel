/**
 * G8/G9：资源点卡片的读取、校验，以及「自动采集至清空」的对账。
 *
 * ★★★ 全流程最容易写错的一行就在本文件的 validateCard 里：
 *
 *      卡片等级判据必须是  cardLevel >= searchFloor      ← 正确
 *      绝不能写成          cardLevel === searchFloor     ← bug
 *
 *   游戏搜索的规则是「返回等级 >= 搜索等级的资源点」。真机实测：伐木场把搜索值调到 1，
 *   连续搜 6 次返回的点等级是 8,7,7,7,7,8，**没有一次等于搜索值**。
 *   写成 `==` 会把这 6 次全判成失败，occupiedFails 迅速打满，下限一路放宽到 minLevel 后放弃，
 *   外部表现就是「一直在搜、永远不派兵」。
 *   「等级高于下限」是**更好**的结果，既不构成拒绝理由，也**不计入 occupiedFails**。
 */

import type { Point, Rect } from '@shared/vision'
import { parseCoord, parseGrouped, parseLevel } from '../vision/digits'
import type { GatherConfig, GatherResourceType, ResourceEntry } from './config'
import { RESOURCE_LABEL, effectiveMinStorage } from './config'
import {
  CARD,
  CARD_LEVEL_ROI_NARROW,
  COORD_MIN_SCORE,
  CARD_LEVEL_ROI_WIDE,
  CHECKBOX_PROBE_REL_LABEL,
  CHECKBOX_RULE,
  coordRoiRightOf,
  offsetPoint,
  offsetRect
} from './geometry'
import type { GatherSession } from './session'
import { GLYPH, TPL } from './templates'

/** 资源类型 -> 卡片标题模板 id。 */
const TITLE_TEMPLATE: Record<GatherResourceType, string> = {
  wood: TPL.resWoodTitle,
  gold: TPL.resGoldTitle,
  iron: TPL.resIronTitle,
  mana: TPL.resManaTitle
}
const TYPE_BY_TITLE: Record<string, GatherResourceType> = {
  [TPL.resWoodTitle]: 'wood',
  [TPL.resGoldTitle]: 'gold',
  [TPL.resIronTitle]: 'iron',
  [TPL.resManaTitle]: 'mana'
}

/** 所属联盟三态。 */
export type AllianceState = 'own' | 'neutral' | 'foreign' | 'unknown'

export interface CardReading {
  /** 采集按钮命中中心 —— 卡片上其它一切位置的锚点。 */
  anchor: Point
  resource: GatherResourceType | null
  /** 卡片上的资源点等级。读不出为 null。 */
  level: number | null
  storage: number | null
  /** 采集者是否为「无」。null = 判据不可用（模板缺失）。 */
  gathererFree: boolean | null
  alliance: AllianceState
  coord: string | null
  /** 「自动采集至清空」的实际勾选态。null = 读不出。 */
  autoChecked: boolean | null
}

/** 等卡片出现（点完搜索之后）。超时返回 null —— 多半是没搜到点。 */
export async function waitForCard(s: GatherSession, waitMs = 8000): Promise<Point | null> {
  const hit = await s.waitFor(TPL.btnGather, {
    roi: CARD.anchorRoi,
    waitMs,
    pollMs: 700
  })
  if (!hit) return null
  return { x: hit.match.centerX, y: hit.match.centerY }
}

/**
 * G8：一帧多 ROI，把卡片上要用的字段一次读齐。
 *
 * @param needAlliance 联盟策略为 any 时可以省掉一次匹配
 */
export async function readCard(
  s: GatherSession,
  anchor: Point,
  needAlliance: boolean
): Promise<CardReading> {
  // ① 资源类型：在标题横带里比四个资源名模板，取分数最高的。
  const titleIds = Object.values(TITLE_TEMPLATE)
  const titleBand = offsetRect(anchor, CARD.titleBandRoi)
  const titleHit = await s.bestOf(titleIds, titleBand)
  const resource = titleHit ? TYPE_BY_TITLE[titleHit.id] ?? null : null

  // ② 等级：★必须以资源名模板的命中框为锚往左反推 —— 标题「等级N 资源名」整体居中，
  //    等级变两位数时整行会左移，固定 ROI 会框空。
  let level: number | null = null
  if (titleHit) {
    const titleId = titleHit.id
    level = await s.readNumberField<number>({
      field: '卡片资源点等级',
      glyphSet: GLYPH.cardTitle,
      tries: 2,
      resolveRoi: async () => roiForCardLevel(s, titleId, titleBand, CARD_LEVEL_ROI_NARROW),
      parse: (t) => parseLevel(t, 30)
    })
    if (level === null) {
      // 一位数框没读到，可能是两位数（10+）导致整行左移，用宽框再试一次。
      level = await s.readNumberField<number>({
        field: '卡片资源点等级（两位数兼容）',
        glyphSet: GLYPH.cardTitle,
        tries: 1,
        resolveRoi: async () => roiForCardLevel(s, titleId, titleBand, CARD_LEVEL_ROI_WIDE),
        parse: (t) => parseLevel(t, 30)
      })
    }
  }

  // ③ 储量。
  const storage = await s.readNumberField<number>({
    field: '卡片储量',
    glyphSet: GLYPH.dark20,
    tries: 2,
    resolveRoi: async () => offsetRect(anchor, CARD.storageValueRoi),
    parse: parseGrouped
  })

  // ④ 采集者 == 无？整词模板判定，不做字符识别。
  let gathererFree: boolean | null = null
  const noneTpl = s.templates.get(TPL.valueNone)
  if (noneTpl) {
    const m = await s.matchOptional(TPL.valueNone, offsetRect(anchor, CARD.gathererValueRoi))
    gathererFree = Boolean(m?.found)
  }

  // ⑤ 所属联盟三态。
  let alliance: AllianceState = 'unknown'
  if (needAlliance) {
    const allianceRoi = offsetRect(anchor, CARD.allianceValueRoi)
    const neutral = await s.matchOptional(TPL.valueNone, allianceRoi)
    if (neutral?.found) {
      alliance = 'neutral'
    } else if (s.templates.has(TPL.allianceOwn)) {
      const own = await s.matchOptional(TPL.allianceOwn, allianceRoi)
      alliance = own?.found ? 'own' : 'foreign'
    } else {
      // 本方联盟模板没裁 —— 分不清「本方」和「他方」，一律按他方处理（宁可少采，也不把队伍派进敌方领地）。
      alliance = 'foreign'
    }
  }

  // ⑥ 坐标（用于目标去重）。有「坐标:」标签就以它为锚，否则用相对采集按钮的偏移。
  const coordLabel = await s.matchOptional(TPL.labelCoordCard)
  const coord = await s.readNumberField<string>({
    field: '卡片坐标',
    glyphSet: GLYPH.cardCoord,
    tries: 1,
    resolveRoi: async () =>
      coordLabel && coordLabel.found
        ? coordRoiRightOf(coordLabel)
        : offsetRect(anchor, CARD.coordValueRoi),
    parse: parseCoord,
    minScore: COORD_MIN_SCORE
  })

  // ⑦ 「自动采集至清空」的实际勾选态（像素取色，必须用彩色）。
  const autoChecked = await readAutoCheckbox(s, anchor)

  const reading: CardReading = {
    anchor,
    resource,
    level,
    storage,
    gathererFree,
    alliance,
    coord,
    autoChecked
  }
  s.log('info', describeCard(reading))
  return reading
}

function describeCard(c: CardReading): string {
  const name = c.resource ? RESOURCE_LABEL[c.resource].category : '未知资源'
  return (
    `资源点卡片：${name} 等级${c.level ?? '?'}，储量 ${c.storage?.toLocaleString('zh-CN') ?? '?'}，` +
    `采集者${c.gathererFree === null ? '未知' : c.gathererFree ? '无' : '已被占用'}，` +
    `联盟 ${allianceLabel(c.alliance)}，坐标 ${c.coord ?? '?'}`
  )
}

function allianceLabel(a: AllianceState): string {
  return a === 'own' ? '本方' : a === 'neutral' ? '中立' : a === 'foreign' ? '他方' : '未知'
}

/** 等级数字 ROI：相对资源名模板的命中框。每次重试都重新匹配一次标题，防止卡片轻微漂移。 */
async function roiForCardLevel(
  s: GatherSession,
  titleId: string,
  titleBand: Rect,
  off: Rect
): Promise<Rect | null> {
  const m = await s.matchOptional(titleId, titleBand)
  if (!m || !m.found) return null
  return { x: m.x + off.x, y: m.y + off.y, w: off.w, h: off.h }
}

// ── G9：「自动采集至清空」对账 ────────────────────────────────────────────

/** 勾选框探针点：优先以「自动采集至清空」文字为锚（勾选框是实心圆，std 不达标，不能用模板匹配它本身）。 */
async function checkboxProbePoint(s: GatherSession, anchor: Point): Promise<Point> {
  const label = await s.matchOptional(TPL.labelAutoUntilEmpty, offsetRect(anchor, CARD.autoLabelRoi))
  if (label && label.found) {
    return { x: label.x + CHECKBOX_PROBE_REL_LABEL.x, y: label.y + CHECKBOX_PROBE_REL_LABEL.y }
  }
  return offsetPoint(anchor, CARD.autoCheckboxFallback)
}

/** 读「自动采集至清空」的实际勾选态。读不出（颜色两边都不像）返回 null。 */
export async function readAutoCheckbox(
  s: GatherSession,
  anchor: Point
): Promise<boolean | null> {
  const at = await checkboxProbePoint(s, anchor)
  const rgb = await s.sample(at, 3)
  if (CHECKBOX_RULE.isOn(rgb)) return true
  if (CHECKBOX_RULE.isOff(rgb)) return false
  s.warn(
    `「自动采集至清空」勾选框取色 (${rgb.r},${rgb.g},${rgb.b}) 既不像已勾选(255,255,103)也不像未勾选(83,83,83)，` +
      '本次按「读不出」处理，不做点击。',
    { probeAt: at, rgb }
  )
  return null
}

/**
 * G9：对账「自动采集至清空」——读实际态 -> 只在不一致时点一下 -> 复验。
 * **禁止盲点**：盲点会把已经正确的状态点反。
 *
 * @returns 是否达成期望态
 */
export async function reconcileAutoGather(
  s: GatherSession,
  anchor: Point,
  desired: boolean
): Promise<boolean> {
  const actual = await readAutoCheckbox(s, anchor)
  if (actual === null) {
    s.warn('「自动采集至清空」当前态读不出，跳过对账（只读不点，避免把状态点反）。')
    return false
  }
  if (actual === desired) {
    s.log('debug', `「自动采集至清空」已是${desired ? '已勾选' : '未勾选'}，无需操作。`)
    return true
  }

  const at = await checkboxProbePoint(s, anchor)
  s.log('info', `「自动采集至清空」当前${actual ? '已勾选' : '未勾选'}，与配置不一致，点一下切换。`)
  await s.tapAt(at, 700)

  const after = await readAutoCheckbox(s, anchor)
  if (after === desired) return true

  s.warn(
    `「自动采集至清空」点击后复验仍不是期望的${desired ? '已勾选' : '未勾选'}（复验读到 ${after === null ? '读不出' : after ? '已勾选' : '未勾选'}）。` +
      '按配置的 abortOnReconcileFail 处理，不再重复点击。'
  )
  return false
}

// ── G8：校验 ──────────────────────────────────────────────────────────────

export type CardVerdict =
  /** 通过，可以派兵 */
  | { ok: true }
  /** 换一个点（重搜）。计入 occupiedFails。 */
  | { ok: false; kind: 'retrySearch'; reason: string }
  /** 分类选错了，回 G4 重选分类。不计入 occupiedFails。 */
  | { ok: false; kind: 'wrongCategory'; reason: string }
  /** 中止本轮。 */
  | { ok: false; kind: 'abort'; reason: string }

/**
 * 校验卡片是否可以派兵。
 *
 * @param searchFloor 本轮的搜索**下限**
 * @param busyCoords  在途队伍的目标坐标（去重用）
 */
export function validateCard(
  cfg: GatherConfig,
  entry: ResourceEntry,
  card: CardReading,
  searchFloor: number,
  busyCoords: Set<string>
): CardVerdict {
  // ① 资源类型必须对得上，否则说明分类选错了。
  if (card.resource === null) {
    return {
      ok: false,
      kind: 'retrySearch',
      reason: '认不出卡片上的资源类型（四个资源名模板都没命中），换一个点。'
    }
  }
  if (card.resource !== entry.type) {
    return {
      ok: false,
      kind: 'wrongCategory',
      reason:
        `卡片上是「${RESOURCE_LABEL[card.resource].category}」，` +
        `但本轮要采的是「${RESOURCE_LABEL[entry.type].category}」，说明分类选错了。`
    }
  }

  // ② 等级。★★ 判据是 >=，不是 ==。见文件头。
  if (card.level === null) {
    if (cfg.safety.onUnknownLevel === 'abort') {
      return {
        ok: false,
        kind: 'abort',
        reason:
          '读不出卡片上的资源点等级，且 safety.onUnknownLevel = abort，本轮中止。' +
          '（若字形集 dig_card_title 尚未补齐 0-9，可把该项改为 acceptCard：' +
          '游戏只会返回等级 >= 搜索下限的点，读不出等级时按满足下限处理是安全的。）'
      }
    }
    // acceptCard：游戏保证返回的点满足下限，读不出就按满足处理，继续走其余校验。
  } else if (card.level < searchFloor) {
    // 理论上不会发生（游戏只返回 >= 下限的点）。真发生了说明滑杆没设对或等级识别错了。
    return {
      ok: false,
      kind: 'retrySearch',
      reason:
        `卡片等级 ${card.level} 低于搜索下限 ${searchFloor}，这不符合游戏行为，` +
        '多半是滑杆没设对或等级数字识别错了。换点重搜并留痕。'
    }
  }
  // ★ 注意这里没有、也不该有任何「等级高于下限就拒绝」的分支：等级越高收益越好。

  // ③ 采集者必须是「无」。
  if (cfg.thresholds.requireGathererNone) {
    if (card.gathererFree === null) {
      return {
        ok: false,
        kind: 'retrySearch',
        reason: '判不了「采集者」是否为无（tpl_value_none 模板缺失），保守起见换一个点。'
      }
    }
    if (!card.gathererFree) {
      return { ok: false, kind: 'retrySearch', reason: '该资源点已被别人采集（采集者不是「无」）。' }
    }
  }

  // ④ 储量。
  const minStorage = effectiveMinStorage(cfg, entry)
  if (minStorage > 0) {
    if (card.storage === null) {
      if (cfg.safety.onUnknownStorage === 'skipPoint') {
        return { ok: false, kind: 'retrySearch', reason: '读不出储量，按不达标处理，换一个点。' }
      }
    } else if (card.storage < minStorage) {
      return {
        ok: false,
        kind: 'retrySearch',
        reason: `储量 ${card.storage.toLocaleString('zh-CN')} 低于下限 ${minStorage.toLocaleString('zh-CN')}。`
      }
    }
  }

  // ⑤ 所属联盟。
  const policy = cfg.thresholds.allianceTerritory
  if (policy !== 'any') {
    const allowed =
      policy === 'own-only'
        ? card.alliance === 'own'
        : card.alliance === 'own' || card.alliance === 'neutral'
    if (!allowed) {
      return {
        ok: false,
        kind: 'retrySearch',
        reason: `所属联盟为「${allianceLabel(card.alliance)}」，不符合策略「${policy}」。`
      }
    }
  }

  // ⑥ 目标去重。
  if (cfg.queuePlan.avoidDuplicateTarget && card.coord && busyCoords.has(card.coord)) {
    return {
      ok: false,
      kind: 'retrySearch',
      reason: `坐标 ${card.coord} 已经有己方队伍在采，换一个点。`
    }
  }

  return { ok: true }
}
