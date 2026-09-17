import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@shared/errors'
import type { PreparedTemplate, RawFrame } from '@shared/vision'
import { matchIn, prepareFrame, prepareTemplate } from '@vision/index'
import { GAME_PACKAGE } from './gather/geometry'

const W = 2560
const H = 1440
const MAX_WAIT_MS = 15 * 60_000
const POLL_MS = 3000

export interface UpdateContext {
  raw: RawFrame
  refWidth: number
  refHeight: number
  io: {
    capture(): Promise<RawFrame>
    foregroundPackage(): Promise<string | null>
    tap(x: number, y: number): Promise<void>
  }
  check?: () => void
  recognize(raw: RawFrame): Promise<boolean>
  /** 更新后出现未知公告时，交给 AI 评估操作风险并处理。 */
  recoverOverlay?: (raw: RawFrame) => Promise<boolean>
  log(message: string): void
}

/** 仅处理已校准的资源下载弹窗；不开放通用“确定”点击。 */
export class GameUpdateRecovery {
  private templates?: Promise<
    [PreparedTemplate, PreparedTemplate, PreparedTemplate, PreparedTemplate]
  >

  constructor(
    private readonly resourcesDir: () => string,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly maxWaitMs = MAX_WAIT_MS
  ) {}

  private load(): Promise<
    [PreparedTemplate, PreparedTemplate, PreparedTemplate, PreparedTemplate]
  > {
    if (!this.templates) {
      this.templates = Promise.all(
        ['message', 'confirm', 'downloading', 'checking'].map(async (name) =>
          prepareTemplate(await readFile(join(this.resourcesDir(), 'game-update', `${name}.png`)), {
            id: `game-update-${name}`,
            name: `游戏资源更新：${name}`,
            refW: W,
            authoredWidth: W,
            shrink: 2,
            threshold: name === 'confirm' ? 0.96 : 0.94
          })
        )
      ) as Promise<[PreparedTemplate, PreparedTemplate, PreparedTemplate, PreparedTemplate]>
      this.templates.catch(() => {
        this.templates = undefined
      })
    }
    return this.templates
  }

  async detect(raw: RawFrame): Promise<{ x: number; y: number } | null> {
    if (Math.abs(raw.width / raw.height - W / H) > 0.03) return null
    const [message, confirm] = await this.load()
    const frame = await prepareFrame(raw, { refW: W, refH: H, shrink: 2 })
    const text = await matchIn(frame, message, { roi: { x: 700, y: 480, w: 1200, h: 250 } })
    if (!text.found) return null
    const button = await matchIn(frame, confirm, { roi: { x: 1150, y: 720, w: 750, h: 400 } })
    if (!button.found) return null
    // 两个控件必须属于同一个、相对位置一致的弹窗。
    if (
      Math.abs(button.centerX - text.centerX - 266) > 20 ||
      Math.abs(button.centerY - text.centerY - 308.5) > 20
    )
      return null
    return { x: button.centerX, y: button.centerY }
  }

  async handle(ctx: UpdateContext): Promise<boolean> {
    ctx.check?.()
    if (!(await this.detect(ctx.raw)) && !(await this.progress(ctx.raw, false))) return false
    const assertForeground = async (): Promise<void> => {
      ctx.check?.()
      if ((await ctx.io.foregroundPackage()) !== GAME_PACKAGE) {
        throw new AppError(
          'GAME_UPDATE_REQUIRED',
          '游戏更新期间前台应用发生变化，已停止操作，请回到游戏后恢复。'
        )
      }
      ctx.check?.()
    }
    await assertForeground()
    // 截图和点击之间可能被人工切屏：点击前必须重新识别，不能沿用旧坐标。
    const fresh = await ctx.io.capture()
    const target = await this.detect(fresh)
    ctx.check?.()
    if (!target && !(await this.progress(fresh, true))) return true
    await assertForeground()
    if (target) {
      ctx.log('识别到游戏资源更新，确认下载；等待更新完成，期间不执行采集或返回键。')
      await ctx.io.tap((target.x * ctx.refWidth) / W, (target.y * ctx.refHeight) / H)
    } else {
      ctx.log('游戏资源正在下载，接续等待更新完成，不重复点击。')
    }

    return this.wait(ctx)
  }

  /** AI 已确认其它布局的低风险更新后，复用下载等待，不再次点击。 */
  async wait(ctx: UpdateContext): Promise<boolean> {
    const assertForeground = async (): Promise<void> => {
      ctx.check?.()
      if ((await ctx.io.foregroundPackage()) !== GAME_PACKAGE) {
        throw new AppError('GAME_UPDATE_REQUIRED', '更新期间前台发生变化，请回到游戏后恢复。')
      }
      ctx.check?.()
    }
    const started = this.now()
    let nextOverlayAt = started + 30_000
    let nextLogAt = started + 30_000
    while (this.now() - started < this.maxWaitMs) {
      // 小步等待使关闭自动/停止任务立即生效；已经开始的游戏下载由游戏继续。
      const until = Math.min(this.now() + POLL_MS, started + this.maxWaitMs)
      while (this.now() < until) {
        ctx.check?.()
        await this.sleep(Math.min(100, until - this.now()))
      }
      await assertForeground()
      const raw = await ctx.io.capture()
      ctx.check?.()
      if (await ctx.recognize(raw)) {
        ctx.log('游戏更新已结束，已识别到游戏界面，继续原任务。')
        return true
      }
      if (await this.detect(raw)) {
        if (this.now() - started >= 20_000) {
          throw new AppError(
            'GAME_UPDATE_REQUIRED',
            '已点击更新确认，但更新提示持续未消失。请检查游戏下载或网络状态后恢复；不会重复点击。'
          )
        }
        continue
      }
      if (this.now() >= nextOverlayAt && ctx.recoverOverlay && !(await this.progress(raw, true))) {
        nextOverlayAt = this.now() + 30_000
        if (await ctx.recoverOverlay(raw)) {
          ctx.check?.()
          // 公告被关闭仍需重新检查，不能把一次点击等同于更新完成。
          if (await ctx.recognize(await ctx.io.capture())) {
            ctx.log('更新后的公告已处理，已回到游戏界面，继续原任务。')
            return true
          }
        }
      }
      if (this.now() >= nextLogAt) {
        nextLogAt = this.now() + 30_000
        ctx.log(`等待游戏更新/加载完成（已等待 ${Math.round((this.now() - started) / 1000)} 秒）。`)
      }
    }
    throw new AppError(
      'GAME_UPDATE_REQUIRED',
      `等待游戏更新/加载超过 ${Math.round(this.maxWaitMs / 60_000)} 分钟，尚未进入已知界面。请检查下载进度或处理当前提示后恢复。`
    )
  }

  /** 下载数字和百分比不断变化，只匹配稳定的进度文案。 */
  private async progress(raw: RawFrame, includeChecking: boolean): Promise<boolean> {
    if (Math.abs(raw.width / raw.height - W / H) > 0.03) return false
    const [, , downloading, checking] = await this.load()
    const frame = await prepareFrame(raw, { refW: W, refH: H, shrink: 2 })
    const roi = { x: 700, y: 1150, w: 1100, h: 140 }
    if ((await matchIn(frame, downloading, { roi })).found) return true
    return includeChecking && (await matchIn(frame, checking, { roi })).found
  }
}
