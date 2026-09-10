/**
 * 资源统计识别 离线自检（★ 不碰模拟器）。
 *
 *   npm run check:resources            —— 全部断言
 *   npm run check:resources -- --seed  —— 另外把模板写进真实 .wl-data 的「万龙觉醒」模板集（同 id 覆盖，幂等）
 *
 * 覆盖：
 *   一、parseCnAmount / formatCnAmount 用例表
 *   二、layout.ts 手抄常量 与 resource-stats.json 一致
 *   三、把真实模板集整目录复制到临时目录 → seedResourceTemplates 入库 → loadGatherTemplates 能加载出字形集与界面模板
 *   四、界面模板正样本（来源帧）/ 负样本（世界地图或弹窗帧）分数
 *   五、res_04_stats.png 读出 4 行 × 2 列并与人工真值对照；res_02_items.png 负样本 8 格全 null 且不抛
 *   六、假 GatherIo 走完整流程（预检 → 道具 → 资源统计 → 读表 → BACK×2 → 校验）；以及三种「不该动屏幕」的失败场景
 *
 * 打包参数与 check:alerts:build 相同（含 --alias:electron=./scripts/stubs/electron-offline.mjs）。
 */

import { cp, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CN_AMOUNT_CASES, formatCnAmount, parseCnAmount, type ResourceType } from '@shared/resources'
import type { AndroidKey } from '@shared/script'
import type { RawFrame, Rect } from '@shared/vision'
import { sharp } from '@vision/cv'
import { matchIn, prepareFrame, readSet } from '@vision/index'
import { loadGatherTemplates, type GatherTemplates } from '@main/game/gather/templates'
import type { GatherIo } from '@main/game/gather/session'
import {
  RESOURCE_STATS_LAYOUT,
  RES_GLYPH,
  RES_TPL,
  invalidateResourceUnitTemplates,
  loadResourceUnitTemplates,
  readResourceStatsFromFrame,
  readResourceStatsPanel,
  seedResourceTemplates
} from '@main/game/resources/index'

const ROOT = process.cwd()
const SHOTS_DIR = join(ROOT, 'docs', 'game', 'shots', 'resources')
const REAL_TEMPLATES_DIR = join(ROOT, '.wl-data', 'templates')
const SPEC_FILE = join(ROOT, 'resources', 'game-data', 'resource-stats.json')
const GAME = 'com.lilithgames.samo.android.cn'

/** 人工真值（res_04_stats.png）。 */
const TRUTH: Record<ResourceType, { item: number; total: number; rawItem: string; rawTotal: string }> = {
  gold: { item: 290_000_000, total: 1_110_000_000, rawItem: '2.9亿', rawTotal: '11.1亿' },
  wood: { item: 320_000_000, total: 410_000_000, rawItem: '3.2亿', rawTotal: '4.1亿' },
  iron: { item: 200_000_000, total: 2_240_000_000, rawItem: '2.0亿', rawTotal: '22.4亿' },
  mana: { item: 620_000_000, total: 720_000_000, rawItem: '6.2亿', rawTotal: '7.2亿' }
}

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}${extra ? `  ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? `  ${extra}` : ''}`)
  }
}

const frameCache = new Map<string, RawFrame>()
async function frame(name: string): Promise<RawFrame> {
  const hit = frameCache.get(name)
  if (hit) return hit
  const buf = await readFile(join(SHOTS_DIR, name))
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const f: RawFrame = {
    width: info.width,
    height: info.height,
    format: 1,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    capturedAt: Date.now()
  }
  frameCache.set(name, f)
  return f
}

/** 按「输入动作次数」推进画面的假 IO：两次输入之间画面不变。 */
class ScriptedIo implements GatherIo {
  cursor = 0
  readonly actions: string[] = []
  captures = 0
  constructor(
    private readonly script: string[],
    private readonly fg: string | null = GAME
  ) {}
  private advance(what: string): void {
    this.actions.push(what)
    if (this.cursor < this.script.length - 1) this.cursor++
  }
  async capture(): Promise<RawFrame> {
    this.captures++
    return frame(this.script[this.cursor])
  }
  async tap(x: number, y: number): Promise<void> {
    this.advance(`tap ${x},${y}`)
  }
  async tapMany(p: [number, number][]): Promise<void> {
    this.advance(`tapMany x${p.length}`)
  }
  async swipe(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    this.advance(`swipe ${x1},${y1}->${x2},${y2}`)
  }
  async key(k: AndroidKey): Promise<void> {
    this.advance(`key ${k}`)
  }
  async launchApp(): Promise<void> {
    this.advance('launchApp')
  }
  async foregroundPackage(): Promise<string | null> {
    return this.fg
  }
}

const quietLog = (): void => undefined
const shotLabels: string[] = []
const onShot = (label: string): void => {
  shotLabels.push(label)
}

function inside(p: string, box: Rect): boolean {
  const m = /^tap (\d+),(\d+)$/.exec(p)
  if (!m) return false
  const x = Number(m[1])
  const y = Number(m[2])
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h
}

async function main(): Promise<void> {
  const seed = process.argv.includes('--seed')

  // ══ 一、金额解析 ══════════════════════════════════════════════════════════
  console.log('【一】parseCnAmount / formatCnAmount')
  for (const [input, expected] of CN_AMOUNT_CASES) {
    const got = parseCnAmount(input)
    ok(`parseCnAmount(${JSON.stringify(input)}) = ${got}`, got === expected, got === expected ? '' : `期望 ${expected}`)
  }
  ok('formatCnAmount(1_110_000_000) = 11.1亿', formatCnAmount(1_110_000_000) === '11.1亿')
  ok('formatCnAmount(300_000_000) = 3亿', formatCnAmount(300_000_000) === '3亿')
  ok('formatCnAmount(91_290_000) = 9129万', formatCnAmount(91_290_000) === '9129万')
  ok('formatCnAmount(59_677) = 6万（≥1万 取整万）', formatCnAmount(59_677) === '6万')
  ok('formatCnAmount(9_999) = 9,999', formatCnAmount(9_999) === '9,999')
  ok('formatCnAmount(null) = —', formatCnAmount(null) === '—')
  for (const t of Object.values(TRUTH)) {
    ok(`往返 ${t.rawTotal}`, formatCnAmount(parseCnAmount(t.rawTotal)) === t.rawTotal.replace('.0亿', '亿'))
  }

  // ══ 二、layout.ts 与 json 一致 ═══════════════════════════════════════════
  console.log('【二】layout.ts 手抄常量 与 resource-stats.json 一致')
  const spec = JSON.parse(await readFile(SPEC_FILE, 'utf8'))
  const L = RESOURCE_STATS_LAYOUT
  ok('refWidth/refHeight', L.refWidth === spec.refWidth && L.refHeight === spec.refHeight)
  ok('nav.itemsTap', JSON.stringify(L.nav.itemsTap) === JSON.stringify(spec.nav.itemsTap))
  ok('itemsPage.statsButtonTap', JSON.stringify(L.itemsPage.statsButtonTap) === JSON.stringify(spec.itemsPage.statsButtonTap))
  ok('itemsPage.resourceCategoryTap', JSON.stringify(L.itemsPage.resourceCategoryTap) === JSON.stringify(spec.itemsPage.resourceCategoryTap))
  ok('dialog.closeTap/backPresses', JSON.stringify(L.dialog) === JSON.stringify({ closeTap: spec.dialog.closeTap, backPresses: spec.dialog.backPresses }))
  ok('rows', JSON.stringify(L.rows) === JSON.stringify(spec.rows))
  ok('rowPitchY/cellRoi', L.rowPitchY === spec.rowPitchY && JSON.stringify(L.cellRoi) === JSON.stringify(spec.cellRoi))
  for (const c of ['item', 'total'] as const) {
    const j = spec.columns[c]
    ok(`columns.${c}`, L.columns[c].centerX === j.centerX && L.columns[c].x === j.x && L.columns[c].w === j.w)
  }
  ok('模板 id 与 RES_TPL 一致', [RES_TPL.btnResStats, RES_TPL.titleResStats, RES_TPL.unitYi, RES_TPL.unitWan, RES_TPL.navItems].every((id) => spec.templates.some((t: { id: string }) => t.id === id)))
  ok('字形集名与 RES_GLYPH 一致', spec.glyphs.setName === RES_GLYPH && spec.glyphs.tags.includes('digit') && spec.glyphs.tags.includes(RES_GLYPH))

  // ══ 三、seed 进临时模板集 ════════════════════════════════════════════════
  console.log('【三】seedResourceTemplates → loadGatherTemplates')
  const tmp = await mkdtemp(join(tmpdir(), 'wl-resources-check-'))
  await cp(REAL_TEMPLATES_DIR, tmp, { recursive: true })
  const seeded = await seedResourceTemplates({ templatesDir: tmp, shotsDir: SHOTS_DIR, specFile: SPEC_FILE, log: quietLog })
  const setId = seeded.setId
  ok(`seed 入库 ${seeded.saved.length} 张`, seeded.saved.length >= 18, seeded.saved.join(' '))
  ok('缺素材的条目被跳过（5 / 8 / comma / 万）', ['dig_resstat_5', 'dig_resstat_8', 'dig_resstat_comma', RES_TPL.unitWan].every((id) => seeded.skipped.includes(id)), seeded.skipped.join(' '))
  const manifest = await readSet(setId)
  const lowStd = manifest.templates.filter((t) => seeded.saved.includes(t.id) && (t.std ?? 0) < 12)
  ok('入库模板 std 全部 ≥ 12', lowStd.length === 0, lowStd.map((t) => `${t.id}=${t.std}`).join(' '))
  const unitDef = manifest.templates.find((t) => t.id === RES_TPL.unitYi)
  ok('单位「亿」没有 digit 标签（不进字形集）', !!unitDef && !(unitDef.tags ?? []).includes('digit'))

  const warns: string[] = []
  const templates: GatherTemplates = await loadGatherTemplates({ templatesDir: tmp, setId, onWarn: (m) => warns.push(m) })
  ok('字形集 dig_resstat 已加载', templates.hasGlyphs(RES_GLYPH))
  const chars = templates.requireGlyphs(RES_GLYPH).glyphs.map((g) => g.char).sort().join('')
  ok('字形集字符 = .0123467 9（缺 5 8）', chars === '.01234679', chars)
  ok('界面模板 tpl_btn_res_stats / tpl_title_res_stats 已加载', templates.has(RES_TPL.btnResStats) && templates.has(RES_TPL.titleResStats))
  ok('可选模板 tpl_nav_items / tpl_btn_close_res_stats / 行标签 已加载', [RES_TPL.navItems, RES_TPL.btnCloseResStats, 'tpl_label_res_gold', 'tpl_label_res_mana'].every((id) => templates.has(id)))
  ok('loadGatherTemplates 没有因资源统计模板报「后缀无法解析」', !warns.some((w) => w.includes('resstat') && w.includes('后缀')), warns.filter((w) => w.includes('resstat')).join(' | '))
  invalidateResourceUnitTemplates()
  const units = await loadResourceUnitTemplates(setId)
  ok('单位「亿」按 shrink=1 编译', units.units.get(RES_TPL.unitYi)?.shrink === 1 && units.missing.includes(RES_TPL.unitWan))

  // ══ 四、界面模板正/负样本 ══════════════════════════════════════════════════
  console.log('【四】界面模板 正样本 / 负样本')
  const f2 = async (name: string) => prepareFrame(await frame(name), { refW: 2560, refH: 1440, shrink: 2 })
  const fStats = await f2('res_04_stats.png')
  const fItems = await f2('res_02_items.png')
  const fMap = await f2('res_06_back2.png')
  const fBack1 = await f2('res_05_back1.png')
  const cases: Array<[string, typeof fStats, typeof fStats]> = [
    [RES_TPL.titleResStats, fStats, fMap],
    [RES_TPL.btnResStats, fItems, fMap],
    [RES_TPL.btnCloseResStats, fStats, fItems],
    [RES_TPL.titleItemsRes, fItems, fStats],
    [RES_TPL.navItems, fMap, fStats],
    ['tpl_label_res_gold', fStats, fItems],
    ['tpl_label_res_mana', fStats, fMap]
  ]
  for (const [id, pos, neg] of cases) {
    const tpl = templates.require(id)
    const mp = await matchIn(pos, tpl)
    const mn = await matchIn(neg, tpl, { threshold: 0.01 })
    ok(`${id} 正样本命中 ${mp.score} / 负样本 ${mn.score}`, mp.found && mp.score >= 0.9 && mn.score < 0.6)
  }
  {
    const mTitle = await matchIn(fBack1, templates.require(RES_TPL.titleResStats))
    const mBtn = await matchIn(fBack1, templates.require(RES_TPL.btnResStats))
    ok('res_05_back1（BACK 一次）：标题消失、按钮仍在', !mTitle.found && mBtn.found)
    const mMap = await matchIn(fMap, templates.require('tpl_nav_city_toggle'))
    ok('res_06_back2（BACK 两次）：世界地图判据命中', mMap.found, `${mMap.score}`)
  }

  // ══ 五、纯识别 ═══════════════════════════════════════════════════════════
  console.log('【五】readResourceStatsFromFrame')
  const at = Date.now()
  const snap = await readResourceStatsFromFrame(await frame('res_04_stats.png'), templates, 3, at)
  ok('快照形状', snap.instanceIndex === 3 && snap.at === at && snap.source === 'panel' && snap.rows.length === 4)
  for (const row of snap.rows) {
    const t = TRUTH[row.type]
    ok(`${row.type} 道具 ${row.rawItem} = ${row.itemTotal}`, row.itemTotal === t.item && row.rawItem === t.rawItem)
    ok(`${row.type} 资源 ${row.rawTotal} = ${row.total}`, row.total === t.total && row.rawTotal === t.rawTotal)
  }
  ok('warnings 为空', snap.warnings.length === 0, snap.warnings.join('；'))

  const neg = await readResourceStatsFromFrame(await frame('res_02_items.png'), templates, 0, at)
  ok('负样本（资源页）8 格全 null 且不抛', neg.rows.every((r) => r.itemTotal == null && r.total == null))
  ok('负样本 warnings 每格都有中文原因', neg.warnings.filter((w) => w.includes('读不出')).length === 8)
  ok('负样本提示缺字形 5/8', neg.warnings.some((w) => w.includes('缺 5/8')))

  // ══ 六、完整流程（假 IO）═════════════════════════════════════════════════
  // ★ 用真实时钟：GatherSession.sleep 按 now() 算剩余时间，假时钟会让 setTimeout 收到负数。
  //   只有「道具页没打开」那个场景要吃满两次 6s 的 waitFor，其余场景都在第一帧就命中/失败。
  console.log('【六】readResourceStatsPanel 假 IO（含一个 ~13s 的超时场景）')
  {
    const io = new ScriptedIo(['res_06_back2.png', 'res_02_items.png', 'res_04_stats.png', 'res_05_back1.png', 'res_06_back2.png'])
    shotLabels.length = 0
    const r = await readResourceStatsPanel({ io, templates, instanceIndex: 1, log: quietLog, onShot })
    ok('流程读出 8 格真值', r.rows.every((row) => row.itemTotal === TRUTH[row.type].item && row.total === TRUTH[row.type].total))
    ok('流程 warnings 为空（BACK×2 干净还原）', r.warnings.length === 0, r.warnings.join('；'))
    ok('动作序列 = tap 道具 → tap 资源统计 → BACK → BACK', io.actions.length === 4 && io.actions[2] === 'key BACK' && io.actions[3] === 'key BACK', io.actions.join(' | '))
    ok('第一下点在底部导航「道具」图标内', inside(io.actions[0], { x: 2030, y: 1295, w: 145, h: 95 }), io.actions[0])
    ok('第二下点在「资源统计」按钮内', inside(io.actions[1], { x: 1480, y: 234, w: 200, h: 62 }), io.actions[1])
    ok('没有留痕失败帧', shotLabels.length === 0, shotLabels.join(' '))
    ok(`截图数 ${io.captures} ≤ 15`, io.captures <= 15)
  }
  {
    // 停在弹窗上（不在主界面）：预检失败，一个动作都不发。
    const io = new ScriptedIo(['res_04_stats.png'])
    let msg = ''
    try {
      await readResourceStatsPanel({ io, templates, instanceIndex: 1, log: quietLog })
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    ok('弹窗开着时抛「当前不在主界面」', msg.includes('当前不在主界面'), msg)
    ok('且 tap/key 次数为 0', io.actions.length === 0, io.actions.join(' | '))
  }
  {
    // 停在资源页（二级页面，不是主界面）：同样不动。
    const io = new ScriptedIo(['res_02_items.png'])
    let msg = ''
    try {
      await readResourceStatsPanel({ io, templates, instanceIndex: 1, log: quietLog })
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    ok('资源页上抛「当前不在主界面」', msg.includes('当前不在主界面') && io.actions.length === 0, msg)
  }
  {
    // 前台不是游戏。
    const io = new ScriptedIo(['res_06_back2.png'], 'com.android.launcher')
    let msg = ''
    try {
      await readResourceStatsPanel({ io, templates, instanceIndex: 1, log: quietLog })
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    ok('前台不是游戏时抛「游戏不在前台」且不动', msg.includes('游戏不在前台') && io.actions.length === 0, msg)
  }
  {
    // 点了「道具」但画面一直不变：报错并还原（世界地图仍在 ⇒ 还原成功）。
    const io = new ScriptedIo(['res_06_back2.png'])
    shotLabels.length = 0
    let msg = ''
    try {
      await readResourceStatsPanel({ io, templates, instanceIndex: 1, log: quietLog, onShot })
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    ok('道具页没打开时抛中文错误', msg.includes('没打开资源页'), msg)
    ok('失败后仍走了 BACK×2 还原', io.actions.filter((a) => a === 'key BACK').length === 2, io.actions.join(' | '))
    ok('留痕 res-items-page-missing', shotLabels.includes('res-items-page-missing'), shotLabels.join(' '))
  }

  // ══ 七、可选：写进真实模板集 ═════════════════════════════════════════════
  if (seed) {
    console.log('【七】--seed：写入真实模板集')
    const real = await seedResourceTemplates({
      templatesDir: REAL_TEMPLATES_DIR,
      shotsDir: SHOTS_DIR,
      specFile: SPEC_FILE,
      log: (level, m) => console.log(`  [${level}] ${m}`)
    })
    ok(`真实模板集 ${real.setId} 已写入 ${real.saved.length} 张`, real.saved.length >= 18)
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('自检崩溃：', e)
  process.exitCode = 1
})
