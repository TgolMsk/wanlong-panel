/**
 * 单个步骤的执行（动作原语）。
 *
 * 这里只管「怎么做一件事」，不管重试、失败处置、跳转 —— 那些是 engine.ts 的事。
 * 失败一律抛 AppError（中文 message），由引擎按 retry / onFail 处置。
 *
 * ★ 坐标：步骤里写的都是脚本坐标空间，交给 adb 之前必须过 ctx.toDevice()。
 * ★ 长按：必须走 DeviceIo.longPress（同一次 shell 里的 motionevent DOWN/sleep/UP），
 *   不能用 swipe 假装 —— swipe 全程阻塞，duration=500 实测占住队列 532ms。
 * ★ 中文输入：必须走 DeviceIo.inputText（ADBKeyboard 的 base64 broadcast），
 *   `input text` 对非 ASCII 是静默丢弃。
 */

import { AppError } from '@shared/errors'
import type { Point, Rect } from '@shared/vision'
import type { ScriptStep } from '@shared/script'
import { describeCondition, evalCondition } from './conditions'
import type { RunContext } from './context'

/** tapTemplate / waitFor 的默认轮询间隔。按 3fps 的判定节奏来，别设更快。 */
const DEFAULT_POLL_MS = 500
/** swipe 默认时长。 */
const DEFAULT_SWIPE_MS = 300

export async function execStep(ctx: RunContext, step: ScriptStep): Promise<void> {
  switch (step.kind) {
    case 'tap': {
      const d = await ctx.toDevice(step.at)
      await ctx.device.tap(ctx.serial, d.x, d.y)
      ctx.snapshot.stats.taps += 1
      afterInput(ctx)
      ctx.log('debug', `点击 (${step.at.x}, ${step.at.y}) → 设备 (${d.x}, ${d.y})`, undefined, {
        stepId: step.id
      })
      return
    }

    case 'tapTemplate': {
      const waitMs = step.waitMs ?? 0
      const pollMs = Math.max(50, step.pollMs ?? DEFAULT_POLL_MS)
      const deadline = Date.now() + waitMs
      let attempt = 0
      let last = ''

      for (;;) {
        if (attempt > 0) ctx.invalidateFrame()
        const m = await ctx.matchTemplate(step.templateId, step.roi, step.threshold)
        attempt += 1
        if (m.found) {
          const offset = step.offset ? ctx.pointToRef(step.offset) : { x: 0, y: 0 }
          const ref: Point = { x: m.centerX + offset.x, y: m.centerY + offset.y }
          const d = await ctx.refToDevicePoint(ref)
          await ctx.device.tap(ctx.serial, d.x, d.y)
          ctx.snapshot.stats.taps += 1
          afterInput(ctx)
          ctx.log(
            'info',
            `点中模板「${step.templateId}」(分数 ${m.score}) → 参考 (${ref.x}, ${ref.y}) / 设备 (${d.x}, ${d.y})`,
            { score: m.score, threshold: m.threshold, attempt },
            { stepId: step.id }
          )
          return
        }
        last = `最高分 ${m.score}，阈值 ${m.threshold}${m.reason ? `（${m.reason}）` : ''}`
        if (Date.now() >= deadline || ctx.aborted) break
        await ctx.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
        if (ctx.aborted) break
      }

      throw new AppError(
        'STEP_FAILED',
        `没找到模板「${step.templateId}」，等了 ${waitMs}ms 共 ${attempt} 次（${last}）。` +
          '排查方向：ROI 是不是框小了、模板是不是在别的分辨率下截的、阈值是不是太高。',
        { stepId: step.id, templateId: step.templateId, attempts: attempt }
      )
    }

    case 'waitFor': {
      const pollMs = Math.max(50, step.pollMs ?? DEFAULT_POLL_MS)
      const deadline = Date.now() + step.waitMs
      let attempt = 0
      let reason = ''

      for (;;) {
        if (attempt > 0) ctx.invalidateFrame()
        const r = await evalCondition(ctx, step.cond)
        attempt += 1
        if (r.ok) {
          ctx.log('debug', `条件成立：${describeCondition(step.cond)}（第 ${attempt} 次判定）`, undefined, {
            stepId: step.id
          })
          return
        }
        reason = r.reason ?? '条件不成立'
        if (Date.now() >= deadline || ctx.aborted) break
        await ctx.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
        if (ctx.aborted) break
      }

      throw new AppError(
        'STEP_FAILED',
        `等待超时（${step.waitMs}ms，判定 ${attempt} 次）：${describeCondition(step.cond)}。最后一次的原因是 ${reason}。`,
        { stepId: step.id, attempts: attempt }
      )
    }

    case 'swipe': {
      const from = await ctx.toDevice(step.from)
      const to = await ctx.toDevice(step.to)
      const ms = step.durationMs ?? DEFAULT_SWIPE_MS
      await ctx.device.swipe(ctx.serial, from.x, from.y, to.x, to.y, ms)
      afterInput(ctx)
      ctx.log(
        'debug',
        `滑动 (${step.from.x}, ${step.from.y}) → (${step.to.x}, ${step.to.y})，${ms}ms`,
        undefined,
        { stepId: step.id }
      )
      return
    }

    case 'longPress': {
      const d = await ctx.toDevice(step.at)
      await ctx.device.longPress(ctx.serial, d.x, d.y, step.durationMs)
      afterInput(ctx)
      ctx.log('debug', `长按 (${step.at.x}, ${step.at.y}) ${step.durationMs}ms`, undefined, {
        stepId: step.id
      })
      return
    }

    case 'text': {
      const text = ctx.interpolate(step.text)
      if (text.length === 0) {
        ctx.log('warn', '要输入的文本为空，跳过。', undefined, { stepId: step.id })
        return
      }
      await ctx.device.inputText(ctx.serial, text)
      afterInput(ctx)
      ctx.log('info', `输入文本（${text.length} 字）`, undefined, { stepId: step.id })
      return
    }

    case 'key': {
      await ctx.device.keyEvent(ctx.serial, step.key)
      afterInput(ctx)
      ctx.log('debug', `按键 ${step.key}`, undefined, { stepId: step.id })
      return
    }

    case 'sleep': {
      await ctx.sleep(step.ms)
      return
    }

    case 'launchApp': {
      const pkg = ctx.resolvePackage(step.packageName, step.id)
      const cold = step.cold ?? false
      await ctx.device.launchApp(ctx.serial, pkg, cold)
      afterInput(ctx)
      ctx.invalidateForeground()
      ctx.log('info', `${cold ? '冷启动' : '启动'}应用 ${pkg}`, undefined, { stepId: step.id })
      return
    }

    case 'stopApp': {
      const pkg = ctx.resolvePackage(step.packageName, step.id)
      await ctx.device.stopApp(ctx.serial, pkg)
      afterInput(ctx)
      ctx.invalidateForeground()
      ctx.log('info', `强制停止应用 ${pkg}`, undefined, { stepId: step.id })
      return
    }

    case 'screenshot': {
      const label = step.label ?? step.id
      const shot = await ctx.shot(label)
      ctx.log('info', `留痕截图：${label}`, undefined, { stepId: step.id, shot: shot ?? undefined })
      return
    }

    case 'log': {
      ctx.log(step.level, ctx.interpolate(step.message), undefined, {
        stepId: step.id,
        scope: 'script'
      })
      return
    }

    case 'label':
      // goto 的落点，本身是空操作。
      return

    case 'goto':
    case 'if':
    case 'loop':
      // 控制流由 engine.ts 直接处理，正常不会走到这里。
      // 真走到了说明引擎有 bug —— 记一条 error 但不要炸掉用户的执行。
      ctx.log('error', `控制流步骤「${step.kind}」被当成动作执行了，请报告这个问题。`, undefined, {
        stepId: step.id
      })
      return

    default: {
      const never: never = step
      throw new AppError('SCRIPT_INVALID', `未知的步骤类型：${JSON.stringify(never)}`)
    }
  }
}

/** 任何会改变画面的动作之后，上一帧就作废了；下次判定必须重新抓。 */
function afterInput(ctx: RunContext): void {
  ctx.invalidateFrame()
}

/** 给日志用的 ROI 描述。 */
export function describeRect(r: Rect | undefined): string {
  return r ? `(${r.x},${r.y} ${r.w}x${r.h})` : '全屏'
}
