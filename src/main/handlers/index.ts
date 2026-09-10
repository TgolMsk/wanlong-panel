/**
 * IPC handler 的集散地，同时定义**主进程内部的依赖契约（端口）**。
 *
 * 为什么要有这一层端口：
 *   handler 只依赖这里声明的窄接口，真正的绑定集中在 src/main/index.ts 的「接线区」。
 *   模块 a/b/c/d 改导出名或改实现，只需要动接线区一个文件，七个 handler 一律不受影响。
 *
 * handler 的职责边界（务必遵守）：
 *   只做「参数换算 + 转发 + 组装返回值」。任何算法、循环、重试策略都属于对应模块，不写在这里。
 */

import type {
  Account,
  AdbLinkState,
  AppInfo,
  AppSettings,
  CreateInstanceOptions,
  DeviceInfo,
  MumuInstance,
  ResolvedPaths
} from '@shared/domain'
import type {
  AndroidKey,
  LogEntry,
  LogQuery,
  RunHandle,
  RunSnapshot,
  ScriptDef,
  ScriptMeta,
  StartRunRequest,
  ValidationIssue
} from '@shared/script'
import type {
  AlphaPreviewRequest,
  AlphaPreviewResult,
  MatchOptions,
  MatchResult,
  RawFrame,
  TemplateDef,
  TemplateSaveInput,
  TemplateSet
} from '@shared/vision'

import { registerInstanceHandlers } from './instance'
import { registerDeviceHandlers } from './device'
import { registerTemplateHandlers } from './template'
import { registerScriptHandlers } from './script'
import { registerRunHandlers } from './run'
import { registerAccountHandlers } from './account'
import { registerAppHandlers } from './app'

/** 端口方法允许同步或异步实现，handler 一律 await。 */
export type MaybePromise<T> = T | Promise<T>

// ── 模块 a：MuMu 实例注册表 ───────────────────────────────────────────────

export interface MumuPort {
  /** 内存里的当前快照（轮询维护），不触发外部进程。 */
  list(): MumuInstance[]
  /** 强制立刻执行一次 `mumutool info all`。 */
  refresh(): Promise<MumuInstance[]>
  get(index: number): MumuInstance | undefined
  open(index: number): Promise<void>
  close(index: number): Promise<void>
  restart(index: number): Promise<void>
  /** 返回新建实例的 index 列表。 */
  create(opts: CreateInstanceOptions): Promise<number[]>
  clone(index: number): Promise<number[]>
  remove(index: number): Promise<void>
  /** 透传给 `mumutool config <i> -s '<json>'`（只有写入端可用，读取端在 Mac 版是坏的）。 */
  config(index: number, settings: Record<string, unknown>): Promise<void>
  /**
   * 回填由上层掌握的字段。mumu 层自己永远不写这三个，
   * 连接态来自模块 b、账号绑定与 runId 来自模块 d。
   */
  patch(
    index: number,
    overlay: { adb?: AdbLinkState; accountId?: string | null; runId?: string | null }
  ): void
}

// ── 模块 b：adb 通道 ──────────────────────────────────────────────────────

/**
 * 实例 index ⇄ serial 的映射由模块 b 自己的注册表维护，
 * 所以这里既有按 index 的连接管理，也有按 serial 的具体操作。
 * serial 一律是规范形式 `127.0.0.1:<adb_port>`（铁律三）。
 */
export interface AdbPort {
  /** 连接并采集设备信息（分辨率取自 screencap 头部）。adbPort 必须来自 mumutool，不能推算。 */
  attach(index: number, adbPort: number): Promise<DeviceInfo>
  detach(index: number): Promise<void>
  /** 已连接则返回缓存的设备信息，否则 null。 */
  cached(index: number): DeviceInfo | null
  /** 重新采集一次（分辨率会随实例配置变化）。 */
  refreshInfo(serial: string): Promise<DeviceInfo>
  capture(serial: string): Promise<RawFrame>
  /** 坐标是**设备真实像素**，参考坐标的换算由 handler 完成。 */
  tap(serial: string, x: number, y: number): Promise<void>
  swipe(
    serial: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number
  ): Promise<void>
  text(serial: string, text: string): Promise<void>
  key(serial: string, key: AndroidKey): Promise<void>
  apps(serial: string): Promise<AppInfo[]>
  foreground(serial: string): Promise<string | null>
  launchApp(serial: string, packageName: string, cold: boolean): Promise<void>
  stopApp(serial: string, packageName: string): Promise<void>
  installApk(serial: string, apkPath: string): Promise<void>
  /** 安装 ADBKeyboard 并切成默认输入法，中文输入的前提。 */
  setupIme(serial: string, apkPath: string): Promise<boolean>
}

// ── 模块 c：模板库 + 一次性匹配 ───────────────────────────────────────────

export interface VisionPort {
  listSets(): Promise<TemplateSet[]>
  createSet(name: string, packageName?: string): Promise<TemplateSet>
  listTemplates(setId: string): Promise<TemplateDef[]>
  saveTemplate(setId: string, input: TemplateSaveInput): Promise<TemplateDef>
  deleteTemplate(setId: string, templateId: string): Promise<void>
  /** 读模板 png 原图（给编辑器显示）。 */
  templateImage(setId: string, templateId: string): Promise<ArrayBuffer>
  /**
   * 在给定的一帧上做**一次性**匹配，仅供模板编辑器的「立即验证」。
   * 脚本运行期的连续匹配全部在 utilityProcess 内完成，绝不走这里。
   */
  matchOnce(
    setId: string,
    templateId: string,
    frame: RawFrame,
    opts?: MatchOptions
  ): Promise<MatchResult>
  /** 面板「再抓一帧去底」的预览：多帧差分 → 洋红底预览 + 不透明占比。纯计算。 */
  alphaPreview(req: AlphaPreviewRequest): Promise<AlphaPreviewResult>
}

// ── 模块 d：磁盘存储 ──────────────────────────────────────────────────────

export interface ScriptStorePort {
  list(): Promise<ScriptMeta[]>
  get(scriptId: string): Promise<ScriptDef>
  save(def: ScriptDef): Promise<ScriptMeta>
  remove(scriptId: string): Promise<void>
  validate(def: ScriptDef): Promise<ValidationIssue[]>
}

export interface AccountStorePort {
  list(): Promise<Account[]>
  save(account: Account): Promise<Account>
  remove(accountId: string): Promise<void>
  /** instanceIndex 传 null 表示解绑。返回变更后的完整账号列表。 */
  bind(accountId: string, instanceIndex: number | null): Promise<Account[]>
}

export interface LogStorePort {
  /** 从 ndjson 读历史日志。 */
  query(query: LogQuery): Promise<LogEntry[]>
  /** 读一张留痕截图（相对 shots/<runId>/ 的文件名）。 */
  readShot(runId: string, shot: string): Promise<ArrayBuffer>
}

// ── 模块 d：执行编排 ──────────────────────────────────────────────────────

/**
 * 编排器自己负责：并发上限、实例占用检查、参数合并、WorkerAttachPayload 组装、
 * fork/attach/kill 执行器进程。所以这里的签名就是原始请求，主进程 handler 不做二次判断
 * —— 同一条规则写两遍迟早会不一致。
 */
export interface OrchestratorPort {
  start(req: StartRunRequest): Promise<RunHandle>
  stop(runId: string): Promise<void>
  pause(runId: string): void
  resume(runId: string): void
  list(): RunSnapshot[]
}

// ── handler 的全部依赖 ────────────────────────────────────────────────────

export interface MainDeps {
  mumu: MumuPort
  adb: AdbPort
  vision: VisionPort
  scripts: ScriptStorePort
  accounts: AccountStorePort
  logs: LogStorePort
  orchestrator: OrchestratorPort
  /** 当前设置（同步取，永远是最新的那一份）。 */
  settings(): AppSettings
  /** 由当前设置推导出的绝对路径。 */
  paths(): ResolvedPaths
  /** 保存设置（内部会推 app:settingsChanged）。 */
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
}

/**
 * 注册全部 IPC 通道。必须在窗口创建之前调用一次，且只能调用一次
 * （重复注册会被 handle() 直接抛错，防止热重载时静默串线）。
 */
export function registerAllHandlers(deps: MainDeps): void {
  registerInstanceHandlers(deps)
  registerDeviceHandlers(deps)
  registerTemplateHandlers(deps)
  registerScriptHandlers(deps)
  registerRunHandlers(deps)
  registerAccountHandlers(deps)
  registerAppHandlers(deps)
}
