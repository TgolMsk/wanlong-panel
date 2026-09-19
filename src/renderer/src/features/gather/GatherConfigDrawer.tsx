/**
 * 采集配置抽屉：把整页表单就地展开在右侧，不跳页。
 *
 * 为什么是抽屉而不是页面：配置是**按实例（按账号）**存的，做成一级页面就必须先在页头
 * 选实例，用户从卡片过来时等于要选两遍。抽屉从哪个卡片/哪一行点开就配哪个实例，没有歧义。
 *
 * 两个挂载点（各自持有自己的 local state，不进 appStore）：
 *   · features/gather/GatherOverviewView.tsx —— 页头按钮 + 每张卡片卡脚的「配置」
 *   · views/InstancesView.tsx —— 「更多 → 采集配置」
 *
 * ★ 抽屉里的表单是「改完点保存」，关抽屉不会自动保存。
 *   而抽屉比页面容易误关得多（点一下外面的遮罩、按一下 Esc 就没了），
 *   所以这里**必须**拦一道：有未保存的修改时先问一句，别让改了半天的配置无声消失。
 *   标题下面那句常驻提示也是为此 —— 嵌在抽屉里时页头被收掉了，
 *   界面上唯一说「要点保存」的地方就只剩最底下那条吸底条。
 */

import { useEffect, useState } from 'react'
import { Drawer, Modal } from 'antd'
import { useAppStore } from '@/store/appStore'
import GatherConfigView from './GatherConfigView'

export interface GatherConfigDrawerProps {
  /** 要配置的实例；null = 关闭。 */
  index: number | null
  onClose: () => void
  /** 保存成功后回调（刷新角标 / 重拉列表）。 */
  onSaved?: (instanceIndex: number) => void
}

export default function GatherConfigDrawer({
  index,
  onClose,
  onSaved
}: GatherConfigDrawerProps): React.JSX.Element {
  const instances = useAppStore((s) => s.instances)
  const accounts = useAppStore((s) => s.accounts)

  // 关闭动画有 300ms，这期间 index 已经是 null 了。
  // 内容跟着 shown 走，抽屉才不会「先变空再滑走」；真正的卸载交给 destroyOnHidden。
  const [shown, setShown] = useState<number | null>(index)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (index !== null) setShown(index)
  }, [index])

  const inst = shown === null ? null : (instances.find((i) => i.index === shown) ?? null)
  const account = shown === null ? null : (accounts.find((a) => a.instanceIndex === shown) ?? null)

  const title =
    shown === null
      ? '采集配置'
      : `采集配置 · #${shown} ${inst?.name ?? '未知实例'}${account ? ` · ${account.name}` : ' · 未绑账号'}`

  /** 有未保存的修改就先问一句。点遮罩、按 Esc、点右上角 × 都走这里。 */
  const requestClose = (): void => {
    if (!dirty) {
      onClose()
      return
    }
    Modal.confirm({
      title: '有未保存的修改',
      content: '直接关掉会丢弃这些改动（配置要点右下角「保存」才会落盘）。确定放弃吗？',
      okText: '放弃修改',
      okButtonProps: { danger: true },
      cancelText: '回去保存',
      onOk: () => {
        setDirty(false)
        onClose()
      }
    })
  }

  return (
    <Drawer
      open={index !== null}
      onClose={requestClose}
      afterOpenChange={(open) => {
        if (!open) {
          setShown(null)
          setDirty(false)
        }
      }}
      title={title}
      width={760}
      destroyOnHidden
      placement="right"
      className="wlg-cfg-drawer"
    >
      <div className="wl-label" style={{ marginBottom: 'var(--wl-space-3)' }}>
        改完要点右下角的「保存」，直接关掉不会保存。配置存在
        {account
          ? `账号「${account.name}」里，跟着账号走。`
          : '本机 —— 这个实例还没绑账号，主进程不会读它。'}
      </div>
      {shown !== null && (
        <GatherConfigView index={shown} embedded onSaved={onSaved} onDirtyChange={setDirty} />
      )}
    </Drawer>
  )
}
