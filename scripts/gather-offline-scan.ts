/** 关键判据在全部 60 帧上的命中扫描：看有没有误命中（会让 G0 走错分支）。 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RawFrame } from '@shared/vision'
import { sharp } from '@vision/cv'
import { setTemplatesDir } from '@vision/index'
import { loadGatherTemplates, TPL } from '@main/game/gather/templates'
import { GatherSession, type GatherIo } from '@main/game/gather/session'
import { normalizeGatherConfig } from '@main/game/gather/config'
import { CARD, CREATE_TROOP, TROOP_PANEL, SEARCH_PANEL } from '@main/game/gather/geometry'

// 以 cwd 为工程根（npm run 保证 cwd 是工程根）；以前写死作者机器的绝对路径，换机器就找不到帧目录。
const ROOT = process.cwd()
class StaticIo implements GatherIo {
  constructor(public raw: RawFrame) {}
  async capture(): Promise<RawFrame> {
    return this.raw
  }
  async tap(): Promise<void> {}
  async tapMany(): Promise<void> {}
  async swipe(): Promise<void> {}
  async key(): Promise<void> {}
  async launchApp(): Promise<void> {}
  async foregroundPackage(): Promise<string | null> {
    return null
  }
}

const PROBES: [string, string, any][] = [
  ['世界地图', TPL.worldSearchIcon, undefined],
  ['城内', TPL.navMapToggle, undefined],
  ['城内(兽族B·透明底)', TPL.navMapToggleB, undefined],
  ['搜索面板', TPL.btnSearch, SEARCH_PANEL.anchorRoi],
  ['黑暗灵页', TPL.autoBtn, SEARCH_PANEL.anchorRoi],
  ['资源卡片', TPL.btnGather, CARD.anchorRoi],
  ['创建部队按钮', TPL.btnCreateTroop, undefined],
  ['创建部队页', TPL.titleCreateTroop, undefined],
  ['行军按钮', TPL.btnMarch, CREATE_TROOP.anchorRoi],
  ['部队面板', TPL.panelTitleTroop, TROOP_PANEL.titleRoi],
  ['退出确认框', TPL.dlgTitleNotice, undefined]
]

async function main(): Promise<void> {
  setTemplatesDir(join(ROOT, '.wl-data/templates'))
  const templates = await loadGatherTemplates({
    setId: 'tset_mtugr5sx0iwc',
    onWarn: () => undefined
  })
  const files = (await readdir(join(ROOT, '.tplkit/frames')))
    .filter((f) => f.endsWith('.png'))
    .sort()
  const counts = new Map<string, string[]>()

  for (const f of files) {
    const buf = await readFile(join(ROOT, '.tplkit/frames', f))
    const { data, info } = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const raw: RawFrame = {
      width: info.width,
      height: info.height,
      format: 1,
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      capturedAt: Date.now()
    }
    const s = new GatherSession({
      io: new StaticIo(raw),
      templates,
      config: normalizeGatherConfig({ safety: { maxCapturesPerCycle: 500 } }),
      log: () => undefined
    })
    const hits: string[] = []
    for (const [label, id, roi] of PROBES) {
      const m = await s.matchOptional(id, roi)
      if (m?.found) {
        hits.push(`${label}(${m.score})`)
        const arr = counts.get(label) ?? []
        arr.push(f)
        counts.set(label, arr)
      }
    }
    console.log(`${f.padEnd(24)} ${hits.join(' ') || '—'}`)
  }

  console.log('\n===== 各判据命中的帧 =====')
  for (const [label, arr] of counts)
    console.log(`${label.padEnd(14)} ${arr.length} 帧: ${arr.join(', ')}`)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
