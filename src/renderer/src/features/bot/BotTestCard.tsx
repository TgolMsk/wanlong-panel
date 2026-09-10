/**
 * 设置页里的「Telegram 机器人 · 在面板内测试动作」小卡。
 *
 * 用途：不方便掏手机时，在面板里把机器人会跑的那条路走一遍 —— 走的是 `bot:perform`，
 * 与 Telegram 里点按钮完全同一个 BotActionPort，所以这里通了手机上就通。
 *
 * 显示规则与通道层一致：有 photo 先显示图（caption 跟在下面），再显示 text；
 * 有 keyboard 就按行列画出内联按钮，点了按 parseCallbackData 的结果再执行一次。
 *
 * ★ 截图 / 资源 / 重启这类会操作模拟器的动作（BOT_ACTION_SPECS[a].touchesDevice）先弹确认：
 *   它们要抢实例锁，采集脚本正在跑时主进程会直接拒绝并给中文原因，这里原样显示。
 * ★ 本卡片拿不到、也不需要 bot token（BotActionResult 里根本没有配置字段）。
 */

import React, { useEffect, useState } from 'react'
import { Alert, Button, Popconfirm, Select, Space, Tooltip } from 'antd'
import { PlayCircleOutlined, ReloadOutlined, RobotOutlined } from '@ant-design/icons'
import {
  BOT_ACTIONS,
  BOT_ACTION_SPECS,
  BOT_MENU_BUTTON,
  callBot,
  describeBotError,
  parseCallbackData,
  type BotAction,
  type BotActionResult,
  type BotInstanceRef
} from '@shared/bot'
import { formatCstClock } from '@shared/alerts'
import GlassCard from '@/components/GlassCard'
import { SemanticTag } from '@/components/StatusTag'
import { bufferToObjectUrl, toast } from '@/ipc/useIpc'
import './bot.css'

/** 卡片顶部的四个快捷按钮（用户点名要的那四个），文案与手机菜单一致。 */
const QUICK_ACTIONS: ReadonlyArray<{ action: BotAction; label: string }> = [
  { action: 'accounts', label: BOT_MENU_BUTTON.accounts },
  { action: 'shot', label: BOT_MENU_BUTTON.shot },
  { action: 'resources', label: BOT_MENU_BUTTON.resources },
  { action: 'stats', label: BOT_MENU_BUTTON.stats }
]

interface LastRun {
  action: BotAction
  instanceIndex: number | null
  at: number
  result: BotActionResult
}

/** 截图上屏：ArrayBuffer -> blob URL，换图或卸载时回收。 */
function useObjectUrl(buf: ArrayBuffer | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!buf) {
      setUrl(null)
      return
    }
    const u = bufferToObjectUrl(buf)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [buf])
  return url
}

export default function BotTestCard(): React.JSX.Element {
  const [action, setAction] = useState<BotAction>('accounts')
  const [instanceIndex, setInstanceIndex] = useState<number | null>(null)
  const [instances, setInstances] = useState<BotInstanceRef[]>([])
  const [instancesError, setInstancesError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [last, setLast] = useState<LastRun | null>(null)
  const [error, setError] = useState<string | null>(null)

  const photoUrl = useObjectUrl(last?.result.photo?.jpeg)

  const loadInstances = async (): Promise<void> => {
    try {
      const list = await callBot('bot:instances')
      setInstances(list)
      setInstancesError(null)
      // 还没选或选的那个不在了 ⇒ 默认选第一个。
      setInstanceIndex((cur) => (cur !== null && list.some((i) => i.index === cur) ? cur : (list[0]?.index ?? null)))
    } catch (e) {
      setInstancesError(describeBotError(e))
    }
  }

  useEffect(() => {
    void loadInstances()
  }, [])

  const spec = BOT_ACTION_SPECS[action]
  const needsInstance = spec.instance === 'required'
  const usesInstance = spec.instance !== 'none'

  /** 真正执行一次。idx 为 null 时按动作要求决定：required 用当前选中的，optional 传 null = 全部。 */
  const run = async (a: BotAction, idx: number | null): Promise<void> => {
    const s = BOT_ACTION_SPECS[a]
    if (s.instance === 'required' && idx === null) {
      toast().warning(`「${s.description}」需要先选一个实例。`)
      return
    }
    if (running) {
      toast().warning('上一个动作还没跑完，等它结束再点。')
      return
    }
    setRunning(true)
    setError(null)
    try {
      const result = await callBot('bot:perform', a, s.instance === 'none' ? null : idx)
      setLast({ action: a, instanceIndex: idx, at: Date.now(), result })
    } catch (e) {
      const msg = describeBotError(e)
      setError(msg)
      toast().error(`机器人动作「${s.description}」失败：${msg}`)
    } finally {
      setRunning(false)
    }
  }

  /** 快捷按钮：把动作同步到下拉框再跑，required 的用当前选中实例。 */
  const runQuick = (a: BotAction): void => {
    setAction(a)
    void run(a, BOT_ACTION_SPECS[a].instance === 'none' ? null : instanceIndex)
  }

  /** 内联按钮：按 callback_data 解析后再执行一次（与手机上点按钮同一条路）。 */
  const runCallback = (data: string): void => {
    const parsed = parseCallbackData(data)
    if (!parsed) {
      toast().error(`看不懂这个按钮的回调数据：${data}`)
      return
    }
    setAction(parsed.action)
    if (parsed.instanceIndex !== null) setInstanceIndex(parsed.instanceIndex)
    void run(parsed.action, parsed.instanceIndex)
  }

  const actionOptions = BOT_ACTIONS.map((a) => {
    const s = BOT_ACTION_SPECS[a]
    return {
      value: a,
      label: (
        <Space size={6}>
          <span>/{s.command}</span>
          <span className="wl-micro">{s.description}</span>
          {s.touchesDevice && <SemanticTag tone="warning">会操作模拟器</SemanticTag>}
        </Space>
      )
    }
  })

  const instanceOptions = instances.map((i) => ({
    value: i.index,
    label: i.name ? `实例 ${i.index} · ${i.name}` : `实例 ${i.index}`
  }))

  const runButton = (
    <Button
      type="primary"
      icon={<PlayCircleOutlined />}
      loading={running}
      disabled={needsInstance && instanceIndex === null}
      onClick={spec.touchesDevice ? undefined : () => void run(action, usesInstance ? instanceIndex : null)}
    >
      执行
    </Button>
  )

  const quickButton = (q: { action: BotAction; label: string }): React.JSX.Element => {
    const s = BOT_ACTION_SPECS[q.action]
    const btn = (
      <Button
        key={q.action}
        loading={running && action === q.action}
        disabled={running || (s.instance === 'required' && instanceIndex === null)}
        onClick={s.touchesDevice ? undefined : () => runQuick(q.action)}
      >
        {q.label}
      </Button>
    )
    if (!s.touchesDevice) return btn
    return (
      <Popconfirm
        key={q.action}
        title={`${s.description}？`}
        description={`会占用实例 ${instanceIndex ?? '?'} 的模拟器几秒；采集脚本正在跑时会被拒绝。`}
        okText="执行"
        cancelText="取消"
        onConfirm={() => runQuick(q.action)}
      >
        {btn}
      </Popconfirm>
    )
  }

  return (
    <GlassCard
      padding="sm"
      title={
        <Space>
          <RobotOutlined />
          <span>Telegram 机器人 · 在面板内测试动作</span>
        </Space>
      }
      extra={
        <Tooltip title="重新拉取可选实例">
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadInstances()} />
        </Tooltip>
      }
    >
      <div className="wlb-note" style={{ marginBottom: 'var(--wl-space-3)' }}>
        走的是机器人真正会跑的那条路（bot:perform），这里通了手机上就通。
        文本原样显示，截图显示缩略图，内联按钮可以直接点。
      </div>

      {instancesError && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 'var(--wl-space-3)' }}
          message="可选实例列表没能拉到"
          description={instancesError}
        />
      )}

      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div className="wlb-quick">
          {QUICK_ACTIONS.map(quickButton)}
        </div>

        <div className="wlb-form">
          <Select<BotAction>
            style={{ minWidth: 300 }}
            value={action}
            onChange={(v) => setAction(v)}
            options={actionOptions}
            popupMatchSelectWidth={false}
          />
          <Select<number>
            style={{ width: 200 }}
            placeholder={usesInstance ? '选择实例' : '此动作不需要实例'}
            value={instanceIndex ?? undefined}
            onChange={(v) => setInstanceIndex(v)}
            options={instanceOptions}
            disabled={!usesInstance}
            allowClear={spec.instance === 'optional'}
            onClear={() => setInstanceIndex(null)}
            notFoundContent="没有可选实例"
          />
          {spec.touchesDevice ? (
            <Popconfirm
              title={`${spec.description}？`}
              description={`会占用实例 ${instanceIndex ?? '?'} 的模拟器几秒；采集脚本正在跑时会被拒绝。`}
              okText="执行"
              cancelText="取消"
              onConfirm={() => void run(action, instanceIndex)}
            >
              {runButton}
            </Popconfirm>
          ) : (
            runButton
          )}
          {spec.instance === 'optional' && (
            <span className="wl-micro">不选实例 = 全部实例</span>
          )}
        </div>

        {error && <div className="wlb-error">操作失败：{error}</div>}

        {last && (
          <div className="wl-sunken wlb-result">
            <div className="wlb-result-head">
              <span className="wl-label">
                /{BOT_ACTION_SPECS[last.action].command}
                {last.instanceIndex !== null && ` ${last.instanceIndex}`} · 北京时间{' '}
                {formatCstClock(last.at)}
              </span>
              {last.result.showMenu && <SemanticTag tone="info">会附带菜单键盘</SemanticTag>}
            </div>

            {last.result.photo && (
              <div className="wlb-photo">
                {photoUrl ? (
                  <img className="wlb-photo-img" src={photoUrl} alt="截图" />
                ) : (
                  <span className="wl-micro">图片解码中…</span>
                )}
                <pre className="wlb-caption">{last.result.photo.caption}</pre>
                <span className="wl-micro">
                  {last.result.photo.filename} · {Math.round(last.result.photo.jpeg.byteLength / 1024)} KB
                </span>
              </div>
            )}

            {last.result.text.trim() !== '' && <pre className="wlb-text">{last.result.text}</pre>}

            {last.result.keyboard && last.result.keyboard.inline_keyboard.length > 0 && (
              <div className="wlb-keyboard">
                {last.result.keyboard.inline_keyboard.map((row, ri) => (
                  <div className="wlb-keyboard-row" key={ri}>
                    {row.map((b) => (
                      <Button key={b.callback_data} size="small" disabled={running} onClick={() => runCallback(b.callback_data)}>
                        {b.text}
                      </Button>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {!last.result.photo && last.result.text.trim() === '' && !last.result.keyboard && (
              <span className="wl-micro">这个动作没有返回任何内容。</span>
            )}
          </div>
        )}
      </Space>
    </GlassCard>
  )
}
