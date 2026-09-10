/**
 * 资源徽章：有资源原画就显示图（透明底 PNG，来自 resources/icons/raw 经 scripts/resource-icons.mjs 处理），
 * 没有就退回「一个字 + 序列色」的文字徽章。采集总览行、采集配置卡、数据统计都用它，别各画各的。
 */

import { GATHER_RESOURCE_META, type GatherResourceType } from './types'

interface ResourceBadgeProps {
  type: GatherResourceType
  /** 边长（px），默认 26。 */
  size?: number
  title?: string
}

export function ResourceBadge({ type, size = 26, title }: ResourceBadgeProps): React.JSX.Element {
  const meta = GATHER_RESOURCE_META[type]
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.5)) }
  if (meta.icon) {
    return (
      <div className="wlg-res wlg-res-img" style={style} title={title}>
        <img src={meta.icon} alt={meta.resource} draggable={false} />
      </div>
    )
  }
  return (
    <div className="wlg-res" style={{ ...style, background: meta.colorVar }} title={title}>
      {meta.glyph}
    </div>
  )
}
