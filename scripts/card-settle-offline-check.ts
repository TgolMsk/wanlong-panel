/**
 * 「等卡片停稳」的离线自检（G8 的 waitForCard）。
 *
 * 不碰模拟器、**不需要真机帧** —— 用一个假 GatherSession 直接喂「按钮一帧帧滑到位」的序列，
 * 所以在任何机器上都能跑（check:gather 需要 gitignore 掉的 .tplkit/frames，很多机器没有）。
 *
 * 盯死三条，每一条都是踩出来的：
 *   ① **见过卡片就绝不能退化成 null**。null 在 flow.ts 里只有一种解释——「附近没有这个等级的点」，
 *      于是放宽下限、把假结论写进 12 小时的 noResultFloor 记忆，下限到底时还会 giveUp 停采 10 分钟。
 *   ② **帧数要有硬上限**。waitFor 在「命中」这条路上不 sleep，若只靠 deadline 收敛，
 *      帧数 = 预算 ÷ 截图延迟（8s ÷ 300~750ms = 11~26 帧），一次 G8 就能吃掉 maxCapturesPerCycle 的三四成，
 *      之后撞上截图熔断连收尾都做不了，游戏停在搜索页等 10 分钟。
 *   ③ **waitMs <= 0 要退化成单帧**，否则 scripts/gather-offline-verify.ts 的静态帧回放会多吃帧。
 */
import { waitForCard } from '@main/game/gather/card'
import type { GatherSession } from '@main/game/gather/session'

let pass = 0,
  fail = 0
const ok = (n: string, c: boolean, extra = '') => {
  c ? (pass++, console.log('  ✅', n, extra)) : (fail++, console.log('  ❌', n, extra))
}

function fakeSession(frames: (readonly [number, number] | null)[]) {
  let t = 0,
    i = 0,
    captures = 0,
    slept = 0
  const logs: string[] = []
  const next = () => {
    const f = frames[Math.min(i, frames.length - 1)]
    i++
    captures++
    t += 750
    return f
  }
  const s = {
    now: () => t,
    invalidate: () => {},
    async sleep(ms: number) {
      t += ms
      slept += ms
    },
    log: (lvl: string, m: string) => logs.push(`${lvl}:${m}`),
    async match(_id: string) {
      const f = next()
      return f
        ? { found: true, centerX: f[0], centerY: f[1] }
        : { found: false, centerX: 0, centerY: 0 }
    },
    async waitFor(_ids: unknown, opts: { waitMs: number; pollMs?: number }) {
      const deadline = t + Math.max(0, opts.waitMs)
      for (;;) {
        const f = next()
        if (f) return { id: 'tpl_btn_gather', match: { centerX: f[0], centerY: f[1] } }
        if (t >= deadline) return null
        t += opts.pollMs ?? 600
      }
    }
  }
  return { s: s as unknown as GatherSession, logs, frames: () => captures, slept: () => slept }
}

console.log('【滑入两帧后停稳】')
{
  const f = fakeSession([
    [1700, 1040],
    [1780, 1044],
    [1800, 1045],
    [1800, 1045]
  ])
  const p = await waitForCard(f.s, 8000)
  ok('返回停稳位，不是第一帧', p?.x === 1800 && p?.y === 1045, JSON.stringify(p))
}
console.log('【一上来就静止】')
{
  const f = fakeSession([
    [1800, 1045],
    [1800, 1045]
  ])
  const p = await waitForCard(f.s, 8000)
  ok('位置对', p?.x === 1800)
  ok('只多吃一帧（共 2）', f.frames() === 2, `实吃 ${f.frames()}`)
  ok('复验前静置过 300ms', f.slept() === 300, `${f.slept()}ms`)
  ok('没有 warn', f.logs.length === 0, f.logs.join('|'))
}
console.log('【容差内抖动算停稳】')
{
  const f = fakeSession([
    [1800, 1045],
    [1805, 1042]
  ])
  ok('5px/3px 判停稳', (await waitForCard(f.s, 8000))?.x === 1805)
}
console.log('【一次都没看见 → null（语义不变）】')
{
  ok('返回 null', (await waitForCard(fakeSession([null]).s, 8000)) === null)
}
console.log('【★ 见过卡片、复验帧没匹配上 → 绝不能返回 null】')
{
  const f = fakeSession([[1800, 1045], null, null, null])
  const p = await waitForCard(f.s, 8000)
  ok('返回上一帧位置而不是 null', p !== null && p.x === 1800, JSON.stringify(p))
  ok(
    '说明了原因',
    f.logs.some((l) => l.includes('没再匹配到')),
    f.logs.join('|')
  )
}
console.log('【★ 一直在动：帧数必须有硬上限，不能烧到 deadline】')
{
  const moving: [number, number][] = []
  for (let k = 0; k < 60; k++) moving.push([1700 + k * 30, 1045])
  const f = fakeSession(moving)
  const p = await waitForCard(f.s, 8000)
  ok('返回最后看到的位置', p !== null && p.x > 1700, JSON.stringify(p))
  ok('总帧数 ≤ 3（1 次命中 + 2 次复验）', f.frames() <= 3, `实吃 ${f.frames()} 帧`)
  ok(
    '发了「仍在移动」的 warn',
    f.logs.some((l) => l.includes('仍在移动')),
    f.logs.join('|')
  )
}
console.log('【waitMs=0（离线回放）退化成单帧】')
{
  const f = fakeSession([
    [1800, 1045],
    [9999, 9999]
  ])
  ok('单帧命中即返回', (await waitForCard(f.s, 0))?.x === 1800)
  ok('只吃 1 帧', f.frames() === 1, `实吃 ${f.frames()}`)
  ok('没静置', f.slept() === 0)
}
console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
process.exit(fail ? 1 : 0)
