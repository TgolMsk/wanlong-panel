/**
 * 告警配置与限流快照的磁盘读写：<dataDir>/alerts.json
 *
 * 写法照抄 src/main/scheduler/store.ts：
 *   全量读写 + 临时文件 rename + 进程内写串行化 + 读取一律容错。
 * 数据量是一份配置 + 几十条冷却记录，没必要上数据库。
 *
 * 为什么限流快照要落盘：AlertThrottle 是纯内存的。不落盘的话，面板一重启，
 * 一个还在坏状态里的实例会立刻再推一条 Telegram —— 用户重启几次就被轰炸几次。
 * 落盘之后冷却跨重启依然有效（lastSentAt 是**绝对时刻**，跨重启不失效）。
 *
 * ★★ 凭据纪律：本文件读写的 config.telegram.botToken 是凭据。
 *    · 任何日志、任何错误信息，一律先过 redactAlertsConfig() / maskToken()
 *    · 下面所有 AppError 的 message 里只有**路径**，没有内容 —— 不要为了"方便排查"
 *      把 JSON.stringify(config) 拼进报错，那等于把 token 写进日志。
 *
 * ★ 默认值只有一份权威：@shared/alerts 的 defaultAlertsConfig()。
 *   本文件**禁止**再写 { enabled: false, cooldownSeconds: 600, ... } 这类字面量。
 *   判定标准：全工程 grep `cooldownSeconds` 时出现具体数字 600 的地方只允许有一处。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@shared/errors'
import type { AlertsConfig, ThrottleEntry } from '@shared/alerts'
import { ALERTS_FILE, defaultAlertsConfig, normalizeAlertsConfig } from '@shared/alerts'

export interface AlertsFile {
  /** 结构版本，将来加字段时用来做迁移。当前 1。 */
  version: 1
  config: AlertsConfig
  /** 限流快照：dedupeKey -> 冷却记录。见 AlertThrottle.snapshot() / restore()。 */
  throttle: Record<string, ThrottleEntry>
  /** 读文件时发现的问题（中文），启动后由 NotifyHub 打到日志里。★ 里面绝不含 token。 */
  loadWarnings?: string[]
}

// ── 进程内写串行化：两处同时保存不会互相踩掉半个文件 ────────────────────────
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
  return join(dataDir, ALERTS_FILE)
}

function numOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

/**
 * 逐条容错还原限流快照。
 * 键的形状是 `${instanceIndex}:${alertType}`（见 alertDedupeKey），这里只做最基本的校验：
 * 键必须是非空字符串、值必须是对象。形状不对的直接丢掉 —— 丢掉的后果只是「早推一条」，
 * 远好过让一个坏字段把整份配置带下水。
 */
function sanitizeThrottle(raw: unknown, warnings: string[]): Record<string, ThrottleEntry> {
  const out: Record<string, ThrottleEntry> = {}
  if (typeof raw !== 'object' || raw === null) return out
  let dropped = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== 'string' || k === '' || typeof v !== 'object' || v === null) {
      dropped += 1
      continue
    }
    const e = v as Record<string, unknown>
    out[k] = {
      lastSentAt: numOr(e.lastSentAt, 0),
      suppressedCount: Math.max(0, Math.trunc(numOr(e.suppressedCount, 0))),
      lastSuppressedAt: typeof e.lastSuppressedAt === 'number' ? e.lastSuppressedAt : null
    }
  }
  if (dropped > 0) {
    warnings.push(`告警配置文件里有 ${dropped} 条推送冷却记录格式不对，已丢弃（最多导致早推一条）。`)
  }
  return out
}

/**
 * 读告警配置文件；文件不存在或损坏都返回默认值（并把原因写进 loadWarnings）。
 *
 * ★ 与 loadSettings 的浅合并不同，这里走 normalizeAlertsConfig 的**逐字段**容错：
 *   磁盘上只写了半截的 telegram 对象不会把整份配置带回默认值，缺哪个子键补哪个。
 *   （settings.json 那边「一个字段不合法就整体回退」的坑，本模块刻意避开。）
 */
export async function loadAlertsFile(dataDir: string): Promise<AlertsFile> {
  const path = fileOf(dataDir)
  const warnings: string[] = []
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // 第一次运行，还没有配置文件 —— 这不是错误。
      return { version: 1, config: defaultAlertsConfig(), throttle: {} }
    }
    throw new AppError('IO_ERROR', `读取告警配置文件失败：${path}`, { cause: String(e) })
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    warnings.push(`告警配置文件不是合法 JSON，已忽略并从默认值重建：${path}`)
    return { version: 1, config: defaultAlertsConfig(), throttle: {}, loadWarnings: warnings }
  }

  const o = (raw ?? {}) as Record<string, unknown>
  const config = normalizeAlertsConfig(o.config)
  const throttle = sanitizeThrottle(o.throttle, warnings)
  return { version: 1, config, throttle, loadWarnings: warnings.length ? warnings : undefined }
}

/**
 * 全量写回。调用方自己控制频率（本模块只在配置变更 / 推送成败之后写）。
 *
 * ★ 报错信息里只有路径，绝不含配置内容 —— 配置里有 token。
 */
export async function saveAlertsFile(dataDir: string, data: AlertsFile): Promise<void> {
  await serialize(async () => {
    const path = fileOf(dataDir)
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    try {
      await mkdir(dataDir, { recursive: true })
      const payload: AlertsFile = {
        version: 1,
        // 落盘前再归一化一次：无论调用方给了什么，磁盘上永远是合法结构。
        config: normalizeAlertsConfig(data.config),
        throttle: data.throttle ?? {}
      }
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await rename(tmp, path)
    } catch (e) {
      await unlink(tmp).catch(() => undefined)
      throw new AppError('IO_ERROR', `写入告警配置文件失败：${path}`, { cause: String(e) })
    }
  })
}

/** 告警配置文件的绝对路径。面板要提示「配置存在哪」时用。 */
export function alertsFilePath(dataDir: string): string {
  return fileOf(dataDir)
}
