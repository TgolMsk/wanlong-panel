/**
 * AI 顾问的配置与问询历史：<dataDir>/ai.json
 *
 * 写法照抄 src/main/alerts/store.ts：全量读写 + 临时文件 rename + 进程内写串行化 + 读取一律容错。
 *
 * ★★ 凭据纪律：config.apiKey 是凭据。任何报错信息里只有**路径**，没有内容。
 * ★ 默认值只有一份权威：@shared/ai 的 defaultAiConfig()。本文件禁止再写字面量。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@shared/errors'
import type { AiConfig, AiConsultRecord } from '@shared/ai'
import { AI_FILE, AI_HISTORY_LIMIT, defaultAiConfig, normalizeAiConfig } from '@shared/ai'

export interface AiFile {
  version: 1
  config: AiConfig
  /** 最近的问询记录，新的在前，最多 AI_HISTORY_LIMIT 条。 */
  history: AiConsultRecord[]
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

export function aiFilePath(dataDir: string): string {
  return join(dataDir, AI_FILE)
}

function sanitizeHistory(raw: unknown): AiConsultRecord[] {
  if (!Array.isArray(raw)) return []
  const out: AiConsultRecord[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.at !== 'number' || typeof o.outcome !== 'string')
      continue
    out.push({
      id: o.id,
      at: o.at,
      instanceIndex: typeof o.instanceIndex === 'number' ? o.instanceIndex : null,
      context: typeof o.context === 'string' ? o.context : '',
      outcome: o.outcome as AiConsultRecord['outcome'],
      message: typeof o.message === 'string' ? o.message : '',
      advice: (o.advice as AiConsultRecord['advice']) ?? null,
      harvestedTemplateId: typeof o.harvestedTemplateId === 'string' ? o.harvestedTemplateId : null,
      latencyMs: typeof o.latencyMs === 'number' ? o.latencyMs : 0
    })
    if (out.length >= AI_HISTORY_LIMIT) break
  }
  return out
}

export async function loadAiFile(dataDir: string): Promise<AiFile> {
  const path = aiFilePath(dataDir)
  const warnings: string[] = []
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, config: defaultAiConfig(), history: [] }
    }
    throw new AppError('IO_ERROR', `读取 AI 顾问配置文件失败：${path}`, { cause: String(e) })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    warnings.push(`AI 顾问配置文件不是合法 JSON，已忽略并从默认值重建：${path}`)
    return { version: 1, config: defaultAiConfig(), history: [], loadWarnings: warnings }
  }
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    version: 1,
    config: normalizeAiConfig(o.config),
    history: sanitizeHistory(o.history),
    loadWarnings: warnings.length ? warnings : undefined
  }
}

export async function saveAiFile(dataDir: string, data: AiFile): Promise<void> {
  await serialize(async () => {
    const path = aiFilePath(dataDir)
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    try {
      await mkdir(dataDir, { recursive: true })
      const payload: AiFile = {
        version: 1,
        config: normalizeAiConfig(data.config),
        history: (data.history ?? []).slice(0, AI_HISTORY_LIMIT)
      }
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await rename(tmp, path)
    } catch (e) {
      await unlink(tmp).catch(() => undefined)
      throw new AppError('IO_ERROR', `写入 AI 顾问配置文件失败：${path}`, { cause: String(e) })
    }
  })
}
