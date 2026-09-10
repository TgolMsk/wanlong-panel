/**
 * 脚本管理。
 *
 * 脚本是**纯数据**（JSON），不是代码 —— 所以这里就是一个带校验的 JSON 编辑器：
 * 左边列表，右边文本域，保存前先 script:validate，问题分 error（红）/ warn（黄）列出来，
 * 点问题可以跳到对应的步骤 id。
 *
 * 故意没上 monaco：一个 1MB+ 的编辑器换来的只是语法高亮，而这里真正需要的是**语义校验**，
 * 那部分在主进程（zod + 引用完整性检查），不在编辑器里。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Input,
  List,
  Popconfirm,
  Row,
  Space,
  Spin,
  Tooltip,
  Typography
} from 'antd'
import {
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  ScanOutlined
} from '@ant-design/icons'
import { emptyScript, makeId } from '@shared/defaults'
import type { ScriptDef, ValidationIssue } from '@shared/script'
import { useAppStore } from '../store/appStore'
import { call, normalizeError, silentCall, tryCall, toast } from '../ipc/useIpc'
import { SemanticTag } from '../components/StatusTag'
import GlassCard from '../components/GlassCard'

function pretty(def: ScriptDef): string {
  return JSON.stringify(def, null, 2)
}

export default function ScriptsView(): React.JSX.Element {
  const scripts = useAppStore((s) => s.scripts)
  const templateSets = useAppStore((s) => s.templateSets)
  const refreshScripts = useAppStore((s) => s.refreshScripts)

  const [currentId, setCurrentId] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  const loadScript = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const def = await silentCall('script:get', id)
      setText(pretty(def))
      setCurrentId(id)
      setDirty(false)
      setIssues(null)
      setParseError(null)
    } catch (e) {
      toast().error(normalizeError(e).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!currentId && scripts.length > 0) void loadScript(scripts[0].id)
  }, [scripts, currentId, loadScript])

  /** 把文本框解析成 ScriptDef；失败时把中文原因写进 parseError。 */
  const parseText = (): ScriptDef | null => {
    try {
      const v: unknown = JSON.parse(text)
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        setParseError('顶层必须是一个 JSON 对象')
        return null
      }
      setParseError(null)
      return v as ScriptDef
    } catch (e) {
      setParseError(`JSON 解析失败：${(e as Error).message}`)
      return null
    }
  }

  const validate = async (): Promise<ValidationIssue[] | null> => {
    const def = parseText()
    if (!def) return null
    const list = await tryCall('script:validate', def)
    if (list) {
      setIssues(list)
      if (list.length === 0) toast().success('校验通过，没有发现问题')
    }
    return list ?? null
  }

  const save = async (): Promise<void> => {
    const def = parseText()
    if (!def) return
    setSaving(true)
    try {
      // 先校验：有 error 级问题就别写盘了，省得下次执行时才炸。
      const list = await tryCall('script:validate', def)
      if (list) {
        setIssues(list)
        const errs = list.filter((i) => i.level === 'error')
        if (errs.length > 0) {
          toast().error(`有 ${errs.length} 个必须修复的问题，已在下方列出`)
          return
        }
      }
      const meta = await call('script:save', def)
      toast().success(`脚本「${meta.name}」已保存（${meta.stepCount} 步）`)
      setDirty(false)
      setCurrentId(meta.id)
      await refreshScripts()
    } catch {
      /* 已提示 */
    } finally {
      setSaving(false)
    }
  }

  const createNew = (): void => {
    const def = emptyScript(makeId('script'), '未命名脚本')
    setText(pretty(def))
    setCurrentId(null)
    setDirty(true)
    setIssues(null)
    setParseError(null)
  }

  const remove = async (id: string, name: string): Promise<void> => {
    const r = await tryCall('script:delete', id)
    if (r !== undefined) {
      toast().success(`脚本「${name}」已删除`)
      if (currentId === id) {
        setCurrentId(null)
        setText('')
      }
      await refreshScripts()
    }
  }

  /** 点问题定位：在文本里找 "id": "<stepId>" 并选中那一段。 */
  const jumpToStep = (stepId: string | null): void => {
    if (!stepId) return
    const ta = taRef.current
    if (!ta) return
    const needle = `"${stepId}"`
    const at = text.indexOf(needle)
    if (at < 0) {
      toast().warning(`在脚本里没找到步骤 id「${stepId}」`)
      return
    }
    ta.focus()
    ta.setSelectionRange(at, at + needle.length)
    // 粗略滚到目标行：按行高估算即可，不必精确。
    const line = text.slice(0, at).split('\n').length
    ta.scrollTop = Math.max(0, (line - 6) * 18)
  }

  const errorCount = issues?.filter((i) => i.level === 'error').length ?? 0
  const warnCount = issues?.filter((i) => i.level === 'warn').length ?? 0

  return (
    <Row gutter={12}>
      <Col span={7}>
        <GlassCard
          padding="sm"
          title="脚本列表"
          extra={
            <Space>
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void refreshScripts()}>
                刷新
              </Button>
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={createNew}>
                新建
              </Button>
            </Space>
          }
        >
          <List
            size="small"
            dataSource={scripts}
            style={{ maxHeight: 560, overflowY: 'auto' }}
            locale={{ emptyText: '还没有脚本。点「新建」得到一个空模板，然后往 steps 里加步骤。' }}
            renderItem={(s) => (
              <List.Item
                className={currentId === s.id ? 'wl-selected' : 'wl-hoverable'}
                style={{
                  cursor: 'pointer',
                  borderRadius: 'var(--wl-radius-sm)',
                  paddingInline: 'var(--wl-space-2)'
                }}
                onClick={() => void loadScript(s.id)}
                actions={
                  s.builtin
                    ? [
                        <Tooltip key="b" title="内置脚本随包分发，不能删除">
                          <SemanticTag tone="neutral">内置</SemanticTag>
                        </Tooltip>
                      ]
                    : [
                        <Popconfirm
                          key="del"
                          title={`删除脚本「${s.name}」？`}
                          description="删除后无法恢复，正在跑这个脚本的执行不受影响。"
                          okText="删除"
                          cancelText="取消"
                          onConfirm={() => void remove(s.id, s.name)}
                        >
                          <Button
                            size="small"
                            type="link"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </Popconfirm>
                      ]
                }
              >
                <List.Item.Meta
                  title={
                    <Space size={4}>
                      <span>{s.name}</span>
                      <SemanticTag tone="neutral">v{s.version}</SemanticTag>
                    </Space>
                  }
                  description={
                    <span className="wl-micro">
                      {s.stepCount} 步{s.packageName ? `｜${s.packageName}` : ''}
                      {s.templateSetId
                        ? `｜模板集 ${
                            templateSets.find((t) => t.id === s.templateSetId)?.name ??
                            s.templateSetId
                          }`
                        : ''}
                    </span>
                  }
                />
              </List.Item>
            )}
          />
        </GlassCard>
      </Col>

      <Col span={17}>
        <GlassCard
          padding="sm"
          title={
            <Space>
              <span>脚本内容（JSON）</span>
              {dirty && <SemanticTag tone="warning">未保存</SemanticTag>}
              {issues && errorCount === 0 && warnCount === 0 && (
                <SemanticTag tone="success">校验通过</SemanticTag>
              )}
              {errorCount > 0 && <SemanticTag tone="danger">{errorCount} 个错误</SemanticTag>}
              {warnCount > 0 && <SemanticTag tone="warning">{warnCount} 个提醒</SemanticTag>}
            </Space>
          }
          extra={
            <Space>
              <Button size="small" icon={<ScanOutlined />} onClick={() => void validate()}>
                校验
              </Button>
              <Button
                size="small"
                onClick={() => {
                  const def = parseText()
                  if (def) setText(pretty(def))
                }}
              >
                格式化
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                onClick={() => void save()}
              >
                保存
              </Button>
            </Space>
          }
        >
          {/* 载入中的遮罩：GlassCard 是纯外壳，loading 态自己在卡片体里处理。 */}
          <Spin spinning={loading} tip="正在读取脚本…">
            {parseError && (
              <Alert type="error" showIcon message={parseError} style={{ marginBottom: 8 }} />
            )}

            {text ? (
              <Input.TextArea
                ref={(el) => {
                  taRef.current = el?.resizableTextArea?.textArea ?? null
                }}
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setDirty(true)
                }}
                spellCheck={false}
                autoSize={{ minRows: 20, maxRows: 28 }}
                style={{
                  fontFamily: 'var(--wl-font-mono)',
                  fontSize: 'var(--wl-fs-mono)',
                  lineHeight: 1.6
                }}
              />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="左边选一个脚本，或点「新建」开始写"
              />
            )}

            {issues && issues.length > 0 && (
              <Card size="small" title="校验结果" style={{ marginTop: 'var(--wl-space-3)' }}>
                <List
                  size="small"
                  dataSource={issues}
                  renderItem={(it) => (
                    <List.Item
                      style={{ cursor: it.stepId ? 'pointer' : 'default' }}
                      onClick={() => jumpToStep(it.stepId)}
                    >
                      <Space align="start">
                        <SemanticTag tone={it.level === 'error' ? 'danger' : 'warning'}>
                          {it.level === 'error' ? '错误' : '提醒'}
                        </SemanticTag>
                        {it.stepId && <Typography.Text code>{it.stepId}</Typography.Text>}
                        <Typography.Text>{it.message}</Typography.Text>
                      </Space>
                    </List.Item>
                  )}
                />
                <span className="wl-micro">点一条问题可以跳到脚本里对应的步骤 id。</span>
              </Card>
            )}

            <Alert
              style={{ marginTop: 'var(--wl-space-3)' }}
              type="info"
              showIcon
              message="脚本坐标一律写在参考分辨率空间"
              description="所有 x/y/w/h（包括 tap 的 at、ROI、模板 bounds）都以脚本自身的 refWidth x refHeight 为准，执行器负责换算到实例真实像素。不要直接填设备像素。"
            />
          </Spin>
        </GlassCard>
      </Col>
    </Row>
  )
}
