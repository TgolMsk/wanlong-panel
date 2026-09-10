/**
 * G0：把游戏拉回「世界地图」这个已知状态，以及关闭各种面板的通用手法。
 *
 * ★ 世界地图上按 BACK 会弹「确定要退出游戏吗」，误点确定就直接退出游戏了。
 *   所以关面板一律优先「点面板外的空地」或「点左上角返回箭头」，
 *   只有在确实认不出当前界面时才盲按一次 BACK，并且**紧接着必须检查并取消退出确认框**。
 */

import { AppError } from '@shared/errors'
import type { Point } from '@shared/vision'
import { CARD, FIXED_TAP, GAME_PACKAGE, POPUP_CLOSE_ROI, offsetPoint } from './geometry'
import type { GatherSession } from './session'
import { TPL } from './templates'

/** 「取消」按钮的兜底坐标（模板缺失时用）。实测按钮墨迹 1488..1608 / 940..1000。 */
const CANCEL_FALLBACK: Point = { x: 1548, y: 970 }
/** 创建部队页左上角返回箭头的兜底坐标。 */
const BACK_ARROW_FALLBACK: Point = { x: 55, y: 68 }

/**
 * 如果屏幕上是「注意 / 确定要退出游戏吗」这类确认框，点「取消」把它关掉。
 * @returns 是否处理了一个对话框
 */
export async function dismissNoticeDialog(s: GatherSession): Promise<boolean> {
  const notice = await s.matchOptional(TPL.dlgTitleNotice)
  if (!notice || !notice.found) return false

  s.log('warn', '检测到确认框（多半是刚才那次 BACK 触发的「退出游戏」提示），点「取消」关闭。')
  const cancel = await s.matchOptional(TPL.btnCancel)
  const at =
    cancel && cancel.found ? { x: cancel.centerX, y: cancel.centerY } : CANCEL_FALLBACK
  // ★ 绝不点「确定」：那会退出游戏。
  await s.tapAt(at, 900)
  return true
}

/**
 * 活动弹窗（带「前往」和右上角 ×）盖住主界面时，点 × 关掉它。
 * 只在右上半屏找 tpl_btn_close_popup；模板缺失或没命中返回 false（由调用方退回盲按 BACK）。
 */
export async function dismissPopupByClose(s: GatherSession): Promise<boolean> {
  const x = await s.matchOptional(TPL.btnClosePopup, POPUP_CLOSE_ROI)
  if (!x || !x.found) return false
  s.log('info', `右上角有弹窗关闭按钮（${x.score}），点它关掉活动弹窗。`)
  await s.tapAt({ x: x.centerX, y: x.centerY }, 900)
  return true
}

/** 关掉资源点卡片：点卡片外的空地（比 BACK 安全）。 */
export async function closeResourceCard(s: GatherSession): Promise<void> {
  const gather = await s.matchOptional(TPL.btnGather, CARD.anchorRoi)
  if (gather && gather.found) {
    const outside = offsetPoint({ x: gather.centerX, y: gather.centerY }, CARD.closeByTapOutside)
    await s.tapAt(clampToScreen(s, outside), 700)
    return
  }
  await s.tapAt(FIXED_TAP.emptyArea, 700)
}

/** 关掉「部队管理」面板：这是个二级面板，BACK 能关，关完确认已回到世界地图。 */
export async function closeTroopPanel(s: GatherSession): Promise<void> {
  const title = await s.matchOptional(TPL.panelTitleTroop, undefined)
  if (!title || !title.found) return
  await s.key('BACK', 800)
  await dismissNoticeDialog(s)
}

/** 从「创建部队」页退回去（左上角返回箭头）。 */
export async function leaveCreateTroopPage(s: GatherSession): Promise<void> {
  const back = await s.matchOptional(TPL.btnBackGeneric)
  const at = back && back.found ? { x: back.centerX, y: back.centerY } : BACK_ARROW_FALLBACK
  await s.tapAt(at, 900)
}

/**
 * 「当前是不是世界地图」的判据模板集合（anyTemplate）。
 *
 * ★★ 真机实测纠正（2026-09-09）：**不能只用放大镜**。
 *    `tpl_world_search_icon` 的镜片是**半透明**的，透出来的是它底下的地图地形，
 *    所以同一个图标在不同地形上分数会大幅漂移：草地上 0.981，图标底下压着一座伐木场时只有 0.794
 *    （峰值位置仍是精确的 (95,1109)，位置没错、只是相似度被地形拉低了）。
 *    症状极其难查：流程会在一块「明明就是世界地图」的画面上连按 6 次 BACK，
 *    每按一次弹一个「确定要退出游戏吗」，靠 dismissNoticeDialog 一次次取消，最后报 G0 失败。
 *    留痕证据：docs/live/003-g0-unknown-2.jpg ~ 007-g0-unknown-6.jpg（全是干净的世界地图）。
 *
 *    `tpl_nav_city_toggle`（左下角回城的城堡按钮）是**不透明**的，同一批帧上稳定 0.985~0.987，
 *    而且它只在世界地图出现（城内是 tpl_nav_map_toggle），判别力一样强。
 *    两张组成 anyTemplate 之后，地形再怎么变也至少有一张顶得住。
 */
export const WORLD_MAP_TEMPLATES = [TPL.navCityToggle, TPL.navCityToggleB, TPL.worldSearchIcon]

/**
 * 「当前是不是城内」的判据模板集合（anyTemplate）。
 *
 * ★ 阵营变体（2026-09-10）：游戏有三套 UI 美术 —— 法师（主号，变体 A）、兽族（huadong 小号，变体 B）、
 *   精灵（暂不适配）。城内左下角的「切世界地图」按钮两套阵营长得完全不一样，只认 A 的话
 *   兽族号一进城内就「认不出界面」，采样连续失败。B 是透明底模板（圆环里透着会变的地形）。
 *   ⚠️ 以后每接一个新阵营的号，这里和 WORLD_MAP_TEMPLATES 都要补一张变体。
 */
export const CITY_TEMPLATES = [TPL.navMapToggle, TPL.navMapToggleB]

/**
 * G0：确保游戏在前台，且当前处于世界地图。
 *
 * @throws AppError 尝试若干次仍回不到世界地图
 */
export async function ensureWorldMap(s: GatherSession, maxAttempts = 6): Promise<void> {
  // ① 前台包名。不是游戏就拉起来（热启动，不 force-stop 用户正在用的游戏）。
  const fg = await s.io.foregroundPackage()
  if (fg !== GAME_PACKAGE) {
    s.log('info', `当前前台是「${fg ?? '未知'}」，不是万龙觉醒，正在拉起游戏……`)
    await s.io.launchApp(GAME_PACKAGE, false)
    s.invalidate()
    // 冷/热启动都给足时间：热启动通常 3~5s，刚被系统回收过则要十几秒。
    const back = await s.waitFor(WORLD_MAP_TEMPLATES, { waitMs: 60_000, pollMs: 2000 })
    if (back) {
      s.log('info', '游戏已回到世界地图。')
      return
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    s.ensureAlive()
    s.invalidate()

    // 已经在世界地图。
    // ★ 注意：资源点卡片只是压在地图上的气泡，这两个判据仍然可见（离线回放实测 12 帧都是如此），
    //   所以这里还要顺手把残留的卡片关掉，否则「回到世界地图」只是看起来干净。
    const hit = await s.bestOf(WORLD_MAP_TEMPLATES)
    const map = hit?.match
    if (map && map.found) {
      const leftover = await s.matchOptional(TPL.btnGather, CARD.anchorRoi)
      if (leftover && leftover.found) {
        s.log('debug', '世界地图上还压着一张资源点卡片，先关掉。')
        await closeResourceCard(s)
        continue
      }
      s.log('debug', `已处于世界地图（${hit?.id} 命中 ${map.score}）。`)
      return
    }

    // 弹窗优先处理，否则下面任何点击都会被它吃掉。
    if (await dismissNoticeDialog(s)) continue

    // 搜索面板开着（它会盖住左下角的放大镜）。这是二级面板，BACK 能关，不会触发退出确认框。
    const searchPanel = await s.matchOptional(TPL.btnSearch)
    if (searchPanel && searchPanel.found) {
      s.log('debug', '当前是搜索面板，按 BACK 关闭。')
      await s.key('BACK', 800)
      await dismissNoticeDialog(s)
      continue
    }

    // 部队管理面板开着。
    const troop = await s.matchOptional(TPL.panelTitleTroop, undefined)
    if (troop && troop.found) {
      s.log('debug', '当前是部队管理面板，按 BACK 关闭。')
      await s.key('BACK', 800)
      await dismissNoticeDialog(s)
      continue
    }

    // 创建部队页。
    const createPage = await s.matchOptional(TPL.titleCreateTroop)
    if (createPage && createPage.found) {
      s.log('debug', '当前是创建部队页，点左上角返回。')
      await leaveCreateTroopPage(s)
      continue
    }

    // 资源点卡片开着（地图上的气泡）。
    const card = await s.matchOptional(TPL.btnGather, CARD.anchorRoi)
    if (card && card.found) {
      s.log('debug', '当前有资源点卡片，点卡片外空地关闭。')
      await closeResourceCard(s)
      continue
    }

    // 在城内 —— 点地图按钮切到世界地图（按钮按阵营各一张，anyTemplate）。
    const city = await s.bestOf(CITY_TEMPLATES)
    if (city && city.match.found) {
      s.log('info', `当前在城内（${city.id} 命中 ${city.match.score}），切到世界地图。`)
      await s.tapAt(FIXED_TAP.cityToMap, 2500)
      continue
    }

    // 认不出来了。先看右上角有没有活动弹窗的 ×（有就点它，比 BACK 精准）。
    if (await dismissPopupByClose(s)) continue

    // 再盲按一次 BACK，然后**必须**检查退出确认框。
    s.log('warn', `认不出当前界面（第 ${attempt}/${maxAttempts} 次），按一次 BACK 试探。`)
    await s.shot(`g0-unknown-${attempt}`)
    await s.key('BACK', 1200)
    await dismissNoticeDialog(s)
  }

  await s.shot('g0-failed')
  throw new AppError(
    'STEP_FAILED',
    `尝试 ${maxAttempts} 次仍无法回到世界地图（${WORLD_MAP_TEMPLATES.join(' / ')} 都始终不命中）。` +
      '请手动把游戏切到世界地图，或检查这几张模板是否仍然有效；' +
      '若这是一个新阵营的账号（精灵等），需要补裁城内 / 世界地图两态按钮的变体模板。' +
      '（★ 放大镜的镜片是半透明的，分数会随镜片底下的地形漂移，所以它一张顶不住；' +
      '真出问题时优先看不透明的 tpl_nav_city_toggle。）',
    { step: 'G0' }
  )
}

/** 把点夹进画面内，避免点到屏幕外（关卡片时相对偏移可能算出负值）。 */
function clampToScreen(s: GatherSession, p: Point): Point {
  return {
    x: Math.min(s.refWidth - 10, Math.max(10, Math.round(p.x))),
    y: Math.min(s.refHeight - 10, Math.max(10, Math.round(p.y)))
  }
}
