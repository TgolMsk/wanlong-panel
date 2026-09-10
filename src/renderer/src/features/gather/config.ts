/**
 * 采集配置的 TypeScript 镜像 + 默认值 + 校验。
 *
 * ★ 唯一权威是 `resources/game-data/gather-config.schema.json`（draft-07，version const = 2）。
 *   本文件是它在渲染进程侧的类型镜像，字段名、默认值、取值范围必须与 schema 逐条一致；
 *   改 schema 就要同步改这里，反之亦然。之所以不直接在渲染进程里跑 ajv/zod 解析 schema：
 *   面板只需要「填表 + 提示」，跑一整个 JSON Schema 校验器要多拖一个运行时进 bundle，
 *   而这里的规则全是简单的范围/枚举判断，手写反而能给出更准确的中文提示。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【全模块最重要的一条不变量，改代码前必读】
 * 游戏的搜索规则是「返回等级 >= 搜索等级的资源点」，**不是精确匹配**。
 * 真机实测：伐木场把搜索值调到 1，连续搜 6 次返回的点是 8,7,7,7,7,8 —— 没有一次等于搜索值。
 * 所以本配置里所有等级值都叫 **searchFloor（搜索下限）**，不是目标值：
 *   · 卡片校验必须写 `卡片等级 >= searchFloor`，**绝不能写 ==**
 *     （写成 == 上面那 6 次会全判失败，表现为「一直在搜、永远不派兵」）
 *   · 不存在、也不可能存在等级上界。要避开不想要的点只能靠储量/行军时长/采集者/联盟
 *   · 「放宽下限」= 让更多点符合条件，不等于「退而求其次采低级点」
 * ════════════════════════════════════════════════════════════════════════════
 */

import { GATHER_RESOURCE_TYPES, type GatherResourceType } from './types'

// ── 类型（镜像 schema）──────────────────────────────────────────────────────

/** 相对上限：searchFloor = maxLv + offset。maxLv 由滑杆推到最右动态探测。 */
export interface RelativeLevelPolicy {
  mode: 'relative'
  /** -5..0，默认 -1（用户默认规则 maxLv-1）。 */
  offset: number
  /** 下限可以放宽到的最低值，默认 5。 */
  minLevel: number
  /** 探测失败时假定的上限，实测当前为 8。 */
  assumedMaxLevel: number
  /** 上限硬顶：探测读到超过它一律判为识别错误。是护栏，不是资源点等级上界。 */
  maxLevelHardCap: number
}

/** 绝对下限：直接指定 searchFloor。配 6 会搜到 6 级及以上，7、8 级都算合格。 */
export interface AbsoluteLevelPolicy {
  mode: 'absolute'
  level: number
  minLevel: number
  /** 关掉则固定下限搜不到就放弃本轮，不放宽。 */
  allowRelax: boolean
}

export type LevelPolicy = RelativeLevelPolicy | AbsoluteLevelPolicy

export type AllianceTerritory = 'own-only' | 'own-and-neutral' | 'any'

export interface ResourceEntry {
  type: GatherResourceType
  enabled: boolean
  /** 1..4，越小越先派。 */
  priority: number
  /** 0..5，这种资源最多同时占几个行军队列。 */
  queues: number
  /** 以下三项留空表示沿用全局设置。 */
  levelPolicy?: LevelPolicy
  minStorage?: number
  maxTravelSeconds?: number
}

export interface GatherThresholds {
  minStorage: number
  maxTravelSeconds: number
  maxDistanceKm: number
  requireGathererNone: boolean
  allianceTerritory: AllianceTerritory
  ownAllianceTag: string
  preferLoadCoversStorage: boolean
}

export interface QueuePlan {
  reserveQueues: number
  maxConcurrentGather: number
  avoidDuplicateTarget: boolean
  minCommanderStamina: number
}

export interface SearchRetry {
  occupiedRetryLimit: number
  floorRelaxStep: number
  researchDelayMs: number
  probeMaxLevel: boolean
  probeIntervalMin: number
}

export interface GatherSchedule {
  slackSeconds: number
  retryBackoffSeconds: number[]
  maxBackoffSeconds: number
  calibrateIntervalMin: number
  jitterSeconds: number
  maxDispatchesPerHour: number
  giveUpCooldownMin: number
}

export interface GatherSafety {
  abortOnReconcileFail: boolean
  onUnknownLevel: 'abort' | 'acceptCard'
  onUnknownStorage: 'skipPoint' | 'accept'
  unknownEtaFallbackSeconds: number
  maxCapturesPerCycle: number
  swipeRetry: number
  shotPolicy: 'never' | 'onFail' | 'always'
}

export interface GatherConfig {
  version: 2
  enabled: boolean
  resources: ResourceEntry[]
  levelPolicy: LevelPolicy
  thresholds: GatherThresholds
  autoGatherUntilEmpty: boolean
  queuePlan: QueuePlan
  searchRetry: SearchRetry
  schedule: GatherSchedule
  safety: GatherSafety
}

// ── 默认值（与 schema 的 default 逐条对齐）──────────────────────────────────

export function defaultLevelPolicy(): RelativeLevelPolicy {
  return { mode: 'relative', offset: -1, minLevel: 5, assumedMaxLevel: 8, maxLevelHardCap: 15 }
}

export function defaultGatherConfig(): GatherConfig {
  return {
    version: 2,
    enabled: false,
    resources: [
      { type: 'wood', enabled: true, priority: 1, queues: 2 },
      { type: 'gold', enabled: true, priority: 2, queues: 1 },
      { type: 'iron', enabled: true, priority: 3, queues: 1 },
      { type: 'mana', enabled: false, priority: 4, queues: 0 }
    ],
    levelPolicy: defaultLevelPolicy(),
    thresholds: {
      minStorage: 300000,
      maxTravelSeconds: 600,
      maxDistanceKm: 0,
      requireGathererNone: true,
      allianceTerritory: 'any', // 用户裁定：任何领地都可采，不做联盟过滤
      ownAllianceTag: '',
      preferLoadCoversStorage: false
    },
    autoGatherUntilEmpty: true,
    queuePlan: {
      reserveQueues: 0,
      maxConcurrentGather: 5,
      avoidDuplicateTarget: true,
      minCommanderStamina: 1
    },
    searchRetry: {
      occupiedRetryLimit: 4,
      floorRelaxStep: 1,
      researchDelayMs: 900,
      probeMaxLevel: true,
      probeIntervalMin: 720
    },
    schedule: {
      slackSeconds: 60,
      retryBackoffSeconds: [30, 60, 120, 240, 300],
      maxBackoffSeconds: 300,
      calibrateIntervalMin: 15,
      jitterSeconds: 20,
      maxDispatchesPerHour: 30,
      giveUpCooldownMin: 10
    },
    safety: {
      abortOnReconcileFail: true,
      /**
       * ★ 与 schema 早期的 default('abort') 不同，取 'acceptCard'，与主进程
       *   src/main/game/gather/config.ts 的 DEFAULT_GATHER_CONFIG 对齐（schema 也已同步改成 acceptCard）。
       *   理由：当前模板库里 dig_card_title 只有 7、8 两个字形，取 'abort' 会让每一轮都在
       *   读卡片等级这一步中止；而「判据是 >= 下限、游戏只返回满足下限的点」保证了 acceptCard 是安全的。
       *   三处默认值必须一致 —— 否则用户在本页点一次保存，就会把主进程那边刻意选的值悄悄改回去。
       */
      onUnknownLevel: 'acceptCard',
      onUnknownStorage: 'skipPoint',
      unknownEtaFallbackSeconds: 600,
      /**
       * ★ 同上，取 60 而不是 schema 早期的 24。
       *   离线回放实测：一次顺利派兵要 17 帧，一次「点被占用、换一个」要 6~7 帧，
       *   默认 occupiedRetryLimit=4 最坏需要约 45 帧；给 24 的话重试策略跑不满就被熔断。
       */
      maxCapturesPerCycle: 60,
      swipeRetry: 3,
      shotPolicy: 'onFail'
    }
  }
}

// ── 反序列化：把外部存的东西补齐成完整配置 ──────────────────────────────────

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}
function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function normalizeLevelPolicy(raw: unknown, fallback: LevelPolicy): LevelPolicy {
  if (!raw || typeof raw !== 'object') return fallback
  const o = raw as Record<string, unknown>
  if (o.mode === 'absolute') {
    return {
      mode: 'absolute',
      level: num(o.level, 7),
      minLevel: num(o.minLevel, 5),
      allowRelax: bool(o.allowRelax, true)
    }
  }
  const d = defaultLevelPolicy()
  return {
    mode: 'relative',
    offset: num(o.offset, d.offset),
    minLevel: num(o.minLevel, d.minLevel),
    assumedMaxLevel: num(o.assumedMaxLevel, d.assumedMaxLevel),
    maxLevelHardCap: num(o.maxLevelHardCap, d.maxLevelHardCap)
  }
}

/**
 * 把任意来源的对象（可能是旧版本、可能缺字段、可能是别人手改的 JSON）
 * 补成一份完整可用的配置。**不抛异常** —— 认不出的字段一律回落默认值，
 * 但会把发现的问题通过 `validateGatherConfig()` 报出来，不静默吞掉。
 */
export function normalizeGatherConfig(raw: unknown): GatherConfig {
  const d = defaultGatherConfig()
  if (!raw || typeof raw !== 'object') return d
  const o = raw as Record<string, unknown>

  const rawResources = Array.isArray(o.resources) ? o.resources : []
  const resources: ResourceEntry[] = GATHER_RESOURCE_TYPES.map((type, i) => {
    const found = rawResources.find(
      (r) => r && typeof r === 'object' && (r as Record<string, unknown>).type === type
    ) as Record<string, unknown> | undefined
    const def = d.resources[i]
    if (!found) return def
    const entry: ResourceEntry = {
      type,
      enabled: bool(found.enabled, def.enabled),
      priority: num(found.priority, def.priority),
      queues: num(found.queues, def.queues)
    }
    if (found.levelPolicy)
      entry.levelPolicy = normalizeLevelPolicy(found.levelPolicy, d.levelPolicy)
    if (found.minStorage !== undefined)
      entry.minStorage = num(found.minStorage, d.thresholds.minStorage)
    if (found.maxTravelSeconds !== undefined) {
      entry.maxTravelSeconds = num(found.maxTravelSeconds, d.thresholds.maxTravelSeconds)
    }
    return entry
  })

  const th = (o.thresholds ?? {}) as Record<string, unknown>
  const qp = (o.queuePlan ?? {}) as Record<string, unknown>
  const sr = (o.searchRetry ?? {}) as Record<string, unknown>
  const sc = (o.schedule ?? {}) as Record<string, unknown>
  const sf = (o.safety ?? {}) as Record<string, unknown>

  const backoff = Array.isArray(sc.retryBackoffSeconds)
    ? sc.retryBackoffSeconds.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : []

  return {
    version: 2,
    enabled: bool(o.enabled, d.enabled),
    resources,
    levelPolicy: normalizeLevelPolicy(o.levelPolicy, d.levelPolicy),
    thresholds: {
      minStorage: num(th.minStorage, d.thresholds.minStorage),
      maxTravelSeconds: num(th.maxTravelSeconds, d.thresholds.maxTravelSeconds),
      maxDistanceKm: num(th.maxDistanceKm, d.thresholds.maxDistanceKm),
      requireGathererNone: bool(th.requireGathererNone, d.thresholds.requireGathererNone),
      allianceTerritory: pick(
        th.allianceTerritory,
        ['own-only', 'own-and-neutral', 'any'] as const,
        d.thresholds.allianceTerritory
      ),
      ownAllianceTag: str(th.ownAllianceTag, d.thresholds.ownAllianceTag).slice(0, 8),
      preferLoadCoversStorage: bool(
        th.preferLoadCoversStorage,
        d.thresholds.preferLoadCoversStorage
      )
    },
    autoGatherUntilEmpty: bool(o.autoGatherUntilEmpty, d.autoGatherUntilEmpty),
    queuePlan: {
      reserveQueues: num(qp.reserveQueues, d.queuePlan.reserveQueues),
      maxConcurrentGather: num(qp.maxConcurrentGather, d.queuePlan.maxConcurrentGather),
      avoidDuplicateTarget: bool(qp.avoidDuplicateTarget, d.queuePlan.avoidDuplicateTarget),
      minCommanderStamina: num(qp.minCommanderStamina, d.queuePlan.minCommanderStamina)
    },
    searchRetry: {
      occupiedRetryLimit: num(sr.occupiedRetryLimit, d.searchRetry.occupiedRetryLimit),
      floorRelaxStep: num(sr.floorRelaxStep, d.searchRetry.floorRelaxStep),
      researchDelayMs: num(sr.researchDelayMs, d.searchRetry.researchDelayMs),
      probeMaxLevel: bool(sr.probeMaxLevel, d.searchRetry.probeMaxLevel),
      probeIntervalMin: num(sr.probeIntervalMin, d.searchRetry.probeIntervalMin)
    },
    schedule: {
      slackSeconds: num(sc.slackSeconds, d.schedule.slackSeconds),
      retryBackoffSeconds: backoff.length > 0 ? backoff : d.schedule.retryBackoffSeconds,
      maxBackoffSeconds: num(sc.maxBackoffSeconds, d.schedule.maxBackoffSeconds),
      calibrateIntervalMin: num(sc.calibrateIntervalMin, d.schedule.calibrateIntervalMin),
      jitterSeconds: num(sc.jitterSeconds, d.schedule.jitterSeconds),
      maxDispatchesPerHour: num(sc.maxDispatchesPerHour, d.schedule.maxDispatchesPerHour),
      giveUpCooldownMin: num(sc.giveUpCooldownMin, d.schedule.giveUpCooldownMin)
    },
    safety: {
      abortOnReconcileFail: bool(sf.abortOnReconcileFail, d.safety.abortOnReconcileFail),
      onUnknownLevel: pick(
        sf.onUnknownLevel,
        ['abort', 'acceptCard'] as const,
        d.safety.onUnknownLevel
      ),
      onUnknownStorage: pick(
        sf.onUnknownStorage,
        ['skipPoint', 'accept'] as const,
        d.safety.onUnknownStorage
      ),
      unknownEtaFallbackSeconds: num(
        sf.unknownEtaFallbackSeconds,
        d.safety.unknownEtaFallbackSeconds
      ),
      maxCapturesPerCycle: num(sf.maxCapturesPerCycle, d.safety.maxCapturesPerCycle),
      swipeRetry: num(sf.swipeRetry, d.safety.swipeRetry),
      shotPolicy: pick(sf.shotPolicy, ['never', 'onFail', 'always'] as const, d.safety.shotPolicy)
    }
  }
}

// ── 校验 ────────────────────────────────────────────────────────────────────

export interface ConfigIssue {
  /** error 会挡住保存；warning 只提示。 */
  level: 'error' | 'warning'
  /** 出问题的字段路径，用于把错误挂到对应的表单项上。 */
  path: string
  message: string
}

function range(
  issues: ConfigIssue[],
  path: string,
  label: string,
  v: number,
  min: number,
  max: number
): void {
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    issues.push({ level: 'error', path, message: `${label}必须是整数。` })
    return
  }
  if (v < min || v > max) {
    issues.push({
      level: 'error',
      path,
      message: `${label}必须在 ${min} ~ ${max} 之间，当前是 ${v}。`
    })
  }
}

/** 返回全部问题（不是遇到第一个就停），方便表单一次性把红字标满。 */
export function validateGatherConfig(cfg: GatherConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = []

  // 资源
  const on = cfg.resources.filter((r) => r.enabled)
  if (cfg.enabled && on.length === 0) {
    issues.push({
      level: 'error',
      path: 'resources',
      message: '已启用自动采集，但一种资源都没选。至少勾一种，否则调度器无事可做。'
    })
  }
  for (const r of cfg.resources) {
    range(issues, `resources.${r.type}.priority`, `「${r.type}」的优先级`, r.priority, 1, 4)
    range(issues, `resources.${r.type}.queues`, `「${r.type}」的队列数`, r.queues, 0, 5)
    if (r.enabled && r.queues === 0) {
      issues.push({
        level: 'warning',
        path: `resources.${r.type}.queues`,
        message: '这种资源已启用但分配了 0 个队列，等于不会被派兵。要么给它队列，要么关掉它。'
      })
    }
  }
  const dupPriority = new Set<number>()
  for (const r of on) {
    if (dupPriority.has(r.priority)) {
      issues.push({
        level: 'warning',
        path: 'resources',
        message: `有多种资源都用了优先级 ${r.priority}，同优先级之间的先后顺序不确定。`
      })
    }
    dupPriority.add(r.priority)
  }
  const sumQueues = on.reduce((s, r) => s + r.queues, 0)
  if (sumQueues > cfg.queuePlan.maxConcurrentGather) {
    issues.push({
      level: 'warning',
      path: 'queuePlan.maxConcurrentGather',
      message:
        `各资源分配的队列数之和是 ${sumQueues}，超过了「自动采集最多占用 ${cfg.queuePlan.maxConcurrentGather} 个队列」。` +
        '超出部分不会生效，低优先级的资源会一直派不出去。'
    })
  }

  // 等级下限
  const lp = cfg.levelPolicy
  if (lp.mode === 'relative') {
    range(issues, 'levelPolicy.offset', '相对上限的偏移', lp.offset, -5, 0)
    range(issues, 'levelPolicy.minLevel', '下限可放宽到的最低值', lp.minLevel, 1, 15)
    range(issues, 'levelPolicy.assumedMaxLevel', '探测失败时假定的上限', lp.assumedMaxLevel, 1, 15)
    range(issues, 'levelPolicy.maxLevelHardCap', '上限硬顶', lp.maxLevelHardCap, 1, 30)
    if (lp.assumedMaxLevel + lp.offset < lp.minLevel) {
      issues.push({
        level: 'warning',
        path: 'levelPolicy.offset',
        message:
          `按当前假定上限 ${lp.assumedMaxLevel} 算出的搜索下限是 ${lp.assumedMaxLevel + lp.offset}，` +
          `已经低于「可放宽到的最低值 ${lp.minLevel}」，放宽机制形同虚设。`
      })
    }
  } else {
    range(issues, 'levelPolicy.level', '固定搜索下限', lp.level, 1, 15)
    range(issues, 'levelPolicy.minLevel', '下限可放宽到的最低值', lp.minLevel, 1, 15)
    if (lp.minLevel > lp.level) {
      issues.push({
        level: 'error',
        path: 'levelPolicy.minLevel',
        message: `「可放宽到的最低值 ${lp.minLevel}」比「固定搜索下限 ${lp.level}」还高，放宽将永远无法生效。`
      })
    }
  }

  // 阈值
  const th = cfg.thresholds
  if (th.minStorage < 0) {
    issues.push({ level: 'error', path: 'thresholds.minStorage', message: '最低储量不能是负数。' })
  }
  if (th.maxTravelSeconds < 0) {
    issues.push({
      level: 'error',
      path: 'thresholds.maxTravelSeconds',
      message: '最长单程行军不能是负数。填 0 表示不限制。'
    })
  }
  if (th.maxTravelSeconds > 0 && th.maxTravelSeconds < 30) {
    issues.push({
      level: 'warning',
      path: 'thresholds.maxTravelSeconds',
      message: '最长单程行军小于 30 秒，附近几乎没有点能满足，很容易一直搜不到而放弃本轮。'
    })
  }
  if (!th.requireGathererNone) {
    issues.push({
      level: 'warning',
      path: 'thresholds.requireGathererNone',
      message:
        '关掉「必须采集者为无」等于允许去抢已被占用的点，实际会派兵失败。除非在调试，不要关。'
    })
  }
  if (th.allianceTerritory !== 'any' && th.ownAllianceTag.trim() === '') {
    issues.push({
      level: 'warning',
      path: 'thresholds.ownAllianceTag',
      message:
        '没有填本方联盟缩写，引擎会自动降级为「只接受所属联盟＝无（中立点）」。' +
        '方向是安全的（少采而不是采错），但会漏掉本方领地上的加成点。'
    })
  }

  // 队列
  range(issues, 'queuePlan.reserveQueues', '预留队列数', cfg.queuePlan.reserveQueues, 0, 5)
  range(
    issues,
    'queuePlan.maxConcurrentGather',
    '自动采集最多占用的队列数',
    cfg.queuePlan.maxConcurrentGather,
    1,
    5
  )

  // 搜索重试
  range(
    issues,
    'searchRetry.occupiedRetryLimit',
    '同一下限下最多重搜次数',
    cfg.searchRetry.occupiedRetryLimit,
    1,
    20
  )
  range(
    issues,
    'searchRetry.floorRelaxStep',
    '每次放宽的级数',
    cfg.searchRetry.floorRelaxStep,
    1,
    3
  )
  if (cfg.searchRetry.researchDelayMs < 300) {
    issues.push({
      level: 'warning',
      path: 'searchRetry.researchDelayMs',
      message:
        '两次搜索间隔小于 300ms，很可能截到地图跳转的动画中间帧，导致模板匹配失败、白白多搜几次。'
    })
  }

  // 调度
  const sc = cfg.schedule
  range(issues, 'schedule.slackSeconds', '唤醒冗余', sc.slackSeconds, 0, 900)
  if (sc.slackSeconds < 15) {
    issues.push({
      level: 'warning',
      path: 'schedule.slackSeconds',
      message:
        '唤醒冗余小于 15 秒。用户明确要求「宁晚勿早」——冗余太小会经常撞上「队伍还没回来」，' +
        '白跑一次开面板（约 750ms/帧）后还要退避重排，反而更慢。'
    })
  }
  if (sc.retryBackoffSeconds.length === 0) {
    issues.push({
      level: 'error',
      path: 'schedule.retryBackoffSeconds',
      message: '退避序列不能为空，否则队列没空时会原地疯狂重试。'
    })
  }
  if (sc.retryBackoffSeconds.some((n) => n < 5)) {
    issues.push({
      level: 'error',
      path: 'schedule.retryBackoffSeconds',
      message: '退避序列里每一项都必须 ≥ 5 秒。'
    })
  }
  for (let i = 1; i < sc.retryBackoffSeconds.length; i++) {
    if (sc.retryBackoffSeconds[i] < sc.retryBackoffSeconds[i - 1]) {
      issues.push({
        level: 'warning',
        path: 'schedule.retryBackoffSeconds',
        message: '退避序列不是递增的，指数退避的意义会被削弱。'
      })
      break
    }
  }
  if (sc.maxBackoffSeconds < 30) {
    issues.push({
      level: 'error',
      path: 'schedule.maxBackoffSeconds',
      message: '退避上限不能小于 30 秒。'
    })
  }
  if (sc.calibrateIntervalMin < 1) {
    issues.push({
      level: 'error',
      path: 'schedule.calibrateIntervalMin',
      message: '兜底校准间隔至少 1 分钟。'
    })
  }
  if (sc.jitterSeconds < 0) {
    issues.push({ level: 'error', path: 'schedule.jitterSeconds', message: '错峰抖动不能是负数。' })
  }
  if (sc.giveUpCooldownMin < 1) {
    issues.push({
      level: 'error',
      path: 'schedule.giveUpCooldownMin',
      message: '放弃后的冷却至少 1 分钟。'
    })
  }

  // 安全
  if (cfg.safety.unknownEtaFallbackSeconds < 60) {
    issues.push({
      level: 'error',
      path: 'safety.unknownEtaFallbackSeconds',
      message: '倒计时识别失败时的保守 ETA 至少 60 秒（宁晚勿早）。'
    })
  }
  if (cfg.safety.maxCapturesPerCycle < 6) {
    issues.push({
      level: 'error',
      path: 'safety.maxCapturesPerCycle',
      message: '单轮派兵截图上限至少 6 张，低于这个数一轮流程根本走不完。'
    })
  }
  if (cfg.safety.swipeRetry === 0) {
    issues.push({
      level: 'warning',
      path: 'safety.swipeRetry',
      message:
        '滑动重试设为 0。实测 adb input swipe 会偶发 SecurityException: INJECT_EVENTS，重试即成功；' +
        '设 0 等于把这种偶发失败直接变成整轮失败。'
    })
  }
  if (!cfg.safety.abortOnReconcileFail) {
    issues.push({
      level: 'warning',
      path: 'safety.abortOnReconcileFail',
      message:
        '关掉「对账复验失败即中止」后，「自动采集至清空」的勾选框可能被反复点开点关。建议保持开启。'
    })
  }

  return issues
}

/** 有没有会挡住保存的错误。 */
export function hasBlockingIssue(issues: readonly ConfigIssue[]): boolean {
  return issues.some((i) => i.level === 'error')
}

// ── 便于界面解释的派生说明 ──────────────────────────────────────────────────

/**
 * 用一句人话说明当前等级策略会搜到什么。
 * @param probedMaxLv 已探测到的等级上限；没探测过传 null，用 assumedMaxLevel。
 */
export function describeLevelPolicy(policy: LevelPolicy, probedMaxLv: number | null): string {
  if (policy.mode === 'absolute') {
    return (
      `固定按 ${policy.level} 级作为**搜索下限**去搜：${policy.level} 级及以上的点都算合格，` +
      `搜到 ${policy.level + 1}、${policy.level + 2} 级是好事，不是失败。` +
      (policy.allowRelax
        ? `连续搜不到时会把下限一路放宽到 ${policy.minLevel} 级。`
        : '已关闭放宽，搜不到就直接放弃本轮。')
    )
  }
  const maxLv = probedMaxLv ?? policy.assumedMaxLevel
  const floor = maxLv + policy.offset
  return (
    `当前等级上限按 ${maxLv} 计（${probedMaxLv === null ? '未探测，用假定值' : '已从滑杆探测'}），` +
    `搜索下限 = ${maxLv} ${policy.offset >= 0 ? '+' : '−'} ${Math.abs(policy.offset)} = ${floor} 级。` +
    `实际会采到 ${floor} 级及以上的点，采到 ${maxLv} 级收益更高、属于正常结果。` +
    `连续搜不到时下限逐步放宽，最低放到 ${policy.minLevel} 级。`
  )
}

/** 把储量数字写成「30 万」这种好读的形式。 */
export function formatStorage(n: number): string {
  if (n <= 0) return '不限制'
  if (n >= 100000000) return `${(n / 100000000).toFixed(2).replace(/\.?0+$/, '')} 亿`
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')} 万`
  return String(n)
}

/** 秒 -> 「10 分 0 秒」。 */
export function formatSeconds(n: number): string {
  if (n <= 0) return '不限制'
  const m = Math.floor(n / 60)
  const s = n % 60
  if (m === 0) return `${s} 秒`
  return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`
}
