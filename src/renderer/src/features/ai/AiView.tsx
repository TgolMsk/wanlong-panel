/**
 * 「AI 处理」页：上半是接口配置（AiSettingsCard），下半是完整的处理记录表。
 * 记录来自 ai:history（首屏拉 50 条）+ ai:consulted 增量推送，由 aiStore 维护。
 */

import React, { useEffect } from 'react'
import { Button, Space, Table, Tag, Tooltip, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import {
  AI_ACTION_LABEL,
  AI_OUTCOME_LABEL,
  AI_SCREEN_LABEL,
  AI_RISK_LABEL,
  type AiConsultRecord
} from '@shared/ai'
import { formatCst } from '@shared/alerts'
import GlassCard from '@/components/GlassCard'
import { SemanticTag } from '@/components/StatusTag'
import AiSettingsCard from './AiSettingsCard'
import { useAiStore } from './aiStore'

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
  const load = useAiStore((s) => s.load)

  useEffect(() => {
    void load()
  }, [load])

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
      <AiSettingsCard />
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
