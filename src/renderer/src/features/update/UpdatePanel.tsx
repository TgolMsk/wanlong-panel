/**
 * 更新面板正文：检查 → 有新版就显示版本号和更新说明 → 下载（带进度）→ 重启并安装。
 *
 * 同一份正文给两个地方用：
 *   · 设置页的「版本与更新」卡（UpdateCard，宽，带页脚说明）
 *   · 侧栏左下角版本号点开的弹层（SidebarUpdate，compact，去掉页脚、正文限宽）
 * 文案与 phase → 色调只写这一份，状态在 updateStore —— 两处各写一份必然漂移。
 *
 * 所有判断都在主进程（src/main/update/），这里只负责摆状态。包括「现在不能装」：
 * 按钮禁用只是提示，真正拦住的是主进程（有任务在跑时它会拒绝）。
 */

import { Alert, Button, Progress, Space, Tooltip, Typography } from 'antd'
import { CloudDownloadOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons'
import { UPDATE_PHASE_TEXT, callUpdate, formatBytes, formatSpeed } from '@shared/update'
import { formatCst } from '@shared/alerts'
import { useUpdateStore } from './updateStore'

/** 「检查更新」按钮。卡片把它放在右上角 extra，弹层放在按钮行里，行为只有一份。 */
export function CheckUpdateButton({
  size = 'small'
}: {
  size?: 'small' | 'middle'
}): React.JSX.Element {
  const state = useUpdateStore((s) => s.state)
  const busy = useUpdateStore((s) => s.busy)
  const run = useUpdateStore((s) => s.run)
  return (
    <Button
      size={size}
      icon={<SyncOutlined />}
      loading={busy || state?.phase === 'checking'}
      disabled={state?.phase === 'downloading'}
      onClick={() => void run(() => callUpdate('update:check'))}
    >
      检查更新
    </Button>
  )
}

export interface UpdatePanelProps {
  /** 紧凑形态（侧栏弹层）：限宽、去掉页脚长说明、把「检查更新」并进按钮行。 */
  compact?: boolean
}

export default function UpdatePanel({ compact = false }: UpdatePanelProps): React.JSX.Element {
  const state = useUpdateStore((s) => s.state)
  const busy = useUpdateStore((s) => s.busy)
  const run = useUpdateStore((s) => s.run)

  if (!state) {
    return <Typography.Text type="secondary">正在读取…</Typography.Text>
  }

  const p = state.progress
  const canDownload = state.phase === 'available'
  const canInstall = state.phase === 'downloaded'
  const notesMaxHeight = compact ? 120 : 180

  return (
    <Space
      direction="vertical"
      size={10}
      style={{ width: '100%', maxWidth: compact ? 320 : undefined }}
    >
      <Space size={compact ? 10 : 16} wrap>
        <span className="wl-micro">当前版本 v{state.currentVersion}</span>
        {state.latestVersion && <span className="wl-micro">最新版本 v{state.latestVersion}</span>}
        {state.checkedAt && (
          <span className="wl-micro">上次检查 {formatCst(state.checkedAt, false)}</span>
        )}
      </Space>

      {state.phase === 'unsupported' && (
        <Alert
          type="info"
          showIcon
          message={
            state.unsupportedReason === 'dev' ? '开发模式不检查更新' : '免安装版不能自动更新'
          }
          description={
            state.unsupportedReason === 'dev' ? (
              '当前是 npm run dev 起的开发版本，更新只在打包后的安装版里生效。'
            ) : (
              <span>
                免安装版（portable）是单个 exe，没有安装程序可以替换它。 到 Release 页下载新的
                portable 覆盖掉现在这个就行，数据目录不受影响。
              </span>
            )
          }
        />
      )}

      {state.phase === 'error' && state.error && (
        <Alert type="error" showIcon message="检查失败" description={state.error} />
      )}

      {state.phase === 'available' && (
        <Alert
          type="warning"
          showIcon
          message={`有新版本 v${state.latestVersion}`}
          description={
            state.releaseNotes ? (
              <Typography.Paragraph
                style={{
                  marginBottom: 0,
                  whiteSpace: 'pre-wrap',
                  maxHeight: notesMaxHeight,
                  overflow: 'auto'
                }}
              >
                {state.releaseNotes}
              </Typography.Paragraph>
            ) : (
              '点「下载更新」开始下载，下完再决定什么时候重启安装。'
            )
          }
        />
      )}

      {state.phase === 'downloading' && (
        <div>
          <Progress percent={p?.percent ?? 0} status="active" />
          <span className="wl-micro">
            {p
              ? `${formatBytes(p.transferred)} / ${formatBytes(p.total)} · ${formatSpeed(p.bytesPerSecond)}`
              : '正在开始…'}
            {' · 用的是增量下载，通常只取变化的那几 MB'}
          </span>
        </div>
      )}

      {canInstall && (
        <Alert
          type={state.installable ? 'success' : 'warning'}
          showIcon
          message={`v${state.latestVersion} 已下载完成`}
          description={
            state.installable
              ? '点「重启并安装」会退出面板、静默装好、再自动打开。'
              : `${state.busyReason ?? ''}安装要先退出应用，等它结束、或先手动停掉再装。`
          }
        />
      )}

      <Space wrap>
        {compact && <CheckUpdateButton />}
        {canDownload && (
          <Button
            type="primary"
            size={compact ? 'small' : 'middle'}
            icon={<CloudDownloadOutlined />}
            loading={busy}
            onClick={() => void run(() => callUpdate('update:download'))}
          >
            下载更新
          </Button>
        )}
        {canInstall && (
          <Tooltip
            title={state.installable ? '退出面板 → 静默安装 → 自动重新打开' : state.busyReason}
          >
            <Button
              type="primary"
              size={compact ? 'small' : 'middle'}
              icon={<ReloadOutlined />}
              disabled={!state.installable}
              loading={busy}
              onClick={() => void run(() => callUpdate('update:install'))}
            >
              重启并安装
            </Button>
          </Tooltip>
        )}
        <Button size="small" type="link" onClick={() => void callUpdate('update:openReleasePage')}>
          打开 Release 页面
        </Button>
      </Space>

      {!compact && (
        <span className="wl-micro">
          更新包来自 GitHub 公开仓库 TgolMsk/wanlong-panel，检查不需要登录。 下载和安装都要你点 ——
          面板不会自己重启，免得把正在跑的挂机任务掐断。
        </span>
      )}
      {compact && state.phase !== 'unsupported' && (
        <span className="wl-micro">
          {UPDATE_PHASE_TEXT[state.phase]} · 面板不会自己重启，装不装由你点。
        </span>
      )}
    </Space>
  )
}
