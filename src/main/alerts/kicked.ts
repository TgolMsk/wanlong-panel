/**
 * 第二层：「顶号」等特定界面的精确识别。★ 目前是**预留**，模板还没采集。
 *
 * 现实约束：制造一次顶号需要另一台设备登录同一账号，没法凭空造样本，
 * 所以本文件写的是「有模板就用、没模板就当没看见」的那一半，命中路径要等用户
 * 真被顶号、把截图发过来、在模板库里裁一张图之后才会第一次跑到。
 *
 * ★★ 降级纪律（必须守住）：
 *   · 模板不存在时 `GatherTemplates.get(id)` 返回 undefined —— 这已经是完美的降级点，
 *     直接 return null 就行，**绝不允许**抛异常、告警或中止采集。
 *   · 所以这几个 id 绝对不能加进 templates.ts 的 CRITICAL_TEMPLATES（整个模板集加载即失败，
 *     采集全线瘫痪），也不要加进 OPTIONAL_TEMPLATES（每次加载都刷一条「缺模板」告警）。
 *     本次交付**没有改动 templates.ts 一个字**，就是这个原因。
 *   · 一张模板都没有时，连截图预处理都不做（省掉一次 prepareFrame），直接降级到第一层兜底。
 *
 * 用户哪天补了模板（id 填成 RESERVED_TEMPLATE 里的值），第二层自动生效，**调用方一行都不用改**。
 */

import { RESERVED_TEMPLATE, type KickedProbe, type KickedProbeResult } from '@shared/alerts'
import type { LogLevel } from '@shared/script'
import type { PreparedFrame, PreparedTemplate, RawFrame } from '@shared/vision'
import { matchIn, prepareFrame } from '@vision/index'

import type { GatherTemplates } from '@main/game/gather/index'

/** 一个候选判据：模板 id + 命中之后要产生什么结论。 */
interface Candidate {
  id: string
  /** 命中后产生哪种事件（两种都会触发暂停）。 */
  type: KickedProbeResult['type']
  /** 中文原因。 */
  reason: string
}

/**
 * 判据表。**顺序即优先级**：先看最能定性的「已在其他设备登录」提示框，
 * 再看登录界面（被踢之后停在这里的时间最长，最容易撞上），最后是维护与更新公告。
 */
const CANDIDATES: readonly Candidate[] = [
  {
    id: RESERVED_TEMPLATE.kickedDialog,
    type: 'suspectedKicked',
    reason: '画面上出现了「账号已在其他设备登录」的提示框，本端已被踢下线。'
  },
  {
    id: RESERVED_TEMPLATE.loginScreen,
    type: 'suspectedKicked',
    reason: '游戏停在登录界面，且自动恢复没能回到世界地图 —— 多半是被顶号踢了出来。'
  },
  {
    id: RESERVED_TEMPLATE.maintenanceDialog,
    type: 'needsAttention',
    reason: '画面上出现了「服务器维护中」公告，现在进不去游戏。'
  },
  {
    id: RESERVED_TEMPLATE.updateDialog,
    type: 'needsAttention',
    reason: '画面上出现了强制更新弹窗，需要先更新客户端才能继续。'
  }
]

export interface KickedProbeOptions {
  templates: GatherTemplates
  /** 匹配阈值。不传就用模板自带的阈值（一般是 0.85）。 */
  threshold?: number
  log?(level: LogLevel, message: string, data?: Record<string, unknown>): void
}

/**
 * 模板库里有没有任何一张顶号相关模板。
 * 没有就完全跳过第二层 —— 连预处理都不用做。
 */
export function hasKickedTemplates(templates: GatherTemplates): boolean {
  return CANDIDATES.some((c) => templates.get(c.id) !== undefined)
}

/**
 * 在**已经预处理好的一帧**上跑第二层识别。
 *
 * @returns 命中返回结论；模板缺失、没命中、或匹配过程本身出错都返回 null（降级到第一层）。
 */
export async function probeKickedOnFrame(
  frame: PreparedFrame,
  opts: KickedProbeOptions
): Promise<KickedProbeResult | null> {
  for (const cand of CANDIDATES) {
    const tpl: PreparedTemplate | undefined = opts.templates.get(cand.id)
    if (!tpl) continue // ★ 模板没采集：静默跳过，这就是「自动降级」
    try {
      const m = await matchIn(frame, tpl, { threshold: opts.threshold })
      if (!m.found) continue
      opts.log?.('warn', `[告警] 第二层识别命中模板「${cand.id}」（score=${m.score}）。`)
      return {
        type: cand.type,
        reason: cand.reason,
        detail: { 命中模板: cand.id, 匹配分: m.score, 阈值: m.threshold }
      }
    } catch (e) {
      // 匹配失败（尺寸不符、shrink 不一致…）只是「这条判据用不了」，绝不能让告警链路挂掉。
      opts.log?.(
        'warn',
        `[告警] 第二层识别跑模板「${cand.id}」时出错，本条判据跳过：${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
  return null
}

/**
 * 在**裸帧**上跑第二层识别（预处理在内部做，shrink 与模板自身保持一致）。
 *
 * 给接线层用：采集失败留痕时手里正好有一张裸帧，直接喂进来即可，**不用额外截图**。
 */
export async function probeKickedOnRawFrame(
  raw: RawFrame,
  opts: KickedProbeOptions
): Promise<KickedProbeResult | null> {
  // 一张模板都没有就别做预处理了 —— 那是纯浪费的一次降采样。
  const anyTpl = CANDIDATES.map((c) => opts.templates.get(c.id)).find((t) => t !== undefined)
  if (!anyTpl) return null

  let frame: PreparedFrame
  try {
    // ★ shrink 必须与模板编译时一致，否则 matchIn 会直接抛 INVALID_ARGUMENT。
    frame = await prepareFrame(raw, {
      refW: opts.templates.refWidth,
      refH: opts.templates.refHeight,
      shrink: anyTpl.shrink
    })
  } catch (e) {
    opts.log?.(
      'warn',
      `[告警] 第二层识别预处理失败，本次降级到通用兜底：${e instanceof Error ? e.message : String(e)}`
    )
    return null
  }
  return probeKickedOnFrame(frame, opts)
}

/**
 * 造一个符合 `KickedProbe` 契约的探针（无参调用、绝不抛异常）。
 * 取帧交给调用方，这样探针既能用「刚截到的失败现场」，也能用离线回放的帧。
 */
export function createKickedProbe(
  opts: KickedProbeOptions & { capture(): Promise<RawFrame> }
): KickedProbe {
  return async (): Promise<KickedProbeResult | null> => {
    if (!hasKickedTemplates(opts.templates)) return null
    try {
      const raw = await opts.capture()
      return await probeKickedOnRawFrame(raw, opts)
    } catch (e) {
      opts.log?.(
        'warn',
        `[告警] 第二层识别取帧失败，本次降级到通用兜底：${e instanceof Error ? e.message : String(e)}`
      )
      return null
    }
  }
}
