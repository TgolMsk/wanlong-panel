/** 离线回放校验：拿 .tplkit/frames 里的真机截图跑一遍各个读取函数。不碰模拟器。 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AndroidKey } from '@shared/script'
import type { RawFrame } from '@shared/vision'
import { sharp } from '@vision/cv'
import { setTemplatesDir } from '@vision/index'
import { loadGatherTemplates, GLYPH, TPL } from '@main/game/gather/templates'
import { CITY_TEMPLATES } from '@main/game/gather/navigation'
import { GatherSession, type GatherIo } from '@main/game/gather/session'
import { normalizeGatherConfig } from '@main/game/gather/config'
import { readCard, readAutoCheckbox } from '@main/game/gather/card'
import { readSliderLevel, findSearchAnchor, classifyCategory } from '@main/game/gather/searchPanel'
import { readTroopPanel } from '@main/game/gather/troopPanel'
import { CREATE_TROOP, VALUE_RIGHT_OF_LABEL } from '@main/game/gather/geometry'
import { parseGrouped, parseGroupedRatio } from '@main/game/vision/digits'
import { parseHmsFlexible } from '@main/game/gather/parse'

// 以 cwd 为工程根（npm run 保证 cwd 是工程根）；以前写死作者机器的绝对路径，换机器就找不到帧目录。
const ROOT = process.cwd()
const FRAMES = join(ROOT, '.tplkit/frames')

async function loadFrame(name: string): Promise<RawFrame> {
  const buf = await readFile(join(FRAMES, name))
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.channels !== 4) throw new Error(`${name} 通道数 ${info.channels}`)
  return {
    width: info.width,
    height: info.height,
    format: 1,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    capturedAt: Date.now()
  }
}

class StaticIo implements GatherIo {
  constructor(public raw: RawFrame) {}
  async capture(): Promise<RawFrame> {
    return this.raw
  }
  async tap(): Promise<void> {}
  async tapMany(): Promise<void> {}
  async swipe(): Promise<void> {}
  async key(_k: AndroidKey): Promise<void> {}
  async launchApp(): Promise<void> {}
  async foregroundPackage(): Promise<string | null> {
    return 'com.lilithgames.samo.android.cn'
  }
}

let pass = 0
let fail = 0
function check(name: string, actual: unknown, expect: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expect)
  if (a === e) {
    pass++
    console.log(`  ✅ ${name} = ${a}`)
  } else {
    fail++
    console.log(`  ❌ ${name} = ${a}  期望 ${e}`)
  }
}
function info(name: string, v: unknown): void {
  console.log(`  ·  ${name} = ${JSON.stringify(v)}`)
}

async function session(frameName: string, templates: any): Promise<GatherSession> {
  const raw = await loadFrame(frameName)
  return new GatherSession({
    io: new StaticIo(raw),
    templates,
    config: normalizeGatherConfig({ safety: { maxCapturesPerCycle: 500 } }),
    log: () => undefined
  })
}

async function main(): Promise<void> {
  setTemplatesDir(join(ROOT, '.wl-data/templates'))
  const templates = await loadGatherTemplates({
    setId: 'tset_mtugr5sx0iwc',
    onWarn: (m) => console.log(`  [warn] ${m}`)
  })
  console.log(
    `模板集加载：界面 ${templates.ui.size} 张，字形集 ${[...templates.glyphSets.keys()].join(', ')}`
  )
  for (const [k, v] of templates.glyphSets) {
    console.log(`  字形集 ${k}: ${v.glyphs.map((g) => g.char).join('')} (中位宽 ${v.medianGlyphW})`)
  }

  // ── 资源点卡片 ──
  console.log(
    '\n【卡片】s05_card_wood8（伐木场 8 级 / 储量 1,260,000 / 采集者无 / [T89S] / 615,535 / 已勾选）'
  )
  {
    const s = await session('s05_card_wood8.png', templates)
    const anchor = await (await import('@main/game/gather/card')).waitForCard(s, 0)
    info('采集按钮锚点', anchor)
    if (anchor) {
      const c = await readCard(s, anchor, true)
      check('资源类型', c.resource, 'wood')
      check('等级', c.level, 8)
      check('储量', c.storage, 1260000)
      check('采集者空闲', c.gathererFree, true)
      check('联盟', c.alliance, 'foreign')
      check('坐标', c.coord, '615,535')
      check('自动采集勾选', c.autoChecked, true)
    }
  }

  console.log('\n【卡片】s06_cb_off（同一张卡，勾选框被点掉）')
  {
    const s = await session('s06_cb_off.png', templates)
    const anchor = await (await import('@main/game/gather/card')).waitForCard(s, 0)
    if (anchor) check('自动采集勾选', await readAutoCheckbox(s, anchor), false)
  }

  for (const [f, want] of [
    ['s17_card_gold.png', 'gold'],
    ['s19_card_iron.png', 'iron'],
    ['s21_card_mana.png', 'mana']
  ] as const) {
    console.log(`\n【卡片】${f}`)
    const s = await session(f, templates)
    const anchor = await (await import('@main/game/gather/card')).waitForCard(s, 0)
    info('锚点', anchor)
    if (anchor) {
      const c = await readCard(s, anchor, true)
      check('资源类型', c.resource, want)
      info('等级/储量/采集者/联盟/坐标', [c.level, c.storage, c.gathererFree, c.alliance, c.coord])
    }
  }

  // ── 搜索面板等级 ──
  console.log('\n【搜索面板】等级读数 + 分类识别')
  for (const [f, want] of [
    ['s04_lv3.png', 3],
    ['s04_lv4.png', 4],
    ['s04_lv5.png', 5],
    ['s04_lv6.png', 6],
    ['s04_lv7.png', 7],
    ['s04_lvmax.png', 8],
    ['s02_lv5.png', 5]
  ] as const) {
    const s = await session(f, templates)
    const anchor = await findSearchAnchor(s)
    if (!anchor) {
      console.log(`  ❌ ${f} 找不到搜索按钮锚点`)
      fail++
      continue
    }
    const lv = await readSliderLevel(s, anchor, 15, 1)
    check(`${f} 等级(锚点x=${anchor.x}, 分类=${classifyCategory(anchor.x)})`, lv, want)
  }
  for (const [f, want] of [
    ['s16_gold.png', 'gold'],
    ['s18_iron.png', 'iron'],
    ['s20_mana.png', 'mana'],
    ['s22_wood.png', 'wood'],
    ['s03_dark.png', 'darkspirit']
  ] as const) {
    const s = await session(f, templates)
    const anchor = await findSearchAnchor(s)
    if (!anchor) {
      console.log(`  ❌ ${f} 找不到搜索按钮锚点`)
      fail++
      continue
    }
    check(`${f} 分类`, classifyCategory(anchor.x), want)
    const auto = await s.matchOptional(TPL.autoBtn)
    info(`${f} 黑暗灵否定判据 tpl_auto_btn`, auto?.found)
  }

  // ── 部队管理面板 ──
  for (const f of [
    's11_panel_gathering.png',
    's10_panel_marching.png',
    's12_recall.png',
    's15_afterpanel.png'
  ]) {
    console.log(`\n【部队管理】${f}`)
    const s = await session(f, templates)
    const title = await s.matchOptional(TPL.panelTitleTroop)
    if (!title?.found) {
      console.log('  · 该帧不是部队管理面板，跳过')
      continue
    }
    try {
      const p = await readTroopPanel(s)
      info('队列', `${p.queueUsed}/${p.queueTotal}`)
      for (const r of p.rows) info(`行${r.index}`, [r.status, r.remainingSec, r.coord, r.stamina])
      for (const w of p.warnings) console.log(`  [warn] ${w}`)
    } catch (e) {
      console.log(`  ❌ ${(e as Error).message}`)
      fail++
    }
  }

  // ── 创建部队页 ──
  console.log('\n【创建部队页】s09_create（行军 00:00:25）')
  {
    const s = await session('s09_create.png', templates)
    const m = await s.match(TPL.btnMarch, CREATE_TROOP.anchorRoi)
    info('行军按钮命中', [m.found, m.x, m.y, m.score])
    if (m.found) {
      const off = CREATE_TROOP.travelTimeRoi
      const r = await s.readDigitsOnce(
        GLYPH.marchBtn,
        { x: m.x + off.x, y: m.y + off.y, w: off.w, h: off.h },
        0.7
      )
      check('行军耗时串', parseHmsFlexible(r.text), 25)
      info('原始串/最低分', [r.text, r.minScore])
    }
    for (const [label, id, parse] of [
      ['兵力', TPL.labelTroops, parseGroupedRatio],
      ['负载量', TPL.labelLoad, parseGrouped]
    ] as const) {
      const lm = await s.matchOptional(id)
      if (!lm?.found) {
        console.log(`  ❌ ${label} 标签未命中`)
        fail++
        continue
      }
      const roi = {
        x: lm.x + lm.w + VALUE_RIGHT_OF_LABEL.dx,
        y: lm.y + VALUE_RIGHT_OF_LABEL.dy,
        w: VALUE_RIGHT_OF_LABEL.w,
        h: VALUE_RIGHT_OF_LABEL.h
      }
      const rd = await s.readDigitsOnce(GLYPH.dark20, roi, 0.7)
      info(`${label} 串`, [rd.text, parse(rd.text), rd.minScore])
    }
  }

  // ── 导航判据 ──
  console.log('\n【导航】')
  for (const f of ['s00_now.png', 's24_city.png', 's29_endstate.png', 's08_bubble.png']) {
    const s = await session(f, templates)
    const map = await s.matchOptional(TPL.worldSearchIcon)
    const city = await s.bestOf(CITY_TEMPLATES)
    const card = await s.matchOptional(TPL.btnGather)
    info(f, { 世界地图: map?.found, 城内: city ? city.id : false, 卡片: card?.found })
  }

  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
