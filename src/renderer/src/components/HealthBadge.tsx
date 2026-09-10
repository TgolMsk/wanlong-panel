/**
 * 环境自检徽标。悬停展开每一项的中文结论与修复建议。
 * 数据来自 app:health（首屏拉一次 + 主进程 app:health 事件推送）。
 */

import { useState } from 'react'
import { Button, Empty, Popover, Space, Typography } from 'antd'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  ReloadOutlined
} from '@ant-design/icons'
import type { HealthReport } from '@shared/domain'
import { useAppStore } from '../store/appStore'
import { tryCall } from '../ipc/useIpc'
import { SemanticTag } from './StatusTag'

function formatTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function Content({
  report,
  onRecheck,
  checking
}: {
  report: HealthReport | null
  onRecheck: () => void
  checking: boolean
}): React.JSX.Element {
  return (
    <div style={{ width: 380 }}>
      {!report ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="尚未拿到自检结果，主进程可能还没就绪"
        />
      ) : (
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {report.items.map((it) => (
            <div
              key={it.key}
              style={{
                display: 'flex',
                gap: 8,
                padding: '6px 0',
                borderBottom: '1px solid var(--wl-split)'
              }}
            >
              <span style={{ marginTop: 2 }}>
                {it.ok ? (
                  <CheckCircleFilled style={{ color: 'var(--wl-success)' }} />
                ) : (
                  <CloseCircleFilled style={{ color: 'var(--wl-danger)' }} />
                )}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{it.label}</div>
                <Typography.Paragraph
                  type={it.ok ? 'secondary' : 'danger'}
                  style={{
                    marginBottom: 0,
                    fontSize: 'var(--wl-fs-label)',
                    whiteSpace: 'pre-wrap'
                  }}
                >
                  {it.detail}
                </Typography.Paragraph>
              </div>
            </div>
          ))}
        </div>
      )}
      <Space style={{ marginTop: 10, width: '100%', justifyContent: 'space-between' }}>
        <span className="wl-micro">最近自检：{report ? formatTime(report.checkedAt) : '—'}</span>
        <Button size="small" icon={<ReloadOutlined />} loading={checking} onClick={onRecheck}>
          重新自检
        </Button>
      </Space>
    </div>
  )
}

export default function HealthBadge({ compact = true }: { compact?: boolean }): React.JSX.Element {
  const health = useAppStore((s) => s.health)
  const setHealth = useAppStore((s) => s.setHealth)
  const [checking, setChecking] = useState(false)

  const recheck = async (): Promise<void> => {
    setChecking(true)
    const r = await tryCall('app:health')
    if (r) setHealth(r)
    setChecking(false)
  }

  const bad = health ? health.items.filter((i) => !i.ok) : []
  const unknown = !health

  // 徽标本身包一层 <span> 是给 Popover 挂 ref 用的（SemanticTag 是纯函数组件，接不了 ref）。
  const tag = (
    <span style={{ cursor: 'pointer', display: 'inline-flex' }}>
      {unknown ? (
        <SemanticTag tone="neutral" icon={<ExclamationCircleFilled />}>
          自检未完成
        </SemanticTag>
      ) : health.ok ? (
        <SemanticTag tone="success" icon={<CheckCircleFilled />}>
          环境正常
        </SemanticTag>
      ) : (
        <SemanticTag tone="danger" icon={<CloseCircleFilled />}>
          {bad.length} 项异常
        </SemanticTag>
      )}
    </span>
  )

  if (compact) {
    return (
      <Popover
        trigger="click"
        placement="bottomRight"
        title="环境自检"
        content={<Content report={health} onRecheck={recheck} checking={checking} />}
      >
        {tag}
      </Popover>
    )
  }

  // 非紧凑模式：设置页里直接铺开。
  return <Content report={health} onRecheck={recheck} checking={checking} />
}
