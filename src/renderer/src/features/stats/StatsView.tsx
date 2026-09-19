/**
 * 「数据统计」页：按北京日期看当天的派兵 / 预计采集量 / 完成趟数 / 失败熔断 / 告警 / 暂停时长，
 * 下方是按资源、按实例的分桶，当天的资源统计快照，以及近 RECENT_DAYS 天的走势表。
 *
 * 口径（见 @shared/stats 文件头）：
 *   · 日桶按**北京时间**切，日期切换只在 DateKey 上用 shiftDateKey 运算，不碰本机时区。
 *   · 「预计采集量」= Σ 派兵时读到的卡片储量（精确到个位），是日采集量的主数据源。
 *   · 「资源统计快照」精度只到 0.1亿，只作对账，页面上明确标出，绝不拿它做差值当采集量。
 *
 * 会去动模拟器的只有一处：「读一次资源统计」按钮（走 stats:snapshotNow，主进程抢实例锁，
 * 采集脚本在跑时会直接被拒绝并给中文原因）。其余全部是读本地日桶，零 adb 开销。
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Select, Space, Table, Tooltip, type TableProps } from 'antd'
import { LeftOutlined, ReloadOutlined, RightOutlined, CameraOutlined } from '@ant-design/icons'
import { formatCst, formatCstClock } from '@shared/alerts'
import { RESOURCE_NAME, RESOURCE_TYPES, formatCnAmount } from '@shared/resources'
import {
  cstDateKey,
  emptyDailyStats,
  formatPausedDuration,
  livePausedMs,
  shiftDateKey,
  type DailyStats,
  type DateKey,
  type InstanceDailyStats
} from '@shared/stats'
import { isInstanceUp, useAppStore } from '@/store/appStore'
import { toast } from '@/ipc/useIpc'
import GlassCard from '@/components/GlassCard'
import MetricStrip from '@/components/MetricStrip'
import StatTile from '@/components/StatTile'
import { SemanticTag } from '@/components/StatusTag'
import ResourceSnapshotTable from './ResourceSnapshotTable'
import { RECENT_DAYS, subscribeStats, todayKey, useStatsStore } from './statsStore'
import './stats.css'
import { ResourceBadge } from '@/features/gather/ResourceBadge'

/** 「暂停时长」里进行中的那段要走表，30 秒刷一次足够（不是倒计时，不用每秒跳）。 */
const LIVE_TICK_MS = 30_000

function useSlowTick(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), LIVE_TICK_MS)
    return () => clearInterval(t)
  }, [])
  return now
}

/** 全部实例当天累计暂停时长（含仍在进行中的那段）。 */
function totalPausedMs(s: DailyStats, now: number): number {
  return Object.values(s.byInstance).reduce((acc, i) => acc + livePausedMs(i, now), 0)
}

function totalCompleted(s: DailyStats): number {
  return RESOURCE_TYPES.reduce((acc, t) => acc + s.byResource[t].completed, 0)
}

function totalEstimated(s: DailyStats): number {
  return RESOURCE_TYPES.reduce((acc, t) => acc + s.byResource[t].estimatedAmount, 0)
}

function totalUnknownStorage(s: DailyStats): number {
  return RESOURCE_TYPES.reduce((acc, t) => acc + s.byResource[t].unknownStorageDispatches, 0)
}

/** 实例的预计采集量。 */
function instanceEstimated(i: InstanceDailyStats): number {
  return RESOURCE_TYPES.reduce((acc, t) => acc + i.byResource[t].estimatedAmount, 0)
}

/** 数字为 0 时压暗，让有数据的行一眼跳出来。 */
function Num({ v, cls }: { v: number; cls?: string }): React.JSX.Element {
  return <span className={`wls-num ${v === 0 ? 'wls-dim' : (cls ?? '')}`}>{v}</span>
}

export default function StatsView(): React.JSX.Element {
  const instances = useAppStore((s) => s.instances)
  const accounts = useAppStore((s) => s.accounts)

  const selectedKey = useStatsStore((s) => s.selectedKey)
  const selectedRaw = useStatsStore((s) => s.selected)
  const recent = useStatsStore((s) => s.recent)
  const loaded = useStatsStore((s) => s.loaded)
  const loading = useStatsStore((s) => s.loading)
  const error = useStatsStore((s) => s.error)
  const snapshotting = useStatsStore((s) => s.snapshotting)
  const load = useStatsStore((s) => s.load)
  const selectDay = useStatsStore((s) => s.selectDay)
  const snapshotNow = useStatsStore((s) => s.snapshotNow)

  const now = useSlowTick()
  const tk = todayKey()
  const isToday = selectedKey === tk
  // 还没拉到就先给一个空桶占位，界面结构不跳。
  const selected = selectedRaw ?? emptyDailyStats(selectedKey)

  const [snapIndex, setSnapIndex] = useState<number | null>(null)

  useEffect(() => {
    void load()
    return subscribeStats()
  }, [load])

  // 默认选第一个开着机的实例做「读一次资源统计」的目标。
  useEffect(() => {
    if (snapIndex !== null && instances.some((i) => i.index === snapIndex)) return
    const first = instances.find(isInstanceUp) ?? instances[0]
    setSnapIndex(first ? first.index : null)
  }, [instances, snapIndex])

  const accountNameOf = useMemo(() => {
    const map = new Map<number, string>()
    for (const a of accounts) if (a.instanceIndex != null) map.set(a.instanceIndex, a.name)
    return (idx: number): string | null => map.get(idx) ?? null
  }, [accounts])

  // ── 汇总数字 ────────────────────────────────────────────────────────────
  const estimated = totalEstimated(selected)
  const completed = totalCompleted(selected)
  const unknown = totalUnknownStorage(selected)
  const paused = totalPausedMs(selected, isToday ? now : Number.POSITIVE_INFINITY)
  const pausedNow = Object.values(selected.byInstance).filter((i) => i.pausedSince != null).length
  const hasAnyData =
    selected.dispatches > 0 ||
    selected.failures > 0 ||
    selected.circuitBreaks > 0 ||
    selected.alerts > 0 ||
    selected.pausedMs > 0 ||
    selected.snapshots.length > 0 ||
    Object.keys(selected.byInstance).length > 0

  // ── 按资源 ──────────────────────────────────────────────────────────────
  const resourceRows = useMemo(
    () =>
      RESOURCE_TYPES.map((t) => {
        const r = selected.byResource[t]
        // 占比按预计采集量算；一趟都没读到储量时退回派兵次数占比，避免整栏全空。
        const share =
          estimated > 0
            ? r.estimatedAmount / estimated
            : selected.dispatches > 0
              ? r.dispatches / selected.dispatches
              : 0
        return { type: t, ...r, share }
      }),
    [selected, estimated]
  )

  // ── 按实例 ──────────────────────────────────────────────────────────────
  const instanceRows = useMemo(
    () => Object.values(selected.byInstance).sort((a, b) => a.instanceIndex - b.instanceIndex),
    [selected]
  )

  const instanceColumns: TableProps<InstanceDailyStats>['columns'] = [
    {
      title: '实例',
      dataIndex: 'instanceIndex',
      width: 170,
      render: (idx: number, r) => {
        const name = r.accountName ?? accountNameOf(idx)
        return (
          <Space size={6}>
            <span>实例 {idx}</span>
            {name && <span className="wl-micro">「{name}」</span>}
            {r.pausedSince != null && isToday && <SemanticTag tone="danger">暂停中</SemanticTag>}
          </Space>
        )
      }
    },
    { title: '派兵', dataIndex: 'dispatches', align: 'right', render: (v: number) => <Num v={v} /> },
    {
      title: '预计采集量',
      key: 'estimated',
      align: 'right',
      render: (_v, r) => {
        const n = instanceEstimated(r)
        return <span className={`wls-mono ${n === 0 ? 'wls-dim' : ''}`}>{n === 0 ? '—' : formatCnAmount(n)}</span>
      }
    },
    {
      title: '失败 / 熔断',
      key: 'fail',
      align: 'right',
      render: (_v, r) => (
        <span>
          <Num v={r.failures} cls="wls-danger" /> / <Num v={r.circuitBreaks} cls="wls-danger" />
        </span>
      )
    },
    { title: '告警', dataIndex: 'alerts', align: 'right', render: (v: number) => <Num v={v} cls="wls-warning" /> },
    {
      title: '暂停时长',
      key: 'paused',
      align: 'right',
      render: (_v, r) => {
        const ms = livePausedMs(r, isToday ? now : Number.POSITIVE_INFINITY)
        return <span className={ms > 0 ? 'wls-warning' : 'wls-dim'}>{formatPausedDuration(ms)}</span>
      }
    }
  ]

  // ── 近 N 天 ─────────────────────────────────────────────────────────────
  const recentDesc = useMemo(() => recent.slice().reverse(), [recent])

  const recentColumns: TableProps<DailyStats>['columns'] = [
    {
      title: '日期（北京）',
      dataIndex: 'dateKey',
      width: 130,
      render: (k: DateKey) => (
        <span className="wls-mono">
          {k}
          {k === tk && <span className="wls-accent"> 今天</span>}
        </span>
      )
    },
    { title: '派兵', dataIndex: 'dispatches', align: 'right', render: (v: number) => <Num v={v} /> },
    {
      title: '预计采集量',
      key: 'estimated',
      align: 'right',
      render: (_v, s) => {
        const n = totalEstimated(s)
        return <span className={`wls-mono ${n === 0 ? 'wls-dim' : ''}`}>{n === 0 ? '—' : formatCnAmount(n)}</span>
      }
    },
    ...RESOURCE_TYPES.map((t) => ({
      title: RESOURCE_NAME[t],
      key: t,
      align: 'right' as const,
      render: (_v: unknown, s: DailyStats) => {
        const r = s.byResource[t]
        return r.dispatches === 0 ? (
          <span className="wls-dim">—</span>
        ) : (
          <Tooltip title={`${r.dispatches} 次派兵，完成 ${r.completed} 趟`}>
            <span className="wls-mono">{formatCnAmount(r.estimatedAmount)}</span>
          </Tooltip>
        )
      }
    })),
    { title: '完成', key: 'completed', align: 'right', render: (_v, s) => <Num v={totalCompleted(s)} /> },
    {
      title: '失败 / 熔断',
      key: 'fail',
      align: 'right',
      render: (_v, s) => (
        <span>
          <Num v={s.failures} cls="wls-danger" /> / <Num v={s.circuitBreaks} cls="wls-danger" />
        </span>
      )
    },
    { title: '告警', dataIndex: 'alerts', align: 'right', render: (v: number) => <Num v={v} cls="wls-warning" /> },
    {
      title: '暂停',
      key: 'paused',
      align: 'right',
      render: (_v, s) => {
        const ms = totalPausedMs(s, s.dateKey === tk ? now : Number.POSITIVE_INFINITY)
        return <span className={ms > 0 ? 'wls-warning' : 'wls-dim'}>{formatPausedDuration(ms)}</span>
      }
    }
  ]

  // ── 操作 ────────────────────────────────────────────────────────────────
  async function handleSnapshot(): Promise<void> {
    if (snapIndex === null) {
      toast().warning('请先选一个实例。')
      return
    }
    const err = await snapshotNow(snapIndex)
    if (err) toast().error(`实例 #${snapIndex} 读资源统计失败：${err}`)
    else toast().success(`实例 #${snapIndex} 已读到一张资源统计快照，已记入今天的日桶。`)
  }

  const instanceOptions = instances.map((i) => {
    const name = accountNameOf(i.index)
    return {
      value: i.index,
      label: `${i.index} · ${name ?? i.name}${isInstanceUp(i) ? '' : '（未开机）'}`,
      disabled: !isInstanceUp(i)
    }
  })

  const snapBusy = snapIndex !== null && snapshotting[snapIndex] === true

  return (
    <div className="wls-page">
      <div className="wls-page-head">
        <div className="wls-page-head-text">
          <span className="wl-label">
            按北京时间每天 0 点分桶。预计采集量来自派兵时读到的卡片储量（按「自动采集至清空」估算）。
          </span>
        </div>
        <Space size={8} wrap>
          <div className="wls-datenav">
            <Tooltip title="前一天">
              <Button size="small" type="text" icon={<LeftOutlined />} onClick={() => void selectDay(shiftDateKey(selectedKey, -1))} />
            </Tooltip>
            <span className={`wls-datenav-key ${isToday ? 'wls-datenav-today' : ''}`}>{selectedKey}</span>
            <Tooltip title={isToday ? '已经是今天' : '后一天'}>
              <Button
                size="small"
                type="text"
                icon={<RightOutlined />}
                disabled={isToday}
                onClick={() => void selectDay(shiftDateKey(selectedKey, 1))}
              />
            </Tooltip>
            <Button size="small" disabled={isToday} onClick={() => void selectDay(tk)}>
              今天
            </Button>
          </div>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            重新拉取
          </Button>
        </Space>
      </div>

      {loaded && error && (
        <Alert type="warning" showIcon message="统计数据没能拉到" description={error} />
      )}

      {/* ── 当日汇总 ─────────────────────────────────────────────────────── */}
      <GlassCard
        title={isToday ? `今日（北京）· ${selectedKey}` : `当日（北京）· ${selectedKey}`}
        extra={
          <span className="wl-micro">
            {selected.updatedAt > 0 ? `最后写入 ${formatCst(selected.updatedAt)}` : '这一天还没有任何记录'}
          </span>
        }
      >
        <MetricStrip>
          <StatTile
            label="派兵次数"
            value={selected.dispatches}
            unit="次"
            tone={selected.dispatches > 0 ? 'accent' : 'neutral'}
            hint="本引擎派出、复验队列 +1 的那些"
          />
          <StatTile
            label="预计采集量"
            value={estimated > 0 ? formatCnAmount(estimated) : '—'}
            tone={estimated > 0 ? 'accent' : 'neutral'}
            hint={
              unknown > 0
                ? `有 ${unknown} 趟储量没读出来，实际会比这个多`
                : 'Σ 派兵时卡片储量，精确到个位'
            }
          />
          <StatTile label="完成趟数" value={completed} unit="趟" hint="派出去的队伍从部队管理面板上消失（回城）" />
          <StatTile
            label="失败 / 熔断"
            value={`${selected.failures} / ${selected.circuitBreaks}`}
            tone={selected.failures + selected.circuitBreaks > 0 ? 'danger' : 'neutral'}
            hint="以 error 收场的采集轮数 / 熔断次数"
          />
          <StatTile
            label="告警"
            value={selected.alerts}
            unit="条"
            tone={selected.alerts > 0 ? 'danger' : 'neutral'}
            hint="含被冷却压掉未推送的"
          />
          <StatTile
            label="暂停时长"
            value={formatPausedDuration(paused)}
            tone={pausedNow > 0 && isToday ? 'danger' : 'neutral'}
            hint={
              pausedNow > 0 && isToday
                ? `${pausedNow} 个实例仍在暂停中，时长在走`
                : '各实例暂停时长之和，跨天在 0 点切开'
            }
          />
        </MetricStrip>

        {!hasAnyData && (
          <div className="wls-summary-foot">
            <span className="wl-micro">
              {isToday
                ? '今天还没有派兵记录。自动调度派出第一支队伍后，这里会实时更新。'
                : '这一天没有任何统计记录（可能当时面板没在跑，或早于统计功能上线）。'}
            </span>
          </div>
        )}
      </GlassCard>

      {/* ── 按资源 / 按实例 ──────────────────────────────────────────────── */}
      <div className="wls-grid-2">
        <GlassCard padding="sm" title="按资源">
          <div className="wls-res-list">
            {resourceRows.map((r) => {
              return (
                <div className="wls-res-row" key={r.type}>
                  <span className="wls-res-glyph" title={RESOURCE_NAME[r.type]}>
                    <ResourceBadge type={r.type} size={22} />
                  </span>
                  <div className="wls-res-main">
                    <div className="wls-res-line">
                      <span className="wls-res-name">{RESOURCE_NAME[r.type]}</span>
                      <span className="wls-res-meta">
                        派兵 {r.dispatches} 次 · 完成 {r.completed} 趟
                        {r.unknownStorageDispatches > 0 && ` · ${r.unknownStorageDispatches} 趟储量未知`}
                        {r.share > 0 && ` · 占 ${Math.round(r.share * 100)}%`}
                      </span>
                    </div>
                    <div className="wls-bar">
                      <div className="wls-bar-fill" style={{ width: `${Math.round(r.share * 100)}%` }} />
                    </div>
                  </div>
                  <span
                    className={`wls-res-amount ${r.estimatedAmount > 0 ? 'wls-res-amount-accent' : 'wls-res-amount-zero'}`}
                    title={r.estimatedAmount > 0 ? `${r.estimatedAmount.toLocaleString('en-US')} 个` : undefined}
                  >
                    {r.estimatedAmount > 0 ? formatCnAmount(r.estimatedAmount) : '—'}
                  </span>
                </div>
              )
            })}
          </div>
        </GlassCard>

        <GlassCard padding="sm" title="按实例">
          {instanceRows.length === 0 ? (
            <div className="wls-empty">
              <div className="wls-empty-title">这一天没有实例产生记录</div>
              <div className="wls-empty-desc">
                派兵、失败、告警、暂停任一发生时实例才会出现在这里。
              </div>
            </div>
          ) : (
            <Table<InstanceDailyStats>
              size="small"
              rowKey="instanceIndex"
              pagination={false}
              columns={instanceColumns}
              dataSource={instanceRows}
            />
          )}
        </GlassCard>
      </div>

      {/* ── 资源统计快照 ─────────────────────────────────────────────────── */}
      <GlassCard
        padding="sm"
        title={`资源统计快照 · ${selected.snapshots.length} 张`}
        extra={
          <div className="wls-snap-actions">
            <Select
              size="small"
              style={{ width: 200 }}
              placeholder="选择实例"
              value={snapIndex ?? undefined}
              onChange={(v: number) => setSnapIndex(v)}
              options={instanceOptions}
              notFoundContent="没有实例"
            />
            <Tooltip title="会占用模拟器几秒：打开「道具 → 资源统计」读一遍再退回主界面。采集脚本正在跑时会被拒绝，稍后再点。">
              <Button
                size="small"
                icon={<CameraOutlined />}
                loading={snapBusy}
                disabled={snapIndex === null}
                onClick={() => void handleSnapshot()}
              >
                读一次资源统计
              </Button>
            </Tooltip>
          </div>
        }
      >
        {selected.snapshots.length === 0 ? (
          <div className="wls-empty">
            <div className="wls-empty-title">这一天还没有资源统计快照</div>
            <div className="wls-empty-desc">
              快照来自游戏「道具 → 资源统计」弹窗（精度 0.1亿，只作对账）。点右上角「读一次资源统计」，
              或在 Telegram 里按「💰 资源」，读到的都会记到当天这里。
            </div>
          </div>
        ) : (
          <ResourceSnapshotTable snapshots={selected.snapshots} accountNameOf={accountNameOf} />
        )}
        <div className="wls-snap-hint" style={{ marginTop: 'var(--wl-space-3)' }}>
          {isToday && cstDateKey(now) !== tk
            ? '北京时间已过 0 点，页面会随主进程推送自动换到新的一天。'
            : `最近一张：${
                selected.snapshots.length > 0
                  ? formatCstClock(selected.snapshots[selected.snapshots.length - 1].at)
                  : '无'
              }`}
        </div>
      </GlassCard>

      {/* ── 近 N 天 ──────────────────────────────────────────────────────── */}
      <GlassCard padding="sm" title={`近 ${RECENT_DAYS} 天`} extra={<span className="wl-micro">点一行切换到那一天</span>}>
        {recentDesc.length === 0 ? (
          <div className="wls-empty">
            <div className="wls-empty-title">还没有历史数据</div>
            <div className="wls-empty-desc">
              {loaded && error ? '统计通道还没接线，接上之后这里会列出每天的汇总。' : '正在拉取…'}
            </div>
          </div>
        ) : (
          <Table<DailyStats>
            size="small"
            rowKey="dateKey"
            pagination={false}
            columns={recentColumns}
            dataSource={recentDesc}
            rowClassName={(s) => `wls-row-clickable ${s.dateKey === selectedKey ? 'wls-row-selected' : ''}`}
            onRow={(s) => ({ onClick: () => void selectDay(s.dateKey) })}
            scroll={{ x: 900 }}
          />
        )}
      </GlassCard>
    </div>
  )
}
