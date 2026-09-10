/**
 * 模板库的磁盘读写。
 *
 * 磁盘布局：
 *   <templatesDir>/<setId>/manifest.json     TemplateSet，用 templateSetSchema 校验
 *   <templatesDir>/<setId>/<templateId>.png  模板图片
 *
 * manifest 是唯一的真相来源；png 文件多出来的（孤儿文件）会被忽略，不会自动出现在列表里。
 *
 * ⚠️ 纯 Node：不 import electron。templatesDir 由主进程在启动时用 setTemplatesDir() 注入，
 *    utilityProcess 侧由 attach 消息里的 paths.templatesDir 注入。
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_SHRINK, REF_HEIGHT, REF_WIDTH, TEMPLATE_MANIFEST_FILE } from '@shared/constants'
import { makeId } from '@shared/defaults'
import { AppError } from '@shared/errors'
import { parseOrThrow, templateSetSchema } from '@shared/schemas'
import type {
  PreparedTemplate,
  Rect,
  TemplateDef,
  TemplateSaveInput,
  TemplateSet
} from '@shared/vision'
import { applyAlpha, buildDiffAlpha } from './alpha'
import { asBuffer, sharp } from './cv'
import { prepareTemplate } from './template'

let templatesDir: string | null = null

/** 由主进程 / worker 在启动时注入模板库根目录（绝对路径）。 */
export function setTemplatesDir(dir: string): void {
  if (!dir) throw new AppError('INVALID_ARGUMENT', '模板库目录不能为空')
  templatesDir = dir
}

/** 当前模板库根目录，未初始化则抛错（而不是悄悄用一个相对路径）。 */
export function getTemplatesDir(): string {
  if (!templatesDir) {
    throw new AppError('IO_ERROR', '模板库目录尚未初始化，请先调用 setTemplatesDir()')
  }
  return templatesDir
}

// ── 模板集 ────────────────────────────────────────────────────────────────

/** 列出全部模板集。单个 manifest 损坏时跳过并在控制台给出中文原因，不拖垮整个列表。 */
export async function listSets(): Promise<TemplateSet[]> {
  const root = getTemplatesDir()
  await mkdir(root, { recursive: true })

  const entries = await readdir(root, { withFileTypes: true })
  const sets: TemplateSet[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    try {
      sets.push(await readSet(e.name))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[vision/store] 跳过损坏的模板集「${e.name}」：${msg}`)
    }
  }
  sets.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  return sets
}

/** 新建一个空模板集。 */
export async function createSet(name: string, packageName?: string): Promise<TemplateSet> {
  const trimmed = name.trim()
  if (!trimmed) throw new AppError('INVALID_ARGUMENT', '模板集名称不能为空')

  const set: TemplateSet = {
    id: makeId('tset'),
    name: trimmed,
    packageName,
    refWidth: REF_WIDTH,
    refHeight: REF_HEIGHT,
    templates: [],
    updatedAt: Date.now()
  }
  await mkdir(setDir(set.id), { recursive: true })
  await writeManifest(set)
  return set
}

/** 读取并校验一个模板集的 manifest。 */
export async function readSet(setId: string): Promise<TemplateSet> {
  const file = join(setDir(setId), TEMPLATE_MANIFEST_FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if (isEnoent(e)) {
      throw new AppError(
        'NOT_FOUND',
        `模板集「${setId}」不存在（缺少 ${TEMPLATE_MANIFEST_FILE}）`,
        {
          setId,
          file
        }
      )
    }
    throw new AppError('IO_ERROR', `读取模板集「${setId}」失败：${errMsg(e)}`, { setId, file })
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new AppError('IO_ERROR', `模板集「${setId}」的 ${TEMPLATE_MANIFEST_FILE} 不是合法 JSON`, {
      setId,
      file
    })
  }
  return parseOrThrow(templateSetSchema, raw, `模板集「${setId}」`)
}

/** 删除整个模板集（连同目录下的图片）。 */
export async function deleteSet(setId: string): Promise<void> {
  await withSetLock(setId, async () => {
    await rm(setDir(setId), { recursive: true, force: true })
  })
}

// ── 模板 ──────────────────────────────────────────────────────────────────

export async function listTemplates(setId: string): Promise<TemplateDef[]> {
  return (await readSet(setId)).templates
}

/**
 * 保存（新增或覆盖）一个模板。
 *
 * 流程：按 crop 裁剪 -> 编码 PNG -> **先跑一遍 prepareTemplate 做方差守卫** -> 落盘 -> 更新 manifest。
 * 守卫不过就直接抛错、一个字节都不写盘，这样面板能立刻给出中文提示，
 * 而不是等脚本跑起来在错误的位置乱点才发现。
 */
export async function saveTemplate(setId: string, input: TemplateSaveInput): Promise<TemplateDef> {
  const name = input.name.trim()
  if (!name) throw new AppError('INVALID_ARGUMENT', '模板名称不能为空')
  if (!input.image || input.image.byteLength === 0) {
    throw new AppError('INVALID_ARGUMENT', `模板「${name}」没有图片数据`)
  }
  if (!(input.authoredWidth > 0) || !(input.authoredHeight > 0)) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `模板「${name}」缺少截取时的画面尺寸（authoredWidth/authoredHeight），无法做分辨率归一化`
    )
  }

  return withSetLock(setId, async () => {
    const set = await readSet(setId)
    const templateId = input.id?.trim() || makeId('tpl')
    assertSafeSegment(templateId, '模板 id')

    const source = asBuffer(new Uint8Array(input.image))

    // ① 裁剪 + 编码成 PNG（模板永远存 PNG：无损，避免 JPEG 块效应污染相关系数）。
    let png: Buffer
    try {
      let pipe = sharp(source)
      if (input.crop) {
        const meta = await sharp(source).metadata()
        const iw = meta.width ?? 0
        const ih = meta.height ?? 0
        const c = normalizeCrop(input.crop)
        if (c.x < 0 || c.y < 0 || c.x + c.w > iw || c.y + c.h > ih) {
          throw new AppError(
            'INVALID_ARGUMENT',
            `模板「${name}」的裁剪区 (${c.x},${c.y} ${c.w}x${c.h}) 超出了图片范围 ${iw}x${ih}`,
            { crop: c, imageWidth: iw, imageHeight: ih }
          )
        }
        pipe = pipe.extract({ left: c.x, top: c.y, width: c.w, height: c.h })
      }
      png = await pipe.png({ compressionLevel: 9 }).toBuffer()
      // 透明底：优先用调用方算好的单通道 α 图；否则用差分帧现算（面板「再抓一帧去底」走这条）。
      let alpha: Uint8Array | null =
        input.alpha && input.alpha.byteLength > 0 ? new Uint8Array(input.alpha) : null
      if (!alpha && input.diffFrames && input.diffFrames.length > 0) {
        if (!input.crop) {
          throw new AppError(
            'INVALID_ARGUMENT',
            `模板「${name}」要做差分去底必须给 crop（差分帧是整帧，得知道裁哪一块）`
          )
        }
        const r = await buildDiffAlpha(
          [new Uint8Array(input.image), ...input.diffFrames.map((b) => new Uint8Array(b))],
          normalizeCrop(input.crop),
          { tolerance: input.diffTolerance }
        )
        alpha = new Uint8Array(r.alphaPng)
      }
      // 把 α 并进第 4 通道（尺寸必须与裁剪后的模板一致）。
      if (alpha) png = await applyAlpha(new Uint8Array(png), alpha)
    } catch (e) {
      if (e instanceof AppError) throw e
      throw new AppError('TEMPLATE_DECODE_FAILED', `模板「${name}」裁剪/编码失败：${errMsg(e)}`, {
        setId,
        templateId
      })
    }

    // ② 归一化后的模板在参考分辨率里的位置与尺寸。
    const k = set.refWidth / input.authoredWidth
    const cropped = input.crop ? normalizeCrop(input.crop) : null
    const pngMeta = await sharp(png).metadata()
    const bounds: Rect = cropped
      ? {
          x: Math.round(cropped.x * k),
          y: Math.round(cropped.y * k),
          w: Math.max(1, Math.round(cropped.w * k)),
          h: Math.max(1, Math.round(cropped.h * k))
        }
      : {
          x: 0,
          y: 0,
          w: Math.max(1, Math.round((pngMeta.width ?? 1) * k)),
          h: Math.max(1, Math.round((pngMeta.height ?? 1) * k))
        }

    // 没显式给 ROI 就按 bounds 外扩一圈自动推一个：实测 ROI 能带来最多 43 倍加速，
    // 默认给一个宽松的窗口比让每个模板都全屏搜合算得多。外扩量取「自身尺寸的 60%」与 80px 的较大者。
    const defaultRoi = input.defaultRoi ?? deriveRoi(bounds, set.refWidth, set.refHeight)

    // ③ ★ 方差守卫：不过就抛错，不写盘。
    const prepared = await prepareTemplate(new Uint8Array(png), {
      id: templateId,
      name,
      refW: set.refWidth,
      authoredWidth: input.authoredWidth,
      shrink: DEFAULT_SHRINK,
      threshold: input.threshold,
      defaultRoi
    })

    // ④ 落盘。
    const file = `${templateId}.png`
    await mkdir(setDir(setId), { recursive: true })
    await writeFile(join(setDir(setId), file), png)

    const now = Date.now()
    const existing = set.templates.find((t) => t.id === templateId)
    const def: TemplateDef = {
      id: templateId,
      name,
      file,
      authoredWidth: input.authoredWidth,
      authoredHeight: input.authoredHeight,
      bounds,
      defaultRoi,
      threshold: input.threshold,
      std: Math.round(prepared.std * 10) / 10,
      ...(prepared.maskCoverage !== undefined ? { maskCoverage: prepared.maskCoverage } : {}),
      tags: input.tags,
      note: input.note,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }

    set.templates = existing
      ? set.templates.map((t) => (t.id === templateId ? def : t))
      : [...set.templates, def]
    set.updatedAt = now
    await writeManifest(set)
    return def
  })
}

export async function deleteTemplate(setId: string, templateId: string): Promise<void> {
  await withSetLock(setId, async () => {
    const set = await readSet(setId)
    const target = set.templates.find((t) => t.id === templateId)
    if (!target) {
      throw new AppError(
        'TEMPLATE_NOT_FOUND',
        `模板集「${set.name}」里没有 id 为 ${templateId} 的模板`,
        {
          setId,
          templateId
        }
      )
    }
    set.templates = set.templates.filter((t) => t.id !== templateId)
    set.updatedAt = Date.now()
    await writeManifest(set)
    // 图片删失败（例如被别的进程占用）不影响 manifest 已经生效，只记一条警告。
    try {
      await rm(join(setDir(setId), target.file), { force: true })
    } catch (e) {
      console.warn(`[vision/store] 模板图片删除失败 ${target.file}：${errMsg(e)}`)
    }
  })
}

/** 读取模板原图字节（面板预览、模板测试都要用）。 */
export async function readTemplateImage(setId: string, templateId: string): Promise<Uint8Array> {
  const set = await readSet(setId)
  const def = set.templates.find((t) => t.id === templateId)
  if (!def) {
    throw new AppError(
      'TEMPLATE_NOT_FOUND',
      `模板集「${set.name}」里没有 id 为 ${templateId} 的模板`,
      {
        setId,
        templateId
      }
    )
  }
  const file = join(setDir(setId), def.file)
  try {
    const buf = await readFile(file)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } catch (e) {
    if (isEnoent(e)) {
      throw new AppError(
        'TEMPLATE_NOT_FOUND',
        `模板「${def.name}」的图片文件丢失：${def.file}（manifest 里还有记录，建议重新截取）`,
        { setId, templateId, file }
      )
    }
    throw new AppError('IO_ERROR', `读取模板「${def.name}」图片失败：${errMsg(e)}`, { file })
  }
}

/**
 * 把整个模板集编译成可直接匹配的 PreparedTemplate，worker 启动时调一次。
 *
 * 单个模板编译失败（图片丢失 / 手改过 manifest 导致方差过低）时**跳过并告警**，
 * 而不是让整个脚本起不来 —— 真正用到那个模板时，detect() 会给出
 * 「模板不在已加载的模板集里」的明确 reason。
 */
export async function loadPrepared(
  setId: string,
  opts: { refW: number; shrink: number }
): Promise<Map<string, PreparedTemplate>> {
  const set = await readSet(setId)
  const map = new Map<string, PreparedTemplate>()
  for (const def of set.templates) {
    try {
      const png = await readTemplateImage(setId, def.id)
      const prepared = await prepareTemplate(png, {
        id: def.id,
        name: def.name,
        refW: opts.refW,
        authoredWidth: def.authoredWidth,
        shrink: opts.shrink,
        threshold: def.threshold,
        defaultRoi: def.defaultRoi
      })
      map.set(def.id, prepared)
    } catch (e) {
      console.warn(`[vision/store] 模板「${def.name}」(${def.id}) 编译失败，已跳过：${errMsg(e)}`)
    }
  }
  return map
}

// ── 内部 ──────────────────────────────────────────────────────────────────

/** 同一个模板集的写操作串行化，避免两次 saveTemplate 并发导致 manifest 互相覆盖。 */
const locks = new Map<string, Promise<unknown>>()

function withSetLock<T>(setId: string, fn: () => Promise<T>): Promise<T> {
  assertSafeSegment(setId, '模板集 id')
  const prev = locks.get(setId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  // 无论成败都要把锁链接下去，否则一次失败会让该模板集永久卡住。
  locks.set(
    setId,
    next.catch(() => undefined)
  )
  return next
}

function setDir(setId: string): string {
  assertSafeSegment(setId, '模板集 id')
  return join(getTemplatesDir(), setId)
}

/** manifest 原子写：先写临时文件再 rename，避免写一半断电留下半个 JSON。 */
async function writeManifest(set: TemplateSet): Promise<void> {
  const dir = setDir(set.id)
  const target = join(dir, TEMPLATE_MANIFEST_FILE)
  const tmp = `${target}.tmp`
  await mkdir(dir, { recursive: true })
  await writeFile(tmp, JSON.stringify(set, null, 2), 'utf8')
  await rename(tmp, target)
}

/** 路径段安全校验：id 会被拼进文件路径，必须挡住 `..` 和分隔符。 */
function assertSafeSegment(seg: string, what: string): void {
  if (!seg || !/^[A-Za-z0-9._-]+$/.test(seg) || seg === '.' || seg === '..') {
    throw new AppError(
      'INVALID_ARGUMENT',
      `${what}「${seg}」不合法：只允许字母、数字、点、下划线和短横线`,
      {
        segment: seg
      }
    )
  }
}

function normalizeCrop(c: Rect): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.round(c.x),
    y: Math.round(c.y),
    w: Math.max(1, Math.round(c.w)),
    h: Math.max(1, Math.round(c.h))
  }
}

/** 由模板位置外扩出一个宽松的默认搜索区（参考分辨率空间）。 */
function deriveRoi(b: Rect, refW: number, refH: number): Rect {
  const padX = Math.max(80, Math.round(b.w * 0.6))
  const padY = Math.max(80, Math.round(b.h * 0.6))
  const x0 = Math.max(0, b.x - padX)
  const y0 = Math.max(0, b.y - padY)
  const x1 = Math.min(refW, b.x + b.w + padX)
  const y1 = Math.min(refH, b.y + b.h + padY)
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

function isEnoent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ENOENT'
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
