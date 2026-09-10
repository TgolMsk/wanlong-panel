/**
 * 端到端冒烟自检 —— 对**真实运行中的 MuMu 实例**跑一遍全链路。
 *
 * 目的：证明这套地基是活的，而不是纸面代码。它不 mock 任何东西：
 * 实例是真的、adb 是真的、截图是真帧、模板是从真帧里裁的、点击真的打进模拟器。
 *
 * 跑法（见 package.json）：
 *     npm run smoke
 * 等价于：先用 esbuild 把本文件连同 src/ 打成 out/smoke/smoke.mjs（为了解析 @shared 等别名），
 * 再用 node 跑。之所以不直接 tsx，是因为工程里的路径别名由 electron-vite / tsconfig paths 提供，
 * 单独引一个 tsx 只为跑冒烟不划算。
 *
 * 六段验证：
 *   1. mumu 封装列实例          listInstances()
 *   2. adb 封装连接 + 真实截图   attach() / captureRaw()
 *   3. 视觉引擎真实模板匹配      saveTemplate() → loadPrepared() → matchIn()（含负样本对照）
 *   4. 输入注入                  key(APP_SWITCH) → 画面变化 → key(HOME) → 画面复原
 *   5. 脚本引擎最小任务          Engine.run()（日志 / 留痕 / 匹配 / 点击全走一遍）
 *   6. 汇总
 *
 * 安全边界（写死在代码里，不要放宽）：
 *   · 只读实例列表，**绝不** create / clone / delete / open / close / restart。
 *   · **绝不** 安装或卸载任何应用，**绝不** 改设备设置。
 *   · 输入只用 HOME / APP_SWITCH 两个按键，以及一次落在**画面空白处**的点击
 *     （空白处由「最低方差区块」算出来，不是猜的）。
 *   · 结束时**不** adb disconnect —— 保持进入时的连接状态，不打扰正在用面板的人。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { defaultSettings, makeId } from '@shared/defaults'
import { MIN_TEMPLATE_STD, REF_HEIGHT, REF_WIDTH } from '@shared/constants'
import type { AppSettings } from '@shared/domain'
import type { ScriptDef } from '@shared/script'
import type { WorkerAttachPayload, WorkerToMain, WorkerToRenderer } from '@shared/worker'
import type { PreparedFrame, Rect } from '@shared/vision'

import { listInstances } from '@main/mumu/index'
import {
  attach,
  captureRaw,
  foregroundPackage,
  forceStop,
  initAdb,
  key as adbKey,
  launch,
  longPress,
  swipe,
  tap,
  typeText
} from '@main/adb/index'
import {
  getCv,
  loadPrepared,
  matchIn,
  prepareFrame,
  saveTemplate,
  setTemplatesDir,
  stdDev,
  createSet,
  listSets
} from '@vision/index'
import { sharp } from '@vision/cv'

import { appendLogs } from '@main/store/logs'
import { saveShot } from '@main/store/shots'

import { RunContext, type DeviceIo, type VisionIo } from '@worker/context'
import { Engine } from '@worker/engine'

// ═══════════════════════════════════════════════════════════════════════════
// 小工具
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 工程根目录。
 * ★ 不能用 import.meta.url 推：本文件会被 esbuild 打包到 out/smoke/smoke.mjs，
 *   相对它算出来的是 out/，数据就会写到 out/.wl-data 去。npm script 永远在工程根跑，用 cwd。
 */
const PROJECT_ROOT = process.cwd()
/** 开发期数据根目录，与 src/main/paths.ts 的 isDev 分支保持一致。 */
const DATA_DIR = join(PROJECT_ROOT, '.wl-data')
const DOCS_DIR = join(PROJECT_ROOT, 'docs')

const paths = {
  dataDir: DATA_DIR,
  templatesDir: join(DATA_DIR, 'templates'),
  shotsDir: join(DATA_DIR, 'shots'),
  logsDir: join(DATA_DIR, 'logs')
}

/** 每一段的判定结果，最后统一汇总。 */
interface Check {
  no: string
  title: string
  ok: boolean
  detail: string
}
const checks: Check[] = []

function record(no: string, title: string, ok: boolean, detail: string): void {
  checks.push({ no, title, ok, detail })
}

let stepIndex = 0
function banner(title: string): void {
  stepIndex += 1
  console.log(`\n${'─'.repeat(74)}`)
  console.log(`【${stepIndex}】${title}`)
  console.log('─'.repeat(74))
}

function ms(t0: number): number {
  return Date.now() - t0
}

function sleep(msec: number): Promise<void> {
  return new Promise((r) => setTimeout(r, msec))
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ═══════════════════════════════════════════════════════════════════════════
// 画面分析：从真帧里挑「适合当模板的区块」和「一定是空白的点」
//
// 不写死坐标，是因为桌面布局会变；写死等于给自己埋雷。
// 两个函数都在**降采样后的灰度帧**上算，与 prepareTemplate 的方差守卫用同一套口径。
// ═══════════════════════════════════════════════════════════════════════════

/** 灰度帧里某个矩形（降采样空间坐标）的标准差。 */
function regionStd(frame: PreparedFrame, gx: number, gy: number, gw: number, gh: number): number {
  const buf = new Uint8Array(gw * gh)
  for (let row = 0; row < gh; row++) {
    const from = (gy + row) * frame.w + gx
    buf.set(frame.gray.subarray(from, from + gw), row * gw)
  }
  return stdDev(buf)
}

interface Block {
  /** 参考分辨率坐标。 */
  rect: Rect
  std: number
}

/**
 * 网格扫描全帧，返回按标准差排序的候选区块（参考分辨率坐标）。
 * 边缘留白 5%：状态栏/导航条那种全局叠加层不适合当模板。
 */
function scanBlocks(frame: PreparedFrame, sizeRef: number, strideRef: number): Block[] {
  const s = frame.shrink
  const gSize = Math.floor(sizeRef / s)
  const gStride = Math.max(1, Math.floor(strideRef / s))
  const marginX = Math.floor(frame.w * 0.05)
  const marginY = Math.floor(frame.h * 0.05)

  const out: Block[] = []
  for (let gy = marginY; gy + gSize <= frame.h - marginY; gy += gStride) {
    for (let gx = marginX; gx + gSize <= frame.w - marginX; gx += gStride) {
      out.push({
        rect: { x: gx * s, y: gy * s, w: gSize * s, h: gSize * s },
        std: regionStd(frame, gx, gy, gSize, gSize)
      })
    }
  }
  out.sort((a, b) => b.std - a.std)
  return out
}

/** 两帧灰度的平均绝对差。用来客观证明「按键真的改变了画面」。 */
function meanAbsDiff(a: PreparedFrame, b: PreparedFrame): number {
  const n = Math.min(a.gray.length, b.gray.length)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) sum += Math.abs(a.gray[i] - b.gray[i])
  return sum / n
}

// ═══════════════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('万龙控制面板 —— 端到端冒烟自检')
  console.log(`工程根目录：${PROJECT_ROOT}`)
  console.log(`运行数据目录：${DATA_DIR}`)

  await mkdir(paths.templatesDir, { recursive: true })
  await mkdir(paths.shotsDir, { recursive: true })
  await mkdir(paths.logsDir, { recursive: true })
  await mkdir(DOCS_DIR, { recursive: true })

  const settings: AppSettings = { ...defaultSettings(DATA_DIR) }

  // ── 1. 实例列表 ─────────────────────────────────────────────────────────
  banner('通过 mumu 封装列出实例（listInstances）')
  let instances: Awaited<ReturnType<typeof listInstances>> = []
  const tList = Date.now()
  try {
    instances = await listInstances()
    const cost = ms(tList)
    console.log(`mumutool info all 耗时 ${cost}ms，共 ${instances.length} 个实例：`)
    for (const i of instances) {
      console.log(
        `  index=${i.index}  name=${i.name}  state=${i.state}  adbPort=${i.adbPort ?? '-'}  ` +
          `pid=${i.pid ?? '-'}  screenReady=${i.screenReady}  serial=${i.serial ?? '-'}`
      )
    }
    const running = instances.filter((i) => i.state === 'running' && i.adbPort !== null)
    record(
      '1',
      '实例列举',
      running.length > 0,
      running.length > 0
        ? `${instances.length} 个实例，${running.length} 个 running；` +
            running
              .map((i) => `index=${i.index}「${i.name}」adb_port=${i.adbPort}`)
              .join('，') +
            `；耗时 ${cost}ms`
        : '没有任何 running 且带 adb_port 的实例，后续验证无法进行'
    )
  } catch (e) {
    record('1', '实例列举', false, `listInstances() 抛错：${errText(e)}`)
    throw e
  }

  const target = instances.find((i) => i.state === 'running' && i.adbPort !== null)
  if (!target || target.adbPort === null) {
    throw new Error('没有可用的 running 实例，冒烟中止。请先在 MuMu 里启动一个实例。')
  }

  // ── 2. adb 连接 + 真实截图 ──────────────────────────────────────────────
  banner('通过 adb 封装解析 serial 并抓真实截图（attach / captureRaw）')
  await initAdb({ adbPath: settings.adbPath })

  const tAttach = Date.now()
  const dev = await attach(target.index, target.adbPort)
  console.log(
    `attach 耗时 ${ms(tAttach)}ms（含一次取分辨率的截图）\n` +
      `  serial=${dev.serial}  机型=${dev.model}  Android ${dev.androidVersion} (SDK ${dev.sdkInt})  ${dev.abi}\n` +
      `  screencap 实测分辨率=${dev.screenWidth}x${dev.screenHeight}  density=${dev.density}  ` +
      `booted=${dev.booted}  前台=${dev.foregroundPackage ?? '未知'}`
  )
  const serial = dev.serial

  // ★ 先按一次 HOME 回桌面再抓基准帧。两个原因：
  //   ① 桌面是**静止画面**，模板匹配才有确定的正确答案；游戏画面每帧都在动，
  //      用它当模板等于给冒烟自己造不确定性。
  //   ② 这本身就是第 4 段输入注入的第一次实证（前台包名会从游戏变成启动器）。
  //   代价只是把前台应用切到后台，不关进程、不改任何设置。
  console.log('准备：按一次 HOME 回到桌面（让基准画面静止；应用只是切到后台，不会被关闭）')
  await adbKey(serial, 'HOME')
  await sleep(1200)

  // 三次连抓，取中位数当作稳定耗时。另外单独测一次不带节流的，好和 CLAUDE.md 的基准数字对齐。
  const capMs: number[] = []
  let raw = await captureRaw(serial)
  for (let i = 0; i < 3; i++) {
    const t = Date.now()
    raw = await captureRaw(serial)
    capMs.push(ms(t))
  }
  const tNoThrottle = Date.now()
  raw = await captureRaw(serial, { throttle: false })
  const noThrottleMs = ms(tNoThrottle)
  capMs.sort((a, b) => a - b)
  const bytes = raw.data.byteLength
  console.log(
    `captureRaw 三次耗时 ${capMs.join(' / ')}ms（中位 ${capMs[1]}ms，含最小间隔 ${settings.minCaptureIntervalMs}ms 节流）\n` +
      `  去掉节流的净耗时：${noThrottleMs}ms\n` +
      `  帧：${raw.width}x${raw.height}  format=${raw.format}（1=RGBA_8888）  像素 ${bytes} 字节 = ${(bytes / 1048576).toFixed(2)}MB`
  )

  // 留痕：走 store/shots 的正式通道（jpeg），另存一份全分辨率 PNG 方便肉眼核对。
  const shotRunId = makeId('smoke').replace(/[^A-Za-z0-9_.-]/g, '')
  const jpeg = await sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, bytes), {
    raw: { width: raw.width, height: raw.height, channels: 4 }
  })
    .resize(1280)
    .jpeg({ quality: 72 })
    .toBuffer()
  const shotRel = await saveShot(paths.shotsDir, shotRunId, '0001-capture.jpg', jpeg)
  // docs/ 下留一份人眼可看的证据。用 jpeg 而不是全分辨率 PNG：后者 3.8MB，不适合进版本库。
  const evidencePath = join(DOCS_DIR, 'smoke-capture.jpg')
  await sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, bytes), {
    raw: { width: raw.width, height: raw.height, channels: 4 }
  })
    .resize(1280)
    .jpeg({ quality: 82 })
    .toFile(evidencePath)
  console.log(`  留痕（正式通道）：${join(paths.shotsDir, shotRel)}`)
  console.log(`  证据截图（docs）：${evidencePath}`)

  const frameOk = raw.width > 0 && raw.height > 0 && bytes === raw.width * raw.height * 4
  record(
    '2',
    '真实截图',
    frameOk,
    `serial=${serial}，分辨率 ${raw.width}x${raw.height}，${(bytes / 1048576).toFixed(2)}MB，` +
      `captureRaw 中位耗时 ${capMs[1]}ms（去节流 ${noThrottleMs}ms）；留痕 ${join(paths.shotsDir, shotRel)}`
  )

  // ── 3. 视觉引擎：真实模板匹配 ───────────────────────────────────────────
  banner('视觉引擎：从真帧裁模板 → 存模板库 → 真实匹配（saveTemplate / matchIn）')

  const tCv = Date.now()
  await getCv()
  console.log(`OpenCV(WASM) 就绪耗时 ${ms(tCv)}ms`)

  const tPrep = Date.now()
  const frame = await prepareFrame(raw, {
    refW: settings.refWidth,
    refH: settings.refHeight,
    shrink: settings.shrink
  })
  console.log(
    `prepareFrame 耗时 ${ms(tPrep)}ms → 灰度 ${frame.w}x${frame.h}（参考 ${frame.refWidth}x${frame.refHeight}，1/${frame.shrink}）`
  )

  // 挑一块高方差区域当模板（越有纹理越好，纯色模板会被方差守卫拒绝）。
  const TPL_SIZE = 240
  const blocks = scanBlocks(frame, TPL_SIZE, 120)
  const best = blocks[0]
  if (!best || best.std < MIN_TEMPLATE_STD * 2) {
    throw new Error(
      `全屏找不到方差足够高的区块（最高 ${best?.std.toFixed(1) ?? 'N/A'}，需 > ${MIN_TEMPLATE_STD * 2}）。` +
        '画面可能是黑屏或纯色，请确认实例画面已经出来了。'
    )
  }
  console.log(
    `自动选中模板区域：(${best.rect.x}, ${best.rect.y}) ${best.rect.w}x${best.rect.h}，区域标准差 ${best.std.toFixed(1)}`
  )

  setTemplatesDir(paths.templatesDir)
  const SET_NAME = '冒烟自检'
  const sets = await listSets()
  const set = sets.find((s) => s.name === SET_NAME) ?? (await createSet(SET_NAME))
  console.log(`模板集：${set.name}（${set.id}） 目录 ${join(paths.templatesDir, set.id)}`)

  // 整帧编码成 PNG 交给 saveTemplate，由它按 crop 裁剪 —— 走的是面板「框选存模板」的同一条路。
  const framePng = await sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, bytes), {
    raw: { width: raw.width, height: raw.height, channels: 4 }
  })
    .png()
    .toBuffer()

  const tSave = Date.now()
  const tplDef = await saveTemplate(set.id, {
    id: 'smoke_probe',
    name: '冒烟探针',
    // TemplateSaveInput.image 契约是 ArrayBuffer；Buffer 只是内存池的一个切片，必须切出独立副本。
    image: framePng.buffer.slice(
      framePng.byteOffset,
      framePng.byteOffset + framePng.byteLength
    ) as ArrayBuffer,
    crop: best.rect,
    authoredWidth: raw.width,
    authoredHeight: raw.height,
    note: '由 scripts/smoke.ts 从真实截图自动裁出，每次冒烟都会覆盖。'
  })
  console.log(
    `saveTemplate 耗时 ${ms(tSave)}ms：id=${tplDef.id} 文件=${tplDef.file} std=${tplDef.std} ` +
      `bounds=(${tplDef.bounds.x},${tplDef.bounds.y} ${tplDef.bounds.w}x${tplDef.bounds.h}) ` +
      `defaultRoi=(${tplDef.defaultRoi?.x},${tplDef.defaultRoi?.y} ${tplDef.defaultRoi?.w}x${tplDef.defaultRoi?.h})`
  )

  const prepared = await loadPrepared(set.id, { refW: settings.refWidth, shrink: settings.shrink })
  const tpl = prepared.get(tplDef.id)
  if (!tpl) throw new Error('loadPrepared 没能编译出刚存的模板，模板库链路有问题。')
  console.log(`loadPrepared：${prepared.size} 张模板，探针编译后 ${tpl.w}x${tpl.h}（灰度，1/${tpl.shrink}）`)

  // ① 正样本：在同一帧里找它自己，应当几乎满分且坐标复原。
  const tMatch = Date.now()
  const hit = await matchIn(frame, tpl)
  const matchMs = ms(tMatch)
  const dx = Math.abs(hit.x - best.rect.x)
  const dy = Math.abs(hit.y - best.rect.y)
  console.log(
    `正样本匹配：found=${hit.found} score=${hit.score} 命中 (${hit.x}, ${hit.y}) ${hit.w}x${hit.h} ` +
      `中心 (${hit.centerX}, ${hit.centerY})  耗时 ${matchMs}ms\n` +
      `  期望起点 (${best.rect.x}, ${best.rect.y})，偏差 (${dx}, ${dy}) 像素（量化精度 ±${frame.shrink}）` +
      (hit.reason ? `\n  reason: ${hit.reason}` : '')
  )

  // ② 负样本：把搜索区挪到画面另一侧，应当明确落空 —— 证明匹配是有判别力的，不是恒返回命中。
  const farX = best.rect.x < settings.refWidth / 2 ? settings.refWidth - 700 : 100
  const farY = best.rect.y < settings.refHeight / 2 ? settings.refHeight - 700 : 100
  const farRoi: Rect = { x: farX, y: farY, w: 600, h: 600 }
  const missed = await matchIn(frame, tpl, { roi: farRoi })
  console.log(
    `负样本对照（ROI ${farRoi.x},${farRoi.y} ${farRoi.w}x${farRoi.h}）：found=${missed.found} score=${missed.score}` +
      (missed.reason ? `（${missed.reason}）` : '')
  )

  // 判定口径：得分要明显高于阈值（0.85），定位偏差不得超过量化精度 ±shrink，
  // 并且负样本必须落空 —— 三条同时成立才算「匹配引擎真的有判别力」。
  // 不要求 score ≈ 1.0：模板经 PNG 往返后是 cubic 缩放的，帧是点采样的，
  // 两者相位不同，实测同帧自匹配就在 0.96~0.98（见 preprocess.ts 的长注释）。
  const posOk =
    hit.found && hit.score >= 0.9 && dx <= frame.shrink && dy <= frame.shrink && !missed.found
  record(
    '3',
    '模板匹配',
    posOk,
    `正样本 score=${hit.score}，命中 (${hit.x},${hit.y})，与期望 (${best.rect.x},${best.rect.y}) 偏差 (${dx},${dy})px，` +
      `匹配耗时 ${matchMs}ms；负样本 found=${missed.found} score=${missed.score}；` +
      `模板 std=${tplDef.std}（下限 ${MIN_TEMPLATE_STD}）`
  )

  // ── 4. 输入注入 ─────────────────────────────────────────────────────────
  banner('输入注入：APP_SWITCH 改变画面 → HOME 复原（key，只用无害按键）')

  const fgBefore = await foregroundPackage(serial)
  console.log(`注入前前台包名：${fgBefore ?? '未知'}`)

  const tKey1 = Date.now()
  await adbKey(serial, 'APP_SWITCH')
  const key1Ms = ms(tKey1)
  await sleep(900)
  const rawSwitch = await captureRaw(serial)
  const frameSwitch = await prepareFrame(rawSwitch, {
    refW: settings.refWidth,
    refH: settings.refHeight,
    shrink: settings.shrink
  })
  const diff = meanAbsDiff(frame, frameSwitch)
  const fgSwitch = await foregroundPackage(serial)
  console.log(
    `APP_SWITCH 注入耗时 ${key1Ms}ms → 画面平均绝对差 ${diff.toFixed(2)}（0 表示画面完全没动），前台=${fgSwitch ?? '未知'}`
  )

  const tKey2 = Date.now()
  await adbKey(serial, 'HOME')
  const key2Ms = ms(tKey2)
  await sleep(1200)
  const fgAfter = await foregroundPackage(serial)
  const rawBack = await captureRaw(serial)
  const frameBack = await prepareFrame(rawBack, {
    refW: settings.refWidth,
    refH: settings.refHeight,
    shrink: settings.shrink
  })
  const backHit = await matchIn(frameBack, tpl)
  const diffBack = meanAbsDiff(frame, frameBack)
  console.log(
    `HOME 注入耗时 ${key2Ms}ms → 与基准帧平均绝对差 ${diffBack.toFixed(2)}，` +
      `探针模板 found=${backHit.found} score=${backHit.score}，前台=${fgAfter ?? '未知'}`
  )

  // 两条独立证据：① 按键真的改变了画面；② 再按 HOME 画面回到了基准状态（模板重新命中）。
  // 只看其中一条都可能被「画面本来就在动」蒙混过去。
  const inputOk = diff > 1 && backHit.found && diffBack < diff
  record(
    '4',
    '输入注入',
    inputOk,
    `APP_SWITCH（${key1Ms}ms）后画面平均绝对差 ${diff.toFixed(2)}（>1 即证明按键真的打进去了）；` +
      `HOME（${key2Ms}ms）复原后差降回 ${diffBack.toFixed(2)}，探针模板重新命中 score=${backHit.score}；` +
      `前台包名 ${fgBefore ?? '未知'} → ${fgSwitch ?? '未知'} → ${fgAfter ?? '未知'}。` +
      '全程只发 keyevent，未安装/卸载应用，未改任何设置。'
  )

  // 空白处坐标：整帧里方差最低的区块中心，脚本引擎那一步要点它（保证点不到任何图标）。
  const calm = scanBlocks(frameBack, 200, 100)
  const emptyBlock = calm[calm.length - 1]
  const emptyPoint = emptyBlock
    ? {
        x: Math.round(emptyBlock.rect.x + emptyBlock.rect.w / 2),
        y: Math.round(emptyBlock.rect.y + emptyBlock.rect.h / 2)
      }
    : { x: Math.round(settings.refWidth / 2), y: Math.round(settings.refHeight * 0.9) }
  console.log(
    `脚本步骤要点的「空白点」：(${emptyPoint.x}, ${emptyPoint.y})，该区块标准差 ${emptyBlock?.std.toFixed(1) ?? 'N/A'}（越低越空）`
  )

  // ── 5. 脚本引擎 ─────────────────────────────────────────────────────────
  banner('脚本引擎：跑一个最小任务（Engine + RunContext + 日志 + 留痕）')

  const runId = makeId('run').replace(/[^A-Za-z0-9_.-]/g, '')
  const script: ScriptDef = {
    id: 'smoke_min',
    name: '冒烟最小任务',
    description: '等待探针模板出现 → 带偏移点到空白处 → 留痕 → 回桌面。全程无害。',
    version: '1.0.0',
    templateSetId: set.id,
    refWidth: REF_WIDTH,
    refHeight: REF_HEIGHT,
    updatedAt: Date.now(),
    steps: [
      { id: 's1', kind: 'log', name: '开场', level: 'info', message: '冒烟最小任务开始。' },
      {
        id: 's2',
        kind: 'waitFor',
        name: '等待探针模板出现',
        cond: { kind: 'template', templateId: tplDef.id },
        waitMs: 8000,
        pollMs: 500
      },
      {
        id: 's3',
        kind: 'tapTemplate',
        name: '点中模板并按偏移落到空白处',
        templateId: tplDef.id,
        // 偏移把落点从模板中心挪到画面空白处：既真的走了 tapTemplate 的匹配+换算+点击，
        // 又保证手指不会落在任何图标上（不会误启动应用）。
        offset: {
          x: emptyPoint.x - (best.rect.x + Math.round(best.rect.w / 2)),
          y: emptyPoint.y - (best.rect.y + Math.round(best.rect.h / 2))
        },
        waitMs: 3000,
        afterDelayMs: 400
      },
      { id: 's4', kind: 'screenshot', name: '留痕', label: 'after-tap' },
      { id: 's5', kind: 'key', name: '回桌面', key: 'HOME' },
      { id: 's6', kind: 'log', name: '收尾', level: 'info', message: '冒烟最小任务结束。' }
    ]
  }

  const payload: WorkerAttachPayload = {
    runId,
    instanceIndex: target.index,
    serial,
    script,
    params: {},
    request: { scriptId: script.id, instanceIndex: target.index },
    settings,
    paths: {
      adbPath: settings.adbPath,
      templatesDir: paths.templatesDir,
      shotsDir: paths.shotsDir,
      logsDir: paths.logsDir
    },
    accountId: null,
    accountName: null
  }

  // ── 主进程侧的落盘适配（正式运行时由 orchestrator 干这件事）──────────────
  const pending: Promise<unknown>[] = []
  let logCount = 0
  let shotCount = 0
  const shotFiles: string[] = []

  const report = (m: WorkerToMain): void => {
    switch (m.type) {
      case 'persistLogs':
        logCount += m.entries.length
        pending.push(appendLogs(paths.logsDir, m.runId, m.entries))
        break
      case 'persistShot':
        shotCount += 1
        shotFiles.push(m.file)
        pending.push(saveShot(paths.shotsDir, m.runId, m.file, m.jpeg))
        break
      default:
        break
    }
  }

  let emitted = 0
  const emit = (m: WorkerToRenderer): void => {
    emitted += 1
    if (m.type === 'logs') {
      for (const e of m.entries) {
        console.log(`    [${e.level}] ${e.stepId ? `(${e.stepId}) ` : ''}${e.message}`)
      }
    }
  }

  // 这一段就是 src/worker/runner.ts 里的适配层，冒烟时在同进程内复刻一份
  // （runner.ts 一加载就要求 process.parentPort，只有 utilityProcess 里才有）。
  const deviceIo: DeviceIo = {
    capture: (s) => captureRaw(s),
    tap: (s, x, y) => tap(s, x, y),
    swipe: (s, x1, y1, x2, y2, d) => swipe(s, x1, y1, x2, y2, d),
    longPress: (s, x, y, d) => longPress(s, x, y, d),
    inputText: (s, t) => typeText(s, t),
    keyEvent: (s, k) => adbKey(s, k),
    launchApp: (s, pkg, cold) => launch(s, pkg, cold),
    stopApp: (s, pkg) => forceStop(s, pkg),
    foregroundPackage: (s) => foregroundPackage(s)
  }
  const visionIo: VisionIo = {
    prepareFrame: (r, o) =>
      prepareFrame(r, { refW: o.refWidth, refH: o.refHeight, shrink: o.shrink }),
    matchIn: (f, t, o) => matchIn(f, t, o)
  }

  const ctx = new RunContext({
    payload,
    templates: prepared,
    device: deviceIo,
    vision: visionIo,
    emit,
    report
  })
  const engine = new Engine(ctx, emit, report)

  const tRun = Date.now()
  await engine.run()
  const runMs = ms(tRun)
  ctx.logger.flush()
  ctx.dispose()
  await Promise.allSettled(pending)

  const snap = ctx.snapshot
  console.log(
    `\n执行结束：status=${snap.status} 耗时 ${runMs}ms 步骤 ${snap.stepDone}/${snap.stepTotal ?? '∞'}\n` +
      `  统计：截图 ${snap.stats.captures} 次，匹配 ${snap.stats.matches} 次（命中 ${snap.stats.matchHits}），` +
      `点击 ${snap.stats.taps} 次，重试 ${snap.stats.retries} 次\n` +
      `  日志 ${logCount} 条 → ${join(paths.logsDir, `${runId}.ndjson`)}\n` +
      `  留痕 ${shotCount} 张 → ${join(paths.shotsDir, runId)}/${shotFiles.join(', ')}\n` +
      `  推给面板的消息 ${emitted} 条（正式运行时走 MessagePort 直连渲染进程）` +
      (snap.error ? `\n  错误：${snap.error}` : '')
  )

  const engineOk = snap.status === 'succeeded' && logCount > 0 && shotCount > 0
  record(
    '5',
    '脚本引擎',
    engineOk,
    `status=${snap.status}，${snap.stepDone} 步，耗时 ${runMs}ms，截图 ${snap.stats.captures} 次 / ` +
      `匹配命中 ${snap.stats.matchHits}/${snap.stats.matches} / 点击 ${snap.stats.taps} 次；` +
      `日志 ${logCount} 条落盘到 ${runId}.ndjson，留痕 ${shotCount} 张` +
      (snap.error ? `；错误：${snap.error}` : '')
  )

  // ── 汇总 ────────────────────────────────────────────────────────────────
  banner('汇总')
  for (const c of checks) {
    console.log(`  ${c.ok ? '✅' : '❌'} [${c.no}] ${c.title}：${c.detail}`)
  }
  const allOk = checks.every((c) => c.ok)
  console.log(`\n${allOk ? '全部通过。' : '存在失败项，见上面的 ❌。'}`)

  await writeFile(
    join(DOCS_DIR, 'smoke-report.json'),
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        instance: { index: target.index, name: target.name, adbPort: target.adbPort, serial },
        device: dev,
        capture: {
          width: raw.width,
          height: raw.height,
          bytes,
          medianMs: capMs[1],
          noThrottleMs
        },
        template: tplDef,
        match: { positive: hit, negative: missed },
        input: {
          diffAfterAppSwitch: diff,
          diffAfterHome: diffBack,
          fgBefore,
          fgSwitch,
          fgAfter,
          emptyPoint
        },
        run: snap,
        checks
      },
      null,
      2
    ),
    'utf8'
  )
  console.log(`机器可读报告：${join(DOCS_DIR, 'smoke-report.json')}`)

  // 队列/节流里还挂着 unref 过的定时器，显式退出更干脆。
  // 注意：**不** adb disconnect —— 保持进入时的连接状态。
  process.exit(allOk ? 0 : 1)
}

main().catch((e: unknown) => {
  console.error('\n冒烟自检中断：', errText(e))
  if (e instanceof Error && e.stack) console.error(e.stack)
  for (const c of checks) {
    console.error(`  ${c.ok ? '✅' : '❌'} [${c.no}] ${c.title}：${c.detail}`)
  }
  process.exit(1)
})
