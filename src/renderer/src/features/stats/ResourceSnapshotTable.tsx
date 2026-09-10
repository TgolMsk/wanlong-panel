/**
 * 「资源统计」快照表：当天所有快照的明细 + 每个实例「日初 / 最近」两张快照的对比。
 *
 * ★ 精度纪律（见 @shared/resources 文件头）：这张表读的是游戏「道具 → 资源统计」弹窗，
 *   数值只到 0.1亿 = 1000 万。所以：
 *     · 所有金额显示都带「≈」；
 *     · 「变化」列只是粗对账（发现资源被大量消耗 / 有采集以外的进项），**不是**日采集量；
 *       日采集量以页面上方「预计采集量」（派兵记账）为准。
 *   顶部 Alert 把这句话说给用户听，别让他拿差值去核采集。
 */

import React, { useMemo } from 'react'
import { Alert, Table, Tooltip, type TableProps } from 'antd'
import { formatCstClock } from '@shared/alerts'
import {
  PANEL_AMOUNT_PRECISION,
  RESOURCE_NAME,
  RESOURCE_PANEL_ROW_ORDER,
  formatCnAmount,
  snapshotRow,
  type ResourceSnapshot,
  type ResourceType
} from '@shared/resources'
import { SemanticTag } from '@/components/StatusTag'

export interface ResourceSnapshotTableProps {
  snapshots: ResourceSnapshot[]
  /** instanceIndex -> 账号名（没有就显示「实例 N」）。 */
  accountNameOf: (instanceIndex: number) => string | null
}

/** 某实例当天的首尾两张快照。 */
interface InstancePair {
  instanceIndex: number
  first: ResourceSnapshot
  last: ResourceSnapshot
}

/** 按实例分组并取当天最早 / 最近两张（只有一张时首尾同一张，对比列显示「—」）。 */
function pairByInstance(snapshots: ResourceSnapshot[]): InstancePair[] {
  const byInst = new Map<number, ResourceSnapshot[]>()
  for (const s of snapshots) {
    const list = byInst.get(s.instanceIndex) ?? []
    list.push(s)
    byInst.set(s.instanceIndex, list)
  }
  const out: InstancePair[] = []
  for (const [instanceIndex, list] of byInst) {
    list.sort((a, b) => a.at - b.at)
    out.push({ instanceIndex, first: list[0], last: list[list.length - 1] })
  }
  return out.sort((a, b) => a.instanceIndex - b.instanceIndex)
}

/** 带原始识别文本 Tooltip 的金额单元格。 */
function AmountCell({ value, raw }: { value: number | null; raw: string }): React.JSX.Element {
  if (value == null) {
    return (
      <Tooltip title={raw ? `识别到「${raw}」但没能解析成数字` : '这一格没读出来'}>
        <span className="wls-dim">{raw || '读不出'}</span>
      </Tooltip>
    )
  }
  return (
    <Tooltip title={`识别原文：${raw || '（无）'}　精确值 ${value.toLocaleString('en-US')}`}>
      <span className="wls-mono">≈{formatCnAmount(value)}</span>
    </Tooltip>
  )
}

/** 「变化」单元格：两张快照的资源总量之差。差值小于精度时不显示方向，避免把噪声当趋势。 */
function DeltaCell({ from, to }: { from: number | null; to: number | null }): React.JSX.Element {
  if (from == null || to == null) return <span className="wls-dim">—</span>
  const d = to - from
  if (Math.abs(d) < PANEL_AMOUNT_PRECISION) {
    return (
      <Tooltip title="两张快照相差不到 0.1亿，在这张表的精度内视为没变化">
        <span className="wls-dim">≈0</span>
      </Tooltip>
    )
  }
  const cls = d > 0 ? 'wls-delta-up' : 'wls-delta-down'
  return (
    <span className={`wls-mono ${cls}`}>
      {d > 0 ? '+' : '-'}
      {formatCnAmount(Math.abs(d))}
    </span>
  )
}

export default function ResourceSnapshotTable({
  snapshots,
  accountNameOf
}: ResourceSnapshotTableProps): React.JSX.Element {
  const pairs = useMemo(() => pairByInstance(snapshots), [snapshots])
  const sorted = useMemo(() => snapshots.slice().sort((a, b) => a.at - b.at), [snapshots])

  const who = (idx: number): string => {
    const name = accountNameOf(idx)
    return name ? `实例 ${idx}「${name}」` : `实例 ${idx}`
  }

  // ── 对比表：一行 = 实例 × 资源 ─────────────────────────────────────────
  interface CompareRow {
    key: string
    instanceIndex: number
    type: ResourceType
    firstAt: number
    lastAt: number
    same: boolean
    firstItem: number | null
    firstTotal: number | null
    lastItem: number | null
    lastTotal: number | null
    rawFirstTotal: string
    rawLastTotal: string
    rawLastItem: string
  }

  const compareRows = useMemo<CompareRow[]>(() => {
    const rows: CompareRow[] = []
    for (const p of pairs) {
      for (const type of RESOURCE_PANEL_ROW_ORDER) {
        const a = snapshotRow(p.first, type)
        const b = snapshotRow(p.last, type)
        rows.push({
          key: `${p.instanceIndex}:${type}`,
          instanceIndex: p.instanceIndex,
          type,
          firstAt: p.first.at,
          lastAt: p.last.at,
          same: p.first === p.last,
          firstItem: a?.itemTotal ?? null,
          firstTotal: a?.total ?? null,
          lastItem: b?.itemTotal ?? null,
          lastTotal: b?.total ?? null,
          rawFirstTotal: a?.rawTotal ?? '',
          rawLastTotal: b?.rawTotal ?? '',
          rawLastItem: b?.rawItem ?? ''
        })
      }
    }
    return rows
  }, [pairs])

  const compareColumns: TableProps<CompareRow>['columns'] = [
    {
      title: '实例',
      dataIndex: 'instanceIndex',
      width: 160,
      onCell: (_r, i) => ({ rowSpan: (i ?? 0) % RESOURCE_PANEL_ROW_ORDER.length === 0 ? RESOURCE_PANEL_ROW_ORDER.length : 0 }),
      render: (_v, r) => (
        <div>
          <div>{who(r.instanceIndex)}</div>
          <div className="wl-micro">
            {r.same
              ? `只有 1 张（${formatCstClock(r.firstAt)}）`
              : `${formatCstClock(r.firstAt)} → ${formatCstClock(r.lastAt)}`}
          </div>
        </div>
      )
    },
    { title: '资源', dataIndex: 'type', width: 72, render: (t: ResourceType) => RESOURCE_NAME[t] },
    {
      title: '日初资源总量',
      key: 'firstTotal',
      align: 'right',
      render: (_v, r) => <AmountCell value={r.firstTotal} raw={r.rawFirstTotal} />
    },
    {
      title: '最近资源总量',
      key: 'lastTotal',
      align: 'right',
      render: (_v, r) => <AmountCell value={r.lastTotal} raw={r.rawLastTotal} />
    },
    {
      title: '最近道具总量',
      key: 'lastItem',
      align: 'right',
      render: (_v, r) => <AmountCell value={r.lastItem} raw={r.rawLastItem} />
    },
    {
      title: '变化',
      key: 'delta',
      align: 'right',
      width: 110,
      render: (_v, r) =>
        r.same ? <span className="wls-dim">—</span> : <DeltaCell from={r.firstTotal} to={r.lastTotal} />
    }
  ]

  // ── 明细表：一行 = 一张快照 ─────────────────────────────────────────────
  const detailColumns: TableProps<ResourceSnapshot>['columns'] = [
    {
      title: '时间',
      dataIndex: 'at',
      width: 92,
      render: (at: number) => <span className="wls-mono">{formatCstClock(at)}</span>
    },
    {
      title: '实例',
      dataIndex: 'instanceIndex',
      width: 150,
      render: (i: number) => who(i)
    },
    ...RESOURCE_PANEL_ROW_ORDER.map((type) => ({
      title: RESOURCE_NAME[type],
      key: type,
      align: 'right' as const,
      render: (_v: unknown, s: ResourceSnapshot) => {
        const row = snapshotRow(s, type)
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
            <span>
              <span className="wl-micro">资源 </span>
              <AmountCell value={row?.total ?? null} raw={row?.rawTotal ?? ''} />
            </span>
            <span>
              <span className="wl-micro">道具 </span>
              <AmountCell value={row?.itemTotal ?? null} raw={row?.rawItem ?? ''} />
            </span>
          </div>
        )
      }
    })),
    {
      title: '说明',
      key: 'warnings',
      width: 120,
      render: (_v, s) =>
        s.warnings.length === 0 ? (
          <SemanticTag tone="success">干净</SemanticTag>
        ) : (
          <Tooltip title={s.warnings.join('；')}>
            <SemanticTag tone="warning">{s.warnings.length} 条降级</SemanticTag>
          </Tooltip>
        )
    }
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--wl-space-4)' }}>
      <Alert
        type="info"
        showIcon
        message="精度 0.1亿（1000 万），仅作对账参考"
        description="这张表读的是游戏「道具 → 资源统计」弹窗，一趟魔水只有 42 万，差值会被四舍五入整个吞掉。日采集量以上方「预计采集量」（派兵时读到的卡片储量）为准；这里的「变化」只用来发现资源被大量消耗或有采集以外的进项。"
      />

      <div>
        <div className="wl-label" style={{ marginBottom: 'var(--wl-space-2)' }}>
          日初 / 最近 对比（每实例当天最早与最近两张快照）
        </div>
        <Table<CompareRow>
          size="small"
          rowKey="key"
          pagination={false}
          columns={compareColumns}
          dataSource={compareRows}
        />
      </div>

      <div>
        <div className="wl-label" style={{ marginBottom: 'var(--wl-space-2)' }}>
          全部快照（{sorted.length} 张，按时间升序）
        </div>
        <Table<ResourceSnapshot>
          size="small"
          rowKey={(s) => `${s.instanceIndex}-${s.at}`}
          pagination={sorted.length > 12 ? { pageSize: 12, size: 'small' } : false}
          columns={detailColumns}
          dataSource={sorted}
          scroll={{ x: 900 }}
        />
      </div>
    </div>
  )
}
