/**
 * ETA 调度器的**离线**自检：拿已存的真机满分辨率截图跑一遍「部队管理」面板采样器，
 * 不碰模拟器、不发一条 adb 命令（capture() 直接把 PNG 解成 RawFrame 喂进去）。
 *
 * 跑法（工程根目录下）：
 *   npx esbuild scripts/sched-offline-check.ts --bundle --platform=node --format=esm \
 *     --target=node22 --packages=external \
 *     --alias:@shared=./src/shared --alias:@main=./src/main \
 *     --alias:@vision=./src/vision --alias:@worker=./src/worker \
 *     --outfile=out/schedcheck/check.mjs && node out/schedcheck/check.mjs [帧名片段...]
 *
 * 帧目录默认是 `<工程根>/.tplkit/frames`（裁模板时抓的那批），也可以用
 * 环境变量 WL_FRAMES_DIR 指到别处。给了帧名片段就只跑匹配的那几张。
 *
 * 判读标准：
 *   · 部队管理面板的帧应当读出「队列 N/M + 每行状态词 + 倒计时」，且**没有 ⚠**；
 *   · 连拍的几张（如 s13_t1..t10 是每秒一张）倒计时应当逐张递减 1 秒 —— 这是最强的正确性证据；
 *   · 非面板的帧应当**跳过**（报「无法确认界面」或试图点击），绝不能读出假数据。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { REF_HEIGHT, REF_WIDTH } from '@shared/constants'
import { defaultSchedulerConfig, deriveMarchView, formatDuration } from '@shared/scheduler'
import type { PreparedTemplate, RawFrame } from '@shared/vision'
import { applyAlpha, buildDiffAlpha, matchIn, prepareFrame, prepareTemplate, setTemplatesDir } from '@vision/index'
import { sharp } from '@vision/cv'

import { getTemplates } from '@main/scheduler/templates'
import { applySample, emptyInstanceState, planNextWake, toMarchState } from '@main/scheduler/state'
import { sampleTroopPanel, type SampleIo } from '@main/scheduler/troopPanel'

const ROOT = process.cwd()
const FRAMES = process.env.WL_FRAMES_DIR ?? join(ROOT, '.tplkit', 'frames')

/** PNG -> RawFrame(RGBA8888)，与 adb screencap 解出来的形状一致。 */
async function rawOf(file: string): Promise<RawFrame> {
  const buf = await readFile(file)
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return {
    width: info.width,
    height: info.height,
    format: 1,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    capturedAt: Date.now()
  }
}

async function main(): Promise<void> {
  setTemplatesDir(join(ROOT, '.wl-data', 'templates'))

  let files: string[]
  try {
    files = (await readdir(FRAMES)).filter((f) => f.toLowerCase().endsWith('.png')).sort()
  } catch {
    console.error(
      `找不到帧目录 ${FRAMES}。\n` +
        '请先用 `npm run tplkit -- cap <名字>` 抓几张真机截图，或用 WL_FRAMES_DIR 指到已有的目录。'
    )
    process.exitCode = 1
    return
  }
  if (files.length === 0) {
    console.error(`帧目录 ${FRAMES} 里一张 PNG 都没有。`)
    process.exitCode = 1
    return
  }

  const t = await getTemplates({ templateSetId: '', refWidth: REF_WIDTH })
  console.log(
    `模板集 ${t.setId}：界面 ${t.ui.size} 张 / 字形 ${t.digits.size} 张；` +
      `dark ${t.dark.glyphs.length} · light ${t.light.glyphs.length} · ` +
      `coord ${t.coord?.glyphs.length ?? 0} · stamina ${t.stamina?.glyphs.length ?? 0}`
  )

  const only = process.argv.slice(2)
  const targets = only.length ? files.filter((f) => only.some((o) => f.includes(o))) : files
  const config = defaultSchedulerConfig()

  if (!(await checkMaskedVariants(t.ui, files))) process.exitCode = 1
  if (!(await checkRowRecognition(t, files))) process.exitCode = 1

  let panels = 0
  let warned = 0

  for (const f of targets) {
    const raw = await rawOf(join(FRAMES, f))
    const io: SampleIo = {
      serial: 'offline',
      capture: async () => raw,
      tapRef: async () => {
        throw new Error('离线自检里不该发生点击 —— 说明这一帧没被认成「面板已打开」')
      },
      key: async () => {
        throw new Error('离线自检里不该发生按键')
      },
      log: () => undefined
    }

    const t0 = Date.now()
    try {
      const s = await sampleTroopPanel(io, t, {
        refWidth: REF_WIDTH,
        refHeight: REF_HEIGHT,
        maxRows: 5,
        readOptionalFields: true,
        closePanelAfterSample: false,
        deadlineAt: Date.now() + 120_000
      })
      panels++
      const busy = s.rows.filter((r) => r.status !== 'idle')
      console.log(
        `\n=== ${f}  (${Date.now() - t0}ms)  队列 ${s.queueUsed ?? '?'}/${s.queueTotal ?? '?'}  在外 ${busy.length} 支`
      )
      for (const r of busy) {
        const m = toMarchState(r, s.sampledAt, [], config)
        const v = deriveMarchView(m, s.sampledAt + 1000)
        console.log(
          `  #${r.slot} ${r.statusText.padEnd(6)} 倒计时=${formatDuration(r.remainingMs)}` +
            `  坐标=${r.targetCoord ?? '-'}` +
            `  耐力=${r.commanders.map((c) => `${c.current ?? '?'}/${c.max ?? '?'}`).join(' ') || '-'}` +
            `  | 距队列释放=${formatDuration(v.untilFreeMs)} 阶段=${v.phaseText}`
        )
      }
      for (const w of s.warnings) {
        warned++
        console.log(`  ⚠ ${w}`)
      }

      let st = emptyInstanceState(0)
      st.auto = true
      st = applySample(st, s, [], config)
      const plan = planNextWake(st, config, s.sampledAt)
      console.log(
        `  下次唤醒：${plan ? `${Math.round((plan.dueAt - s.sampledAt) / 1000)}s 后（${plan.reason}）` : '无'}`
      )
    } catch (e) {
      const first = e instanceof Error ? e.message.split('\n')[0] : String(e)
      console.log(`\n=== ${f}  跳过（不是部队管理面板）：${first}`)
    }
  }

  console.log(`\n合计：${targets.length} 帧，其中 ${panels} 帧读出了面板，${warned} 条告警。`)
}

/**
 * 透明底模板 + 阵营变体自检（2026-09-10）。
 *
 * 场景：兽族小号（huadong）在城内时，主号（法师）的城内地图按钮模板只有 0.72，采样连续失败。
 * 补的变体 tpl_nav_map_toggle_b 圆环里透着会变的地形，所以是多帧差分去底的透明底模板。
 * 这里验：① 它编译出来了且带掩码；② 兽族城内两帧都命中 ≥0.9（其中一帧是没参与去底的）；
 * ③ 法师城内 / 世界地图都不命中；④ 视觉层的 α 管线本身（buildDiffAlpha → applyAlpha → prepareTemplate）能走通。
 * 帧不在时只提示、不判失败（别的机器上没有这批帧）。
 */
async function checkMaskedVariants(ui: Map<string, PreparedTemplate>, files: string[]): Promise<boolean> {
  console.log('\n【透明底模板 / 阵营变体】')
  let pass = 0
  let fail = 0
  const ok = (name: string, cond: boolean, extra = ''): void => {
    if (cond) pass++
    else fail++
    console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`)
  }

  const tpl = ui.get('tpl_nav_map_toggle_b')
  ok('tpl_nav_map_toggle_b 已编译', Boolean(tpl))
  if (tpl) {
    ok(
      '带透明底掩码，且不透明占比在 0.3~0.9',
      Boolean(tpl.mask) && (tpl.maskCoverage ?? 0) >= 0.3 && (tpl.maskCoverage ?? 0) <= 0.9,
      `coverage=${tpl.maskCoverage ?? '无'}`
    )
    ok('掩码长度 = w*h', !tpl.mask || tpl.mask.length === tpl.w * tpl.h)

    const cases: Array<[string, boolean]> = [
      ['huadong_city.png', true],
      ['huadong_city_pan2.png', true],
      ['huadong_after2.png', true],
      ['zhuhao_city.png', false],
      ['s24_city.png', false],
      ['inst1_worldmap.png', false],
      ['s00_now.png', false]
    ]
    for (const [file, expect] of cases) {
      if (!files.includes(file)) {
        console.log(`  · 跳过 ${file}（帧不存在）`)
        continue
      }
      const frame = await prepareFrame(await rawOf(join(FRAMES, file)), {
        refW: REF_WIDTH,
        refH: REF_HEIGHT,
        shrink: 2
      })
      const m = await matchIn(frame, tpl)
      ok(
        `${file} → ${expect ? '应命中(≥0.9)' : '应不命中'}`,
        expect ? m.found && m.score >= 0.9 : !m.found,
        `score=${m.score} at=${m.x},${m.y}`
      )
    }
  }

  // α 管线自检：从两帧差分得到 α，并进裁剪 PNG，编译后必须带掩码；同一裁剪不带 α 则不带掩码。
  const a = 'huadong_after2.png'
  const b = 'huadong_city_pan2.png'
  if (files.includes(a) && files.includes(b)) {
    const fa = await readFile(join(FRAMES, a))
    const fb = await readFile(join(FRAMES, b))
    const crop = { x: 22, y: 1224, w: 196, h: 192 }
    const diff = await buildDiffAlpha([new Uint8Array(fa), new Uint8Array(fb)], crop, { tolerance: 24 })
    ok('buildDiffAlpha 覆盖率合理（0.3~0.9）', diff.coverage > 0.3 && diff.coverage < 0.9, `coverage=${diff.coverage.toFixed(3)}`)
    const cropPng = await sharp(fa).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h }).png().toBuffer()
    const rgba = await applyAlpha(new Uint8Array(cropPng), new Uint8Array(diff.alphaPng))
    const prepared = await prepareTemplate(new Uint8Array(rgba), { id: 'tmp_masked', name: '自检·透明底', refW: REF_WIDTH, shrink: 2 })
    ok('带 α 的 PNG 编译后有掩码', Boolean(prepared.mask) && (prepared.maskCoverage ?? 0) > 0.3, `coverage=${prepared.maskCoverage}`)
    const plain = await prepareTemplate(new Uint8Array(cropPng), { id: 'tmp_plain', name: '自检·普通', refW: REF_WIDTH, shrink: 2 })
    ok('不带 α 的 PNG 编译后没有掩码', !plain.mask && plain.maskCoverage === undefined)
    ok('透明底模板的 std 只统计不透明像素（与整块不同）', Math.abs(prepared.std - plain.std) > 1, `masked=${prepared.std.toFixed(1)} plain=${plain.std.toFixed(1)}`)
  } else {
    console.log(`  · 跳过 α 管线自检（缺 ${a} / ${b}）`)
  }

  console.log(`  透明底自检：通过 ${pass} / 失败 ${fail}`)
  return fail === 0
}

/**
 * 行内资源缩略图识别 + 「采集中」图标判据 + 进度条倒计时二值化（2026-09-10）。
 * 真值来自人眼核对过的面板帧（缩略图拼图 .tplkit/view/thumb_sheet.png、进度条拼图 status_bars.png）。
 */
async function checkRowRecognition(t: Awaited<ReturnType<typeof getTemplates>>, files: string[]): Promise<boolean> {
  console.log('\n【行内资源缩略图 / 采集中图标 / 进度条倒计时二值化】')
  let pass = 0
  let fail = 0
  const ok = (name: string, cond: boolean, extra = ''): void => {
    if (cond) pass++
    else fail++
    console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`)
  }
  const sampleOf = async (file: string) => {
    const raw = await rawOf(join(FRAMES, file))
    const io: SampleIo = {
      serial: 'offline',
      capture: async () => raw,
      tapRef: async () => {
        throw new Error('离线自检里不该发生点击')
      },
      key: async () => {
        throw new Error('离线自检里不该发生按键')
      },
      log: () => undefined
    }
    return sampleTroopPanel(io, t, {
      refWidth: REF_WIDTH,
      refHeight: REF_HEIGHT,
      maxRows: 5,
      readOptionalFields: true,
      closePanelAfterSample: false,
      deadlineAt: Date.now() + 120_000
    })
  }
  const cases: Array<{
    file: string
    resources: Array<string | null>
    timers?: Record<number, number>
    /** 行号 → 人眼核对过的坐标原文（坐标字形 0-9 补齐后的回归）。 */
    coords?: Record<number, string>
  }> = [
    { file: 'panel_mana5.png', resources: ['mana', 'mana', 'mana', 'mana', 'mana'] },
    { file: 'panel_gold_wood.png', resources: ['gold', 'wood', 'gold', 'wood', 'wood'] },
    { file: 'inst3_panel.png', resources: ['gold', null, null, null, null] },
    {
      file: 'panel_iron.png',
      resources: ['wood', 'iron', 'gold', 'wood', 'wood'],
      coords: { 1: '674,627', 2: '678,628', 3: '686,628', 4: '671,634', 5: '679,618' }
    },
    { file: 'inst3_panel.png', resources: [], coords: { 1: '1231,717', 2: '1239,710' } },
    // 第 1 行「01:44:06」：绿色载重条边界正压在「44」上，二值化前读成「01:4:06」。
    { file: 'troop-panel-5rows.png', resources: [], timers: { 1: (1 * 3600 + 44 * 60 + 6) * 1000 } }
  ]
  for (const c of cases) {
    if (!files.includes(c.file)) {
      console.log(`  · 跳过 ${c.file}（帧不存在）`)
      continue
    }
    const s = await sampleOf(c.file)
    c.resources.forEach((want, i) => {
      const row = s.rows[i]
      ok(`${c.file} 第 ${i + 1} 行资源 = ${want ?? 'null'}`, (row?.resourceType ?? null) === want, `读到 ${row?.resourceType ?? 'null'}（${row?.statusText ?? '-'}）`)
    })
    for (const row of s.rows) {
      if (row.status !== 'gathering') continue
      ok(`${c.file} 第 ${row.slot} 行（采集中）倒计时读出`, row.remainingMs != null, `remainingMs=${row.remainingMs ?? 'null'}`)
    }
    for (const [slot, want] of Object.entries(c.coords ?? {})) {
      const row = s.rows[Number(slot) - 1]
      ok(`${c.file} 第 ${slot} 行坐标 = ${want}`, row?.targetCoord === want, `读到 ${row?.targetCoord ?? 'null'}`)
    }
    for (const [slot, ms] of Object.entries(c.timers ?? {})) {
      const row = s.rows[Number(slot) - 1]
      ok(`${c.file} 第 ${slot} 行倒计时 = ${formatDuration(ms)}`, row?.remainingMs === ms, `读到 ${row?.remainingMs == null ? 'null' : formatDuration(row.remainingMs)}`)
    }
  }
  console.log(`  行识别自检：通过 ${pass} / 失败 ${fail}`)
  return fail === 0
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
