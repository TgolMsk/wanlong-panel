/**
 * 「这个实例已被异常暂停」的红条。
 *
 * 出现条件只有一个：`pause.paused === true`。
 * ★ **不是** `!auto` —— 用户自己在卡片上手动关掉自动调度也会让 auto 为 false，
 *   那是正常操作，不该标红吓人。
 *
 * 条上给出四件事，缺一不可：
 *   1. 出了什么事（事件类型标题 + 中文原因）
 *   2. 什么时候出的（**北京时间**，因为游戏按北京时间跑，而宿主机时区不一定是北京）
 *   3. 该怎么办（ALERT_SPECS[type].advice）
 *   4. 现场是什么样（可点开的留痕截图）+ 一个「恢复」按钮
 *
 * 颜色全部走 tokens.css 的 --wl-* 变量（见 alerts.css），本文件不写死任何色值。
 */

import React, { useEffect, useState } from 'react'
import { Button, Modal, Popconfirm, Spin, Tooltip } from 'antd'
import { PictureOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { ALERT_SEVERITY_TONE, alertSpec, formatCst, type InstancePauseState } from '@shared/alerts'
import { bufferToObjectUrl, silentCall, toast } from '@/ipc/useIpc'
import './alerts.css'

/** 告警留痕统一落在 <dataDir>/shots/alerts/ 下，与主进程 saveShot 的 runId 约定一致。 */
const ALERT_SHOT_DIR = 'alerts'

export interface PauseBannerProps {
  pause: InstancePauseState
  /** 实例名，只用于弹窗标题与二次确认文案。 */
  instanceName?: string | null
  /** true 时补上圆角与描边（独立成块用）；false 时贴在卡片内部。 */
  standalone?: boolean
  /** 正在恢复（按钮转圈 + 防连点）。 */
  resuming?: boolean
  onResume: (instanceIndex: number) => void
}

export function PauseBanner({
  pause,
  instanceName,
  standalone,
  resuming,
  onResume
}: PauseBannerProps): React.JSX.Element | null {
  const [shotUrl, setShotUrl] = useState<string | null>(null)
  const [shotLoading, setShotLoading] = useState(false)

  // 对象 URL 必须显式回收，否则每看一次截图就漏一份几百 KB 的 Blob。
  useEffect(() => {
    return () => {
      if (shotUrl) URL.revokeObjectURL(shotUrl)
    }
  }, [shotUrl])

  if (!pause.paused) return null

  const spec = pause.type ? alertSpec(pause.type) : null
  const tone = pause.severity ? ALERT_SEVERITY_TONE[pause.severity] : 'danger'
  const toneClass =
    tone === 'warning' ? ' wla-banner-warning' : tone === 'info' ? ' wla-banner-info' : ''
  const cls = `wla-banner${toneClass}${standalone ? ' wla-banner-standalone' : ''}`

  const who = instanceName
    ? `实例 #${pause.instanceIndex}（${instanceName}）`
    : `实例 #${pause.instanceIndex}`

  const openShot = async (): Promise<void> => {
    if (!pause.shotPath) return
    setShotLoading(true)
    try {
      // shotPath 形如 `alerts/inst0-1757462412345.jpg`，主进程的 splitShotPath 会自己拆开，
      // 第一个参数只是拆不出目录时的兜底。
      const buf = await silentCall('run:shot', ALERT_SHOT_DIR, pause.shotPath)
      if (shotUrl) URL.revokeObjectURL(shotUrl)
      setShotUrl(bufferToObjectUrl(buf))
    } catch (e) {
      toast().error(
        `读取现场截图失败：${(e as { message?: string }).message ?? '未知错误'}。` +
          '截图可能已经被清理，或者留痕策略当时是「不留痕」。'
      )
    } finally {
      setShotLoading(false)
    }
  }

  const closeShot = (): void => {
    if (shotUrl) URL.revokeObjectURL(shotUrl)
    setShotUrl(null)
  }

  const detailEntries = Object.entries(pause.detail ?? {})

  return (
    <div className={cls}>
      <div className="wla-banner-head">
        <span className="wla-banner-title">{spec ? spec.title : '已暂停'}</span>
        <span className="wl-micro">自动调度已关闭，不会再排唤醒</span>
      </div>

      <div className="wla-banner-reason">{pause.reason ?? '没有记录原因。'}</div>

      {pause.advice && <div className="wla-banner-advice">处置：{pause.advice}</div>}

      <div className="wla-banner-meta">
        <span>暂停于 {pause.pausedAt == null ? '--' : formatCst(pause.pausedAt)}（北京时间）</span>
        {pause.notified === true && <span>已推送到 Telegram</span>}
        {pause.notified === null && <span>未配置推送</span>}
      </div>

      {detailEntries.length > 0 && (
        <div className="wla-detail">
          {detailEntries.map(([k, v]) => (
            <span className="wla-detail-chip" key={k}>
              {k}={String(v)}
            </span>
          ))}
        </div>
      )}

      {pause.notifyError && (
        <div className="wla-banner-notify-err">
          推送失败：{pause.notifyError}（暂停本身已经生效，推送失败不影响它）
        </div>
      )}

      <div className="wla-banner-actions">
        <Popconfirm
          title="确认已经处理好现场了吗？"
          description={
            <span style={{ maxWidth: 300, display: 'inline-block' }}>
              恢复会重新打开 {who} 的自动调度，并立刻去读一次「部队管理」面板。
              如果游戏还停在异常界面（登录页 / 公告框），多半会马上再次暂停。
            </span>
          }
          okText="确认恢复"
          cancelText="再看看"
          onConfirm={() => onResume(pause.instanceIndex)}
        >
          <Button
            size="small"
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={resuming === true}
          >
            恢复
          </Button>
        </Popconfirm>

        {pause.shotPath ? (
          <Tooltip title={`留痕文件：${pause.shotPath}`}>
            <Button
              size="small"
              icon={<PictureOutlined />}
              loading={shotLoading}
              onClick={() => void openShot()}
            >
              查看现场截图
            </Button>
          </Tooltip>
        ) : (
          <Tooltip title="这次暂停没有留下截图。留痕策略为「不留痕」，或者出事时截图本身也失败了。">
            <span className="wl-micro">无现场截图</span>
          </Tooltip>
        )}
      </div>

      <Modal
        open={shotUrl !== null}
        onCancel={closeShot}
        footer={null}
        width={960}
        title={`${who} 暂停现场 · ${pause.pausedAt == null ? '--' : formatCst(pause.pausedAt)}（北京时间）`}
      >
        {shotUrl ? <img className="wla-shot-img" src={shotUrl} alt="暂停现场截图" /> : <Spin />}
      </Modal>
    </div>
  )
}

export default PauseBanner
