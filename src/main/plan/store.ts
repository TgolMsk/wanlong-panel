/**
 * 计划表的磁盘读写：<dataDir>/plans.json
 *
 * 写法照抄 scheduler/store.ts：全量读写 + 临时文件 rename + 进程内写串行化。
 * 数据量是几个账号 × 几条任务，没必要上数据库。
 *
 * 读取一律**容错**：文件损坏、字段缺失、类型不对，都退回默认值并把原因写进 loadWarnings，
 * 绝不因为一个手改坏了的 plans.json 让面板起不来。
 * 手改这个文件是允许的（跟 templates/manifest.json 一样），所以每个字段都得挡住乱填。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@shared/errors'
import type { AccountPlan, ClockWindow, PlanConfig, PlanTask, TaskTrigger } from '@shared/plan'
import { PLAN_FILE, PLAN_RANGE, clampToRange, defaultPlanConfig, parseClock } from '@shared/plan'

/**
 * 任务的执行记账，跨重启保留。
 *
 * ★ 为什么必须落盘：补跑判定要靠 lastRunAt。不存的话，早上 8 点跑过的任务，
 *   8 点 05 分重启面板就会被当成「今天还没跑」再跑一遍。
 */
export interface PersistedTaskRuntime {
  accountId: string
  taskId: string
  lastRunAt: number | null
  lastEndedAt: number | null
  lastResult: 'succeeded' | 'failed' | 'aborted' | null
  lastError: string | null
  runs: number
  fails: number
}

export interface PlanFile {
  version: 1
  config: PlanConfig
  plans: AccountPlan[]
  runtime?: PersistedTaskRuntime[]
  /** 读文件时发现的问题（中文），启动后由计划器打到日志里。 */
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
  return join(dataDir, PLAN_FILE)
}

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/** 逐字段合并配置：单个字段非法只回退这一个字段，不整体作废。 */
export function mergePlanConfig(
  base: PlanConfig,
  patch: Partial<PlanConfig> | undefined
): PlanConfig {
  const p = patch ?? {}
  return {
    version: 1,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    preemptGraceMs: clampToRange(
      num(p.preemptGraceMs, base.preemptGraceMs),
      PLAN_RANGE.preemptGraceMs
    ),
    catchUpMs: clampToRange(num(p.catchUpMs, base.catchUpMs), PLAN_RANGE.catchUpMs),
    queueWaitMs: clampToRange(num(p.queueWaitMs, base.queueWaitMs), PLAN_RANGE.queueWaitMs),
    retry: clampToRange(num(p.retry, base.retry), PLAN_RANGE.retry),
    retryDelayMs: clampToRange(num(p.retryDelayMs, base.retryDelayMs), PLAN_RANGE.retryDelayMs),
    aiAssist: typeof p.aiAssist === 'boolean' ? p.aiAssist : base.aiAssist
  }
}

function sanitizeWindow(raw: unknown): ClockWindow | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const from = str(o.from)
  const to = str(o.to)
  if (from == null || to == null) return undefined
  if (parseClock(from) == null || parseClock(to) == null) return undefined
  return { from, to }
}

/** 触发方式容错：认不出的一律退回「仅手动」—— 宁可不跑，也不能按猜出来的时间乱跑。 */
export function sanitizeTrigger(raw: unknown, warn: (m: string) => void): TaskTrigger {
  if (typeof raw !== 'object' || raw === null) return { kind: 'manual' }
  const o = raw as Record<string, unknown>
  if (o.kind === 'daily') {
    const at = Array.isArray(o.at)
      ? (o.at as unknown[]).map(str).filter((v): v is string => v != null && parseClock(v) != null)
      : []
    if (at.length === 0) {
      warn('有一条「每天」任务没给合法时刻（要 HH:MM），已改成仅手动。')
      return { kind: 'manual' }
    }
    // 去重 + 排序，面板显示和触发顺序才稳定。
    return { kind: 'daily', at: [...new Set(at)].sort() }
  }
  if (o.kind === 'interval') {
    const every = clampToRange(num(o.everyMinutes, 60), PLAN_RANGE.everyMinutes)
    return { kind: 'interval', everyMinutes: every, window: sanitizeWindow(o.window) }
  }
  return { kind: 'manual' }
}

function sanitizeParams(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'boolean') out[k] = v
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeTask(raw: unknown, warn: (m: string) => void): PlanTask | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const id = str(o.id)
  const scriptId = str(o.scriptId)
  if (id == null || scriptId == null) {
    warn('计划表里有一条任务缺 id 或 scriptId，已跳过。')
    return null
  }
  return {
    id,
    scriptId,
    enabled: o.enabled === true,
    trigger: sanitizeTrigger(o.trigger, warn),
    priority: clampToRange(num(o.priority, 50), PLAN_RANGE.priority),
    params: sanitizeParams(o.params),
    maxRunMinutes: clampToRange(num(o.maxRunMinutes, 30), PLAN_RANGE.maxRunMinutes),
    note: str(o.note) ?? undefined
  }
}

export function sanitizePlan(raw: unknown, warn: (m: string) => void): AccountPlan | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const accountId = str(o.accountId)
  if (accountId == null) {
    warn('计划表里有一条记录没有 accountId，已跳过。')
    return null
  }
  const tasks: PlanTask[] = []
  const seen = new Set<string>()
  if (Array.isArray(o.tasks)) {
    for (const r of o.tasks) {
      const t = sanitizeTask(r, warn)
      if (!t) continue
      if (seen.has(t.id)) {
        warn(`账号 ${accountId} 的任务 id「${t.id}」重复，已丢弃后一条。`)
        continue
      }
      seen.add(t.id)
      tasks.push(t)
    }
  }
  return {
    accountId,
    enabled: o.enabled === true,
    tasks,
    updatedAt: num(o.updatedAt, 0)
  }
}

function sanitizeRuntime(raw: unknown): PersistedTaskRuntime | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const accountId = str(o.accountId)
  const taskId = str(o.taskId)
  if (accountId == null || taskId == null) return null
  const r = o.lastResult
  return {
    accountId,
    taskId,
    lastRunAt: typeof o.lastRunAt === 'number' && Number.isFinite(o.lastRunAt) ? o.lastRunAt : null,
    lastEndedAt:
      typeof o.lastEndedAt === 'number' && Number.isFinite(o.lastEndedAt) ? o.lastEndedAt : null,
    lastResult: r === 'succeeded' || r === 'failed' || r === 'aborted' ? r : null,
    lastError: str(o.lastError),
    runs: Math.max(0, Math.round(num(o.runs, 0))),
    fails: Math.max(0, Math.round(num(o.fails, 0)))
  }
}

/** 读计划文件；文件不存在或损坏都返回默认值（并把原因写进 loadWarnings）。 */
export async function loadPlanFile(dataDir: string): Promise<PlanFile> {
  const path = fileOf(dataDir)
  const warnings: string[] = []
  const warn = (m: string): void => {
    warnings.push(m)
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, config: defaultPlanConfig(), plans: [] }
    }
    throw new AppError('IO_ERROR', `读取计划文件失败：${path}`, { cause: String(e) })
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    warn(`计划文件不是合法 JSON，已忽略并从默认值重建：${path}`)
    return { version: 1, config: defaultPlanConfig(), plans: [], loadWarnings: warnings }
  }

  const o = (raw ?? {}) as Record<string, unknown>
  const config = mergePlanConfig(defaultPlanConfig(), o.config as Partial<PlanConfig>)
  const plans: AccountPlan[] = []
  const seen = new Set<string>()
  if (Array.isArray(o.plans)) {
    for (const r of o.plans) {
      const p = sanitizePlan(r, warn)
      if (!p) continue
      if (seen.has(p.accountId)) {
        warn(`账号 ${p.accountId} 有两份计划，已丢弃后一份。`)
        continue
      }
      seen.add(p.accountId)
      plans.push(p)
    }
  }
  const runtime: PersistedTaskRuntime[] = []
  if (Array.isArray(o.runtime)) {
    for (const r of o.runtime) {
      const v = sanitizeRuntime(r)
      if (v) runtime.push(v)
    }
  }
  return {
    version: 1,
    config,
    plans,
    runtime,
    loadWarnings: warnings.length ? warnings : undefined
  }
}

/** 全量写回。调用方自己控制频率（本模块只在计划变更 / 配置变更时写）。 */
export async function savePlanFile(dataDir: string, data: PlanFile): Promise<void> {
  await serialize(async () => {
    const path = fileOf(dataDir)
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    try {
      await mkdir(dataDir, { recursive: true })
      const payload: PlanFile = {
        version: 1,
        config: data.config,
        plans: data.plans,
        runtime: data.runtime ?? []
      }
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await rename(tmp, path)
    } catch (e) {
      await unlink(tmp).catch(() => undefined)
      throw new AppError('IO_ERROR', `写入计划文件失败：${path}`, { cause: String(e) })
    }
  })
}

export function planFilePath(dataDir: string): string {
  return fileOf(dataDir)
}
