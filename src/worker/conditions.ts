/**
 * 条件求值。
 *
 * 所有条件都在**同一帧**上判断：ctx.frame() 自带最小间隔限流，
 * 一个 and/or 里的十个模板条件只会抓一次图（这正是限流缓存存在的意义）。
 * 想强制看新画面，调用方先 ctx.invalidateFrame()。
 */

import type { Condition } from '@shared/script'
import type { MatchResult } from '@shared/vision'
import type { RunContext } from './context'

export interface CondResult {
  ok: boolean
  /** 模板类条件命中时带回匹配结果（anyTemplate 会带回**实际命中的那个**模板）。 */
  match?: MatchResult
  /** 中文说明，失败时写进日志，方便定位到底是哪一条不成立。 */
  reason?: string
}

export async function evalCondition(ctx: RunContext, cond: Condition): Promise<CondResult> {
  switch (cond.kind) {
    case 'always':
      return { ok: true }

    case 'never':
      return { ok: false, reason: '条件恒为 false' }

    case 'template': {
      const want = cond.present ?? true
      const m = await ctx.matchTemplate(cond.templateId, cond.roi, cond.threshold)
      const ok = m.found === want
      return {
        ok,
        match: m,
        reason: ok
          ? undefined
          : want
            ? `模板「${cond.templateId}」未出现（最高分 ${m.score}，阈值 ${m.threshold}${m.reason ? `，${m.reason}` : ''}）`
            : `模板「${cond.templateId}」仍然存在（分数 ${m.score}）`
      }
    }

    case 'anyTemplate': {
      const scores: string[] = []
      for (const id of cond.templateIds) {
        const m = await ctx.matchTemplate(id, cond.roi, cond.threshold)
        if (m.found) return { ok: true, match: m }
        scores.push(`${id}=${m.score}`)
      }
      return { ok: false, reason: `候选模板都没出现（${scores.join(', ')}）` }
    }

    case 'foreground': {
      const equals = cond.equals ?? true
      const pkg = await ctx.foregroundPackage()
      const same = pkg === cond.packageName
      const ok = same === equals
      return {
        ok,
        reason: ok
          ? undefined
          : equals
            ? `前台应用是「${pkg ?? '未知'}」，不是期望的「${cond.packageName}」`
            : `前台应用正是不该出现的「${cond.packageName}」`
      }
    }

    case 'and': {
      for (const c of cond.all) {
        const r = await evalCondition(ctx, c)
        if (!r.ok) return { ok: false, reason: r.reason ?? '子条件不成立' }
      }
      return { ok: true }
    }

    case 'or': {
      const reasons: string[] = []
      for (const c of cond.any) {
        const r = await evalCondition(ctx, c)
        if (r.ok) return r
        if (r.reason) reasons.push(r.reason)
      }
      return { ok: false, reason: `所有分支都不成立（${reasons.join('；')}）` }
    }

    case 'not': {
      const r = await evalCondition(ctx, cond.of)
      return { ok: !r.ok, reason: r.ok ? '被取反的条件成立' : undefined }
    }

    default: {
      // 穷尽性检查：DSL 加了新的 Condition 而这里忘了处理时，编译期就会报错。
      const never: never = cond
      return { ok: false, reason: `未知条件类型：${JSON.stringify(never)}` }
    }
  }
}

/** 条件的中文摘要，写日志用（别把整个 JSON 糊进日志里）。 */
export function describeCondition(cond: Condition): string {
  switch (cond.kind) {
    case 'always':
      return '总是'
    case 'never':
      return '从不'
    case 'template':
      return `${cond.present === false ? '不存在' : '出现'}模板「${cond.templateId}」`
    case 'anyTemplate':
      return `出现任一模板「${cond.templateIds.join('/')}」`
    case 'foreground':
      return `${cond.equals === false ? '前台不是' : '前台是'}「${cond.packageName}」`
    case 'and':
      return cond.all.map(describeCondition).join(' 且 ')
    case 'or':
      return cond.any.map(describeCondition).join(' 或 ')
    case 'not':
      return `非(${describeCondition(cond.of)})`
    default:
      return '未知条件'
  }
}
