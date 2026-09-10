/**
 * 脚本的磁盘读写与静态校验。
 *
 *   内置脚本：src/scripts/builtin.ts（随包分发，只读）
 *   用户脚本：<dataDir>/scripts/<scriptId>.json（ScriptDef，zod 校验）
 *
 * validateScript() 是「运行前体检」：把那些一跑起来必然出错、但 zod 查不出来的问题
 * （重复 step id、goto 找不到 label、引用了不存在的模板、ROI 越界）提前变成中文提示。
 *
 * 本模块不注册 IPC handler（那是模块 e 的事），只导出纯函数，目录由调用方传入。
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@shared/errors'
import { parseOrThrow, scriptDefSchema } from '@shared/schemas'
import type { Rect } from '@shared/vision'
import type { Condition, ScriptDef, ScriptMeta, ScriptStep, ValidationIssue } from '@shared/script'
import {
  BUILTIN_SCRIPT_PREFIX,
  builtinScriptMetas,
  countSteps,
  getBuiltinScript,
  isBuiltinScriptId
} from '../../scripts/builtin'

export { BUILTIN_SCRIPT_PREFIX, isBuiltinScriptId }

/** 文件名安全的 id：只允许字母数字下划线中划线点，避免 ../ 之类的路径穿越。 */
const SAFE_ID = /^[A-Za-z0-9_.-]+$/

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new AppError('INVALID_ARGUMENT', `脚本 id 含非法字符（只允许字母、数字、_ - .）：${id}`)
  }
}

function fileOf(scriptsDir: string, id: string): string {
  assertSafeId(id)
  return join(scriptsDir, `${id}.json`)
}

function toMeta(def: ScriptDef, builtin: boolean): ScriptMeta {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    version: def.version,
    packageName: def.packageName,
    templateSetId: def.templateSetId,
    stepCount: countSteps(def.steps),
    updatedAt: def.updatedAt,
    builtin
  }
}

// ── 读 ────────────────────────────────────────────────────────────────────

/**
 * 列出全部脚本（内置在前，用户脚本按更新时间倒序）。
 * 单个文件损坏不会让整张列表挂掉：它会以「⚠ 无法解析」的形式出现在列表里，
 * 让用户看得见问题，而不是被静默吞掉。
 */
export async function listScripts(scriptsDir: string): Promise<ScriptMeta[]> {
  const metas: ScriptMeta[] = builtinScriptMetas()

  let files: string[]
  try {
    files = (await readdir(scriptsDir)).filter((f) => f.endsWith('.json'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return metas
    throw new AppError('IO_ERROR', `读取脚本目录失败：${scriptsDir}`, { cause: String(e) })
  }

  const user: ScriptMeta[] = []
  for (const f of files) {
    const id = f.slice(0, -'.json'.length)
    try {
      const def = await readUserScript(scriptsDir, id)
      user.push(toMeta(def, false))
    } catch (e) {
      user.push({
        id,
        name: `⚠ 无法解析的脚本文件：${f}`,
        description: e instanceof AppError ? e.message : String(e),
        version: '0.0.0',
        stepCount: 0,
        updatedAt: 0,
        builtin: false
      })
    }
  }
  user.sort((a, b) => b.updatedAt - a.updatedAt)
  return [...metas, ...user]
}

async function readUserScript(scriptsDir: string, id: string): Promise<ScriptDef> {
  const path = fileOf(scriptsDir, id)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('SCRIPT_NOT_FOUND', `脚本不存在：${id}`, { path })
    }
    throw new AppError('IO_ERROR', `读取脚本失败：${path}`, { cause: String(e) })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new AppError('SCRIPT_INVALID', `脚本文件不是合法 JSON：${path}`)
  }
  return parseOrThrow(scriptDefSchema, raw, `脚本 ${id}`, 'SCRIPT_INVALID') as ScriptDef
}

export async function getScript(scriptsDir: string, scriptId: string): Promise<ScriptDef> {
  const builtin = getBuiltinScript(scriptId)
  if (builtin) return builtin
  return readUserScript(scriptsDir, scriptId)
}

// ── 写 ────────────────────────────────────────────────────────────────────

/**
 * 保存用户脚本。
 * 结构性错误（重复 step id / 重复 label / goto 找不到 label）会被拒绝——
 * 这类脚本存下来也跑不了，早报早修。其余问题（模板缺失、ROI 越界）只是 warn，照常保存。
 */
export async function saveScript(scriptsDir: string, def: ScriptDef): Promise<ScriptMeta> {
  if (isBuiltinScriptId(def.id)) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `内置脚本不可覆盖：${def.id}。请用「另存为」改一个不以 ${BUILTIN_SCRIPT_PREFIX} 开头的 id。`
    )
  }
  assertSafeId(def.id)

  const checked = parseOrThrow(scriptDefSchema, def, `脚本 ${def.id}`, 'SCRIPT_INVALID') as ScriptDef
  const fatal = validateScript(checked).filter((i) => i.level === 'error' && i.fatal === true)
  if (fatal.length > 0) {
    throw new AppError('SCRIPT_INVALID', `脚本存在结构性错误，无法保存：\n${formatIssues(fatal)}`, {
      issues: fatal
    })
  }

  const saved: ScriptDef = { ...checked, updatedAt: Date.now() }
  const path = fileOf(scriptsDir, saved.id)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await mkdir(scriptsDir, { recursive: true })
    await writeFile(tmp, `${JSON.stringify(saved, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  } catch (e) {
    await unlink(tmp).catch(() => undefined)
    throw new AppError('IO_ERROR', `写入脚本失败：${path}`, { cause: String(e) })
  }
  return toMeta(saved, false)
}

export async function deleteScript(scriptsDir: string, scriptId: string): Promise<void> {
  if (isBuiltinScriptId(scriptId)) {
    throw new AppError('INVALID_ARGUMENT', `内置脚本不可删除：${scriptId}`)
  }
  const path = fileOf(scriptsDir, scriptId)
  try {
    await unlink(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('SCRIPT_NOT_FOUND', `要删除的脚本不存在：${scriptId}`)
    }
    throw new AppError('IO_ERROR', `删除脚本失败：${path}`, { cause: String(e) })
  }
}

// ── 校验 ──────────────────────────────────────────────────────────────────

/** 带 fatal 标记的校验结果：fatal 的错误会阻止保存，普通 error 只是强提示。 */
export interface ScriptIssue extends ValidationIssue {
  /** true 表示「存下来也跑不了」，saveScript 会拒绝。 */
  fatal?: boolean
}

export interface ValidateOptions {
  /** 当前模板集里可用的模板 id。不传则跳过模板存在性检查。 */
  availableTemplateIds?: readonly string[]
  /** 面板当前的全局参考分辨率，用于提示脚本坐标空间不一致。 */
  settingsRefWidth?: number
  settingsRefHeight?: number
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues
    .map((i) => `· [${i.level === 'error' ? '错误' : '警告'}]${i.stepId ? ` ${i.stepId}:` : ''} ${i.message}`)
    .join('\n')
}

/**
 * 静态体检。只做「不跑起来也能查出来」的事，不碰磁盘、不连设备。
 */
export function validateScript(def: ScriptDef, opts: ValidateOptions = {}): ScriptIssue[] {
  const issues: ScriptIssue[] = []
  const push = (
    level: ValidationIssue['level'],
    stepId: string | null,
    message: string,
    fatal = false
  ): void => {
    issues.push({ level, stepId, message, fatal })
  }

  const templateIds = opts.availableTemplateIds ? new Set(opts.availableTemplateIds) : null
  const refW = def.refWidth
  const refH = def.refHeight

  if (def.steps.length === 0) push('warn', null, '脚本没有任何步骤，跑起来会立刻结束。')
  if (refW <= 0 || refH <= 0) push('error', null, '参考分辨率必须为正数。', true)
  if (
    opts.settingsRefWidth !== undefined &&
    opts.settingsRefHeight !== undefined &&
    (opts.settingsRefWidth !== refW || opts.settingsRefHeight !== refH)
  ) {
    push(
      'warn',
      null,
      `脚本坐标空间是 ${refW}x${refH}，与面板当前参考分辨率 ${opts.settingsRefWidth}x${opts.settingsRefHeight} 不一致；` +
        '执行器会自动等比换算，但模板是按面板参考分辨率归一化的，建议统一以免出现偏移。'
    )
  }

  // ── 第一遍：收集所有 label 与 step id ──
  const seenIds = new Set<string>()
  const allLabels = new Set<string>()
  const duplicatedLabels = new Set<string>()
  walk(def.steps, (step) => {
    if (seenIds.has(step.id)) {
      push('error', step.id, `步骤 id 重复：「${step.id}」。日志归档与 goto 依赖 id 唯一。`, true)
    }
    seenIds.add(step.id)
    if (step.kind === 'label') {
      if (allLabels.has(step.label)) duplicatedLabels.add(step.label)
      allLabels.add(step.label)
    }
  })
  for (const l of duplicatedLabels) {
    push('error', null, `label 重复定义：「${l}」，goto 无法确定跳到哪一个。`, true)
  }

  const checkRect = (stepId: string, what: string, r: Rect | undefined): void => {
    if (!r) return
    if (r.w <= 0 || r.h <= 0) {
      push('error', stepId, `${what} 的宽高必须为正数。`)
      return
    }
    if (r.x < 0 || r.y < 0 || r.x + r.w > refW || r.y + r.h > refH) {
      push(
        'error',
        stepId,
        `${what} 超出参考分辨率范围（${r.x},${r.y} ${r.w}x${r.h} 不在 ${refW}x${refH} 内）。`
      )
    }
  }
  const checkPoint = (stepId: string, what: string, x: number, y: number): void => {
    if (x < 0 || y < 0 || x > refW || y > refH) {
      push('warn', stepId, `${what} 坐标 (${x}, ${y}) 落在 ${refW}x${refH} 画面之外，点击会无效。`)
    }
  }
  const checkTemplate = (stepId: string, id: string): void => {
    if (templateIds && !templateIds.has(id)) {
      push('error', stepId, `引用了模板集里不存在的模板：「${id}」。`)
    }
  }
  const checkCondition = (stepId: string, cond: Condition, what: string): void => {
    switch (cond.kind) {
      case 'template':
        checkTemplate(stepId, cond.templateId)
        checkRect(stepId, `${what} 的 ROI`, cond.roi)
        break
      case 'anyTemplate':
        for (const id of cond.templateIds) checkTemplate(stepId, id)
        checkRect(stepId, `${what} 的 ROI`, cond.roi)
        break
      case 'and':
        for (const c of cond.all) checkCondition(stepId, c, what)
        break
      case 'or':
        for (const c of cond.any) checkCondition(stepId, c, what)
        break
      case 'not':
        checkCondition(stepId, cond.of, what)
        break
      default:
        break
    }
  }

  let usesTemplate = false

  // ── 第二遍：逐步检查 + goto 作用域 ──
  const visit = (steps: readonly ScriptStep[], scopes: ReadonlyArray<Set<string>>): void => {
    const local = new Set<string>()
    for (const s of steps) if (s.kind === 'label') local.add(s.label)
    const scope = [...scopes, local]
    const visible = (label: string): boolean => scope.some((s) => s.has(label))

    for (const step of steps) {
      if (step.when) {
        checkCondition(step.id, step.when, 'when 条件')
        if (conditionUsesTemplate(step.when)) usesTemplate = true
      }
      if (step.retry !== undefined && step.retry > 10) {
        push('warn', step.id, `retry=${step.retry} 偏大，失败时会长时间卡住这一步。`)
      }
      if (step.onFail?.kind === 'goto' && !visible(step.onFail.label)) {
        push(
          'error',
          step.id,
          `onFail 要跳到 label「${step.onFail.label}」，但它不在当前作用域里（只能跳到同级或外层的 label）。`,
          true
        )
      }

      switch (step.kind) {
        case 'tap':
          checkPoint(step.id, '点击', step.at.x, step.at.y)
          break
        case 'tapTemplate':
          usesTemplate = true
          checkTemplate(step.id, step.templateId)
          checkRect(step.id, 'ROI', step.roi)
          if ((step.waitMs ?? 0) > 0 && (step.pollMs ?? 500) <= 0) {
            push('error', step.id, 'pollMs 必须为正数。')
          }
          break
        case 'waitFor':
          checkCondition(step.id, step.cond, '等待条件')
          if (conditionUsesTemplate(step.cond)) usesTemplate = true
          if (step.waitMs <= 0) push('warn', step.id, 'waitMs=0，等于只看一帧就判定。')
          break
        case 'swipe':
          checkPoint(step.id, '滑动起点', step.from.x, step.from.y)
          checkPoint(step.id, '滑动终点', step.to.x, step.to.y)
          break
        case 'longPress':
          checkPoint(step.id, '长按', step.at.x, step.at.y)
          if (step.durationMs > 10_000) push('warn', step.id, '长按超过 10 秒，确认不是笔误？')
          break
        case 'text':
          if (step.text.length === 0) push('warn', step.id, '要输入的文本为空。')
          if (/[^\x00-\x7F]/.test(step.text)) {
            push(
              'warn',
              step.id,
              '文本含非 ASCII 字符，必须先在设备上安装并启用 ADBKeyboard，否则会被静默丢弃。'
            )
          }
          break
        case 'launchApp':
        case 'stopApp':
          if (!step.packageName && !def.packageName) {
            push('error', step.id, '既没给步骤 packageName，脚本也没设 packageName，无法确定要操作哪个应用。')
          }
          break
        case 'goto': {
          if (!visible(step.label)) {
            const elsewhere = allLabels.has(step.label)
            push(
              'error',
              step.id,
              elsewhere
                ? `goto 目标 label「${step.label}」在别的分支/循环体内，跳不过去（只能跳到同级或外层）。`
                : `goto 目标 label「${step.label}」不存在。`,
              true
            )
          }
          if (step.maxTimes !== undefined && step.maxTimes <= 0) {
            push('error', step.id, 'maxTimes 必须为正数。')
          }
          break
        }
        case 'if':
          checkCondition(step.id, step.cond, 'if 条件')
          if (conditionUsesTemplate(step.cond)) usesTemplate = true
          if (step.then.length === 0 && (step.else?.length ?? 0) === 0) {
            push('warn', step.id, 'if 的两个分支都是空的。')
          }
          visit(step.then, scope)
          if (step.else) visit(step.else, scope)
          break
        case 'loop':
          if (step.repeat === undefined && step.while === undefined) {
            push(
              'warn',
              step.id,
              `循环既没设 repeat 也没设 while，会一直跑到硬上限 ${step.maxIterations ?? 1000} 次。`
            )
          }
          if (step.while) {
            checkCondition(step.id, step.while, 'loop 的 while 条件')
            if (conditionUsesTemplate(step.while)) usesTemplate = true
          }
          if (step.steps.length === 0) push('warn', step.id, '循环体是空的。')
          visit(step.steps, scope)
          break
        default:
          break
      }
    }
  }
  visit(def.steps, [])

  if (usesTemplate && !def.templateSetId) {
    push('warn', null, '脚本用到了模板匹配，但没有绑定 templateSetId，运行时会找不到模板。')
  }
  if (def.loop && (def.loopIntervalMs ?? 0) < 1000) {
    push('warn', null, '循环模式下每轮间隔小于 1 秒，会让 adb 队列一直满负荷；建议不低于 3000ms。')
  }

  return issues
}

function conditionUsesTemplate(c: Condition): boolean {
  switch (c.kind) {
    case 'template':
    case 'anyTemplate':
      return true
    case 'and':
      return c.all.some(conditionUsesTemplate)
    case 'or':
      return c.any.some(conditionUsesTemplate)
    case 'not':
      return conditionUsesTemplate(c.of)
    default:
      return false
  }
}

/** 深度遍历所有步骤（含 if / loop 的子步骤）。 */
function walk(steps: readonly ScriptStep[], fn: (s: ScriptStep) => void): void {
  for (const s of steps) {
    fn(s)
    if (s.kind === 'if') {
      walk(s.then, fn)
      if (s.else) walk(s.else, fn)
    } else if (s.kind === 'loop') {
      walk(s.steps, fn)
    }
  }
}
