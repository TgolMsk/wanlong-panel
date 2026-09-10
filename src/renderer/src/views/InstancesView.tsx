/**
 * 实例管理：MuMu 多实例的开关机、克隆、删除，以及 adb 链路的连接/断开。
 *
 * 两条硬约束在这里体现：
 *  1. **并发上限**。实测单实例跑 Unity 游戏 45.7% CPU + 1.2GB RSS，本机 10 核 24GB，
 *     超过 4 个直接把 CPU 打满。已开机数达上限时「启动」按钮禁用并给出中文说明。
 *  2. **serial 只认 127.0.0.1:<adb_port>**，端口由 mumutool info 动态返回，界面上原样展示，
 *     不做任何「端口 = 16384 + index*32」这类推算。
 */

import { useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Drawer,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Table,
  Tooltip,
  Typography
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  CopyOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  EyeOutlined,
  LinkOutlined,
  PlusOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SettingOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import type { CreateInstanceOptions, MumuInstance } from '@shared/domain'
import { INSTANCE_DISK_COST_BYTES } from '@shared/constants'
import {
  accountOfInstance,
  activeRunOfInstance,
  countRunningInstances,
  isInstanceUp,
  useAppStore
} from '../store/appStore'
import { call, tryCall, toast } from '../ipc/useIpc'
import { AdbStateTag, InstanceStateTag, RunStatusTag, SemanticTag } from '../components/StatusTag'
import GlassCard from '../components/GlassCard'
import PreviewPane from './PreviewPane'

const GB = 1024 * 1024 * 1024

interface CreateFormValues {
  count: number
  type: 'phone' | 'tablet'
  extra?: string
}

export default function InstancesView(): React.JSX.Element {
  const instances = useAppStore((s) => s.instances)
  const accounts = useAppStore((s) => s.accounts)
  const runs = useAppStore((s) => s.runs)
  const settings = useAppStore((s) => s.settings)
  const refreshInstances = useAppStore((s) => s.refreshInstances)
  const refreshAccounts = useAppStore((s) => s.refreshAccounts)
  const selectInstance = useAppStore((s) => s.selectInstance)

  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [configTarget, setConfigTarget] = useState<MumuInstance | null>(null)
  const [configText, setConfigText] = useState('{\n  "vmCpuCount": 4\n}')
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [createForm] = Form.useForm<CreateFormValues>()

  const upCount = useMemo(() => countRunningInstances(instances), [instances])
  const limit = settings.maxConcurrentInstances
  const atLimit = upCount >= limit

  const mark = (key: string, v: boolean): void => setBusy((b) => ({ ...b, [key]: v }))
  const isBusy = (index: number, op: string): boolean => !!busy[`${index}:${op}`]

  /** 统一的「跑一个实例操作 -> 刷新列表」流程。 */
  async function op(
    index: number,
    name: string,
    fn: () => Promise<unknown>,
    okText: string
  ): Promise<void> {
    const key = `${index}:${name}`
    mark(key, true)
    try {
      await fn()
      toast().success(okText)
      await refreshInstances(true)
    } catch {
      /* call() 已经弹过中文错误，这里不再重复 */
    } finally {
      mark(key, false)
    }
  }

  const doRefresh = async (): Promise<void> => {
    setRefreshing(true)
    await refreshInstances(true)
    await refreshAccounts()
    setRefreshing(false)
  }

  const doAttach = async (index: number): Promise<void> => {
    const key = `${index}:attach`
    mark(key, true)
    try {
      const info = await call('device:attach', index)
      toast().success(
        `已连接 ${info.serial}｜${info.model}｜Android ${info.androidVersion}｜画面 ${info.screenWidth}x${info.screenHeight}`
      )
      await refreshInstances()
    } catch {
      /* 已提示 */
    } finally {
      mark(key, false)
    }
  }

  const submitCreate = async (): Promise<void> => {
    let values: CreateFormValues
    try {
      values = await createForm.validateFields()
    } catch {
      return
    }
    let extra: Record<string, unknown> | undefined
    if (values.extra && values.extra.trim()) {
      try {
        const parsed: unknown = JSON.parse(values.extra)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('必须是一个 JSON 对象')
        }
        extra = parsed as Record<string, unknown>
      } catch (e) {
        toast().error(`高级配置不是合法的 JSON 对象：${(e as Error).message}`)
        return
      }
    }
    const opts: CreateInstanceOptions = {
      count: values.count,
      type: values.type,
      settings: extra
    }
    setCreating(true)
    try {
      const created = await call('instance:create', opts)
      toast().success(`已创建实例：${created.join('、')}`)
      setCreateOpen(false)
      createForm.resetFields()
      await refreshInstances(true)
    } catch {
      /* 已提示 */
    } finally {
      setCreating(false)
    }
  }

  const submitConfig = async (): Promise<void> => {
    if (!configTarget) return
    let parsed: Record<string, unknown>
    try {
      const v: unknown = JSON.parse(configText)
      if (typeof v !== 'object' || v === null || Array.isArray(v))
        throw new Error('必须是 JSON 对象')
      parsed = v as Record<string, unknown>
    } catch (e) {
      toast().error(`配置不是合法的 JSON 对象：${(e as Error).message}`)
      return
    }
    const ok = await tryCall('instance:config', configTarget.index, parsed)
    if (ok !== undefined) {
      toast().success(`实例 ${configTarget.index} 配置已写入`)
      setConfigTarget(null)
      await refreshInstances(true)
    }
  }

  const columns: TableColumnsType<MumuInstance> = [
    {
      title: '序号',
      dataIndex: 'index',
      width: 60,
      render: (v: number) => <Typography.Text strong>{v}</Typography.Text>
    },
    { title: '名称', dataIndex: 'name', width: 140, ellipsis: true },
    {
      title: '实例状态',
      dataIndex: 'state',
      width: 110,
      render: (_: unknown, r) => <InstanceStateTag state={r.state} screenReady={r.screenReady} />
    },
    {
      title: 'adb 链路',
      dataIndex: 'adb',
      width: 100,
      render: (_: unknown, r) => <AdbStateTag state={r.adb} />
    },
    {
      title: 'adb 端口',
      dataIndex: 'adbPort',
      width: 90,
      render: (v: number | null) =>
        v === null ? <Typography.Text type="secondary">—</Typography.Text> : v
    },
    {
      title: 'serial',
      dataIndex: 'serial',
      width: 150,
      render: (v: string | null) =>
        v ? (
          <Typography.Text className="wl-mono" code copyable={{ text: v }}>
            {v}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">未运行</Typography.Text>
        )
    },
    {
      title: '绑定账号',
      key: 'account',
      width: 160,
      render: (_: unknown, r) => {
        const acc = accountOfInstance(accounts, r.index)
        if (!acc) return <Typography.Text type="secondary">未绑定</Typography.Text>
        return (
          <SemanticTag tone={acc.enabled ? 'info' : 'neutral'}>
            {acc.name}
            {acc.enabled ? '' : '（停用）'}
          </SemanticTag>
        )
      }
    },
    {
      title: '当前执行',
      key: 'run',
      width: 130,
      render: (_: unknown, r) => {
        const run = activeRunOfInstance(runs, r.index)
        if (!run) return <Typography.Text type="secondary">空闲</Typography.Text>
        const pct =
          run.stepTotal && run.stepTotal > 0
            ? Math.min(100, Math.round((run.stepDone / run.stepTotal) * 100))
            : null
        return (
          <Space direction="vertical" size={0} style={{ width: '100%' }}>
            <Space size={4}>
              <RunStatusTag status={run.status} />
              <Typography.Text ellipsis style={{ maxWidth: 110 }}>
                {run.scriptName}
              </Typography.Text>
            </Space>
            {pct === null ? (
              <span className="wl-micro">
                第 {run.iteration} 轮｜已执行 {run.stepDone} 步
              </span>
            ) : (
              <Progress percent={pct} size="small" />
            )}
          </Space>
        )
      }
    },
    {
      title: '操作',
      key: 'actions',
      // ★ 固定在右侧让「关闭/重启」在窄窗口下也始终可见。之前的"重叠"是两件事叠加：
      //   scroll.x 写死 1500 大于各列之和导致相邻列被拉伸到固定列下面，加上毛玻璃底把它们透了出来。
      //   现在 scroll.x='max-content' + 固定单元格不透明底色（见 styles 里的 .ant-table-cell-fix-right）。
      fixed: 'right',
      width: 400,
      // ★ 固定单元格用内联样式强制不透明（双保险：styles/tokens.css 里也有按 -fix-start/-fix-end 类名的全局规则）。
      //   antd 的固定列背景走主题 token（本主题是毛玻璃透明色），透明的固定列会把相邻列透出来。
      onCell: () => ({ style: { background: 'var(--wl-bg-elevated)' } }),
      onHeaderCell: () => ({ style: { background: 'var(--wl-bg-elevated)' } }),
      render: (_: unknown, r) => {
        const up = isInstanceUp(r)
        const hasRun = !!activeRunOfInstance(runs, r.index)
        return (
          <Space size={4} wrap={false}>
            {up ? (
              <Popconfirm
                title="关闭这个实例？"
                description={
                  hasRun ? '该实例上还有执行在跑，关闭会让脚本中断。' : '模拟器会被关机。'
                }
                okText="关闭"
                cancelText="取消"
                onConfirm={() =>
                  op(
                    r.index,
                    'close',
                    () => call('instance:close', r.index),
                    `实例 ${r.index} 已关闭`
                  )
                }
              >
                <Button
                  size="small"
                  danger
                  icon={<PoweroffOutlined />}
                  loading={isBusy(r.index, 'close')}
                >
                  关闭
                </Button>
              </Popconfirm>
            ) : (
              <Tooltip
                title={
                  atLimit
                    ? `已开机 ${upCount} 个，达到并发上限 ${limit}。单实例实测约 45.7% CPU + 1.2GB 内存，再开会把机器拖垮；请先关掉一个，或到「设置」里调高上限。`
                    : ''
                }
              >
                <Button
                  size="small"
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  disabled={atLimit}
                  loading={isBusy(r.index, 'open')}
                  onClick={() =>
                    op(
                      r.index,
                      'open',
                      () => call('instance:open', r.index),
                      `实例 ${r.index} 已启动`
                    )
                  }
                >
                  启动
                </Button>
              </Tooltip>
            )}

            <Button
              size="small"
              icon={<ReloadOutlined />}
              disabled={!up}
              loading={isBusy(r.index, 'restart')}
              onClick={() =>
                op(
                  r.index,
                  'restart',
                  () => call('instance:restart', r.index),
                  `实例 ${r.index} 正在重启`
                )
              }
            >
              重启
            </Button>

            {r.adb === 'connected' ? (
              <Button
                size="small"
                icon={<DisconnectOutlined />}
                loading={isBusy(r.index, 'detach')}
                onClick={() =>
                  op(
                    r.index,
                    'detach',
                    () => call('device:detach', r.index),
                    `实例 ${r.index} 已断开 adb`
                  )
                }
              >
                断开
              </Button>
            ) : (
              <Button
                size="small"
                icon={<LinkOutlined />}
                disabled={!up}
                loading={isBusy(r.index, 'attach')}
                onClick={() => doAttach(r.index)}
              >
                连接
              </Button>
            )}

            <Button
              size="small"
              icon={<EyeOutlined />}
              disabled={r.adb !== 'connected'}
              onClick={() => {
                selectInstance(r.index)
                setPreviewIndex(r.index)
              }}
            >
              画面
            </Button>

            <Dropdown
              menu={{
                items: [
                  { key: 'clone', icon: <CopyOutlined />, label: '克隆实例' },
                  { key: 'config', icon: <SettingOutlined />, label: '写入配置' },
                  { type: 'divider' },
                  { key: 'delete', icon: <DeleteOutlined />, label: '删除实例', danger: true }
                ],
                onClick: ({ key }) => {
                  if (key === 'clone') {
                    Modal.confirm({
                      title: `克隆实例 ${r.index}？`,
                      content: `克隆会完整复制一份系统盘，约需 ${(INSTANCE_DISK_COST_BYTES / GB).toFixed(1)} GB 磁盘，过程较慢。`,
                      okText: '开始克隆',
                      cancelText: '取消',
                      onOk: () =>
                        op(
                          r.index,
                          'clone',
                          async () => {
                            const created = await call('instance:clone', r.index)
                            return created
                          },
                          '克隆已完成'
                        )
                    })
                  } else if (key === 'config') {
                    setConfigTarget(r)
                  } else if (key === 'delete') {
                    Modal.confirm({
                      title: `删除实例 ${r.index}（${r.name}）？`,
                      content:
                        '实例数据会被永久删除，且无法恢复。请确认里面的账号数据已经不需要了。',
                      okText: '确认删除',
                      okButtonProps: { danger: true },
                      cancelText: '取消',
                      onOk: () =>
                        op(
                          r.index,
                          'delete',
                          () => call('instance:delete', r.index),
                          `实例 ${r.index} 已删除`
                        )
                    })
                  }
                }
              }}
            >
              <Button size="small">更多</Button>
            </Dropdown>
          </Space>
        )
      }
    }
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <GlassCard
        padding="sm"
        title={
          <Space>
            <span>模拟器实例</span>
            <SemanticTag tone={atLimit ? 'warning' : 'info'}>
              已开机 {upCount} / 上限 {limit}
            </SemanticTag>
          </Space>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} loading={refreshing} onClick={doRefresh}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建实例
            </Button>
          </Space>
        }
      >
        {atLimit && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 'var(--wl-space-3)' }}
            message={`已达到并发上限（${limit} 个）`}
            description="继续开机会让 CPU 与内存吃紧（单实例实测 45.7% CPU、1.2GB 内存）。请先关掉一个实例，或到「设置」里调整上限。"
          />
        )}
        <Table<MumuInstance>
          size="small"
          rowKey="index"
          columns={columns}
          dataSource={instances}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText:
              '还没有实例。点右上角「新建实例」创建，或确认 MuMu 模拟器已经启动、mumutool 路径正确（见「设置」页的环境自检）。'
          }}
        />
      </GlassCard>

      {/* 新建实例 */}
      <Modal
        open={createOpen}
        title="新建实例"
        okText="创建"
        cancelText="取消"
        confirmLoading={creating}
        onOk={submitCreate}
        onCancel={() => setCreateOpen(false)}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`每个新实例约占 ${(INSTANCE_DISK_COST_BYTES / GB).toFixed(1)} GB 磁盘，创建过程可能持续数分钟。`}
        />
        <Form form={createForm} layout="vertical" initialValues={{ count: 1, type: 'phone' }}>
          <Form.Item
            name="count"
            label="数量"
            rules={[{ required: true, message: '请填写要创建的数量' }]}
          >
            <InputNumber min={1} max={8} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="type" label="机型">
            <Select
              options={[
                { value: 'phone', label: '手机' },
                { value: 'tablet', label: '平板' }
              ]}
            />
          </Form.Item>
          <Form.Item
            name="extra"
            label="高级配置（可选，JSON，透传给 mumutool create -s）"
            extra='例如 {"vmCpuCount": 4, "vmMemory": 4096}。留空则用 MuMu 默认值。'
          >
            <Input.TextArea rows={4} placeholder='{"vmCpuCount": 4}' />
          </Form.Item>
        </Form>
      </Modal>

      {/* 写入实例配置 */}
      <Modal
        open={!!configTarget}
        title={configTarget ? `写入配置 —— 实例 ${configTarget.index}（${configTarget.name}）` : ''}
        okText="写入"
        cancelText="取消"
        onOk={submitConfig}
        onCancel={() => setConfigTarget(null)}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="只支持写入，不支持读回"
          description="Mac 版 mumutool 的配置读取接口是坏的，这里只把 JSON 透传给 mumutool config -s。写错的键会被 MuMu 忽略，不会有回显。"
        />
        <Input.TextArea
          rows={8}
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          spellCheck={false}
          style={{ fontFamily: 'Menlo, Monaco, monospace' }}
        />
      </Modal>

      {/* 画面预览 / 手动操控 */}
      <Drawer
        open={previewIndex !== null}
        onClose={() => setPreviewIndex(null)}
        width={860}
        title={previewIndex !== null ? `实例 ${previewIndex} 画面（手动操控）` : ''}
        destroyOnHidden
      >
        <PreviewPane instanceIndex={previewIndex} active={previewIndex !== null} />
      </Drawer>
    </Space>
  )
}
