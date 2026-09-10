/**
 * 卡片外壳。全面板的分区容器都走它，别再直接用裸 `<Card>`。
 *
 * 三种形态（对应 tokens.css 里冻结的三个工具类，样式不在这里定义）：
 *   · glass  毛玻璃深色卡（默认）—— 低透明度白填充 + 细高光描边 + 柔长阴影
 *   · solid  实心卡 —— 浮层内部、需要压住背景内容的地方用
 *   · sunken 凹槽 —— 比卡片更低一层，日志/画面这类容器用
 *
 * 注意：antd 的 Card 自己也画底色与描边，所以这里把它的边框关掉、底色设成透明，
 * 外观完全交给外层 div 上的 `.wl-glass` / `.wl-solid` / `.wl-sunken`。
 */

import { Card } from 'antd'

export type GlassCardVariant = 'glass' | 'solid' | 'sunken'
export type GlassCardPadding = 'lg' | 'sm'

const VARIANT_CLASS: Record<GlassCardVariant, string> = {
  glass: 'wl-glass',
  solid: 'wl-solid',
  sunken: 'wl-sunken'
}

/** lg 用 --wl-card-pad(20)，sm 用 --wl-card-pad-sm(14)。表格密集的页面用 sm。 */
const PADDING_VAR: Record<GlassCardPadding, string> = {
  lg: 'var(--wl-card-pad)',
  sm: 'var(--wl-card-pad-sm)'
}

export interface GlassCardProps {
  title?: React.ReactNode
  /** 标题右侧的操作区。 */
  extra?: React.ReactNode
  /** 卡片底部的补充区（分割线以下）。 */
  footer?: React.ReactNode
  variant?: GlassCardVariant
  padding?: GlassCardPadding
  /** 追加到卡片正文容器上的类名，例如 `wl-scroll-y`。 */
  bodyClassName?: string
  className?: string
  style?: React.CSSProperties
  children?: React.ReactNode
}

export default function GlassCard({
  title,
  extra,
  footer,
  variant = 'glass',
  padding = 'lg',
  bodyClassName,
  className,
  style,
  children
}: GlassCardProps): React.JSX.Element {
  const pad = PADDING_VAR[padding]
  return (
    <div className={[VARIANT_CLASS[variant], className].filter(Boolean).join(' ')} style={style}>
      <Card
        variant="borderless"
        title={title}
        extra={extra}
        styles={{
          header: {
            background: 'transparent',
            borderBottom: title ? '1px solid var(--wl-split)' : 'none',
            paddingInline: pad,
            minHeight: 0,
            paddingBlock: 'var(--wl-space-3)'
          },
          body: { background: 'transparent', padding: pad }
        }}
        style={{ background: 'transparent', boxShadow: 'none', borderRadius: 'inherit' }}
        classNames={{ body: bodyClassName }}
      >
        {children}
      </Card>
      {footer !== undefined && footer !== null && (
        <div
          style={{
            borderTop: '1px solid var(--wl-split)',
            padding: pad,
            paddingBlock: 'var(--wl-space-3)'
          }}
        >
          {footer}
        </div>
      )}
    </div>
  )
}
