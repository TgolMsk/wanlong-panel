/**
 * 可视化脚本编辑器「功能块」层（`src/shared/blocks.ts`）的**离线**自检。
 *
 * 测的是两部分纯逻辑（不 import React、不碰 DOM、不碰 IPC，所以能在纯 node 里跑）：
 *   一、块树的增删改查（路径定位、移动、复制、统计）
 *   二、DSL ⇄ 中文块的对照、默认值、一句话摘要
 *
 * 为什么值得测：这两个模块是「界面点一下 → 脚本 JSON 变成什么样」的全部逻辑。
 * 路径算错一个下标，用户就会看到「我明明删的是第 3 块，第 4 块没了」——
 * 这种 bug 在界面上很难复现，在这里两行就能钉死。
 *
 * 跑法（工程根目录）：
 *     npm run check:blocks
 */

import type { ScriptStep } from '@shared/script'
import type { TemplateDef } from '@shared/vision'
import {
  BLOCK_CATALOG,
  appendToBranch,
  blockIssue,
  branchesOf,
  childrenOf,
  cloneWithNewIds,
  collectIds,
  collectTemplateIds,
  countBlocks,
  describeBlock,
  getAt,
  insertAfter,
  kindOfStep,
  makeBlock,
  moveAt,
  movedPath,
  nextStepId,
  removeAt,
  samePath,
  templateIdOf,
  updateAt,
  withTemplateId,
  type BlockKind
} from '@shared/blocks'

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

/** 一棵有嵌套的样板树：tap / if(then 两块, else 一块) / loop(一块)。 */
function sample(): ScriptStep[] {
  return [
    { id: 'a', kind: 'tap', at: { x: 10, y: 20 } },
    {
      id: 'b',
      kind: 'if',
      cond: { kind: 'template', templateId: 'tpl_x' },
      then: [
        { id: 'b1', kind: 'sleep', ms: 100 },
        { id: 'b2', kind: 'tapTemplate', templateId: 'tpl_y' }
      ],
      else: [{ id: 'b3', kind: 'key', key: 'BACK' }]
    },
    {
      id: 'c',
      kind: 'loop',
      repeat: 3,
      steps: [{ id: 'c1', kind: 'screenshot' }]
    }
  ]
}

const templates: TemplateDef[] = [
  {
    id: 'tpl_x',
    name: '联盟按钮',
    file: 'tpl_x.png',
    authoredWidth: 2560,
    authoredHeight: 1440,
    bounds: { x: 0, y: 0, w: 40, h: 40 },
    createdAt: 0,
    updatedAt: 0
  },
  {
    id: 'tpl_y',
    name: '确定按钮',
    file: 'tpl_y.png',
    authoredWidth: 2560,
    authoredHeight: 1440,
    bounds: { x: 0, y: 0, w: 40, h: 40 },
    createdAt: 0,
    updatedAt: 0
  }
]

// ── 一、路径定位 ───────────────────────────────────────────────────────────

function checkLocate(): void {
  section('一、路径定位')
  const t = sample()
  ok('顶层取块', getAt(t, [1])?.id === 'b')
  ok('分支里取块', getAt(t, [1, 'then', 1])?.id === 'b2')
  ok('else 分支', getAt(t, [1, 'else', 0])?.id === 'b3')
  ok('循环体', getAt(t, [2, 'steps', 0])?.id === 'c1')
  ok('越界返回 null', getAt(t, [9]) === null)
  ok('走错分支返回 null', getAt(t, [0, 'then', 0]) === null)
  ok('空路径返回 null', getAt(t, []) === null)
  ok('samePath 认得同一条路径', samePath([1, 'then', 0], [1, 'then', 0]))
  ok('samePath 认得不同路径', !samePath([1, 'then', 0], [1, 'else', 0]))

  ok('branchesOf：if 两个分支', branchesOf(t[1]).join(',') === 'then,else')
  ok(
    'branchesOf：没有 else 时只报一个',
    branchesOf({ ...t[1], else: undefined } as ScriptStep).join(',') === 'then'
  )
  ok('branchesOf：loop 一个分支', branchesOf(t[2]).join(',') === 'steps')
  ok('branchesOf：叶子没有分支', branchesOf(t[0]).length === 0)
  ok('childrenOf 拿到子块', childrenOf(t[1], 'then').length === 2)
}

// ── 二、增删改 ─────────────────────────────────────────────────────────────

function checkMutate(): void {
  section('二、增删改（每次都返回新数组，绝不原地改）')
  const t = sample()
  const frozen = JSON.stringify(t)

  const updated = updateAt(t, [1, 'then', 0], { id: 'b1', kind: 'sleep', ms: 999 })
  const changed = getAt(updated, [1, 'then', 0])
  ok('改分支里的块', changed?.kind === 'sleep' && changed.ms === 999)
  ok('★ 原数组没被动过', JSON.stringify(t) === frozen)
  ok('没动到的兄弟块还在', getAt(updated, [1, 'then', 1])?.id === 'b2')

  const removed = removeAt(t, [1, 'then', 0])
  ok('删分支里的块', childrenOf(getAt(removed, [1]) as ScriptStep, 'then').length === 1)
  ok('删完剩下的是原来的第二块', getAt(removed, [1, 'then', 0])?.id === 'b2')

  const removedTop = removeAt(t, [0])
  ok('删顶层第一块', removedTop.length === 2 && removedTop[0].id === 'b')

  const inserted = insertAfter(t, [0], [{ id: 'new', kind: 'sleep', ms: 1 }])
  ok('插在指定块之后', inserted[1].id === 'new' && inserted[2].id === 'b')

  const appended = insertAfter(t, [], [{ id: 'tail', kind: 'sleep', ms: 1 }])
  ok('空路径 = 追加到末尾', appended[appended.length - 1].id === 'tail')

  const intoBranch = appendToBranch(t, [1], 'else', [{ id: 'e2', kind: 'sleep', ms: 1 }])
  ok('往分支末尾加块', childrenOf(getAt(intoBranch, [1]) as ScriptStep, 'else').length === 2)

  const intoLoop = appendToBranch(t, [2], 'steps', [{ id: 'c2', kind: 'sleep', ms: 1 }])
  ok('往循环体加块', childrenOf(getAt(intoLoop, [2]) as ScriptStep, 'steps').length === 2)
}

// ── 三、移动 ───────────────────────────────────────────────────────────────

function checkMove(): void {
  section('三、上下移动')
  const t = sample()
  const down = moveAt(t, [0], 1)
  ok('顶层下移', down[0].id === 'b' && down[1].id === 'a')

  const up = moveAt(t, [2], -1)
  ok('顶层上移', up[1].id === 'c' && up[2].id === 'b')

  ok('到顶了就不动', moveAt(t, [0], -1)[0].id === 'a')
  ok('到底了就不动', moveAt(t, [2], 1)[2].id === 'c')

  const inBranch = moveAt(t, [1, 'then', 1], -1)
  ok('分支内上移', getAt(inBranch, [1, 'then', 0])?.id === 'b2')
  ok('分支内移动不影响外层', inBranch[0].id === 'a' && inBranch[2].id === 'c')

  ok('movedPath 跟着挪', samePath(movedPath([1, 'then', 1], -1), [1, 'then', 0]))
}

// ── 四、id 与统计 ──────────────────────────────────────────────────────────

function checkIds(): void {
  section('四、id 生成与统计')
  const t = sample()
  const ids = collectIds(t)
  ok('收集到全部 id（含子块）', ids.size === 7, [...ids].join(','))
  ok('统计块数（含子块）', countBlocks(t) === 7)

  ok('新 id 不与现有冲突', !ids.has(nextStepId(t, 'tap')))
  const withTap1: ScriptStep[] = [...t, { id: 'tap-1', kind: 'sleep', ms: 1 }]
  ok('已被占用就往后找', nextStepId(withTap1, 'tap') === 'tap-2')

  const copy = cloneWithNewIds(t, t[1])
  ok('复制出来的块换了 id', copy.id !== 'b')
  ok(
    '★ 子块的 id 也全换了（否则保存时会报 id 重复）',
    copy.kind === 'if' && copy.then.every((s) => !ids.has(s.id)),
    copy.kind === 'if' ? copy.then.map((s) => s.id).join(',') : ''
  )
  ok('复制保留了内容', copy.kind === 'if' && copy.then.length === 2)

  const tplIds = collectTemplateIds(t)
  ok('收集到引用的模板', tplIds.has('tpl_x') && tplIds.has('tpl_y'), [...tplIds].join(','))
}

// ── 五、块目录 ─────────────────────────────────────────────────────────────

function checkCatalog(): void {
  section('五、块目录：DSL ⇄ 中文块')
  const kinds = BLOCK_CATALOG.map((b) => b.kind)
  ok('目录里没有重复的块', new Set(kinds).size === kinds.length)

  let roundTripOk = true
  let describeOk = true
  const bad: string[] = []
  for (const kind of kinds) {
    const step = makeBlock(kind as BlockKind, `${kind}-1`, 'tpl_x')
    if (kindOfStep(step) !== kind) {
      roundTripOk = false
      bad.push(`${kind}→${kindOfStep(step)}`)
    }
    const text = describeBlock(step, templates)
    if (!text || text.length === 0) {
      describeOk = false
      bad.push(`${kind} 没有摘要`)
    }
  }
  ok('★ 每种块「建出来再认回去」都还是同一种', roundTripOk, bad.join(' '))
  ok('每种块都有一句中文摘要', describeOk)

  const wait = makeBlock('waitAppear', 'w1', 'tpl_x')
  ok('等它出现 → waitFor + present 默认', wait.kind === 'waitFor' && wait.cond.kind === 'template')
  const gone = makeBlock('waitDisappear', 'w2', 'tpl_x')
  ok(
    '等它消失 → waitFor + present:false',
    gone.kind === 'waitFor' && gone.cond.kind === 'template' && gone.cond.present === false
  )

  const tap = makeBlock('tapTemplate', 't1', 'tpl_x')
  ok('摘要里是模板的中文名，不是 id', describeBlock(tap, templates).includes('联盟按钮'))
  ok('模板被删了就原样显示 id', describeBlock(tap, []).includes('tpl_x'))

  ok('templateIdOf 取得到', templateIdOf(tap) === 'tpl_x')
  ok('换模板', templateIdOf(withTemplateId(tap, 'tpl_y')) === 'tpl_y')
  ok('没有模板的块返回 null', templateIdOf(makeBlock('sleep', 's1')) === null)
}

// ── 六、一眼可见的问题 ─────────────────────────────────────────────────────

function checkIssues(): void {
  section('六、卡片上的黄标（一眼可见的问题）')
  const have = new Set(['tpl_x', 'tpl_y'])
  ok('没选模板要标出来', blockIssue(makeBlock('tapTemplate', 't', ''), have) === '还没选模板')
  ok(
    '模板不在模板集里要标出来',
    blockIssue(makeBlock('tapTemplate', 't', 'tpl_gone'), have)?.includes('不在') === true
  )
  ok('选对了就不标', blockIssue(makeBlock('tapTemplate', 't', 'tpl_x'), have) === null)
  ok('空文本要标', blockIssue(makeBlock('text', 't'), have) !== null)
  ok('坐标还是 0,0 要标', blockIssue(makeBlock('tap', 't'), have) !== null)
  ok(
    '循环既没次数也没条件要标',
    blockIssue({ id: 'l', kind: 'loop', steps: [] }, have)?.includes('一直转') === true
  )
  ok('正常的循环不标', blockIssue(makeBlock('loop', 'l'), have) === null)
}

function main(): void {
  console.log('===== 功能块离线自检（纯函数，不碰界面）=====')
  checkLocate()
  checkMutate()
  checkMove()
  checkIds()
  checkCatalog()
  checkIssues()
  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
  if (fail > 0) process.exitCode = 1
}

main()
