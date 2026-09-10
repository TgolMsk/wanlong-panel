/**
 * 「群控倒计时」总览页。
 *
 * 全屏所有倒计时共用一个每秒时钟（useCountdownTick），从采样快照里的绝对时刻本地递推，
 * **零 adb 开销**。采集阶段显示「采集中 HH:MM:SS」，到 gatherDoneAt 会自动翻成
 * 「返回中 MM:SS」——因为 freeAt = gatherDoneAt + travelTime 在派兵那一刻就已知，无需重采样。
 * 真正会去动模拟器的只有两处：卡片上的「立即采样」按钮，以及调度器自己的到点唤醒与周期校准。
 */

import React, { useEffect, useMemo } from 'react'
import { Alert, Button } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { formatDuration } from '@shared/scheduler'
import { alertSpec } from '@shared/alerts'
import { useAppStore, isRunActive } from '@/store/appStore'
import { pauseOf, pausedIndexes, subscribeAlerts, useAlertStore } from '@/features/alerts'
import { toast } from '@/ipc/useIpc'
import GlassCard from '@/components/GlassCard'
import MetricStrip from '@/components/MetricStrip'
import StatTile from '@/components/StatTile'
import { formatAgo, formatClock, formatShort, summarizeQueues } from './present'
import { InstanceMarchCard } from './InstanceMarchCard'
import { emptyQueueState, subscribeScheduler, useMarchStore } from './marchStore'
import { useCountdownTick } from './useCountdownTick'
import './gather.css'

export default function GatherOverviewView(): React.JSX.Element {
  const instances = useAppStore((s) => s.instances)
  const accounts = useAppStore((s) => s.accounts)
  const runs = useAppStore((s) => s.runs)
  const refreshInstances = useAppStore((s) => s.refreshInstances)

  const byInstance = useMarchStore((s) => s.byInstance)
  const config = useMarchStore((s) => s.config)
  const loaded = useMarchStore((s) => s.loaded)
  const error = useMarchStore((s) => s.error)
  const samplingMap = useMarchStore((s) => s.sampling)
  const load = useMarchStore((s) => s.load)
  const sampleOne = useMarchStore((s) => s.sampleOne)
  const setAuto = useMarchStore((s) => s.setAuto)

  // 异常暂停态：与调度状态分开推送（alerts:pauseChanged），所以单独订阅一份。
  const pauses = useAlertStore((s) => s.pauses)
  const resumingMap = useAlertStore((s) => s.resuming)
  const loadAlerts = useAlertStore((s) => s.load)
  const resume = useAlertStore((s) => s.resume)

  const now = useCountdownTick()

  useEffect(() => {
    void load()
    return subscribeScheduler()
  }, [load])

  useEffect(() => {
    void loadAlerts()
    return subscribeAlerts()
  }, [loadAlerts])

  // 临期窗口取「唤醒冗余」的两倍且至少 60 秒：冗余越大，越早该提醒用户「快到了」。
  const imminentMs = Math.max(60_000, config.slackSeconds * 2 * 1000)
  const staleAfterMs = Math.max(60_000, config.calibrateIntervalMin * 60_000)

  // 每个实例都出一张卡，没有调度记录的用占位，保证卡片数量与实例数量一致。
  const states = useMemo(
    () =>
      instances.map(
        (i) =>
          byInstance[i.index] ??
          emptyQueueState(i.index, accounts.find((a) => a.instanceIndex === i.index)?.id ?? null)
      ),
    [instances, byInstance, accounts]
  )

  const sum = useMemo(() => summarizeQueues(states), [states])
  const pausedList = useMemo(() => pausedIndexes(pauses), [pauses])
  const activeRuns = runs.filter((r) => isRunActive(r.status)).length

  const nextFreeText =
    sum.nextFreeAt == null
      ? '—'
      : sum.nextFreeAt <= now
        ? '已到期'
        : formatShort(sum.nextFreeAt - now)

  async function handleSample(index: number): Promise<void> {
    const err = await sampleOne(index)
    if (err) toast().error(`实例 #${index} 采样失败：${err}`)
    else toast().success(`实例 #${index} 已重新读取「部队管理」面板。`)
  }

  async function handleToggleAuto(index: number, enabled: boolean): Promise<void> {
    const err = await setAuto(index, enabled)
    if (err) toast().error(`实例 #${index} ${enabled ? '开启' : '关闭'}自动调度失败：${err}`)
  }

  // 恢复 = 清掉暂停记录 + 重新打开自动调度 + 清掉该实例的推送冷却，全部由主进程一次做完。
  async function handleResume(index: number): Promise<void> {
    const err = await resume(index)
    if (err) {
      toast().error(`实例 #${index} 恢复失败：${err}`)
      return
    }
    toast().success(`实例 #${index} 已恢复自动调度，正在重新读一次「部队管理」面板。`)
    void load()
  }

  return (
    <div className="wlg-page">
      <div className="wlg-page-head">
        <div className="wlg-page-head-text">
          <h1 className="wl-title">群控倒计时</h1>
          <span className="wl-label">
            所有实例的在途队伍与队列占用。倒计时在本地每秒递推，不会为了刷新数字去截图。
          </span>
        </div>
        <div className="wlg-actions-btns">
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            重新拉取调度状态
          </Button>
          <Button onClick={() => void refreshInstances(true)}>刷新实例列表</Button>
        </div>
      </div>

      {loaded && error && (
        <Alert type="warning" showIcon message="调度状态没能拉到" description={error} />
      )}

      {pausedList.length > 0 && (
        <Alert
          type="error"
          showIcon
          message={`${pausedList.length} 个实例已被暂停，需要人工介入`}
          description={
            <span>
              {pausedList
                .map((i) => {
                  const p = pauseOf(pauses, i)
                  const title = p.type ? alertSpec(p.type).title : '已暂停'
                  return `#${i}（${title}）`
                })
                .join('、')}
              ：自动调度已经关掉，不会再操作这些实例的游戏。
              处理完现场后到下面对应的红色卡片上点「恢复」。
            </span>
          }
        />
      )}

      <GlassCard>
        <MetricStrip>
          <StatTile
            label="总队列占用"
            value={sum.queueTotal > 0 ? `${sum.queueUsed}/${sum.queueTotal}` : '—'}
            hint={
              sum.queueTotal > 0
                ? `已读到队列数据的 ${sum.instanceCount} 个实例合计`
                : '还没有实例读到面板右上角的队列 N/M'
            }
          />
          <StatTile
            label="最近到期"
            value={nextFreeText}
            tone="accent"
            hint={
              sum.nextFreeAt == null
                ? '当前没有能算出释放时刻的在途队伍'
                : `实例 #${sum.nextFreeInstance} 于 ${formatClock(sum.nextFreeAt)} 释放队列，唤醒还会再加 ${config.slackSeconds} 秒冗余`
            }
          />
          <StatTile
            label="在途队伍"
            value={sum.activeMarches}
            unit="支"
            hint="正在行军 / 采集 / 返程，不含空闲行与读不出的行"
          />
          <StatTile
            label="执行中任务"
            value={activeRuns}
            unit="个"
            hint="orchestrator 里仍占着实例的执行数，同一实例同时只能跑一个"
          />
          {(sum.unreadableMarches > 0 || sum.failedInstances > 0) && (
            <StatTile
              label="识别异常"
              value={sum.unreadableMarches + sum.failedInstances}
              unit="处"
              tone="danger"
              hint={`${sum.unreadableMarches} 行倒计时读不出、${sum.failedInstances} 个实例采样失败，原因见各卡片`}
            />
          )}
        </MetricStrip>

        <div
          className="wlg-summary-foot"
          style={{ marginTop: 'var(--wl-space-4)', paddingTop: 'var(--wl-space-3)' }}
        >
          <span className="wl-micro">
            {sum.autoInstances} 个实例已开自动调度
            {sum.nextWakeAt != null &&
              ` · 下次唤醒 ${formatClock(sum.nextWakeAt)}（实例 #${sum.nextWakeInstance}${
                sum.nextWakeReason ? ` · ${sum.nextWakeReason}` : ''
              }）`}
          </span>
          <span className="wl-micro">
            {sum.oldestSampledAt == null
              ? '尚无采样'
              : `最旧一份采样于 ${formatAgo(now - sum.oldestSampledAt)}`}
            {` · 校准间隔 ${formatDuration(config.calibrateIntervalMin * 60_000)}`}
          </span>
        </div>
      </GlassCard>

      {instances.length === 0 ? (
        <div className="wl-glass wlg-empty">
          <div className="wlg-empty-title">没有可显示的实例</div>
          <div className="wlg-empty-desc">
            面板还没有拉到 MuMu 实例列表。到「实例」页刷新一次，或确认 mumutool 路径配置正确。
          </div>
        </div>
      ) : (
        <div className="wlg-cards">
          {instances.map((inst, i) => (
            <InstanceMarchCard
              key={inst.index}
              instance={inst}
              account={accounts.find((a) => a.instanceIndex === inst.index) ?? null}
              state={states[i]}
              now={now}
              imminentMs={imminentMs}
              staleAfterMs={staleAfterMs}
              sampling={samplingMap[inst.index] === true}
              pause={pauseOf(pauses, inst.index)}
              resuming={resumingMap[inst.index] === true}
              onResume={(idx) => void handleResume(idx)}
              onSample={(idx) => void handleSample(idx)}
              onToggleAuto={(idx, v) => void handleToggleAuto(idx, v)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
