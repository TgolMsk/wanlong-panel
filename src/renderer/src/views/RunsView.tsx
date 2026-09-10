/**
 * 执行监控：启动 / 暂停 / 继续 / 停止，以及每次执行的实时状态、日志和画面。
 *
 * 数据来源分两路（别搞混）：
 *   · run:changed（IPC 低频推送）—— 状态机变化，主进程发。
 *   · MessagePort 的 status/logs/frame —— 高频，worker 直连渲染进程，完全绕开主进程。
 * 两路都往同一个 store / ring buffer 里写，谁先到都不影响正确性。
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tooltip,
  Typography
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import type { RunSnapshot, ScriptDef, ScriptParamDef, StartRunRequest } from '@shared/script'
import { activeRunOfInstance, isInstanceUp, isRunActive, useAppStore } from '../store/appStore'
import { call, silentCall, tryCall, toast } from '../ipc/useIpc'
import { useWorkerPort } from '../ipc/useWorkerPort'
import { pushLogs } from '../store/logStore'
import { RunStatusTag, SemanticTag } from '../components/StatusTag'
import GlassCard from '../components/GlassCard'
import MetricStrip from '../components/MetricStrip'
import StatTile from '../components/StatTile'
import LogPane from './LogPane'
import PreviewPane from './PreviewPane'

type ParamValue = string | number | boolean

/**
 * 固定表头的补丁样式。
 * 主题把 Table.headerBg 设成了 transparent（为了让卡片的毛玻璃透上来），
 * 但这张表开了 scroll.y，表头是 sticky 的 —— 不给底色的话，滚动时行内容会从表头下面透出来。
 * 只在这一张表上生效，别提升成全局样式。
 */
const RUNS_TABLE_STICKY_HEAD_CSS = `
  .wl-runs-table .ant-table-thead > tr > th {
    background: var(--wl-bg-elevated) !important;
  }
`

const SHOT_POLICY_OPTIONS = [
  { value: 'never', label: '不留痕（最省磁盘）' },
  { value: 'onFail', label: '仅失败时留痕（推荐）' },
  { value: 'always', label: '每步都留痕（很占磁盘）' }
]

function fmtDuration(from: number, to: number | null): string {
  const ms = (to ?? Date.now()) - from
  if (ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`
}

// ── 启动执行的弹窗 ────────────────────────────────────────────────────────

function StartRunModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const instances = useAppStore((s) => s.instances)
  const scripts = useAppStore((s) => s.scripts)
  const accounts = useAppStore((s) => s.accounts)
  const runs = useAppStore((s) => s.runs)
  const settings = useAppStore((s) => s.settings)
  const refreshRuns = useAppStore((s) => s.refreshRuns)
  const selectRun = useAppStore((s) => s.selectRun)

  const [instanceIndex, setInstanceIndex] = useState<number | null>(null)
  const [scriptId, setScriptId] = useState<string | null>(null)
  const [accountId, setAccountId] = useState<string | undefined>(undefined)
  const [shotPolicy, setShotPolicy] = useState<'never' | 'onFail' | 'always'>(settings.shotPolicy)
  const [def, setDef] = useState<ScriptDef | null>(null)
  const [defLoading, setDefLoading] = useState(false)
  const [defError, setDefError] = useState<string | null>(null)
  const [params, setParams] = useState<Record<string, ParamValue>>({})
  const [starting, setStarting] = useState(false)

  // 选中脚本后把完整定义拉下来，参数表单按 ScriptParamDef 动态生成。
  useEffect(() => {
    if (!scriptId) {
      setDef(null)
      setParams({})
      return
    }
    let alive = true
    setDefLoading(true)
    setDefError(null)
    silentCall('script:get', scriptId)
      .then((d) => {
        if (!alive) return
        setDef(d)
        const init: Record<string, ParamValue> = {}
        for (const p of d.params ?? []) {
          if (p.default !== undefined) init[p.key] = p.default
        }
        setParams(init)
      })
      .catch((e: { message?: string }) => {
        if (!alive) return
        setDef(null)
        setDefError(e.message ?? '读取脚本失败')
      })
      .finally(() => {
        if (alive) setDefLoading(false)
      })
    return () => {
      alive = false
    }
  }, [scriptId])

  // 账号选中后，若它有默认脚本就顺手带出来。
  useEffect(() => {
    if (!accountId) return
    const acc = accounts.find((a) => a.id === accountId)
    if (acc?.defaultScriptId && !scriptId) setScriptId(acc.defaultScriptId)
    if (acc && acc.instanceIndex !== null && instanceIndex === null)
      setInstanceIndex(acc.instanceIndex)
  }, [accountId, accounts, scriptId, instanceIndex])

  const instanceOptions = instances.map((i) => {
    const busy = activeRunOfInstance(runs, i.index)
    const disabled = !isInstanceUp(i) || i.adb !== 'connected' || !!busy
    let reason = ''
    if (!isInstanceUp(i)) reason = '（未开机）'
    else if (i.adb !== 'connected') reason = '（adb 未连接）'
    else if (busy) reason = `（正在跑 ${busy.scriptName}）`
    return {
      value: i.index,
      label: `${i.index} · ${i.name}${reason}`,
      disabled
    }
  })

  const submit = async (): Promise<void> => {
    if (instanceIndex === null) {
      toast().warning('请先选择一个实例')
      return
    }
    if (!scriptId) {
      toast().warning('请先选择要执行的脚本')
      return
    }
    const req: StartRunRequest = {
      scriptId,
      instanceIndex,
      accountId,
      params,
      shotPolicy
    }
    setStarting(true)
    try {
      const handle = await call('run:start', req)
      toast().success(`已启动执行 ${handle.runId}`)
      selectRun(handle.runId)
      await refreshRuns()
      onClose()
    } catch {
      /* 已提示 */
    } finally {
      setStarting(false)
    }
  }

  const renderParam = (p: ScriptParamDef): React.JSX.Element => {
    const value = params[p.key]
    const set = (v: ParamValue): void => setParams((old) => ({ ...old, [p.key]: v }))
    if (p.type === 'boolean') {
      return <Switch checked={value === true} onChange={(v) => set(v)} />
    }
    if (p.type === 'number') {
      return (
        <InputNumber
          style={{ width: '100%' }}
          value={typeof value === 'number' ? value : undefined}
          onChange={(v) => set(typeof v === 'number' ? v : 0)}
        />
      )
    }
    if (p.type === 'enum') {
      return (
        <Select
          style={{ width: '100%' }}
          value={typeof value === 'string' ? value : undefined}
          onChange={(v: string) => set(v)}
          options={p.options ?? []}
        />
      )
    }
    return (
      <Input value={typeof value === 'string' ? value : ''} onChange={(e) => set(e.target.value)} />
    )
  }

  return (
    <Modal
      open={open}
      title="启动执行"
      okText="启动"
      cancelText="取消"
      confirmLoading={starting}
      onOk={() => void submit()}
      onCancel={onClose}
      width={620}
      destroyOnHidden
    >
      <Form layout="vertical">
        <Form.Item label="目标实例" required>
          <Select
            placeholder="选择一个已开机且 adb 已连接的实例"
            value={instanceIndex ?? undefined}
            onChange={(v: number) => setInstanceIndex(v)}
            options={instanceOptions}
            notFoundContent="没有可用实例。请先到「实例管理」启动实例并连接 adb。"
          />
        </Form.Item>

        <Form.Item label="脚本" required>
          <Select
            placeholder="选择脚本"
            value={scriptId ?? undefined}
            onChange={(v: string) => setScriptId(v)}
            loading={defLoading}
            options={scripts.map((s) => ({
              value: s.id,
              label: `${s.name}  v${s.version}（${s.stepCount} 步）`
            }))}
            notFoundContent="还没有脚本。到「脚本」页新建一个。"
          />
        </Form.Item>

        <Form.Item label="账号（可选，用于日志归档与参数取值）">
          <Select
            allowClear
            placeholder="不绑定账号"
            value={accountId}
            onChange={(v?: string) => setAccountId(v)}
            options={accounts.map((a) => ({
              value: a.id,
              label: `${a.name}${a.instanceIndex !== null ? `（绑定实例 ${a.instanceIndex}）` : ''}`,
              disabled: !a.enabled
            }))}
          />
        </Form.Item>

        <Form.Item label="截图留痕策略">
          <Select
            value={shotPolicy}
            onChange={(v: 'never' | 'onFail' | 'always') => setShotPolicy(v)}
            options={SHOT_POLICY_OPTIONS}
          />
        </Form.Item>

        {defError && (
          <Alert type="error" showIcon message={defError} style={{ marginBottom: 12 }} />
        )}

        {def && (def.params?.length ?? 0) > 0 && (
          <Card size="small" title="脚本参数" style={{ marginBottom: 8 }}>
            {def.params?.map((p) => (
              <Form.Item key={p.key} label={p.label} extra={p.note} style={{ marginBottom: 12 }}>
                {renderParam(p)}
              </Form.Item>
            ))}
          </Card>
        )}

        {def && (
          <span className="wl-micro">
            脚本参考分辨率 {def.refWidth}x{def.refHeight}
            {def.packageName ? `｜目标应用 ${def.packageName}` : ''}
            {def.templateSetId ? `｜模板集 ${def.templateSetId}` : ''}
            {def.loop ? '｜挂机模式（走完一轮自动重来）' : ''}
          </span>
        )}
      </Form>
    </Modal>
  )
}

// ── 主视图 ────────────────────────────────────────────────────────────────

export default function RunsView(): React.JSX.Element {
  const runs = useAppStore((s) => s.runs)
  const instances = useAppStore((s) => s.instances)
  const selectedRunId = useAppStore((s) => s.selectedRunId)
  const selectRun = useAppStore((s) => s.selectRun)
  const upsertRun = useAppStore((s) => s.upsertRun)
  const refreshRuns = useAppStore((s) => s.refreshRuns)

  const [startOpen, setStartOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [tab, setTab] = useState<'logs' | 'preview'>('logs')

  // worker 直连：状态与日志直接进 store / ring buffer。
  useWorkerPort({
    onStatus: (snap) => upsertRun(snap),
    onLogs: (_runId, entries) => pushLogs(entries),
    onOpened: (runId) => selectRun(runId)
  })

  const selected = useMemo(
    () => runs.find((r) => r.runId === selectedRunId) ?? null,
    [runs, selectedRunId]
  )

  // 命中率：没有匹配记录时是 null（"0%" 会被误读成"全都没命中"）。
  const selectedHitRate =
    selected && selected.stats.matches > 0
      ? Math.round((selected.stats.matchHits / selected.stats.matches) * 100)
      : null

  const activeCount = runs.filter((r) => isRunActive(r.status)).length
  const anyIdleInstance = instances.some(
    (i) => isInstanceUp(i) && i.adb === 'connected' && !activeRunOfInstance(runs, i.index)
  )

  const doRefresh = async (): Promise<void> => {
    setRefreshing(true)
    await refreshRuns()
    setRefreshing(false)
  }

  const control = async (
    runId: string,
    channel: 'run:pause' | 'run:resume' | 'run:stop',
    okText: string
  ): Promise<void> => {
    const r = await tryCall(channel, runId)
    if (r !== undefined) {
      toast().success(okText)
      await refreshRuns()
    }
  }

  const columns: TableColumnsType<RunSnapshot> = [
    {
      title: '实例',
      dataIndex: 'instanceIndex',
      width: 90,
      render: (v: number, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>#{v}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 'var(--wl-fs-micro)' }}>
            {r.serial ?? '—'}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: '脚本 / 账号',
      key: 'script',
      width: 200,
      render: (_: unknown, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text ellipsis>{r.scriptName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 'var(--wl-fs-micro)' }}>
            {r.accountName ?? '未绑定账号'}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (_: unknown, r) => <RunStatusTag status={r.status} />
    },
    {
      title: '进度',
      key: 'progress',
      width: 180,
      render: (_: unknown, r) => {
        if (r.stepTotal && r.stepTotal > 0) {
          const pct = Math.min(100, Math.round((r.stepDone / r.stepTotal) * 100))
          return (
            <Space direction="vertical" size={0} style={{ width: '100%' }}>
              <Progress
                percent={pct}
                size="small"
                status={r.status === 'failed' ? 'exception' : undefined}
              />
              <Typography.Text type="secondary" style={{ fontSize: 'var(--wl-fs-micro)' }} ellipsis>
                {r.currentStepName ?? r.currentStepId ?? '—'}
              </Typography.Text>
            </Space>
          )
        }
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text style={{ fontSize: 'var(--wl-fs-label)' }}>
              第 {r.iteration} 轮
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 'var(--wl-fs-micro)' }} ellipsis>
              已执行 {r.stepDone} 步｜{r.currentStepName ?? '—'}
            </Typography.Text>
          </Space>
        )
      }
    },
    {
      title: '运行时长',
      key: 'duration',
      width: 90,
      render: (_: unknown, r) => fmtDuration(r.startedAt, r.endedAt)
    },
    {
      title: '运行统计',
      key: 'stats',
      width: 250,
      render: (_: unknown, r) => {
        const hitRate =
          r.stats.matches > 0 ? Math.round((r.stats.matchHits / r.stats.matches) * 100) : null
        return (
          <Space size={4} wrap>
            <Tooltip title="截图次数">
              <SemanticTag tone="neutral">截图 {r.stats.captures}</SemanticTag>
            </Tooltip>
            <Tooltip title="模板匹配次数 / 命中次数">
              <SemanticTag tone={hitRate !== null && hitRate < 30 ? 'warning' : 'neutral'}>
                命中 {r.stats.matchHits}/{r.stats.matches}
                {hitRate !== null ? `（${hitRate}%）` : ''}
              </SemanticTag>
            </Tooltip>
            <SemanticTag tone="neutral">点击 {r.stats.taps}</SemanticTag>
            {r.stats.retries > 0 && (
              <SemanticTag tone="warning">重试 {r.stats.retries}</SemanticTag>
            )}
            <Tooltip title="最近一次完整 tick 耗时 / 平均截图耗时。截图 280ms 左右是正常水平。">
              <SemanticTag tone={r.stats.lastTickMs > 2000 ? 'warning' : 'neutral'}>
                tick {r.stats.lastTickMs}ms｜截图 {Math.round(r.stats.avgCaptureMs)}ms
              </SemanticTag>
            </Tooltip>
          </Space>
        )
      }
    },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: 230,
      render: (_: unknown, r) => {
        const live = isRunActive(r.status)
        return (
          <Space size={4} wrap>
            {r.status === 'paused' ? (
              <Button
                size="small"
                icon={<PlayCircleOutlined />}
                onClick={() => void control(r.runId, 'run:resume', '已继续执行')}
              >
                继续
              </Button>
            ) : (
              <Button
                size="small"
                icon={<PauseCircleOutlined />}
                disabled={r.status !== 'running'}
                onClick={() => void control(r.runId, 'run:pause', '已暂停')}
              >
                暂停
              </Button>
            )}
            <Popconfirm
              title="停止这次执行？"
              description="会跑完当前步骤后退出，脚本进度不会保留。"
              okText="停止"
              cancelText="取消"
              disabled={!live}
              onConfirm={() => void control(r.runId, 'run:stop', '已请求停止')}
            >
              <Button size="small" danger icon={<StopOutlined />} disabled={!live}>
                停止
              </Button>
            </Popconfirm>
            <Button
              size="small"
              type={selectedRunId === r.runId ? 'primary' : 'default'}
              onClick={() => selectRun(r.runId)}
            >
              查看
            </Button>
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
            <span>执行监控</span>
            <SemanticTag tone={activeCount > 0 ? 'accent' : 'neutral'}>
              进行中 {activeCount}
            </SemanticTag>
          </Space>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void doRefresh()}>
              刷新
            </Button>
            <Tooltip
              title={
                anyIdleInstance
                  ? ''
                  : '没有空闲且已连接 adb 的实例。请先到「实例管理」启动实例并点「连接」。'
              }
            >
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                disabled={!anyIdleInstance}
                onClick={() => setStartOpen(true)}
              >
                启动执行
              </Button>
            </Tooltip>
          </Space>
        }
      >
        {/*
          这张表开了 scroll.y（表头固定）。主题里 Table.headerBg 被设成 transparent 以贴合毛玻璃，
          固定表头下滚动时行内容会从表头底下透出来 —— 所以这里单独给表头补一层不透明底。
          样式作用域限定在 .wl-runs-table 内，不会影响别的表。
        */}
        <style>{RUNS_TABLE_STICKY_HEAD_CSS}</style>
        <Table<RunSnapshot>
          className="wl-runs-table"
          size="small"
          rowKey="runId"
          columns={columns}
          dataSource={runs}
          pagination={false}
          scroll={{ x: 1200, y: 260 }}
          rowClassName={(r) => (r.runId === selectedRunId ? 'ant-table-row-selected' : '')}
          onRow={(r) => ({ onClick: () => selectRun(r.runId) })}
          locale={{
            emptyText:
              '还没有执行记录。先在「实例管理」启动实例并连接 adb，再点右上角「启动执行」。'
          }}
        />
      </GlassCard>

      {selected?.error && (
        <Alert
          type="error"
          showIcon
          message={`执行 ${selected.runId} 失败`}
          description={selected.error}
        />
      )}

      <GlassCard padding="sm">
        {selected ? (
          <>
            <Descriptions size="small" column={4} style={{ marginBottom: 'var(--wl-space-3)' }}>
              <Descriptions.Item label="执行 id">
                <Typography.Text className="wl-mono" code copyable={{ text: selected.runId }}>
                  {selected.runId}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="实例">#{selected.instanceIndex}</Descriptions.Item>
              <Descriptions.Item label="脚本">{selected.scriptName}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <RunStatusTag status={selected.status} />
              </Descriptions.Item>
            </Descriptions>

            {/* 关键数字：这一排是「标题 > 关键数字 > 标签」三档字号里的中间那档。 */}
            <div style={{ marginBottom: 'var(--wl-space-4)' }}>
              <MetricStrip>
                <StatTile label="截图次数" value={selected.stats.captures} />
                <StatTile
                  label="匹配命中"
                  value={`${selected.stats.matchHits}/${selected.stats.matches}`}
                  tone={selectedHitRate !== null && selectedHitRate < 30 ? 'danger' : 'accent'}
                  hint={
                    selectedHitRate !== null
                      ? `命中率 ${selectedHitRate}%（低于 30% 多半是模板或 ROI 不对）`
                      : '还没有匹配记录'
                  }
                />
                <StatTile label="点击次数" value={selected.stats.taps} />
                <StatTile
                  label="重试次数"
                  value={selected.stats.retries}
                  tone={selected.stats.retries > 0 ? 'danger' : 'neutral'}
                />
                <StatTile
                  label="tick 耗时"
                  value={selected.stats.lastTickMs}
                  unit="ms"
                  tone={selected.stats.lastTickMs > 2000 ? 'danger' : 'neutral'}
                  hint="最近一次完整 tick"
                />
                <StatTile
                  label="平均截图"
                  value={Math.round(selected.stats.avgCaptureMs)}
                  unit="ms"
                  hint="游戏在前台约 750ms 属正常"
                />
              </MetricStrip>
            </div>

            <Tabs
              activeKey={tab}
              onChange={(k) => setTab(k as 'logs' | 'preview')}
              items={[
                {
                  key: 'logs',
                  label: '实时日志',
                  children: <LogPane runId={selected.runId} height={320} />
                },
                {
                  key: 'preview',
                  label: '画面',
                  children: (
                    <PreviewPane
                      instanceIndex={selected.instanceIndex}
                      runId={selected.runId}
                      active={tab === 'preview'}
                      height={380}
                    />
                  )
                }
              ]}
            />
          </>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="上面选一条执行，这里显示它的实时日志与画面"
          />
        )}
      </GlassCard>

      <StartRunModal open={startOpen} onClose={() => setStartOpen(false)} />
    </Space>
  )
}
