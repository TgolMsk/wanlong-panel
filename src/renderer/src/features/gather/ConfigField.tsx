/**
 * 配置表单的通用零件：一个字段 = 左边中文名 + schema 键名，右边控件 + 中文说明 + 代价提示 + 校验红字。
 *
 * 「代价提示」是这个模块特有的：每个可调项都要告诉用户「调大/调小分别付出什么代价」，
 * 不是干巴巴地摆一个数字框。面板的使用者是玩家不是程序员。
 */

import React from 'react'
import GlassCard from '@/components/GlassCard'
import type { ConfigIssue } from './config'

export interface ConfigFieldProps {
  /** 中文字段名。 */
  name: string
  /** schema 里的键路径，例如 `schedule.slackSeconds`。同时用于挂校验错误。 */
  path: string
  /** 一句话说明这个字段是干什么的。 */
  hint?: React.ReactNode
  /** 调大/调小的代价。显示成一条左侧带强调色竖线的说明块。 */
  cost?: React.ReactNode
  /** 当前配置的全部校验问题，本组件自己挑出 path 匹配的显示。 */
  issues?: readonly ConfigIssue[]
  children: React.ReactNode
}

export function ConfigField({
  name,
  path,
  hint,
  cost,
  issues,
  children
}: ConfigFieldProps): React.JSX.Element {
  const mine = (issues ?? []).filter((i) => i.path === path)
  return (
    <div className="wlg-field">
      <div className="wlg-field-label">
        <span className="wlg-field-name">{name}</span>
        <span className="wlg-field-key">{path}</span>
      </div>
      <div className="wlg-field-control">
        <div className="wlg-field-inline">{children}</div>
        {hint && <div className="wlg-field-hint">{hint}</div>}
        {cost && <div className="wlg-field-cost">{cost}</div>}
        {mine.map((i, k) => (
          <div key={k} className={i.level === 'error' ? 'wlg-field-err' : 'wlg-field-warn'}>
            {i.level === 'error' ? '错误：' : '提醒：'}
            {i.message}
          </div>
        ))}
      </div>
    </div>
  )
}

export interface ConfigSectionProps {
  title: string
  desc?: React.ReactNode
  extra?: React.ReactNode
  children: React.ReactNode
}

export function ConfigSection({
  title,
  desc,
  extra,
  children
}: ConfigSectionProps): React.JSX.Element {
  // 卡片外壳复用面板统一的 GlassCard（毛玻璃 + 冻结的圆角/阴影），不自己再画一套。
  return (
    <GlassCard title={<span className="wl-heading">{title}</span>} extra={extra}>
      {desc && (
        <div className="wlg-section-desc" style={{ marginBottom: 'var(--wl-space-3)' }}>
          {desc}
        </div>
      )}
      <div>{children}</div>
    </GlassCard>
  )
}
