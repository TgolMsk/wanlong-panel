/**
 * 「版本与更新」卡片（设置页右栏）。
 *
 * 一条直线：检查 → 有新版就显示版本号和更新说明 → 下载（带进度）→ 重启并安装。
 * 所有判断都在主进程（src/main/update/），这里只负责把状态摆出来 —— 包括
 * 「现在不能装」这种事：按钮禁用只是提示，真正拦住的是主进程（有任务在跑时它会拒绝）。
 */

import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Progress, Space, Tooltip, Typography } from 'antd'
import { CloudDownloadOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons'
import {
  UPDATE_PHASE_TEXT,
  callUpdate,
  formatBytes,
  formatSpeed,
  onUpdateEvent,
  type UpdateState
} from '@shared/update'
import { formatCst } from '@shared/alerts'
import { normalizeError, toast } from '../../ipc/useIpc'
import { SemanticTag } from '../../components/StatusTag'
import GlassCard from '../../components/GlassCard'

const TONE: Record<UpdateState['phase'], 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  idle: 'neutral',
  checking: 'info',
  latest: 'success',
  available: 'warning',
  downloading: 'info',
  downloaded: 'success',
  error: 'danger',
  unsupported: 'neutral'
}

export default function UpdateCard(): React.JSX.Element {
  const [state, setState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setState(await callUpdate('update:state'))
    } catch (e) {
      toast().error(normalizeError(e).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 下载进度是主进程推的，别在这里轮询。
  useEffect(() => onUpdateEvent('update:changed', (s) => setState(s)), [])

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast().error(normalizeError(e).message)
    } finally {
      setBusy(false)
    }
  }

  if (!state) {
    return (
      <GlassCard padding="sm" title="版本与更新">
        <Typography.Text type="secondary">正在读取…</Typography.Text>
      </GlassCard>
    )
  }

  const p = state.progress
  const canDownload = state.phase === 'available'
  const canInstall = state.phase === 'downloaded'

  return (
    <GlassCard
      padding="sm"
      title={
        <Space size={8}>
          <span>版本与更新</span>
          <SemanticTag tone={TONE[state.phase]}>{UPDATE_PHASE_TEXT[state.phase]}</SemanticTag>
        </Space>
      }
      extra={
        <Button
          size="small"
          icon={<SyncOutlined />}
          loading={busy || state.phase === 'checking'}
          disabled={state.phase === 'downloading'}
          onClick={() => void run(() => callUpdate('update:check'))}
        >
          检查更新
        </Button>
      }
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space size={16} wrap>
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
                    maxHeight: 180,
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
          {canDownload && (
            <Button
              type="primary"
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
                icon={<ReloadOutlined />}
                disabled={!state.installable}
                loading={busy}
                onClick={() => void run(() => callUpdate('update:install'))}
              >
                重启并安装
              </Button>
            </Tooltip>
          )}
          <Button
            size="small"
            type="link"
            onClick={() => void callUpdate('update:openReleasePage')}
          >
            打开 Release 页面
          </Button>
        </Space>

        <span className="wl-micro">
          更新包来自 GitHub 公开仓库 TgolMsk/wanlong-panel，检查不需要登录。 下载和安装都要你点 ——
          面板不会自己重启，免得把正在跑的挂机任务掐断。
        </span>
      </Space>
    </GlassCard>
  )
}
