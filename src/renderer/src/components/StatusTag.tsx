/**
 * 状态标签。三套状态机（模拟器实例 / adb 链路 / 执行）共用一个渲染逻辑，
 * 中文文案与配色集中在这里，别在各视图里各写各的。
 *
 * 配色规矩：**不用 antd 的预设色名**（green/red/gold/volcano/processing）。
 * 那套色走的是 antd 自己的调色板，与品牌的薄荷绿 / 珊瑚红不同源，
 * 会让状态标签成为整个面板唯一色系不统一的地方。这里统一改成语义键 +
 * tokens.css 的 `var(--wl-*)`，形状按规范做成药丸形。
 *
 * 中文文案与状态机映射是三条业务流程共用的语义，**一个字都不要改**。
 */

import { Badge } from 'antd'
import type { AdbLinkState, MumuState } from '@shared/domain'
import type { RunStatus } from '@shared/script'

/** 语义色键。对应 tokens.css 的 --wl-<tone> / --wl-<tone>-soft 两个变量。 */
export type SemanticTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent'

interface Desc {
  label: string
  tone: SemanticTone
}

const TONE_FG: Record<SemanticTone, string> = {
  success: 'var(--wl-success)',
  warning: 'var(--wl-warning)',
  danger: 'var(--wl-danger)',
  info: 'var(--wl-info)',
  neutral: 'var(--wl-text-secondary)',
  accent: 'var(--wl-accent)'
}

const TONE_BG: Record<SemanticTone, string> = {
  success: 'var(--wl-success-soft)',
  warning: 'var(--wl-warning-soft)',
  danger: 'var(--wl-danger-soft)',
  info: 'var(--wl-info-soft)',
  neutral: 'var(--wl-neutral-soft)',
  accent: 'var(--wl-accent-soft)'
}

/**
 * 语义药丸标签。顶栏、表格、卡片里所有"一个词的状态"都用它，
 * 保证全面板只有一套状态配色。
 */
export function SemanticTag({
  tone = 'neutral',
  icon,
  children,
  title
}: {
  tone?: SemanticTone
  icon?: React.ReactNode
  children: React.ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 'var(--wl-control-h-sm)',
        paddingInline: 'var(--wl-space-3)',
        borderRadius: 'var(--wl-radius-pill)',
        background: TONE_BG[tone],
        color: TONE_FG[tone],
        fontSize: 'var(--wl-fs-label)',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums'
      }}
    >
      {icon}
      {children}
    </span>
  )
}

const INSTANCE_MAP: Record<string, Desc> = {
  running: { label: '运行中', tone: 'success' },
  starting: { label: '启动中', tone: 'info' },
  stopped: { label: '已关闭', tone: 'neutral' },
  error: { label: '异常', tone: 'danger' }
}

const ADB_MAP: Record<AdbLinkState, Desc> = {
  connected: { label: '已连接', tone: 'success' },
  connecting: { label: '连接中', tone: 'info' },
  disconnected: { label: '未连接', tone: 'neutral' },
  unauthorized: { label: '未授权', tone: 'warning' },
  error: { label: '连接失败', tone: 'danger' }
}

const RUN_MAP: Record<RunStatus, Desc> = {
  pending: { label: '排队中', tone: 'neutral' },
  starting: { label: '启动中', tone: 'info' },
  running: { label: '执行中', tone: 'accent' },
  paused: { label: '已暂停', tone: 'warning' },
  stopping: { label: '停止中', tone: 'warning' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  aborted: { label: '已中止', tone: 'danger' }
}

export function InstanceStateTag({
  state,
  screenReady
}: {
  state: MumuState
  /** 屏幕是否已就绪（state_detail.enableScreen）。运行中但屏幕没起来要单独提示。 */
  screenReady?: boolean
}): React.JSX.Element {
  const d = INSTANCE_MAP[state] ?? { label: state || '未知', tone: 'neutral' as SemanticTone }
  if (state === 'running' && screenReady === false) {
    return <SemanticTag tone="warning">运行中(屏幕未就绪)</SemanticTag>
  }
  return <SemanticTag tone={d.tone}>{d.label}</SemanticTag>
}

export function AdbStateTag({ state }: { state: AdbLinkState }): React.JSX.Element {
  const d = ADB_MAP[state] ?? { label: String(state), tone: 'neutral' as SemanticTone }
  return <SemanticTag tone={d.tone}>{d.label}</SemanticTag>
}

export function RunStatusTag({ status }: { status: RunStatus }): React.JSX.Element {
  const d = RUN_MAP[status] ?? { label: String(status), tone: 'neutral' as SemanticTone }
  return <SemanticTag tone={d.tone}>{d.label}</SemanticTag>
}

/** 小圆点版本，用在标题栏这类空间紧张的地方。 */
export function RunStatusDot({ status }: { status: RunStatus }): React.JSX.Element {
  const running = status === 'running' || status === 'starting'
  const bad = status === 'failed' || status === 'aborted'
  return (
    <Badge
      status={
        running ? 'processing' : bad ? 'error' : status === 'succeeded' ? 'success' : 'default'
      }
      text={RUN_MAP[status]?.label ?? status}
    />
  )
}

export type StatusKind = 'instance' | 'adb' | 'run'

/** 通用入口：<StatusTag kind="run" value={r.status} /> */
export default function StatusTag({
  kind,
  value
}: {
  kind: StatusKind
  value: string
}): React.JSX.Element {
  if (kind === 'adb') return <AdbStateTag state={value as AdbLinkState} />
  if (kind === 'run') return <RunStatusTag status={value as RunStatus} />
  return <InstanceStateTag state={value} />
}
