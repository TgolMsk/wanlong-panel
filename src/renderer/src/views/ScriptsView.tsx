/**
 * 脚本管理。两种编辑模式，同一份数据。
 *
 *   可视化：脚本画成一列**功能块卡片**（features/blocks/）。最值钱的一条路是
 *           「从画面截取」—— 抓一帧、在画面上拉个框，模板存进模板库的同时，
 *           「点这张图 / 等它出现」那一块也直接插进脚本。不用认识 JSON 也能写脚本。
 *   JSON：  原来那个带校验的文本域，一个字没动。复杂条件（and/or/not）、批量改、
 *           从别处粘一整段进来，仍然靠它。
 *
 * ★ 单一数据源：**text（JSON 字符串）** 始终是唯一真相。可视化模式每次改动都重新序列化回 text，
 *   所以两个模式之间来回切永远不会出现「两边不一致」。代价是每次改动都 JSON.stringify 一次，
 *   脚本最多几十 KB，可以忽略。
 *
 * 故意没上 monaco：一个 1MB+ 的编辑器换来的只是语法高亮，而这里真正需要的是**语义校验**，
 * 那部分在主进程（zod + 引用完整性检查），不在编辑器里。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Input,
  InputNumber,
  List,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
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
import type { TemplateDef } from '@shared/vision'
import { useAppStore } from '../store/appStore'
import { call, normalizeError, silentCall, tryCall, toast } from '../ipc/useIpc'
import { SemanticTag } from '../components/StatusTag'
import GlassCard from '../components/GlassCard'
import BlockEditor from '../features/blocks/BlockEditor'
import CaptureBlockModal from '../features/blocks/CaptureBlockModal'
import { countBlocks, insertAfter, nextStepId, type BlockPath } from '@shared/blocks'

function pretty(def: ScriptDef): string {
  return JSON.stringify(def, null, 2)
}

export default function ScriptsView(): React.JSX.Element {
  const scripts = useAppStore((s) => s.scripts)
  const templateSets = useAppStore((s) => s.templateSets)
  const refreshScripts = useAppStore((s) => s.refreshScripts)
  const refreshTemplateSets = useAppStore((s) => s.refreshTemplateSets)

  const [currentId, setCurrentId] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  /** 编辑模式。记在本机，下次打开还停在这儿。 */
  const [mode, setMode] = useState<'visual' | 'json'>(() => {
    try {
      return localStorage.getItem('wl.scriptEditMode') === 'json' ? 'json' : 'visual'
    } catch {
      // 隐私窗口 / 站点数据被禁时 localStorage 会抛，默认可视化即可。
      return 'visual'
    }
  })
  /** 当前脚本模板集里的模板，可视化模式的下拉和卡片文案都要用。 */
  const [templates, setTemplates] = useState<TemplateDef[]>([])
  /** 「从画面截取」弹窗，值是插入位置（null = 插到末尾）。 */
  const [capturingAt, setCapturingAt] = useState<{ at: BlockPath | null } | null>(null)

  const switchMode = (m: 'visual' | 'json'): void => {
    setMode(m)
    try {
      localStorage.setItem('wl.scriptEditMode', m)
    } catch {
      /* 存不下就算了，不影响使用 */
    }
  }

  /**
   * text → ScriptDef。可视化模式全靠它，所以解析失败时不能崩，
   * 而要退回「先去 JSON 模式把语法修好」的提示。
   */
  const parsed = useMemo((): { def: ScriptDef | null; error: string | null } => {
    if (!text.trim()) return { def: null, error: null }
    try {
      const v: unknown = JSON.parse(text)
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        return { def: null, error: '顶层必须是一个 JSON 对象' }
      }
      const def = v as ScriptDef
      if (!Array.isArray(def.steps)) return { def: null, error: 'steps 必须是一个数组' }
      return { def, error: null }
    } catch (e) {
      return { def: null, error: `JSON 解析失败：${(e as Error).message}` }
    }
  }, [text])

  /** 可视化模式改完一律回写 text —— 单一数据源。 */
  const applyDef = useCallback((next: ScriptDef): void => {
    setText(pretty(next))
    setDirty(true)
  }, [])

  /**
   * 一个模板集都没有时的死路出口：就地建一个并挂到当前脚本上。
   * 不这样的话，新用户点开「可视化」会看到「从画面截取」是灰的，却不知道要先去模板库页建个集合。
   */
  const createSetForScript = async (): Promise<void> => {
    const def = parsed.def
    if (!def) return
    const set = await tryCall('template:createSet', `${def.name} 的模板`, def.packageName)
    if (!set) return
    applyDef({ ...def, templateSetId: set.id })
    await refreshTemplateSets()
    toast().success(`已建模板集「${set.name}」并挂到这个脚本上`)
  }

  // 模板集变了就把模板列表重新拉一遍（可视化模式的下拉、卡片文案、缺失提示都靠它）。
  const setId = parsed.def?.templateSetId ?? null
  useEffect(() => {
    let alive = true
    if (!setId) {
      setTemplates([])
      return
    }
    void silentCall('template:list', setId)
      .then((list) => {
        if (alive) setTemplates(list)
      })
      .catch(() => {
        // 模板集被删了之类：可视化模式会把「模板不在模板集里」标出来，这里不用再弹一次。
        if (alive) setTemplates([])
      })
    return () => {
      alive = false
    }
  }, [setId])

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
              <Segmented
                size="small"
                value={mode}
                onChange={(v) => switchMode(v as 'visual' | 'json')}
                options={[
                  { value: 'visual', label: '可视化' },
                  { value: 'json', label: 'JSON' }
                ]}
              />
              {mode === 'visual' && parsed.def && (
                <Typography.Text type="secondary">
                  共 {countBlocks(parsed.def.steps)} 块
                </Typography.Text>
              )}
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
              {mode === 'json' && (
                <Button
                  size="small"
                  onClick={() => {
                    const def = parseText()
                    if (def) setText(pretty(def))
                  }}
                >
                  格式化
                </Button>
              )}
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

            {!text ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="左边选一个脚本，或点「新建」开始写"
              />
            ) : mode === 'json' ? (
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
            ) : parsed.def ? (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <ScriptHeaderFields
                  def={parsed.def}
                  templateSets={templateSets}
                  onChange={applyDef}
                  onCreateSet={createSetForScript}
                />
                <BlockEditor
                  script={parsed.def}
                  templates={templates}
                  onChange={(steps) => applyDef({ ...(parsed.def as ScriptDef), steps })}
                  onCapture={(at) => setCapturingAt({ at })}
                />
              </Space>
            ) : (
              <Alert
                type="warning"
                showIcon
                message="这份脚本的 JSON 现在读不出来，可视化模式帮不上忙"
                description={`${parsed.error ?? ''} —— 先切到 JSON 模式把语法修好，再回来。`}
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

            {mode === 'json' && (
              <Alert
                style={{ marginTop: 'var(--wl-space-3)' }}
                type="info"
                showIcon
                message="脚本坐标一律写在参考分辨率空间"
                description="所有 x/y/w/h（包括 tap 的 at、ROI、模板 bounds）都以脚本自身的 refWidth x refHeight 为准，执行器负责换算到实例真实像素。不要直接填设备像素。"
              />
            )}
          </Spin>
        </GlassCard>
      </Col>

      <CaptureBlockModal
        open={capturingAt !== null}
        setId={setId}
        makeId={(prefix) => nextStepId(parsed.def?.steps ?? [], prefix)}
        onCancel={() => setCapturingAt(null)}
        onDone={(step, tpl) => {
          const def = parsed.def
          if (!def) return
          const at = capturingAt?.at ?? null
          applyDef({
            ...def,
            steps: at ? insertAfter(def.steps, at, [step]) : [...def.steps, step]
          })
          // 新模板立刻进下拉，不必等下一次 template:list。
          setTemplates((old) => [...old.filter((t) => t.id !== tpl.id), tpl])
          setCapturingAt(null)
        }}
      />
    </Row>
  )
}

// ── 脚本头部字段（可视化模式）────────────────────────────────────────────

/**
 * 脚本级别的几项设置。只放**写脚本时真会改**的四个：
 * 名字、模板集、目标应用、要不要一直循环。版本号、参考分辨率、参数表这些低频项留在 JSON 模式。
 */
function ScriptHeaderFields({
  def,
  templateSets,
  onChange,
  onCreateSet
}: {
  def: ScriptDef
  templateSets: { id: string; name: string }[]
  onChange: (next: ScriptDef) => void
  onCreateSet: () => Promise<void>
}): React.JSX.Element {
  return (
    <Card size="small" styles={{ body: { paddingBlock: 10 } }}>
      <Space wrap size={16} align="start">
        <div>
          <div className="wl-micro">脚本名</div>
          <Input
            style={{ width: 200 }}
            value={def.name}
            onChange={(e) => onChange({ ...def, name: e.target.value })}
          />
        </div>
        <div>
          <div className="wl-micro">模板集（从画面截取的模板存到这里）</div>
          <Space.Compact>
            <Select
              style={{ width: 240 }}
              placeholder={templateSets.length === 0 ? '还没有模板集' : '选一个模板集'}
              value={def.templateSetId}
              options={templateSets.map((t) => ({ value: t.id, label: t.name }))}
              onChange={(v) => onChange({ ...def, templateSetId: v })}
              allowClear
              onClear={() => onChange({ ...def, templateSetId: undefined })}
            />
            <Tooltip title="就地建一个空模板集并挂到这个脚本上">
              <Button icon={<PlusOutlined />} onClick={() => void onCreateSet()} />
            </Tooltip>
          </Space.Compact>
        </div>
        <div>
          <div className="wl-micro">目标应用包名</div>
          <Input
            style={{ width: 220 }}
            placeholder="com.example.app"
            value={def.packageName ?? ''}
            onChange={(e) => onChange({ ...def, packageName: e.target.value || undefined })}
          />
        </div>
        <div>
          <div className="wl-micro">跑完再来一轮</div>
          <Space>
            <Switch
              checked={def.loop === true}
              onChange={(v) => onChange({ ...def, loop: v ? true : undefined })}
            />
            {def.loop && (
              <InputNumber
                style={{ width: 150 }}
                min={0}
                max={3_600_000}
                step={1000}
                addonAfter="ms 间隔"
                value={def.loopIntervalMs ?? 0}
                onChange={(v) => onChange({ ...def, loopIntervalMs: v ?? 0 })}
              />
            )}
          </Space>
        </div>
      </Space>
    </Card>
  )
}
