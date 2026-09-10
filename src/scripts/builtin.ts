/**
 * 内置示例脚本（随包分发，不可删、不可改）。
 *
 * 这里的脚本**刻意与任何具体游戏无关**，只用来给用户当「写法参考」：
 * 展示 waitFor / tapTemplate / if / loop / onFail / 参数插值这些通用能力怎么组合。
 * 等模板截好、游戏装好之后，具体游戏的脚本请由面板另存为用户脚本
 * （<dataDir>/scripts/<id>.json），不要往这个文件里塞游戏逻辑。
 *
 * 约定：内置脚本 id 一律以 BUILTIN_SCRIPT_PREFIX 开头，store/scripts.ts 靠它拒绝保存/删除。
 */

import { REF_HEIGHT, REF_WIDTH } from '@shared/constants'
import type { ScriptDef, ScriptMeta, ScriptStep } from '@shared/script'

/** 内置脚本 id 前缀。用户脚本禁止使用这个前缀。 */
export const BUILTIN_SCRIPT_PREFIX = 'builtin_'

/**
 * 内置脚本的 updatedAt 固定不变（不要用 Date.now()）：
 * 否则每次启动面板都会显示「刚刚更新」，也会让前端的列表 diff 一直抖动。
 */
const BUILTIN_UPDATED_AT = 1_757_000_000_000

/** 占位模板 id：用户按提示换成自己模板集里的真实 id。 */
const PLACEHOLDER_TEMPLATE = 'demo_target'
/** 占位包名：用户按提示换成真实游戏包名。 */
const PLACEHOLDER_PACKAGE = 'com.example.app'

/** 示例一：等某个模板出现 → 点它 → 留一张截图。这是 90% 自动化步骤的骨架。 */
const demoWaitTap: ScriptDef = {
  id: `${BUILTIN_SCRIPT_PREFIX}wait_tap`,
  name: '示例·等模板出现后点击',
  description:
    '通用写法示例：等待模板出现 → 点击它 → 截图留痕。' +
    `使用前请把模板 id「${PLACEHOLDER_TEMPLATE}」换成你自己模板集里的真实模板，并按需调整 ROI。`,
  version: '1.0.0',
  refWidth: REF_WIDTH,
  refHeight: REF_HEIGHT,
  params: [
    {
      key: 'waitSeconds',
      label: '等待上限（秒）',
      type: 'number',
      default: 30,
      note: '模板迟迟不出现时最多等多久；超时按 onFail 处置。'
    }
  ],
  steps: [
    {
      id: 'log_begin',
      kind: 'log',
      level: 'info',
      name: '开始',
      message: '示例脚本开始运行。请把 demo_target 换成你自己的模板 id。'
    },
    {
      id: 'wait_target',
      kind: 'waitFor',
      name: '等目标出现',
      // ROI 是最划算的加速（实测全屏 62ms → 单键 1.45ms），能填就填。
      cond: {
        kind: 'template',
        templateId: PLACEHOLDER_TEMPLATE,
        roi: { x: 0, y: 0, w: REF_WIDTH, h: REF_HEIGHT }
      },
      waitMs: 30_000,
      pollMs: 1000,
      // 等不到就直接结束，不要往下瞎点。
      onFail: { kind: 'abort' }
    },
    {
      id: 'tap_target',
      kind: 'tapTemplate',
      name: '点击目标',
      templateId: PLACEHOLDER_TEMPLATE,
      waitMs: 5000,
      pollMs: 500,
      afterDelayMs: 1200,
      retry: 1,
      retryDelayMs: 800
    },
    {
      id: 'shot_after',
      kind: 'screenshot',
      name: '点击后留痕',
      label: 'after-tap'
    },
    {
      id: 'log_done',
      kind: 'log',
      level: 'info',
      name: '结束',
      message: '示例脚本执行完毕。'
    }
  ],
  updatedAt: BUILTIN_UPDATED_AT
}

/** 示例二：应用保活巡检。展示 loop / if / not+foreground / 冷启动 的写法。 */
const demoKeepAlive: ScriptDef = {
  id: `${BUILTIN_SCRIPT_PREFIX}keep_alive`,
  name: '示例·应用保活巡检',
  description:
    '通用写法示例：每分钟检查一次目标应用是否在前台，掉出前台就冷启动拉回来。' +
    `使用前请把包名「${PLACEHOLDER_PACKAGE}」换成真实游戏包名（脚本头部和 foreground 条件里各有一处）。`,
  version: '1.0.0',
  packageName: PLACEHOLDER_PACKAGE,
  refWidth: REF_WIDTH,
  refHeight: REF_HEIGHT,
  loop: true,
  loopIntervalMs: 60_000,
  steps: [
    {
      id: 'check_foreground',
      kind: 'if',
      name: '检查前台应用',
      cond: {
        kind: 'not',
        of: { kind: 'foreground', packageName: PLACEHOLDER_PACKAGE }
      },
      then: [
        {
          id: 'log_lost',
          kind: 'log',
          level: 'warn',
          message: '目标应用不在前台，准备冷启动。'
        },
        {
          id: 'relaunch',
          kind: 'launchApp',
          name: '冷启动应用',
          cold: true,
          // 拉不起来也别炸整轮巡检，下一轮再试。
          onFail: { kind: 'continue' }
        },
        {
          id: 'wait_boot',
          kind: 'sleep',
          name: '等应用起来',
          ms: 20_000
        },
        {
          id: 'shot_relaunched',
          kind: 'screenshot',
          name: '冷启动后留痕',
          label: 'relaunched',
          capture: true
        }
      ],
      else: [
        {
          id: 'log_ok',
          kind: 'log',
          level: 'debug',
          message: '目标应用在前台，正常。'
        }
      ]
    }
  ],
  updatedAt: BUILTIN_UPDATED_AT
}

/** 全部内置脚本。 */
export const BUILTIN_SCRIPTS: readonly ScriptDef[] = Object.freeze([demoWaitTap, demoKeepAlive])

export function isBuiltinScriptId(id: string): boolean {
  return id.startsWith(BUILTIN_SCRIPT_PREFIX)
}

/** 取一份内置脚本的深拷贝（调用方可能会改它，别把常量改脏了）。 */
export function getBuiltinScript(id: string): ScriptDef | null {
  const found = BUILTIN_SCRIPTS.find((s) => s.id === id)
  return found ? (structuredClone(found) as ScriptDef) : null
}

/** 递归统计步骤总数（含 if / loop 的子步骤）。 */
export function countSteps(steps: readonly ScriptStep[]): number {
  let n = 0
  for (const s of steps) {
    n += 1
    if (s.kind === 'if') n += countSteps(s.then) + countSteps(s.else ?? [])
    else if (s.kind === 'loop') n += countSteps(s.steps)
  }
  return n
}

/** 内置脚本的列表元信息。 */
export function builtinScriptMetas(): ScriptMeta[] {
  return BUILTIN_SCRIPTS.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    version: s.version,
    packageName: s.packageName,
    templateSetId: s.templateSetId,
    stepCount: countSteps(s.steps),
    updatedAt: s.updatedAt,
    builtin: true
  }))
}
