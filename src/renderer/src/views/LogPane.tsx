/**
 * 日志面板。
 *
 * 实时日志走 MessagePort（worker 每 100ms 合并一批推过来），历史日志走 run:logs 读 ndjson。
 * 两者都进 logStore 的 ring buffer：**只保留最近 2000 行**，永远不把全量日志塞进 React state。
 * 列表用 react-virtuoso 虚拟滚动 + followOutput 自动贴底（用户往上翻时会自动停止跟随）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { VirtuosoHandle } from 'react-virtuoso'
import { Button, Empty, Image, Input, Modal, Segmented, Select, Space, Spin, Tooltip } from 'antd'
import { ClearOutlined, PictureOutlined, ReloadOutlined } from '@ant-design/icons'
import { LOG_RING_CAPACITY } from '@shared/constants'
import type { LogEntry, LogLevel } from '@shared/script'
import { clearLogs, mergeHistory, useLogCounters, useLogs } from '../store/logStore'
import { bufferToObjectUrl, silentCall, toast } from '../ipc/useIpc'
import { useAppStore } from '../store/appStore'
import { SemanticTag } from '../components/StatusTag'
import { WL_LOG_COLORS } from '../styles/antd-theme'

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误'
}

function ts(t: number): string {
  const d = new Date(t)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function Row({
  entry,
  levelColor,
  onOpenShot
}: {
  entry: LogEntry
  /** 当前主题下的四级日志色，由外层按 themeMode 取好再传进来，避免每行都读一次 store。 */
  levelColor: Record<LogLevel, string>
  onOpenShot: (e: LogEntry) => void
}): React.JSX.Element {
  const color = levelColor[entry.level]
  const dataText = entry.data ? JSON.stringify(entry.data) : ''
  return (
    <div
      className="wl-mono"
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'baseline',
        padding: '2px 8px',
        lineHeight: '18px',
        borderBottom: '1px solid var(--wl-split)',
        background: entry.level === 'error' ? 'var(--wl-danger-soft)' : undefined
      }}
    >
      <span style={{ color: 'var(--wl-text-tertiary)', flex: '0 0 auto' }}>{ts(entry.ts)}</span>
      <span style={{ color, flex: '0 0 34px' }}>{LEVEL_LABEL[entry.level]}</span>
      <span style={{ color: 'var(--wl-series-3)', flex: '0 0 auto' }}>[{entry.scope}]</span>
      {entry.instanceIndex !== null && (
        <span style={{ color: 'var(--wl-series-6)', flex: '0 0 auto' }}>
          #{entry.instanceIndex}
        </span>
      )}
      {entry.stepId && (
        <span style={{ color: 'var(--wl-text-secondary)', flex: '0 0 auto' }}>{entry.stepId}</span>
      )}
      <span
        style={{
          flex: '1 1 auto',
          color: entry.level === 'error' ? 'var(--wl-danger)' : 'var(--wl-text)'
        }}
      >
        {entry.message}
        {dataText && (
          <Tooltip title={dataText}>
            <span style={{ color: 'var(--wl-text-disabled)', marginLeft: 6 }}>
              {dataText.length > 90 ? `${dataText.slice(0, 90)}…` : dataText}
            </span>
          </Tooltip>
        )}
      </span>
      {entry.shot && (
        <Button
          size="small"
          type="link"
          icon={<PictureOutlined />}
          style={{ flex: '0 0 auto', padding: 0, height: 18 }}
          onClick={() => onOpenShot(entry)}
        >
          留痕
        </Button>
      )}
    </div>
  )
}

export interface LogPaneProps {
  /** 只看这次执行的日志；不传则看全部。 */
  runId?: string | null
  height?: number
}

export default function LogPane({ runId = null, height = 360 }: LogPaneProps): React.JSX.Element {
  const [minLevel, setMinLevel] = useState<LogLevel>('info')
  const [keyword, setKeyword] = useState('')
  const [follow, setFollow] = useState(true)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [shot, setShot] = useState<{ url: string; title: string } | null>(null)
  const [shotLoading, setShotLoading] = useState(false)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const themeMode = useAppStore((s) => s.themeMode)
  const levelColor = WL_LOG_COLORS[themeMode]

  const filter = useMemo(() => ({ runId, minLevel, keyword }), [runId, minLevel, keyword])
  const logs = useLogs(filter)
  const counters = useLogCounters()

  // 切换执行时回到底部。
  useEffect(() => {
    setFollow(true)
  }, [runId])

  // Modal 关掉时释放 blob URL，否则留痕图会一直占内存。
  useEffect(() => {
    return () => {
      if (shot) URL.revokeObjectURL(shot.url)
    }
  }, [shot])

  const loadHistory = async (): Promise<void> => {
    setLoadingHistory(true)
    try {
      const entries = await silentCall('run:logs', {
        runId: runId ?? undefined,
        minLevel,
        limit: LOG_RING_CAPACITY
      })
      const added = mergeHistory(entries)
      toast().success(`已载入 ${added} 条历史日志`)
    } catch (e) {
      toast().error(`读取历史日志失败：${(e as { message?: string }).message ?? '未知错误'}`)
    } finally {
      setLoadingHistory(false)
    }
  }

  const openShot = async (entry: LogEntry): Promise<void> => {
    if (!entry.shot || !entry.runId) return
    setShotLoading(true)
    try {
      const buf = await silentCall('run:shot', entry.runId, entry.shot)
      if (shot) URL.revokeObjectURL(shot.url)
      setShot({ url: bufferToObjectUrl(buf), title: `${ts(entry.ts)}｜${entry.message}` })
    } catch (e) {
      toast().error(`读取留痕截图失败：${(e as { message?: string }).message ?? '未知错误'}`)
    } finally {
      setShotLoading(false)
    }
  }

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap size={8}>
        <Segmented<LogLevel>
          size="small"
          value={minLevel}
          onChange={(v) => setMinLevel(v)}
          options={[
            { value: 'debug', label: '全部' },
            { value: 'info', label: '信息以上' },
            { value: 'warn', label: '警告以上' },
            { value: 'error', label: '仅错误' }
          ]}
        />
        <Input.Search
          size="small"
          allowClear
          style={{ width: 220 }}
          placeholder="按内容 / 模块 / 步骤 id 过滤"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Select
          size="small"
          value={follow ? 'follow' : 'free'}
          style={{ width: 108 }}
          onChange={(v) => setFollow(v === 'follow')}
          options={[
            { value: 'follow', label: '自动贴底' },
            { value: 'free', label: '停止跟随' }
          ]}
        />
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={loadingHistory}
          onClick={() => void loadHistory()}
        >
          载入历史
        </Button>
        <Button size="small" icon={<ClearOutlined />} onClick={() => clearLogs(runId ?? undefined)}>
          清空
        </Button>
        <span className="wl-micro">
          显示 {logs.length} / 缓冲 {counters.total} 行（上限 {LOG_RING_CAPACITY}）
        </span>
        {counters.error > 0 && <SemanticTag tone="danger">错误 {counters.error}</SemanticTag>}
        {counters.warn > 0 && <SemanticTag tone="warning">警告 {counters.warn}</SemanticTag>}
      </Space>

      <div className="wl-sunken" style={{ height, overflow: 'hidden' }}>
        {logs.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ paddingTop: height / 4 }}
            description={
              runId
                ? '这次执行还没有日志。执行开始后实时日志会自动出现，历史日志点「载入历史」。'
                : '暂无日志。启动一次执行，或点「载入历史」读取磁盘上的 ndjson。'
            }
          />
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={logs}
            // 'auto' 的语义就是「只有已经贴着底部时才跟随」，用户往上翻时它会自动让开，
            // 所以这里不需要再自己监听 atBottomStateChange 去关跟随（那样会一翻就永久关掉）。
            followOutput={follow ? 'auto' : false}
            style={{ height: '100%' }}
            itemContent={(_index, entry) => (
              <Row entry={entry} levelColor={levelColor} onOpenShot={(e) => void openShot(e)} />
            )}
          />
        )}
      </div>

      <Modal
        open={!!shot}
        title={shot?.title ?? '留痕截图'}
        footer={null}
        width={900}
        onCancel={() => {
          if (shot) URL.revokeObjectURL(shot.url)
          setShot(null)
        }}
        destroyOnHidden
      >
        <Spin spinning={shotLoading}>
          {shot && <Image src={shot.url} alt="留痕截图" style={{ width: '100%' }} />}
        </Spin>
      </Modal>
    </Space>
  )
}
