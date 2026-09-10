/**
 * 「部队管理」面板采样器 —— ETA 调度唯一的数据源。
 *
 * 流程：确认在世界地图 → 点右侧列表图标打开面板 → 抓一帧 → 逐行识别 → **读完即关**。
 * 面板不常驻打开，免得挡住别的任务。
 *
 * 一次采样的开销（实测口径）：
 *   打开面板 2~3 张截图（每张约 750ms，游戏在前台）+ 采样帧 1 张 + 关闭复验 1 张，
 *   加上 prepareFrame（shrink=2 约 1.5ms、shrink=1 约 8ms）与几百次小 ROI 匹配。
 *   总计 4~6 秒。所以它**只在到点唤醒与周期校准时跑**，绝不轮询。
 *
 * ★ 本文件不 import electron，设备能力全部由 SampleIo 注入，便于离线测试。
 *
 * 几何全部来自 resources/game-data/gather-flow.json 的 anchors.troopPanel（真机复量过），
 * 改动前先看那份文件，别凭截图目测。
 */

import { AppError } from '@shared/errors'
import type { AndroidKey } from '@shared/script'
import type { MarchResourceType, MarchStatus, StaminaValue } from '@shared/scheduler'
import type { MatchResult, PreparedFrame, PreparedTemplate, RawFrame, Rect } from '@shared/vision'
import { matchIn, prepareFrame } from '@vision/index'
import {
  CLOCK_PATTERN,
  COORD_PATTERN,
  FRACTION_PATTERN,
  parseClockMs,
  parseCoord,
  parseFraction,
  readNumberText
} from './digits'
import { POPUP_CLOSE_ROI } from '@main/game/gather/geometry'
import { optionalUi, requireUi, STATUS_TEMPLATES, TPL, type SchedulerTemplates } from './templates'

// ── 几何常量（参考分辨率 2560x1440）──────────────────────────────────────

/** 世界地图右侧边缘的列表图标。★ 务必 x=2522：实测点 2468 会落到地图上把地图拖走。 */
const ENTRY_TAP = { x: 2522, y: 592 }
/** 右侧栏入口图标的搜索区：覆盖列表图标（≈592）与收起双箭头（≈682）。 */
const MAP_ENTRY_ROI: Rect = { x: 2430, y: 540, w: 130, h: 220 }
/** (2524,682) 是收起右侧栏的双箭头，别点错 —— 这里写出来是给后来者提个醒。 */

/** 城内左下角的地图按钮中心（tpl_nav_map_toggle 的 bounds 中心）。 */
const CITY_TO_MAP_TAP = { x: 125, y: 1319 }

/** 面板外的空地，BACK 关不掉时的兜底点击位置（面板左边界 x=914，这里在地图上）。 */
const TAP_OUTSIDE = { x: 400, y: 700 }

const PANEL_TITLE_ROI: Rect = { x: 800, y: 10, w: 700, h: 120 }
const QUEUE_ICON_ROI: Rect = { x: 2020, y: 14, w: 340, h: 100 }
/**
 * 队列数字相对 tpl_queue_icon_panel **命中框**的偏移。
 * 真机复量（.tplkit/frames/s11_panel_gathering.png，满分辨率）：
 * 图标墨迹 2140..2181，「2/5」三个字形 2189..2208 / 2211..2222 / 2226..2245，y 43..79，
 * 右边 2343..2355 是「i」信息按钮，绝不能框进来。
 */
const QUEUE_DIGIT_REL: Rect = { x: -6, y: 2, w: 84, h: -2 }

/** 第 1 行中心 y 与行距。真机实测行距 250（旧文档的 243 来自 1280x720 缩放图，是错的）。 */
const ROW_FIRST_CENTER_Y = 248
/**
 * 行距。★ 实测 242~244（4 行与 5 行面板都是），**不是**最初写死的 250。
 * 误差逐行累积：按 250 算到第 4 行漂 20px、第 5 行漂 28px，状态词与「坐标:」标签的
 * 识别带双双落空，两支在采的队伍被当成空位（用户实测「五个队列只读出三个」）。
 * 现在只作兜底：真实行中心由 detectRowCenters() 扫描得到。
 */
const ROW_PITCH_Y = 243
/** 扫描「坐标:」标签用的窗高与步长（参考坐标）。 */
const ROW_SCAN_WIN = 100
const ROW_SCAN_STEP = 25
/** 「坐标:」标签左上角相对行中心的偏移：模板在第一行裁得（行中心 248、标签 y=306）。 */
const COORD_LABEL_TO_ROW_CENTER = 58

/**
 * 状态条（状态词 + 倒计时）相对 rowY 的搜索矩形。
 *
 * ★ 左边界必须给到 1415：两类行的排版**不一样** ——
 *   采集中是白字压在载重进度条上、整体居中（x≈1546 起）；
 *   采集行军中 / 返回中 是深灰字直接压在行底色上、**左对齐在 x≈1432**。
 *   旧文档写的 1461 会把左对齐的那两个状态词整个切掉，表现为「有队伍却认不出状态」。
 */
const STATUS_BAR_REL: Rect = { x: 1415, y: 16, w: 525, h: 56 }
/** 状态条右边界，倒计时 ROI 不许越过它，否则会把行尾装饰切进来。 */
const STATUS_BAR_RIGHT = STATUS_BAR_REL.x + STATUS_BAR_REL.w

/** 行内「坐标:」标签的搜索带（相对 rowY）。实测行 1 标签墨迹 1143..1210 / 310..339。 */
const COORD_LABEL_REL: Rect = { x: 1085, y: 40, w: 390, h: 72 }
/**
 * 行左侧目标资源点缩略图的搜索带（相对 rowY）。缩略图本体实测 1125..1317 / 行中心 -60..+57，
 * 上面压着「⛏ 载重」角标、下面紧挨「坐标:」，模板只框 -52..+52 的本体。
 */
const THUMB_REL: Rect = { x: 1105, y: -70, w: 230, h: 150 }
/** 「采集中」菱形图标（白镐）的搜索带（相对 rowY）。图标实测 1365..1423 / +19..+76。 */
const STATUS_ICON_REL: Rect = { x: 1345, y: 5, w: 100, h: 85 }
/**
 * 只认出图标、没认出状态词时，给倒计时定位用的「采集中」三个字的兜底位置（相对 rowY）。
 * 取自 tpl_status_gathering 的 bounds（行 1：1542,278 98x34 → 行中心 248）。
 */
const STATUS_WORD_FALLBACK_REL: Rect = { x: 1542, y: 30, w: 98, h: 34 }
/** 两名指挥官的耐力搜索带（相对 rowY），先在带内找水滴图标再取它右边的数字。 */
const STAMINA_BANDS_REL: Rect[] = [
  { x: 1995, y: -84, w: 330, h: 80 },
  { x: 1995, y: 8, w: 330, h: 92 }
]

// ── 注入的设备能力 ────────────────────────────────────────────────────────

export interface SampleIo {
  serial: string
  /** 抓一帧裸图。 */
  capture(): Promise<RawFrame>
  /** 参考分辨率坐标点击（内部负责换算到设备像素）。 */
  tapRef(x: number, y: number): Promise<void>
  key(k: AndroidKey): Promise<void>
  /** 中文日志回调，采样过程的每一步都会喊一声，便于排障。 */
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void
  /**
   * 认不出界面时，把**这一帧**交给上层跑顶号/掉线探针 —— 帧已经截了，零额外开销；
   * 不这样做的话顶号只能靠「连续 N 次采样失败」的慢路径才被发现。
   * 返回 true 表示探针命中并已接管（告警中心会暂停实例），采样器就不再盲按 BACK 试探。
   * 实现方不得抛异常（抛了也会被吞、按未命中处理）。
   */
  onUnrecognized?: (raw: RawFrame) => Promise<boolean | void>
}

export interface SampleOptions {
  refWidth: number
  refHeight: number
  maxRows: number
  readOptionalFields: boolean
  closePanelAfterSample: boolean
  /** 整次采样的截止时刻（Date.now() 口径）。 */
  deadlineAt: number
}

// ── 采样结果 ──────────────────────────────────────────────────────────────

export interface RowSample {
  slot: number
  status: MarchStatus
  statusText: string
  remainingMs: number | null
  targetCoord: string | null
  troopCount: number | null
  commanders: StaminaValue[]
  /** 按行左侧资源点缩略图识别出的资源类型；行军中/返回中（缩略图是部队图）或没模板时为 null。 */
  resourceType: MarchResourceType | null
  warning?: string
}

export interface PanelSample {
  sampledAt: number
  queueUsed: number | null
  queueTotal: number | null
  rows: RowSample[]
  warnings: string[]
}

// ── 小工具 ────────────────────────────────────────────────────────────────

function rowY(slot: number): number {
  return ROW_FIRST_CENTER_Y + (slot - 1) * ROW_PITCH_Y
}

/**
 * 沿「坐标:」标签所在的列扫描，找出每一行的**真实**中心 y（从上到下）。
 * 有内容的行一定带「坐标:」；空位没有，所以返回的数量 = 有内容的行数，
 * 后面的空位仍按固定行距去看（用于确认它确实是空的）。
 * 成本：约 48 次小 ROI 匹配（每次 ~1ms），可忽略。
 */
async function detectRowCenters(
  ui: PreparedFrame,
  t: SchedulerTemplates,
  maxRows: number
): Promise<number[]> {
  const label = optionalUi(t, TPL.coordLabel)
  if (!label) return []
  const x = COORD_LABEL_REL.x
  const w = COORD_LABEL_REL.w
  const yEnd = rowY(maxRows) + COORD_LABEL_REL.y + 60
  const hits: number[] = []
  for (let y0 = 150; y0 <= yEnd; y0 += ROW_SCAN_STEP) {
    const m = await matchIn(ui, label, { roi: { x, y: y0, w, h: ROW_SCAN_WIN } })
    if (m.found) hits.push(m.y)
  }
  hits.sort((a, b) => a - b)
  const tops: number[] = []
  for (const y of hits) {
    if (tops.length === 0 || y - tops[tops.length - 1] > ROW_PITCH_Y / 2) tops.push(y)
  }
  return tops.slice(0, maxRows).map((y) => y - COORD_LABEL_TO_ROW_CENTER)
}

function relRect(r: Rect, y: number): Rect {
  return { x: r.x, y: y + r.y, w: r.w, h: r.h }
}

function checkDeadline(opts: SampleOptions, what: string): void {
  if (Date.now() > opts.deadlineAt) {
    throw new AppError(
      'TIMEOUT',
      `读取部队管理面板超时（卡在：${what}）。\n` +
        '游戏在前台时单张截图约 750ms，一次采样要十几张；' +
        '如果经常超时，请到调度设置里把 sampleTimeoutMs 调大，或确认模拟器没有卡住。',
      { what }
    )
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms))
}

/** 取一帧并做两级预处理（shrink=2 给界面模板，shrink=1 给数字字形）。 */
async function grab(
  io: SampleIo,
  opts: SampleOptions
): Promise<{ raw: RawFrame; ui: PreparedFrame; digits: PreparedFrame }> {
  const raw = await io.capture()
  const ui = await prepareFrame(raw, { refW: opts.refWidth, refH: opts.refHeight, shrink: 2 })
  const digits = await prepareFrame(raw, { refW: opts.refWidth, refH: opts.refHeight, shrink: 1 })
  return { raw, ui, digits }
}

// ── 打开 / 关闭面板 ───────────────────────────────────────────────────────

/**
 * 打开面板最多试几轮：前两轮只等动画；之后每轮先跑探针，再依次试「点弹窗 ×」「按一次 BACK」；
 * 两招都用过还认不出就放弃。
 */
const OPEN_PANEL_ATTEMPTS = 5

/**
 * 确保「部队管理」面板已经打开，返回可用于识别的那一帧。
 *
 * 不假设当前在哪：面板已开就直接用；在世界地图就点入口；在城内先切世界地图。
 * 认不出来时先等动画，再把帧交给探针（顶号/掉线），然后**只盲按一次 BACK**（关活动弹窗），
 * 仍认不出就报错让上层决定 —— 乱点比不点危险得多。
 */
async function ensurePanelOpen(
  io: SampleIo,
  t: SchedulerTemplates,
  opts: SampleOptions
): Promise<{ ui: PreparedFrame; digits: PreparedFrame; noMarches?: boolean }> {
  const title = requireUi(t, TPL.panelTitle)
  const entryIcon = optionalUi(t, TPL.queueIconMap)
  // ★ 世界地图判据必须是 anyTemplate：放大镜镜片半透明、分数随地形漂移（见 templates.ts）；
  //   回城城堡按钮按阵营各一张（A 法师 / B 兽族）。
  const worldMap = pickUi(t, [TPL.navCityToggle, TPL.navCityToggleB, TPL.worldSearchIcon])
  // ★ 城内判据同样按阵营各一张。只认 A 的话兽族号一进城内就永远「认不出界面」，采样连续失败
  //   （2026-09-10 huadong 实测）。B 是透明底模板：圆环里透着会变的地形，只拿控件本体匹配。
  const cityView = pickUi(t, [TPL.navMapToggle, TPL.navMapToggleB])
  const closePopup = optionalUi(t, TPL.btnClosePopup)
  let closeTried = false
  let backTried = false

  for (let attempt = 1; attempt <= OPEN_PANEL_ATTEMPTS; attempt++) {
    checkDeadline(opts, `打开部队管理面板（第 ${attempt} 次尝试）`)
    const frame = await grab(io, opts)

    const hit = await matchIn(frame.ui, title, { roi: PANEL_TITLE_ROI })
    if (hit.found) {
      io.log?.('debug', `部队管理面板已打开（标题命中 ${hit.score}）。`)
      return { ui: frame.ui, digits: frame.digits }
    }

    const onMap = await firstHit(frame.ui, worldMap)
    if (onMap) {
      // ★ 入口只在有队伍在野外时才存在。没有就别点了 —— 点下去落在地图上，
      //   连点三次会被误判成「掉线」并暂停实例（小号刚开号时实测踩到）。
      if (entryIcon) {
        const e = await matchIn(frame.ui, entryIcon, { roi: MAP_ENTRY_ROI })
        if (!e.found) {
          io.log?.(
            'info',
            `世界地图右侧没有部队管理入口（${e.score.toFixed(3)}）⇒ 判定没有队伍在野外，本次按空队列处理。`
          )
          return { ui: frame.ui, digits: frame.digits, noMarches: true }
        }
      }
      io.log?.('info', `当前在世界地图（${onMap.id} 命中 ${onMap.score}），点右侧列表图标打开部队管理面板。`)
      await io.tapRef(ENTRY_TAP.x, ENTRY_TAP.y)
      await sleep(1200)
      continue
    }

    const inCity = await firstHit(frame.ui, cityView)
    if (inCity) {
      io.log?.('info', `当前在城内（${inCity.id} 命中 ${inCity.score}），先切到世界地图。`)
      await io.tapRef(CITY_TO_MAP_TAP.x, CITY_TO_MAP_TAP.y)
      await sleep(2500)
      continue
    }

    // 认不出界面：可能有弹窗盖着，也可能在别的二级页。前两轮只等一等（动画/加载）。
    if (attempt <= 2) {
      io.log?.('warn', '暂时认不出当前界面，等 1.5s 再看一次（可能正在播动画或加载）。')
      await sleep(1500)
      continue
    }

    // 第三轮起先把这一帧交给上层探针（顶号 / 断网弹窗）。命中 ⇒ 告警中心已接管，别再折腾。
    if (await probeUnrecognized(io, frame.raw)) {
      throw new AppError(
        'NOT_FOUND',
        '采样时发现顶号 / 掉线类弹窗，已交给告警中心处理（暂停实例并推送），本次采样放弃。',
        { serial: io.serial }
      )
    }
    // ★ 活动弹窗（「光明精铸-自选宝物」这类带「前往」和右上角 × 的）会一直盖着主界面，
    //   不关掉采样就永远失败。第一招：右上半屏找弹窗的 ×，找到就点它（精准）。
    if (!closeTried && closePopup) {
      closeTried = true
      const x = await matchIn(frame.ui, closePopup, { roi: POPUP_CLOSE_ROI })
      if (x.found) {
        io.log?.('info', `右上角有弹窗关闭按钮（${x.score}），点它关掉活动弹窗。`)
        await io.tapRef(x.centerX, x.centerY)
        await sleep(900)
        continue
      }
    }
    // 第二招：盲按一次 BACK；主界面上按 BACK 会弹「确定要退出游戏吗」，
    // 所以紧接着必须检查并点「取消」，绝不点确定。
    if (!backTried) {
      backTried = true
      io.log?.('warn', '认不出当前界面，可能有活动弹窗盖着；按一次 BACK 试探（若弹出退出确认框会立刻点「取消」）。')
      await io.key('BACK')
      await sleep(1200)
      const after = await grab(io, opts)
      await dismissExitDialog(io, t, after.ui)
      continue
    }
    throw new AppError(
      'NOT_FOUND',
      '无法确认模拟器当前的界面，不敢盲点打开部队管理面板。\n' +
        '既没认出世界地图（放大镜 / 回城按钮 A·B），也没认出城内（地图按钮 A·B），面板标题也不在，' +
        '试过点弹窗 × 和按一次 BACK 之后仍然如此。\n' +
        '常见原因：有活动弹窗盖着、游戏还在加载、停在某个二级页，或者这是一个还没裁过导航模板的新阵营账号。\n' +
        '请手动回到世界地图后重试；若是新阵营（精灵等），请补裁城内 / 世界地图两态按钮的变体模板。',
      { serial: io.serial }
    )
  }

  throw new AppError('TIMEOUT', '连点几次都没能打开部队管理面板，已放弃本次采样。', {
    serial: io.serial
  })
}

/** 从模板集里挑出存在的那些（缺的静默跳过，由 anyTemplate 的其它成员顶上）。 */
function pickUi(t: SchedulerTemplates, ids: string[]): PreparedTemplate[] {
  return ids
    .map((id) => optionalUi(t, id))
    .filter((x): x is PreparedTemplate => Boolean(x))
}

/** anyTemplate：按顺序试，第一张命中的就返回（id + 分数），都不命中返回 null。 */
async function firstHit(
  frame: PreparedFrame,
  tpls: PreparedTemplate[]
): Promise<{ id: string; score: number } | null> {
  for (const tpl of tpls) {
    const m = await matchIn(frame, tpl)
    if (m.found) return { id: tpl.id, score: m.score }
  }
  return null
}

/** 把帧交给上层探针；探针没配 / 抛异常都按「未命中」处理。 */
async function probeUnrecognized(io: SampleIo, raw: RawFrame): Promise<boolean> {
  if (!io.onUnrecognized) return false
  try {
    return (await io.onUnrecognized(raw)) === true
  } catch {
    // 探针自己的问题不能拖垮采样流程的错误语义。
    return false
  }
}

/**
 * 认出「退出游戏确认框」就点「取消」。返回是否处理了一个确认框。
 * ★ 绝不点「确定」：那会直接退出游戏。
 */
async function dismissExitDialog(io: SampleIo, t: SchedulerTemplates, ui: PreparedFrame): Promise<boolean> {
  const exitTitle = optionalUi(t, TPL.exitDialogTitle)
  if (!exitTitle) return false
  const dlg = await matchIn(ui, exitTitle)
  if (!dlg.found) return false
  io.log?.('warn', '弹出了退出游戏确认框，立刻点「取消」（绝不会点确定）。')
  const cancel = optionalUi(t, TPL.btnCancel)
  if (!cancel) {
    io.log?.('warn', '模板集里没有「取消」按钮模板，请手动关掉这个确认框。')
    return true
  }
  const btn = await matchIn(ui, cancel)
  if (btn.found) {
    await io.tapRef(btn.centerX, btn.centerY)
    await sleep(600)
  } else {
    io.log?.('warn', '没定位到「取消」按钮，请手动关掉这个确认框。')
  }
  return true
}

/**
 * 关闭面板。
 *
 * ★ 世界地图上按 BACK 会弹「确定要退出游戏吗」，误点确定会直接退出游戏。
 *   所以这里 BACK 之后一定要复验：认出退出确认框就立刻点「取消」，绝不点确定。
 */
async function closePanel(io: SampleIo, t: SchedulerTemplates, opts: SampleOptions): Promise<void> {
  const title = requireUi(t, TPL.panelTitle)

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 1) await io.key('BACK')
    else await io.tapRef(TAP_OUTSIDE.x, TAP_OUTSIDE.y)
    await sleep(900)

    const frame = await grab(io, opts)
    if (await dismissExitDialog(io, t, frame.ui)) return

    const still = await matchIn(frame.ui, title, { roi: PANEL_TITLE_ROI })
    if (!still.found) {
      io.log?.('debug', '部队管理面板已关闭。')
      return
    }
    io.log?.('warn', `第 ${attempt} 次没关掉面板，换一种方式再试。`)
  }
  io.log?.('warn', '部队管理面板没能关掉，它会继续盖在世界地图上；下次采样会复用它，不影响读数。')
}

// ── 逐字段识别 ────────────────────────────────────────────────────────────

/** 读表头的队列 N/M。读不出返回 {null,null} 并给中文告警。 */
async function readQueue(
  digits: PreparedFrame,
  ui: PreparedFrame,
  t: SchedulerTemplates,
  warnings: string[]
): Promise<{ used: number | null; total: number | null }> {
  const icon = optionalUi(t, TPL.queueIcon)
  if (!icon) {
    warnings.push('缺少队列图标模板 tpl_queue_icon_panel，读不到行军队列占用（N/M）。')
    return { used: null, total: null }
  }
  const hit = await matchIn(ui, icon, { roi: QUEUE_ICON_ROI })
  if (!hit.found) {
    warnings.push(`表头队列图标没找到（${hit.reason ?? '原因未知'}），行军队列占用读不出来。`)
    return { used: null, total: null }
  }
  const roi: Rect = {
    x: hit.x + hit.w + QUEUE_DIGIT_REL.x,
    y: hit.y + QUEUE_DIGIT_REL.y,
    w: QUEUE_DIGIT_REL.w,
    h: hit.h + QUEUE_DIGIT_REL.h
  }
  const r = await readNumberText(digits, roi, t.dark, { pattern: FRACTION_PATTERN })
  const parsed = parseFraction(r.text)
  if (!parsed) {
    warnings.push(r.reason ?? '行军队列占用（N/M）识别失败。')
    return { used: null, total: null }
  }
  if (r.reason) warnings.push(r.reason)
  return { used: parsed.used, total: parsed.total }
}

/** 在一行的状态条里找状态词，返回分数最高的那个。 */
async function readStatusWord(
  ui: PreparedFrame,
  t: SchedulerTemplates,
  y: number
): Promise<{ spec: (typeof STATUS_TEMPLATES)[number]; hit: MatchResult } | null> {
  const roi = relRect(STATUS_BAR_REL, y)
  let best: { spec: (typeof STATUS_TEMPLATES)[number]; hit: MatchResult } | null = null
  for (const spec of STATUS_TEMPLATES) {
    const tpl = optionalUi(t, spec.id)
    if (!tpl) continue
    const hit = await matchIn(ui, tpl, { roi })
    if (hit.found && (best == null || hit.score > best.hit.score)) best = { spec, hit }
  }
  if (best) return best

  // 第二判据：进度条左端菱形图标里的白镐。「采集中」三个字压在进度条上，绿灰边界扫过时会被盖住，
  // 图标却始终在。只认出图标时，状态词的位置按固定排版兜底（倒计时 ROI 由它推）。
  const icon = optionalUi(t, TPL.statusIconGathering)
  if (!icon) return null
  const ih = await matchIn(ui, icon, { roi: relRect(STATUS_ICON_REL, y) })
  if (!ih.found) return null
  const spec = STATUS_TEMPLATES.find((s) => s.status === 'gathering')
  if (!spec) return null
  const fb = relRect(STATUS_WORD_FALLBACK_REL, y)
  const hit: MatchResult = {
    ...ih,
    templateId: spec.id,
    x: fb.x,
    y: fb.y,
    w: fb.w,
    h: fb.h,
    centerX: fb.x + fb.w / 2,
    centerY: fb.y + fb.h / 2
  }
  return { spec, hit }
}

/**
 * 按行左侧的资源点缩略图认出这支队在采什么。
 * 模板 id 形如 tpl_row_res_<type>[_变体]，同一类型可以有多张（不同等级的资源点美术可能不同）。
 * 取分最高的那张；没有任何模板或都不命中返回 null（行军中/返回中的行缩略图是部队图，本来就认不出）。
 */
async function readRowResource(
  ui: PreparedFrame,
  t: SchedulerTemplates,
  y: number
): Promise<MarchResourceType | null> {
  const roi = relRect(THUMB_REL, y)
  let best: { type: MarchResourceType; score: number } | null = null
  for (const [id, tpl] of t.ui) {
    if (!id.startsWith(TPL.rowResourcePrefix)) continue
    const type = id.slice(TPL.rowResourcePrefix.length).split('_')[0]
    if (type !== 'wood' && type !== 'gold' && type !== 'iron' && type !== 'mana') continue
    const m = await matchIn(ui, tpl, { roi })
    if (m.found && (best == null || m.score > best.score)) best = { type, score: m.score }
  }
  return best?.type ?? null
}

/**
 * 读状态词右边的倒计时。
 *
 * 两类行的渲染完全不同，字形集绝不可互换：
 *   · 采集中 —— 白字压在载重进度条上（居中），用 dig_light16；
 *   · 采集行军中 / 返回中 —— 深灰字直接压在浅蓝行底上（左对齐），用 dig_dark20。
 */
async function readRowTimer(
  digits: PreparedFrame,
  t: SchedulerTemplates,
  word: { spec: (typeof STATUS_TEMPLATES)[number]; hit: MatchResult }
): Promise<{ ms: number | null; warning?: string }> {
  const { hit, spec } = word
  // ★ 纵向必须**收紧到字带以内**：
  //   采集中那一行的文字是压在灰色进度条上的，ROI 一旦上下溢出到浅绿行底，
  //   分位数会把整条进度条当成前景，8 个字形会被切成 1 段，读出来只有一个 '?'。
  const left = spec.onProgressBar ? hit.x + hit.w - 6 : hit.x + hit.w + 2
  const top = spec.onProgressBar ? hit.y + 4 : hit.y + 3
  const height = spec.onProgressBar ? hit.h - 8 : hit.h - 6
  const roi: Rect = {
    x: left,
    y: top,
    w: Math.max(60, Math.min(206, STATUS_BAR_RIGHT - left)),
    h: Math.max(12, height)
  }
  const set = spec.onProgressBar ? t.light : t.dark
  const r = await readNumberText(digits, roi, set, { pattern: CLOCK_PATTERN })
  const ms = parseClockMs(r.text)
  if (ms == null) {
    return { ms: null, warning: r.reason ?? `第 ${spec.text} 行的倒计时识别失败。` }
  }
  return { ms, warning: r.reason }
}

/** 读行内的目标坐标（best-effort：dig_card_coord 已齐全，但读不出仍要按 null 处理）。 */
async function readRowCoord(
  digits: PreparedFrame,
  ui: PreparedFrame,
  t: SchedulerTemplates,
  y: number
): Promise<{ coord: string | null; hitFound: boolean }> {
  const label = optionalUi(t, TPL.coordLabel)
  if (!label) return { coord: null, hitFound: false }
  // ★ 必须限死在行内的 x 带里：tpl_label_coord_row 打在资源卡的「坐标:」上能到 0.957，
  //   全屏匹配一定会串台。
  const hit = await matchIn(ui, label, { roi: relRect(COORD_LABEL_REL, y) })
  if (!hit.found) return { coord: null, hitFound: false }
  if (!t.coord) return { coord: null, hitFound: true }

  // ★ 这行文字带下划线（实测 y>=341 就是下划线），ROI 必须停在它上面；
  //   右侧 x>=1375 还有别的元素，宽度给到 120 就够（实测数字止于 1321）。
  const roi: Rect = { x: hit.x + hit.w - 2, y: hit.y + 4, w: 120, h: Math.max(8, hit.h - 6) }
  const r = await readNumberText(digits, roi, t.coord, { pattern: COORD_PATTERN })
  return { coord: parseCoord(r.text), hitFound: true }
}

/** 读两名指挥官的耐力（best-effort：dig_stamina 目前只有 0 1 5 /）。 */
async function readRowStamina(
  digits: PreparedFrame,
  ui: PreparedFrame,
  t: SchedulerTemplates,
  y: number
): Promise<StaminaValue[]> {
  const out: StaminaValue[] = []
  const drop = optionalUi(t, TPL.staminaDrop)
  for (const band of STAMINA_BANDS_REL) {
    const empty: StaminaValue = { current: null, max: null }
    if (!drop || !t.stamina) {
      out.push(empty)
      continue
    }
    const hit = await matchIn(ui, drop, { roi: relRect(band, y) })
    if (!hit.found) {
      out.push(empty)
      continue
    }
    // 白字 + 黑描边压在蓝色耐力条上：纵向必须贴着字带，溢出到条的高光边就会切不开。
    const roi: Rect = { x: hit.x + hit.w + 4, y: hit.y + 12, w: 130, h: 22 }
    const r = await readNumberText(digits, roi, t.stamina, { pattern: FRACTION_PATTERN })
    const parsed = parseFraction(r.text)
    out.push(parsed ? { current: parsed.used, max: parsed.total } : empty)
  }
  return out
}

// ── 主入口 ────────────────────────────────────────────────────────────────

/**
 * 打开部队管理面板，读一次，然后关掉。
 *
 * 任何一步失败都会抛带中文说明的 AppError —— **绝不吞异常、绝不返回猜测值**。
 * 单个字段读不出时不抛错，而是把该字段置 null 并在 warnings 里写清楚原因，
 * 由调度层决定是降级还是重试。
 */
export async function sampleTroopPanel(
  io: SampleIo,
  t: SchedulerTemplates,
  opts: SampleOptions
): Promise<PanelSample> {
  const warnings: string[] = []
  const { ui, digits, noMarches } = await ensurePanelOpen(io, t, opts)
  const sampledAt = Date.now()

  if (noMarches) {
    // 没有队伍在野外 ⇒ 面板根本打不开（入口不存在）。按「全空」返回：
    // 队列上限此刻读不到，用配置里的 maxRows（= 队列上限）估计，派兵后下一次采样会读到真实值。
    const total = Math.max(1, Math.min(8, opts.maxRows))
    warnings.push(
      `世界地图右侧没有部队管理入口，判定没有队伍在野外；队列上限按配置 ${total} 估计（派兵后会读到真实值）。`
    )
    const rows: RowSample[] = []
    for (let slot = 1; slot <= total; slot++) {
      rows.push({
        slot,
        status: 'idle',
        statusText: '空闲',
        remainingMs: null,
        targetCoord: null,
        troopCount: null,
        commanders: [],
        resourceType: null
      })
    }
    return { sampledAt, queueUsed: 0, queueTotal: total, rows, warnings }
  }

  const queue = await readQueue(digits, ui, t, warnings)
  checkDeadline(opts, '读取表头队列占用')

  const rows: RowSample[] = []
  const maxRows = Math.max(1, Math.min(8, opts.maxRows))
  // ★ 先扫出真实行中心，再逐行识别；扫不到的行（空位）退回固定行距。
  const centers = await detectRowCenters(ui, t, maxRows)
  const drift = centers.map((c, i) => c - rowY(i + 1)).filter((d) => Math.abs(d) > 10)
  if (drift.length > 0) {
    io.log?.('debug', `行中心相对固定行距有偏移：${centers.map((c, i) => `${i + 1}:${c - rowY(i + 1)}`).join(' ')}（已按扫描结果识别）。`)
  }
  for (let slot = 1; slot <= maxRows; slot++) {
    checkDeadline(opts, `识别第 ${slot} 行`)
    const y = centers[slot - 1] ?? rowY(slot)

    const word = await readStatusWord(ui, t, y)
    const coordProbe = await readRowCoord(digits, ui, t, y)

    if (!word) {
      if (!coordProbe.hitFound) {
        // 没状态词也没坐标 —— 这一行是空的（队列空位）。
        rows.push({
          slot,
          status: 'idle',
          statusText: '空闲',
          remainingMs: null,
          targetCoord: null,
          troopCount: null,
          commanders: [],
          resourceType: null
        })
        continue
      }
      // 有内容但状态词认不出来：多半是「驻扎中/集结中/战斗中」这些还没采模板的状态。
      const warning =
        `第 ${slot} 行有队伍但状态词认不出来（已知模板只有 采集中 / 采集行军中 / 返回中）。` +
        '按兜底 ETA 处理，请在这种状态出现时补采模板。'
      warnings.push(warning)
      rows.push({
        slot,
        status: 'unknown',
        statusText: '未知状态',
        remainingMs: null,
        targetCoord: coordProbe.coord,
        troopCount: null,
        commanders: [],
        resourceType: await readRowResource(ui, t, y),
        warning
      })
      continue
    }

    const timer = await readRowTimer(digits, t, word)
    if (timer.warning) warnings.push(`第 ${slot} 行：${timer.warning}`)

    // ★ 兵力（如 31,500）在这个面板上是**白字 + 黑描边**，而现有的 dig_dark20 是
    //   浅底深字的那一套（从资源点卡片的储量裁的）。TM_CCOEFF_NORMED 跨极性是强负相关，
    //   拿它去打白字一个都打不中。所以这里**不读兵力**，等补一套白字字形再说。
    //   调度本身也用不到兵力，它只影响面板显示。
    const troopCount: number | null = null
    const commanders = opts.readOptionalFields ? await readRowStamina(digits, ui, t, y) : []

    // 资源类型：采集中的行左侧是资源点缩略图；行军中/返回中是部队图，识别不到就 null（由派兵记账补）。
    const resourceType = await readRowResource(ui, t, y)

    rows.push({
      slot,
      status: word.spec.status,
      statusText: word.spec.text,
      remainingMs: timer.ms,
      targetCoord: coordProbe.coord,
      troopCount,
      commanders,
      resourceType,
      warning: timer.warning
    })
  }

  // 行数与表头 N 对不上是重要信号：要么有行没认出来，要么面板还没画完。
  const busyRows = rows.filter((r) => r.status !== 'idle').length
  if (queue.used != null && busyRows !== queue.used) {
    warnings.push(
      `表头显示已用队列 ${queue.used}，但只识别出 ${busyRows} 行有内容。` +
        '可能有状态词没认出来，或者面板还在动画中。本次读数按行识别结果为准，并已缩短下次校准间隔。'
    )
  }

  if (opts.closePanelAfterSample) {
    try {
      await closePanel(io, t, opts)
    } catch (e) {
      // 关不掉不该让整次采样白跑 —— 数据已经读到手了。
      warnings.push(`关闭部队管理面板失败：${AppError.from(e).message}`)
    }
  }

  return { sampledAt, queueUsed: queue.used, queueTotal: queue.total, rows, warnings }
}
