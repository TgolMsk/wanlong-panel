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
 * ★ 抽屉里的表单是「改完点保存」，与整页完全一样。关抽屉不会自动保存，
 *   所以标题下面那句提示要一直在（destroyOnClose 让下次打开重新读盘，不会留着上次的脏值）。
 */

import { Drawer } from 'antd'
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

  const inst = index === null ? null : (instances.find((i) => i.index === index) ?? null)
  const account = index === null ? null : (accounts.find((a) => a.instanceIndex === index) ?? null)

  const title =
    index === null
      ? '采集配置'
      : `采集配置 · #${index} ${inst?.name ?? '未知实例'}${account ? ` · ${account.name}` : ' · 未绑账号'}`

  return (
    <Drawer
      open={index !== null}
      onClose={onClose}
      title={title}
      width={760}
      destroyOnHidden
      placement="right"
      className="wlg-cfg-drawer"
    >
      {index !== null && <GatherConfigView index={index} embedded onSaved={onSaved} />}
    </Drawer>
  )
}
