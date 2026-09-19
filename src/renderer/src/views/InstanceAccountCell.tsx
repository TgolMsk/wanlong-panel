/**
 * 实例列表「绑定账号」列里的内联下拉。
 *
 * 用户原话：「模拟器实例列表可以直接配置账号，不需要切到账号页绑定」。
 * 所以这一列从只读标签变成可直接改的 Select：选一个账号就绑上，选「未绑定」就解绑，
 * 选「新建账号并绑定」当场建一个（只问名字，其它字段到「账号管理」页再补）。
 *
 * 三件必须守住的事：
 *   1. **绑定是一对一的** —— 选一个已经绑在别的实例上的账号 = 把它改绑过来，
 *      所以选项里要写清「已绑定 #2，选中将改绑」，不能让人以为是复制一份。
 *   2. **主进程 account:bind 不发 account:changed**（全工程唯一一处 emit 在登录那条链路），
 *      所以这里必须拿返回值自己 setAccounts，否则界面要等下次刷新才变。
 *   3. **绑上账号要把本机存的采集配置搬过去** —— 主进程只从绑定账号里读采集配置，
 *      不搬的话用户一绑账号就会发现「配置变回默认了」，像是面板把设置弄丢了。
 *
 * ★ 登录向导正在跑时**不预先禁用**：能不能改由主进程的 login.assertEditable 说，
 *   让它那句中文错误原样冒泡出来，比在界面上猜一个禁用条件准。
 */

import { useState } from 'react'
import { Modal, Select, Input, Tooltip } from 'antd'
import type { Account } from '@shared/domain'
import { makeId } from '@shared/defaults'
import { call, toast, tryCall } from '@/ipc/useIpc'
import { isInstanceUp, useAppStore } from '@/store/appStore'
import { afterAccountBind } from '@/features/gather'

/** 下拉里的两个特殊项。账号 id 都是 `acc_` 前缀，不会撞。 */
const NONE = '__none__'
const CREATE = '__create__'

export interface InstanceAccountCellProps {
  instanceIndex: number
  /** 这一行当前绑着的账号，没有为 null。 */
  account: Account | null
  /** 禁用原因（中文）；null = 可用。禁用时鼠标悬停会解释为什么不能改。 */
  disabledReason: string | null
  /** 绑定关系变化后（含新建）回调，用来刷新采集配置角标之类的派生数据。 */
  onChanged?: (instanceIndex: number) => void
}

export default function InstanceAccountCell({
  instanceIndex,
  account,
  disabledReason,
  onChanged
}: InstanceAccountCellProps): React.JSX.Element {
  const accounts = useAppStore((s) => s.accounts)
  const instances = useAppStore((s) => s.instances)
  const setAccounts = useAppStore((s) => s.setAccounts)
  const refreshAccounts = useAppStore((s) => s.refreshAccounts)

  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')

  /** 绑定成功后的收尾。搬配置那段与账号页共用 afterAccountBind，两个入口行为必须一样。 */
  const afterBind = async (list: Account[]): Promise<void> => {
    setAccounts(list)
    await afterAccountBind(instanceIndex, list, setAccounts)
    onChanged?.(instanceIndex)
  }

  const bind = async (accountId: string, index: number | null): Promise<void> => {
    setBusy(true)
    try {
      const list = await tryCall('account:bind', accountId, index)
      if (list) {
        if (index === null) {
          // ★ 说清配置去哪了：解绑后采集配置仍留在账号里，界面上却会显示成默认值
          //   （主进程与本页都只从绑定账号读配置），不说的话看起来就像被清空了。
          const name = accounts.find((a) => a.id === accountId)?.name ?? '该账号'
          toast().success(`已解除绑定。采集配置仍留在账号「${name}」里，绑回它就会回来。`)
          setAccounts(list)
          onChanged?.(instanceIndex)
        } else {
          toast().success(`已绑定到实例 ${index}`)
          await afterBind(list)
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const onSelect = (value: string): void => {
    if (value === NONE) {
      if (account) void bind(account.id, null)
      return
    }
    if (value === CREATE) {
      setNewName('')
      setCreateOpen(true)
      return
    }
    void bind(value, instanceIndex)
  }

  const createAndBind = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) {
      toast().warning('给账号起个名字，比如「主号-王朝A区」。')
      return
    }
    setBusy(true)
    try {
      const now = Date.now()
      // 直接带 instanceIndex 建，省一次 bind 往返；一对一冲突由主进程判。
      const created = await call('account:save', {
        id: makeId('acc'),
        name,
        instanceIndex,
        enabled: true,
        createdAt: now,
        updatedAt: now
      } satisfies Account)
      setCreateOpen(false)
      toast().success(`账号「${created.name}」已创建并绑定到实例 ${instanceIndex}`)
      const list = await tryCall('account:list')
      if (list) await afterBind(list)
      else await refreshAccounts()
    } catch {
      /* call 已经弹过中文错误 */
    } finally {
      setBusy(false)
    }
  }

  const options = [
    { value: NONE, label: account ? '解除绑定' : '未绑定' },
    ...accounts.map((a) => {
      const parts: string[] = [a.name]
      if (!a.enabled) parts.push('已停用')
      if (a.instanceIndex !== null && a.instanceIndex !== instanceIndex) {
        const owner = instances.find((i) => i.index === a.instanceIndex)
        parts.push(`已绑定 #${a.instanceIndex}${owner ? ` ${owner.name}` : ''}，选中将改绑`)
      }
      return {
        value: a.id,
        label: parts.length > 1 ? `${parts[0]}（${parts.slice(1).join('，')}）` : parts[0]
      }
    }),
    { value: CREATE, label: '＋ 新建账号并绑定…' }
  ]

  const select = (
    <Select
      size="small"
      style={{ width: '100%' }}
      value={account ? account.id : NONE}
      loading={busy}
      disabled={disabledReason !== null || busy}
      showSearch
      optionFilterProp="label"
      placeholder="未绑定"
      options={options}
      onSelect={onSelect}
    />
  )

  const instanceUp = instances.find((i) => i.index === instanceIndex)
  const hint =
    disabledReason ??
    (account
      ? `采集配置存在这个账号里。${instanceUp && !isInstanceUp(instanceUp) ? '实例没开机也能改绑。' : ''}`
      : '没绑账号的实例开了自动采集也只会定时读面板，不会派兵 —— 先选一个账号。')

  return (
    <>
      <Tooltip title={hint}>
        <span style={{ display: 'block' }}>{select}</span>
      </Tooltip>
      <Modal
        open={createOpen}
        title={`新建账号并绑定到实例 ${instanceIndex}`}
        okText="创建并绑定"
        cancelText="取消"
        confirmLoading={busy}
        onOk={() => void createAndBind()}
        onCancel={() => setCreateOpen(false)}
      >
        <div className="wl-label" style={{ marginBottom: 'var(--wl-space-2)' }}>
          只需要一个名字。服务器、备注、默认脚本这些到「设备与账号 → 账号管理」页再补。
        </div>
        <Input
          autoFocus
          value={newName}
          maxLength={40}
          placeholder="例如 主号-王朝A区"
          onChange={(e) => setNewName(e.target.value)}
          onPressEnter={() => void createAndBind()}
        />
      </Modal>
    </>
  )
}
