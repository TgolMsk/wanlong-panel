/**
 * 每个实例的「采集配置健康度」角标。
 *
 * 采集配置不再是一个独立页面，而是总览页卡片 / 实例列表里就地展开的抽屉，
 * 所以入口按钮上必须一眼能看出「这个实例的配置有没有问题」，否则用户没有理由去点它。
 *
 * ★ 只有一份实现：总览页页头按钮、卡片卡脚按钮、实例列表那一列都用这个 hook，
 *   不许各自再算一遍 —— 「未绑账号也算问题」这类判据分散成三份必然漂移。
 *
 * 数据来源是同步的（accounts 里的 scriptParams + 本机 localStorage），
 * 所以这里不做异步、不缓存，跟着 instances / accounts 变就重算。
 * 保存完调 refresh()：未绑账号的实例配置落在 localStorage，accounts 不变、
 * 光靠依赖数组推不出来。
 */

import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store/appStore'
import { hasBlockingIssue, validateGatherConfig } from './config'
import { loadGatherConfig } from './configStorage'

export interface GatherConfigBadge {
  /** 采集总开关（配置里的 enabled）。主进程只认绑定账号里存的那份。 */
  enabled: boolean
  /** 这个实例有没有绑定账号。没绑 = 开了自动采集也只会定时读面板、不会派兵。 */
  bound: boolean
  /** 配置校验里 level==='error' 的条数（会挡住保存）。 */
  errors: number
  /** 需要提醒的严重程度；没问题时是 null（入口按钮不挂点）。 */
  tone: 'warning' | 'danger' | null
  /** 一句中文，直接当 tooltip 用。没问题时也有话说。 */
  text: string
}

/** 算一个实例的角标。导出是为了让自检和别处的单点使用不必再抄一遍判据。 */
export function describeGatherConfigBadge(
  instanceIndex: number,
  accounts: Parameters<typeof loadGatherConfig>[1]
): GatherConfigBadge {
  const loaded = loadGatherConfig(instanceIndex, accounts)
  const issues = validateGatherConfig(loaded.config)
  const errors = issues.filter((i) => i.level === 'error').length
  const enabled = loaded.config.enabled
  const bound = loaded.account !== null

  // 严重性从重到轻：配置错误 > 没绑账号 > 总开关没开。
  if (hasBlockingIssue(issues)) {
    return {
      enabled,
      bound,
      errors,
      tone: 'danger',
      text: `采集配置有 ${errors} 处错误，修好才能保存。点开展开配置。`
    }
  }
  if (!bound) {
    return {
      enabled,
      bound,
      errors,
      tone: 'warning',
      text: '这个实例还没绑定账号。主进程只从绑定账号里读采集配置，现在这份只存在本机。'
    }
  }
  if (!enabled) {
    return {
      enabled,
      bound,
      errors,
      tone: 'warning',
      text: '采集总开关没打开，不会派兵。点开展开配置，打开总开关并保存。'
    }
  }
  return {
    enabled,
    bound,
    errors,
    tone: null,
    text: '采集配置正常。点开可以就地修改。'
  }
}

export interface GatherConfigBadges {
  /** instanceIndex -> 角标。 */
  badges: Record<number, GatherConfigBadge>
  /** 有几个实例需要提醒（tone 非 null）。页头按钮上的数字就是它。 */
  problemCount: number
  /** 保存完手动重算一次（未绑账号的配置存在 localStorage，推不出来）。 */
  refresh: () => void
}

export function useGatherConfigBadges(): GatherConfigBadges {
  const instances = useAppStore((s) => s.instances)
  const accounts = useAppStore((s) => s.accounts)
  const [nonce, setNonce] = useState(0)

  const badges = useMemo(() => {
    const map: Record<number, GatherConfigBadge> = {}
    for (const inst of instances) {
      map[inst.index] = describeGatherConfigBadge(inst.index, accounts)
    }
    return map
    // nonce 只是「重算一次」的开关，故意进依赖数组。
  }, [instances, accounts, nonce])

  const problemCount = useMemo(
    () => Object.values(badges).filter((b) => b.tone !== null).length,
    [badges]
  )

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  return { badges, problemCount, refresh }
}
