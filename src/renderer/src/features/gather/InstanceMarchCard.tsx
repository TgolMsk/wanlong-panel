/**
 * 一个实例一张毛玻璃卡：卡头是实例名 / 账号 / 在线状态 / 队列 N/M + 诊断角标，
 * 卡身是每支队伍一行，卡脚是采样新鲜度 + 下一次唤醒 + 手动操作。
 *
 * ★ 报错 / 提醒 / 暂停原因**不再常驻卡身**，全部收进卡头的诊断角标（点开才展开）——
 *   挂机时十张卡的红条会把真正要看的倒计时挤到屏幕外。但两件事必须留在外面：
 *   ① 暂停时整张卡的红框（唯一剩下的严重性信号）② 卡脚的「恢复」按钮（要点一下才继续干活）。
 */

import React from 'react'
import { Badge, Button, Popconfirm, Switch, Tooltip } from 'antd'
import { PlayCircleOutlined, ReloadOutlined, SlidersOutlined } from '@ant-design/icons'
import type { Account, MumuInstance } from '@shared/domain'
import { freeQueueSlots, type InstanceQueueState } from '@shared/scheduler'
import { emptyPauseState, type InstancePauseState } from '@shared/alerts'
import { formatAgo, formatClock, formatShort } from './present'
import { MarchRow } from './MarchRow'
import { InstanceDiagnosticsBadge } from './InstanceDiagnosticsBadge'
import type { GatherConfigBadge } from './useGatherConfigBadges'

/** 队列徽章。读的是「部队管理」面板右上角的 N/M（实测 4/5）。卡头与实例列表的「自动采集」列共用。 */
export function QueueBadge({ state }: { state: InstanceQueueState }): React.JSX.Element {
  const free = freeQueueSlots(state)
  if (state.queueUsed == null || state.queueTotal == null || free == null) {
    return (
      <Tooltip title="队列占用未能识别。派兵的硬前置之一就是「队列有空位」，读不出来时调度会保守地不派兵，绝不当成 0 或无限。">
        <span className="wlg-queue">
          <span className="wlg-queue-used">?</span>
          <span className="wlg-queue-total">/?</span>
        </span>
      </Tooltip>
    )
  }
  const cls = free === 0 ? 'wlg-queue wlg-queue-full' : 'wlg-queue wlg-queue-free'
  return (
    <Tooltip
      title={
        free === 0
          ? `行军队列已满（${state.queueUsed}/${state.queueTotal}）。必须等队伍回城释放队列才能再派。`
          : `行军队列 ${state.queueUsed}/${state.queueTotal}，还有 ${free} 个空位可以派兵。`
      }
    >
      <span className={cls}>
        <span className="wlg-queue-used">{state.queueUsed}</span>
        <span className="wlg-queue-total">/{state.queueTotal}</span>
      </span>
    </Tooltip>
  )
}

export interface InstanceMarchCardProps {
  instance: MumuInstance
  account: Account | null
  state: InstanceQueueState
  now: number
  imminentMs: number
  staleAfterMs: number
  /** 正在采样（按钮转圈 + 禁用）。 */
  sampling: boolean
  /**
   * 异常暂停态。`paused === true` 时整张卡标红，原因进卡头的诊断角标，卡脚多出「恢复」按钮。
   * ★ 判据是它，**不是 `!auto`** —— 用户自己手动关掉自动调度也会让 auto 为 false，
   *   那是正常操作，不该标红。没接线时传 null 即可。
   */
  pause?: InstancePauseState | null
  /** 正在恢复（「恢复」按钮转圈 + 防连点）。 */
  resuming?: boolean
  onResume?: (instanceIndex: number) => void
  onSample: (instanceIndex: number) => void
  onToggleAuto: (instanceIndex: number, enabled: boolean) => void
  /** 采集配置健康度，决定卡脚「配置」按钮上挂不挂角标。没接线时传 null。 */
  badge?: GatherConfigBadge | null
  /** 就地展开这个实例的采集配置抽屉。 */
  onOpenConfig?: (instanceIndex: number) => void
}

export function InstanceMarchCard({
  instance,
  account,
  state,
  now,
  imminentMs,
  staleAfterMs,
  sampling,
  pause,
  resuming,
  onResume,
  onSample,
  onToggleAuto,
  badge,
  onOpenConfig
}: InstanceMarchCardProps): React.JSX.Element {
  const paused = pause?.paused === true
  const online = instance.state === 'running' && instance.adb === 'connected'
  const starting = instance.state === 'starting' || instance.adb === 'connecting'
  const broken =
    instance.adb === 'error' || instance.adb === 'unauthorized' || instance.state === 'error'

  const dotClass = broken
    ? 'wlg-dot wlg-dot-error'
    : online
      ? 'wlg-dot wlg-dot-online'
      : starting
        ? 'wlg-dot wlg-dot-busy'
        : 'wlg-dot'

  const onlineText = broken
    ? 'adb 异常'
    : online
      ? '在线'
      : starting
        ? '启动中'
        : instance.state === 'running'
          ? '已开机 · adb 未连接'
          : '未开机'

  // 只显示有内容的行；空闲行没必要占版面，队列 N/M 已经说明还剩几个位子。
  const rows = state.marches.filter((m) => m.status !== 'idle')
  const neverSampled = state.lastSampledAt === 0

  return (
    <section className={`wl-glass wlg-card${paused ? ' wla-card-paused' : ''}`}>
      <header className="wlg-card-head">
        <span className={dotClass} aria-hidden />
        <div className="wlg-card-title">
          <div className="wlg-card-name">
            #{instance.index} {instance.name}
          </div>
          <div className="wlg-card-sub">
            <span className="wl-label">{account ? account.name : '未绑定账号'}</span>
            <span className="wl-micro">·</span>
            <span className="wl-micro">{onlineText}</span>
          </div>
        </div>
        <QueueBadge state={state} />
        <InstanceDiagnosticsBadge
          instance={instance}
          state={state}
          pause={pause ?? emptyPauseState(instance.index)}
          resuming={resuming}
          onResume={(i) => onResume?.(i)}
          imminentMs={imminentMs}
          staleAfterMs={staleAfterMs}
        />
      </header>

      <div className="wlg-card-body">
        {!state.auto && state.operating && (
          <div className="wl-micro" role="status">
            设备操作正在收尾，自动派遣已关闭。
          </div>
        )}
        {rows.length > 0 ? (
          rows.map((m) => (
            <MarchRow
              key={`${state.instanceIndex}:${m.slot}`}
              march={m}
              now={now}
              imminentMs={imminentMs}
              staleAfterMs={staleAfterMs}
            />
          ))
        ) : neverSampled ? (
          <div className="wlg-empty">
            <div className="wlg-empty-title">尚未采样</div>
            <div className="wlg-empty-desc">点击「立即采样」读取队伍进度，或开启自动调度。</div>
          </div>
        ) : !state.error ? (
          <div className="wlg-empty">
            <div className="wlg-empty-title">当前没有在途队伍</div>
            <div className="wlg-empty-desc">
              队列空着。打开自动调度后，调度器会在下一次唤醒时派出队伍。
            </div>
          </div>
        ) : null}
      </div>

      <footer className="wlg-card-foot">
        <div className="wlg-field-inline">
          <Tooltip
            title={
              paused
                ? '这个实例被异常暂停了，自动调度已经关掉。请用旁边的「恢复」按钮重新开启 —— 那条路会同时清掉暂停记录与推送冷却，直接扳这个开关不会。暂停原因点卡头右上角的角标看。'
                : '打开后，这个实例会在队列释放时自动被唤醒去派下一轮。关掉只保留倒计时展示，不会主动操作模拟器。'
            }
          >
            <span className="wl-label">自动调度</span>
          </Tooltip>
          <Switch
            size="small"
            checked={state.auto}
            disabled={paused}
            onChange={(v) => onToggleAuto(state.instanceIndex, v)}
          />
          <span className="wl-micro">
            {neverSampled
              ? '未采样'
              : state.lastSampleOk
                ? `上次读面板 ${formatAgo(now - state.lastSampledAt)}`
                : `上次采样失败（${formatAgo(now - state.lastSampledAt)}）`}
          </span>
          {state.nextWakeAt != null && (
            <Tooltip
              title={
                `${state.nextWakeReason ?? '已排定唤醒'}` +
                (state.backoffStep > 0 ? `（已退避 ${state.backoffStep} 次）` : '')
              }
            >
              <span className="wl-micro">
                下次唤醒 {formatClock(state.nextWakeAt)}
                {state.nextWakeAt > now ? `（${formatShort(state.nextWakeAt - now)} 后）` : ''}
              </span>
            </Tooltip>
          )}
        </div>
        <div className="wlg-field-inline">
          {paused && (
            <Popconfirm
              title="确认已经处理好现场了吗？"
              description={
                <span style={{ maxWidth: 300, display: 'inline-block' }}>
                  恢复会重新打开实例 #{instance.index}（{instance.name}）的自动调度，并立刻去读一次
                  「部队管理」面板。如果游戏还停在异常界面（登录页 / 公告框），多半会马上再次暂停。
                </span>
              }
              okText="确认恢复"
              cancelText="再看看"
              onConfirm={() => onResume?.(instance.index)}
            >
              <Button
                size="small"
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={resuming === true}
              >
                恢复
              </Button>
            </Popconfirm>
          )}
          <Tooltip
            title={
              paused
                ? '注意：这个实例已被异常暂停，但「立即采样」仍然会真的去操作模拟器读一次面板。游戏若还停在异常界面（登录页 / 公告框），这次采样多半也会失败。'
                : '真的去开一次「部队管理」面板读当前状态。游戏在前台时单张截图约 750ms，一次采样十几张，请不要连点。'
            }
          >
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={sampling || state.sampling}
              disabled={sampling || state.sampling || state.operating}
              onClick={() => onSample(state.instanceIndex)}
            >
              立即采样
            </Button>
          </Tooltip>
          {onOpenConfig && (
            <Tooltip title={badge?.text ?? '就地展开这个实例的采集配置（改完要点保存）。'}>
              <Badge
                dot={!!badge?.tone}
                size="small"
                style={{
                  backgroundColor:
                    badge?.tone === 'danger' ? 'var(--wl-danger)' : 'var(--wl-warning)'
                }}
              >
                <Button
                  size="small"
                  icon={<SlidersOutlined />}
                  onClick={() => onOpenConfig(instance.index)}
                >
                  配置
                </Button>
              </Badge>
            </Tooltip>
          )}
        </div>
      </footer>
    </section>
  )
}
