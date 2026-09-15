/**
 * ETA 驱动的采集调度器。
 *
 * 它解决的问题：10 个账号 × 5 支队，轮询式要几十次截图/分钟；
 * ETA 式在空闲期**接近零 adb 调用** —— 因为倒计时是确定性递减的，读一次就能本地推到底。
 *
 *   采样：打开部队管理面板 → 读每行 (状态词, 剩余时间) → 读完即关
 *   记账：freeAt = sampledAt + 采集剩余 + travelTime      （绝对时刻，跨重启有效）
 *   显示：面板每秒本地递推，零 adb 开销
 *   调度：定时器挂在 freeAt + slack 上（**宁晚勿早**），到点再开面板校验
 *   兜底：唤醒后队列仍未空 -> 指数退避 30s→60s→120s→封顶 5min；每 15 分钟周期校准一次
 *
 * ★ 与执行器（orchestrator）的边界：
 *   主进程和每个 utilityProcess 各持一份 adb 队列单例，**跨进程不共享**。
 *   所以某个实例上有脚本在跑时，调度器**绝不去动它** —— 两边同时驱动同一个模拟器
 *   会互相插入点击，后果不可预测。这一条由 deps.busyRunIdOf 把关。
 *
 * ★ 关于「主进程不做视觉」这条纪律：
 *   本模块确实在主进程里跑匹配，这是有意的例外，代价也算过：
 *   采样是低频事件（每支队一个采集周期只需 2 次），单次几百个小 ROI 匹配，
 *   且 digits.ts 每 24 次匹配就让出一次事件循环，不会像脚本执行那样持续占满主线程。
 *   把它塞进 utilityProcess 需要新开一个 rollup 入口（改 electron.vite.config.ts），
 *   收益不足以抵消复杂度。若将来采样频率上去了，再搬。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { refToDevice } from '@shared/constants'
import type { DeviceInfo } from '@shared/domain'
import { AppError } from '@shared/errors'
import type { AndroidKey } from '@shared/script'
import type {
  InstanceQueueState,
  MarchResourceType,
  SchedulerConfig,
  TravelTimeSource,
  WakeInfo
} from '@shared/scheduler'
import { SCHED_CH, defaultSchedulerConfig } from '@shared/scheduler'
import type { RawFrame } from '@shared/vision'

import { ensureGameForeground, type GamePresence } from '@main/game/launch'
import { emitScheduler, handleScheduler, resetSchedulerIpc } from './ipc'
import {
  applySample,
  backoffMs,
  emptyInstanceState,
  hasFreeSlot,
  planNextWake,
  HEALTH_PROBE_REASON,
  type TravelHint
} from './state'
import { loadSchedulerFile, mergeConfig, saveSchedulerFile, toPersisted } from './store'
import { cancelAllWakes, cancelWake, getWake, listWakes, scheduleWake } from './timers'
import { getTemplates, invalidateTemplates } from './templates'
import { sampleTroopPanel, type PanelSample, type SampleIo } from './troopPanel'

// ── 依赖注入 ──────────────────────────────────────────────────────────────

/** 调度器需要的设备能力（只要这三样，其余一概不碰）。 */
export interface SchedulerAdbPort {
  capture(serial: string): Promise<RawFrame>
  tap(serial: string, x: number, y: number): Promise<void>
  key(serial: string, k: AndroidKey): Promise<void>
  /** 前台包名（健康探针 + 冷启动恢复用，可选）。 */
  foregroundPackage?(serial: string): Promise<string | null>
  /** 某包的进程是否还活着（健康探针 + 冷启动恢复用，可选）。 */
  isRunning?(serial: string, pkg: string): Promise<boolean>
  /**
   * 拉起游戏（冷启动恢复用，可选）。
   * ★ 实现**必须**是 monkey：`am start` 对《万龙觉醒》返回成功但进程起不来（adb/apps.ts 有实测记录）。
   * 不接这个能力时，「模拟器刚开机、游戏没跑」就只能靠人工恢复。
   */
  launchApp?(serial: string, pkg: string): Promise<void>
}

export interface SchedulerDeps {
  /** 运行数据根目录（scheduler.json 落在这里）。每次现取，用户可能改了数据目录。 */
  dataDir(): string
  /** 参考分辨率，来自 app settings。 */
  refSize(): { refWidth: number; refHeight: number }
  /** 实例 index -> 已连接的设备信息（内部负责必要时 attach）。 */
  resolveDevice(instanceIndex: number): Promise<DeviceInfo>
  /**
   * 该实例上是否有脚本在跑；有就返回 runId。
   * ★ 这是调度器与执行器之间唯一的互斥手段，必须接上，不能给个恒返回 null 的桩。
   */
  busyRunIdOf(instanceIndex: number): string | null
  /** 实例绑定的账号 id（用于面板显示）。 */
  accountIdOf?(instanceIndex: number): Promise<string | null>
  adb: SchedulerAdbPort
  /** 中文日志。默认打到 console。 */
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
  /**
   * 每次「开部队管理面板采样」的成败通报（可选，不接照常跑）。
   *
   * 异常检测模块用它累计「连续采样失败」→ 判定模拟器或游戏掉线。
   * ★ 只通报**真的去读了面板**的那些：被采样节流跳过、被「实例上有脚本在跑」让路的，
   *   都不算失败，不会走到这里。
   * ★ 实现方不得抛异常（真抛了这里也会吞掉），更不得在里面 await 调度器自己的方法。
   */
  onSampleResult?(instanceIndex: number, ok: boolean, message: string | null): void
  /**
   * 采样器认不出界面时，把那一帧交出来跑探针（顶号弹窗等）。
   * 返回 true = 探针命中并已接管（告警中心暂停实例），采样器就不再按 BACK 试探。
   * 在实例锁内被调用：实现方只能做识别 + 抛告警，**不得** await 调度器自己的方法。
   */
  onUnrecognizedFrame?(instanceIndex: number, raw: RawFrame): Promise<boolean | 'recovered' | void>
  /**
   * 健康探针：到点截一帧（不开面板）交给上层，附带前台包名与游戏进程存活情况。
   * 同样在实例锁内，同样不得 await 调度器方法。
   */
  onHealthProbe?(
    instanceIndex: number,
    raw: RawFrame,
    ctx: { foreground: string | null; running: boolean | null }
  ): Promise<void>
  /** 健康探针要盯的游戏包名；不给就不做进程存活判断。 */
  gamePackage?(): string
  /**
   * 「上次采样还在外面的队伍，这次面板上不见了」的通报（可选）—— 数据统计据此记「完成趟数」。
   *
   * 判据是目标坐标：上次 `status !== 'idle'` 且有 targetCoord 的行，本次采样里没有相同坐标的行。
   * 面板行重排 / 坐标读不出都会漏计或误计，所以它只是参考指标，主指标是派兵记账。
   * ★ 同步回调，在实例锁内被调用：实现方不得抛异常（真抛了这里也会吞掉），不得 await 调度器方法。
   */
  onMarchGone?(
    instanceIndex: number,
    gone: Array<{ slot: number; coord: string | null }>,
    at: number
  ): void
  /**
   * 自动调度开关**真的翻转**时的通报（可选）—— 数据统计据此记「暂停 / 恢复」并累出暂停时长。
   *
   * ★ 这是暂停/恢复事件的**唯一来源**：面板「自动调度」开关（scheduler:setAuto IPC）、
   *   告警中心的异常暂停 / 恢复、机器人的 /pause /resume 最终都落到 setAuto()，在这里统一通报，
   *   上层不要再各自记一遍。同值重复调用（已经关了再关）不通报。
   * ★ 同步回调，实现方不得抛异常（真抛了这里也会吞掉），不得 await 调度器方法。
   */
  onAutoChanged?(instanceIndex: number, enabled: boolean, at: number): void
}

/**
 * 队列出现空位时的回调 —— 采集派遣流程在这里接管。
 * 调度器只负责「什么时候去看」和「看到了什么」，**不决定派哪一队去哪里**。
 */
export type QueueFreeHook = (state: InstanceQueueState) => Promise<void>

// ── 实例运行时 ────────────────────────────────────────────────────────────

/** 记录「当前异步上下文正持有哪个实例的锁」，用于重入判定。 */
const lockCtx = new AsyncLocalStorage<number>()

interface Runtime {
  state: InstanceQueueState
  travelHints: TravelHint[]
  /** 每实例串行锁：同一个模拟器同时只允许一条采样/派遣链在跑。 */
  lock: Promise<unknown>
  /** 上次健康探针时刻（内存态）。 */
  lastHealthProbeAt?: number
}

class SchedulerImpl {
  private deps: SchedulerDeps | null = null
  private config: SchedulerConfig = defaultSchedulerConfig()
  private readonly runtimes = new Map<number, Runtime>()
  private queueFreeHook: QueueFreeHook | null = null
  private started = false

  // ── 生命周期 ───────────────────────────────────────────────────────────

  async init(deps: SchedulerDeps): Promise<void> {
    if (this.started) return
    this.deps = deps
    this.started = true

    // ★ 先把 IPC 通道注册上：万一状态文件读坏了，面板至少能拉到空状态并看到错误，
    //   而不是收到一句「No handler registered」不知所云。
    this.registerHandlers()

    let file: Awaited<ReturnType<typeof loadSchedulerFile>>
    try {
      file = await loadSchedulerFile(deps.dataDir())
    } catch (e) {
      this.log(
        'error',
        `读取调度状态文件失败，本次从空状态开始（不会影响别的功能）：${AppError.from(e).message}`
      )
      return
    }
    this.config = file.config
    for (const w of file.loadWarnings ?? []) this.log('warn', w)

    for (const inst of file.instances) {
      const state = emptyInstanceState(inst.instanceIndex)
      state.auto = inst.auto
      state.accountId = inst.accountId
      state.queueUsed = inst.queueUsed
      state.queueTotal = inst.queueTotal
      // ★ 恢复的是**绝对时刻**，所以重启后倒计时依然是对的。
      state.marches = inst.marches
      state.lastSampledAt = inst.lastSampledAt
      state.lastSampleOk = inst.lastSampledAt > 0
      this.runtimes.set(inst.instanceIndex, {
        state,
        travelHints: inst.travelHints,
        lock: Promise.resolve()
      })
    }

    // 重新排期。注意：**不要**在启动时立刻扑上去采样一轮 ——
    // 面板刚起来 adb 可能还没连上，而且用户未必希望一开机就动模拟器。
    for (const rt of this.runtimes.values()) {
      if (rt.state.auto) this.rearm(rt.state.instanceIndex, '面板重启后恢复排期')
    }
    this.log(
      'info',
      `ETA 调度器已就绪，恢复了 ${this.runtimes.size} 个实例的记账，` +
        `其中 ${[...this.runtimes.values()].filter((r) => r.state.auto).length} 个开着自动调度。`
    )
  }

  /** 退出前收尾：停掉全部定时器并把状态落盘。 */
  async stop(): Promise<void> {
    cancelAllWakes()
    if (!this.started) return
    try {
      await this.persist()
    } catch (e) {
      this.log('error', `保存调度状态失败：${AppError.from(e).message}`)
    }
    resetSchedulerIpc()
    this.started = false
  }

  setQueueFreeHook(hook: QueueFreeHook | null): void {
    this.queueFreeHook = hook
  }

  // ── 对外查询 ───────────────────────────────────────────────────────────

  list(): InstanceQueueState[] {
    return [...this.runtimes.values()]
      .map((r) => cloneState(r.state))
      .sort((a, b) => a.instanceIndex - b.instanceIndex)
  }

  getState(instanceIndex: number): InstanceQueueState {
    return cloneState(this.rt(instanceIndex).state)
  }

  getConfig(): SchedulerConfig {
    return { ...this.config, retryBackoffSeconds: [...this.config.retryBackoffSeconds] }
  }

  async saveConfig(patch: Partial<SchedulerConfig>): Promise<SchedulerConfig> {
    const before = this.config.templateSetId
    this.config = mergeConfig(this.config, patch)
    if (this.config.templateSetId !== before) invalidateTemplates()
    await this.persist()
    emitScheduler('scheduler:configChanged', this.getConfig())
    // 冗余量变了，全部重排一次。
    for (const rt of this.runtimes.values()) {
      if (rt.state.auto) this.rearm(rt.state.instanceIndex, '调度配置已更新')
    }
    return this.getConfig()
  }

  listWakes(): WakeInfo[] {
    return listWakes().map((t) => ({
      instanceIndex: t.key,
      dueAt: t.dueAt,
      reason: t.reason,
      backoffStep: t.backoffStep
    }))
  }

  // ── 对外操作 ───────────────────────────────────────────────────────────

  /** 开/关某实例的自动调度。 */
  async setAuto(instanceIndex: number, enabled: boolean): Promise<InstanceQueueState> {
    const rt = this.rt(instanceIndex)
    const flipped = rt.state.auto !== enabled
    rt.state.auto = enabled
    if (flipped) this.notifyAutoChanged(instanceIndex, enabled)
    if (!enabled) {
      cancelWake(instanceIndex)
      rt.state.nextWakeAt = null
      rt.state.nextWakeReason = null
      rt.state.backoffStep = 0
      this.publish(rt.state)
      await this.persist()
      return cloneState(rt.state)
    }

    this.publish(rt.state)
    await this.persist()
    // 刚打开就先读一次，否则得等到下一个校准点才知道现在是什么情况。
    try {
      await this.sample(instanceIndex, '开启自动调度后的首次采样')
    } catch (e) {
      const err = AppError.from(e)
      this.log('warn', `实例 ${instanceIndex} 首次采样失败：${err.message}`)
      // ★ 这里必须补一次排期，否则会留下「auto=true 但一个 timer 都没有」的僵尸态：
      //   sampleLocked 的失败分支只 publish+persist 就 throw，不 rearm。
      //   而「异常暂停之后点恢复」正好是设备大概率还没好的场景，命中率极高 ——
      //   用户看着像恢复成功了，实际永远不会再唤醒。走退避重试才是对的。
      this.rearm(instanceIndex, `首次采样失败：${err.message}`, 1)
    }
    return cloneState(rt.state)
  }

  /**
   * 借用某实例的独占权跑一段外部流程（机器人截图 / 读资源统计 / 重启游戏）。
   *
   * 与采样、派遣抢的是**同一把实例锁**：fn 跑的时候调度器绝不会去点同一个模拟器；
   * 反过来，调度器正在采样/派遣时 fn 会排队等它结束。
   *
   * ★ 实例上有脚本（utilityProcess）在跑时直接拒绝 —— 跨进程没有共享的 adb 队列，
   *   busyRunIdOf 是与执行器之间唯一的互斥手段（与 sampleLocked 的第一道检查同一条规矩）。
   * ★ fn 内部若要调 noteDispatch / sampleNow 会走重入放行；但**绝不能**在 fn 里调 setAuto(true)
   *   （它会 await sample，而 sample 在同一异步上下文里直接执行，等于在锁内又开一次面板）。
   * ★ 不发 publish、不改 sampling 标志：对面板来说这段时间实例只是「被占着」。
   *
   * @param what 中文动作名，只用来拼拒绝时的提示，如「截图」「读资源统计」。
   */
  async exclusive<T>(instanceIndex: number, what: string, fn: () => Promise<T>): Promise<T> {
    const deps = this.requireDeps()
    const busy = deps.busyRunIdOf(instanceIndex)
    if (busy) {
      throw new AppError(
        'CONCURRENCY_LIMIT',
        `实例 ${instanceIndex} 上正有脚本在跑（${busy}），${what}稍后再试。`,
        { instanceIndex, runId: busy }
      )
    }
    return this.withLock(instanceIndex, fn)
  }

  /** 面板上的「立刻刷新」。 */
  async sampleNow(instanceIndex: number): Promise<InstanceQueueState> {
    await this.sample(instanceIndex, '面板手动刷新')
    return cloneState(this.rt(instanceIndex).state)
  }

  /**
   * 采集流程派兵成功后调用，把「创建部队」页行军按钮上读到的单程耗时交进来。
   * 这是 travelTime 最可信的来源（实测显示 00:01:04，不用猜也不用观察）。
   */
  async noteDispatch(
    instanceIndex: number,
    info: {
      /** 行军按钮上读到的单程耗时；没读出来传 null（按配置兜底值记、来源 fallback），别不记账。 */
      travelTimeMs: number | null
      coord?: string | null
      source?: TravelTimeSource
      /** 派的是什么资源：行军中/返回中的行缩略图是部队图，面板全靠这个显示资源类型。 */
      resourceType?: MarchResourceType | null
    }
  ): Promise<void> {
    if (
      info.travelTimeMs != null &&
      (!Number.isFinite(info.travelTimeMs) || info.travelTimeMs < 0)
    ) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `派兵记账收到非法的行军耗时：${String(info.travelTimeMs)}（毫秒）。`,
        { instanceIndex }
      )
    }
    const rt = this.rt(instanceIndex)
    const travelTimeMs = info.travelTimeMs ?? this.config.defaultTravelSeconds * 1000
    const source: TravelTimeSource =
      info.travelTimeMs == null ? 'fallback' : (info.source ?? 'dispatch')
    rt.travelHints.unshift({
      travelTimeMs,
      source,
      at: Date.now(),
      coord: info.coord ?? null,
      resourceType: info.resourceType ?? null
    })
    rt.travelHints = rt.travelHints.slice(0, 8)
    this.log(
      'info',
      `实例 ${instanceIndex} 记下一次派兵：单程 ${Math.round(travelTimeMs / 1000)}s` +
        `${info.travelTimeMs == null ? '（行军按钮没读到，按兜底值记）' : ''}` +
        `${info.coord ? `，目标 ${info.coord}` : ''}${info.resourceType ? `，资源 ${info.resourceType}` : ''}。`
    )
    // 刚派完兵状态必然变了，读一次拿到新队伍的采集倒计时。
    try {
      await this.sample(instanceIndex, '派兵后校准', true)
    } catch (e) {
      this.log('warn', `实例 ${instanceIndex} 派兵后校准失败：${AppError.from(e).message}`)
      this.rearm(instanceIndex, '派兵后校准失败，稍后重试')
    }
  }

  /** 忘掉某实例的全部记账（面板「重置」用）。 */
  async forget(instanceIndex: number): Promise<void> {
    cancelWake(instanceIndex)
    this.runtimes.delete(instanceIndex)
    await this.persist()
  }

  // ── 采样 ───────────────────────────────────────────────────────────────

  /**
   * 同一实例的操作串行化：模拟器是独占资源，两条链同时点它必然打架。
   *
   * ★ 带重入保护（与 adb/queue.ts 同一套 AsyncLocalStorage 思路）：
   *   派遣流程是在锁内被调用的，它十有八九会回头调 noteDispatch，
   *   而 noteDispatch 又要采样 —— 不做重入保护这里就是个死锁。
   */
  private withLock<T>(instanceIndex: number, fn: () => Promise<T>): Promise<T> {
    if (lockCtx.getStore() === instanceIndex) return fn()
    const rt = this.rt(instanceIndex)
    const run = (): Promise<T> => lockCtx.run(instanceIndex, fn)
    const next = rt.lock.then(run, run)
    rt.lock = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  /** @param force 跳过采样节流（到点唤醒、派兵后校准这类「必须读到最新状态」的场景用）。 */
  /** 健康探针：一帧 + 前台包名 + 进程存活，交给上层判定。任何失败只记日志。 */
  private async healthProbe(instanceIndex: number, rt: Runtime): Promise<void> {
    const deps = this.requireDeps()
    rt.lastHealthProbeAt = Date.now()
    if (!deps.onHealthProbe) return
    if (deps.busyRunIdOf(instanceIndex)) {
      this.log('debug', `实例 ${instanceIndex} 上有脚本在跑，本次健康探针跳过。`)
      return
    }
    try {
      await this.withLock(instanceIndex, async () => {
        const dev = await deps.resolveDevice(instanceIndex)
        const raw = await deps.adb.capture(dev.serial)
        const pkg = deps.gamePackage?.()
        let foreground: string | null = null
        let running: boolean | null = null
        try {
          foreground = (await deps.adb.foregroundPackage?.(dev.serial)) ?? null
        } catch {
          foreground = null
        }
        try {
          running = pkg && deps.adb.isRunning ? await deps.adb.isRunning(dev.serial, pkg) : null
        } catch {
          running = null
        }
        this.log(
          'debug',
          `实例 ${instanceIndex} 健康探针：前台=${foreground ?? '未知'} 游戏进程=${running === null ? '未知' : running ? '在' : '不在'}`
        )
        await deps.onHealthProbe!(instanceIndex, raw, { foreground, running })
      })
    } catch (e) {
      this.log('warn', `实例 ${instanceIndex} 健康探针失败：${AppError.from(e).message}`)
    }
  }

  private async sample(instanceIndex: number, reason: string, force = false): Promise<void> {
    await this.withLock(instanceIndex, () => this.sampleLocked(instanceIndex, reason, force))
  }

  private async sampleLocked(instanceIndex: number, reason: string, force: boolean): Promise<void> {
    const deps = this.requireDeps()
    const rt = this.rt(instanceIndex)

    // ① 执行器占用检查。跨进程没有共享的 adb 队列，同时驱动一定出事。
    const busy = deps.busyRunIdOf(instanceIndex)
    if (busy) {
      throw new AppError(
        'CONCURRENCY_LIMIT',
        `实例 ${instanceIndex} 上正有脚本在跑（${busy}），调度器不去动它。\n` +
          '等这次执行结束后会自动重试；想立刻读队列请先停掉那个任务。',
        { instanceIndex, runId: busy }
      )
    }

    // ② 采样节流，防止手抖连点。到点唤醒必须拿到最新状态，所以 force 时不节流。
    const since = Date.now() - rt.state.lastSampledAt
    if (!force && rt.state.lastSampledAt > 0 && since < this.config.minSampleIntervalMs) {
      this.log(
        'debug',
        `实例 ${instanceIndex} 距上次采样只有 ${since}ms，低于最小间隔 ` +
          `${this.config.minSampleIntervalMs}ms，本次跳过（${reason}）。`
      )
      return
    }

    rt.state.sampling = true
    this.publish(rt.state)

    try {
      const dev = await deps.resolveDevice(instanceIndex)
      const { refWidth, refHeight } = deps.refSize()
      const templates = await getTemplates({
        templateSetId: this.config.templateSetId,
        refWidth
      })

      const io: SampleIo = {
        serial: dev.serial,
        capture: () => deps.adb.capture(dev.serial),
        tapRef: async (x, y) => {
          const p = toDevice(dev, x, y)
          await deps.adb.tap(dev.serial, p.x, p.y)
        },
        key: (k) => deps.adb.key(dev.serial, k),
        log: (level, message) => this.log(level, `[实例 ${instanceIndex}] ${message}`),
        onUnrecognized: deps.onUnrecognizedFrame
          ? (raw) => deps.onUnrecognizedFrame!(instanceIndex, raw)
          : undefined,
        // 冷启动恢复：模拟器刚开机 / 游戏被杀时，采样器靠它把游戏拉起来再继续。
        // 三样能力（前台包名 / 拉起 / 游戏包名）缺一就不接，采样器会退回原来的兜底阶梯。
        ensureGameForeground: this.buildEnsureGameForeground(instanceIndex, dev.serial)
      }

      this.log('info', `实例 ${instanceIndex} 开始读部队管理面板（${reason}）。`)
      const sample = await sampleTroopPanel(io, templates, {
        refWidth,
        refHeight,
        maxRows: this.config.maxRows,
        readOptionalFields: this.config.readOptionalFields,
        closePanelAfterSample: this.config.closePanelAfterSample,
        deadlineAt: Date.now() + this.config.sampleTimeoutMs
      })

      if (deps.accountIdOf) {
        rt.state.accountId = await deps.accountIdOf(instanceIndex).catch(() => null)
      }
      const prev = rt.state
      rt.state = applySample(prev, sample, rt.travelHints, this.config)
      this.notifyMarchGone(instanceIndex, prev, sample)
      for (const w of sample.warnings) this.log('warn', `[实例 ${instanceIndex}] ${w}`)
      this.log(
        'info',
        `实例 ${instanceIndex} 读到队列 ${sample.queueUsed ?? '?'}/${sample.queueTotal ?? '?'}，` +
          `${sample.rows.filter((r) => r.status !== 'idle').length} 支队在外。`
      )
    } catch (e) {
      const err = AppError.from(e)
      rt.state = { ...rt.state, sampling: false, lastSampleOk: false, error: err.message }
      this.publish(rt.state)
      await this.persist()
      // 「实例上有脚本在跑」是正常让路，不是故障 —— 不能计进掉线计数。
      // （它其实在进 try 之前就抛了，这里再挡一道，免得将来有人挪动那段代码。）
      if (err.code !== 'CONCURRENCY_LIMIT') {
        this.notifySampleResult(instanceIndex, false, err.message)
      }
      throw err
    }

    this.publish(rt.state)
    await this.persist()
    this.notifySampleResult(instanceIndex, true, null)
    this.rearm(instanceIndex, '采样完成')
  }

  // ── 排期与唤醒 ─────────────────────────────────────────────────────────

  /**
   * 拼出采样器要的「冷启动恢复」能力：确认游戏在前台，不在就用 monkey 拉起来。
   * 能力不全（没接 foregroundPackage / launchApp / gamePackage）就返回 undefined，
   * 采样器会退回原来的「等一等 / 点弹窗 × / 按 BACK」阶梯。
   */
  private buildEnsureGameForeground(
    instanceIndex: number,
    serial: string
  ): (() => Promise<GamePresence>) | undefined {
    const deps = this.deps
    if (!deps) return undefined
    const { foregroundPackage, launchApp, isRunning } = deps.adb
    const pkg = deps.gamePackage?.()
    if (!foregroundPackage || !launchApp || !pkg) return undefined
    return () =>
      ensureGameForeground(
        {
          foreground: () => foregroundPackage(serial),
          launch: () => launchApp(serial, pkg),
          isRunning: isRunning ? () => isRunning(serial, pkg) : undefined,
          log: (level, message) => this.log(level, `[实例 ${instanceIndex}] ${message}`)
        },
        { packageName: pkg }
      )
  }

  /** 按当前状态重排唤醒。backoffStep 传了就走退避，不传则按 ETA 正常排。 */
  private rearm(instanceIndex: number, why: string, backoffStep?: number): void {
    const rt = this.runtimes.get(instanceIndex)
    if (!rt) return
    if (!rt.state.auto) {
      cancelWake(instanceIndex)
      rt.state.nextWakeAt = null
      rt.state.nextWakeReason = null
      this.publish(rt.state)
      return
    }

    const now = Date.now()
    let dueAt: number
    let reason: string
    let step = 0

    if (backoffStep && backoffStep > 0) {
      step = backoffStep
      const wait = backoffMs(this.config, step)
      dueAt = now + wait
      reason = `退避重试（第 ${step} 次，等 ${Math.round(wait / 1000)}s）：${why}`
    } else {
      const plan = planNextWake(rt.state, this.config, now, {
        lastHealthProbeAt: rt.lastHealthProbeAt
      })
      if (!plan) {
        cancelWake(instanceIndex)
        rt.state.nextWakeAt = null
        rt.state.nextWakeReason = null
        this.publish(rt.state)
        return
      }
      dueAt = plan.dueAt
      reason = plan.reason
    }

    rt.state.nextWakeAt = dueAt
    rt.state.nextWakeReason = reason
    rt.state.backoffStep = step
    scheduleWake({ key: instanceIndex, dueAt, reason, backoffStep: step }, (task) => {
      void this.onWake(task.key, task.reason, task.backoffStep)
    })
    this.publish(rt.state)
    this.log(
      'debug',
      `实例 ${instanceIndex} 下次唤醒：${new Date(dueAt).toLocaleTimeString('zh-CN')}（${reason}）。`
    )
  }

  /**
   * 到点了。
   *
   * ★ timer 到期只代表「该去看一眼」——机器休眠会让 timer 滞后，
   *   所以这里**必须**重新读一次面板校验，绝不能直接认为队伍已经回来了。
   */
  private async onWake(instanceIndex: number, reason: string, prevStep: number): Promise<void> {
    const rt = this.runtimes.get(instanceIndex)
    if (!rt || !rt.state.auto) return

    // ★ 健康探针分流：只截一帧不开面板，不计入采样成败、不动退避阶梯。
    if (reason === HEALTH_PROBE_REASON) {
      await this.healthProbe(instanceIndex, rt)
      // 探针完了按正常 ETA 重新排期（step=0），退避阶梯保持原样不被打断。
      // 按正常 ETA 重排（step=0）：planNextWake 会自己挑最早的候选，不会把队列打爆。
      void prevStep
      if (rt.state.auto) this.rearm(instanceIndex, '健康探针已完成')
      return
    }

    try {
      await this.sample(instanceIndex, `到点唤醒 · ${reason}`, true)
    } catch (e) {
      const err = AppError.from(e)
      this.log('warn', `实例 ${instanceIndex} 唤醒采样失败：${err.message}`)
      this.rearm(instanceIndex, err.message, prevStep + 1)
      return
    }

    const free = hasFreeSlot(rt.state)
    if (free !== true) {
      // 队列仍未空（或压根没读出 N/M）—— 指数退避，别原地打转。
      const why =
        free === null
          ? '队列占用没读出来，按未空处理'
          : `队列仍是 ${rt.state.queueUsed}/${rt.state.queueTotal}，还没空出来`
      this.log('info', `实例 ${instanceIndex} 唤醒后${why}，进入退避重试。`)
      this.rearm(instanceIndex, why, prevStep + 1)
      return
    }

    // 有空位了：交给采集派遣流程。调度器自己不决定派哪一队去哪里。
    rt.state.backoffStep = 0
    if (!this.queueFreeHook) {
      this.log(
        'info',
        `实例 ${instanceIndex} 队列有空位（${rt.state.queueUsed}/${rt.state.queueTotal}），` +
          '但还没有接入采集派遣流程，本次只做记录。'
      )
      // ★ 这里必须走退避：没人接管的话队列会一直是空的，
      //   按 ETA 正常排期会被压到最小采样间隔上，变成每几秒开一次面板。
      this.rearm(instanceIndex, '队列有空位但没有采集派遣流程接管', prevStep + 1)
      return
    }

    try {
      await this.withLock(instanceIndex, async () => {
        await this.queueFreeHook?.(cloneState(rt.state))
      })
    } catch (e) {
      const err = AppError.from(e)
      this.log('warn', `实例 ${instanceIndex} 的派遣流程报错：${err.message}`)
      this.rearm(instanceIndex, `派遣失败：${err.message}`, prevStep + 1)
      return
    }

    // ★ 派遣流程正常派出去的话，它会调 noteDispatch，那条路会重新采样并按新 ETA 排期。
    //   要是跑完队列**还是**空的（没找到合适的资源点、兵力不够…），说明这一轮没派成，
    //   必须走退避，否则 planNextWake 会把唤醒压到最小间隔上，变成每几秒开一次面板的死循环。
    if (hasFreeSlot(rt.state) === true) {
      this.rearm(instanceIndex, '派遣流程跑完了但队列仍有空位，稍后再试', prevStep + 1)
      return
    }
    this.rearm(instanceIndex, '派遣流程已执行')
  }

  // ── 杂项 ───────────────────────────────────────────────────────────────

  private rt(instanceIndex: number): Runtime {
    if (!Number.isInteger(instanceIndex) || instanceIndex < 0) {
      throw new AppError('INVALID_ARGUMENT', `实例编号非法：${String(instanceIndex)}`)
    }
    let rt = this.runtimes.get(instanceIndex)
    if (!rt) {
      rt = { state: emptyInstanceState(instanceIndex), travelHints: [], lock: Promise.resolve() }
      this.runtimes.set(instanceIndex, rt)
    }
    return rt
  }

  /** 把采样成败告诉异常检测模块。★ 它坏掉绝不能连累调度。 */
  private notifySampleResult(instanceIndex: number, ok: boolean, message: string | null): void {
    try {
      this.deps?.onSampleResult?.(instanceIndex, ok, message)
    } catch (e) {
      this.log('warn', `采样结果通报失败（不影响调度）：${AppError.from(e).message}`)
    }
  }

  /** 自动调度开关翻转 → 通报上层（数据统计）。回调抛错只记日志，绝不影响开关本身。 */
  private notifyAutoChanged(instanceIndex: number, enabled: boolean): void {
    const hook = this.deps?.onAutoChanged
    if (!hook) return
    try {
      hook(instanceIndex, enabled, Date.now())
    } catch (e) {
      this.log(
        'warn',
        `实例 ${instanceIndex} 的自动调度开关通报回调抛错（已忽略）：${AppError.from(e).message}`
      )
    }
  }

  /**
   * 把「上次在外、这次不见了」的队伍报给统计模块。★ 它坏掉绝不能连累调度（与 notifySampleResult 同一写法）。
   * 只比对目标坐标：上次 status!=='idle' 且有坐标、本次面板里没有相同坐标的行。
   */
  private notifyMarchGone(
    instanceIndex: number,
    prev: InstanceQueueState,
    sample: PanelSample
  ): void {
    const hook = this.deps?.onMarchGone
    if (!hook) return
    const stillThere = new Set(
      sample.rows
        .map((r) => r.targetCoord)
        .filter((c): c is string => typeof c === 'string' && c !== '')
    )
    const gone = prev.marches
      .filter((m) => m.status !== 'idle' && m.targetCoord && !stillThere.has(m.targetCoord))
      .map((m) => ({ slot: m.slot, coord: m.targetCoord }))
    if (gone.length === 0) return
    try {
      hook(instanceIndex, gone, sample.sampledAt)
    } catch (e) {
      this.log('warn', `队伍回城通报失败（不影响调度）：${AppError.from(e).message}`)
    }
  }

  private requireDeps(): SchedulerDeps {
    if (!this.deps) {
      throw new AppError('UNKNOWN', 'ETA 调度器还没初始化完成，请稍后再试。')
    }
    return this.deps
  }

  private publish(state: InstanceQueueState): void {
    emitScheduler('scheduler:changed', cloneState(state))
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    if (this.deps?.log) this.deps.log(level, message)
    else if (level === 'error' || level === 'warn') console.warn(`[scheduler] ${message}`)
    else console.log(`[scheduler] ${message}`)
  }

  private async persist(): Promise<void> {
    if (!this.deps) return
    try {
      await saveSchedulerFile(this.deps.dataDir(), {
        version: 1,
        config: this.config,
        instances: [...this.runtimes.values()].map((r) => toPersisted(r.state, r.travelHints))
      })
    } catch (e) {
      // 落盘失败不该打断调度，但绝不静默。
      this.log('error', `保存调度状态失败：${AppError.from(e).message}`)
    }
  }

  private registerHandlers(): void {
    handleScheduler(SCHED_CH.state, () => this.list())
    handleScheduler(SCHED_CH.sample, (i) => this.sampleNow(i))
    handleScheduler(SCHED_CH.setAuto, (i, enabled) => this.setAuto(i, enabled))
    handleScheduler(SCHED_CH.config, () => this.getConfig())
    handleScheduler(SCHED_CH.saveConfig, (patch) => this.saveConfig(patch))
    handleScheduler(SCHED_CH.wakes, () => this.listWakes())
    handleScheduler(SCHED_CH.cancelWake, (i) => {
      cancelWake(i)
      const rt = this.runtimes.get(i)
      if (rt) {
        rt.state.nextWakeAt = null
        rt.state.nextWakeReason = null
        this.publish(rt.state)
      }
    })
    handleScheduler(SCHED_CH.forget, (i) => this.forget(i))
  }
}

function toDevice(dev: DeviceInfo, x: number, y: number): { x: number; y: number } {
  if (!(dev.screenWidth > 0 && dev.screenHeight > 0)) {
    throw new AppError(
      'CAPTURE_BAD_FRAME',
      `无法确定设备 ${dev.serial} 的画面分辨率，坐标换算不能继续。请断开后重新连接该实例。`,
      { serial: dev.serial }
    )
  }
  return refToDevice(x, y, dev.screenWidth, dev.screenHeight)
}

function cloneState(s: InstanceQueueState): InstanceQueueState {
  return {
    ...s,
    marches: s.marches.map((m) => ({ ...m, commanders: m.commanders.map((c) => ({ ...c })) })),
    warnings: [...s.warnings]
  }
}

let singleton: SchedulerImpl | null = null

/** 全局唯一的调度器。主进程在 bootstrap 里 init 一次。 */
export function getScheduler(): SchedulerImpl {
  if (!singleton) singleton = new SchedulerImpl()
  return singleton
}

export type Scheduler = SchedulerImpl

/** 唤醒任务查询（面板「调度」页与排障用）。 */
export { getWake, listWakes }
export type { TravelHint } from './state'
export type { PanelSample, RowSample } from './troopPanel'
