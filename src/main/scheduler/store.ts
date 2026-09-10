/**
 * 调度状态的磁盘读写：<dataDir>/scheduler.json
 *
 * 为什么要落盘：freeAt / gatherDoneAt 都是**绝对时刻**，面板重启后依然有效 ——
 * 一支 9 小时的采集队，重启面板不该让它退化成「不知道什么时候回来」。
 * 相对值（剩余多少秒）跨重启必然失效，所以本工程**只存绝对时刻**。
 *
 * 写法照抄 store/accounts.ts：全量读写 + 临时文件 rename + 进程内写串行化。
 * 数据量是几个实例 × 五行，没必要上数据库。
 *
 * 读取一律**容错**：文件损坏、字段缺失、类型不对，都退回默认值并在返回值里说明，
 * 绝不因为一个坏掉的缓存文件把面板卡死在启动阶段。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@shared/errors'
import type {
  InstanceQueueState,
  MarchResourceType,
  MarchState,
  SchedulerConfig
} from '@shared/scheduler'
import { defaultSchedulerConfig } from '@shared/scheduler'
import type { TravelHint } from './state'

export const SCHEDULER_FILE = 'scheduler.json'

export interface PersistedInstance {
  instanceIndex: number
  auto: boolean
  accountId: string | null
  queueUsed: number | null
  queueTotal: number | null
  marches: MarchState[]
  lastSampledAt: number
  travelHints: TravelHint[]
}

export interface SchedulerFile {
  version: 1
  config: SchedulerConfig
  instances: PersistedInstance[]
  /** 读文件时发现的问题（中文），启动后由调度器打到日志里。 */
  loadWarnings?: string[]
}

let chain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

function fileOf(dataDir: string): string {
  return join(dataDir, SCHEDULER_FILE)
}

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 逐字段合并配置：单个字段非法只回退这一个字段，不整体作废。 */
export function mergeConfig(
  base: SchedulerConfig,
  patch: Partial<SchedulerConfig> | undefined
): SchedulerConfig {
  const p = patch ?? {}
  const ladder = Array.isArray(p.retryBackoffSeconds)
    ? p.retryBackoffSeconds.filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
    : []
  return {
    slackSeconds: clamp(num(p.slackSeconds, base.slackSeconds), 0, 3600),
    retryBackoffSeconds: ladder.length > 0 ? ladder : base.retryBackoffSeconds,
    maxBackoffSeconds: clamp(num(p.maxBackoffSeconds, base.maxBackoffSeconds), 5, 3600),
    calibrateIntervalMin: clamp(num(p.calibrateIntervalMin, base.calibrateIntervalMin), 1, 720),
    healthProbeIntervalMin: clamp(
      num(p.healthProbeIntervalMin, base.healthProbeIntervalMin),
      0,
      120
    ),
    jitterSeconds: clamp(num(p.jitterSeconds, base.jitterSeconds), 0, 600),
    defaultTravelSeconds: clamp(num(p.defaultTravelSeconds, base.defaultTravelSeconds), 0, 7200),
    unknownEtaFallbackSeconds: clamp(
      num(p.unknownEtaFallbackSeconds, base.unknownEtaFallbackSeconds),
      10,
      86400
    ),
    minSampleIntervalMs: clamp(num(p.minSampleIntervalMs, base.minSampleIntervalMs), 1000, 600000),
    sampleTimeoutMs: clamp(num(p.sampleTimeoutMs, base.sampleTimeoutMs), 5000, 600000),
    closePanelAfterSample:
      typeof p.closePanelAfterSample === 'boolean'
        ? p.closePanelAfterSample
        : base.closePanelAfterSample,
    maxRows: clamp(num(p.maxRows, base.maxRows), 1, 8),
    readOptionalFields:
      typeof p.readOptionalFields === 'boolean' ? p.readOptionalFields : base.readOptionalFields,
    templateSetId: typeof p.templateSetId === 'string' ? p.templateSetId : base.templateSetId
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** 资源类型字段的白名单校验；不认识的值当 null（别让一个错字把整条记录废掉）。 */
function resourceOrNull(v: unknown): MarchResourceType | null {
  return v === 'wood' || v === 'gold' || v === 'iron' || v === 'mana' ? v : null
}

function sanitizeMarch(raw: unknown): MarchState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const slot = numOrNull(m.slot)
  if (slot == null) return null
  const status = m.status
  if (
    status !== 'gathering' &&
    status !== 'gatherMarching' &&
    status !== 'returning' &&
    status !== 'idle' &&
    status !== 'unknown'
  ) {
    return null
  }
  const src = m.travelTimeSource
  return {
    slot,
    status,
    statusText: typeof m.statusText === 'string' ? m.statusText : '',
    targetCoord: typeof m.targetCoord === 'string' ? m.targetCoord : null,
    troopCount: numOrNull(m.troopCount),
    commanders: Array.isArray(m.commanders)
      ? (m.commanders as unknown[]).map((c) => ({
          current: numOrNull((c as Record<string, unknown>)?.current),
          max: numOrNull((c as Record<string, unknown>)?.max)
        }))
      : [],
    remainingMs: numOrNull(m.remainingMs),
    resourceType: resourceOrNull(m.resourceType),
    fillRatio: numOrNull(m.fillRatio),
    timerEndsAt: numOrNull(m.timerEndsAt),
    gatherDoneAt: numOrNull(m.gatherDoneAt),
    freeAt: numOrNull(m.freeAt),
    travelTimeMs: numOrNull(m.travelTimeMs),
    travelTimeSource:
      src === 'dispatch' || src === 'observed' || src === 'fallback' || src === 'unrecorded'
        ? src
        : 'fallback',
    sampledAt: num(m.sampledAt, 0),
    warning: typeof m.warning === 'string' ? m.warning : undefined
  }
}

function sanitizeInstance(raw: unknown, warnings: string[]): PersistedInstance | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const idx = numOrNull(o.instanceIndex)
  if (idx == null) {
    warnings.push('调度缓存里有一条记录没有 instanceIndex，已跳过。')
    return null
  }
  const marchesRaw = Array.isArray(o.marches) ? o.marches : []
  const marches: MarchState[] = []
  for (const r of marchesRaw) {
    const m = sanitizeMarch(r)
    if (m) marches.push(m)
    else warnings.push(`实例 ${idx} 的一条队伍记录格式不对，已丢弃。`)
  }
  const hintsRaw = Array.isArray(o.travelHints) ? o.travelHints : []
  const travelHints: TravelHint[] = []
  for (const r of hintsRaw) {
    const h = r as Record<string, unknown>
    const ms = numOrNull(h?.travelTimeMs)
    if (ms == null) continue
    const s = h.source
    travelHints.push({
      travelTimeMs: ms,
      source: s === 'dispatch' || s === 'observed' || s === 'fallback' ? s : 'dispatch',
      at: num(h.at, 0),
      coord: typeof h.coord === 'string' ? h.coord : null,
      resourceType: resourceOrNull(h.resourceType)
    })
  }
  return {
    instanceIndex: idx,
    auto: o.auto === true,
    accountId: typeof o.accountId === 'string' ? o.accountId : null,
    queueUsed: numOrNull(o.queueUsed),
    queueTotal: numOrNull(o.queueTotal),
    marches,
    lastSampledAt: num(o.lastSampledAt, 0),
    travelHints
  }
}

/** 读调度文件；文件不存在或损坏都返回默认值（并把原因写进 loadWarnings）。 */
export async function loadSchedulerFile(dataDir: string): Promise<SchedulerFile> {
  const path = fileOf(dataDir)
  const warnings: string[] = []
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, config: defaultSchedulerConfig(), instances: [] }
    }
    throw new AppError('IO_ERROR', `读取调度状态文件失败：${path}`, { cause: String(e) })
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    warnings.push(`调度状态文件不是合法 JSON，已忽略并从默认值重建：${path}`)
    return { version: 1, config: defaultSchedulerConfig(), instances: [], loadWarnings: warnings }
  }

  const o = (raw ?? {}) as Record<string, unknown>
  const config = mergeConfig(defaultSchedulerConfig(), o.config as Partial<SchedulerConfig>)
  const instances: PersistedInstance[] = []
  if (Array.isArray(o.instances)) {
    for (const r of o.instances) {
      const inst = sanitizeInstance(r, warnings)
      if (inst) instances.push(inst)
    }
  }
  return { version: 1, config, instances, loadWarnings: warnings.length ? warnings : undefined }
}

/** 全量写回。调用方自己控制频率（本模块只在采样完成/配置变更时写）。 */
export async function saveSchedulerFile(dataDir: string, data: SchedulerFile): Promise<void> {
  await serialize(async () => {
    const path = fileOf(dataDir)
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    try {
      await mkdir(dataDir, { recursive: true })
      const payload: SchedulerFile = {
        version: 1,
        config: data.config,
        instances: data.instances
      }
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await rename(tmp, path)
    } catch (e) {
      await unlink(tmp).catch(() => undefined)
      throw new AppError('IO_ERROR', `写入调度状态文件失败：${path}`, { cause: String(e) })
    }
  })
}

/** 把运行时状态压成可落盘的形状。 */
export function toPersisted(
  state: InstanceQueueState,
  travelHints: TravelHint[]
): PersistedInstance {
  return {
    instanceIndex: state.instanceIndex,
    auto: state.auto,
    accountId: state.accountId,
    queueUsed: state.queueUsed,
    queueTotal: state.queueTotal,
    marches: state.marches,
    lastSampledAt: state.lastSampledAt,
    // 只留最近 8 条，够用且不会让文件无限长大。
    travelHints: [...travelHints].sort((a, b) => b.at - a.at).slice(0, 8)
  }
}
