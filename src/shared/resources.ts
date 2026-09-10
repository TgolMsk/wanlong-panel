/**
 * 「资源」相关的公共契约：资源类型、资源统计面板快照、中文金额（11.1亿 / 9129万）解析。
 *
 * ★ 本文件是**新增**的，不改动 src/shared 里任何既有文件。
 * ★ 四端共用：不得 import electron / node:fs / sharp / opencv（与 shared 层的其它文件同一纪律）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【数据来源与精度 —— 读代码前先看这段】
 *
 * 游戏里「道具 → 资源 → 资源统计」那张弹窗（docs/game/shots/resources/res_04_stats.png）
 * 是 4 行 × 2 列的表：金币 / 木材 / 铁矿石 / 魔水 × 「道具总量」「资源总量」，
 * 值形如 `2.9亿` / `11.1亿` / `22.4亿`（深色字、浅底，字高约 34px @2560x1440）。
 *
 * ★ 精度只到 0.1亿 = 1000 万。一趟魔水只采 42 万、一趟木材 126 万，按这张表做
 *   「今天采了多少」的差值会被四舍五入整个吞掉。所以：
 *     · 每日采集统计的**主数据源是派兵记账**（见 stats.ts，DispatchRecord.storage 精确到个位）
 *     · 这张表只用于**日切快照**与**粗对账**（例如发现资源被大量消耗）
 *   `PANEL_AMOUNT_PRECISION` 把这条常识写成常量，面板与机器人显示时据此加「≈」与说明。
 * ══════════════════════════════════════════════════════════════════════════
 */

// ══════════════════════════════════════════════════════════════════════════
// 一、资源类型
// ══════════════════════════════════════════════════════════════════════════

/**
 * 四种可采集资源。
 *
 * ★ 与 src/main/game/gather/config.ts 的 `GatherResourceType` **逐字相同**（结构类型，可互相赋值）。
 *   shared 层不能 import main，所以这里另写一份；改任何一边前先改另一边。
 *   下游 (b)/(c) 若担心漂移，可在主进程里加一行
 *   `const _check: Record<GatherResourceType, ResourceType> = { wood:'wood', gold:'gold', iron:'iron', mana:'mana' }`。
 */
export const RESOURCE_TYPES = ['gold', 'wood', 'iron', 'mana'] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

/** 中文名，与游戏里「资源统计」表的行标题一致。顺序 = 表里的行序（金币在第一行）。 */
export const RESOURCE_NAME: Record<ResourceType, string> = {
  gold: '金币',
  wood: '木材',
  iron: '铁矿石',
  mana: '魔水'
}

/** 资源统计表里从上到下的行序。识别与渲染都按这个顺序，别在别处再写一份。 */
export const RESOURCE_PANEL_ROW_ORDER: readonly ResourceType[] = ['gold', 'wood', 'iron', 'mana']

export function isResourceType(v: unknown): v is ResourceType {
  return typeof v === 'string' && (RESOURCE_TYPES as readonly string[]).includes(v)
}

// ══════════════════════════════════════════════════════════════════════════
// 二、资源统计面板快照
// ══════════════════════════════════════════════════════════════════════════

/** 快照来自哪里。`topbar`（顶栏缩写）目前**没有实现**，只是给将来留的枚举值。 */
export type ResourceSnapshotSource = 'panel' | 'topbar'

/** 资源统计表的一行。两列各自独立：一列读失败不影响另一列。 */
export interface ResourceSnapshotRow {
  type: ResourceType
  /** 「道具总量」列，整数（个）。读不出 / 解析失败为 null。 */
  itemTotal: number | null
  /** 「资源总量」列，整数（个）。读不出 / 解析失败为 null。 */
  total: number | null
  /** 「道具总量」列识别到的原始字符串（如 `2.9亿`）；读不出为空串。排障与面板显示用。 */
  rawItem: string
  /** 「资源总量」列识别到的原始字符串（如 `11.1亿`）；读不出为空串。 */
  rawTotal: string
}

/** 一次「资源统计」读数。所有时刻都是**绝对毫秒**（Date.now()），显示时才换算成北京时间。 */
export interface ResourceSnapshot {
  /** 读取时刻。 */
  at: number
  instanceIndex: number
  source: ResourceSnapshotSource
  /** 固定 4 行，顺序 = RESOURCE_PANEL_ROW_ORDER。缺行也要占位（两列 null）。 */
  rows: ResourceSnapshotRow[]
  /** 识别过程中的中文降级说明（某列低置信、某行没读出等）。空数组 = 干净。 */
  warnings: string[]
}

/**
 * ★ 资源统计表的数值精度：0.1亿 = 1000 万（个）。
 *   面板/机器人渲染快照时必须带「≈」并注明「精度 0.1亿，不能用于日采集量差值」。
 */
export const PANEL_AMOUNT_PRECISION = 10_000_000

/** 造一个「全部读不出」的空快照（读面板失败时也要给面板一个形状完整的对象）。 */
export function emptyResourceSnapshot(
  instanceIndex: number,
  at: number = Date.now(),
  source: ResourceSnapshotSource = 'panel'
): ResourceSnapshot {
  return {
    at,
    instanceIndex,
    source,
    rows: RESOURCE_PANEL_ROW_ORDER.map((type) => ({
      type,
      itemTotal: null,
      total: null,
      rawItem: '',
      rawTotal: ''
    })),
    warnings: []
  }
}

/** 从快照里取某种资源那一行；没有就返回 null。 */
export function snapshotRow(snap: ResourceSnapshot, type: ResourceType): ResourceSnapshotRow | null {
  return snap.rows.find((r) => r.type === type) ?? null
}

// ══════════════════════════════════════════════════════════════════════════
// 三、中文金额解析：'11.1亿' | '9129万' | '59,677' -> 整数
// ══════════════════════════════════════════════════════════════════════════

const YI = 100_000_000
const WAN = 10_000

/**
 * 把游戏里的中文金额字符串解析成整数（个）。**纯函数，不抛异常**。
 *
 * 规格（下游识别模块与离线自检都以此为准）：
 *   · 允许的形状：`<数字>[.<数字>]<单位>?`，单位 ∈ { 亿, 万, 无 }；数字部分允许千分位逗号 `,`
 *   · 全角/半角空格、全角数字与全角句点一律先归一化；`億` 视为 `亿`
 *   · 结果 = 数值 × 单位倍数，**四舍五入到整数**；负数 / NaN / 无限 / 空串 / 多个单位 / 多个小数点 → null
 *   · 有单位时允许小数（11.1亿 = 1,110,000,000）；**无单位时不允许小数**（`59,677.5` → null，
 *     游戏从不显示带小数的原始个数，出现小数点多半是把「亿」认丢了 —— 宁可 null 也不给一个错 1 亿倍的数）
 *   · 识别占位符 `?`（字形集缺字时 readDigits 会插）→ null
 *
 * 用例表见 `CN_AMOUNT_CASES`；离线自检（scripts/resources-offline-check.ts）逐条跑它。
 */
export function parseCnAmount(text: string | null | undefined): number | null {
  if (text == null) return null
  let s = normalizeAmountText(text)
  if (s === '' || s.includes('?')) return null

  let mult = 1
  let unitCount = 0
  if (s.endsWith('亿')) {
    mult = YI
    unitCount += 1
    s = s.slice(0, -1)
  } else if (s.endsWith('万')) {
    mult = WAN
    unitCount += 1
    s = s.slice(0, -1)
  }
  // 单位只能出现在末尾且只能有一个；剩下的串里再出现单位字就是脏数据。
  if (/[亿万]/.test(s) || unitCount > 1) return null

  // 无单位：只接受纯整数（允许千分位）。
  if (mult === 1) {
    if (!/^\d{1,3}(,\d{3})*$/.test(s) && !/^\d+$/.test(s)) return null
    const n = Number(s.replace(/,/g, ''))
    return Number.isSafeInteger(n) && n >= 0 ? n : null
  }

  // 有单位：`123` / `12.3` / `1,234.5`，最多一个小数点。
  if (!/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(s) && !/^\d+(\.\d+)?$/.test(s)) return null
  const v = Number(s.replace(/,/g, ''))
  if (!Number.isFinite(v) || v < 0) return null
  const out = Math.round(v * mult)
  return Number.isSafeInteger(out) ? out : null
}

/** 全角 → 半角、去空白、億 → 亿。只做字符层面的归一化，不做语义判断。 */
function normalizeAmountText(text: string): string {
  return text
    .replace(/[\s　]/g, '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[．。]/g, '.')
    .replace(/，/g, ',')
    .replace(/億/g, '亿')
}

/**
 * 整数 → 游戏风格的中文金额（面板与机器人显示用）。
 *   ≥ 1亿  → 保留 1 位小数的「亿」（11.1亿）
 *   ≥ 1万  → 整数「万」（9129万）；不足 1 万 → 千分位整数（59,677）
 * null → '—'。
 */
export function formatCnAmount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const v = Math.round(n)
  if (Math.abs(v) >= YI) return `${trimZero((v / YI).toFixed(1))}亿`
  if (Math.abs(v) >= WAN) return `${Math.round(v / WAN)}万`
  return v.toLocaleString('en-US')
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

/**
 * 单元用例表（输入 → 期望输出）。离线自检直接 for..of 跑一遍，**不要在自检脚本里再抄一份**。
 * 加新用例只加这里。
 */
export const CN_AMOUNT_CASES: ReadonlyArray<readonly [input: string, expected: number | null]> = [
  // 亿
  ['11.1亿', 1_110_000_000],
  ['2.9亿', 290_000_000],
  ['22.4亿', 2_240_000_000],
  ['3亿', 300_000_000],
  ['0.5亿', 50_000_000],
  ['1,234.5亿', 123_450_000_000],
  // 万
  ['9129万', 91_290_000],
  ['1.2万', 12_000],
  ['42万', 420_000],
  // 无单位
  ['59,677', 59_677],
  ['1260000', 1_260_000],
  ['1,260,000', 1_260_000],
  ['0', 0],
  // 归一化
  ['１１.１亿', 1_110_000_000],
  [' 2.9 亿 ', 290_000_000],
  ['11.1億', 1_110_000_000],
  ['2．9亿', 290_000_000],
  // 拒绝
  ['', null],
  ['abc', null],
  ['亿', null],
  ['1.2.3亿', null],
  ['11.1亿万', null],
  ['-3亿', null],
  ['59,677.5', null],
  ['1?.1亿', null],
  ['1,23', null]
]

// ══════════════════════════════════════════════════════════════════════════
// 四、渲染（机器人「💰 资源」回复与面板共用同一段文案）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 把一次快照渲染成纯文本（★ 不用 Markdown，理由见 alerts.ts「为什么不开 parse_mode」）。
 *
 *   实例 0「主号」资源统计（北京时间 2026-09-09 21:22）
 *   金币　道具 2.9亿　资源 11.1亿
 *   ...
 *   （精度 0.1亿≈1000 万，只作对账参考，不能用来算日采集量）
 *
 * @param formatTime 时间格式化函数（传 alerts.ts 的 formatCst；shared 内不互相硬依赖）
 */
export function renderResourceSnapshotText(
  snap: ResourceSnapshot,
  opts: { accountName?: string | null; formatTime: (at: number) => string }
): string {
  const who = opts.accountName ? `「${opts.accountName}」` : ''
  const lines: string[] = [`实例 ${snap.instanceIndex}${who}资源统计（北京时间 ${opts.formatTime(snap.at)}）`]
  for (const type of RESOURCE_PANEL_ROW_ORDER) {
    const row = snapshotRow(snap, type)
    const item = row?.itemTotal != null ? formatCnAmount(row.itemTotal) : row?.rawItem || '读不出'
    const total = row?.total != null ? formatCnAmount(row.total) : row?.rawTotal || '读不出'
    lines.push(`${RESOURCE_NAME[type]}　道具 ${item}　资源 ${total}`)
  }
  lines.push('（精度 0.1亿≈1000 万，只作对账参考，不能用来算日采集量）')
  if (snap.warnings.length > 0) lines.push(`⚠️ ${snap.warnings.join('；')}`)
  return lines.join('\n')
}
