/** runGatherCycle 全流程离线干跑 + 决策逻辑单测。不碰模拟器。 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AndroidKey } from '@shared/script'
import type { RawFrame } from '@shared/vision'
import { sharp } from '@vision/cv'
import { setTemplatesDir } from '@vision/index'
import { loadGatherTemplates } from '@main/game/gather/templates'
import { GatherSession, type GatherIo } from '@main/game/gather/session'
import {
  normalizeGatherConfig,
  DEFAULT_GATHER_CONFIG,
  computeSearchFloor
} from '@main/game/gather/config'
import { validateCard, type CardReading } from '@main/game/gather/card'
import { relaxSearchFloor } from '@main/game/gather/searchPanel'
import { runGatherCycle } from '@main/game/gather/flow'
import { readTroopPanel } from '@main/game/gather/troopPanel'
import { planWake, toMarchRecords } from '@main/game/gather/eta'
import { createRuntimeState } from '@main/game/gather/types'

// 以 cwd 为工程根（npm run 保证 cwd 是工程根）；以前写死作者机器的绝对路径，换机器就找不到帧目录。
const ROOT = process.cwd()
const cache = new Map<string, RawFrame>()
async function frame(name: string): Promise<RawFrame> {
  const hit = cache.get(name)
  if (hit) return hit
  const buf = await readFile(join(ROOT, '.tplkit/frames', name))
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const f: RawFrame = {
    width: info.width,
    height: info.height,
    format: 1,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    capturedAt: Date.now()
  }
  cache.set(name, f)
  return f
}

let pass = 0,
  fail = 0
function check(name: string, actual: unknown, expect: unknown): void {
  const a = JSON.stringify(actual),
    e = JSON.stringify(expect)
  if (a === e) {
    pass++
    console.log(`  ✅ ${name} = ${a}`)
  } else {
    fail++
    console.log(`  ❌ ${name} = ${a} 期望 ${e}`)
  }
}

/** 按「输入动作次数」推进的脚本化 IO：两次输入之间画面不变，正好模拟真机。 */
class ScriptedIo implements GatherIo {
  cursor = 0
  readonly actions: string[] = []
  constructor(private readonly script: string[]) {}
  private advance(what: string): void {
    this.actions.push(what)
    if (this.cursor < this.script.length - 1) this.cursor++
  }
  async capture(): Promise<RawFrame> {
    return frame(this.script[this.cursor])
  }
  async tap(x: number, y: number): Promise<void> {
    this.advance(`tap ${x},${y}`)
  }
  async tapMany(p: [number, number][]): Promise<void> {
    this.advance(`tapMany x${p.length} @${p[0]?.[0]},${p[0]?.[1]}`)
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
    return 'com.lilithgames.samo.android.cn'
  }
}

async function main(): Promise<void> {
  setTemplatesDir(join(ROOT, '.wl-data/templates'))
  const templates = await loadGatherTemplates({
    setId: 'tset_mtugr5sx0iwc',
    onWarn: () => undefined
  })

  // ══ 1. 决策逻辑单测（不需要图像）══════════════════════════════════════
  console.log('【单测】等级判据必须是 >= 而不是 ==')
  {
    const cfg = normalizeGatherConfig({
      thresholds: { allianceTerritory: 'any', minStorage: 300000 }
    })
    const entry = cfg.resources.find((r) => r.type === 'wood')!
    const base: CardReading = {
      anchor: { x: 0, y: 0 },
      resource: 'wood',
      level: 8,
      storage: 1260000,
      gathererFree: true,
      alliance: 'unknown',
      coord: '615,535',
      autoChecked: true
    }
    check('等级 8 >= 下限 7 → 通过', validateCard(cfg, entry, base, 7, new Set()).ok, true)
    check('等级 8 >= 下限 8 → 通过', validateCard(cfg, entry, base, 8, new Set()).ok, true)
    check(
      '等级 8 >= 下限 5 → 通过（不因「高于下限」被拒）',
      validateCard(cfg, entry, base, 5, new Set()).ok,
      true
    )
    check(
      '等级 6 < 下限 7 → 拒绝',
      validateCard(cfg, entry, { ...base, level: 6 }, 7, new Set()).ok,
      false
    )
    check(
      '采集者非空 → 拒绝',
      validateCard(cfg, entry, { ...base, gathererFree: false }, 7, new Set()).ok,
      false
    )
    check(
      '储量不足 → 拒绝',
      validateCard(cfg, entry, { ...base, storage: 100 }, 7, new Set()).ok,
      false
    )
    check('坐标重复 → 拒绝', validateCard(cfg, entry, base, 7, new Set(['615,535'])).ok, false)
    const wrong = validateCard(cfg, entry, { ...base, resource: 'gold' }, 7, new Set())
    check('资源类型不符 → wrongCategory', wrong.ok === false ? wrong.kind : null, 'wrongCategory')
    const unknownAbort = normalizeGatherConfig({
      thresholds: { allianceTerritory: 'any' },
      safety: { onUnknownLevel: 'abort' }
    })
    const r1 = validateCard(unknownAbort, entry, { ...base, level: null }, 7, new Set())
    check('等级读不出 + abort → abort', r1.ok === false ? r1.kind : null, 'abort')
    const r2 = validateCard(cfg, entry, { ...base, level: null }, 7, new Set())
    check('等级读不出 + acceptCard → 通过', r2.ok, true)
    // 联盟策略
    const ownOnly = normalizeGatherConfig({ thresholds: { allianceTerritory: 'own-only' } })
    check(
      'own-only + 中立 → 拒绝',
      validateCard(ownOnly, entry, { ...base, alliance: 'neutral' }, 7, new Set()).ok,
      false
    )
    // 显式指定策略来测这条分支 —— 不要依赖默认值（默认已按用户裁定改为 'any'）。
    const ownNeutral = normalizeGatherConfig({
      thresholds: { allianceTerritory: 'own-and-neutral' }
    })
    check(
      'own-and-neutral + 中立 → 通过',
      validateCard(ownNeutral, entry, { ...base, alliance: 'neutral' }, 7, new Set()).ok,
      true
    )
    check(
      'own-and-neutral + 他方 → 拒绝',
      validateCard(ownNeutral, entry, { ...base, alliance: 'foreign' }, 7, new Set()).ok,
      false
    )
    // ★ 锁死用户裁定：默认配置下任何领地都可采，联盟不构成拒绝理由。
    //   这三条一旦失败，说明有人把 allianceTerritory 的默认值改回了过滤策略。
    const byDefault = normalizeGatherConfig({})
    check('默认策略 = any', byDefault.thresholds.allianceTerritory, 'any')
    check(
      '默认 + 他方联盟 → 通过（不筛联盟）',
      validateCard(byDefault, entry, { ...base, alliance: 'foreign' }, 7, new Set()).ok,
      true
    )
    check(
      '默认 + 本方联盟 → 通过',
      validateCard(byDefault, entry, { ...base, alliance: 'own' }, 7, new Set()).ok,
      true
    )
  }

  console.log('\n【单测】下限计算与放宽')
  {
    const p = DEFAULT_GATHER_CONFIG.levelPolicy
    check('maxLv=8 offset=-1 → 下限 7', computeSearchFloor(p, 8), 7)
    check('maxLv=10 offset=-1 → 下限 9', computeSearchFloor(p, 10), 9)
    check('放宽 7 → 6', relaxSearchFloor(p, 7, 1), 6)
    check('放宽到 minLevel(5) 之下 → null（放弃）', relaxSearchFloor(p, 5, 1), null)
    const abs = normalizeGatherConfig({
      levelPolicy: { mode: 'absolute', level: 6, minLevel: 5, allowRelax: false } as any
    }).levelPolicy
    check('absolute + 不允许放宽 → null', relaxSearchFloor(abs, 6, 1), null)
  }

  console.log('\n【单测】唤醒时刻（宁晚勿早）')
  {
    const cfg = normalizeGatherConfig({})
    const now = 1_000_000_000_000
    const st = createRuntimeState()
    st.travelTimeByCoord['615,535'] = 64
    const reading = {
      queueUsed: 1,
      queueTotal: 5,
      sampledAt: now,
      warnings: [],
      rows: [
        {
          index: 1,
          status: 'gathering' as const,
          remainingSec: 600,
          coord: '615,535',
          stamina: null,
          sampledAt: now
        }
      ]
    }
    const recs = toMarchRecords(reading, st, cfg)
    check('freeAt = 采样 + 剩余600s + 回程64s', recs[0].freeAt! - now, (600 + 64) * 1000)
    const plan = planWake(cfg, now, recs, 0, () => 0)
    check('唤醒 = freeAt + slack60s', plan.at - now, (600 + 64 + 60) * 1000)
    const stale = planWake(cfg, now + 800_000, recs, 0, () => 0)
    check('ETA 已过期 → 退避 30s', stale.at - (now + 800_000), 30_000)
  }

  // ══ 2. 全 25 帧部队管理面板回放 ═══════════════════════════════════════
  console.log('\n【回放】部队管理面板时间序列')
  {
    const files = (await readdir(join(ROOT, '.tplkit/frames')))
      .filter((f) => /^s1[34]_/.test(f))
      .sort()
    let okRows = 0,
      badRows = 0
    for (const f of files) {
      const s = new GatherSession({
        io: {
          ...new (class {})(),
          capture: async () => frame(f),
          tap: async () => {},
          tapMany: async () => {},
          swipe: async () => {},
          key: async () => {},
          launchApp: async () => {},
          foregroundPackage: async () => null
        } as GatherIo,
        templates,
        config: normalizeGatherConfig({ safety: { maxCapturesPerCycle: 500 } }),
        log: () => undefined
      })
      try {
        const p = await readTroopPanel(s)
        const desc = p.rows
          .map((r) => `${r.status}/${r.remainingSec ?? '?'}/${r.coord ?? '?'}`)
          .join('  ')
        const good = p.rows.every((r) => r.status !== 'unknown' && r.remainingSec !== null)
        good ? okRows++ : badRows++
        console.log(
          `  ${good ? '✅' : '⚠️ '} ${f.padEnd(14)} 队列 ${p.queueUsed}/${p.queueTotal}  ${desc}`
        )
      } catch (e) {
        badRows++
        console.log(`  ❌ ${f} ${(e as Error).message.slice(0, 60)}`)
      }
    }
    console.log(`  小计：完全读全 ${okRows} 帧，有缺失 ${badRows} 帧`)
  }

  // ══ 3. runGatherCycle 全流程干跑 ══════════════════════════════════════
  console.log('\n【干跑】runGatherCycle 完整一轮')
  {
    const io = new ScriptedIo([
      's00_now.png', // 起始：世界地图
      's13_t1.png', // #1 tap 部队入口（队列 1/5，在采 697,566）
      's00_now.png', // #2 key BACK 关面板
      's22_wood.png', // #3 tap 放大镜 → 搜索面板（伐木场）
      's04_lvmax.png', // #4 swipe 探上限
      's04_lvmax.png', // #5 swipe 再探
      's04_lv7.png', // #6 tapMany [−] 把下限设到 7
      's05_card_wood8.png', // #7 tap 搜索 → 卡片（8 级 >= 7）
      's08_bubble.png', // #8 tap 采集
      's09_create.png', // #9 tap 创建部队
      's09_create.png', // #10 tap 一键编成
      's28_final.png', // #11 tap 行军 → 回世界地图
      's11_panel_gathering.png' // #12 tap 部队入口（队列 2/5 ⇒ 确认 +1）
    ])
    const logs: string[] = []
    const r = await runGatherCycle({
      io,
      templates,
      config: {
        enabled: true,
        // 只要一支伐木队，派完就该收工（否则会继续找第二个点，而剧本只写到这里）
        resources: [
          { type: 'wood', enabled: true, priority: 1, queues: 1 },
          { type: 'gold', enabled: false, priority: 2, queues: 0 },
          { type: 'iron', enabled: false, priority: 3, queues: 0 },
          { type: 'mana', enabled: false, priority: 4, queues: 0 }
        ],
        thresholds: { allianceTerritory: 'any' },
        searchRetry: { researchDelayMs: 0 },
        safety: { maxCapturesPerCycle: 200 }
      },
      log: (lv, m) => {
        if (lv !== 'debug') logs.push(`[${lv}] ${m}`)
      },
      random: () => 0
    })
    console.log('  —— 动作序列 ——')
    io.actions.forEach((a, i) => console.log(`   ${String(i + 1).padStart(2)}. ${a}`))
    console.log('  —— 日志 ——')
    logs.forEach((l) => console.log(`   ${l}`))
    console.log(`  结果 outcome=${r.outcome} 截图=${r.captures} 消息=${r.message}`)
    console.log(
      `  下次唤醒：${r.nextWakeAt ? new Date(r.nextWakeAt).toLocaleTimeString('zh-CN') : '无'}（${r.nextWakeReason}）`
    )
    check(
      '走到了行军这一步',
      io.actions.some((a) => a === 'tap 2125,1266'),
      true
    )
    check(
      '点过 [−] 调下限',
      io.actions.some((a) => a.startsWith('tapMany')),
      true
    )
    check('探过等级上限（两次 swipe）', io.actions.filter((a) => a.startsWith('swipe')).length, 2)
    check('探测到的等级上限（按资源记在 levelByResource.wood）', r.state.levelByResource.wood?.maxLevel ?? null, 8)
  }

  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
  if (fail > 0) process.exitCode = 1
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
