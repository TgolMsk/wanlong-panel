/**
 * 模板自学习：把 AI 认出的关闭按钮从**点击前那一帧**裁成模板存进模板库。
 *
 * 走本工程正式的 @vision/store.saveTemplate：含 std<12 方差守卫、原子写、manifest 更新。
 * 方差不过（纯色块）就存不进去 —— 那正是不该学的东西，返回 null 由调用方记一条即可。
 *
 * id 约定：
 *   第一张叫 tpl_btn_close_popup（就是采集流程一直缺的那张）；
 *   之后的叫 tpl_btn_close_popup_ai2、_ai3 …（不同活动弹窗的 × 长得不一样，可以多学几张）。
 *   采集流程与调度器都按「id 等于或以 tpl_btn_close_popup_ 开头」的前缀扫描，新增变体不用改代码。
 *
 * 纯 Node，不 import electron。
 */

import type { AiBox } from '@shared/ai'
import { AppError } from '@shared/errors'
import type { RawFrame, Rect, TemplateDef } from '@shared/vision'
import { sharp } from '@vision/cv'
import { readSet, saveTemplate } from '@vision/index'

/** 采集流程用的关闭按钮模板 id（与 src/main/game/gather/templates.ts 的 TPL.btnClosePopup 一致）。 */
export const CLOSE_POPUP_TEMPLATE_ID = 'tpl_btn_close_popup'
/** 最多自学几张变体，再多就该人工看看是不是在学错东西了。 */
export const MAX_HARVESTED_VARIANTS = 8
/** 裁剪时在 AI 给的框外多留几个像素，免得把按钮边缘切掉。 */
const HARVEST_MARGIN_PX = 3
/** 模板尺寸范围（参考坐标）。太小没判别力，太大不是按钮。 */
const MIN_TEMPLATE_PX = 16
const MAX_TEMPLATE_PX = 420

export interface HarvestInput {
  /** 点击前的裸帧（按钮还在画面上）。 */
  raw: RawFrame
  /** 参考坐标下的按钮框。 */
  box: AiBox
  refWidth: number
  refHeight: number
  setId: string
  /** 写进模板备注：模型的理由、置信度、来源链路。 */
  note: string
}

export interface HarvestResult {
  id: string
  def: TemplateDef
}

/** 关闭按钮模板 id 是否属于本家族（原始那张或 AI 变体）。 */
export function isClosePopupTemplateId(id: string): boolean {
  return id === CLOSE_POPUP_TEMPLATE_ID || id.startsWith(`${CLOSE_POPUP_TEMPLATE_ID}_`)
}

/** 给新模板挑 id：原始 id 空着就用它，否则 _ai2 / _ai3 …；超过上限返回 null。 */
export function nextHarvestId(existingIds: string[]): string | null {
  if (!existingIds.includes(CLOSE_POPUP_TEMPLATE_ID)) return CLOSE_POPUP_TEMPLATE_ID
  const family = existingIds.filter(isClosePopupTemplateId)
  if (family.length >= MAX_HARVESTED_VARIANTS) return null
  for (let n = 2; n < MAX_HARVESTED_VARIANTS + 2; n++) {
    const id = `${CLOSE_POPUP_TEMPLATE_ID}_ai${n}`
    if (!existingIds.includes(id)) return id
  }
  return null
}

/**
 * 裁模板。成功返回 {id, def}；不该学 / 学不了（上限、方差太低、框不合理）返回 null 并把原因交给 onSkip。
 * 绝不抛异常。
 */
export async function harvestCloseButton(
  input: HarvestInput,
  onSkip: (reason: string) => void
): Promise<HarvestResult | null> {
  const { raw, box } = input
  if (box.w < MIN_TEMPLATE_PX || box.h < MIN_TEMPLATE_PX) {
    onSkip(`目标框太小（${box.w}x${box.h}），不够当模板。`)
    return null
  }
  if (box.w > MAX_TEMPLATE_PX || box.h > MAX_TEMPLATE_PX) {
    onSkip(`目标框太大（${box.w}x${box.h}），不像一个按钮，不学。`)
    return null
  }

  let existingIds: string[]
  try {
    existingIds = (await readSet(input.setId)).templates.map((t) => t.id)
  } catch (e) {
    onSkip(`读模板集失败：${AppError.from(e).message}`)
    return null
  }
  const id = nextHarvestId(existingIds)
  if (!id) {
    onSkip(
      `已经自学了 ${MAX_HARVESTED_VARIANTS} 张关闭按钮变体，不再新增。请到「模板」页看看是不是学错了东西。`
    )
    return null
  }

  // 参考坐标 -> 设备像素，外扩一圈后夹进画面。
  const kx = raw.width / input.refWidth
  const ky = raw.height / input.refHeight
  const left = clamp(Math.floor(box.x * kx) - HARVEST_MARGIN_PX, 0, raw.width - 2)
  const top = clamp(Math.floor(box.y * ky) - HARVEST_MARGIN_PX, 0, raw.height - 2)
  const right = clamp(Math.ceil((box.x + box.w) * kx) + HARVEST_MARGIN_PX, left + 2, raw.width)
  const bottom = clamp(Math.ceil((box.y + box.h) * ky) + HARVEST_MARGIN_PX, top + 2, raw.height)
  const crop: Rect = { x: left, y: top, w: right - left, h: bottom - top }

  // 整帧 PNG（store 按 crop 裁；给整帧是为了让 bounds / defaultRoi 落在正确的位置）。
  let framePng: Buffer
  try {
    framePng = await sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), {
      raw: { width: raw.width, height: raw.height, channels: 4 }
    })
      .png({ compressionLevel: 1 })
      .toBuffer()
  } catch (e) {
    onSkip(`截图编码失败：${AppError.from(e).message}`)
    return null
  }

  // 搜索区：按钮框外扩（不同弹窗的 × 位置略有差异，给足余量），夹进参考画面。
  const roiPad = Math.max(160, Math.round(Math.max(box.w, box.h) * 2))
  const defaultRoi: Rect = {
    x: clamp(box.x - roiPad, 0, input.refWidth - 1),
    y: clamp(box.y - roiPad, 0, input.refHeight - 1),
    w: 0,
    h: 0
  }
  defaultRoi.w = clamp(box.x + box.w + roiPad, defaultRoi.x + 1, input.refWidth) - defaultRoi.x
  defaultRoi.h = clamp(box.y + box.h + roiPad, defaultRoi.y + 1, input.refHeight) - defaultRoi.y

  const seq = id === CLOSE_POPUP_TEMPLATE_ID ? 1 : Number(id.slice(id.lastIndexOf('ai') + 2)) || 0
  try {
    const def = await saveTemplate(input.setId, {
      id,
      name: `弹窗关闭·AI 自学 #${seq}`,
      image: toArrayBuffer(framePng),
      authoredWidth: raw.width,
      authoredHeight: raw.height,
      crop,
      defaultRoi,
      tags: ['ai-harvest', 'popup-close'],
      note: input.note.slice(0, 300)
    })
    return { id, def }
  } catch (e) {
    const err = AppError.from(e)
    if (err.code === 'TEMPLATE_LOW_VARIANCE') {
      onSkip(`裁出来的区域方差太低（纯色 / 渐变），视觉层拒绝入库：${err.message}`)
    } else {
      onSkip(`保存模板失败：${err.message}`)
    }
    return null
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength)
  new Uint8Array(ab).set(buf)
  return ab
}
