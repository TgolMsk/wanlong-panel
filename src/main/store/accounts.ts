/**
 * 账号的磁盘读写：<dataDir>/accounts/accounts.json
 *
 * 设计要点：
 *  · 全量读 / 全量写。账号量级是几十，没必要上数据库。
 *  · 每次写都走「临时文件 + rename」，避免断电/崩溃留下半截 JSON。
 *  · 所有写操作在本模块内串行化（同一进程里可能有多个 IPC 并发调用），避免丢更新。
 *  · **一个实例同时只能绑一个账号**：任何把账号绑到实例 N 的操作，都会把其他账号在 N 上的绑定解掉。
 *
 * 本模块不注册 IPC handler（那是模块 e 的事），只导出纯函数，目录由调用方传入。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ACCOUNTS_FILE } from '@shared/constants'
import { AppError } from '@shared/errors'
import { accountsFileSchema, parseOrThrow } from '@shared/schemas'
import type { Account } from '@shared/domain'

interface AccountsFile {
  version: 1
  accounts: Account[]
}

/** 同一进程内的写串行化，防止「读-改-写」竞态丢更新。 */
let chain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  // 无论成败都让链继续，别让一次失败卡死后续所有写入。
  chain = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

function fileOf(accountsDir: string): string {
  return join(accountsDir, ACCOUNTS_FILE)
}

async function readFileRaw(accountsDir: string): Promise<AccountsFile> {
  const path = fileOf(accountsDir)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accounts: [] }
    throw new AppError('IO_ERROR', `读取账号文件失败：${path}`, { cause: String(e) })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new AppError('IO_ERROR', `账号文件不是合法 JSON，请检查或删除后重建：${path}`)
  }
  return parseOrThrow(accountsFileSchema, raw, '账号文件') as AccountsFile
}

async function writeFileRaw(accountsDir: string, data: AccountsFile): Promise<void> {
  const path = fileOf(accountsDir)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await mkdir(accountsDir, { recursive: true })
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  } catch (e) {
    // 临时文件残留会污染目录，尽量清掉；清不掉也不要盖住原始错误。
    await unlink(tmp).catch(() => undefined)
    throw new AppError('IO_ERROR', `写入账号文件失败：${path}`, { cause: String(e) })
  }
}

/** 解除除 keepId 之外所有账号在 instanceIndex 上的绑定。返回是否发生了改动。 */
function unbindOthers(accounts: Account[], instanceIndex: number, keepId: string): boolean {
  let changed = false
  const now = Date.now()
  for (const a of accounts) {
    if (a.id !== keepId && a.instanceIndex === instanceIndex) {
      a.instanceIndex = null
      if (a.setup) {
        a.setup = { status: 'pending', instanceIdentity: null, verifiedAt: null }
        a.enabled = false
      }
      a.updatedAt = now
      changed = true
    }
  }
  return changed
}

// ── 对外 API ──────────────────────────────────────────────────────────────

export async function listAccounts(accountsDir: string): Promise<Account[]> {
  const f = await readFileRaw(accountsDir)
  return f.accounts
}

export async function getAccount(accountsDir: string, accountId: string): Promise<Account | null> {
  const f = await readFileRaw(accountsDir)
  return f.accounts.find((a) => a.id === accountId) ?? null
}

/**
 * 新增或更新一个账号（按 id upsert）。
 * 若 account.instanceIndex 非 null，会自动把其他账号在该实例上的绑定解掉。
 */
export async function saveAccount(accountsDir: string, account: Account): Promise<Account> {
  return serialize(async () => {
    const f = await readFileRaw(accountsDir)
    const now = Date.now()
    const idx = f.accounts.findIndex((a) => a.id === account.id)
    const merged: Account = {
      ...account,
      // 初始化状态只能由登录流程更新，普通表单不能伪造或覆盖。
      setup: idx >= 0 ? f.accounts[idx].setup : undefined,
      createdAt: idx >= 0 ? f.accounts[idx].createdAt : account.createdAt || now,
      updatedAt: now
    }
    if (merged.setup && f.accounts[idx].instanceIndex !== merged.instanceIndex) {
      merged.setup = { status: 'pending', instanceIdentity: null, verifiedAt: null }
    }
    if (merged.setup?.status === 'pending') merged.enabled = false
    if (idx >= 0) f.accounts[idx] = merged
    else f.accounts.push(merged)

    if (merged.instanceIndex !== null) unbindOthers(f.accounts, merged.instanceIndex, merged.id)

    // 落盘前再过一遍 schema：宁可在这里报错，也不要写出一份下次启动读不回来的文件。
    const checked = parseOrThrow(accountsFileSchema, f, '账号文件') as AccountsFile
    await writeFileRaw(accountsDir, checked)
    return merged
  })
}

export async function deleteAccount(accountsDir: string, accountId: string): Promise<void> {
  return serialize(async () => {
    const f = await readFileRaw(accountsDir)
    const next = f.accounts.filter((a) => a.id !== accountId)
    if (next.length === f.accounts.length) {
      throw new AppError('NOT_FOUND', `要删除的账号不存在：${accountId}`)
    }
    await writeFileRaw(accountsDir, { version: 1, accounts: next })
  })
}

/**
 * 把账号绑到某个实例；instanceIndex 传 null 表示解绑。
 * 返回改动后的完整账号列表（面板直接拿去刷新，省一次往返）。
 */
export async function bindAccount(
  accountsDir: string,
  accountId: string,
  instanceIndex: number | null
): Promise<Account[]> {
  return serialize(async () => {
    const f = await readFileRaw(accountsDir)
    const target = f.accounts.find((a) => a.id === accountId)
    if (!target) throw new AppError('NOT_FOUND', `要绑定的账号不存在：${accountId}`)

    const now = Date.now()
    if (target.setup && target.instanceIndex !== instanceIndex) {
      target.setup = { status: 'pending', instanceIdentity: null, verifiedAt: null }
      target.enabled = false
    }
    target.instanceIndex = instanceIndex
    target.updatedAt = now
    if (instanceIndex !== null) unbindOthers(f.accounts, instanceIndex, accountId)

    await writeFileRaw(accountsDir, f)
    return f.accounts
  })
}

/** 反查某个实例当前绑定的账号。执行脚本时用来给日志打上账号名。 */
export async function accountOfInstance(
  accountsDir: string,
  instanceIndex: number
): Promise<Account | null> {
  const f = await readFileRaw(accountsDir)
  return f.accounts.find((a) => a.instanceIndex === instanceIndex) ?? null
}

/** 登录向导专用的原子绑定：只绑定空闲实例，不抢占其他账号。 */
export async function prepareLoginAccount(
  accountsDir: string,
  input: {
    accountId: string
    name?: string
    instanceIndex: number
    identity: string | null
    packageName: string
  }
): Promise<Account> {
  return serialize(async () => {
    const f = await readFileRaw(accountsDir)
    let target = f.accounts.find((a) => a.id === input.accountId)
    const owner = f.accounts.find(
      (a) => a.instanceIndex === input.instanceIndex && a.id !== input.accountId
    )
    if (owner)
      throw new AppError(
        'INVALID_ARGUMENT',
        `实例已绑定「${owner.name}」，请使用该账号继续登录，或先解除原绑定。`
      )
    if (
      target?.instanceIndex !== null &&
      target?.instanceIndex !== undefined &&
      target.instanceIndex !== input.instanceIndex
    ) {
      throw new AppError('INVALID_ARGUMENT', '该账号已绑定其他实例，请先解除绑定。')
    }
    if (target?.packageName && target.packageName !== input.packageName) {
      throw new AppError(
        'INVALID_ARGUMENT',
        '当前登录向导适用于《万龙觉醒》国服，请检查账号的游戏包名。'
      )
    }
    const now = Date.now()
    if (!target) {
      if (!input.name?.trim()) throw new AppError('INVALID_ARGUMENT', '请填写新账号名称。')
      target = {
        id: input.accountId,
        name: input.name.trim(),
        instanceIndex: null,
        enabled: false,
        createdAt: now,
        updatedAt: now
      }
      f.accounts.push(target)
    }
    target.instanceIndex = input.instanceIndex
    target.packageName = input.packageName
    target.setup = { status: 'pending', instanceIdentity: input.identity, verifiedAt: null }
    target.enabled = false
    target.updatedAt = now
    await writeFileRaw(accountsDir, parseOrThrow(accountsFileSchema, f, '账号文件') as AccountsFile)
    return target
  })
}

/** 验证后再启用账号；绑定关系变化时拒绝把验证结果写到别的实例上。 */
export async function completeLoginAccount(
  accountsDir: string,
  id: string,
  instanceIndex: number,
  identity: string | null
): Promise<Account> {
  return serialize(async () => {
    const f = await readFileRaw(accountsDir)
    const target = f.accounts.find((a) => a.id === id)
    if (
      !target ||
      target.instanceIndex !== instanceIndex ||
      !target.setup ||
      target.setup.instanceIdentity !== identity
    ) {
      throw new AppError('INVALID_ARGUMENT', '账号绑定已改变，请重新开始登录向导。')
    }
    const now = Date.now()
    target.setup = { status: 'ready', instanceIdentity: identity, verifiedAt: now }
    target.enabled = true
    target.updatedAt = now
    await writeFileRaw(accountsDir, f)
    return target
  })
}
