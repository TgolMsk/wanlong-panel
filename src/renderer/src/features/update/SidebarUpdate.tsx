/**
 * 侧栏左下角的版本号 + 更新入口。
 *
 * 用户要的是「版本号和更新放在左下角」：平时只是一行不起眼的版本号，
 * 有新版本时右边挂一个红点，点开才是完整的更新面板（与设置页那张卡同一份正文）。
 *
 * 两种形态都由本组件自己决定，**App.tsx 里不要再写 `!collapsed &&`**：
 *   · 展开（208px）：`v<版本号>` 文字按钮，靠 .wl-sidebar-bottom 的 space-between 待在左边
 *   · 收起（72px）：只剩一个图标按钮，版本号进 Tooltip —— 56px 可用宽度放不下两个文字控件
 *
 * ★ 红点只表示「真的有新版本」。检查失败不亮点，理由见 updateStore.hasPendingUpdate。
 */

import { useState } from 'react'
import { Button, Popover, Tooltip } from 'antd'
import { CloudDownloadOutlined, InfoCircleOutlined } from '@ant-design/icons'
import UpdatePanel from './UpdatePanel'
import { hasPendingUpdate, useUpdateFeed, useUpdateStore } from './updateStore'

export interface SidebarUpdateProps {
  /** 侧栏是否收起。收起时只显示图标，版本号进 Tooltip。 */
  collapsed: boolean
}

export function SidebarUpdate({ collapsed }: SidebarUpdateProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  useUpdateFeed()
  const state = useUpdateStore((s) => s.state)

  const version = state ? `v${state.currentVersion}` : '读取中…'
  const pending = hasPendingUpdate(state)
  const hint = pending
    ? `有新版本 v${state?.latestVersion ?? ''}，点开看更新说明`
    : `${version} · 点开检查更新`

  const panel = (
    <Popover
      trigger="click"
      placement={collapsed ? 'rightBottom' : 'topLeft'}
      open={open}
      onOpenChange={setOpen}
      title="版本与更新"
      content={<UpdatePanel compact />}
    >
      {collapsed ? (
        <Button
          type="text"
          size="small"
          aria-label={hint}
          icon={pending ? <CloudDownloadOutlined /> : <InfoCircleOutlined />}
        />
      ) : (
        <button type="button" className="wl-sidebar-version" aria-label={hint}>
          <span className="wl-sidebar-note">{version}</span>
          {pending && <span className="wl-sidebar-version-dot" aria-hidden="true" />}
        </button>
      )}
    </Popover>
  )

  // 弹层开着的时候不要再挂 Tooltip，两层浮层叠在一起会互相抢焦点。
  return open ? (
    panel
  ) : (
    <Tooltip title={hint} placement={collapsed ? 'right' : 'top'}>
      {panel}
    </Tooltip>
  )
}

export default SidebarUpdate
