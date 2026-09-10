/**
 * 日统计的纯 reducer：StatsEvent → DailyStats。
 *
 * ★ 本文件只做算术，不 import electron / node:fs，也不知道"现在几点"——
 *   所有时刻都从事件里来，方便离线自检用假时间逐条验算。
 * ★ 日期算法只有一份：@shared/stats 的 cstDateKey / cstNextDayStart（北京时间 UTC+8 位移），
 *   这里**不得**再出现 getHours / toLocaleDateString 之类依赖宿主时区的调用。
 *
 * 口径见 src/shared/stats.ts 顶部的【统计口径】。
 */

import {
  RESOURCE_NAME,
  RESOURCE_TYPES,
  type ResourceType
} from '@shared/resources'
import {
  STATS_SNAPSHOTS_PER_DAY,
  cstDateKey,
  cstNextDayStart,
  dateKeyToDayStart,
  emptyDailyStats,
  emptyInstanceDailyStats,
  type DailyResourceStat,
  type DailyStats,
  type InstanceDailyStats,
  type StatsEvent
} from '@shared/stats'

/** applyStatsEvent 的外部上下文：账号名与「坐标 → 资源类型」反查，由 StatsCenter 维护。 */
export interface ApplyContext {
  /** 事件发生时该实例绑定的账号名（缓存值，首次可能为 null）。 */
  accountName: string | null
  /** 从派兵记账反查坐标对应的资源类型；查不到返回 null。 */
  resourceOfCoord?: (instanceIndex: number, coord: string | null) => ResourceType | null
  /** 归类失败等降级情况的中文说明出口（可选，默认丢弃）。 */
  warn?: (message: string) => void
}

/** 取（或建）某实例的分桶。 */
function instanceBucket(day: DailyStats, instanceIndex: number): InstanceDailyStats {
  const key = String(instanceIndex)
  let inst = day.byInstance[key]
  if (!inst) {
    inst = emptyInstanceDailyStats(instanceIndex)
    day.byInstance[key] = inst
  }
  return inst
}

/** 一组资源账里派兵最多的那种；全部为 0 返回 null。 */
function mostDispatchedResource(by: Record<ResourceType, DailyResourceStat>): ResourceType | null {
  let best: ResourceType | null = null
  let bestCount = 0
  for (const t of RESOURCE_TYPES) {
    if (by[t].dispatches > bestCount) {
      best = t
      bestCount = by[t].dispatches
    }
  }
  return best
}

/**
 * 把一条事件折进日桶，返回**新对象**（输入不动）。
 *
 * ★ 调用方保证 `cstDateKey(e.at) === day.dateKey`；这里不做跨日判断（那是 rolloverDay / StatsCenter 的事）。
 *   为了不让一条时间错乱的事件把桶弄脏，不满足时只记 warn 并原样返回克隆。
 */
export function applyStatsEvent(day: DailyStats, e: StatsEvent, ctx: ApplyContext): DailyStats {
  const next = structuredClone(day)
  if (!Number.isFinite(e.at) || cstDateKey(e.at) !== next.dateKey) {
    ctx.warn?.(
      `[统计] 事件 ${e.kind} 的日期（${cstDateKey(e.at)}）与日桶 ${next.dateKey} 不符，已忽略。`
    )
    return next
  }
  const inst = instanceBucket(next, e.instanceIndex)
  // 账号名以最后一次事件时的绑定为准（首次可能为 null，后续事件会补上）。
  if (ctx.accountName != null) inst.accountName = ctx.accountName

  switch (e.kind) {
    case 'dispatch': {
      const r = e.resource
      const g = next.byResource[r]
      const i = inst.byResource[r]
      const amount = typeof e.storage === 'number' && Number.isFinite(e.storage) && e.storage >= 0 ? e.storage : null
      g.dispatches += 1
      i.dispatches += 1
      next.dispatches += 1
      inst.dispatches += 1
      if (amount == null) {
        g.unknownStorageDispatches += 1
        i.unknownStorageDispatches += 1
      } else {
        g.estimatedAmount += amount
        i.estimatedAmount += amount
      }
      break
    }
    case 'cycleFailed': {
      if (e.outcome === 'circuitBroken') {
        next.circuitBreaks += 1
        inst.circuitBreaks += 1
      } else {
        next.failures += 1
        inst.failures += 1
      }
      break
    }
    case 'tripCompleted': {
      // 优先事件自带的类型 → 派兵记账反查 → 该实例今天派得最多的资源 → 全局派得最多的资源。
      // 四步都落空说明今天压根没派过兵（多半是昨天派的队伍今天回来、且记账表已丢），
      // 这种趟数无处归类，只能放弃并记一条说明，不能凭空塞进某种资源。
      let r: ResourceType | null = e.resource ?? ctx.resourceOfCoord?.(e.instanceIndex, e.coord) ?? null
      let via = ''
      if (!r) {
        r = mostDispatchedResource(inst.byResource)
        via = r ? '按该实例今日派兵最多的资源归类' : ''
      }
      if (!r) {
        r = mostDispatchedResource(next.byResource)
        via = r ? '按全局今日派兵最多的资源归类' : ''
      }
      if (!r) {
        ctx.warn?.(
          `[统计] 实例 ${e.instanceIndex} 的队伍（${e.coord ?? '坐标未知'}）回城，但今天没有任何派兵记录可归类，此趟未计入完成趟数。`
        )
        break
      }
      if (via) {
        ctx.warn?.(
          `[统计] 实例 ${e.instanceIndex} 的队伍（${e.coord ?? '坐标未知'}）回城时查不到资源类型，${via}：${RESOURCE_NAME[r]}。`
        )
      }
      next.byResource[r].completed += 1
      inst.byResource[r].completed += 1
      break
    }
    case 'alertRaised': {
      next.alerts += 1
      inst.alerts += 1
      break
    }
    case 'paused': {
      // 幂等：已经在暂停中就不重置起点，否则重复 paused 会把已经过去的暂停时段抹掉。
      if (inst.pausedSince == null) inst.pausedSince = e.at
      break
    }
    case 'resumed': {
      if (inst.pausedSince != null) {
        const span = Math.max(0, e.at - inst.pausedSince)
        inst.pausedMs += span
        next.pausedMs += span
        inst.pausedSince = null
      }
      break
    }
    case 'snapshot': {
      next.snapshots.push(structuredClone(e.snapshot))
      next.snapshots.sort((a, b) => a.at - b.at)
      if (next.snapshots.length > STATS_SNAPSHOTS_PER_DAY) {
        next.snapshots.splice(0, next.snapshots.length - STATS_SNAPSHOTS_PER_DAY)
      }
      break
    }
    default: {
      // 穷尽检查：新增事件种类时这里会编译不过，提醒来补 reducer。
      const never: never = e
      ctx.warn?.(`[统计] 未知事件种类，已忽略：${JSON.stringify(never)}`)
      break
    }
  }
  next.updatedAt = Math.max(next.updatedAt, e.at)
  return next
}

/**
 * 日切：把 prev 在它的北京 0 点边界上收口，并开出下一天的空桶。
 *   · 仍在暂停中的实例：暂停时长算到边界为止记进 closed，然后在 opened 里从边界继续计（pausedSince = boundary）。
 *   · accountName 沿用到新桶（当天第一条事件之前面板也能显示账号名）。
 *   · 只处理**紧挨着的**下一天；隔了多天由调用方连续调用。
 *
 * `at` 只用来给 opened.updatedAt 一个不早于边界的值（真实日切时 = 触发时刻；离线补算可传边界）。
 */
export function rolloverDay(prev: DailyStats, at: number): { closed: DailyStats; opened: DailyStats } {
  const dayStart = dateKeyToDayStart(prev.dateKey)
  const boundary = cstNextDayStart(Number.isFinite(dayStart) ? dayStart : at)
  const closed = structuredClone(prev)
  const opened = emptyDailyStats(cstDateKey(boundary), Math.max(boundary, Number.isFinite(at) ? at : boundary))

  for (const inst of Object.values(closed.byInstance)) {
    const carried = emptyInstanceDailyStats(inst.instanceIndex)
    carried.accountName = inst.accountName
    if (inst.pausedSince != null) {
      const span = Math.max(0, boundary - inst.pausedSince)
      inst.pausedMs += span
      closed.pausedMs += span
      inst.pausedSince = null
      carried.pausedSince = boundary
    }
    opened.byInstance[String(inst.instanceIndex)] = carried
  }
  closed.updatedAt = Math.max(closed.updatedAt, boundary)
  return { closed, opened }
}

/** 日桶里有没有任何值得落盘的内容（全空的桶不写文件，免得隔了几天不开机就刷出一堆空 JSON）。 */
export function isDayEmpty(day: DailyStats): boolean {
  if (day.dispatches || day.failures || day.circuitBreaks || day.alerts || day.pausedMs) return false
  if (day.snapshots.length > 0) return false
  for (const inst of Object.values(day.byInstance)) {
    if (inst.pausedSince != null || inst.pausedMs || inst.dispatches || inst.failures || inst.alerts) return false
    for (const t of RESOURCE_TYPES) if (inst.byResource[t].completed) return false
  }
  for (const t of RESOURCE_TYPES) if (day.byResource[t].completed) return false
  return true
}
