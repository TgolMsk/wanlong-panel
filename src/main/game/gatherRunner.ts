/**
 * 「ETA 调度器」与「自动采集流程」之间的接线层。
 *
 * 两边都刻意不认识对方：
 *   · `@main/scheduler` 只负责「什么时候该去看一眼」和「看到了什么」，
 *     队列出现空位时调一次 `QueueFreeHook`，**不决定派哪一队去哪里**。
 *   · `@main/game/gather` 只负责「派一队去哪里」，它不写磁盘、不起定时器、不注册 IPC。
 * 中间缺的这三件事就是本文件干的：
 *   ① 取 serial / 模板目录 / 每个实例的采集配置（配置页写在账号的 scriptParams.gather.configJson 里）
 *   ② `GatherRuntimeState` 的落盘与回读（等级上限缓存 / 在途记账 / 退避档位都在里面，
 *      runGatherCycle 自己**不写盘**，不存回去的话每一轮都要重新探测等级上限）
 *   ③ 派兵成功后回调 `scheduler.noteDispatch()`，把只有派兵那一刻读得到的单程行军耗时交回去
 *
 * ★ 这个钩子是在**调度器的实例锁内**被调用的（同一个模拟器同时只允许一条链在跑），
 *   所以这里不需要再加自己的互斥；但也因此**绝不能**在这里去 await 另一个会抢同一把锁的东西。
 *   `noteDispatch` 是安全的：调度器对同一异步上下文做了重入放行。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { KickedProbeResult } from '@shared/alerts'
import { AppError } from '@shared/errors'
import type { LogLevel } from '@shared/script'
import type { RawFrame } from '@shared/vision'
import type { InstanceQueueState, MarchResourceType } from '@shared/scheduler'

import {
  GAME_PACKAGE,
  createAdbGatherIo,
  createRuntimeState,
  loadGatherTemplates,
  normalizeGatherConfig,
  runGatherCycle,
  type DispatchRecord,
  type GatherCycleResult,
  type GatherRuntimeState,
  type GatherTemplates
} from './gather/index'

/** 采集运行期状态的落盘文件名（放在 dataDir 根下，与 scheduler.json 并列）。 */
const STATE_FILE = 'gather-state.json'

/** 配置页把采集配置塞在账号的这个「脚本参数」槽里。 */
const CONFIG_SCRIPT_KEY = 'gather'
const CONFIG_FIELD = 'configJson'

export interface GatherRunnerDeps {
  /** 运行数据根目录。每次现取 —— 用户可能改了数据目录。 */
  dataDir(): string
  /** 模板库目录。 */
  templatesDir(): string
  /** 实例 index -> 已连接设备的 serial。 */
  resolveSerial(instanceIndex: number): Promise<string>
  /**
   * 取该实例的采集配置（原样返回配置页存的对象，未归一化）。
   * 读不到就返回 null，本模块会退回默认配置。
   */
  loadConfig(instanceIndex: number): Promise<unknown | null>
  /** 派兵成功后把单程行军耗时交回调度器。 */
  noteDispatch(
    instanceIndex: number,
    info: {
      travelTimeMs: number | null
      coord?: string | null
      resourceType?: MarchResourceType | null
    }
  ): Promise<void>
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void
  /**
   * 留痕钩子（可选）。给的是裸帧，编码与落盘由调用方决定。
   * 返回落盘后的相对路径（相对 <dataDir>/shots）；没存就返回 null/undefined。
   * ★ 那个路径会被写进告警事件，面板据此显示「现场截图」。
   */
  onShot?(instanceIndex: number, label: string, raw: RawFrame): Promise<string | null | void>
  /**
   * 第二层「顶号」精确识别（可选）。
   *
   * 只在**采集失败留痕**的那一刻被调用，用的就是那张已经截好的裸帧，**不会额外截图**。
   * ★ 模板缺失时实现方必须返回 null（静默降级到第一层通用兜底），绝不允许抛异常。
   */
  probeKicked?(
    instanceIndex: number,
    raw: RawFrame,
    templates: GatherTemplates
  ): Promise<KickedProbeResult | null>
  /**
   * 一轮采集结束后的事实通报（可选），交给告警模块做「连续失败 → 需要人工介入」的判定。
   *
   * ★ 它是在**调度器的实例锁内**被调用的，实现方不得在里面 await 任何会抢同一把锁的东西
   *   （例如 scheduler.sampleNow / setAuto(true)）。关掉 auto（setAuto(false)）是安全的。
   * ★ 实现方**不应抛异常**；真抛了本模块也会吞掉并记一条告警日志 —— 告警链路自己坏掉
   *   绝不能连累采集主流程。
   */
  onCycleResult?(instanceIndex: number, fact: GatherCycleFact): Promise<void>
  /**
   * 本轮派兵成功的逐条记录（可选），交给数据统计做「派兵次数 / 预计采集量」记账。
   *
   * 派兵时读到的卡片储量（DispatchRecord.storage）精确到个位，配置默认勾「自动采集至清空」，
   * 所以一趟的采集量 ≈ 储量 —— 这是日统计的主数据源。
   * ★ 在 onCycleResult 之后、往调度器抛错之前调用；实现方抛错只记一条 warn，绝不连累采集与派兵记账。
   */
  onDispatched?(instanceIndex: number, records: DispatchRecord[], at: number): Promise<void> | void
}

export type { DispatchRecord }

/** 一轮采集结束后交给告警模块的事实。只有事实，不含结论。 */
export interface GatherCycleFact {
  outcome: GatherCycleResult['outcome']
  /** 中文摘要，可直接显示。 */
  message: string
  /**
   * 失败发生在哪一步。★ `'G0'` 表示「未知界面恢复阶梯已用尽」——
   * 这是最强的「卡死/顶号」信号，告警模块用更小的阈值对待它。
   *
   * 之所以要在这里单独拎出来：`createQueueFreeHook` 往调度器抛的时候会重新包一层 AppError，
   * 原来的 `detail.step` 在那一层就丢了，调度器只能看到一句中文。
   */
  step: string | null
  /** 失败的错误码（SerializedError.code）。 */
  errorCode: string | null
  /** 本轮派出了几支队。 */
  dispatched: number
  /** 本轮截图数。 */
  captures: number
  /** 现场截图（相对 <dataDir>/shots）；没留到为 null。 */
  shotPath: string | null
  /** 第二层顶号识别的结论；模板缺失或没命中为 null。 */
  kicked: KickedProbeResult | null
}

/**
 * 哪些留痕标签算「失败现场」。
 *   g0-failed    未知界面恢复阶梯 6 轮全跑完仍回不到世界地图（ensureWorldMap 抛错前留的）
 *   cycle-error  本轮以异常收场（flow.ts 的兜底 catch 里留的）
 * 只有这两个标签会触发第二层识别与「现场截图」记账，别的标签（g0-unknown-N 等）只是过程留痕。
 */
export const FAILURE_SHOT_LABELS: ReadonlySet<string> = new Set([
  'g0-failed',
  'cycle-error',
  // 顶号 / 健康探针命中时的现场，必须留痕给面板与推送看。
  'kicked',
  'health-probe'
])

/** 从账号的 scriptParams 里把采集配置抠出来。给 deps.loadConfig 用的现成实现。 */
export function readGatherConfigFromAccount(account: {
  scriptParams?: Record<string, Record<string, string | number | boolean>>
}): unknown | null {
  const raw = account.scriptParams?.[CONFIG_SCRIPT_KEY]?.[CONFIG_FIELD]
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    // 存坏了不该让整条链路挂掉：退回默认配置，由调用方的 log 提示用户重存一次。
    return null
  }
}

// ── 运行期状态的落盘 ───────────────────────────────────────────────────────

type StateFile = Record<string, GatherRuntimeState>

async function loadStates(dataDir: string): Promise<StateFile> {
  try {
    const text = await readFile(join(dataDir, STATE_FILE), 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as StateFile
  } catch {
    // 文件不存在 / 读坏了都按「从空状态开始」处理 —— 状态本身是缓存，丢了只是慢一点。
    return {}
  }
}

async function saveState(
  dataDir: string,
  instanceIndex: number,
  state: GatherRuntimeState
): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const all = await loadStates(dataDir)
  all[String(instanceIndex)] = state
  await writeFile(join(dataDir, STATE_FILE), JSON.stringify(all, null, 2), 'utf8')
}

// ── 模板缓存 ───────────────────────────────────────────────────────────────
//
// 模板编译不便宜（93 张，界面模板 shrink=2 + 字形 shrink=1 两档），
// 而且每次编译都会新占一份内存，**绝不能每轮重编**。按模板目录缓存一份即可。

let cachedTemplates: { dir: string; value: GatherTemplates } | null = null

/** 按模板目录缓存的采集模板集（顶号探针等外部模块也用它，避免各编一份）。 */
export async function getGatherTemplates(
  dir: string,
  log: GatherRunnerDeps['log']
): Promise<GatherTemplates> {
  return templatesFor(dir, log)
}

async function templatesFor(dir: string, log: GatherRunnerDeps['log']): Promise<GatherTemplates> {
  if (cachedTemplates && cachedTemplates.dir === dir) return cachedTemplates.value
  const value = await loadGatherTemplates({
    templatesDir: dir,
    packageName: GAME_PACKAGE,
    onWarn: (m, d) => log('warn', `采集模板：${m}`, d)
  })
  cachedTemplates = { dir, value }
  log(
    'info',
    `采集模板集 ${value.setId} 已编译：界面模板 ${value.ui.size} 张，字形集 ${value.glyphSets.size} 套` +
      (value.missing.length > 0
        ? `，缺 ${value.missing.length} 张（${value.missing.join('、')}）`
        : '')
  )
  return value
}

/** 模板库被改动过（新增/删除模板）时调一次，下一轮会重新编译。 */
export function invalidateGatherTemplates(): void {
  cachedTemplates = null
}

// ── 主体 ───────────────────────────────────────────────────────────────────

/**
 * 跑一轮自动采集。**不抛异常**：结果全在返回值里。
 * 直接调它可以做「手动派一轮」；接给调度器请用下面的 `createQueueFreeHook`。
 */
export async function runGatherForInstance(
  deps: GatherRunnerDeps,
  instanceIndex: number,
  signal?: AbortSignal
): Promise<GatherCycleResult> {
  return (await runGatherWithContext(deps, instanceIndex, signal)).result
}

/**
 * 与 `runGatherForInstance` 同一条流程，另外把「告警模块需要的事实」一并带出来
 * （现场截图路径、第二层顶号识别结论、失败发生在哪一步）。
 *
 * 拆成两个函数是因为这些事实**取不到第二次**：裸帧 14.7MB，留痕那一刻不顺手处理掉，
 * 之后就只能再截一张图（要动模拟器，还未必还停在出事的那个界面）。
 */
export async function runGatherWithContext(
  deps: GatherRunnerDeps,
  instanceIndex: number,
  signal?: AbortSignal
): Promise<{ result: GatherCycleResult; fact: GatherCycleFact }> {
  const dataDir = deps.dataDir()
  const templates = await templatesFor(deps.templatesDir(), deps.log)
  const serial = await deps.resolveSerial(instanceIndex)
  const io = createAdbGatherIo({ serial })

  const rawConfig = await deps.loadConfig(instanceIndex)
  const config = normalizeGatherConfig(
    (rawConfig ?? {}) as Parameters<typeof normalizeGatherConfig>[0]
  )
  if (!rawConfig) {
    deps.log(
      'info',
      `实例 ${instanceIndex} 没有存过采集配置，本轮用默认配置` +
        '（在「采集配置」页保存一次就会写进该实例绑定的账号里）。'
    )
  }

  const states = await loadStates(dataDir)
  const state = states[String(instanceIndex)] ?? createRuntimeState()

  // 失败现场的两件东西：截图落盘路径、第二层识别结论。都在留痕那一刻顺手取到。
  let shotPath: string | null = null
  let kicked: KickedProbeResult | null = null
  let probed = false

  const onShot =
    deps.onShot || deps.probeKicked
      ? async (label: string, raw: RawFrame): Promise<void> => {
          const isFailure = FAILURE_SHOT_LABELS.has(label)
          if (deps.onShot) {
            try {
              const saved = await deps.onShot(instanceIndex, label, raw)
              if (isFailure && typeof saved === 'string' && saved) shotPath = saved
            } catch (e) {
              // 留痕失败绝不能让这一轮采集（乃至后面的暂停判定）失败。
              deps.log(
                'warn',
                `[实例${instanceIndex}] 留痕「${label}」落盘失败：${AppError.from(e).message}`
              )
            }
          }
          // 第二层识别只在失败现场跑一次：模板缺失时实现方会立刻返回 null，几乎零开销。
          if (isFailure && !probed && deps.probeKicked) {
            probed = true
            try {
              kicked = await deps.probeKicked(instanceIndex, raw, templates)
            } catch (e) {
              deps.log(
                'warn',
                `[实例${instanceIndex}] 顶号识别出错，本次按通用兜底处理：${AppError.from(e).message}`
              )
            }
          }
        }
      : undefined

  const result = await runGatherCycle({
    io,
    templates,
    config,
    state,
    signal,
    log: (level, message, data) => deps.log(level, `[实例${instanceIndex}] ${message}`, data),
    onShot
  })

  // ★ 必须存回去：等级上限缓存 / 在途记账 / 退避档位都在里面。
  //   存盘失败不该让「已经派出去的兵」白派，所以只告警不抛。
  try {
    await saveState(dataDir, instanceIndex, result.state)
  } catch (e) {
    deps.log(
      'warn',
      `实例 ${instanceIndex} 的采集运行期状态没存下来（下一轮会重新探测等级上限）：` +
        AppError.from(e).message
    )
  }

  const detailStep = (result.error?.detail as { step?: unknown } | undefined)?.step
  const fact: GatherCycleFact = {
    outcome: result.outcome,
    message: result.message,
    step: typeof detailStep === 'string' ? detailStep : null,
    errorCode: result.error?.code ?? null,
    dispatched: result.dispatched.length,
    captures: result.captures,
    shotPath,
    kicked
  }

  return { result, fact }
}

/**
 * 造一个可以直接交给 `getScheduler().setQueueFreeHook()` 的钩子。
 *
 * 调度器在「队列确认有空位」时调它；派兵成功就回调 `noteDispatch`，
 * 那条路会重新采样面板并按新的 ETA 重排唤醒 —— 所以这里**不需要**自己排定时器。
 */
export function createQueueFreeHook(
  deps: GatherRunnerDeps
): (state: InstanceQueueState) => Promise<void> {
  /** 把一次「压根没跑起来」的失败也通报给告警模块。★ 通报本身出错不许连累主流程。 */
  const reportQuietly = async (index: number, fact: GatherCycleFact): Promise<void> => {
    if (!deps.onCycleResult) return
    try {
      await deps.onCycleResult(index, fact)
    } catch (e) {
      // 告警链路自己坏掉绝不能连累采集：这里只记一条，流程照常继续。
      deps.log('warn', `[实例${index}] 异常检测模块处理本轮结果时出错：${AppError.from(e).message}`)
    }
  }

  return async (queue: InstanceQueueState): Promise<void> => {
    const index = queue.instanceIndex

    let ctx: { result: GatherCycleResult; fact: GatherCycleFact }
    try {
      ctx = await runGatherWithContext(deps, index)
    } catch (e) {
      // ★ 这一轮**压根没跑起来**：模板集加载失败、解析不出 serial、账号配置读不出来……
      //   这些错在 runGatherWithContext 里就抛了，走不到下面那次通报。
      //   不在这里补一刀的话，「设备/模板一直坏着」就会永远只在调度器里退避重试，
      //   连续失败计数一次都不涨，用户永远等不到「需要人工介入」那条推送。
      const err = AppError.from(e)
      await reportQuietly(index, {
        outcome: 'error',
        message: `采集流程没能启动：${err.message}`,
        // 没有走到状态机，所以没有步骤号；这条只进普通的「连续失败」计数。
        step: null,
        errorCode: err.code,
        dispatched: 0,
        captures: 0,
        shotPath: null,
        kicked: null
      })
      throw err
    }

    const { result, fact } = ctx

    for (const w of result.warnings) deps.log('warn', `[实例${index}] ${w}`)

    // ★ 必须在 throw 之前通报：outcome==='error' 那条路是往上抛的，
    //   抛出去之后 detail.step 会被调度器那层重新包掉，再想判「恢复阶梯用尽」就来不及了。
    await reportQuietly(index, fact)

    // 派兵记账交给数据统计。★ 统计链路坏了绝不连累采集：只记一条 warn。
    if (result.dispatched.length > 0 && deps.onDispatched) {
      try {
        await deps.onDispatched(index, result.dispatched, Date.now())
      } catch (e) {
        deps.log('warn', `[实例${index}] 数据统计记派兵时出错（不影响采集）：${AppError.from(e).message}`)
      }
    }

    if (result.outcome === 'error') {
      // 往上抛：调度器接住之后会走退避重排，比在这里自己吞掉更符合它的状态机。
      throw new AppError('STEP_FAILED', result.message, { instanceIndex: index })
    }

    deps.log(
      result.dispatched.length > 0 ? 'info' : 'debug',
      `[实例${index}] 自动采集本轮结束：${result.message}`,
      { outcome: result.outcome, dispatched: result.dispatched.length, captures: result.captures }
    )

    for (const d of result.dispatched) {
      if (d.travelTimeSec === null) {
        deps.log(
          'warn',
          `[实例${index}] 这一趟没读出单程行军耗时，调度器只能用兜底值估 freeAt（会偏保守）。`
        )
      }
      // ★ 耗时没读到也要记账：坐标 + 资源类型是面板显示「这支队在采什么」的唯一来源
      //   （行军中/返回中的行缩略图是部队图，认不出资源）。
      await deps.noteDispatch(index, {
        travelTimeMs: d.travelTimeSec === null ? null : d.travelTimeSec * 1000,
        coord: d.coord,
        resourceType: d.resource
      })
    }
  }
}
