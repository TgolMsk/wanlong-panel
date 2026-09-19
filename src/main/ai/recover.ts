/**
 * 认不出界面时的 AI 恢复流程：识别 → 评估操作风险 → 点击并复验 → 学习关闭模板 → 记录。
 *
 * 采集流程（navigation.ts 的 ensureWorldMap）与调度器采样（scheduler/troopPanel.ts 的 ensurePanelOpen）
 * 在「盲按 BACK 之前」各插一次本函数。返回 handled=true 表示画面已经被改变、调用方应重新截图再判；
 * requiresAttention 表示需暂停并交给用户处理，不能继续 BACK 阶梯；画面过期时 handled=true 仅要求重新截图。
 *
 * ★ 三条安全边界：
 *   1. 点击需通过风险评估；确认动作还需新截图二次评估和重复执行保护。
 *   2. 点完必须复验：画面没变 ⇒ 当没发生；
 *   3. 只在「点完回到了已知界面」时才裁模板 —— 画面变了但仍认不出，说明关掉的可能不是弹窗
 *      （或底下还有一层），这种情况学到的模板是不可信的。
 *
 * 纯 Node，不 import electron。设备操作走 RecoverIo（参考坐标），采集流程的 GatherIo 天然满足它。
 */

import type { AiAdvice, AiConsultOutcome, AiScreenKind } from '@shared/ai'
import { AI_ACTION_LABEL } from '@shared/ai'
import { AppError } from '@shared/errors'
import type { AndroidKey } from '@shared/script'
import type { PreparedTemplate, RawFrame } from '@shared/vision'
import { matchIn, prepareFrame } from '@vision/index'
import type { AiAdvisor } from './advisor'
import { harvestCloseButton } from './harvest'
import { riskRejection, isLowEffect } from './risk'
import { GAME_PACKAGE } from '@main/game/gather/geometry'

export interface RecoverIo {
  capture(): Promise<RawFrame>
  /** 参考坐标点击。 */
  tap(x: number, y: number): Promise<void>
  key(k: AndroidKey): Promise<void>
}

export type RecoverLogger = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>
) => void

export interface RecoverContext {
  checkAlive?: () => void
  foregroundPackage?: () => Promise<string | null>
  /** 更新已经开始时，不再确认第二次更新。 */
  allowUpdateConfirm?: boolean
  instanceIndex: number | null
  /** gather-g0 / scheduler-sample。 */
  context: string
  /** 认不出的那一帧（点击前）。 */
  raw: RawFrame
  io: RecoverIo
  refWidth: number
  refHeight: number
  /** 模板集 id（裁模板用）。null = 不裁。 */
  setId: string | null
  attempt: number
  /** 用本地模板判断一帧是不是已知界面（世界地图 / 城内 / 面板…）。不给就只看画面有没有变。 */
  recognize?: (raw: RawFrame) => Promise<boolean>
  /** 模板集里已有的关闭按钮模板（去重：已有模板能认出这个 × 就不再学）。 */
  existingCloseTemplates?: PreparedTemplate[]
  log: RecoverLogger
}

export interface RecoverResult {
  handled: boolean
  advice: AiAdvice | null
  harvestedTemplateId: string | null
  outcome: AiConsultOutcome
  message: string
  requiresAttention?: boolean
}

/**
 * 模型说的这个界面是不是「流程本来就认识、待着不动也没事」的主界面。
 *
 * 只有这三类算：世界地图 / 城内 / 部队管理面板。顶号、维护公告、网络断开、看不出来
 * 这些仍然要暂停等人 —— 那才是安全闸门该拦的东西。
 */
function isMainScreen(screen: AiScreenKind): boolean {
  return screen === 'world_map' || screen === 'city' || screen === 'troop_panel'
}

/** 点击后等画面稳定的时间。 */
const AFTER_TAP_MS = 900
/** 画面「变了」的判据：shrink=4 灰度图的平均绝对差（0~255）。弹窗关闭通常 > 15，误点通常 < 3。 */
const CHANGED_THRESHOLD = 6

/** 绝不抛异常。 */
export async function aiRecoverUnknownScreen(
  advisor: AiAdvisor,
  ctx: RecoverContext
): Promise<RecoverResult> {
  const t0 = Date.now()
  let pendingAdvice: AiAdvice | null = null
  const finish = (
    outcome: AiConsultOutcome,
    message: string,
    advice: AiAdvice | null,
    harvestedTemplateId: string | null,
    handled: boolean,
    requiresAttention = false
  ): RecoverResult => {
    advisor.note({
      instanceIndex: ctx.instanceIndex,
      context: ctx.context,
      outcome,
      message,
      advice,
      harvestedTemplateId,
      latencyMs: Date.now() - t0
    })
    ctx.log(handled ? 'info' : 'warn', `AI 顾问：${message}`, { outcome, handled })
    return { handled, advice, harvestedTemplateId, outcome, message, requiresAttention }
  }

  try {
    ctx.checkAlive?.()
    const c = await advisor.consult({
      instanceIndex: ctx.instanceIndex,
      context: ctx.context,
      raw: ctx.raw,
      refWidth: ctx.refWidth,
      refHeight: ctx.refHeight,
      attempt: ctx.attempt
    })
    if (!c.advice) {
      // 未启用不记录（否则每次认不出界面都刷一条「未启用」）；被拦下 / 失败才记。
      if (c.outcome === null) {
        ctx.log('debug', `AI 顾问未参与：${c.reason}`)
        return {
          handled: false,
          advice: null,
          harvestedTemplateId: null,
          outcome: 'skipped',
          message: c.reason
        }
      }
      return finish(c.outcome, c.reason, null, null, false)
    }
    let advice = c.advice
    pendingAdvice = advice
    const cfg = advisor.currentConfig()
    ctx.checkAlive?.()

    if (advice.action === 'back' || advice.action === 'none') {
      if (
        advice.risk &&
        (advice.risk.level !== 'low' ||
          advice.risk.hazards.length ||
          !isLowEffect(advice.risk.effect)) &&
        // ★ 例外：模型说「这本来就是主界面、不用动」时**不要**升级成「需要人处理」。
        //   back / none 这两个动作本函数根本不会去点，risk 描述的是它**假想**中那一下点击的后果；
        //   拿一个不会发生的点击的风险，把实例暂停掉，是把安全闸门用错了地方。
        //   2026-09-18 真机：派完兵后一个半透明功能引导气泡盖在世界地图上，G0 认不出 → 问 AI →
        //   AI 答「画面主体就是世界地图，气泡没有 × 可关，强行点反而偏离主界面」→ 却被判成
        //   风险未通过 → 实例暂停等人处理。正确的处置是交回兜底阶梯：下一帧气泡自己就没了。
        !isMainScreen(advice.screen)
      ) {
        return finish(
          'rejected',
          `风险判断未通过：${advice.risk.reason || '风险不明'}，停止自动处理。`,
          advice,
          null,
          false,
          true
        )
      }
      return finish(
        'no_action',
        `模型判断当前是「${advice.screen}」，建议「${AI_ACTION_LABEL[advice.action]}」，交回兜底阶梯处理（${advice.reason}）。`,
        advice,
        null,
        false
      )
    }
    const rejectedRisk = riskRejection(advice)
    if (rejectedRisk) return finish('rejected', rejectedRisk, advice, null, false, true)
    if (ctx.allowUpdateConfirm === false && advice.risk?.effect === 'download_update') {
      return finish('no_action', '资源更新已开始，继续等待，不重复确认下载。', advice, null, false)
    }
    if (!advice.target) {
      return finish('rejected', '模型建议点击但没有给出目标框，不执行。', advice, null, false)
    }
    const minConfidence =
      advice.action === 'tap_confirm' ? Math.max(0.85, cfg.minConfidence) : cfg.minConfidence
    if (advice.confidence < minConfidence) {
      return finish(
        'rejected',
        `模型置信度 ${advice.confidence.toFixed(2)} 低于阈值 ${minConfidence}，不执行「${AI_ACTION_LABEL[advice.action]}」。`,
        advice,
        null,
        false,
        advice.action === 'tap_confirm'
      )
    }

    const checkForeground = async (): Promise<boolean> => {
      ctx.checkAlive?.()
      if (!ctx.foregroundPackage) return advice.action !== 'tap_confirm'
      const ok = (await ctx.foregroundPackage()) === GAME_PACKAGE
      ctx.checkAlive?.()
      return ok
    }
    if (!(await checkForeground()))
      return finish('rejected', '无法确认游戏仍在前台，已停止点击。', advice, null, false, true)
    let clickFrame = await ctx.io.capture()
    ctx.checkAlive?.()
    if (advice.action === 'tap_confirm') {
      const original = advice
      const second = await advisor.consult({
        instanceIndex: ctx.instanceIndex,
        context: ctx.context,
        raw: clickFrame,
        refWidth: ctx.refWidth,
        refHeight: ctx.refHeight,
        attempt: ctx.attempt,
        recheck: true
      })
      ctx.checkAlive?.()
      if (!second.advice)
        return finish(
          'rejected',
          `点击前风险复核未完成：${second.reason}`,
          original,
          null,
          false,
          true
        )
      advice = { ...second.advice, riskRechecked: true }
      pendingAdvice = advice
      const secondRisk = riskRejection(advice)
      if (
        secondRisk ||
        advice.action !== 'tap_confirm' ||
        advice.confidence < minConfidence ||
        advice.risk?.effect !== original.risk?.effect ||
        advice.risk?.buttonText.replace(/\s/g, '') !== original.risk?.buttonText.replace(/\s/g, '')
      ) {
        return finish(
          'rejected',
          `点击前复核未通过：${secondRisk ?? '按钮、后果或置信度发生变化'}。`,
          advice,
          null,
          false,
          true
        )
      }
      const latest = await ctx.io.capture()
      ctx.checkAlive?.()
      if (
        !advice.target ||
        !(await stableTarget(clickFrame, latest, advice.target, ctx.refWidth, ctx.refHeight))
      ) {
        return finish('rejected', '复核后画面发生变化，本次未点击，重新判断。', advice, null, true)
      }
      clickFrame = latest
    } else if (
      !(await stableTarget(ctx.raw, clickFrame, advice.target, ctx.refWidth, ctx.refHeight))
    ) {
      return finish(
        'rejected',
        '等待模型回复期间目标发生变化，本次未点击，重新判断。',
        advice,
        null,
        true
      )
    }
    if (!(await checkForeground()))
      return finish('rejected', '点击前前台已变化，停止操作。', advice, null, false, true)
    ctx.checkAlive?.()
    if (advice.action === 'tap_confirm' && !advisor.claimConfirmation(ctx.instanceIndex, advice)) {
      return finish(
        'rejected',
        '60 秒内已执行过相同确认，停止重复点击，请检查当前进度。',
        advice,
        null,
        false,
        true
      )
    }

    // ── 执行 ──
    const box = advice.target!
    const cx = Math.round(box.x + box.w / 2)
    const cy = Math.round(box.y + box.h / 2)
    ctx.log(
      'info',
      `按 AI 建议「${AI_ACTION_LABEL[advice.action]}」点击 (${cx},${cy})：${advice.reason}`
    )
    await ctx.io.tap(cx, cy)
    await sleep(AFTER_TAP_MS)
    const after = await ctx.io.capture()

    // ── 复验 ──
    const diff = await meanAbsDiff(clickFrame, after, ctx.refWidth, ctx.refHeight)
    const changed = diff >= CHANGED_THRESHOLD
    let recognized = false
    if (ctx.recognize) {
      try {
        recognized = await ctx.recognize(after)
      } catch (e) {
        ctx.log('warn', `复验时模板判断出错，按未识别处理：${AppError.from(e).message}`)
      }
    }
    if (!changed && !recognized) {
      return finish(
        'rejected',
        `点了 (${cx},${cy}) 之后画面没有变化（差异 ${diff.toFixed(1)}），判定无效，交回兜底阶梯。`,
        advice,
        null,
        false,
        advice.action === 'tap_confirm'
      )
    }
    if (!recognized) {
      return finish(
        'applied',
        `点了 (${cx},${cy})，画面变了（差异 ${diff.toFixed(1)}）但还没回到已知界面，重新判断。`,
        advice,
        null,
        true
      )
    }

    // ── 自学模板：只在 tap_close 且回到了已知界面时 ──
    if (advice.action !== 'tap_close' || !cfg.autoHarvest || !ctx.setId) {
      return finish('verified', `点了 (${cx},${cy})，已回到已知界面。`, advice, null, true)
    }
    if (await alreadyCovered(ctx, box)) {
      return finish(
        'verified',
        `点了 (${cx},${cy})，已回到已知界面；模板库里已有模板能认出这个关闭按钮，不再重复学习。`,
        advice,
        null,
        true
      )
    }
    let skipReason = ''
    const harvested = await harvestCloseButton(
      {
        raw: ctx.raw,
        box,
        refWidth: ctx.refWidth,
        refHeight: ctx.refHeight,
        setId: ctx.setId,
        note: `AI 自学（${ctx.context}，置信 ${advice.confidence.toFixed(2)}，模型 ${advice.model}）：${advice.reason}`
      },
      (r) => {
        skipReason = r
      }
    )
    if (!harvested) {
      return finish(
        'verified',
        `点了 (${cx},${cy})，已回到已知界面；本次没有裁模板：${skipReason}`,
        advice,
        null,
        true
      )
    }
    try {
      advisor.templateHarvested(ctx.setId, harvested.id)
    } catch (e) {
      ctx.log('warn', `通知模板缓存失效时出错（下次重启生效）：${AppError.from(e).message}`)
    }
    return finish(
      'harvested',
      `点了 (${cx},${cy})，已回到已知界面，并把关闭按钮裁成了模板「${harvested.id}」（std ${harvested.def.std ?? '?'}），下次同样的弹窗本地就能认出。`,
      advice,
      harvested.id,
      true
    )
  } catch (e) {
    const msg = `AI 恢复流程出错：${AppError.from(e).message}`
    return finish(
      'failed',
      msg,
      pendingAdvice,
      null,
      false,
      pendingAdvice?.action === 'tap_confirm'
    )
  }
}

/** 比较按钮与周边上下文，避免模型请求期间切屏后误点旧坐标。 */
export async function stableTarget(
  a: RawFrame,
  b: RawFrame,
  box: { x: number; y: number; w: number; h: number },
  refW: number,
  refH: number
): Promise<boolean> {
  if (a.width !== b.width || a.height !== b.height) return false
  const pa = await prepareFrame(a, { refW, refH, shrink: 2 })
  const pb = await prepareFrame(b, { refW, refH, shrink: 2 })
  const left = Math.max(0, Math.floor((box.x - 160) / 2))
  const top = Math.max(0, Math.floor((box.y - 240) / 2))
  const right = Math.min(pa.w, Math.ceil((box.x + box.w + 160) / 2))
  const bottom = Math.min(pa.h, Math.ceil((box.y + box.h + 80) / 2))
  let changed = 0,
    sum = 0,
    n = 0
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const d = Math.abs(pa.gray[y * pa.w + x]! - pb.gray[y * pb.w + x]!)
      sum += d
      if (d > 20) changed++
      n++
    }
  return n > 0 && sum / n < 3 && changed / n < 0.015
}

/** 已有的关闭按钮模板能不能在点击前那一帧的目标区域里认出这个 ×。能 ⇒ 不用再学。 */
async function alreadyCovered(
  ctx: RecoverContext,
  box: { x: number; y: number; w: number; h: number }
): Promise<boolean> {
  const list = ctx.existingCloseTemplates ?? []
  if (list.length === 0) return false
  try {
    const shrink = list[0]!.shrink
    const frame = await prepareFrame(ctx.raw, { refW: ctx.refWidth, refH: ctx.refHeight, shrink })
    const pad = Math.max(40, Math.max(box.w, box.h))
    const roi = {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      w: Math.min(ctx.refWidth, box.x + box.w + pad) - Math.max(0, box.x - pad),
      h: Math.min(ctx.refHeight, box.y + box.h + pad) - Math.max(0, box.y - pad)
    }
    for (const tpl of list) {
      if (tpl.shrink !== shrink) continue
      const m = await matchIn(frame, tpl, { roi })
      if (m.found) return true
    }
  } catch (e) {
    ctx.log('warn', `查重时模板匹配出错，按「没有覆盖」处理：${AppError.from(e).message}`)
  }
  return false
}

/** 两帧的平均绝对灰度差（shrink=4，640x360 一级的粗比对，几毫秒）。 */
export async function meanAbsDiff(
  a: RawFrame,
  b: RawFrame,
  refW: number,
  refH: number
): Promise<number> {
  const pa = await prepareFrame(a, { refW, refH, shrink: 4 })
  const pb = await prepareFrame(b, { refW, refH, shrink: 4 })
  const n = Math.min(pa.gray.length, pb.gray.length)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) sum += Math.abs(pa.gray[i]! - pb.gray[i]!)
  return sum / n
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
