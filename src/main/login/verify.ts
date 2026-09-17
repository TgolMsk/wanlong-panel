import { AppError } from '@shared/errors'
import { GAME_PACKAGE } from '@main/game/gather/geometry'
import { CITY_TEMPLATES, WORLD_MAP_TEMPLATES } from '@main/game/gather/navigation'
import { getGatherTemplates } from '@main/game/gatherRunner'
import { captureRaw, foregroundPackage } from '@main/adb/index'
import { matchIn, prepareFrame } from '@vision/index'
import type { RawFrame } from '@shared/vision'

/** 用户触发的一次本地主界面检查；不保存登录截图，也不调用 AI。 */
export async function verifyGameHome(
  serial: string,
  templatesDir: string,
  refW: number,
  refH: number
): Promise<boolean> {
  if ((await foregroundPackage(serial)) !== GAME_PACKAGE) return false
  return verifyGameFrame(await captureRaw(serial), templatesDir, refW, refH)
}

/** 同一识别逻辑也供保存的登录素材回放使用。 */
export async function verifyGameFrame(
  raw: RawFrame,
  templatesDir: string,
  refW: number,
  refH: number
): Promise<boolean> {
  const templates = await getGatherTemplates(templatesDir, () => undefined)
  const candidates = [...CITY_TEMPLATES, ...WORLD_MAP_TEMPLATES]
    .map((id) => templates.get(id))
    .filter((t) => !!t)
  if (!candidates.length)
    throw new AppError(
      'TEMPLATE_NOT_FOUND',
      '缺少城内／世界地图模板，请先在图像模板页配置对应阵营模板。'
    )
  const frame = await prepareFrame(raw, { refW, refH, shrink: 2 })
  for (const tpl of candidates) {
    if ((await matchIn(frame, tpl, { roi: tpl.defaultRoi })).found) return true
  }
  return false
}
