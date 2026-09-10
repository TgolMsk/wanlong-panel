/**
 * 关键数字磁贴。
 *
 * 这是风格规范里「标题 > 关键数字 > 标签」三档字号的中间那一档：
 *   数字用 `.wl-metric`（28px / semibold / 紧字距），单位小一号跟在后面，
 *   标签用 `.wl-label`（12px 薰衣草灰），提示用 `.wl-micro`（11px）。
 * 三档字号必须拉开，别在调用处再改字号。
 */

export type StatTone = 'accent' | 'neutral' | 'danger'

const TONE_COLOR: Record<StatTone, string> = {
  accent: 'var(--wl-accent)',
  neutral: 'var(--wl-text)',
  danger: 'var(--wl-danger)'
}

export interface StatTileProps {
  label: string
  /** 数字本体。字符串（如 `12/40`）或数字都行。 */
  value: React.ReactNode
  /** 单位，跟在数字右边，小一号低对比。 */
  unit?: string
  tone?: StatTone
  /** 数字下方的一句中文说明，用来解释这个数字什么时候算不正常。 */
  hint?: string
}

export default function StatTile({
  label,
  value,
  unit,
  tone = 'neutral',
  hint
}: StatTileProps): React.JSX.Element {
  return (
    <div style={{ minWidth: 108 }}>
      <div className="wl-label" style={{ marginBottom: 'var(--wl-space-1)' }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span className="wl-metric" style={{ color: TONE_COLOR[tone] }}>
          {value}
        </span>
        {unit && (
          <span
            style={{
              fontSize: 'var(--wl-fs-label)',
              color: 'var(--wl-text-tertiary)'
            }}
          >
            {unit}
          </span>
        )}
      </div>
      {hint && (
        <div className="wl-micro" style={{ marginTop: 'var(--wl-space-1)' }}>
          {hint}
        </div>
      )}
    </div>
  )
}
