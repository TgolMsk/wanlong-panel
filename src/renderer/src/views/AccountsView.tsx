/**
 * 账号管理。
 *
 * 账号是「多账号脚本化」的落点：一个账号绑一个实例，多实例并发时每个实例跑自己那份账号数据。
 * 绑定关系是**一对一**的 —— 一个实例同时只能绑一个账号，所以选实例时会把已被别人占用的项标出来。
 */

import { useState } from 'react'
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tooltip,
  Typography
} from 'antd'
import type { TableColumnsType } from 'antd'
import { DeleteOutlined, PlusOutlined, ReloadOutlined, UserOutlined } from '@ant-design/icons'
import { makeId } from '@shared/defaults'
import type { Account } from '@shared/domain'
import { isInstanceUp, useAppStore } from '../store/appStore'
import { call, tryCall, toast } from '../ipc/useIpc'
import { SemanticTag } from '../components/StatusTag'
import GlassCard from '../components/GlassCard'
import AccountLoginDrawer from './AccountLoginDrawer'

interface AccountFormValues {
  name: string
  packageName?: string
  note?: string
  defaultScriptId?: string
  instanceIndex?: number | null
  enabled: boolean
}

export default function AccountsView(): React.JSX.Element {
  const accounts = useAppStore((s) => s.accounts)
  const instances = useAppStore((s) => s.instances)
  const scripts = useAppStore((s) => s.scripts)
  const setAccounts = useAppStore((s) => s.setAccounts)
  const refreshAccounts = useAppStore((s) => s.refreshAccounts)

  const [editing, setEditing] = useState<Account | null>(null)
  const [loginTarget, setLoginTarget] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [form] = Form.useForm<AccountFormValues>()

  const openCreate = (): void => {
    setEditing(null)
    form.setFieldsValue({
      name: '',
      packageName: undefined,
      note: undefined,
      defaultScriptId: undefined,
      instanceIndex: null,
      enabled: true
    })
    setOpen(true)
  }

  const openEdit = (a: Account): void => {
    setEditing(a)
    form.setFieldsValue({
      name: a.name,
      packageName: a.packageName,
      note: a.note,
      defaultScriptId: a.defaultScriptId,
      instanceIndex: a.instanceIndex,
      enabled: a.enabled
    })
    setOpen(true)
  }

  /** 生成实例下拉选项，把已被别的账号占用的实例标出来。 */
  const instanceOptions = (selfId: string | null): { value: number; label: string }[] =>
    instances.map((i) => {
      const owner = accounts.find((a) => a.instanceIndex === i.index && a.id !== selfId)
      const parts: string[] = [`${i.index} · ${i.name}`]
      if (!isInstanceUp(i)) parts.push('未开机')
      if (owner) parts.push(`已绑定「${owner.name}」，选中将改绑`)
      return {
        value: i.index,
        label: parts.length > 1 ? `${parts[0]}（${parts.slice(1).join('，')}）` : parts[0]
      }
    })

  const submit = async (): Promise<void> => {
    let v: AccountFormValues
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    const now = Date.now()
    const account: Account = {
      id: editing?.id ?? makeId('acc'),
      name: v.name.trim(),
      packageName: v.packageName?.trim() || undefined,
      note: v.note?.trim() || undefined,
      defaultScriptId: v.defaultScriptId || undefined,
      instanceIndex: typeof v.instanceIndex === 'number' ? v.instanceIndex : null,
      scriptParams: editing?.scriptParams,
      enabled: v.enabled,
      createdAt: editing?.createdAt ?? now,
      updatedAt: now
    }
    setSaving(true)
    try {
      await call('account:save', account)
      toast().success(`账号「${account.name}」已保存`)
      setOpen(false)
      await refreshAccounts()
    } catch {
      /* 已提示 */
    } finally {
      setSaving(false)
    }
  }

  const bind = async (accountId: string, index: number | null): Promise<void> => {
    const list = await tryCall('account:bind', accountId, index)
    if (list) {
      setAccounts(list)
      toast().success(index === null ? '已解除绑定' : `已绑定到实例 ${index}`)
    }
  }

  const remove = async (a: Account): Promise<void> => {
    const r = await tryCall('account:delete', a.id)
    if (r !== undefined) {
      toast().success(`账号「${a.name}」已删除`)
      await refreshAccounts()
    }
  }

  const doRefresh = async (): Promise<void> => {
    setRefreshing(true)
    await refreshAccounts()
    setRefreshing(false)
  }

  const columns: TableColumnsType<Account> = [
    {
      title: '账号',
      dataIndex: 'name',
      width: 190,
      render: (v: string, r) => (
        <Space direction="vertical" size={0}>
          <Space size={4}>
            <UserOutlined />
            <Typography.Link onClick={() => openEdit(r)}>{v}</Typography.Link>
            {r.setup?.status === 'pending' ? (
              <SemanticTag tone="warning">待登录</SemanticTag>
            ) : (
              !r.enabled && <SemanticTag tone="neutral">已停用</SemanticTag>
            )}
          </Space>
          {r.note && <span className="wl-micro">{r.note}</span>}
        </Space>
      )
    },
    {
      title: '登录检查',
      key: 'loginStatus',
      width: 135,
      render: (_: unknown, r) =>
        r.setup?.status === 'ready' ? (
          <Tooltip
            title={
              r.setup.verifiedAt
                ? `检查于 ${new Date(r.setup.verifiedAt).toLocaleString()}`
                : undefined
            }
          >
            <SemanticTag tone="success">已检查</SemanticTag>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">{r.setup ? '等待登录' : '未检查'}</Typography.Text>
        )
    },
    {
      title: '绑定实例',
      dataIndex: 'instanceIndex',
      width: 280,
      render: (_: unknown, r) => (
        <Select
          size="small"
          allowClear
          style={{ width: '100%' }}
          placeholder="未绑定"
          value={r.instanceIndex ?? undefined}
          onChange={(v?: number) => void bind(r.id, typeof v === 'number' ? v : null)}
          options={instanceOptions(r.id)}
          notFoundContent="没有实例"
        />
      )
    },
    {
      title: '默认脚本',
      dataIndex: 'defaultScriptId',
      width: 190,
      render: (v?: string) => {
        if (!v) return <Typography.Text type="secondary">未设置</Typography.Text>
        const s = scripts.find((x) => x.id === v)
        return s ? (
          <SemanticTag tone="info">{s.name}</SemanticTag>
        ) : (
          <Tooltip title="这个脚本已经不存在了，请重新选一个">
            <SemanticTag tone="danger">{v}（已丢失）</SemanticTag>
          </Tooltip>
        )
      }
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (v: boolean, r) => (
        <Switch
          size="small"
          checked={v}
          disabled={r.setup?.status === 'pending'}
          onChange={async (checked) => {
            const next: Account = { ...r, enabled: checked, updatedAt: Date.now() }
            const saved = await tryCall('account:save', next)
            if (saved) await refreshAccounts()
          }}
        />
      )
    },
    {
      title: '操作',
      key: 'actions',
      width: 230,
      render: (_: unknown, r) => (
        <Space size={4}>
          <Button
            size="small"
            disabled={r.instanceIndex === null}
            onClick={() => setLoginTarget(r.instanceIndex)}
          >
            {r.setup?.status === 'pending' ? '继续登录' : '登录'}
          </Button>
          <Button size="small" onClick={() => openEdit(r)}>
            编辑
          </Button>
          <Popconfirm
            title={`删除账号「${r.name}」？`}
            description="只删除面板里的账号配置，不会影响模拟器里的游戏数据。"
            okText="删除"
            cancelText="取消"
            onConfirm={() => void remove(r)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <GlassCard
        padding="sm"
        title={
          <Space>
            <span>账号</span>
            <SemanticTag tone="neutral">{accounts.length} 个</SemanticTag>
          </Space>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void doRefresh()}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建账号
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 'var(--wl-space-3)' }}
          message="一个实例同时只能绑一个账号"
          description="把某个实例绑给新账号时，原来占着它的账号会自动解绑。多账号并发跑脚本时，请让每个账号绑到不同实例。「模拟器实例」页的「绑定账号」列也能直接改绑，与这里是同一条通道、效果完全一样。"
        />
        <Table<Account>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={accounts}
          pagination={false}
          scroll={{ x: 1140 }}
          locale={{ emptyText: '还没有账号。点右上角「新建账号」，然后把它绑到一个实例上。' }}
        />
      </GlassCard>
      {loginTarget !== null && (
        <AccountLoginDrawer instanceIndices={[loginTarget]} onClose={() => setLoginTarget(null)} />
      )}

      <Modal
        open={open}
        title={editing ? `编辑账号：${editing.name}` : '新建账号'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={() => setOpen(false)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="账号名称"
            rules={[{ required: true, message: '请填写账号名称' }]}
          >
            <Input placeholder="例如：主号-王朝A区" />
          </Form.Item>
          <Form.Item
            name="packageName"
            label="游戏包名（可选）"
            extra="填了之后可以按包名筛选脚本与模板集。"
          >
            <Input placeholder="com.example.game" />
          </Form.Item>
          <Form.Item name="instanceIndex" label="绑定实例（可选）">
            <Select
              allowClear
              placeholder="暂不绑定"
              options={instanceOptions(editing?.id ?? null)}
            />
          </Form.Item>
          <Form.Item name="defaultScriptId" label="默认脚本（可选）">
            <Select
              allowClear
              placeholder="不设置"
              options={scripts.map((s) => ({ value: s.id, label: `${s.name} v${s.version}` }))}
            />
          </Form.Item>
          <Form.Item name="note" label="备注（服务器、角色名等）">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch disabled={editing?.setup?.status === 'pending'} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
