/**
 * 「版本与更新」卡片（设置页右栏）。
 *
 * 只是个外壳：状态在 updateStore，正文在 UpdatePanel（与侧栏左下角那个弹层同一份）。
 * 长文案留在这张卡里 —— 侧栏弹层太窄，放不下也不该放。
 */

import { Space } from 'antd'
import { UPDATE_PHASE_TEXT } from '@shared/update'
import { SemanticTag } from '../../components/StatusTag'
import GlassCard from '../../components/GlassCard'
import UpdatePanel, { CheckUpdateButton } from './UpdatePanel'
import { UPDATE_TONE, useUpdateFeed, useUpdateStore } from './updateStore'

export default function UpdateCard(): React.JSX.Element {
  useUpdateFeed()
  const state = useUpdateStore((s) => s.state)

  return (
    <GlassCard
      padding="sm"
      title={
        <Space size={8}>
          <span>版本与更新</span>
          {state && (
            <SemanticTag tone={UPDATE_TONE[state.phase]}>
              {UPDATE_PHASE_TEXT[state.phase]}
            </SemanticTag>
          )}
        </Space>
      }
      extra={<CheckUpdateButton />}
    >
      <UpdatePanel />
    </GlassCard>
  )
}
