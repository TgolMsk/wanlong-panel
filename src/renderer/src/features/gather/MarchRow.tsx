/**
 * 一支在途队伍的一行：资源徽章 + 目标坐标 + 倒计时进度条。
 *
 * 这一行**每秒重渲染一次**，所以刻意做得很轻：几乎没有 antd 组件，只有一次纯计算
 * （present.ts → @shared/scheduler.deriveMarchView）。倒计时全部来自本地时钟递推，零 adb 开销。
 */

import React, { memo } from 'react'
import { Tooltip } from 'antd'
import { MARCH_STATUS_TEXT, type MarchState } from '@shared/scheduler'
import { formatClock, formatShort, presentMarch, type MarchTone } from './present'
import { GATHER_RESOURCE_META, readResourceType } from './types'
import { ResourceBadge } from './ResourceBadge'

/** 薄荷绿填充的细进度条。progress 为 null 时走「进度不可知」的斜纹态，不编造假比例。 */
function MarchProgressBar({
  progress,
  tone
}: {
  progress: number | null
  tone: MarchTone
}): React.JSX.Element {
  if (progress === null) {
    return (
      <div className="wlg-bar" role="progressbar" aria-label="进度未知">
        <div className="wlg-bar-indeterminate" />
      </div>
    )
  }
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100)
  const fillClass =
    tone === 'warning'
      ? 'wlg-bar-fill wlg-bar-fill-warning'
      : tone === 'danger'
        ? 'wlg-bar-fill wlg-bar-fill-danger'
        : tone === 'neutral'
          ? 'wlg-bar-fill wlg-bar-fill-neutral'
          : 'wlg-bar-fill'
  return (
    <div
      className="wlg-bar"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={fillClass} style={{ width: `${pct}%` }} />
    </div>
  )
}

export interface MarchRowProps {
  march: MarchState
  /** 由 useCountdownTick 提供的统一时刻，保证全屏所有行的秒数完全同步。 */
  now: number
  /** 剩余不足多少毫秒算临期（高亮）。 */
  imminentMs: number
  /** 采样超过多久算数据陈旧（灰化并标「待校准」）。 */
  staleAfterMs: number
}

function MarchRowInner({ march, now, imminentMs, staleAfterMs }: MarchRowProps): React.JSX.Element {
  const p = presentMarch(march, now, { imminentMs, staleAfterMs })
  const resource = readResourceType(march)
  const meta = resource ? GATHER_RESOURCE_META[resource] : null

  const rowClass = [
    'wlg-row',
    p.reasonLevel === 'error' && p.reason ? 'wlg-row-error' : '',
    p.imminent && p.tone === 'warning' ? 'wlg-row-imminent' : '',
    p.stale ? 'wlg-row-stale' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const timerToneClass =
    p.tone === 'accent'
      ? 'wlg-timer-accent'
      : p.tone === 'warning'
        ? 'wlg-timer-warning'
        : p.tone === 'danger'
          ? 'wlg-timer-danger'
          : 'wlg-timer-neutral'

  // 只有真的是一串数字时才用大号等宽样式；「待校准」「倒计时不可用」这类中文说明用正常字号。
  const timerIsNumber = p.view.remainingMs != null && p.view.remainingMs > 0

  const commanderText = march.commanders
    .map((c) => (c.current == null || c.max == null ? null : `${c.current}/${c.max}`))
    .filter((s): s is string => s !== null)
    .join(' · ')

  return (
    <div className={rowClass}>
      {meta && resource ? (
        <Tooltip title={`${meta.resource}（搜索面板分类「${meta.category}」）`}>
          <span>
            <ResourceBadge type={resource} size={28} />
          </span>
        </Tooltip>
      ) : (
        <Tooltip title="资源类型未知：采集中的行按左侧资源点缩略图自动识别（木材/金币/魔水已有模板，铁矿石待补）；行军中/返回中的行缩略图是部队图，认不出，只有面板自己派的队才能按坐标从派兵记录里查到。">
          <div className="wlg-res wlg-res-unknown">?</div>
        </Tooltip>
      )}

      <div className="wlg-row-main">
        <div className="wlg-row-line">
          <span className="wlg-row-phase">
            {p.view.phase === 'unknown' ? MARCH_STATUS_TEXT[march.status] : p.view.phaseText}
          </span>
          <span className="wl-mono wlg-row-coord">
            {march.targetCoord ? `坐标 ${march.targetCoord}` : '坐标未识别'}
          </span>
          {march.troopCount != null && (
            <span className="wlg-row-badge">{march.troopCount.toLocaleString('zh-CN')} 兵</span>
          )}
          {commanderText && (
            <Tooltip title="本行指挥官的耐力。全部指挥官都低于配置的最低耐力时本轮不派兵。">
              <span className="wlg-row-badge">耐力 {commanderText}</span>
            </Tooltip>
          )}
          {march.travelTimeSource === 'fallback' && march.status !== 'idle' && (
            <Tooltip title="单程行军耗时没有从「创建部队」页读到，用的是配置里的兜底估计，释放时刻只是估算值。">
              <span className="wlg-row-badge wlg-row-badge-warn">行军时长为估算</span>
            </Tooltip>
          )}
          {march.travelTimeSource === 'unrecorded' && march.status !== 'idle' && (
            <Tooltip title="没有这支队的派兵记录（手动派出的，或记录已丢失）：行军耗时按配置兜底值估算，释放时刻只是估算值。采完回城后由面板接管派兵即可。">
              <span className="wlg-row-badge">非面板派出</span>
            </Tooltip>
          )}
          {p.stale && (
            <Tooltip
              title={`距上次读「部队管理」面板已超过校准间隔 ${formatShort(p.staleForMs)}，倒计时可能有漂移，等下一次校准纠正。`}
            >
              <span className="wlg-row-badge wlg-row-badge-warn">待校准</span>
            </Tooltip>
          )}
        </div>

        <MarchProgressBar progress={p.view.progress} tone={p.tone} />
      </div>

      <div className="wlg-row-timer">
        <div
          className={`wlg-timer-text ${timerToneClass} ${timerIsNumber ? '' : 'wlg-timer-text-plain'}`}
        >
          {p.text}
        </div>
        {p.freeAt != null && march.status !== 'idle' && (
          <Tooltip
            title={`队列预计在 ${formatClock(p.freeAt)} 释放。调度器的唤醒时刻还会在此之上再加「唤醒冗余」，宁晚勿早。`}
          >
            <span className="wl-micro">释放 {formatClock(p.freeAt)}</span>
          </Tooltip>
        )}
      </div>

      {p.reason && (
        <div className={`wlg-row-reason ${p.reasonLevel === 'error' ? '' : 'wlg-row-reason-warn'}`}>
          第 {march.slot} 行：{p.reason}
        </div>
      )}
    </div>
  )
}

/**
 * memo 的比较函数：only 当 now 跨了一整秒、或者 march 引用变了才重渲染。
 * 主要是挡住父组件因为别的原因重渲染带来的连锁开销。
 */
export const MarchRow = memo(MarchRowInner, (a, b) => {
  return (
    a.march === b.march &&
    Math.floor(a.now / 1000) === Math.floor(b.now / 1000) &&
    a.imminentMs === b.imminentMs &&
    a.staleAfterMs === b.staleAfterMs
  )
})
