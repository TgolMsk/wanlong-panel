/**
 * 脚本通道 —— 转发给模块 d 的脚本存储。
 *
 * 这里只做一层「入口校验」：从渲染进程进来的 ScriptDef 是用户在编辑器里拼出来的，
 * 存盘前必须先过 zod（schemas.scriptDefSchema），否则一个写坏的 JSON 会一路带到
 * utilityProcess 里才炸，排查成本高得多。
 */

import { parseOrThrow, scriptDefSchema } from '@shared/schemas'
import { CH } from '@shared/ipc'
import { handle } from '@main/ipc'
import type { MainDeps } from './index'

export function registerScriptHandlers(deps: MainDeps): void {
  handle(CH.scriptList, () => deps.scripts.list())

  handle(CH.scriptGet, (scriptId) => deps.scripts.get(scriptId))

  handle(CH.scriptSave, (def) => {
    const checked = parseOrThrow(scriptDefSchema, def, '脚本', 'SCRIPT_INVALID')
    return deps.scripts.save(checked)
  })

  handle(CH.scriptDelete, (scriptId) => deps.scripts.remove(scriptId))

  /**
   * validate 与 save 的区别：validate 只报告问题、不落盘，而且**不抛错**——
   * 编辑器需要拿到完整的 issue 列表逐条显示，而不是在第一个错误上中断。
   */
  handle(CH.scriptValidate, (def) => {
    const parsed = scriptDefSchema.safeParse(def)
    if (!parsed.success) {
      return parsed.error.issues.map((i) => ({
        level: 'error' as const,
        stepId: stepIdFromPath(def, i.path),
        message: `${i.path.join('.') || '脚本'}：${i.message}`
      }))
    }
    return deps.scripts.validate(parsed.data)
  })
}

/**
 * 把 zod 的 path（例如 ['steps', 3, 'at', 'x']）映射回具体步骤 id，
 * 让面板能把红框画在对应的那一行上。映射不出来就归为脚本级问题（null）。
 */
function stepIdFromPath(def: unknown, path: readonly PropertyKey[]): string | null {
  if (path[0] !== 'steps' || typeof path[1] !== 'number') return null
  const steps = (def as { steps?: { id?: unknown }[] } | null)?.steps
  const id = steps?.[path[1]]?.id
  return typeof id === 'string' ? id : null
}
