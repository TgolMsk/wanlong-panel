/**
 * 「任务计划」页：一个账号勾选若干脚本，每个脚本配一个运行时间，到点自动排队执行。
 *
 * 页面只做三件事：把计划表摆出来、把开关接上、把状态显示清楚。
 * 所有判断（该不该跑、排谁在前、要不要让采集调度器让路）都在主进程的计划器里，
 * 这里一行业务逻辑都不写 —— 同一条规则写两遍，迟早漂移成两套行为。
 *
 * ★ 时间一律北京时间：'HH:MM' 是北京时间的那一刻，绝对时刻用 formatCst() 显示。
 *   宿主机时区不一定是北京（本机实测是 America/Los_Angeles），绝不能用 toLocaleString()。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tooltip,
  Typography
} from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  StopOutlined
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { formatCst } from '@shared/alerts'
import { formatDuration } from '@shared/scheduler'
import {
  PLAN_PHASE_TEXT,
  PLAN_RANGE,
  callPlan,
  clampToRange,
  describeTrigger,
  emptyTask,
  onPlanEvent,
  parseClock,
  type AccountPlan,
  type PlanConfig,
  type PlanOverview,
  type PlanTask,
  type PlanTaskState,
  type TaskTrigger
} from '@shared/plan'
import { makeId } from '@shared/defaults'
import { useAppStore } from '../store/appStore'
import { normalizeError, toast } from '../ipc/useIpc'
import GlassCard from '../components/GlassCard'
import { SemanticTag } from '../components/StatusTag'

const PHASE_TONE: Record<PlanTaskState['phase'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  idle: 'neutral',
  queued: 'warning',
  running: 'success',
  done: 'success',
  failed: 'danger',
  skipped: 'warning'
}

interface TaskDraft {
  accountId: string
  task: PlanTask
  /** 编辑已有任务时为 true（账号不可改）。 */
  editing: boolean
}

export default function PlansView(): React.JSX.Element {
  const accounts = useAppStore((s) => s.accounts)
  const scripts = useAppStore((s) => s.scripts)
  const refreshAccounts = useAppStore((s) => s.refreshAccounts)
  const refreshScripts = useAppStore((s) => s.refreshScripts)

  const [overview, setOverview] = useState<PlanOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [draft, setDraft] = useState<TaskDraft | null>(null)
  const [configOpen, setConfigOpen] = useState(false)
  const [configDraft, setConfigDraft] = useState<PlanConfig | null>(null)
  /** 每秒动一下，让「下次运行 / 已等」这类倒计时走起来。纯本地递推，零 IPC。 */
  const [now, setNow] = useState(Date.now())

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setOverview(await callPlan('plan:state'))
    } catch (e) {
      toast().error(normalizeError(e).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshAccounts()
    void refreshScripts()
    void reload()
  }, [reload, refreshAccounts, refreshScripts])

  useEffect(() => onPlanEvent('plan:changed', (o) => setOverview(o)), [])
  useEffect(
    () =>
      onPlanEvent('plan:configChanged', (c) =>
        setOverview((prev) => (prev ? { ...prev, config: c } : prev))
      ),
    []
  )

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const config = overview?.config ?? null
  const rows = useMemo(() => {
    const list = [...(overview?.tasks ?? [])]
    // 同一个账号的任务挨在一起，账号内按优先级从高到低（= 实际执行顺序）。
    list.sort(
      (a, b) =>
        a.accountName.localeCompare(b.accountName, 'zh-CN') ||
        b.priority - a.priority ||
        a.taskId.localeCompare(b.taskId)
    )
    return list
  }, [overview])

  const scriptOptions = useMemo(
    () => scripts.map((s) => ({ value: s.id, label: `${s.name}（${s.stepCount} 步）` })),
    [scripts]
  )
  const accountOptions = useMemo(
    () =>
      accounts.map((a) => ({
        value: a.id,
        label:
          a.instanceIndex == null
            ? `${a.name}（未绑定实例）`
            : `${a.name}（实例 ${a.instanceIndex}）`
      })),
    [accounts]
  )

  // ── 操作 ────────────────────────────────────────────────────────────────

  const guard = async (fn: () => Promise<PlanOverview>, okMessage?: string): Promise<void> => {
    try {
      setOverview(await fn())
      if (okMessage) toast().success(okMessage)
    } catch (e) {
      toast().error(normalizeError(e).message)
    }
  }

  const toggleTask = (row: PlanTaskState, enabled: boolean): void => {
    void guard(() => callPlan('plan:setTaskEnabled', row.accountId, row.taskId, enabled))
  }

  const toggleAccount = (accountId: string, enabled: boolean): void => {
    void guard(() => callPlan('plan:setAccountEnabled', accountId, enabled))
  }

  const runNow = (row: PlanTaskState): void => {
    void guard(() => callPlan('plan:runNow', row.accountId, row.taskId), '已加入队列')
  }

  const cancel = (row: PlanTaskState): void => {
    void guard(() => callPlan('plan:cancel', row.accountId, row.taskId), '已取消')
  }

  /** 增删改都走「读整份 → 改 tasks → 整份写回」，主进程那边只有一条覆盖保存通道。 */
  const mutatePlan = async (
    accountId: string,
    fn: (plan: AccountPlan) => AccountPlan
  ): Promise<void> => {
    try {
      const current = await callPlan('plan:get', accountId)
      await callPlan('plan:save', fn(current))
      await reload()
    } catch (e) {
      toast().error(normalizeError(e).message)
    }
  }

  const removeTask = (row: PlanTaskState): void => {
    void mutatePlan(row.accountId, (plan) => ({
      ...plan,
      tasks: plan.tasks.filter((t) => t.id !== row.taskId)
    }))
  }

  const openNew = (): void => {
    const accountId = accounts[0]?.id
    const scriptId = scripts[0]?.id
    if (!accountId || !scriptId) {
      toast().warning('先去「账号管理」建一个账号、去「脚本」页建一个脚本，再来排计划。')
      return
    }
    setDraft({ accountId, task: emptyTask(makeId('task'), scriptId), editing: false })
  }

  const openEdit = async (row: PlanTaskState): Promise<void> => {
    try {
      const plan = await callPlan('plan:get', row.accountId)
      const task = plan.tasks.find((t) => t.id === row.taskId)
      if (!task) {
        toast().error('这条任务已经不在计划里了，刷新一下再试。')
        return
      }
      setDraft({ accountId: row.accountId, task, editing: true })
    } catch (e) {
      toast().error(normalizeError(e).message)
    }
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    const t = draft.task
    if (t.trigger.kind === 'daily') {
      const bad = t.trigger.at.filter((v) => parseClock(v) == null)
      if (t.trigger.at.length === 0 || bad.length > 0) {
        toast().error('「每天」至少要填一个时刻，格式是 HH:MM（北京时间），例如 08:00。')
        return
      }
    }
    await mutatePlan(draft.accountId, (plan) => {
      const tasks = plan.tasks.some((x) => x.id === t.id)
        ? plan.tasks.map((x) => (x.id === t.id ? t : x))
        : [...plan.tasks, t]
      // 新建计划时账号开关默认打开，否则勾了任务却发现整个账号是关的，很容易误以为坏了。
      return { ...plan, enabled: plan.tasks.length === 0 ? true : plan.enabled, tasks }
    })
    setDraft(null)
  }

  const saveConfig = async (): Promise<void> => {
    if (!configDraft) return
    try {
      const next = await callPlan('plan:saveConfig', configDraft)
      setOverview((prev) => (prev ? { ...prev, config: next } : prev))
      setConfigOpen(false)
      toast().success('已保存')
    } catch (e) {
      toast().error(normalizeError(e).message)
    }
  }

  // ── 表格 ────────────────────────────────────────────────────────────────

  const columns: ColumnsType<PlanTaskState> = [
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 76,
      render: (_v, row) => (
        <Tooltip title={row.accountEnabled ? '勾上才会自动跑' : '这个账号的总开关是关的'}>
          <Switch
            size="small"
            checked={row.enabled}
            onChange={(v) => toggleTask(row, v)}
            disabled={!row.accountEnabled}
          />
        </Tooltip>
      )
    },
    {
      title: '账号',
      dataIndex: 'accountName',
      width: 180,
      render: (_v, row) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Switch
              size="small"
              checked={row.accountEnabled}
              onChange={(v) => toggleAccount(row.accountId, v)}
            />
            <Typography.Text>{row.accountName}</Typography.Text>
          </Space>
          {row.instanceIndex == null ? (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              未绑定实例，跑不了
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              实例 {row.instanceIndex}
            </Typography.Text>
          )}
        </Space>
      )
    },
    {
      title: '脚本',
      dataIndex: 'scriptName',
      render: (_v, row) =>
        row.scriptName ? (
          <Space direction="vertical" size={0}>
            <Typography.Text>{row.scriptName}</Typography.Text>
            {row.note && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {row.note}
              </Typography.Text>
            )}
          </Space>
        ) : (
          <Typography.Text type="danger">脚本已删除（{row.scriptId}）</Typography.Text>
        )
    },
    {
      title: '运行时间',
      dataIndex: 'trigger',
      width: 200,
      render: (_v, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{describeTrigger(row.trigger)}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            优先级 {row.priority}
            {row.maxRunMinutes > 0 ? ` · 上限 ${row.maxRunMinutes} 分钟` : ' · 不限时'}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: '状态',
      dataIndex: 'phase',
      width: 150,
      render: (_v, row) => (
        <Space direction="vertical" size={2}>
          <SemanticTag tone={PHASE_TONE[row.phase]}>{PLAN_PHASE_TEXT[row.phase]}</SemanticTag>
          {row.phase === 'queued' && row.queuedAt != null && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已等 {formatDuration(now - row.queuedAt)}
            </Typography.Text>
          )}
          {row.lastError && row.phase !== 'running' && (
            <Tooltip title={row.lastError}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                {row.lastError}
              </Typography.Text>
            </Tooltip>
          )}
        </Space>
      )
    },
    {
      title: '下次运行',
      dataIndex: 'nextRunAt',
      width: 190,
      render: (_v, row) =>
        row.nextRunAt == null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            <Typography.Text>{formatDuration(row.nextRunAt - now)}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatCst(row.nextRunAt, false)}（北京）
            </Typography.Text>
          </Space>
        )
    },
    {
      title: '上次',
      dataIndex: 'lastEndedAt',
      width: 180,
      render: (_v, row) =>
        row.lastRunAt == null ? (
          <Typography.Text type="secondary">还没跑过</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            <Typography.Text style={{ fontSize: 12 }}>
              {formatCst(row.lastRunAt, false)}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {row.runs} 次{row.fails > 0 ? `，失败 ${row.fails} 次` : ''}
            </Typography.Text>
          </Space>
        )
    },
    {
      title: '操作',
      key: 'actions',
      width: 210,
      render: (_v, row) => (
        <Space size={4}>
          {row.phase === 'running' || row.phase === 'queued' ? (
            <Button size="small" icon={<StopOutlined />} onClick={() => cancel(row)}>
              停止
            </Button>
          ) : (
            <Button
              size="small"
              icon={<PlayCircleOutlined />}
              disabled={row.instanceIndex == null || !row.scriptName}
              onClick={() => runNow(row)}
            >
              立即运行
            </Button>
          )}
          <Button size="small" icon={<EditOutlined />} onClick={() => void openEdit(row)} />
          <Popconfirm title="删掉这条任务？" onConfirm={() => removeTask(row)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <GlassCard
        title="任务计划"
        extra={
          <Space>
            <Space size={6}>
              <Typography.Text type="secondary">总开关</Typography.Text>
              <Tooltip title="关掉后一切定时都不生效，只剩「立即运行」。">
                <Switch
                  checked={config?.enabled ?? false}
                  onChange={(v) => {
                    void (async () => {
                      try {
                        const next = await callPlan('plan:saveConfig', { enabled: v })
                        setOverview((prev) => (prev ? { ...prev, config: next } : prev))
                      } catch (e) {
                        toast().error(normalizeError(e).message)
                      }
                    })()
                  }}
                />
              </Tooltip>
            </Space>
            <Button
              icon={<SettingOutlined />}
              onClick={() => {
                setConfigDraft(config ? { ...config } : null)
                setConfigOpen(true)
              }}
            >
              计划设置
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>
              添加任务
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="脚本优先级最高"
          description={
            <span>
              到点要跑脚本时，采集调度器会先礼后兵地让开（先等它收尾，超时就打断），脚本跑完再放回去并重读一次队列。
              同一个实例上的任务<strong>按优先级排队挨个跑</strong>，不会同时动一个模拟器。运行时间里的 HH:MM
              都是<strong>北京时间</strong>。
            </span>
          }
        />
        {rows.length === 0 ? (
          <Empty description="还没有任何计划。点右上角「添加任务」，给某个账号勾一个脚本、设个时间。" />
        ) : (
          <Table<PlanTaskState>
            size="small"
            rowKey={(r) => `${r.accountId}::${r.taskId}`}
            columns={columns}
            dataSource={rows}
            pagination={false}
            loading={loading}
            scroll={{ x: 1200 }}
          />
        )}
      </GlassCard>

      <TaskModal
        draft={draft}
        accountOptions={accountOptions}
        scriptOptions={scriptOptions}
        onChange={setDraft}
        onCancel={() => setDraft(null)}
        onOk={() => void saveDraft()}
      />

      <Modal
        open={configOpen}
        title="计划设置"
        onCancel={() => setConfigOpen(false)}
        onOk={() => void saveConfig()}
        okText="保存"
        cancelText="取消"
        width={560}
      >
        {configDraft && (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Field
              label="抢占宽限"
              hint="到点要跑脚本、而采集调度器正在动这个实例时，先等它自然收尾这么久；还不让开就打断它。"
            >
              <InputNumber
                min={PLAN_RANGE.preemptGraceMs[0] / 1000}
                max={PLAN_RANGE.preemptGraceMs[1] / 1000}
                value={Math.round(configDraft.preemptGraceMs / 1000)}
                addonAfter="秒"
                onChange={(v) =>
                  setConfigDraft({ ...configDraft, preemptGraceMs: Math.round((v ?? 0) * 1000) })
                }
              />
            </Field>
            <Field
              label="补跑窗口"
              hint="面板关了一会儿、实例刚开机时，错过的触发点在这个时长内还补跑一次；超过就直接等下一次。"
            >
              <InputNumber
                min={0}
                max={PLAN_RANGE.catchUpMs[1] / 60_000}
                value={Math.round(configDraft.catchUpMs / 60_000)}
                addonAfter="分钟"
                onChange={(v) =>
                  setConfigDraft({ ...configDraft, catchUpMs: Math.round((v ?? 0) * 60_000) })
                }
              />
            </Field>
            <Field
              label="排队等待上限"
              hint="排进队列后一直轮不到（实例忙），等超过这个时长就跳过这一轮。"
            >
              <InputNumber
                min={PLAN_RANGE.queueWaitMs[0] / 60_000}
                max={PLAN_RANGE.queueWaitMs[1] / 60_000}
                value={Math.round(configDraft.queueWaitMs / 60_000)}
                addonAfter="分钟"
                onChange={(v) =>
                  setConfigDraft({
                    ...configDraft,
                    queueWaitMs: Math.round((v ?? 1) * 60_000)
                  })
                }
              />
            </Field>
            <Field label="失败重试" hint="脚本执行失败后再试几次，以及两次之间隔多久。">
              <Space>
                <InputNumber
                  min={PLAN_RANGE.retry[0]}
                  max={PLAN_RANGE.retry[1]}
                  value={configDraft.retry}
                  addonAfter="次"
                  onChange={(v) =>
                    setConfigDraft({
                      ...configDraft,
                      retry: clampToRange(v ?? 0, PLAN_RANGE.retry)
                    })
                  }
                />
                <InputNumber
                  min={0}
                  max={PLAN_RANGE.retryDelayMs[1] / 1000}
                  value={Math.round(configDraft.retryDelayMs / 1000)}
                  addonAfter="秒后"
                  onChange={(v) =>
                    setConfigDraft({ ...configDraft, retryDelayMs: Math.round((v ?? 0) * 1000) })
                  }
                />
              </Space>
            </Field>
            <Field
              label="脚本执行期间允许 AI 介入"
              hint="某一步重试耗尽时，先让视觉大模型看一眼当前画面（多半是活动弹窗挡路），它关掉了就重试这一步。需要「AI 处理」页里已经配好接口。"
            >
              <Switch
                checked={configDraft.aiAssist}
                onChange={(v) => setConfigDraft({ ...configDraft, aiAssist: v })}
              />
            </Field>
          </Space>
        )}
      </Modal>
    </Space>
  )
}

// ── 任务编辑弹窗 ──────────────────────────────────────────────────────────

interface TaskModalProps {
  draft: TaskDraft | null
  accountOptions: { value: string; label: string }[]
  scriptOptions: { value: string; label: string }[]
  onChange: (d: TaskDraft) => void
  onCancel: () => void
  onOk: () => void
}

function TaskModal({
  draft,
  accountOptions,
  scriptOptions,
  onChange,
  onCancel,
  onOk
}: TaskModalProps): React.JSX.Element {
  if (!draft) return <Modal open={false} />
  const t = draft.task
  const setTask = (patch: Partial<PlanTask>): void =>
    onChange({ ...draft, task: { ...t, ...patch } })
  const setTrigger = (trigger: TaskTrigger): void => setTask({ trigger })

  return (
    <Modal
      open
      title={draft.editing ? '编辑任务' : '添加任务'}
      onCancel={onCancel}
      onOk={onOk}
      okText="保存"
      cancelText="取消"
      width={600}
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Field label="账号" hint="任务跑在这个账号绑定的实例上。">
          <Select
            style={{ width: '100%' }}
            options={accountOptions}
            value={draft.accountId}
            disabled={draft.editing}
            onChange={(v) => onChange({ ...draft, accountId: v })}
          />
        </Field>
        <Field
          label="脚本"
          hint="在「脚本」页建好的脚本。模板来自模板库，脚本里引用哪些模板由脚本自己决定。"
        >
          <Select
            style={{ width: '100%' }}
            options={scriptOptions}
            value={t.scriptId}
            onChange={(v) => setTask({ scriptId: v })}
          />
        </Field>
        <Field label="运行时间" hint="HH:MM 一律是北京时间。">
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Segmented
              value={t.trigger.kind}
              options={[
                { label: '每天固定时刻', value: 'daily' },
                { label: '按间隔重复', value: 'interval' },
                { label: '仅手动', value: 'manual' }
              ]}
              onChange={(v) => {
                const kind = v as TaskTrigger['kind']
                if (kind === 'daily') setTrigger({ kind: 'daily', at: ['08:00'] })
                else if (kind === 'interval') setTrigger({ kind: 'interval', everyMinutes: 60 })
                else setTrigger({ kind: 'manual' })
              }}
            />
            {t.trigger.kind === 'daily' && (
              <Select
                mode="tags"
                style={{ width: '100%' }}
                placeholder="输入 08:00 回车，可以加多个时刻"
                value={t.trigger.at}
                onChange={(v) => setTrigger({ kind: 'daily', at: v })}
                tokenSeparators={[',', '，', ' ']}
              />
            )}
            {t.trigger.kind === 'interval' && (
              <IntervalEditor trigger={t.trigger} onChange={setTrigger} />
            )}
            {t.trigger.kind === 'manual' && (
              <Typography.Text type="secondary">
                只在这一页点「立即运行」时才跑。适合还在调试的脚本。
              </Typography.Text>
            )}
          </Space>
        </Field>
        <Field label="优先级" hint="同一个实例上同时到点时，数字大的先跑。">
          <InputNumber
            min={PLAN_RANGE.priority[0]}
            max={PLAN_RANGE.priority[1]}
            value={t.priority}
            onChange={(v) => setTask({ priority: clampToRange(v ?? 50, PLAN_RANGE.priority) })}
          />
        </Field>
        <Field
          label="单次时间上限"
          hint="超过就停掉这次执行，防止一个卡住的脚本一直霸占实例。填 0 表示不限。"
        >
          <InputNumber
            min={PLAN_RANGE.maxRunMinutes[0]}
            max={PLAN_RANGE.maxRunMinutes[1]}
            value={t.maxRunMinutes}
            addonAfter="分钟"
            onChange={(v) =>
              setTask({ maxRunMinutes: clampToRange(v ?? 0, PLAN_RANGE.maxRunMinutes) })
            }
          />
        </Field>
        <Field label="备注" hint="只给自己看。">
          <Input
            value={t.note ?? ''}
            onChange={(e) => setTask({ note: e.target.value || undefined })}
            maxLength={80}
          />
        </Field>
      </Space>
    </Modal>
  )
}

/**
 * 「按间隔重复」的编辑器。
 *
 * 单独拆出来只为一件事：把 trigger 收窄成 interval 分支。写在 TaskModal 里的话，
 * 嵌套 onChange 回调里的 t.trigger 会丢掉收窄（TS 不敢假设回调执行时它还是同一个分支），
 * 于是每次取 window 都要再判一次 kind，读起来全是噪音。
 */
function IntervalEditor({
  trigger,
  onChange
}: {
  trigger: Extract<TaskTrigger, { kind: 'interval' }>
  onChange: (t: TaskTrigger) => void
}): React.JSX.Element {
  const w = trigger.window
  return (
    <Space wrap>
      <InputNumber
        min={PLAN_RANGE.everyMinutes[0]}
        max={PLAN_RANGE.everyMinutes[1]}
        value={trigger.everyMinutes}
        addonBefore="每"
        addonAfter="分钟"
        onChange={(v) =>
          onChange({
            ...trigger,
            everyMinutes: clampToRange(v ?? 60, PLAN_RANGE.everyMinutes)
          })
        }
      />
      <Tooltip title="只在这个北京时间段内跑。起点晚于终点表示跨零点，例如 22:00 至 06:00。">
        <Switch
          checkedChildren="限时段"
          unCheckedChildren="全天"
          checked={Boolean(w)}
          onChange={(on) =>
            onChange({
              ...trigger,
              window: on ? { from: '09:00', to: '23:00' } : undefined
            })
          }
        />
      </Tooltip>
      {w && (
        <Space>
          <Input
            style={{ width: 90 }}
            value={w.from}
            placeholder="09:00"
            onChange={(e) => onChange({ ...trigger, window: { ...w, from: e.target.value } })}
          />
          <span>至</span>
          <Input
            style={{ width: 90 }}
            value={w.to}
            placeholder="23:00"
            onChange={(e) => onChange({ ...trigger, window: { ...w, to: e.target.value } })}
          />
        </Space>
      )}
    </Space>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div style={{ marginBottom: 4 }}>
        <Typography.Text strong>{label}</Typography.Text>
      </div>
      {children}
      {hint && (
        <div style={{ marginTop: 4 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {hint}
          </Typography.Text>
        </div>
      )}
    </div>
  )
}
