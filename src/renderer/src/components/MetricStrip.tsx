/**
 * 一排关键数字磁贴的容器。窄屏自动换行，磁贴之间有分割线。
 * 只管排布，不管内容 —— 里面放 <StatTile />。
 */

export interface MetricStripProps {
  children?: React.ReactNode
  className?: string
}

export default function MetricStrip({ children, className }: MetricStripProps): React.JSX.Element {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: 'var(--wl-space-3)',
        rowGap: 'var(--wl-space-4)',
        columnGap: 'var(--wl-space-6)'
      }}
    >
      {children}
    </div>
  )
}
