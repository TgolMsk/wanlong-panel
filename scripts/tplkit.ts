/**
 * 模板裁剪工具箱（tplkit）—— 给「万龙觉醒」裁模板用的一次性命令行工具。
 *
 * 跑法：
 *   npm run tplkit -- <子命令> [参数...]
 *
 * 它只做四类事，全部走本工程正式的视觉层 / 设备层 API，绝不自己 mkdir 乱放：
 *   · cap      抓一帧真实截图，落成 PNG（原始 2560x1440）+ 一张缩放 JPG 供人眼查看
 *   · view     从已存的帧里裁一块并放大若干倍，供人眼确认框选是否贴合
 *   · analyze  给一块区域算 std / 均值 / 前景紧致外接框 / 列投影（用来精确定位字形边界）
 *   · save     按 JSON 作业批量 saveTemplate（走 @vision/store，含 std<12 守卫）
 *   · verify   批量自检：正样本同帧重匹配 + 负样本换帧/换区必须落空
 *   · probe    取某点 NxN 邻域的 RGB 均值（开关态标定用）
 *   · alpha    多帧差分去底预览：给裁剪区 + 两三帧不同背景的整帧，输出洋红底预览图与不透明占比
 *              （正式裁模板时在 save 作业里写 diffFrames / diffTolerance 即可，见 SaveJob）
 *
 * 坐标口径：本工程参考分辨率 2560x1440 恰好等于该实例 screencap 的真实分辨率，
 * 所以这里的所有 x/y/w/h 既是参考坐标也是设备像素，不需要换算。
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { REF_HEIGHT, REF_WIDTH } from '@shared/constants'
import type { Rect } from '@shared/vision'

import { attach, captureRaw, initAdb } from '@main/adb/index'
import { bootstrapEmulatorForScripts, listInstances } from '@main/mumu/index'
import {
  buildDiffAlpha,
  createSet,
  listSets,
  loadPrepared,
  matchIn,
  prepareFrame,
  saveTemplate,
  setTemplatesDir,
  stdDev,
  deleteTemplate,
  listTemplates
} from '@vision/index'
import { sharp } from '@vision/cv'

const PROJECT_ROOT = process.cwd()
const DATA_DIR = join(PROJECT_ROOT, '.wl-data')
const TEMPLATES_DIR = join(DATA_DIR, 'templates')
const SET_NAME = '万龙觉醒'
const PACKAGE = 'com.lilithgames.samo.android.cn'
const SHRINK = Number(process.env.TPLKIT_SHRINK ?? 2)

const argv = process.argv.slice(2)
const cmd = argv[0]

function num(v: string | undefined, dflt?: number): number {
  if (v === undefined) {
    if (dflt === undefined) throw new Error(`缺少数字参数`)
    return dflt
  }
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`不是合法数字：${v}`)
  return n
}

async function ensureDir(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
}

/** 抓一帧并存 PNG；同时存一张 1280 宽的 JPG 供人眼查看。 */
async function cmdCap(name: string): Promise<void> {
  // 驱动与 adb 路径按平台解析；实例用 WL_INSTANCE=<index> 指定，不指定取第一个 running 的。
  const env = await bootstrapEmulatorForScripts()
  await initAdb({ adbPath: env.adbPath })
  const wanted = (process.env['WL_INSTANCE'] ?? '').trim()
  const instances = await listInstances()
  const target = wanted
    ? instances.find((i) => i.index === Number(wanted))
    : instances.find((i) => i.state === 'running' && i.adbPort !== null)
  if (!target || target.adbPort === null) {
    throw new Error(
      `没有可用的 running 实例${wanted ? `（WL_INSTANCE=${wanted}）` : ''}，无法抓帧。`
    )
  }
  const dev = await attach(target.index, target.adbPort)
  const raw = await captureRaw(dev.serial, { throttle: false })
  const bytes = raw.width * raw.height * 4
  const png = await sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, bytes), {
    raw: { width: raw.width, height: raw.height, channels: 4 }
  })
    .png({ compressionLevel: 6 })
    .toBuffer()
  const out = join(scratch(), 'frames', `${name}.png`)
  await ensureDir(out)
  await writeFile(out, png)
  const view = join(scratch(), 'view', `${name}.jpg`)
  await ensureDir(view)
  await sharp(png).resize({ width: 1280 }).jpeg({ quality: 80 }).toFile(view)
  console.log(JSON.stringify({ ok: true, out, view, w: raw.width, h: raw.height }))
}

function scratch(): string {
  return process.env.TPLKIT_SCRATCH ?? join(PROJECT_ROOT, '.tplkit')
}

/** 裁一块并放大，供人眼确认。 */
async function cmdView(
  framePng: string,
  x: number,
  y: number,
  w: number,
  h: number,
  out: string,
  zoom: number
): Promise<void> {
  await ensureDir(out)
  await sharp(framePng)
    .extract({ left: x, top: y, width: w, height: h })
    .resize({ width: Math.round(w * zoom), kernel: 'nearest' })
    .png()
    .toFile(out)
  console.log(JSON.stringify({ ok: true, out, zoom }))
}

/** 灰度化一块区域，返回 {w,h,gray}。 */
async function grayRegion(
  framePng: string,
  r: Rect
): Promise<{ w: number; h: number; gray: Uint8Array }> {
  const buf = await sharp(framePng)
    .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
    .greyscale()
    .raw()
    .toBuffer()
  return { w: r.w, h: r.h, gray: new Uint8Array(buf) }
}

/**
 * 区域分析：std（与 prepareTemplate 的守卫同口径，注意守卫是在 shrink 后的灰度上算）、
 * 均值、前景紧致外接框、列投影。
 */
async function cmdAnalyze(
  framePng: string,
  x: number,
  y: number,
  w: number,
  h: number,
  polarity?: string,
  thr?: number
): Promise<void> {
  const g = await grayRegion(framePng, { x, y, w, h })
  const full = stdDev(g.gray)
  let sum = 0
  for (const v of g.gray) sum += v
  const mean = sum / g.gray.length

  // 背景取四条边的中位数，前景 = 与背景差 > 40 的像素
  const edge: number[] = []
  for (let i = 0; i < w; i++) {
    edge.push(g.gray[i]!, g.gray[(h - 1) * w + i]!)
  }
  for (let j = 0; j < h; j++) {
    edge.push(g.gray[j * w]!, g.gray[j * w + w - 1]!)
  }
  edge.sort((a, b) => a - b)
  const bg = edge[Math.floor(edge.length / 2)]!

  const THR = thr ?? 45
  let minX = w
  let maxX = -1
  let minY = h
  let maxY = -1
  const colCount = new Array<number>(w).fill(0)
  const rowCount = new Array<number>(h).fill(0)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = g.gray[j * w + i]!
      const fg =
        polarity === 'light'
          ? v - bg > THR
          : polarity === 'dark'
            ? bg - v > THR
            : Math.abs(v - bg) > THR
      if (fg) {
        colCount[i]!++
        rowCount[j]!++
        if (i < minX) minX = i
        if (i > maxX) maxX = i
        if (j < minY) minY = j
        if (j > maxY) maxY = j
      }
    }
  }

  // 列投影分段（连续非零列为一段）—— 用来切字形
  const segs: Array<{ x0: number; x1: number }> = []
  let cur: { x0: number; x1: number } | null = null
  for (let i = 0; i < w; i++) {
    if (colCount[i]! > 0) {
      if (!cur) cur = { x0: i, x1: i }
      else cur.x1 = i
    } else if (cur) {
      segs.push(cur)
      cur = null
    }
  }
  if (cur) segs.push(cur)

  // 用 shrink=2 灰度再算一遍 std（这才是守卫真正用的口径）
  const sw = Math.max(1, Math.floor(w / SHRINK))
  const sh = Math.max(1, Math.floor(h / SHRINK))
  const small = new Uint8Array(sw * sh)
  for (let j = 0; j < sh; j++) {
    for (let i = 0; i < sw; i++) {
      small[j * sw + i] = g.gray[j * SHRINK * w + i * SHRINK]!
    }
  }
  const stdShrunk = stdDev(small)

  console.log(
    JSON.stringify(
      {
        rect: { x, y, w, h },
        mean: Number(mean.toFixed(1)),
        bg,
        stdFull: Number(full.toFixed(1)),
        stdShrink2: Number(stdShrunk.toFixed(1)),
        tight:
          maxX < 0 ? null : { x: x + minX, y: y + minY, w: maxX - minX + 1, h: maxY - minY + 1 },
        colSegs: segs.map((s) => ({ x: x + s.x0, w: s.x1 - s.x0 + 1 })),
        rowFirstLast: maxY < 0 ? null : [y + minY, y + maxY]
      },
      null,
      1
    )
  )
}

/** 取某点 NxN 邻域 RGB 均值。 */
async function cmdProbe(framePng: string, x: number, y: number, n: number): Promise<void> {
  const half = Math.floor(n / 2)
  const buf = await sharp(framePng)
    .extract({ left: x - half, top: y - half, width: n, height: n })
    .raw()
    .toBuffer()
  const ch = buf.length / (n * n)
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < n * n; i++) {
    r += buf[i * ch]!
    g += buf[i * ch + 1]!
    b += buf[i * ch + 2]!
  }
  const k = n * n
  console.log(
    JSON.stringify({
      at: [x, y],
      n,
      rgb: [Math.round(r / k), Math.round(g / k), Math.round(b / k)]
    })
  )
}

interface SaveJob {
  id: string
  name: string
  frame: string
  crop: Rect
  defaultRoi?: Rect
  threshold?: number
  tags?: string[]
  note?: string
  /**
   * 透明底：给几张「同一控件、同一位置、不同背景」的整帧，与 frame 做多帧差分去底，
   * 会变的像素抠成透明不参与匹配。圆环里透地形的按钮、压在地图上的半透明控件都该这么裁。
   */
  diffFrames?: string[]
  /** 差分容差（RGB 任一通道差值 ≤ 容差视为没变），默认 DEFAULT_ALPHA_DIFF_TOLERANCE。 */
  diffTolerance?: number
}

async function resolveSet(): Promise<string> {
  setTemplatesDir(TEMPLATES_DIR)
  const sets = await listSets()
  const found = sets.find((s) => s.name === SET_NAME)
  if (found) return found.id
  const made = await createSet(SET_NAME, PACKAGE)
  console.error(`[tplkit] 新建模板集 ${made.name}（${made.id}）`)
  return made.id
}

const CHAR_NAME: Record<string, string> = {
  ':': 'colon',
  ',': 'comma',
  '/': 'slash',
  '.': 'dot',
  '%': 'pct'
}

/** 字符 -> 模板 id 后缀（数字直接用 d0..d9）。 */
function charSuffix(c: string): string {
  if (c >= '0' && c <= '9') return `d${c}`
  const n = CHAR_NAME[c]
  if (!n) throw new Error(`未支持的字符：${c}`)
  return n
}

/**
 * 字形切分：在给定 ROI 内按列投影把一串等宽数字切成单字，
 * 统一使用整串的行范围（保证同一套内所有字形等高），逐字加 pad 像素同色背景。
 * 输出一份 SaveJob[]（可直接喂给 tplkit save）。
 *
 * 用法：glyphs <frame> <x> <y> <w> <h> <polarity:dark|light> <thr> <chars> <prefix> <out.json> [pad] [minSegW]
 */
async function cmdGlyphs(
  framePng: string,
  x: number,
  y: number,
  w: number,
  h: number,
  polarity: string,
  thr: number,
  chars: string,
  prefix: string,
  outFile: string,
  pad: number,
  minSegW: number
): Promise<void> {
  const g = await grayRegion(framePng, { x, y, w, h })
  const edge: number[] = []
  for (let i = 0; i < w; i++) edge.push(g.gray[i]!, g.gray[(h - 1) * w + i]!)
  for (let j = 0; j < h; j++) edge.push(g.gray[j * w]!, g.gray[j * w + w - 1]!)
  edge.sort((a, b) => a - b)
  const bg = edge[Math.floor(edge.length / 2)]!
  const isFg = (v: number): boolean =>
    polarity === 'light'
      ? v - bg > thr
      : polarity === 'dark'
        ? bg - v > thr
        : Math.abs(v - bg) > thr

  const colCount = new Array<number>(w).fill(0)
  let minY = h
  let maxY = -1
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (isFg(g.gray[j * w + i]!)) {
        colCount[i]!++
        if (j < minY) minY = j
        if (j > maxY) maxY = j
      }
    }
  }
  if (maxY < 0) throw new Error('ROI 内没有前景像素，检查极性/阈值/坐标')

  const segs: Array<{ x0: number; x1: number }> = []
  let cur: { x0: number; x1: number } | null = null
  for (let i = 0; i < w; i++) {
    if (colCount[i]! > 0) {
      if (!cur) cur = { x0: i, x1: i }
      else cur.x1 = i
    } else if (cur) {
      if (cur.x1 - cur.x0 + 1 >= minSegW) segs.push(cur)
      cur = null
    }
  }
  if (cur && cur.x1 - cur.x0 + 1 >= minSegW) segs.push(cur)

  const list = [...chars]
  if (segs.length !== list.length) {
    console.error(
      JSON.stringify({
        warn: '切出的字形段数与给定字符数不符，请调整 ROI/阈值/minSegW',
        segs: segs.map((s) => ({ x: x + s.x0, w: s.x1 - s.x0 + 1 })),
        chars: list.length,
        rows: [y + minY, y + maxY]
      })
    )
    process.exitCode = 1
    return
  }

  const top = y + minY - pad
  const height = maxY - minY + 1 + pad * 2
  const jobs: SaveJob[] = []
  const seen = new Set<string>()
  for (let k = 0; k < segs.length; k++) {
    const c = list[k]!
    const suffix = charSuffix(c)
    if (seen.has(suffix)) continue
    seen.add(suffix)
    const s = segs[k]!
    const left = x + s.x0 - pad
    const width = s.x1 - s.x0 + 1 + pad * 2
    jobs.push({
      id: `${prefix}_${suffix}`,
      name: `${prefix} 字形 ${c}`,
      frame: framePng,
      crop: { x: left, y: top, w: width, h: height },
      threshold: 0.78,
      tags: ['digit', prefix],
      note: `从 ${framePng.split('/').pop()} 的 ${x},${y},${w},${h} 切出；字形 ${c}`
    })
  }
  await ensureDir(outFile)
  await writeFile(outFile, JSON.stringify(jobs, null, 1), 'utf8')
  console.log(
    JSON.stringify({
      ok: true,
      out: outFile,
      count: jobs.length,
      glyphRow: [top, top + height - 1],
      glyphH: height,
      widths: jobs.map((j) => j.crop.w),
      ids: jobs.map((j) => j.id)
    })
  )
}

/**
 * 透明底预览：alpha <x> <y> <w> <h> <out.png> <tol> <frameA> <frameB> [frameC...]
 * 洋红色 = 抠掉（不参与匹配）。占比太低（<0.3）通常是几帧之间控件位置没对齐。
 */
async function cmdAlpha(
  x: number,
  y: number,
  w: number,
  h: number,
  out: string,
  tol: number,
  frames: string[]
): Promise<void> {
  const bufs = await Promise.all(frames.map((p) => readFile(p)))
  const r = await buildDiffAlpha(
    bufs.map((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)),
    { x, y, w, h },
    { tolerance: tol }
  )
  const crop = await sharp(bufs[0]!)
    .extract({ left: x, top: y, width: w, height: h })
    .png()
    .toBuffer()
  const { applyAlpha } = await import('@vision/index')
  const rgba = await applyAlpha(new Uint8Array(crop), new Uint8Array(r.alphaPng))
  await ensureDir(out)
  await sharp(rgba)
    .flatten({ background: '#ff00ff' })
    .resize({ width: Math.min(1200, w * 4), kernel: 'nearest' })
    .png()
    .toFile(out)
  console.log(
    JSON.stringify({
      ok: true,
      out,
      coverage: Number(r.coverage.toFixed(3)),
      tol,
      frames: frames.length
    })
  )
}

/** 批量存模板。JSON 是 SaveJob[]。 */
async function cmdSave(jobFile: string): Promise<void> {
  const jobs = JSON.parse(await readFile(jobFile, 'utf8')) as SaveJob[]
  const setId = await resolveSet()
  const out: unknown[] = []
  for (const j of jobs) {
    try {
      const png = await readFile(j.frame)
      const meta = await sharp(png).metadata()
      // 透明底：多帧差分去底，α 图与裁剪区同尺寸。
      let alpha: ArrayBuffer | undefined
      let coverage: number | undefined
      if (j.diffFrames && j.diffFrames.length > 0) {
        const others = await Promise.all(j.diffFrames.map((p) => readFile(p)))
        const r = await buildDiffAlpha(
          [png, ...others].map((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)),
          j.crop,
          { tolerance: j.diffTolerance }
        )
        alpha = r.alphaPng.buffer.slice(
          r.alphaPng.byteOffset,
          r.alphaPng.byteOffset + r.alphaPng.byteLength
        ) as ArrayBuffer
        coverage = r.coverage
      }
      const def = await saveTemplate(setId, {
        id: j.id,
        name: j.name,
        image: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
        authoredWidth: meta.width ?? REF_WIDTH,
        authoredHeight: meta.height ?? REF_HEIGHT,
        crop: j.crop,
        defaultRoi: j.defaultRoi,
        threshold: j.threshold,
        tags: j.tags,
        note: j.note,
        alpha
      })
      out.push({
        id: def.id,
        ok: true,
        std: def.std,
        bounds: def.bounds,
        roi: def.defaultRoi,
        maskCoverage: def.maskCoverage ?? null,
        diffCoverage: coverage ?? null
      })
    } catch (e) {
      out.push({ id: j.id, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  console.log(JSON.stringify(out, null, 1))
}

interface VerifyJob {
  /** 模板 id */
  id: string
  /** 正样本帧（应当命中）+ 期望命中的位置（模板 bounds 的 x,y） */
  pos: { frame: string; expect?: [number, number]; roi?: Rect }
  /** 负样本：帧 + ROI（必须落空） */
  neg: Array<{ frame: string; roi?: Rect; label?: string }>
  threshold?: number
}

const frameCache = new Map<string, Awaited<ReturnType<typeof prepareFrame>>>()

async function preparedFromPng(png: string): Promise<Awaited<ReturnType<typeof prepareFrame>>> {
  const hit = frameCache.get(png)
  if (hit) return hit
  const img = sharp(png).ensureAlpha()
  const meta = await img.metadata()
  const raw = await img.raw().toBuffer()
  const f = await prepareFrame(
    {
      width: meta.width ?? REF_WIDTH,
      height: meta.height ?? REF_HEIGHT,
      format: 1,
      data: new Uint8Array(raw),
      capturedAt: Date.now()
    },
    { refW: REF_WIDTH, refH: REF_HEIGHT, shrink: SHRINK }
  )
  frameCache.set(png, f)
  return f
}

async function cmdVerify(jobFile: string): Promise<void> {
  const jobs = JSON.parse(await readFile(jobFile, 'utf8')) as VerifyJob[]
  const setId = await resolveSet()
  const tpls = await loadPrepared(setId, { refW: REF_WIDTH, shrink: SHRINK })
  const out: unknown[] = []
  for (const j of jobs) {
    const tpl = tpls.get(j.id)
    if (!tpl) {
      out.push({ id: j.id, ok: false, error: '模板未编译出来（可能存盘失败）' })
      continue
    }
    const pf = await preparedFromPng(j.pos.frame)
    const hit = await matchIn(pf, tpl, { roi: j.pos.roi, threshold: j.threshold })
    let dx: number | null = null
    let dy: number | null = null
    if (j.pos.expect) {
      dx = Math.abs(hit.x - j.pos.expect[0])
      dy = Math.abs(hit.y - j.pos.expect[1])
    }
    const negs: unknown[] = []
    let negOk = true
    for (const n of j.neg) {
      const nf = await preparedFromPng(n.frame)
      const m = await matchIn(nf, tpl, { roi: n.roi, threshold: j.threshold })
      if (m.found) negOk = false
      negs.push({
        label: n.label ?? n.frame.split('/').pop(),
        found: m.found,
        score: m.score,
        reason: m.reason
      })
    }
    const posOk = hit.found && hit.score >= 0.95 && (dx === null || (dx <= 2 && dy! <= 2))
    out.push({
      id: j.id,
      ok: posOk && negOk,
      std: tpl.std,
      masked: tpl.maskCoverage ?? null,
      size: [tpl.refW, tpl.refH],
      pos: {
        found: hit.found,
        score: hit.score,
        at: [hit.x, hit.y],
        center: [hit.centerX, hit.centerY],
        dx,
        dy
      },
      neg: negs
    })
  }
  console.log(JSON.stringify(out, null, 1))
}

/** 两两互匹（数字模板交叉自检）：把 ids 里每张模板拿去匹配其他每张模板的正样本裁块。 */
async function cmdCross(jobFile: string): Promise<void> {
  const jobs = JSON.parse(await readFile(jobFile, 'utf8')) as Array<{
    id: string
    frame: string
    roi: Rect
  }>
  const setId = await resolveSet()
  const tpls = await loadPrepared(setId, { refW: REF_WIDTH, shrink: SHRINK })
  const rows: Array<Record<string, unknown>> = []
  let worst = { self: '', other: '', score: -1 }
  for (const a of jobs) {
    const tpl = tpls.get(a.id)
    if (!tpl) {
      rows.push({ id: a.id, error: '模板缺失' })
      continue
    }
    const row: Record<string, unknown> = { id: a.id, std: tpl.std }
    for (const b of jobs) {
      const f = await preparedFromPng(b.frame)
      const m = await matchIn(f, tpl, { roi: b.roi, threshold: 0.01 })
      row[b.id] = m.score
      if (a.id !== b.id && m.score > worst.score) {
        worst = { self: a.id, other: b.id, score: m.score }
      }
    }
    rows.push(row)
  }
  console.log(JSON.stringify({ rows, worstCross: worst }, null, 1))
}

/**
 * 跨场景数字识别自检：在 ROI 内按列投影切字，对每个字位用整套字形做 argmax，
 * 与期望字符串比对。用来验证「一套通用数字模板能不能读另一个界面的数字」。
 *
 * 用法：ocr <frame> <x> <y> <w> <h> <polarity> <thr> <expect> <setPrefix> [minSegW]
 */
async function cmdOcr(
  framePng: string,
  x: number,
  y: number,
  w: number,
  h: number,
  polarity: string,
  thr: number,
  expect: string,
  setPrefix: string,
  minSegW: number
): Promise<void> {
  const g = await grayRegion(framePng, { x, y, w, h })
  const edge: number[] = []
  for (let i = 0; i < w; i++) edge.push(g.gray[i]!, g.gray[(h - 1) * w + i]!)
  for (let j = 0; j < h; j++) edge.push(g.gray[j * w]!, g.gray[j * w + w - 1]!)
  edge.sort((a, b) => a - b)
  const bg = edge[Math.floor(edge.length / 2)]!
  const isFg = (v: number): boolean =>
    polarity === 'light'
      ? v - bg > thr
      : polarity === 'dark'
        ? bg - v > thr
        : Math.abs(v - bg) > thr
  const colCount = new Array<number>(w).fill(0)
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) if (isFg(g.gray[j * w + i]!)) colCount[i]!++
  const segs: Array<{ x0: number; x1: number }> = []
  let cur: { x0: number; x1: number } | null = null
  for (let i = 0; i < w; i++) {
    if (colCount[i]! > 0) {
      if (!cur) cur = { x0: i, x1: i }
      else cur.x1 = i
    } else if (cur) {
      if (cur.x1 - cur.x0 + 1 >= minSegW) segs.push(cur)
      cur = null
    }
  }
  if (cur && cur.x1 - cur.x0 + 1 >= minSegW) segs.push(cur)

  const setId = await resolveSet()
  const tpls = await loadPrepared(setId, { refW: REF_WIDTH, shrink: SHRINK })
  const members = [...tpls.values()].filter((t) => t.id.startsWith(setPrefix + '_'))
  if (!members.length) throw new Error(`模板集里没有前缀为 ${setPrefix}_ 的字形`)
  const maxTplW = Math.max(...members.map((t) => t.refW))
  const frame = await preparedFromPng(framePng)

  const want = [...expect]
  const got: string[] = []
  const detail: unknown[] = []
  for (const s of segs) {
    // ROI 必须比最宽的字形还宽，否则窄字形（冒号）位上所有模板都塞不下、分数恒为 0
    const pad = Math.max(4, Math.ceil((maxTplW - (s.x1 - s.x0 + 1)) / 2) + 3)
    const roi = { x: x + s.x0 - pad, y: y - 4, w: s.x1 - s.x0 + 1 + pad * 2, h: h + 8 }
    let best = { id: '', score: -1 }
    let second = -1
    for (const t of members) {
      const m = await matchIn(frame, t, { roi, threshold: 0.01 })
      if (m.score > best.score) {
        second = best.score
        best = { id: t.id, score: m.score }
      } else if (m.score > second) second = m.score
    }
    const ch = best.id.slice(setPrefix.length + 1).replace(/^d/, '')
    const c = ch === 'colon' ? ':' : ch === 'slash' ? '/' : ch === 'comma' ? ',' : ch
    got.push(c)
    detail.push({
      at: x + s.x0,
      w: s.x1 - s.x0 + 1,
      pick: c,
      score: Number(best.score.toFixed(4)),
      margin: Number((best.score - second).toFixed(4))
    })
  }
  const text = got.join('')
  console.log(
    JSON.stringify(
      {
        setPrefix,
        frame: framePng.split('/').pop(),
        expect,
        got: text,
        ok: text === expect,
        segs: segs.length,
        wanted: want.length,
        detail
      },
      null,
      1
    )
  )
  if (text !== expect) process.exitCode = 2
}

/** 在某帧上匹配某个已存模板，打印命中结果（用来推算「相对锚点的偏移」）。 */
async function cmdFind(id: string, framePng: string, roiJson?: string): Promise<void> {
  const setId = await resolveSet()
  const tpls = await loadPrepared(setId, { refW: REF_WIDTH, shrink: SHRINK })
  const tpl = tpls.get(id)
  if (!tpl) throw new Error(`模板 ${id} 不存在`)
  const roi = roiJson ? (JSON.parse(roiJson) as Rect) : undefined
  const m = await matchIn(await preparedFromPng(framePng), tpl, { roi, threshold: 0.5 })
  console.log(
    JSON.stringify({
      frame: framePng.split('/').pop(),
      found: m.found,
      score: m.score,
      at: [m.x, m.y],
      wh: [m.w, m.h],
      center: [m.centerX, m.centerY]
    })
  )
}

/**
 * 全量扫描自检：把模板集里每个 tpl_* 模板，在给定的一批帧上按各自 defaultRoi 匹配一遍，
 * 打印命中的帧列表与分数。命中集合是否 == 语义上「应该出现」的界面集合，就是最终验收依据。
 *
 * 用法：scan <framesDir> [idPrefix]
 */
async function cmdScan(framesDir: string, prefix: string): Promise<void> {
  const setId = await resolveSet()
  const tpls = await loadPrepared(setId, { refW: REF_WIDTH, shrink: SHRINK })
  const defs = await listTemplates(setId)
  const byId = new Map(defs.map((d) => [d.id, d]))
  const names = (await readdir(framesDir)).filter((f) => f.endsWith('.png')).sort()
  const frames = new Map<string, Awaited<ReturnType<typeof prepareFrame>>>()
  for (const n of names) frames.set(n, await preparedFromPng(join(framesDir, n)))

  const rows: unknown[] = []
  for (const t of [...tpls.values()]
    .filter((t) => t.id.startsWith(prefix))
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const roi = byId.get(t.id)?.defaultRoi
    const hits: Array<{ f: string; s: number; at: [number, number] }> = []
    let maxMiss = 0
    for (const [n, f] of frames) {
      const m = await matchIn(f, t, { roi })
      if (m.found)
        hits.push({ f: n.replace('.png', ''), s: Number(m.score.toFixed(3)), at: [m.x, m.y] })
      else if (m.score > maxMiss) maxMiss = m.score
    }
    rows.push({
      id: t.id,
      std: Number(t.std.toFixed(1)),
      size: [t.refW, t.refH],
      hitCount: hits.length,
      bestMiss: Number(maxMiss.toFixed(3)),
      hits
    })
  }
  console.log(JSON.stringify(rows, null, 1))
}

/** 删除模板（按 id 前缀或精确 id）。 */
async function cmdDel(prefix: string): Promise<void> {
  const setId = await resolveSet()
  const all = await listTemplates(setId)
  const hit = all.filter((t) => t.id === prefix || t.id.startsWith(prefix))
  for (const t of hit) await deleteTemplate(setId, t.id)
  console.log(JSON.stringify({ deleted: hit.map((t) => t.id) }))
}

/** 列出模板集里全部模板。 */
async function cmdList(): Promise<void> {
  const setId = await resolveSet()
  const all = await listTemplates(setId)
  console.log(
    JSON.stringify(
      all.map((t) => ({
        id: t.id,
        name: t.name,
        std: t.std,
        bounds: t.bounds,
        roi: t.defaultRoi,
        tags: t.tags,
        note: t.note
      })),
      null,
      1
    )
  )
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'scan':
      await cmdScan(argv[1]!, argv[2] ?? 'tpl_')
      break
    case 'del':
      await cmdDel(argv[1]!)
      break
    case 'ls':
      await cmdList()
      break
    case 'ocr':
      await cmdOcr(
        argv[1]!,
        num(argv[2]),
        num(argv[3]),
        num(argv[4]),
        num(argv[5]),
        argv[6]!,
        num(argv[7]),
        argv[8]!,
        argv[9]!,
        num(argv[10], 3)
      )
      break
    case 'find':
      await cmdFind(argv[1]!, argv[2]!, argv[3])
      break
    case 'cap':
      await cmdCap(argv[1] ?? 'frame')
      break
    case 'view':
      await cmdView(
        argv[1]!,
        num(argv[2]),
        num(argv[3]),
        num(argv[4]),
        num(argv[5]),
        argv[6]!,
        num(argv[7], 4)
      )
      break
    case 'analyze':
      await cmdAnalyze(
        argv[1]!,
        num(argv[2]),
        num(argv[3]),
        num(argv[4]),
        num(argv[5]),
        argv[6],
        argv[7] ? num(argv[7]) : undefined
      )
      break
    case 'probe':
      await cmdProbe(argv[1]!, num(argv[2]), num(argv[3]), num(argv[4], 5))
      break
    case 'glyphs':
      await cmdGlyphs(
        argv[1]!,
        num(argv[2]),
        num(argv[3]),
        num(argv[4]),
        num(argv[5]),
        argv[6]!,
        num(argv[7]),
        argv[8]!,
        argv[9]!,
        argv[10]!,
        num(argv[11], 2),
        num(argv[12], 2)
      )
      break
    case 'alpha':
      await cmdAlpha(
        num(argv[1]),
        num(argv[2]),
        num(argv[3]),
        num(argv[4]),
        argv[5]!,
        num(argv[6]),
        argv.slice(7)
      )
      break
    case 'save':
      await cmdSave(argv[1]!)
      break
    case 'verify':
      await cmdVerify(argv[1]!)
      break
    case 'cross':
      await cmdCross(argv[1]!)
      break
    default:
      console.error(
        '用法：tplkit cap|view|analyze|probe|alpha|glyphs|save|verify|cross|find|ls|del ...'
      )
      process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e))
  process.exitCode = 1
})
