/**
 * 「AI 处理」页（左侧一级入口）。从上到下三块：
 *   1. **总开关**：顶部第一眼就能看见、点一下立刻保存（不需要再点「保存」）。
 *      用户原话：「开关也设置在改内容页面顶部」。
 *   2. **接口配置**：默认折叠，点标题右边那个带角标的按钮才展开（AiSettingsCard）。
 *      角标的含义：红 = 还没配完（缺地址 / Key / 模型名），黄 = 配好了但总开关没开，无点 = 正常工作。
 *   3. **处理记录**：完整表格，来自 ai:history（首屏 50 条）+ ai:consulted 增量推送。
 *
 * ★ 订阅（subscribeAi）在本页做，不在 AiSettingsCard 里 —— 配置折叠起来时也要继续收 ai:consulted。
 */

import React, { useEffect, useState } from 'react'
import { Badge, Button, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { DownOutlined, ReloadOutlined, RobotOutlined, SettingOutlined } from '@ant-design/icons'
import {
  AI_ACTION_LABEL,
  AI_OUTCOME_LABEL,
  AI_SCREEN_LABEL,
  AI_RISK_LABEL,
  type AiConsultRecord
} from '@shared/ai'
import { formatCst } from '@shared/alerts'
import { toast } from '@/ipc/useIpc'
import GlassCard from '@/components/GlassCard'
import { SemanticTag } from '@/components/StatusTag'
import AiSettingsCard from './AiSettingsCard'
import { subscribeAi, useAiStore } from './aiStore'

const OUTCOME_COLOR: Record<AiConsultRecord['outcome'], string> = {
  skipped: 'default',
  failed: 'error',
  unparsable: 'warning',
  no_action: 'default',
  rejected: 'warning',
  applied: 'processing',
  verified: 'success',
  harvested: 'success'
}

const CONTEXT_LABEL: Record<string, string> = {
  'gather-g0': '采集流程',
  'scheduler-sample': '调度采样',
  test: '设置页测试'
}

export default function AiView(): React.JSX.Element {
  const history = useAiStore((s) => s.history)
  const status = useAiStore((s) => s.status)
  const configView = useAiStore((s) => s.configView)
  const saving = useAiStore((s) => s.saving)
  const load = useAiStore((s) => s.load)
  const saveConfig = useAiStore((s) => s.saveConfig)

  const [configOpen, setConfigOpen] = useState(false)

  useEffect(() => {
    void load()
    return subscribeAi()
  }, [load])

  // 配完整 = 地址 + Key + 模型名都有。status 是主进程算的，拿不到时退回看 configView。
  const configured = status ? status.configured : !!(configView.baseUrl && configView.apiKeySet && configView.model)
  const enabled = configView.enabled

  const badgeTone = !configured ? 'var(--wl-danger)' : !enabled ? 'var(--wl-warning)' : null
  const badgeText = !configured
    ? '还没配完：接口地址、API Key、模型名三样齐了才能用。点开填。'
    : !enabled
      ? '接口已配好，但上面的总开关没开 —— 认不出界面时不会问模型。'
      : '接口配置正常。点开可以改地址 / 模型 / 限额，或测一次视觉能力。'

  // 总开关：点一下直接落盘，不走表单的「保存」。
  const toggleEnabled = async (v: boolean): Promise<void> => {
    const err = await saveConfig({ enabled: v })
    if (err) {
      toast().error(`${v ? '启用' : '关闭'} AI 顾问失败：${err}`)
      return
    }
    toast().success(v ? 'AI 顾问已启用。' : 'AI 顾问已关闭，认不出界面时照旧只走 BACK 兜底。')
  }

  const columns: TableColumnsType<AiConsultRecord> = [
    { title: '时间', dataIndex: 'at', width: 150, render: (v: number) => formatCst(v) },
    {
      title: '实例',
      dataIndex: 'instanceIndex',
      width: 70,
      render: (v: number | null) => (v === null ? '—' : v)
    },
    {
      title: '来源',
      dataIndex: 'context',
      width: 100,
      render: (v: string) => CONTEXT_LABEL[v] ?? v
    },
    {
      title: '结果',
      dataIndex: 'outcome',
      width: 150,
      render: (v: AiConsultRecord['outcome']) => (
        <Tag color={OUTCOME_COLOR[v]}>{AI_OUTCOME_LABEL[v]}</Tag>
      )
    },
    {
      title: '模型判断',
      key: 'advice',
      width: 260,
      render: (_: unknown, r) =>
        r.advice ? (
          <span className="wl-micro">
            {AI_SCREEN_LABEL[r.advice.screen]} / {AI_ACTION_LABEL[r.advice.action]} / 置信{' '}
            {r.advice.confidence.toFixed(2)}
            {r.advice.target
              ? ` / 目标 (${r.advice.target.x},${r.advice.target.y} ${r.advice.target.w}×${r.advice.target.h})`
              : ''}
            {r.advice.refined ? ' / 已精修' : ''}
          </span>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        )
    },
    {
      title: '风险评估',
      key: 'risk',
      width: 240,
      render: (_: unknown, r) =>
        r.advice?.risk ? (
          <Tooltip
            title={`${r.advice.risk.reason}；点击后：${r.advice.risk.consequence}；依据：${r.advice.risk.dialogText}`}
          >
            <span>
              <Tag color={r.advice.risk.level === 'low' ? 'success' : 'warning'}>
                {AI_RISK_LABEL[r.advice.risk.level] ?? '风险不明'}
              </Tag>
              {r.advice.risk.buttonText || '无点击'}
              {r.advice.riskRechecked ? ' · 已复核' : ''}
            </span>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">未评估（旧记录）</Typography.Text>
        )
    },
    {
      title: '耗时',
      dataIndex: 'latencyMs',
      width: 80,
      render: (v: number) => `${(v / 1000).toFixed(1)}s`
    },
    {
      title: '新模板',
      dataIndex: 'harvestedTemplateId',
      width: 200,
      render: (v: string | null) => (v ? <Typography.Text code>{v}</Typography.Text> : '—')
    },
    {
      title: '说明',
      dataIndex: 'message',
      ellipsis: { showTitle: false },
      render: (v: string) => (
        <Tooltip title={v} placement="topLeft">
          <span>{v}</span>
        </Tooltip>
      )
    }
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {/* ── 顶部：总开关 + 折叠起来的接口配置入口 ───────────────────────── */}
      <GlassCard
        padding="sm"
        title={
          <Space size={10}>
            <RobotOutlined />
            <span>AI 顾问总开关</span>
            <Switch
              checkedChildren="已启用"
              unCheckedChildren="已关闭"
              checked={enabled}
              loading={saving}
              disabled={!configured && !enabled}
              onChange={(v) => void toggleEnabled(v)}
            />
            {!configured && (
              <span className="wl-micro">先点右边「接口配置」把地址、Key、模型名填好才能启用。</span>
            )}
          </Space>
        }
        extra={
          <Tooltip title={badgeText}>
            <Badge
              dot={badgeTone !== null}
              size="small"
              style={badgeTone ? { backgroundColor: badgeTone } : undefined}
            >
              <Button
                icon={configOpen ? <DownOutlined /> : <SettingOutlined />}
                onClick={() => setConfigOpen((v) => !v)}
              >
                接口配置
              </Button>
            </Badge>
          </Tooltip>
        }
      >
        <span className="wl-micro">
          {status
            ? `最近一小时 ${status.callsLastHour} / ${status.maxCallsPerHour || '∞'} 次 · 累计问询 ${status.consultCount} 次 · 自学模板 ${status.harvestedCount} 张 · ${status.configured ? (status.enabled ? '已启用' : '已配置但未启用') : '尚未配置完整'}`
            : '还没拿到状态。'}
          {' · 只有采集 / 采样认不出界面时才会问，白名单里只有关闭与取消两种动作会真的去点。'}
        </span>
      </GlassCard>

      {configOpen && <AiSettingsCard />}
      <GlassCard
        padding="sm"
        title={
          <Space>
            <span>处理记录</span>
            {status && (
              <SemanticTag tone="info">
                最近一小时 {status.callsLastHour} 次 · 累计 {status.consultCount} 次 · 自学模板{' '}
                {status.harvestedCount} 张
              </SemanticTag>
            )}
          </Space>
        }
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        }
      >
        <Table<AiConsultRecord>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={history}
          pagination={{ pageSize: 20, size: 'small' }}
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText: '还没有记录。只有在采集 / 采样认不出界面、且 AI 顾问已启用时才会问询。'
          }}
        />
      </GlassCard>
    </Space>
  )
}
