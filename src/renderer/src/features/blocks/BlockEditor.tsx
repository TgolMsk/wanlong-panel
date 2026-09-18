/**
 * 可视化脚本编辑器：把脚本的 steps 画成一列**功能块卡片**，点开就能改，不用碰 JSON。
 *
 * 设计取舍：
 *  · 卡片折叠时只显示「一句人话」（catalog.ts 的 describeBlock），展开才露出表单 ——
 *    一个 30 步的脚本要能一屏扫完，否则可视化还不如 JSON 好读。
 *  · 排序用上下按钮而不是拖拽：树形结构里的拖拽（还要能拖进 if 的分支）交互复杂、易错，
 *    而上下移动是确定性的、键盘也能用。真正的「拖」留给最值钱的那一处 —— 在画面上拉框截图。
 *  · 不做实时校验红叉。明显的坑（没选模板、坐标还是 0,0）就地标黄，
 *    引用完整性这类仍然交给主进程的 script:validate —— 同一条规则不写两遍。
 *
 * ★ 坐标全部在**脚本的参考分辨率**空间（script.refWidth × refHeight），
 *   表单里会把这个尺寸写在提示里，免得有人按设备真实像素填。
 */

import { useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Collapse,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CameraOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  PlusOutlined,
  RightOutlined
} from '@ant-design/icons'
import type { AndroidKey, Condition, LogLevel, ScriptDef, ScriptStep } from '@shared/script'
import type { TemplateDef } from '@shared/vision'
import {
  ANDROID_KEY_TEXT,
  BLOCK_CATALOG,
  appendToBranch,
  blockIssue,
  blockMeta,
  branchesOf,
  childrenOf,
  cloneWithNewIds,
  describeBlock,
  describeCond,
  getAt,
  insertAfter,
  kindOfStep,
  makeBlock,
  moveAt,
  movedPath,
  nextStepId,
  pathKey,
  removeAt,
  samePath,
  updateAt,
  type BlockKind,
  type BlockPath,
  type Branch
} from '@shared/blocks'

const BRANCH_TEXT: Record<Branch, string> = {
  then: '成立时',
  else: '否则',
  steps: '循环体'
}

export interface BlockEditorProps {
  script: ScriptDef
  templates: TemplateDef[]
  onChange: (steps: ScriptStep[]) => void
  /** 打开「从画面截取」弹窗；参数是插入位置（null = 末尾）。 */
  onCapture: (at: BlockPath | null) => void
}

export default function BlockEditor({
  script,
  templates,
  onChange,
  onCapture
}: BlockEditorProps): React.JSX.Element {
  const [selected, setSelected] = useState<BlockPath | null>(null)
  const steps = script.steps
  const templateIds = useMemo(() => new Set(templates.map((t) => t.id)), [templates])

  const addBlock = (kind: BlockKind, at: BlockPath | null): void => {
    const step = makeBlock(
      kind,
      nextStepId(steps, kind === 'waitAppear' || kind === 'waitDisappear' ? 'wait' : kind)
    )
    const next = at ? insertAfter(steps, at, [step]) : [...steps, step]
    onChange(next)
    setSelected(at ? [...at.slice(0, -1), (at[at.length - 1] as number) + 1] : [next.length - 1])
  }

  const addToBranch = (parentPath: BlockPath, branch: Branch, kind: BlockKind): void => {
    const step = makeBlock(
      kind,
      nextStepId(steps, kind === 'waitAppear' || kind === 'waitDisappear' ? 'wait' : kind)
    )
    onChange(appendToBranch(steps, parentPath, branch, [step]))
    const parent = getAt(steps, parentPath)
    const n = parent ? childrenOf(parent, branch).length : 0
    setSelected([...parentPath, branch, n])
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap>
        <Tooltip
          title={script.templateSetId ? '抓一帧画面，拉个框，直接变成一块' : '先给脚本选一个模板集'}
        >
          <Button
            type="primary"
            icon={<CameraOutlined />}
            disabled={!script.templateSetId}
            onClick={() => onCapture(selected)}
          >
            从画面截取
          </Button>
        </Tooltip>
        <AddBlockButton onPick={(k) => addBlock(k, selected)} hasTemplates={templates.length > 0} />
        <Typography.Text type="secondary">
          {/* 「共 N 块」在卡片标题栏已经有了，这里只说插到哪 —— 同一屏不重复同一个数字。 */}
          {selected ? '新块会插在选中的那块后面' : '没选中任何块，新块加在最后'}
        </Typography.Text>
      </Space>

      {steps.length === 0 ? (
        <Empty
          description={
            script.templateSetId
              ? '还是空的。点「从画面截取」把游戏里的按钮框下来，它会直接变成第一块。'
              : '还是空的。先在上面给脚本选一个模板集，然后就能从画面截取了。'
          }
        />
      ) : (
        <BlockList
          steps={steps}
          basePath={[]}
          script={script}
          templates={templates}
          templateIds={templateIds}
          selected={selected}
          onSelect={setSelected}
          onChangeRoot={onChange}
          rootSteps={steps}
          onAddToBranch={addToBranch}
          onCapture={onCapture}
        />
      )}
    </Space>
  )
}

// ── 块列表（可递归）──────────────────────────────────────────────────────

interface ListProps {
  steps: ScriptStep[]
  basePath: BlockPath
  script: ScriptDef
  templates: TemplateDef[]
  templateIds: Set<string>
  selected: BlockPath | null
  onSelect: (p: BlockPath | null) => void
  /** 改的是整棵树，所以回调始终作用在 rootSteps 上。 */
  onChangeRoot: (steps: ScriptStep[]) => void
  rootSteps: ScriptStep[]
  onAddToBranch: (parentPath: BlockPath, branch: Branch, kind: BlockKind) => void
  onCapture: (at: BlockPath | null) => void
}

function BlockList(props: ListProps): React.JSX.Element {
  const { steps, basePath, rootSteps, onChangeRoot, selected, onSelect } = props
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {steps.map((step, i) => {
        const path = [...basePath, i]
        const isSelected = selected != null && samePath(selected, path)
        return (
          <BlockCard
            key={`${pathKey(path)}-${step.id}`}
            {...props}
            step={step}
            path={path}
            index={i}
            isSelected={isSelected}
            onToggle={() => onSelect(isSelected ? null : path)}
            onMove={(delta) => {
              onChangeRoot(moveAt(rootSteps, path, delta))
              if (isSelected) onSelect(movedPath(path, delta))
            }}
            onDuplicate={() => {
              onChangeRoot(insertAfter(rootSteps, path, [cloneWithNewIds(rootSteps, step)]))
            }}
            onRemove={() => {
              onChangeRoot(removeAt(rootSteps, path))
              if (isSelected) onSelect(null)
            }}
            onPatch={(next) => onChangeRoot(updateAt(rootSteps, path, next))}
          />
        )
      })}
    </div>
  )
}

// ── 单块卡片 ──────────────────────────────────────────────────────────────

interface CardProps extends Omit<ListProps, 'selected'> {
  step: ScriptStep
  path: BlockPath
  index: number
  /** 外层的 selected 是「哪一条路径被选中」，到了卡片这里已经算成布尔了，所以要 Omit 掉再重定义。 */
  selected: BlockPath | null
  isSelected: boolean
  onToggle: () => void
  onMove: (delta: -1 | 1) => void
  onDuplicate: () => void
  onRemove: () => void
  onPatch: (next: ScriptStep) => void
}

function BlockCard(props: CardProps): React.JSX.Element {
  const { step, path, index, isSelected, templates, templateIds, script } = props
  const meta = blockMeta(kindOfStep(step))
  const issue = blockIssue(step, templateIds)
  const branches = branchesOf(step)
  const canElse = step.kind === 'if' && !step.else

  return (
    <div
      className={isSelected ? 'wl-solid' : 'wl-sunken'}
      style={{
        borderRadius: 10,
        padding: '10px 12px',
        border: isSelected ? '1px solid var(--wl-accent)' : '1px solid transparent'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Button
          type="text"
          size="small"
          icon={isSelected ? <DownOutlined /> : <RightOutlined />}
          onClick={props.onToggle}
        />
        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={props.onToggle}>
          <Space size={8} wrap>
            <Typography.Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {index + 1}.
            </Typography.Text>
            <Tag
              color="var(--wl-accent-soft)"
              style={{ color: 'var(--wl-accent)', border: 'none' }}
            >
              {meta.label}
            </Tag>
            <Typography.Text>
              {step.name ? `${step.name} —— ` : ''}
              {describeBlock(step, templates)}
            </Typography.Text>
            {step.when && (
              <Tooltip title={`只有「${describeCond(step.when, templates)}」时才执行这一块`}>
                <Tag>有前置条件</Tag>
              </Tooltip>
            )}
            {issue && (
              <Tooltip title={issue}>
                <Tag
                  color="var(--wl-warning-soft)"
                  style={{ color: 'var(--wl-warning)', border: 'none' }}
                >
                  {issue}
                </Tag>
              </Tooltip>
            )}
          </Space>
        </div>
        <Space size={2}>
          <Tooltip title="上移">
            <Button
              type="text"
              size="small"
              icon={<ArrowUpOutlined />}
              onClick={() => props.onMove(-1)}
            />
          </Tooltip>
          <Tooltip title="下移">
            <Button
              type="text"
              size="small"
              icon={<ArrowDownOutlined />}
              onClick={() => props.onMove(1)}
            />
          </Tooltip>
          <Tooltip title="复制一块">
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={props.onDuplicate} />
          </Tooltip>
          <Tooltip title="删除">
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={props.onRemove}
            />
          </Tooltip>
        </Space>
      </div>

      {isSelected && (
        <div style={{ marginTop: 10, paddingLeft: 34 }}>
          <StepFields
            step={step}
            script={script}
            templates={templates}
            onPatch={props.onPatch}
            onCapture={() => props.onCapture(path)}
          />
        </div>
      )}

      {branches.length > 0 && (
        <div style={{ marginTop: 10, paddingLeft: 22 }}>
          {branches.map((branch) => (
            <div
              key={branch}
              style={{
                borderLeft: '2px solid var(--wl-accent-soft)',
                paddingLeft: 12,
                marginBottom: 8
              }}
            >
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {BRANCH_TEXT[branch]}
              </Typography.Text>
              <div style={{ marginTop: 6 }}>
                {childrenOf(step, branch).length === 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    这个分支还是空的
                  </Typography.Text>
                ) : (
                  <BlockList
                    {...props}
                    steps={childrenOf(step, branch)}
                    basePath={[...path, branch]}
                  />
                )}
              </div>
              <div style={{ marginTop: 6 }}>
                <AddBlockButton
                  size="small"
                  label={`往${BRANCH_TEXT[branch]}加一块`}
                  hasTemplates={templates.length > 0}
                  onPick={(k) => props.onAddToBranch(path, branch, k)}
                />
              </div>
            </div>
          ))}
          {canElse && (
            <Button
              size="small"
              type="dashed"
              icon={<PlusOutlined />}
              onClick={() => props.onPatch({ ...step, else: [] })}
            >
              加一个「否则」分支
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

// ── 「加一块」按钮（分组下拉）────────────────────────────────────────────

function AddBlockButton({
  onPick,
  hasTemplates,
  size,
  label = '加一块'
}: {
  onPick: (kind: BlockKind) => void
  hasTemplates: boolean
  size?: 'small'
  label?: string
}): React.JSX.Element {
  const groups = ['画面', '操作', '应用', '流程'] as const
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        onClick: ({ key }) => onPick(key as BlockKind),
        items: groups.map((g) => ({
          key: g,
          type: 'group' as const,
          label: g,
          children: BLOCK_CATALOG.filter((b) => b.group === g).map((b) => ({
            key: b.kind,
            disabled: b.needsTemplate && !hasTemplates,
            label: (
              <Tooltip
                title={b.needsTemplate && !hasTemplates ? '模板集里还没有模板，先去截一张' : b.hint}
                placement="right"
              >
                <span>{b.label}</span>
              </Tooltip>
            )
          }))
        }))
      }}
    >
      <Button size={size} icon={<PlusOutlined />}>
        {label}
      </Button>
    </Dropdown>
  )
}

// ── 单块的表单 ────────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div style={{ minWidth: 180 }}>
      <div style={{ marginBottom: 4 }}>
        <Typography.Text style={{ fontSize: 12 }} type="secondary">
          {label}
        </Typography.Text>
      </div>
      {children}
      {hint && (
        <div style={{ marginTop: 2 }}>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {hint}
          </Typography.Text>
        </div>
      )}
    </div>
  )
}

function StepFields({
  step,
  script,
  templates,
  onPatch,
  onCapture
}: {
  step: ScriptStep
  script: ScriptDef
  templates: TemplateDef[]
  onPatch: (next: ScriptStep) => void
  onCapture: () => void
}): React.JSX.Element {
  const tplOptions = templates.map((t) => ({ value: t.id, label: `${t.name}（${t.id}）` }))
  const coordHint = `参考分辨率 ${script.refWidth}×${script.refHeight}`
  const patch = (p: Partial<ScriptStep>): void => onPatch({ ...step, ...p } as ScriptStep)

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space wrap size={16} align="start">
        {step.kind === 'tapTemplate' && (
          <>
            <Field label="点哪张模板">
              <Space.Compact>
                <Select
                  style={{ width: 260 }}
                  value={step.templateId || undefined}
                  options={tplOptions}
                  placeholder="选一张模板"
                  onChange={(v) => onPatch({ ...step, templateId: v })}
                  showSearch
                  optionFilterProp="label"
                />
                <Tooltip title="现截一张新的">
                  <Button icon={<CameraOutlined />} onClick={onCapture} />
                </Tooltip>
              </Space.Compact>
            </Field>
            <Field label="找不到时最多等" hint="0 = 只看当前这一帧">
              <InputNumber
                min={0}
                max={600_000}
                step={500}
                addonAfter="ms"
                value={step.waitMs ?? 0}
                onChange={(v) => onPatch({ ...step, waitMs: v ?? 0 })}
              />
            </Field>
            <Field label="点击偏移" hint="相对模板中心，一般留 0">
              <Space.Compact>
                <InputNumber
                  style={{ width: 90 }}
                  addonBefore="x"
                  value={step.offset?.x ?? 0}
                  onChange={(v) =>
                    onPatch({ ...step, offset: { x: v ?? 0, y: step.offset?.y ?? 0 } })
                  }
                />
                <InputNumber
                  style={{ width: 90 }}
                  addonBefore="y"
                  value={step.offset?.y ?? 0}
                  onChange={(v) =>
                    onPatch({ ...step, offset: { x: step.offset?.x ?? 0, y: v ?? 0 } })
                  }
                />
              </Space.Compact>
            </Field>
            <Field label="匹配阈值" hint="留空用模板自己的；调低更容易命中也更容易认错">
              <InputNumber
                min={0.5}
                max={0.99}
                step={0.01}
                style={{ width: 110 }}
                value={step.threshold}
                onChange={(v) => onPatch({ ...step, threshold: v ?? undefined })}
              />
            </Field>
          </>
        )}

        {step.kind === 'waitFor' && (
          <>
            <Field label="等什么">
              <CondEditor
                cond={step.cond}
                templates={templates}
                onChange={(c) => c && onPatch({ ...step, cond: c })}
                onCapture={onCapture}
              />
            </Field>
            <Field label="最多等" hint="超时算这一步失败">
              <InputNumber
                min={0}
                max={600_000}
                step={1000}
                addonAfter="ms"
                value={step.waitMs}
                onChange={(v) => onPatch({ ...step, waitMs: v ?? 0 })}
              />
            </Field>
            <Field label="多久看一次" hint="留空 = 按引擎默认节奏（约 3 帧/秒）">
              <InputNumber
                min={100}
                max={10_000}
                step={100}
                addonAfter="ms"
                value={step.pollMs}
                onChange={(v) => onPatch({ ...step, pollMs: v ?? undefined })}
              />
            </Field>
          </>
        )}

        {step.kind === 'tap' && (
          <Field label="点哪里" hint={coordHint}>
            <Space.Compact>
              <InputNumber
                style={{ width: 110 }}
                addonBefore="x"
                value={step.at.x}
                onChange={(v) => onPatch({ ...step, at: { ...step.at, x: v ?? 0 } })}
              />
              <InputNumber
                style={{ width: 110 }}
                addonBefore="y"
                value={step.at.y}
                onChange={(v) => onPatch({ ...step, at: { ...step.at, y: v ?? 0 } })}
              />
            </Space.Compact>
          </Field>
        )}

        {step.kind === 'swipe' && (
          <>
            <Field label="从" hint={coordHint}>
              <Space.Compact>
                <InputNumber
                  style={{ width: 100 }}
                  addonBefore="x"
                  value={step.from.x}
                  onChange={(v) => onPatch({ ...step, from: { ...step.from, x: v ?? 0 } })}
                />
                <InputNumber
                  style={{ width: 100 }}
                  addonBefore="y"
                  value={step.from.y}
                  onChange={(v) => onPatch({ ...step, from: { ...step.from, y: v ?? 0 } })}
                />
              </Space.Compact>
            </Field>
            <Field label="滑到">
              <Space.Compact>
                <InputNumber
                  style={{ width: 100 }}
                  addonBefore="x"
                  value={step.to.x}
                  onChange={(v) => onPatch({ ...step, to: { ...step.to, x: v ?? 0 } })}
                />
                <InputNumber
                  style={{ width: 100 }}
                  addonBefore="y"
                  value={step.to.y}
                  onChange={(v) => onPatch({ ...step, to: { ...step.to, y: v ?? 0 } })}
                />
              </Space.Compact>
            </Field>
            <Field label="用时" hint="滑动期间队列是堵住的，别写太长">
              <InputNumber
                min={50}
                max={5000}
                addonAfter="ms"
                value={step.durationMs ?? 300}
                onChange={(v) => onPatch({ ...step, durationMs: v ?? 300 })}
              />
            </Field>
          </>
        )}

        {step.kind === 'longPress' && (
          <>
            <Field label="按哪里" hint={coordHint}>
              <Space.Compact>
                <InputNumber
                  style={{ width: 100 }}
                  addonBefore="x"
                  value={step.at.x}
                  onChange={(v) => onPatch({ ...step, at: { ...step.at, x: v ?? 0 } })}
                />
                <InputNumber
                  style={{ width: 100 }}
                  addonBefore="y"
                  value={step.at.y}
                  onChange={(v) => onPatch({ ...step, at: { ...step.at, y: v ?? 0 } })}
                />
              </Space.Compact>
            </Field>
            <Field label="按多久">
              <InputNumber
                min={100}
                max={10_000}
                addonAfter="ms"
                value={step.durationMs}
                onChange={(v) => onPatch({ ...step, durationMs: v ?? 800 })}
              />
            </Field>
          </>
        )}

        {step.kind === 'text' && (
          <Field label="输入什么" hint="中文会走 ADBKeyboard 广播，引擎已经处理好了">
            <Input
              style={{ width: 320 }}
              value={step.text}
              onChange={(e) => onPatch({ ...step, text: e.target.value })}
            />
          </Field>
        )}

        {step.kind === 'key' && (
          <Field label="按哪个键">
            <Select
              style={{ width: 160 }}
              value={step.key}
              options={Object.entries(ANDROID_KEY_TEXT).map(([k, label]) => ({
                value: k,
                label
              }))}
              onChange={(v) => onPatch({ ...step, key: v as AndroidKey })}
            />
          </Field>
        )}

        {step.kind === 'sleep' && (
          <Field label="等多久" hint="能用「等它出现」就别死等">
            <InputNumber
              min={0}
              max={600_000}
              step={100}
              addonAfter="ms"
              value={step.ms}
              onChange={(v) => onPatch({ ...step, ms: v ?? 0 })}
            />
          </Field>
        )}

        {(step.kind === 'launchApp' || step.kind === 'stopApp') && (
          <Field
            label="应用包名"
            hint={`留空 = 用脚本头部的 ${script.packageName || '（还没填）'}`}
          >
            <Input
              style={{ width: 280 }}
              placeholder={script.packageName || 'com.example.app'}
              value={step.packageName ?? ''}
              onChange={(e) => onPatch({ ...step, packageName: e.target.value || undefined })}
            />
          </Field>
        )}
        {step.kind === 'launchApp' && (
          <Field label="冷启动" hint="先强制停止再打开，保证是全新进程">
            <Switch checked={step.cold ?? false} onChange={(v) => onPatch({ ...step, cold: v })} />
          </Field>
        )}

        {step.kind === 'screenshot' && (
          <Field label="截图标签" hint="会写进文件名，方便回头找">
            <Input
              style={{ width: 220 }}
              value={step.label ?? ''}
              onChange={(e) => onPatch({ ...step, label: e.target.value || undefined })}
            />
          </Field>
        )}

        {step.kind === 'log' && (
          <>
            <Field label="级别">
              <Select
                style={{ width: 120 }}
                value={step.level}
                options={[
                  { value: 'debug', label: '调试' },
                  { value: 'info', label: '信息' },
                  { value: 'warn', label: '警告' },
                  { value: 'error', label: '错误' }
                ]}
                onChange={(v) => onPatch({ ...step, level: v as LogLevel })}
              />
            </Field>
            <Field label="写什么">
              <Input
                style={{ width: 320 }}
                value={step.message}
                onChange={(e) => onPatch({ ...step, message: e.target.value })}
              />
            </Field>
          </>
        )}

        {step.kind === 'if' && (
          <Field label="条件">
            <CondEditor
              cond={step.cond}
              templates={templates}
              onChange={(c) => c && onPatch({ ...step, cond: c })}
              onCapture={onCapture}
            />
          </Field>
        )}

        {step.kind === 'loop' && (
          <>
            <Field label="重复几次" hint="留空 = 只看下面的条件">
              <InputNumber
                min={1}
                max={10_000}
                value={step.repeat}
                onChange={(v) => onPatch({ ...step, repeat: v ?? undefined })}
              />
            </Field>
            <Field label="只要满足就继续" hint="留空 = 只按次数">
              <CondEditor
                cond={step.while}
                allowEmpty
                templates={templates}
                onChange={(c) => onPatch({ ...step, while: c ?? undefined })}
                onCapture={onCapture}
              />
            </Field>
            <Field label="硬上限" hint="防死循环，默认 1000">
              <InputNumber
                min={1}
                max={100_000}
                value={step.maxIterations}
                onChange={(v) => onPatch({ ...step, maxIterations: v ?? undefined })}
              />
            </Field>
          </>
        )}

        {step.kind === 'label' && (
          <Field label="落点名">
            <Input
              style={{ width: 200 }}
              value={step.label}
              onChange={(e) => onPatch({ ...step, label: e.target.value })}
            />
          </Field>
        )}

        {step.kind === 'goto' && (
          <>
            <Field label="跳到哪个落点">
              <Input
                style={{ width: 200 }}
                value={step.label}
                onChange={(e) => onPatch({ ...step, label: e.target.value })}
              />
            </Field>
            <Field label="最多跳几次" hint="防死循环">
              <InputNumber
                min={1}
                max={10_000}
                value={step.maxTimes}
                onChange={(v) => onPatch({ ...step, maxTimes: v ?? undefined })}
              />
            </Field>
          </>
        )}
      </Space>

      <Collapse
        ghost
        size="small"
        items={[
          {
            key: 'more',
            label: (
              <Typography.Text type="secondary">
                更多设置（起名、前置条件、失败处理）
              </Typography.Text>
            ),
            children: (
              <Space wrap size={16} align="start">
                <Field label="这一块叫什么" hint="会显示在日志里，不填就用块类型">
                  <Input
                    style={{ width: 220 }}
                    value={step.name ?? ''}
                    placeholder="例如：点开联盟"
                    onChange={(e) => patch({ name: e.target.value || undefined })}
                  />
                </Field>
                <Field label="前置条件" hint="不成立就跳过这一块，不算失败">
                  <CondEditor
                    cond={step.when}
                    allowEmpty
                    templates={templates}
                    onChange={(c) => patch({ when: c ?? undefined })}
                    onCapture={onCapture}
                  />
                </Field>
                <Field label="失败重试">
                  <Space.Compact>
                    <InputNumber
                      style={{ width: 100 }}
                      min={0}
                      max={20}
                      addonAfter="次"
                      value={step.retry ?? 0}
                      onChange={(v) => patch({ retry: v ?? 0 })}
                    />
                    <InputNumber
                      style={{ width: 130 }}
                      min={0}
                      max={60_000}
                      step={100}
                      addonAfter="ms 后"
                      value={step.retryDelayMs}
                      onChange={(v) => patch({ retryDelayMs: v ?? undefined })}
                    />
                  </Space.Compact>
                </Field>
                <Field
                  label="重试完还是失败"
                  hint="AI 顾问会在这之前先看一眼画面（除非选「跳过」）"
                >
                  <Select
                    style={{ width: 190 }}
                    value={step.onFail?.kind ?? 'abort'}
                    options={[
                      { value: 'abort', label: '停止整个脚本' },
                      { value: 'continue', label: '跳过，继续下一块' },
                      { value: 'goto', label: '跳到某个落点' },
                      { value: 'restartApp', label: '重启应用，从头再来' }
                    ]}
                    onChange={(v) => {
                      if (v === 'goto') patch({ onFail: { kind: 'goto', label: '落点1' } })
                      else if (v === 'abort') patch({ onFail: undefined })
                      else patch({ onFail: { kind: v as 'continue' | 'restartApp' } })
                    }}
                  />
                </Field>
                {step.onFail?.kind === 'goto' && (
                  <Field label="跳到哪个落点">
                    <Input
                      style={{ width: 160 }}
                      value={step.onFail.label}
                      onChange={(e) => patch({ onFail: { kind: 'goto', label: e.target.value } })}
                    />
                  </Field>
                )}
                <Field label="这一块的超时" hint="留空 = 不单独限时">
                  <InputNumber
                    min={0}
                    max={600_000}
                    step={1000}
                    addonAfter="ms"
                    value={step.timeoutMs}
                    onChange={(v) => patch({ timeoutMs: v ?? undefined })}
                  />
                </Field>
                <Field label="做完再等一下" hint="给界面动画留时间">
                  <InputNumber
                    min={0}
                    max={60_000}
                    step={100}
                    addonAfter="ms"
                    value={step.afterDelayMs}
                    onChange={(v) => patch({ afterDelayMs: v ?? undefined })}
                  />
                </Field>
                <Field label="强制留痕" hint="不管全局策略，这一块都存一张截图">
                  <Switch
                    checked={step.capture === true}
                    onChange={(v) => patch({ capture: v ? true : undefined })}
                  />
                </Field>
              </Space>
            )
          }
        ]}
      />
    </Space>
  )
}

// ── 条件编辑器 ────────────────────────────────────────────────────────────

type CondMode = 'none' | 'has' | 'hasNot' | 'anyOf' | 'foreground' | 'always' | 'complex'

function modeOf(cond: Condition | undefined): CondMode {
  if (!cond) return 'none'
  switch (cond.kind) {
    case 'template':
      return cond.present === false ? 'hasNot' : 'has'
    case 'anyTemplate':
      return 'anyOf'
    case 'foreground':
      return 'foreground'
    case 'always':
      return 'always'
    default:
      return 'complex'
  }
}

/**
 * 条件编辑器。覆盖日常 95% 的用法；and / or / not 这类组合条件只读显示，
 * 要改请切到 JSON 模式 —— 为了几个百分比的场景在这里堆一棵可视化表达式树，不划算。
 */
function CondEditor({
  cond,
  templates,
  onChange,
  onCapture,
  allowEmpty
}: {
  cond?: Condition
  templates: TemplateDef[]
  onChange: (c: Condition | null) => void
  onCapture: () => void
  allowEmpty?: boolean
}): React.JSX.Element {
  const mode = modeOf(cond)
  const tplOptions = templates.map((t) => ({ value: t.id, label: `${t.name}（${t.id}）` }))
  const firstTpl = templates[0]?.id ?? ''

  if (mode === 'complex' && cond) {
    return (
      <Alert
        type="info"
        showIcon
        message={`组合条件：${describeCond(cond, templates)}`}
        description="这种条件要到 JSON 模式里改。可视化模式不会动它。"
        style={{ maxWidth: 420 }}
      />
    )
  }

  const options = [
    ...(allowEmpty ? [{ value: 'none', label: '不设条件' }] : []),
    { value: 'has', label: '画面上有' },
    { value: 'hasNot', label: '画面上没有' },
    { value: 'anyOf', label: '出现任意一张' },
    { value: 'foreground', label: '前台应用是' },
    { value: 'always', label: '总是成立' }
  ]

  const switchMode = (m: CondMode): void => {
    switch (m) {
      case 'none':
        onChange(null)
        break
      case 'has':
        onChange({ kind: 'template', templateId: firstTpl })
        break
      case 'hasNot':
        onChange({ kind: 'template', templateId: firstTpl, present: false })
        break
      case 'anyOf':
        onChange({ kind: 'anyTemplate', templateIds: firstTpl ? [firstTpl] : [] })
        break
      case 'foreground':
        onChange({ kind: 'foreground', packageName: '' })
        break
      case 'always':
        onChange({ kind: 'always' })
        break
      default:
        break
    }
  }

  return (
    <Space direction="vertical" size={6}>
      <Segmented
        size="small"
        value={mode}
        options={options}
        onChange={(v) => switchMode(v as CondMode)}
      />
      {(mode === 'has' || mode === 'hasNot') && cond?.kind === 'template' && (
        <Space.Compact>
          <Select
            style={{ width: 240 }}
            value={cond.templateId || undefined}
            options={tplOptions}
            placeholder="选一张模板"
            showSearch
            optionFilterProp="label"
            onChange={(v) => onChange({ ...cond, templateId: v })}
          />
          <Tooltip title="现截一张新的">
            <Button icon={<CameraOutlined />} onClick={onCapture} />
          </Tooltip>
        </Space.Compact>
      )}
      {mode === 'anyOf' && cond?.kind === 'anyTemplate' && (
        <Select
          mode="multiple"
          style={{ width: 300 }}
          value={cond.templateIds}
          options={tplOptions}
          placeholder="选几张模板，出现任意一张就算成立"
          showSearch
          optionFilterProp="label"
          onChange={(v) => onChange({ ...cond, templateIds: v })}
        />
      )}
      {mode === 'foreground' && cond?.kind === 'foreground' && (
        <Space>
          <Input
            style={{ width: 240 }}
            placeholder="com.example.app"
            value={cond.packageName}
            onChange={(e) => onChange({ ...cond, packageName: e.target.value })}
          />
          <Switch
            checkedChildren="是"
            unCheckedChildren="不是"
            checked={cond.equals !== false}
            onChange={(v) => onChange({ ...cond, equals: v ? undefined : false })}
          />
        </Space>
      )}
    </Space>
  )
}
