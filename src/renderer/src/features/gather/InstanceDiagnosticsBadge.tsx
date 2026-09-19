/**
 * 诊断角标：一个带数字的小按钮，点开才展开「这个实例现在有什么毛病」。
 *
 * 用户原话：「自动采集 报错相关信息以角标提示点开才能查看内容」。
 * 所以这里的规矩是：
 *   · 收起态只给两个信号 —— **几条** + **最重那条有多重**（红 / 黄 / 灰）
 *   · 一条都没有时整个按钮不渲染（没事就不该有东西吸引注意力）
 *   · ★ 动作不藏进角标。「恢复」按钮留在外面（卡脚 / 表格行里），
 *     因为「要点一下才能让它继续干活」这件事本身就该一眼看见。
 *     抽屉里的 PauseBanner 因此传 showResume={false}，免得同一个动作出现两遍。
 *
 * 严重程度、条目内容都来自 diagnostics.ts（纯函数），本文件只负责摆。
 */

import { useMemo, useState } from 'react'
import { Badge, Button, Drawer, Tooltip } from 'antd'
import { WarningOutlined } from '@ant-design/icons'
import type { MumuInstance } from '@shared/domain'
import type { InstanceQueueState } from '@shared/scheduler'
import { formatCst, type InstancePauseState } from '@shared/alerts'
import { PauseBanner } from '@/features/alerts'
import { collectDiagnostics, attentionCount, worstLevel, type DiagnosticItem } from './diagnostics'

const LEVEL_TEXT: Record<DiagnosticItem['level'], string> = {
  error: '故障',
  warning: '提醒',
  info: '说明'
}

export interface InstanceDiagnosticsBadgeProps {
  instance: MumuInstance
  state: InstanceQueueState
  pause: InstancePauseState
  /** 正在恢复（按钮转圈 + 防连点）。 */
  resuming?: boolean
  onResume?: (instanceIndex: number) => void
  /** 表格里没有 MarchRow，要把行内原因也收进来；卡片里不用（行上已经有了）。 */
  rowReasons?: boolean
  imminentMs?: number
  staleAfterMs?: number
}

export function InstanceDiagnosticsBadge({
  instance,
  state,
  pause,
  resuming,
  onResume,
  rowReasons = false,
  imminentMs = 60_000,
  staleAfterMs = 60_000
}: InstanceDiagnosticsBadgeProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)

  // 行原因要一个时刻，但它不随秒变（只用来算「读不出坐标」这类事实），
  // 所以在 memo 里取一次 Date.now()，不挂 useCountdownTick —— 那会让整张表每秒重渲染。
  const items = useMemo(
    () =>
      collectDiagnostics({ state, pause, rowReasons, now: Date.now(), imminentMs, staleAfterMs }),
    [state, pause, rowReasons, imminentMs, staleAfterMs]
  )

  const worst = worstLevel(items)
  if (worst === null) return null

  const count = attentionCount(items)
  const tone = worst === 'error' ? 'var(--wl-danger)' : 'var(--wl-warning)'
  const tip =
    count > 0
      ? `${count} 条需要处理：${items.find((i) => i.level !== 'info')?.title ?? ''}。点开查看原因、处置建议与现场截图。`
      : '有几条说明，点开查看。'

  return (
    <>
      <Tooltip title={tip}>
        <Badge
          count={count > 0 ? count : undefined}
          dot={count === 0}
          size="small"
          style={{ backgroundColor: tone }}
        >
          <Button
            className="wlg-diag-btn"
            type="text"
            size="small"
            icon={<WarningOutlined style={{ color: tone }} />}
            aria-label={`实例 #${instance.index} 诊断信息`}
            onClick={() => setOpen(true)}
          />
        </Badge>
      </Tooltip>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={`诊断 · #${instance.index} ${instance.name}`}
        width={560}
        placement="right"
      >
        <div className="wlg-diag-sections">
          {pause.paused && (
            <PauseBanner
              pause={pause}
              instanceName={instance.name}
              standalone
              resuming={resuming}
              showResume={false}
              onResume={(i) => onResume?.(i)}
            />
          )}

          {items.map((item, i) => (
            <div key={`${item.title}-${i}`} className="wlg-diag-text">
              <span className={`wl-label wlg-diag-level-${item.level}`}>
                {LEVEL_TEXT[item.level]} · {item.title}
              </span>
              <div>{item.text}</div>
            </div>
          ))}

          <div className="wl-micro">
            上次采样
            {state.lastSampledAt > 0
              ? ` ${formatCst(state.lastSampledAt, false)}（北京时间）`
              : '：还没采过'}
            {state.backoffStep > 0 && ` · 正在退避重试（第 ${state.backoffStep} 次）`}
          </div>
        </div>
      </Drawer>
    </>
  )
}

export default InstanceDiagnosticsBadge
