/**
 * 实例管理：模拟器多实例（雷电 / MuMu）的开关机、克隆、删除，以及 adb 链路的连接/断开。
 *
 * 两条硬约束在这里体现：
 *  1. **并发上限**。实测单实例跑 Unity 游戏 45.7% CPU + 1.2GB RSS，本机 10 核 24GB，
 *     超过 4 个直接把 CPU 打满。已开机数达上限时「启动」按钮禁用并给出中文说明。
 *  2. **serial 只认 127.0.0.1:<adb_port>**，端口由驱动给出（MuMu 从 info 现读，雷电按 5555+2·序号），
 *     界面上原样展示，渲染进程自己不做任何推算。
 *  3. 雷电会报每个实例**配置**的分辨率，与参考分辨率不一致时在列表里标黄 —— 模板全部截自 2560×1440，
 *     实例不是这个尺寸的话所有匹配都会错位。
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
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
  SearchOutlined,
  SettingOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import type { BaseInstanceSelection, CreateInstanceOptions, MumuInstance } from '@shared/domain'
import { INSTANCE_DISK_COST_BYTES } from '@shared/constants'
import {
  accountOfInstance,
  activeRunOfInstance,
  countRunningInstances,
  isInstanceUp,
  useAppStore
} from '../store/appStore'
import { call, tryCall, toast, useIpcEvent } from '../ipc/useIpc'
import { AdbStateTag, InstanceStateTag, RunStatusTag, SemanticTag } from '../components/StatusTag'
import GlassCard from '../components/GlassCard'
import PreviewPane from './PreviewPane'
import AccountLoginDrawer from './AccountLoginDrawer'

const GB = 1024 * 1024 * 1024

interface CreateFormValues {
  source: 'base' | 'blank'
  count: number
  type: 'phone' | 'tablet'
  extra?: string
  loginAfterCreate: boolean
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
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'up' | 'stopped'>('all')
  const [refreshing, setRefreshing] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [configTarget, setConfigTarget] = useState<MumuInstance | null>(null)
  const isLd = (settings.runtimeEmulator ?? settings.emulator) === 'ldplayer'
  /** Windows 版 MuMu（MuMuManager.exe）：配置键与雷电一样走 resolution / cpu / memory 这套友好键。 */
  const isMumuWin = !isLd && (window.api?.env.platform ?? '') === 'win32'
  const winDriver = isLd || isMumuWin
  const [configText, setConfigText] = useState(() =>
    winDriver ? '{\n  "resolution": "2560,1440,360"\n}' : '{\n  "vmCpuCount": 4\n}'
  )
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [loginTargets, setLoginTargets] = useState<number[] | null>(null)
  const [createForm] = Form.useForm<CreateFormValues>()
  const [base, setBase] = useState<BaseInstanceSelection | null>(null)
  const [baseReady, setBaseReady] = useState(false)
  const [baseLoading, setBaseLoading] = useState(false)
  const [createBase, setCreateBase] = useState<BaseInstanceSelection | null>(null)
  const source = Form.useWatch('source', createForm) ?? (createBase ? 'base' : 'blank')
  const baseInstance = base ? instances.find((i) => i.index === base.index) : undefined
  const baseValid =
    !!baseInstance &&
    (!base?.identity || base.identity === (baseInstance.identity ?? baseInstance.bundlePath))
  const createSource = createBase ? instances.find((i) => i.index === createBase.index) : undefined
  const cloneUnavailable =
    source === 'base' &&
    (!createSource ||
      createSource.state !== 'stopped' ||
      (!!createBase?.identity &&
        createBase.identity !== (createSource.identity ?? createSource.bundlePath)))

  useEffect(() => {
    let mounted = true
    void tryCall('instance:base').then((value) => {
      if (mounted && value !== undefined) {
        setBase(value)
        setBaseReady(true)
      }
    })
    return () => {
      mounted = false
    }
  }, [])
  useIpcEvent('instance:baseChanged', (value) => {
    setBase(value)
    setBaseReady(true)
  })

  async function changeBase(index: number | null): Promise<void> {
    setBaseLoading(true)
    try {
      const selected = await call('instance:setBase', index)
      setBase(selected)
      setBaseReady(true)
      toast().success(
        selected
          ? `已将实例 ${selected.index}「${selected.name}」设为基础实例`
          : '已取消基础实例，后续默认空白新建'
      )
    } catch {
      /* call 已提示 */
    } finally {
      setBaseLoading(false)
    }
  }

  async function openCreate(): Promise<void> {
    setBaseLoading(true)
    try {
      const current = await call('instance:base')
      setBase(current)
      setBaseReady(true)
      setCreateBase(current)
      setCreateOpen(true)
    } catch {
      /* 读取失败不能误用空白新建 */
    } finally {
      setBaseLoading(false)
    }
  }

  const upCount = useMemo(() => countRunningInstances(instances), [instances])
  const limit = settings.maxConcurrentInstances
  const atLimit = upCount >= limit

  const visibleInstances = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    return instances
      .filter((instance) => {
        const account = accountOfInstance(accounts, instance.index)
        const matches =
          !term ||
          [instance.name, String(instance.index), account?.name ?? ''].some((text) =>
            text.toLocaleLowerCase().includes(term)
          )
        return (
          matches &&
          (statusFilter === 'all' ||
            (statusFilter === 'up' ? isInstanceUp(instance) : !isInstanceUp(instance)))
        )
      })
      .sort((a, b) => a.index - b.index)
  }, [instances, accounts, query, statusFilter])

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
    const current = await tryCall('instance:base')
    if (current !== undefined) {
      setBase(current)
      setBaseReady(true)
    }
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
    if (values.source === 'blank' && values.extra && values.extra.trim()) {
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
      source: values.source,
      expectedBaseIndex: values.source === 'base' ? createBase?.index : undefined,
      count: values.count,
      type: values.source === 'blank' ? values.type : undefined,
      settings: extra
    }
    setCreating(true)
    try {
      const created = await call('instance:create', opts)
      toast().success(`已创建实例：${created.join('、')}`)
      setCreateOpen(false)
      createForm.resetFields()
      await refreshInstances(true)
      if (values.loginAfterCreate && created.length) setLoginTargets(created)
    } catch {
      /* 已提示 */
    } finally {
      setCreating(false)
      await refreshInstances(true)
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
      title: '实例',
      key: 'instance',
      width: 180,
      render: (_: unknown, r) => (
        <div className="wl-instance-name">
          <Typography.Text strong ellipsis title={r.name}>
            {r.name}
          </Typography.Text>
          <small>
            实例 #{r.index}
            {base?.index === r.index && (
              <SemanticTag tone={baseValid ? 'info' : 'warning'}>
                {baseValid ? '基础实例' : '基础实例已变化'}
              </SemanticTag>
            )}
          </small>
        </div>
      )
    },
    {
      title: '状态',
      key: 'state',
      width: 150,
      render: (_: unknown, r) => (
        <Space direction="vertical" size={4}>
          <Space size={4}>
            <InstanceStateTag state={r.state} screenReady={r.screenReady} />
            <AdbStateTag state={r.adb} />
          </Space>
          {r.resolution &&
            (r.resolution.width !== settings.refWidth ||
              r.resolution.height !== settings.refHeight) && (
              <Tooltip
                title={`请在模拟器设置中调整为 ${settings.refWidth}×${settings.refHeight}、DPI 360 后重启。展开此行可查看当前分辨率。`}
              >
                <span>
                  <SemanticTag tone="warning">分辨率不一致</SemanticTag>
                </span>
              </Tooltip>
            )}
        </Space>
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
      width: 230,
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

            {r.adb === 'connected' ? (
              <Button
                size="small"
                icon={<EyeOutlined />}
                onClick={() => {
                  selectInstance(r.index)
                  setPreviewIndex(r.index)
                }}
              >
                画面
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

            <Dropdown
              trigger={['click']}
              disabled={Object.entries(busy).some(
                ([key, value]) => value && key.startsWith(`${r.index}:`)
              )}
              menu={{
                items: [
                  { key: 'login', label: '账号登录', disabled: base?.index === r.index || hasRun },
                  { key: 'restart', icon: <ReloadOutlined />, label: '重启实例', disabled: !up },
                  {
                    key: 'detach',
                    icon: <DisconnectOutlined />,
                    label: '断开连接',
                    disabled: r.adb !== 'connected'
                  },
                  { type: 'divider' },
                  {
                    key: 'base',
                    icon: <CopyOutlined />,
                    label: base?.index === r.index && baseValid ? '取消基础实例' : '设为基础实例',
                    disabled: baseLoading
                  },
                  {
                    key: 'clone',
                    icon: <CopyOutlined />,
                    label: '克隆实例',
                    disabled: r.state !== 'stopped'
                  },
                  { key: 'config', icon: <SettingOutlined />, label: '写入配置' },
                  { type: 'divider' },
                  { key: 'delete', icon: <DeleteOutlined />, label: '删除实例', danger: true }
                ],
                onClick: ({ key }) => {
                  if (key === 'login') setLoginTargets([r.index])
                  if (key === 'restart') {
                    Modal.confirm({
                      title: `重启实例 ${r.index}？`,
                      content: hasRun
                        ? '该实例上还有任务在执行，重启会中断当前任务。'
                        : '模拟器会关闭后重新启动。',
                      okText: '重启',
                      cancelText: '取消',
                      onOk: () =>
                        op(
                          r.index,
                          'restart',
                          () => call('instance:restart', r.index),
                          `实例 ${r.index} 正在重启`
                        )
                    })
                  } else if (key === 'detach') {
                    void op(
                      r.index,
                      'detach',
                      () => call('device:detach', r.index),
                      `实例 ${r.index} 已断开连接`
                    )
                  } else if (key === 'base') {
                    void changeBase(base?.index === r.index && baseValid ? null : r.index)
                  } else if (key === 'clone') {
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
            <Button
              type="primary"
              icon={<PlusOutlined />}
              loading={baseLoading}
              onClick={() => void openCreate()}
            >
              新建实例
            </Button>
          </Space>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <Space wrap>
            <Typography.Text type="secondary">
              {!baseReady
                ? '基础实例设置尚未读取，可点击刷新重试。'
                : base
                  ? `基础实例：#${base.index} ${baseInstance?.name ?? base.name} · 新建时默认克隆`
                  : '未设置基础实例 · 可在实例的「更多」中设置'}
            </Typography.Text>
            {base && (
              <Button
                size="small"
                type="link"
                loading={baseLoading}
                onClick={() => void changeBase(null)}
              >
                取消基础实例
              </Button>
            )}
          </Space>
          {base && (!baseValid || baseInstance?.state !== 'stopped') && (
            <Typography.Paragraph type="warning" style={{ margin: '4px 0 0' }}>
              {!baseValid
                ? '基础实例已不存在或已被替换，请重新设置；也可选择空白新建。'
                : '基础实例仍在运行，克隆前请先关闭它。'}
            </Typography.Paragraph>
          )}
        </div>
        {atLimit && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 'var(--wl-space-3)' }}
            message={`已达到并发上限（${limit} 个）`}
            description="继续开机会让 CPU 与内存吃紧（单实例实测 45.7% CPU、1.2GB 内存）。请先关掉一个实例，或到「设置」里调整上限。"
          />
        )}
        <div className="wl-instance-toolbar">
          <Space wrap>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索实例名称、序号或账号"
              aria-label="搜索实例"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Select
              aria-label="筛选实例状态"
              value={statusFilter}
              onChange={setStatusFilter}
              style={{ width: 126 }}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'up', label: '已开机' },
                { value: 'stopped', label: '未开机' }
              ]}
            />
          </Space>
          <Typography.Text type="secondary">
            {visibleInstances.length} / {instances.length} 个实例 · 展开行可看连接详情
          </Typography.Text>
        </div>
        <Table<MumuInstance>
          size="small"
          rowKey="index"
          columns={columns}
          dataSource={visibleInstances}
          expandable={{
            columnWidth: 36,
            expandedRowRender: (r) => (
              <div className="wl-device-details">
                <span>
                  连接地址：
                  <Typography.Text code copyable={r.serial ? { text: r.serial } : false}>
                    {r.serial ?? '未连接'}
                  </Typography.Text>
                </span>
                <span>
                  端口：<strong>{r.adbPort ?? '—'}</strong>
                </span>
                <span>
                  分辨率：
                  <strong>
                    {r.resolution
                      ? `${r.resolution.width}×${r.resolution.height} @ ${r.resolution.dpi} DPI`
                      : '未读取'}
                  </strong>
                </span>
              </div>
            )
          }}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText:
              query || statusFilter !== 'all'
                ? '没有符合筛选条件的实例，请调整搜索或状态筛选。'
                : isLd
                  ? '还没有实例。点右上角「新建实例」创建，或确认雷电多开器里有实例、ldconsole.exe 路径正确（见「设置」页的环境自检）。'
                  : isMumuWin
                    ? '还没有实例。点右上角「新建实例」创建，或确认 MuMu 多开器里有实例、MuMuManager.exe 路径正确（见「设置」页的环境自检）。'
                    : '还没有实例。点右上角「新建实例」创建，或确认 MuMu 模拟器已经启动、mumutool 路径正确（见「设置」页的环境自检）。'
          }}
        />
      </GlassCard>

      {/* 新建实例 */}
      {loginTargets && (
        <AccountLoginDrawer instanceIndices={loginTargets} onClose={() => setLoginTargets(null)} />
      )}
      <Modal
        open={createOpen}
        title="新建实例"
        okText={source === 'base' ? '开始克隆' : '创建'}
        cancelText="取消"
        confirmLoading={creating}
        okButtonProps={{ disabled: cloneUnavailable }}
        cancelButtonProps={{ disabled: creating }}
        closable={!creating}
        maskClosable={!creating}
        keyboard={!creating}
        onOk={submitCreate}
        onCancel={() => {
          if (!creating) setCreateOpen(false)
        }}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`每个新实例约占 ${(INSTANCE_DISK_COST_BYTES / GB).toFixed(1)} GB 磁盘，创建过程可能持续数分钟。`}
        />
        <Form
          form={createForm}
          layout="vertical"
          clearOnDestroy
          // 雷电 add 出来的实例默认 1280×720@280、MuMu 新建的也不一定是 2560×1440，与模板不匹配，
          // 所以 Windows 两家驱动默认都把参考分辨率填上。
          initialValues={{
            source: createBase ? 'base' : 'blank',
            count: 1,
            loginAfterCreate: true,
            type: 'phone',
            extra: winDriver
              ? `{\n  "resolution": "${settings.refWidth},${settings.refHeight},360"\n}`
              : undefined
          }}
        >
          <Form.Item name="source" label="创建方式" rules={[{ required: true }]}>
            <Select
              styles={{ popup: { root: { background: 'var(--wl-bg-elevated)' } } }}
              options={[
                {
                  value: 'base',
                  label: createBase
                    ? `克隆基础实例 #${createBase.index} · ${createBase.name}`
                    : '克隆基础实例（尚未设置）',
                  disabled: !createBase
                },
                { value: 'blank', label: '空白新建' }
              ]}
            />
          </Form.Item>
          {source === 'base' && (
            <Alert
              type={cloneUnavailable ? 'warning' : 'info'}
              showIcon
              style={{ marginBottom: 12 }}
              message={
                cloneUnavailable
                  ? '基础实例不可克隆，请先关闭它并确认实例仍存在。'
                  : '沿用基础实例中的应用、游戏数据和模拟器配置'
              }
              description="每份副本均从基础实例复制。新实例需单独绑定账号并设置自动任务；游戏登录状态可能随系统盘复制，请按需切换账号。"
            />
          )}
          <Form.Item
            name="count"
            label="数量"
            rules={[{ required: true, message: '请填写要创建的数量' }]}
          >
            <InputNumber min={1} max={8} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="loginAfterCreate" valuePropName="checked">
            <Checkbox>创建后设置账号并登录游戏</Checkbox>
          </Form.Item>
          {source === 'blank' && !winDriver && (
            <Form.Item name="type" label="机型">
              <Select
                options={[
                  { value: 'phone', label: '手机' },
                  { value: 'tablet', label: '平板' }
                ]}
              />
            </Form.Item>
          )}
          <Form.Item
            name="extra"
            hidden={source !== 'blank'}
            label={
              isLd
                ? '高级配置（可选，JSON，建完交给 ldconsole modify）'
                : isMumuWin
                  ? '高级配置（可选，JSON，建完交给 MuMuManager setting）'
                  : '高级配置（可选，JSON，透传给 mumutool create -s）'
            }
            extra={
              isLd
                ? '例如 {"resolution": "2560,1440,360", "cpu": 4, "memory": 4096}。留空则用雷电默认值（通常是 1920×1080，与本工程模板不匹配）。'
                : isMumuWin
                  ? '例如 {"resolution": "2560,1440,360", "cpu": 4, "memory": 4096}。留空则用 MuMu 默认值（不一定是 2560×1440，与本工程模板不匹配）。'
                  : '例如 {"vmCpuCount": 4, "vmMemory": 4096}。留空则用 MuMu 默认值。'
            }
          >
            <Input.TextArea
              rows={4}
              placeholder={winDriver ? '{"resolution": "2560,1440,360"}' : '{"vmCpuCount": 4}'}
            />
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
        {isLd ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="写入后要重启实例才生效"
            description={
              '键名与 ldconsole modify 的参数一一对应：resolution（"宽,高,DPI"）/ cpu / memory / manufacturer / model / pnumber / imei / imsi / simserial / androidid / mac / autorotate / lockwindow / root。不认识的键会直接报错，不会静默忽略。'
            }
          />
        ) : isMumuWin ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="写入后要重启实例才生效"
            description={
              '友好键：resolution（"宽,高,DPI"）/ cpu / memory（MB）/ manufacturer / model / pnumber / imei / autorotate / lockwindow / root；也可以直接写 MuMuManager setting 的原始键（如 "performance_mode": "high"）。不认识的键会直接报错。'
            }
          />
        ) : (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="只支持写入，不支持读回"
            description="Mac 版 mumutool 的配置读取接口是坏的，这里只把 JSON 透传给 mumutool config -s。写错的键会被 MuMu 忽略，不会有回显。"
          />
        )}
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
