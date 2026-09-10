/**
 * 账号通道 —— 转发给模块 d 的账号存储。
 *
 * 账号与实例是 1:1 绑定（一个实例同时只跑一个账号），绑定关系变化后要把
 * accountId 回填进实例注册表，面板的实例卡片才会显示「当前账号」。
 */

import { accountSchema, parseOrThrow } from '@shared/schemas'
import { AppError } from '@shared/errors'
import { CH } from '@shared/ipc'
import { handle } from '@main/ipc'
import type { MainDeps } from './index'

export function registerAccountHandlers(deps: MainDeps): void {
  handle(CH.accountList, () => deps.accounts.list())

  handle(CH.accountSave, (account) => {
    const checked = parseOrThrow(accountSchema, account, '账号')
    if (!checked.name.trim()) throw new AppError('INVALID_ARGUMENT', '账号名称不能为空。')
    return deps.accounts.save(checked)
  })

  handle(CH.accountDelete, async (accountId) => {
    await deps.accounts.remove(accountId)
    await syncBindings(deps)
  })

  handle(CH.accountBind, async (accountId, instanceIndex) => {
    // bind 内部会把同一个实例上的其它账号解绑，所以要拿它返回的完整列表来同步。
    const accounts = await deps.accounts.bind(accountId, instanceIndex)
    applyBindings(deps, accounts)
    return accounts
  })
}

// ── 内部 ─────────────────────────────────────────────────────────────────

async function syncBindings(deps: MainDeps): Promise<void> {
  try {
    applyBindings(deps, await deps.accounts.list())
  } catch (e) {
    console.warn('[account] 同步实例上的账号绑定失败：', e)
  }
}

/** 把「实例 -> 账号」的映射写回实例注册表；没绑账号的实例显式置 null。 */
function applyBindings(
  deps: MainDeps,
  accounts: { id: string; instanceIndex: number | null }[]
): void {
  const byIndex = new Map<number, string>()
  for (const a of accounts) {
    if (a.instanceIndex !== null) byIndex.set(a.instanceIndex, a.id)
  }
  for (const inst of deps.mumu.list()) {
    deps.mumu.patch(inst.index, { accountId: byIndex.get(inst.index) ?? null })
  }
}
