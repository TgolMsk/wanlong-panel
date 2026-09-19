/**
 * 把一个实例「现在有什么毛病」收成一份清单。纯函数，不碰 React、不读 store。
 *
 * 为什么要单独一层：这些信息原来是三块常驻大字（红条 / 上次采样失败 / 采样告警），
 * 挂机时十个实例的卡片会被它们填满，真正要看的倒计时反而被挤到下面。
 * 现在统一收进角标（InstanceDiagnosticsBadge），点开才展开 —— 但**收起来不等于不告诉**：
 * 角标上要有数量与严重程度，所以「有几条、最重的是哪一档」必须先算出来。
 *
 * ★ 严重程度只有三档，含义固定：
 *   error   —— 已经不干活了（被暂停 / 采样失败），不处理就一直这样
 *   warning —— 还在干，但这一轮的判断可能是错的（识别不确定、行数对不上）
 *   info    —— 只是说明，不需要动手
 */

import type { InstanceQueueState } from '@shared/scheduler'
import { alertSpec, type InstancePauseState } from '@shared/alerts'
import { presentMarch } from './present'

export type DiagnosticLevel = 'error' | 'warning' | 'info'

export interface DiagnosticItem {
  level: DiagnosticLevel
  /** 短标题，用于清单里的小标签。 */
  title: string
  /** 正文（中文，要能指导操作）。 */
  text: string
}

export interface CollectDiagnosticsOptions {
  state: InstanceQueueState
  pause: InstancePauseState
  /**
   * 把每一行队伍的中文原因也收进来。
   * 实例列表那张表里没有 MarchRow，行内的「坐标读不出」之类的话没有别的地方能显示；
   * 采集总览的卡片里有 MarchRow，行原因已经在行上了，传 false（默认）免得重复两遍。
   */
  rowReasons?: boolean
  /** presentMarch 需要的时刻。行原因本身不随秒变，传一次渲染时的 Date.now() 就够。 */
  now: number
  /** 剩余不足多少毫秒算临期。 */
  imminentMs?: number
  /** 采样超过多久算数据陈旧。 */
  staleAfterMs?: number
}

/** 最重的一档；没有任何条目时返回 null。 */
export function worstLevel(items: readonly DiagnosticItem[]): DiagnosticLevel | null {
  if (items.some((i) => i.level === 'error')) return 'error'
  if (items.some((i) => i.level === 'warning')) return 'warning'
  if (items.length > 0) return 'info'
  return null
}

/** 需要用户注意的条数（info 不算 —— 角标上的数字必须等于「要处理几件事」）。 */
export function attentionCount(items: readonly DiagnosticItem[]): number {
  return items.filter((i) => i.level !== 'info').length
}

export function collectDiagnostics({
  state,
  pause,
  rowReasons = false,
  now,
  imminentMs = 60_000,
  staleAfterMs = 60_000
}: CollectDiagnosticsOptions): DiagnosticItem[] {
  const items: DiagnosticItem[] = []

  // ① 被异常暂停 —— 最重的一条，永远排第一。详情（现场截图 / 处置建议 / 推送结果）
  //    由 PauseBanner 自己渲染，这里只负责让它在清单里占一条、把角标点成红的。
  if (pause.paused) {
    const spec = pause.type ? alertSpec(pause.type) : null
    items.push({
      level: 'error',
      title: spec ? spec.title : '已暂停',
      text: pause.reason ?? '没有记录原因。'
    })
  }

  // ② 采样失败。
  // ★ 判据是「有错误原因」，**不能**加 lastSampledAt > 0：采样失败那条路只写 lastSampleOk/error，
  //   不动 lastSampledAt（src/main/scheduler/index.ts）。所以「从来没成功采过一次」的实例
  //   lastSampledAt 恒为 0 —— 加了那个前置，adb 未授权 / 游戏不在主界面这类一上来就失败的情况
  //   会一条提示都不显示，卡片只说「尚未采样」，用户以为还没开始，其实是在反复失败。
  if (!state.lastSampleOk && state.error) {
    items.push({
      level: 'error',
      title: state.lastSampledAt > 0 ? '上次采样失败' : '一直没能采样成功',
      text: state.error
    })
  }

  // ③ 采样告警：识别不确定、行数对不上之类。每次采样覆盖，所以这里是「本轮」的说法。
  for (const w of state.warnings) {
    items.push({ level: 'warning', title: '本轮采样告警', text: w })
  }

  // ④ 行内原因（只有表格那种看不到 MarchRow 的地方才收）。
  if (rowReasons) {
    for (const m of state.marches) {
      const p = presentMarch(m, now, { imminentMs, staleAfterMs })
      if (!p.reason) continue
      items.push({
        level: p.reasonLevel,
        title: `第 ${m.slot} 行`,
        text: p.reason
      })
    }
  }

  return items
}
