/**
 * 功能块层：可视化脚本编辑器背后的**纯逻辑**。
 *
 * 两件事，都与界面无关，所以放在契约层（不 import React、不碰 DOM、不碰 IPC，能被离线自检直接跑）：
 *
 *   一、块树的增删改查 —— 脚本的 steps 是一棵树（if 有 then/else，loop 有 steps），
 *       界面上每个块用一条**路径**定位：[2] = 顶层第 3 块，[2,'then',0] = 那块 if 的「成立时」第 1 块。
 *       所有操作都返回新数组（不原地改），React 的状态比较才靠得住。
 *
 *   二、块目录 —— DSL 的 kind（tapTemplate / waitFor / onFail）⇄ 面板上的中文块
 *       （「点这张图」「等它出现」「失败了怎么办」）。两套词汇的对照**只写在这里**，
 *       别在各个组件里各翻译各的。
 *
 * ★ 为什么不直接让界面改 JSON：改 JSON 时一个逗号打错，整份脚本就读不出来了。
 *   路径操作是结构化的，改不坏；而 JSON 模式仍然留着，给需要手搓复杂逻辑的人。
 *
 * 自检：npm run check:blocks
 */

import type { AndroidKey, Condition, ScriptStep } from './script'
import type { TemplateDef } from './vision'

// ═══════════════════════════════════════════════════════════════════════════
// 一、块树
// ═══════════════════════════════════════════════════════════════════════════

/** 分支名。叶子块没有分支。 */
export type Branch = 'then' | 'else' | 'steps'

/** 块路径：数字是同级序号，字符串是分支名。例如 [1, 'then', 0]。 */
export type BlockPath = (number | Branch)[]

export function pathKey(path: BlockPath): string {
  return path.join('/')
}

export function samePath(a: BlockPath, b: BlockPath): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** 这个块下面有哪些分支（按界面显示顺序）。 */
export function branchesOf(step: ScriptStep): Branch[] {
  if (step.kind === 'if') return step.else ? ['then', 'else'] : ['then']
  if (step.kind === 'loop') return ['steps']
  return []
}

export function childrenOf(step: ScriptStep, branch: Branch): ScriptStep[] {
  if (step.kind === 'if') {
    if (branch === 'then') return step.then
    if (branch === 'else') return step.else ?? []
  }
  if (step.kind === 'loop' && branch === 'steps') return step.steps
  return []
}

function withChildren(step: ScriptStep, branch: Branch, children: ScriptStep[]): ScriptStep {
  if (step.kind === 'if' && branch === 'then') return { ...step, then: children }
  if (step.kind === 'if' && branch === 'else') return { ...step, else: children }
  if (step.kind === 'loop' && branch === 'steps') return { ...step, steps: children }
  return step
}

/**
 * 把路径拆成「容器里的数组」+「数组里的下标」。
 * 返回 null 表示路径指向了不存在的地方（界面刚删过一块又点了旧按钮时会遇到）。
 */
function locate(
  steps: ScriptStep[],
  path: BlockPath
): { list: ScriptStep[]; index: number; rebuild: (list: ScriptStep[]) => ScriptStep[] } | null {
  if (path.length === 0) return null
  const [head, ...rest] = path
  if (typeof head !== 'number' || head < 0 || head >= steps.length) return null

  if (rest.length === 0) {
    return {
      list: steps,
      index: head,
      rebuild: (list) => list
    }
  }

  const [branch, ...tail] = rest
  if (typeof branch !== 'string') return null
  const parent = steps[head]
  const inner = locate(childrenOf(parent, branch), tail)
  if (!inner) return null
  return {
    list: inner.list,
    index: inner.index,
    rebuild: (list) => {
      const nextChildren = inner.rebuild(list)
      const next = [...steps]
      next[head] = withChildren(parent, branch, nextChildren)
      return next
    }
  }
}

export function getAt(steps: ScriptStep[], path: BlockPath): ScriptStep | null {
  const at = locate(steps, path)
  return at ? (at.list[at.index] ?? null) : null
}

export function updateAt(steps: ScriptStep[], path: BlockPath, next: ScriptStep): ScriptStep[] {
  const at = locate(steps, path)
  if (!at) return steps
  const list = [...at.list]
  list[at.index] = next
  return at.rebuild(list)
}

export function removeAt(steps: ScriptStep[], path: BlockPath): ScriptStep[] {
  const at = locate(steps, path)
  if (!at) return steps
  const list = [...at.list]
  list.splice(at.index, 1)
  return at.rebuild(list)
}

/** 在指定位置**之后**插入。path 为空数组表示追加到顶层末尾。 */
export function insertAfter(
  steps: ScriptStep[],
  path: BlockPath,
  added: ScriptStep[]
): ScriptStep[] {
  if (path.length === 0) return [...steps, ...added]
  const at = locate(steps, path)
  if (!at) return [...steps, ...added]
  const list = [...at.list]
  list.splice(at.index + 1, 0, ...added)
  return at.rebuild(list)
}

/** 插到某个分支的末尾（「往这个分支里加一块」按钮用）。 */
export function appendToBranch(
  steps: ScriptStep[],
  parentPath: BlockPath,
  branch: Branch,
  added: ScriptStep[]
): ScriptStep[] {
  const parent = getAt(steps, parentPath)
  if (!parent) return steps
  const children = [...childrenOf(parent, branch), ...added]
  return updateAt(steps, parentPath, withChildren(parent, branch, children))
}

/** 同级内上下移动。到顶/到底就原样返回。 */
export function moveAt(steps: ScriptStep[], path: BlockPath, delta: -1 | 1): ScriptStep[] {
  const at = locate(steps, path)
  if (!at) return steps
  const to = at.index + delta
  if (to < 0 || to >= at.list.length) return steps
  const list = [...at.list]
  const [moved] = list.splice(at.index, 1)
  list.splice(to, 0, moved)
  return at.rebuild(list)
}

/** 移动之后这块在哪（面板要把选中状态跟着挪过去）。 */
export function movedPath(path: BlockPath, delta: -1 | 1): BlockPath {
  const next = [...path]
  const last = next[next.length - 1]
  if (typeof last === 'number') next[next.length - 1] = last + delta
  return next
}

/** 收集整棵树里已用的 step id，生成新 id 时要避开。 */
export function collectIds(steps: ScriptStep[], into = new Set<string>()): Set<string> {
  for (const s of steps) {
    into.add(s.id)
    for (const b of branchesOf(s)) collectIds(childrenOf(s, b), into)
  }
  return into
}

/**
 * 生成一个不与现有块冲突的 id。
 * 形如 `tap-3`：前缀用块类型，读日志时一眼能看出是哪一步。
 */
export function nextStepId(steps: ScriptStep[], prefix: string): string {
  const used = collectIds(steps)
  for (let n = 1; n < 10_000; n++) {
    const id = `${prefix}-${n}`
    if (!used.has(id)) return id
  }
  return `${prefix}-${Date.now()}`
}

/** 深拷贝一块（含子块），并把里面所有 id 都换成没用过的 —— 「复制」按钮用。 */
export function cloneWithNewIds(steps: ScriptStep[], step: ScriptStep): ScriptStep {
  const used = collectIds(steps)
  const fresh = (prefix: string): string => {
    for (let n = 1; n < 10_000; n++) {
      const id = `${prefix}-${n}`
      if (!used.has(id)) {
        used.add(id)
        return id
      }
    }
    return `${prefix}-${Date.now()}`
  }
  const walk = (s: ScriptStep): ScriptStep => {
    const copy: ScriptStep = { ...s, id: fresh(s.kind) }
    if (copy.kind === 'if') {
      return {
        ...copy,
        then: copy.then.map(walk),
        ...(copy.else ? { else: copy.else.map(walk) } : {})
      }
    }
    if (copy.kind === 'loop') return { ...copy, steps: copy.steps.map(walk) }
    return copy
  }
  return walk(step)
}

/** 整棵树里一共多少块（含子块）—— 面板上显示「共 N 块」。 */
export function countBlocks(steps: ScriptStep[]): number {
  let n = 0
  for (const s of steps) {
    n += 1
    for (const b of branchesOf(s)) n += countBlocks(childrenOf(s, b))
  }
  return n
}

/** 整棵树里引用到的模板 id（面板据此提示「这些模板还在不在模板集里」）。 */
export function collectTemplateIds(steps: ScriptStep[], into = new Set<string>()): Set<string> {
  const fromCond = (c: unknown): void => {
    if (typeof c !== 'object' || c === null) return
    const o = c as Record<string, unknown>
    if (typeof o.templateId === 'string') into.add(o.templateId)
    if (Array.isArray(o.templateIds)) {
      for (const id of o.templateIds) if (typeof id === 'string') into.add(id)
    }
    for (const key of ['all', 'any'] as const) {
      const list = o[key]
      if (Array.isArray(list)) for (const sub of list) fromCond(sub)
    }
    if (o.of) fromCond(o.of)
  }
  for (const s of steps) {
    if (s.kind === 'tapTemplate') into.add(s.templateId)
    if (s.kind === 'waitFor') fromCond(s.cond)
    // ★ if 的条件、loop 的 while 也会引用模板，漏了它们等于漏掉整条分支的依赖。
    if (s.kind === 'if') fromCond(s.cond)
    if (s.kind === 'loop' && s.while) fromCond(s.while)
    if (s.when) fromCond(s.when)
    for (const b of branchesOf(s)) collectTemplateIds(childrenOf(s, b), into)
  }
  return into
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、块目录（DSL ⇄ 中文块）
// ═══════════════════════════════════════════════════════════════════════════

/** 面板上的块类型。与 DSL 的 kind 大多是一一对应，waitFor 拆成了「等出现 / 等消失」两个入口。 */
export type BlockKind =
  | 'tapTemplate'
  | 'waitAppear'
  | 'waitDisappear'
  | 'tap'
  | 'swipe'
  | 'longPress'
  | 'text'
  | 'key'
  | 'sleep'
  | 'launchApp'
  | 'stopApp'
  | 'screenshot'
  | 'log'
  | 'if'
  | 'loop'
  | 'label'
  | 'goto'

export interface BlockMeta {
  kind: BlockKind
  /** 面板上的块名。 */
  label: string
  /** 一句话说明它干什么，鼠标悬停时显示。 */
  hint: string
  /** 分组，决定在「加一块」面板里排在哪一栏。 */
  group: '画面' | '操作' | '应用' | '流程'
  /** 需要模板集里有模板才能用。 */
  needsTemplate?: boolean
}

export const BLOCK_CATALOG: BlockMeta[] = [
  {
    kind: 'tapTemplate',
    label: '点这张图',
    hint: '在画面里找这张模板，找到就点它。自动化里 90% 的动作都是这一块。',
    group: '画面',
    needsTemplate: true
  },
  {
    kind: 'waitAppear',
    label: '等它出现',
    hint: '一直等到这张模板出现为止；等过头了算这一步失败。',
    group: '画面',
    needsTemplate: true
  },
  {
    kind: 'waitDisappear',
    label: '等它消失',
    hint: '等到这张模板从画面上消失（等加载圈转完最常用）。',
    group: '画面',
    needsTemplate: true
  },
  {
    kind: 'tap',
    label: '点固定坐标',
    hint: '点画面上的一个固定位置。界面一改版就会点空，能用模板就别用它。',
    group: '操作'
  },
  { kind: 'swipe', label: '滑动', hint: '从一个点滑到另一个点。', group: '操作' },
  { kind: 'longPress', label: '长按', hint: '按住不放一段时间。', group: '操作' },
  { kind: 'text', label: '输入文字', hint: '往当前输入框里打字，中文也行。', group: '操作' },
  { kind: 'key', label: '按系统键', hint: '返回 / 主页 / 回车这类系统按键。', group: '操作' },
  {
    kind: 'sleep',
    label: '等一会儿',
    hint: '干等一段时间。能用「等它出现」就别用死等。',
    group: '操作'
  },
  {
    kind: 'launchApp',
    label: '启动应用',
    hint: '把游戏拉到前台；勾上「冷启动」会先杀掉再重开。',
    group: '应用'
  },
  { kind: 'stopApp', label: '关闭应用', hint: '强制停止应用。', group: '应用' },
  {
    kind: 'screenshot',
    label: '留一张截图',
    hint: '主动存一张现场图，方便事后排查。',
    group: '应用'
  },
  { kind: 'log', label: '记一行日志', hint: '往运行日志里写一句话，标记跑到哪了。', group: '应用' },
  { kind: 'if', label: '条件分支', hint: '条件成立走一条路，不成立走另一条。', group: '流程' },
  {
    kind: 'loop',
    label: '循环',
    hint: '把里面的块重复跑若干次，或一直跑到条件不成立。',
    group: '流程'
  },
  { kind: 'label', label: '落点', hint: '给「跳转」用的落脚点，本身什么都不做。', group: '流程' },
  { kind: 'goto', label: '跳转', hint: '跳到某个落点。只能跳到同级或外层。', group: '流程' }
]

export function blockMeta(kind: BlockKind): BlockMeta {
  return BLOCK_CATALOG.find((b) => b.kind === kind) ?? BLOCK_CATALOG[0]
}

/** 反过来：一个已有的 step 在面板上算哪种块。 */
export function kindOfStep(step: ScriptStep): BlockKind {
  if (step.kind === 'waitFor') {
    const c = step.cond
    if (c.kind === 'template' && c.present === false) return 'waitDisappear'
    return 'waitAppear'
  }
  return step.kind as BlockKind
}

/** 新建一块时的默认内容。templateId 只有画面类的块会用到。 */
export function makeBlock(kind: BlockKind, id: string, templateId?: string): ScriptStep {
  const tpl = templateId ?? ''
  switch (kind) {
    case 'tapTemplate':
      return { id, kind: 'tapTemplate', templateId: tpl, waitMs: 3000, retry: 1 }
    case 'waitAppear':
      return {
        id,
        kind: 'waitFor',
        cond: { kind: 'template', templateId: tpl },
        waitMs: 10_000
      }
    case 'waitDisappear':
      return {
        id,
        kind: 'waitFor',
        cond: { kind: 'template', templateId: tpl, present: false },
        waitMs: 10_000
      }
    case 'tap':
      return { id, kind: 'tap', at: { x: 0, y: 0 } }
    case 'swipe':
      return { id, kind: 'swipe', from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, durationMs: 300 }
    case 'longPress':
      return { id, kind: 'longPress', at: { x: 0, y: 0 }, durationMs: 800 }
    case 'text':
      return { id, kind: 'text', text: '' }
    case 'key':
      return { id, kind: 'key', key: 'BACK' }
    case 'sleep':
      return { id, kind: 'sleep', ms: 1000 }
    case 'launchApp':
      return { id, kind: 'launchApp', cold: false }
    case 'stopApp':
      return { id, kind: 'stopApp' }
    case 'screenshot':
      return { id, kind: 'screenshot' }
    case 'log':
      return { id, kind: 'log', level: 'info', message: '' }
    case 'if':
      return { id, kind: 'if', cond: { kind: 'template', templateId: tpl }, then: [] }
    case 'loop':
      return { id, kind: 'loop', steps: [], repeat: 3 }
    case 'label':
      return { id, kind: 'label', label: '落点1' }
    case 'goto':
      return { id, kind: 'goto', label: '落点1', maxTimes: 10 }
  }
}

/** 这一块引用的模板 id（只看它自己最主要的那个），没有就返回 null。 */
export function templateIdOf(step: ScriptStep): string | null {
  if (step.kind === 'tapTemplate') return step.templateId
  if (step.kind === 'waitFor' && step.cond.kind === 'template') return step.cond.templateId
  if (step.kind === 'if' && step.cond.kind === 'template') return step.cond.templateId
  return null
}

/** 换掉这一块引用的模板。 */
export function withTemplateId(step: ScriptStep, templateId: string): ScriptStep {
  if (step.kind === 'tapTemplate') return { ...step, templateId }
  if (step.kind === 'waitFor' && step.cond.kind === 'template') {
    return { ...step, cond: { ...step.cond, templateId } }
  }
  if (step.kind === 'if' && step.cond.kind === 'template') {
    return { ...step, cond: { ...step.cond, templateId } }
  }
  return step
}

export const ANDROID_KEY_TEXT: Record<AndroidKey, string> = {
  BACK: '返回',
  HOME: '主页',
  ENTER: '回车',
  MENU: '菜单',
  APP_SWITCH: '任务列表',
  DEL: '退格',
  ESCAPE: 'Esc',
  VOLUME_UP: '音量 +',
  VOLUME_DOWN: '音量 −'
}

export const FAIL_POLICY_TEXT = {
  abort: '停止整个脚本',
  continue: '跳过，继续下一块',
  goto: '跳到某个落点',
  restartApp: '重启应用，从头再来'
} as const

/** 模板 id → 中文名。找不到就把 id 原样显示（模板被删了的情况）。 */
export function templateName(templates: TemplateDef[], id: string | null): string {
  if (!id) return '（还没选模板）'
  return templates.find((t) => t.id === id)?.name ?? id
}

/** 条件的中文描述。复杂条件（and/or/not）只给个概括，编辑要去 JSON 模式。 */
export function describeCond(cond: Condition, templates: TemplateDef[]): string {
  switch (cond.kind) {
    case 'always':
      return '总是成立'
    case 'never':
      return '永不成立'
    case 'template':
      return cond.present === false
        ? `画面上没有「${templateName(templates, cond.templateId)}」`
        : `画面上有「${templateName(templates, cond.templateId)}」`
    case 'anyTemplate':
      return `出现任意一张：${cond.templateIds.map((id) => templateName(templates, id)).join('、')}`
    case 'foreground':
      return cond.equals === false
        ? `前台不是「${cond.packageName}」`
        : `前台是「${cond.packageName}」`
    case 'and':
      return `同时满足 ${cond.all.length} 个条件`
    case 'or':
      return `满足 ${cond.any.length} 个条件之一`
    case 'not':
      return '不满足某个条件'
  }
}

/**
 * 一块在卡片上显示的那句话。写得越像人话越好 —— 这是面板上出现频率最高的文本。
 */
export function describeBlock(step: ScriptStep, templates: TemplateDef[]): string {
  switch (step.kind) {
    case 'tapTemplate': {
      const name = templateName(templates, step.templateId)
      const wait = step.waitMs
        ? `，最多等 ${Math.round(step.waitMs / 1000)} 秒`
        : '，只看当前这一帧'
      const off =
        step.offset && (step.offset.x || step.offset.y)
          ? `，偏移 (${step.offset.x}, ${step.offset.y})`
          : ''
      return `找到「${name}」就点它${wait}${off}`
    }
    case 'waitFor': {
      const secs = Math.round(step.waitMs / 1000)
      return `${describeCond(step.cond, templates)}，最多等 ${secs} 秒`
    }
    case 'tap':
      return `点 (${step.at.x}, ${step.at.y})`
    case 'swipe':
      return `从 (${step.from.x}, ${step.from.y}) 滑到 (${step.to.x}, ${step.to.y})，用时 ${step.durationMs ?? 300}ms`
    case 'longPress':
      return `在 (${step.at.x}, ${step.at.y}) 按住 ${step.durationMs}ms`
    case 'text':
      return step.text ? `输入「${step.text}」` : '输入（内容还没填）'
    case 'key':
      return `按「${ANDROID_KEY_TEXT[step.key]}」键`
    case 'sleep':
      return `等 ${step.ms}ms`
    case 'launchApp':
      return `${step.cold ? '冷启动' : '启动'}${step.packageName ? `「${step.packageName}」` : '脚本指定的应用'}`
    case 'stopApp':
      return `关闭${step.packageName ? `「${step.packageName}」` : '脚本指定的应用'}`
    case 'screenshot':
      return step.label ? `留一张截图（${step.label}）` : '留一张截图'
    case 'log':
      return `日志：${step.message || '（还没填内容）'}`
    case 'if':
      return `如果${describeCond(step.cond, templates)}`
    case 'loop': {
      if (step.repeat != null && step.while)
        return `重复 ${step.repeat} 次，且只在「${describeCond(step.while, templates)}」时继续`
      if (step.repeat != null) return `重复 ${step.repeat} 次`
      if (step.while) return `只要「${describeCond(step.while, templates)}」就一直重复`
      return '循环（还没设次数或条件）'
    }
    case 'label':
      return `落点「${step.label}」`
    case 'goto':
      return `跳到落点「${step.label}」${step.maxTimes ? `，最多 ${step.maxTimes} 次` : ''}`
  }
}

/**
 * 这一块有没有明显问题（面板上标黄/标红用）。
 * 只做「一眼可见」的检查，真正的校验仍然在主进程的 script:validate（引用完整性、goto 落点等）。
 */
export function blockIssue(step: ScriptStep, templateIds: Set<string>): string | null {
  const tpl = templateIdOf(step)
  if (tpl !== null) {
    if (!tpl) return '还没选模板'
    if (!templateIds.has(tpl)) return `模板「${tpl}」不在这个脚本的模板集里`
  }
  if (step.kind === 'text' && !step.text) return '还没填要输入的内容'
  if (step.kind === 'log' && !step.message) return '还没填日志内容'
  if (step.kind === 'loop' && step.repeat == null && !step.while)
    return '既没设次数也没设条件，会一直转下去'
  if (step.kind === 'tap' && step.at.x === 0 && step.at.y === 0) return '坐标还是 (0, 0)'
  return null
}
