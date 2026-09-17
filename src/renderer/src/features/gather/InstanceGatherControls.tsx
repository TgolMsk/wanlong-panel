/**
 * 实例列表「自动采集」列的单元格：一行开关 + 队列 N/M + 「采样」按钮，一行状态说明。
 *
 * 与「采集总览」页的卡片脚是同一套语义（同一个 scheduler:setAuto / scheduler:sample），
 * 只是压成两行塞进表格。差异只有两处：
 *   · 被异常暂停时这里只给「已暂停 · 类型」和「恢复」按钮，原因 / 处置建议 / 现场截图仍去总览页看；
 *   · 多两个提醒标签：「配置未启用」（采集配置总开关是关的）与「未绑定账号」——
 *     这两种情况下开了自动调度也只会定时读面板、不会派兵，卡片上没有这层提示，用户常常在这儿踩坑。
 */

import React from 'react'
import { Button, Popconfirm, Switch, Tooltip } from 'antd'
import { PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import type { MumuInstance } from '@shared/domain'
import type { InstanceQueueState } from '@shared/scheduler'
import { alertSpec, formatCst, type InstancePauseState } from '@shared/alerts'
import { SemanticTag, type SemanticTone } from '@/components/StatusTag'
import { QueueBadge } from './InstanceMarchCard'
import { formatAgo, formatClock } from './present'
import './gather.css'

export interface InstanceGatherControlsProps {
  instance: MumuInstance
  state: InstanceQueueState
  pause: InstancePauseState
  /** 当前时刻（毫秒），用来算「几分钟前」；由父组件按秒级或十秒级更新。 */
  now: number
  /** 正在采样（仓库的防连点态或主进程推来的 state.sampling）。 */
  sampling: boolean
  /** 正在切换开关。 */
  toggling: boolean
  /** 正在恢复。 */
  resuming: boolean
  /** 采集配置的总开关（「启用自动采集」）是否打开。 */
  configEnabled: boolean
  /** 是否绑定了账号。主进程只从绑定账号里读采集配置，未绑定的实例开了也不会派兵。 */
  hasAccount: boolean
  /** 是基础实例：只用于克隆，主进程会拒绝给它开自动调度。 */
  isBase: boolean
  onToggleAuto: (instanceIndex: number, enabled: boolean) => void
  onSample: (instanceIndex: number) => void
  onResume: (instanceIndex: number) => void
  /** 跳到这个实例的「采集配置」页。 */
  onOpenConfig: (instanceIndex: number) => void
  /** 跳到「账号管理」页。 */
  onOpenAccounts: () => void
}

interface StatusLine {
  text: string
  tone: SemanticTone | null
  /** 悬停时的补充说明。 */
  tip: string | null
}

/** 第二行该显示什么。优先级从上到下：暂停 > 采样中 > 收尾中 > 上次失败 > 下次唤醒 > 上次采样。 */
function describeStatus(
  state: InstanceQueueState,
  pause: InstancePauseState,
  sampling: boolean,
  now: number
): StatusLine {
  if (pause.paused) {
    const title = pause.type ? alertSpec(pause.type).title : '已暂停'
    return {
      text: `已暂停 · ${title}`,
      tone: 'danger',
      tip:
        `${pause.reason ?? '没有记录原因。'}` +
        `（暂停于 ${pause.pausedAt == null ? '--' : formatCst(pause.pausedAt)} 北京时间）` +
        '原因详情、处置建议与现场截图在「采集总览」页的红条里。'
    }
  }
  if (sampling || state.sampling) {
    return { text: '正在读「部队管理」面板…', tone: 'info', tip: null }
  }
  if (!state.auto && state.operating) {
    return {
      text: '设备操作收尾中',
      tone: 'warning',
      tip: '自动采集已关闭，正在等最后一次设备操作结束。'
    }
  }
  const sampled = state.lastSampledAt > 0
  if (sampled && !state.lastSampleOk) {
    return {
      text: `上次采样失败（${formatAgo(now - state.lastSampledAt)}）`,
      tone: 'danger',
      tip: state.error
    }
  }
  if (state.auto && state.nextWakeAt != null) {
    return {
      text: `下次唤醒 ${formatClock(state.nextWakeAt)}`,
      tone: null,
      tip:
        (state.nextWakeReason ?? '已排定唤醒') +
        (state.backoffStep > 0 ? `（已退避 ${state.backoffStep} 次）` : '')
    }
  }
  if (sampled) {
    return { text: `上次采样 ${formatAgo(now - state.lastSampledAt)}`, tone: null, tip: null }
  }
  return { text: '未采样', tone: null, tip: '还没读过这个实例的「部队管理」面板。' }
}

export function InstanceGatherControls({
  instance,
  state,
  pause,
  now,
  sampling,
  toggling,
  resuming,
  configEnabled,
  hasAccount,
  isBase,
  onToggleAuto,
  onSample,
  onResume,
  onOpenConfig,
  onOpenAccounts
}: InstanceGatherControlsProps): React.JSX.Element {
  const index = instance.index
  const paused = pause.paused
  const up = instance.state === 'running' || instance.state === 'starting'
  const busySampling = sampling || state.sampling
  // 基础实例：主进程会拒绝开启（它只用于克隆），但已经开着的要允许关掉。
  const switchLocked = paused || (isBase && !state.auto)

  const switchTip = paused
    ? '这个实例被异常暂停了，自动调度已经关掉。请用旁边的「恢复」按钮重新开启 —— 那条路会同时清掉暂停记录与推送冷却，直接扳开关不会。'
    : isBase && !state.auto
      ? '基础实例只用于克隆，不参与自动采集。请在克隆出来的副本上开启。'
      : state.auto
        ? '关闭后只保留倒计时展示，不再主动操作这个模拟器（与「采集总览」页的「自动调度」是同一个开关）。'
        : '开启后先读一次「部队管理」面板，之后在队列释放时自动唤醒去派下一轮采集队（与「采集总览」页的「自动调度」是同一个开关）。'

  const sampleTip = !up
    ? '实例未开机，无法采样。'
    : paused
      ? '注意：这个实例已被异常暂停，但「采样」仍然会真的去操作模拟器读一次面板。游戏若还停在异常界面，这次多半也会失败。'
      : '真的去开一次「部队管理」面板读当前队列状态，不派兵。游戏在前台时一次采样十几张截图、几秒钟，请不要连点。'

  const status = describeStatus(state, pause, sampling, now)

  return (
    <div className="wlg-inline-controls">
      <div className="wlg-inline-row">
        <Tooltip title={switchTip}>
          <span className="wlg-inline-hit">
            <Switch
              size="small"
              aria-label={`实例 ${index} 自动采集开关`}
              checked={state.auto}
              loading={toggling}
              disabled={switchLocked}
              onChange={(v) => onToggleAuto(index, v)}
            />
          </span>
        </Tooltip>
        <span className="wl-label">{state.auto ? '已开启' : '未开启'}</span>
        <QueueBadge state={state} />
        <Tooltip title={sampleTip}>
          <span className="wlg-inline-hit">
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={busySampling}
              disabled={!up || busySampling || state.operating === true}
              onClick={() => onSample(index)}
            >
              采样
            </Button>
          </span>
        </Tooltip>
      </div>

      <div className="wlg-inline-row">
        {status.tone ? (
          <SemanticTag tone={status.tone} title={status.tip ?? undefined}>
            {status.text}
          </SemanticTag>
        ) : (
          <Tooltip title={status.tip}>
            <span className="wl-micro">{status.text}</span>
          </Tooltip>
        )}

        {paused && (
          <Popconfirm
            title="确认已经处理好现场了吗？"
            description={
              <span style={{ maxWidth: 300, display: 'inline-block' }}>
                恢复会重新打开实例 #{index}（{instance.name}
                ）的自动采集，并立刻去读一次「部队管理」面板。 如果游戏还停在异常界面（登录页 /
                公告框），多半会马上再次暂停。
              </span>
            }
            okText="确认恢复"
            cancelText="再看看"
            onConfirm={() => onResume(index)}
          >
            <Button size="small" type="primary" icon={<PlayCircleOutlined />} loading={resuming}>
              恢复
            </Button>
          </Popconfirm>
        )}

        {!paused && !hasAccount && (
          <Tooltip title="主进程只从绑定账号里读采集配置：没绑账号的实例开了自动采集也只会定时读面板，不会派兵。点击去「账号管理」页绑定一个账号。">
            <button type="button" className="wlg-tag-btn" onClick={onOpenAccounts}>
              <SemanticTag tone="warning">未绑定账号</SemanticTag>
            </button>
          </Tooltip>
        )}

        {!paused && hasAccount && !configEnabled && (
          <Tooltip title="这个实例的采集配置里「启用自动采集」是关的：开了自动采集也只会定时读面板，不会派兵。点击去「采集配置」页打开并保存。">
            <button type="button" className="wlg-tag-btn" onClick={() => onOpenConfig(index)}>
              <SemanticTag tone="warning">配置未启用</SemanticTag>
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

export default InstanceGatherControls
