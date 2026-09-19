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
import { silentCall, toast } from '@/ipc/useIpc'
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
 * 绑定成功后的统一收尾。**三个绑定入口都必须调它**，否则会出现
 * 「从实例列表绑就搬、从账号页绑就不搬」这种说不清的差别：
 *   · views/InstanceAccountCell.tsx（实例列表那一列）
 *   · views/AccountsView.tsx 的 bind()（账号页「绑定实例」下拉）
 *   · views/AccountsView.tsx 的 submit()（账号编辑表单里的「绑定实例」）
 *
 * 它做两件事，都是为了同一个目的 —— **别让用户以为面板把采集配置弄丢了**：
 *   ① 本机存着、账号里没有 → 搬进账号（主进程只从绑定账号读配置，不搬就等于没配）
 *   ② 本机存着、账号里也有 → **不覆盖账号那份**（那份是正在生效的），
 *      但必须说出来 —— 否则用户刚在未绑状态下改好保存的那一版会被无声地晾在一边，
 *      界面上既看不到也不生效，全程零提示。
 */
export async function afterAccountBind(
  instanceIndex: number,
  accounts: readonly Account[],
  setAccounts: (list: Account[]) => void
): Promise<void> {
  const account = accounts.find((a) => a.instanceIndex === instanceIndex) ?? null
  if (!account) return
  if (!hasLocalGatherConfig(instanceIndex)) return

  const existing = account.scriptParams?.[GATHER_PARAM_SCOPE]?.[GATHER_PARAM_KEY]
  if (typeof existing === 'string' && existing.trim() !== '') {
    toast().warning(
      `账号「${account.name}」里本来就有一份采集配置，现在生效的是它。` +
        '本机还留着另一份（未绑账号时保存的），没有覆盖过去 —— ' +
        '要用本机那份，请打开采集配置核对后重新保存一次。'
    )
    return
  }

  const { raw } = readLocal(instanceIndex)
  if (typeof raw !== 'string' || raw.trim() === '') return
  const { config } = parseConfigJson(raw)
  try {
    const res = await saveGatherConfig(instanceIndex, accounts, config)
    if (res.accounts) setAccounts(res.accounts)
    try {
      window.localStorage.removeItem(localKey(instanceIndex))
    } catch {
      // 清不掉无所谓：账号里那份已经是权威的了，loadGatherConfig 也优先读账号。
    }
    toast().info(`本机存的采集配置已搬到账号「${account.name}」，以后跟着账号走。`)
  } catch (e) {
    // 搬不动不算绑定失败：绑定已经生效了，只是配置还留在本机。说清楚就行。
    toast().warning(
      `账号已绑定，但本机存的采集配置没能搬过去：${e instanceof Error ? e.message : String(e)}。` +
        '打开采集配置点一次「保存」即可把它写进账号。'
    )
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
