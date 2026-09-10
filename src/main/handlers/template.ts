/**
 * 模板库通道 —— 转发给模块 c（视觉引擎自带的模板存储）。
 *
 * template:test 的设计取舍：
 *   抓一帧 -> 用**同一帧**做匹配 + 生成预览图 -> 把 MatchResult 原样回传，
 *   由面板在 canvas 上画标注框。主进程不做任何绘制合成（少一次 sharp composite，
 *   而且面板画的框能跟着缩放/拖拽走，比烧进图里好用）。
 *
 * 匹配与预览共用同一帧很关键：如果分两次截图，用户会看到「框画在了别的画面上」，
 * 以为是定位错了，实际只是两帧之间画面动了。
 */

import { PREVIEW_WIDTH } from '@shared/constants'
import { AppError } from '@shared/errors'
import { CH } from '@shared/ipc'
import { handle } from '@main/ipc'
import { invalidateGatherTemplates } from '@main/game/gatherRunner'
import { invalidateResourceUnitTemplates } from '@main/game/resources/templates'
import { invalidateTemplates as invalidateSchedulerTemplates } from '@main/scheduler/templates'
import { ensureDevice, rawFrameToShot } from './device'
import type { MainDeps } from './index'

function invalidateAllTemplateCaches(): void {
  invalidateGatherTemplates()
  invalidateSchedulerTemplates()
  invalidateResourceUnitTemplates()
}

export function registerTemplateHandlers(deps: MainDeps): void {
  handle(CH.templateSets, () => deps.vision.listSets())

  handle(CH.templateCreateSet, (name, packageName) => {
    if (!name.trim()) throw new AppError('INVALID_ARGUMENT', '模板集名称不能为空。')
    return deps.vision.createSet(name.trim(), packageName)
  })

  handle(CH.templateList, (setId) => deps.vision.listTemplates(setId))

  // ★ 面板里裁/删模板后，调度器、采集流程、资源统计三处的编译缓存都要作废，
  //   否则新模板要等重启才生效（tplkit 直接写盘的仍需重启或重新保存一次）。
  handle(CH.templateSave, async (setId, input) => {
    const def = await deps.vision.saveTemplate(setId, input)
    invalidateAllTemplateCaches()
    return def
  })

  handle(CH.templateDelete, async (setId, templateId) => {
    await deps.vision.deleteTemplate(setId, templateId)
    invalidateAllTemplateCaches()
  })

  handle(CH.templateImage, (setId, templateId) => deps.vision.templateImage(setId, templateId))

  // 「再抓一帧去底」预览：纯计算，不碰设备。帧由面板自己抓（device:capture）后原样传回来。
  handle(CH.templateAlphaPreview, (req) => {
    if (!req.diffFrames || req.diffFrames.length === 0) {
      throw new AppError('INVALID_ARGUMENT', '至少要再抓一帧（同一位置、不同背景）才能做差分去底。')
    }
    return deps.vision.alphaPreview(req)
  })

  handle(CH.templateTest, async (req) => {
    const dev = await ensureDevice(deps, req.instanceIndex)
    const t0 = Date.now()
    const frame = await deps.adb.capture(dev.serial)
    const captureMs = Date.now() - t0

    const match = await deps.vision.matchOnce(req.setId, req.templateId, frame, {
      roi: req.roi,
      threshold: req.threshold
    })
    const preview = await rawFrameToShot(frame, { width: PREVIEW_WIDTH }, captureMs)
    return { match, preview }
  })
}
