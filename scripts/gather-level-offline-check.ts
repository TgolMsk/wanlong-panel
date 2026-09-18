/**
 * 搜索等级记忆 + 下限状态机（src/main/game/gather/levelMemory.ts）的**离线**自检。
 * 不碰模拟器、不需要真机截图（与 check:sched / check:gather 不同，这里全是纯决策）。
 *
 *   npm run check:level
 *
 * 覆盖：
 *   一、起步下限：策略算法 / 记忆 / 记忆过期 / 夹到 minLevel / absolute 不放宽时忽略记忆 / 上限缺省
 *   二、★ 用户真机场景（2026-09-18）：魔水池滑杆 10、附近只有 8 级 —— 一次空搜就放宽到 8，下一轮直接从 8 起步
 *   三、状态机：搜不到立刻放宽且不消耗「点不合适」次数；点不合适照旧重试够次数才放宽；放到底放弃；见过卡片后的空搜只放宽不记忆
 *   四、记忆的写入与作废：放弃时也写；更低的观察覆盖；在记忆下限搜到点即作废；上限变化作废；按资源分别记
 *   五、落盘：新状态的形状、旧字段丢弃、坏数据收敛、gather-state.json 往返
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_GATHER_CONFIG,
  DEFAULT_LEVEL_POLICY,
  computeSearchFloor,
  type LevelPolicy,
  type SearchRetry
} from '@main/game/gather/config'
import {
  GATHER_RESOURCE_TYPES,
  effectiveMaxLevel,
  emptyLevelMemory,
  expireNoResult,
  hasFreshNoResult,
  isMaxLevelStale,
  learnFromSearch,
  levelMemoryOf,
  onCard,
  onNoCard,
  onUnsuitable,
  planStartFloor,
  recordMaxLevel,
  relaxFloor,
  sanitizeLevelMemory,
  startFloorSearch,
  type FloorSearch
} from '@main/game/gather/levelMemory'
import { createRuntimeState, type GatherRuntimeState } from '@main/game/gather/types'
import { loadGatherStates, saveGatherState } from '@main/game/gatherStateStore'

// ── 断言小工具 ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    fail += 1
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n【${title}】`)
}

const MIN = 60_000
const T0 = 1_700_000_000_000

/** 默认配置：offset −1、minLevel 5、assumedMaxLevel 8；occupiedRetryLimit 4、floorRelaxStep 1、probeIntervalMin 720。 */
const retry: SearchRetry = { ...DEFAULT_GATHER_CONFIG.searchRetry }
const relative: LevelPolicy = { ...DEFAULT_LEVEL_POLICY }
const fixedNoRelax: LevelPolicy = {
  mode: 'absolute',
  level: 9,
  minLevel: 5,
  allowRelax: false,
  maxLevelHardCap: 15
}
const ttl = retry.probeIntervalMin

// ══════════════════════════════════════════════════════════════════════════
// 一、起步下限
// ══════════════════════════════════════════════════════════════════════════

function checkStartFloor(): void {
  section('一、起步下限：策略 / 记忆 / 过期 / minLevel / 不放宽')

  const fresh = emptyLevelMemory()
  const p0 = planStartFloor(relative, fresh, 10, T0, ttl)
  ok(
    '没有记忆：下限 = 滑杆上限 + 偏移 = 10 − 1 = 9',
    p0.floor === 9 && !p0.fromMemory && p0.policyFloor === 9
  )
  ok('与 computeSearchFloor 一致', p0.policyFloor === computeSearchFloor(relative, 10))

  const remembered = { ...emptyLevelMemory(), noResultFloor: 9, noResultAt: T0 }
  const p1 = planStartFloor(relative, remembered, 10, T0 + 30 * MIN, ttl)
  ok('★ 记得「9 级搜不到」：直接从 8 起步', p1.floor === 8 && p1.fromMemory && p1.policyFloor === 9)

  const p2 = planStartFloor(relative, remembered, 10, T0 + (ttl + 1) * MIN, ttl)
  ok('记忆过期（超过 probeIntervalMin）：回到策略下限 9', p2.floor === 9 && !p2.fromMemory)
  ok(
    '过期判定：hasFreshNoResult 为 false',
    !hasFreshNoResult(remembered, T0 + (ttl + 1) * MIN, ttl)
  )
  ok(
    'expireNoResult 清掉过期记忆并返回它',
    expireNoResult(remembered, T0 + (ttl + 1) * MIN, ttl) === 9 && remembered.noResultFloor === null
  )
  ok(
    '没过期的不会被清',
    expireNoResult({ ...emptyLevelMemory(), noResultFloor: 9, noResultAt: T0 }, T0 + MIN, ttl) ===
      null
  )

  const lowOffset: LevelPolicy = {
    mode: 'relative',
    offset: -3,
    minLevel: 5,
    assumedMaxLevel: 8,
    maxLevelHardCap: 15
  }
  const p3 = planStartFloor(
    lowOffset,
    { ...emptyLevelMemory(), noResultFloor: 9, noResultAt: T0 },
    10,
    T0,
    ttl
  )
  ok('策略本身已经更低（偏移 −3 → 7）：记忆不起作用', p3.floor === 7 && !p3.fromMemory)

  const p4 = planStartFloor(
    relative,
    { ...emptyLevelMemory(), noResultFloor: 5, noResultAt: T0 },
    10,
    T0,
    ttl
  )
  ok('记忆 −1 低于 minLevel：夹到 minLevel=5', p4.floor === 5 && p4.fromMemory)

  const p5 = planStartFloor(
    fixedNoRelax,
    { ...emptyLevelMemory(), noResultFloor: 9, noResultAt: T0 },
    10,
    T0,
    ttl
  )
  ok('absolute 且不允许放宽：忽略记忆，就用固定的 9', p5.floor === 9 && !p5.fromMemory)

  ok('没探测过：上限用 assumedMaxLevel=8', effectiveMaxLevel(emptyLevelMemory(), relative) === 8)
  ok(
    'absolute 没探测过：上限用 maxLevelHardCap',
    effectiveMaxLevel(emptyLevelMemory(), fixedNoRelax) === 15
  )
  ok(
    '探测过：用探测值',
    effectiveMaxLevel({ ...emptyLevelMemory(), maxLevel: 10, probedAt: T0 }, relative) === 10
  )

  ok('从没探测 → 该探测', isMaxLevelStale(emptyLevelMemory(), T0, ttl))
  ok(
    '刚探测过 → 不用探',
    !isMaxLevelStale({ ...emptyLevelMemory(), maxLevel: 10, probedAt: T0 }, T0 + 5 * MIN, ttl)
  )
  ok(
    '超过 probeIntervalMin → 该探测',
    isMaxLevelStale(
      { ...emptyLevelMemory(), maxLevel: 10, probedAt: T0 },
      T0 + (ttl + 1) * MIN,
      ttl
    )
  )

  ok('relaxFloor：9 → 8', relaxFloor(relative, 9, 1) === 8)
  ok('relaxFloor：步长 2 → 7', relaxFloor(relative, 9, 2) === 7)
  ok('relaxFloor：到 minLevel 就放不动', relaxFloor(relative, 5, 1) === null)
  ok('relaxFloor：absolute 不允许放宽 → null', relaxFloor(fixedNoRelax, 9, 1) === null)
}

// ══════════════════════════════════════════════════════════════════════════
// 二、用户真机场景
// ══════════════════════════════════════════════════════════════════════════

function checkUserScenario(): void {
  section('二、★ 真机场景：魔水池滑杆 10、附近只有 8 级')
  const state = createRuntimeState()
  let clock = T0
  const mem = levelMemoryOf(state, 'mana')
  const probed = recordMaxLevel(mem, 10, clock)
  ok(
    '探测到滑杆上限 10（按资源记在 mana 下）',
    state.levelByResource.mana?.maxLevel === 10 && probed.changed && probed.previous === null
  )

  // 第一轮
  const plan1 = planStartFloor(relative, mem, effectiveMaxLevel(mem, relative), clock, ttl)
  ok('第一轮起步下限 9', plan1.floor === 9 && !plan1.fromMemory)
  let st: FloorSearch = startFloorSearch(plan1.floor)
  const step = onNoCard(st, relative, retry)
  ok(
    '★ 9 级搜不出卡片 → 一次就放宽到 8（不再白等 4 次）',
    step.kind === 'relaxed' && step.kind === 'relaxed' && step.to === 8,
    step.reason
  )
  st = step.state
  ok(
    '记下了「9 级搜不到」的观察，点不合适计数归零',
    st.lowestEmptyFloor === 9 && st.unsuitableFails === 0 && !st.cardSeen
  )
  // 8 级出了卡片
  const learned = learnFromSearch(mem, st, clock, ttl, st.floor)
  st = onCard(st)
  ok(
    '★ 8 级出卡片 → 确认写入记忆：mana 下限 9 搜不到',
    learned.committed === 9 &&
      learned.forgot === null &&
      mem.noResultFloor === 9 &&
      mem.noResultAt === clock
  )
  ok('见过卡片后状态里的观察已清空', st.cardSeen && st.lowestEmptyFloor === null)

  // 第二轮（30 分钟后）
  clock += 30 * MIN
  ok('第二轮不用重新探测上限（12 小时缓存）', !isMaxLevelStale(mem, clock, ttl))
  const plan2 = planStartFloor(relative, mem, effectiveMaxLevel(mem, relative), clock, ttl)
  ok('★ 第二轮直接从 8 起步，一次空搜都不用', plan2.floor === 8 && plan2.fromMemory)

  // 其它资源不受影响
  const wood = levelMemoryOf(state, 'wood')
  ok(
    '伐木场没有被魔水的上限带偏（各自独立、尚未探测）',
    wood.maxLevel === null && isMaxLevelStale(wood, clock, ttl)
  )
  recordMaxLevel(wood, 8, clock)
  ok(
    '伐木场探到 8 → 起步 7；魔水仍是 8',
    planStartFloor(relative, wood, 8, clock, ttl).floor === 7 &&
      planStartFloor(relative, mem, 10, clock, ttl).floor === 8
  )

  // 12 小时后记忆过期，重新试一次 9（一次空搜的代价）
  clock = T0 + (ttl + 1) * MIN
  ok(
    '12 小时后记忆过期，回到 9 重新探路（只多花一次搜索）',
    expireNoResult(mem, clock, ttl) === 9 &&
      planStartFloor(relative, mem, 10, clock, ttl).floor === 9
  )
}

// ══════════════════════════════════════════════════════════════════════════
// 三、状态机
// ══════════════════════════════════════════════════════════════════════════

function checkStateMachine(): void {
  section('三、下限状态机：搜不到 vs 点不合适')

  // 点不合适：重试够次数才放宽
  let st = startFloorSearch(9)
  const r1 = onUnsuitable(st, relative, retry)
  const r2 = onUnsuitable(r1.state, relative, retry)
  const r3 = onUnsuitable(r2.state, relative, retry)
  ok(
    '点不合适 ×3 → 同一下限重搜',
    r1.kind === 'retry' &&
      r2.kind === 'retry' &&
      r3.kind === 'retry' &&
      r3.state.unsuitableFails === 3
  )
  const r4 = onUnsuitable(r3.state, relative, retry)
  ok(
    '点不合适第 4 次（occupiedRetryLimit=4）→ 放宽 9 → 8，计数归零',
    r4.kind === 'relaxed' && r4.to === 8 && r4.state.unsuitableFails === 0
  )
  ok('点不合适不会留下「搜不到」的观察', r4.state.lowestEmptyFloor === null)

  // 搜不到：不消耗点不合适的次数
  st = { ...startFloorSearch(9), unsuitableFails: 2 }
  const n1 = onNoCard(st, relative, retry)
  ok(
    '★ 已经点不合适 2 次时搜不到 → 仍立刻放宽（不是等到第 4 次）',
    n1.kind === 'relaxed' && n1.to === 8 && n1.state.unsuitableFails === 0
  )

  // 步长
  const wide: SearchRetry = { ...retry, floorRelaxStep: 2 }
  ok(
    'floorRelaxStep=2：搜不到 9 → 7',
    onNoCard(startFloorSearch(9), relative, wide).kind === 'relaxed' &&
      (onNoCard(startFloorSearch(9), relative, wide) as { to: number }).to === 7
  )

  // 放到底
  const g1 = onNoCard(startFloorSearch(5), relative, retry)
  ok(
    'minLevel=5 上搜不到 → 放弃，原因写明 minLevel',
    g1.kind === 'giveUp' && g1.reason.includes('minLevel=5'),
    g1.reason
  )
  let bottom: FloorSearch = startFloorSearch(5)
  let last = onUnsuitable(bottom, relative, retry)
  for (let i = 0; i < 3; i++) {
    if (last.kind === 'giveUp') break
    bottom = last.state
    last = onUnsuitable(bottom, relative, retry)
  }
  ok(
    'minLevel 上点不合适 4 次 → 放弃',
    last.kind === 'giveUp' && last.reason.includes('连续 4 次'),
    last.reason
  )

  // absolute 不放宽
  const a1 = onNoCard(startFloorSearch(9), fixedNoRelax, retry)
  ok(
    'absolute 不允许放宽：搜不到 → 直接放弃，原因写明配置不允许',
    a1.kind === 'giveUp' && a1.reason.includes('配置不允许放宽')
  )

  // occupiedRetryLimit=1：第一次点不合适就放宽
  const one: SearchRetry = { ...retry, occupiedRetryLimit: 1 }
  ok(
    'occupiedRetryLimit=1：第一次点不合适就放宽',
    onUnsuitable(startFloorSearch(9), relative, one).kind === 'relaxed'
  )

  // 见过卡片之后的空搜：只放宽，不记忆
  const seen = onCard(startFloorSearch(8))
  const n2 = onNoCard(seen, relative, retry)
  ok(
    '见过卡片后再搜不到 → 放宽到 7，但不记「搜不到」（按一次性故障处理）',
    n2.kind === 'relaxed' && n2.to === 7 && n2.state.lowestEmptyFloor === null
  )
  const mem = emptyLevelMemory()
  ok(
    '这种情况放弃时也不会写入记忆',
    learnFromSearch(mem, n2.state, T0, ttl).committed === null && mem.noResultFloor === null
  )
}

// ══════════════════════════════════════════════════════════════════════════
// 四、记忆的写入与作废
// ══════════════════════════════════════════════════════════════════════════

function checkLearning(): void {
  section('四、记忆的写入与作废')

  // 放弃时也写：9 空、8 空、然后截图配额用尽
  {
    const mem = emptyLevelMemory()
    let st = startFloorSearch(9)
    st = (onNoCard(st, relative, retry) as { state: FloorSearch }).state
    st = (onNoCard(st, relative, retry) as { state: FloorSearch }).state
    ok('两次空搜后处在 7，记下的是最低的空下限 8', st.floor === 7 && st.lowestEmptyFloor === 8)
    const learned = learnFromSearch(mem, st, T0, ttl)
    ok(
      '★ 放弃时把 8 写进记忆，下一轮从 7 起步（跨轮逐级下探，不再每轮从 9 撞起）',
      learned.committed === 8 && planStartFloor(relative, mem, 10, T0 + MIN, ttl).floor === 7
    )
  }

  // 记忆下限起步后又搜不到：记忆往下修
  {
    const mem = { ...emptyLevelMemory(), noResultFloor: 9, noResultAt: T0 }
    const plan = planStartFloor(relative, mem, 10, T0 + MIN, ttl)
    let st = startFloorSearch(plan.floor)
    st = (onNoCard(st, relative, retry) as { state: FloorSearch }).state
    const learned = learnFromSearch(mem, st, T0 + MIN, ttl, st.floor)
    ok(
      '记忆 9 → 起步 8 也搜不到 → 7 出卡片：记忆修正为 8',
      plan.floor === 8 && learned.committed === 8 && mem.noResultFloor === 8
    )
  }

  // 已有更低的新鲜记忆：保留更低者，只刷新时间
  {
    const mem = { ...emptyLevelMemory(), noResultFloor: 8, noResultAt: T0 }
    const st = { ...startFloorSearch(7), lowestEmptyFloor: 9 }
    const learned = learnFromSearch(mem, st, T0 + MIN, ttl, 7)
    ok(
      '已知 8 搜不到、这次观察到 9 搜不到、7 出卡片：保留更低的 8，刷新时刻',
      learned.committed === 8 &&
        learned.forgot === null &&
        mem.noResultFloor === 8 &&
        mem.noResultAt === T0 + MIN
    )
  }
  // 已有记忆被这次的卡片推翻，同时又有新的观察：先作废旧的，再写新的
  {
    const mem = { ...emptyLevelMemory(), noResultFloor: 8, noResultAt: T0 }
    const st = { ...startFloorSearch(8), lowestEmptyFloor: 9 }
    const learned = learnFromSearch(mem, st, T0 + MIN, ttl, 8)
    ok(
      '记忆说 8 搜不到、这次 8 却出了卡片、9 搜不到：作废 8，改记 9',
      learned.forgot === 8 && learned.committed === 9 && mem.noResultFloor === 9
    )
  }

  // 在记忆说搜不到的下限搜到了点 → 作废
  {
    const mem = { ...emptyLevelMemory(), noResultFloor: 9, noResultAt: T0 }
    const learned = learnFromSearch(mem, startFloorSearch(9), T0 + MIN, ttl, 9)
    ok(
      '记忆说 9 搜不到、这次 9 却出了卡片 → 记忆作废',
      learned.forgot === 9 && learned.committed === null && mem.noResultFloor === null
    )
  }
  {
    const mem = { ...emptyLevelMemory(), noResultFloor: 9, noResultAt: T0 }
    const learned = learnFromSearch(mem, startFloorSearch(8), T0 + MIN, ttl, 8)
    ok(
      '在更低的 8 出卡片不与记忆矛盾 → 记忆保留',
      learned.forgot === null && mem.noResultFloor === 9
    )
  }

  // 上限变化作废
  {
    const mem = {
      ...emptyLevelMemory(),
      maxLevel: 10,
      probedAt: T0,
      noResultFloor: 9,
      noResultAt: T0
    }
    const same = recordMaxLevel(mem, 10, T0 + MIN)
    ok(
      '探测值没变：记忆保留',
      !same.changed &&
        same.forgotNoResult === null &&
        mem.noResultFloor === 9 &&
        mem.probedAt === T0 + MIN
    )
    const changed = recordMaxLevel(mem, 11, T0 + 2 * MIN)
    ok(
      '探测值变了（10 → 11）：作废「9 搜不到」',
      changed.changed &&
        changed.previous === 10 &&
        changed.forgotNoResult === 9 &&
        mem.noResultFloor === null &&
        mem.maxLevel === 11
    )
  }

  // 按资源分别记
  {
    const state = createRuntimeState()
    recordMaxLevel(levelMemoryOf(state, 'mana'), 10, T0)
    recordMaxLevel(levelMemoryOf(state, 'wood'), 8, T0)
    learnFromSearch(
      levelMemoryOf(state, 'mana'),
      { ...startFloorSearch(8), lowestEmptyFloor: 9 },
      T0,
      ttl,
      8
    )
    ok(
      'mana 与 wood 各自一份：上限 10/8，只有 mana 有「搜不到」记忆',
      state.levelByResource.mana?.maxLevel === 10 &&
        state.levelByResource.wood?.maxLevel === 8 &&
        state.levelByResource.mana?.noResultFloor === 9 &&
        state.levelByResource.wood?.noResultFloor === null
    )
    ok(
      '没碰过的资源不会凭空出现条目',
      state.levelByResource.gold === undefined && state.levelByResource.iron === undefined
    )
    ok(
      'levelMemoryOf 返回的是 state 里的同一个对象（改动直接落在 state）',
      levelMemoryOf(state, 'mana') === state.levelByResource.mana
    )
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 五、落盘
// ══════════════════════════════════════════════════════════════════════════

async function checkPersistence(): Promise<void> {
  section('五、落盘：形状、旧字段、坏数据、往返')

  const fresh = createRuntimeState()
  ok(
    '新状态：levelByResource 是空对象，没有旧的 maxLevel 字段',
    JSON.stringify(fresh.levelByResource) === '{}' && !('maxLevel' in fresh)
  )

  const cleaned = sanitizeLevelMemory({
    mana: { maxLevel: 10, probedAt: T0, noResultFloor: 9, noResultAt: T0 },
    wood: { maxLevel: '8', probedAt: T0 },
    gold: { maxLevel: 8 },
    iron: { noResultFloor: 7, noResultAt: T0 },
    junk: { maxLevel: 3, probedAt: T0 }
  })
  ok('合法条目原样保留', cleaned.mana?.maxLevel === 10 && cleaned.mana?.noResultFloor === 9)
  ok('上限不是数字 → 整条丢弃', cleaned.wood === undefined)
  ok('有上限没时刻 → 丢弃', cleaned.gold === undefined)
  ok(
    '只有「搜不到」记忆、没有上限 → 保留记忆',
    cleaned.iron?.noResultFloor === 7 && cleaned.iron?.maxLevel === null
  )
  ok('不认识的资源类型被忽略', !('junk' in cleaned))
  ok(
    'undefined / null / 数组 → 空对象',
    JSON.stringify(sanitizeLevelMemory(undefined)) === '{}' &&
      JSON.stringify(sanitizeLevelMemory(null)) === '{}' &&
      JSON.stringify(sanitizeLevelMemory([1])) === '{}'
  )
  ok('资源类型清单齐全', GATHER_RESOURCE_TYPES.join(',') === 'wood,gold,iron,mana')

  // gather-state.json 往返
  const dir = await mkdtemp(join(tmpdir(), 'wl-level-check-'))
  const state: GatherRuntimeState = createRuntimeState()
  recordMaxLevel(levelMemoryOf(state, 'mana'), 10, T0)
  learnFromSearch(
    levelMemoryOf(state, 'mana'),
    { ...startFloorSearch(8), lowestEmptyFloor: 9 },
    T0,
    ttl,
    8
  )
  await saveGatherState(dir, 0, state)
  const loaded = await loadGatherStates(dir)
  const back = sanitizeLevelMemory(loaded['0']?.levelByResource)
  ok(
    '★ 写进 gather-state.json 再读回来：mana 的上限与「9 搜不到」都在',
    back.mana?.maxLevel === 10 && back.mana?.noResultFloor === 9 && back.mana?.noResultAt === T0
  )

  // 旧版本文件：共用的 maxLevel 被丢弃
  const legacyDir = await mkdtemp(join(tmpdir(), 'wl-level-legacy-'))
  await writeFile(
    join(legacyDir, 'gather-state.json'),
    JSON.stringify({
      '0': {
        maxLevel: 8,
        maxLevelProbedAt: T0,
        backoffIndex: 0,
        giveUpUntil: null,
        dispatchTimestamps: [],
        inFlight: [],
        lastPanelSampledAt: null,
        travelTimeByCoord: {},
        resourceByCoord: {}
      }
    }),
    'utf8'
  )
  const legacy = (await loadGatherStates(legacyDir))['0'] as unknown as Record<string, unknown>
  ok(
    '旧文件里共用的 maxLevel=8 不会被当成任何资源的上限（下一轮重新探测）',
    JSON.stringify(sanitizeLevelMemory(legacy.levelByResource)) === '{}' && legacy.maxLevel === 8
  )
}

// ── 跑 ────────────────────────────────────────────────────────────────────

checkStartFloor()
checkUserScenario()
checkStateMachine()
checkLearning()
await checkPersistence()

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
if (fail > 0) process.exitCode = 1
