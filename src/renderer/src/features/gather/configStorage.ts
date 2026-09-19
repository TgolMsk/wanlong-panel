/**
 * 采集配置的读写。
 *
 * ★ 现状说明（重要，别把它当成最终形态）：
 *   已冻结的 52 条 IPC 通道里**没有**「采集配置」这一类的读写通道，主进程也还没有
 *   对应的 store 模块。为了让面板现在就能用、并且数据是真的存下来的（不是假 UI），
 *   这里走一条**不改任何冻结契约**的路：
 *
 *     实例已绑定账号 → 存进 `Account.scriptParams['gather'].configJson`（一段 JSON 字符串），
 *                       通过既有的 `account:save` 通道落盘到 accounts.json。
 *     实例没绑账号   → 退回 localStorage，并在界面上明确告诉用户「这份配置只留在本机浏览器
 *                       存储里，换机器就没了，建议先给实例绑一个账号」。
 *
 *   `Account.scriptParams` 的类型是 `Record<string, Record<string, string|number|boolean>>`，
 *   存不了嵌套结构，所以只能塞一段 JSON 字符串。这是**权宜之计**，等主进程加了
 *   `gather:getConfig` / `gather:saveConfig` 通道（或 `store/gather.ts`）之后，
 *   只需要把本文件的 loadGatherConfig / saveGatherConfig 两个函数换成 IPC 调用，
 *   上层组件一行都不用动。
 *
 * 错误处理原则：读失败一律回落默认配置并把中文原因报出去（绝不静默吞），
 * 写失败把中文原因抛给调用方去弹提示。
 */

import type { Account } from '@shared/domain'
import { silentCall } from '@/ipc/useIpc'
import { defaultGatherConfig, normalizeGatherConfig, type GatherConfig } from './config'

/** 存在 Account.scriptParams 下的哪个键。它不是真的脚本 id，只是一个命名空间。 */
export const GATHER_PARAM_SCOPE = 'gather'
/** 命名空间里存 JSON 字符串的字段名。 */
export const GATHER_PARAM_KEY = 'configJson'
/** 没有绑定账号时的 localStorage 键前缀。 */
const LOCAL_KEY_PREFIX = 'wl.gather.config.instance.'

export type GatherConfigOrigin = 'account' | 'local' | 'default'

export interface LoadedGatherConfig {
  config: GatherConfig
  /** 这份配置是从哪读来的，界面据此提示用户。 */
  origin: GatherConfigOrigin
  /** 绑定的账号（origin === 'account' 时非 null）。 */
  account: Account | null
  /** 读取过程中的中文警告（例如「存的 JSON 解析失败，已回落默认值」）。 */
  warning: string | null
}

function localKey(instanceIndex: number): string {
  return `${LOCAL_KEY_PREFIX}${instanceIndex}`
}

function readLocal(instanceIndex: number): { raw: string | null; warning: string | null } {
  try {
    return { raw: window.localStorage.getItem(localKey(instanceIndex)), warning: null }
  } catch (e) {
    return {
      raw: null,
      warning: `读取本机存储失败（${e instanceof Error ? e.message : String(e)}），已使用默认配置。`
    }
  }
}

function writeLocal(instanceIndex: number, json: string): void {
  try {
    window.localStorage.setItem(localKey(instanceIndex), json)
  } catch (e) {
    throw new Error(
      `写入本机存储失败：${e instanceof Error ? e.message : String(e)}。` +
        '建议给这个实例绑定一个账号，配置就会随 accounts.json 一起落盘。'
    )
  }
}

/** 从一段 JSON 字符串还原配置。解析失败不抛，回落默认并给出中文原因。 */
function parseConfigJson(json: string): { config: GatherConfig; warning: string | null } {
  try {
    const parsed: unknown = JSON.parse(json)
    return { config: normalizeGatherConfig(parsed), warning: null }
  } catch (e) {
    return {
      config: defaultGatherConfig(),
      warning:
        `已保存的采集配置解析失败（${e instanceof Error ? e.message : String(e)}），` +
        '已回落到默认配置。保存一次即可覆盖掉损坏的数据。'
    }
  }
}

/**
 * 读一个实例的采集配置。
 * @param accounts 面板已有的账号列表（appStore.accounts），避免为了读配置再打一次 IPC。
 */
export function loadGatherConfig(
  instanceIndex: number,
  accounts: readonly Account[]
): LoadedGatherConfig {
  const account = accounts.find((a) => a.instanceIndex === instanceIndex) ?? null

  if (account) {
    const raw = account.scriptParams?.[GATHER_PARAM_SCOPE]?.[GATHER_PARAM_KEY]
    if (typeof raw === 'string' && raw.trim() !== '') {
      const { config, warning } = parseConfigJson(raw)
      return { config, origin: 'account', account, warning }
    }
    return {
      config: defaultGatherConfig(),
      origin: 'default',
      account,
      warning: null
    }
  }

  const { raw, warning } = readLocal(instanceIndex)
  if (raw !== null && raw.trim() !== '') {
    const parsed = parseConfigJson(raw)
    return {
      config: parsed.config,
      origin: 'local',
      account: null,
      warning: parsed.warning
    }
  }
  return { config: defaultGatherConfig(), origin: 'default', account: null, warning }
}

export interface SaveResult {
  origin: GatherConfigOrigin
  /** 保存后账号对象（origin === 'account' 时非 null），调用方可以用它刷新 store。 */
  accounts: Account[] | null
  /** 中文提示，直接显示给用户。 */
  message: string
}

/**
 * 保存一个实例的采集配置。
 * 失败一律 throw Error（中文消息），调用方负责弹提示 —— 不要在这里吞异常。
 */
export async function saveGatherConfig(
  instanceIndex: number,
  accounts: readonly Account[],
  config: GatherConfig
): Promise<SaveResult> {
  const json = JSON.stringify(config)
  const account = accounts.find((a) => a.instanceIndex === instanceIndex) ?? null

  if (!account) {
    writeLocal(instanceIndex, json)
    return {
      origin: 'local',
      accounts: null,
      message:
        '已保存到本机存储。这个实例还没绑定账号，配置不会随 accounts.json 落盘 —— ' +
        '建议到「账号」页给它绑一个账号，配置才能跟着账号走。'
    }
  }

  // ★ 必须基于最新的账号对象做合并，不能拿页面上缓存的旧值整体覆盖，
  //   否则会把别人（或别的页签）刚改的账号字段冲掉。
  const patched: Account = {
    ...account,
    scriptParams: {
      ...(account.scriptParams ?? {}),
      [GATHER_PARAM_SCOPE]: {
        ...(account.scriptParams?.[GATHER_PARAM_SCOPE] ?? {}),
        [GATHER_PARAM_KEY]: json
      }
    },
    updatedAt: Date.now()
  }

  try {
    await silentCall('account:save', patched)
  } catch (e) {
    const msg = (e as { message?: string }).message ?? String(e)
    throw new Error(`保存到账号「${account.name}」失败：${msg}`)
  }

  let refreshed: Account[] | null = null
  try {
    refreshed = await silentCall('account:list')
  } catch {
    // 列表刷新失败不算保存失败，配置已经落盘了。调用方自己 refreshAccounts 即可。
    refreshed = null
  }

  return {
    origin: 'account',
    accounts: refreshed,
    message: `已保存到账号「${account.name}」，随 accounts.json 落盘。`
  }
}

/** 本机存储里有没有这个实例的采集配置（未绑账号时保存会落在这里）。 */
export function hasLocalGatherConfig(instanceIndex: number): boolean {
  const { raw } = readLocal(instanceIndex)
  return typeof raw === 'string' && raw.trim() !== ''
}

/**
 * 刚给实例绑上账号时，把本机存的那份采集配置搬到账号里。
 *
 * ★ 为什么必须搬：未绑账号时保存的配置落在 localStorage，而**主进程只从绑定账号里读配置**。
 *   不搬的话，用户在实例列表里一绑账号，界面上的配置就会「变回默认值」——
 *   看起来像面板把设置弄丢了（2026-09-18 那次「本地有配置了却搜不到」就是这种困惑）。
 *
 * 只在账号里**还没有**采集配置时搬，绝不覆盖账号上已有的那份（那是更权威的一份）。
 * 搬完清掉本机那份，避免下次解绑又读到一份过期的。
 *
 * @returns null = 没东西可搬（本机没存 / 账号已有配置 / 没绑上账号）；否则带中文说明。
 */
export async function migrateLocalConfigToAccount(
  instanceIndex: number,
  accounts: readonly Account[]
): Promise<{ accounts: Account[] | null; message: string } | null> {
  const account = accounts.find((a) => a.instanceIndex === instanceIndex) ?? null
  if (!account) return null

  const existing = account.scriptParams?.[GATHER_PARAM_SCOPE]?.[GATHER_PARAM_KEY]
  if (typeof existing === 'string' && existing.trim() !== '') return null

  const { raw } = readLocal(instanceIndex)
  if (typeof raw !== 'string' || raw.trim() === '') return null

  const { config } = parseConfigJson(raw)
  const res = await saveGatherConfig(instanceIndex, accounts, config)
  try {
    window.localStorage.removeItem(localKey(instanceIndex))
  } catch {
    // 清不掉无所谓：账号里那份已经是权威的了，下次 loadGatherConfig 也优先读账号。
  }
  return {
    accounts: res.accounts,
    message: `本机存的采集配置已搬到账号「${account.name}」，以后跟着账号走。`
  }
}

/** 导出成便于粘贴/备份的 JSON 文本。 */
export function exportGatherConfig(config: GatherConfig): string {
  return JSON.stringify(config, null, 2)
}

/** 从粘贴进来的 JSON 文本导入。格式不对时抛中文错误。 */
export function importGatherConfig(text: string): GatherConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('顶层必须是一个 JSON 对象。')
  }
  const version = (parsed as Record<string, unknown>).version
  if (version !== undefined && version !== 2) {
    throw new Error(
      `配置版本是 ${String(version)}，当前面板只认 version = 2（缺失的字段会补默认值）。`
    )
  }
  return normalizeGatherConfig(parsed)
}
