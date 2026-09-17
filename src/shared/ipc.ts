/**
 * IPC 契约 —— 主进程与渲染进程之间的**唯一事实来源**。
 *
 * 用法：
 *   主进程   import { handle } from '@main/ipc'  ->  handle('instance:list', async () => ...)
 *   渲染进程 window.api.invoke('instance:list')
 * 改任何一个通道的签名，两端都会立刻编译报错，这正是这份文件存在的意义。
 *
 * 规则：
 *  1. 所有参数与返回值必须能被 structuredClone（不能传 class 实例、函数、Buffer 请用 ArrayBuffer）。
 *  2. 抛错请抛 AppError；主进程的 handle 包装会把它 serialize 成 SerializedError 再过桥。
 *  3. 高频数据（日志流、预览帧）**不走这里**，走 MessagePort（见 worker.ts）。
 *     这里只放请求-响应式的低频操作和低频推送。
 */

import type {
  BaseInstanceSelection,
  Account,
  AppInfo,
  AppSettings,
  CreateInstanceOptions,
  DeviceInfo,
  HealthReport,
  MumuInstance,
  ResolvedPaths
} from './domain'
import type { LoginCommand, LoginInput, LoginRequest, LoginSession } from './login'
import type {
  LogEntry,
  LogQuery,
  RunHandle,
  RunSnapshot,
  ScriptDef,
  ScriptMeta,
  StartRunRequest,
  ValidationIssue
} from './script'
import type {
  AlphaPreviewRequest,
  AlphaPreviewResult,
  MatchResult,
  Point,
  Rect,
  TemplateDef,
  TemplateSaveInput,
  TemplateSet
} from './vision'
import type { AndroidKey } from './script'

// ── 辅助载荷类型 ──────────────────────────────────────────────────────────

/** 一次性截图，用于模板截取工具和画面预览。 */
export interface CaptureShot {
  /** 设备真实分辨率（来自 screencap 头部，不是 wm size）。 */
  width: number
  height: number
  /** JPEG 字节。渲染进程用 createImageBitmap(new Blob([jpeg])) 上屏。 */
  jpeg: ArrayBuffer
  /** jpeg 的实际宽高（可能被降采样过）。 */
  jpegWidth: number
  jpegHeight: number
  capturedAt: number
  elapsedMs: number
}

export interface CaptureOptions {
  /** 输出宽度，默认 PREVIEW_WIDTH。传 0 表示保持原始分辨率（大，慎用）。 */
  width?: number
  quality?: number
}

/** 模板专用无损截图；坐标仍以输出 PNG 尺寸为准。 */
export interface PngCaptureShot {
  width: number
  height: number
  png: ArrayBuffer
  imageWidth: number
  imageHeight: number
  capturedAt: number
  elapsedMs: number
}

/** 在真实设备画面上试跑一个模板，模板编辑器用它做「立即验证」。 */
export interface TemplateTestRequest {
  setId: string
  templateId: string
  instanceIndex: number
  roi?: Rect
  threshold?: number
}

export interface TemplateTestResult {
  match: MatchResult
  /** 带标注框的预览图，方便肉眼确认落点。 */
  preview: CaptureShot
}

/** 直接在设备上做一次动作（面板手动操控用，不经脚本引擎）。 */
export interface ManualInput {
  instanceIndex: number
  /** 参考分辨率坐标，主进程负责换算到设备像素。 */
  at?: Point
  to?: Point
  durationMs?: number
  text?: string
  key?: AndroidKey
}

// ── 通道名常量 ────────────────────────────────────────────────────────────
// 用常量而不是散落的字符串，避免拼写错误；类型仍以 IpcRoutes 为准。

export const CH = {
  // 实例
  instanceList: 'instance:list',
  instanceRefresh: 'instance:refresh',
  instanceOpen: 'instance:open',
  instanceClose: 'instance:close',
  instanceRestart: 'instance:restart',
  instanceCreate: 'instance:create',
  instanceClone: 'instance:clone',
  instanceDelete: 'instance:delete',
  instanceConfig: 'instance:config',
  instanceBase: 'instance:base',
  instanceSetBase: 'instance:setBase',
  // 设备
  deviceAttach: 'device:attach',
  deviceDetach: 'device:detach',
  deviceInfo: 'device:info',
  deviceCapture: 'device:capture',
  deviceCapturePng: 'device:capturePng',
  deviceTap: 'device:tap',
  deviceSwipe: 'device:swipe',
  deviceText: 'device:text',
  deviceKey: 'device:key',
  deviceApps: 'device:apps',
  deviceForeground: 'device:foreground',
  deviceLaunchApp: 'device:launchApp',
  deviceStopApp: 'device:stopApp',
  deviceInstallApk: 'device:installApk',
  deviceSetupIme: 'device:setupIme',
  // 模板
  templateSets: 'template:sets',
  templateCreateSet: 'template:createSet',
  templateList: 'template:list',
  templateSave: 'template:save',
  templateDelete: 'template:delete',
  templateImage: 'template:image',
  templateTest: 'template:test',
  templateAlphaPreview: 'template:alphaPreview',
  // 脚本
  scriptList: 'script:list',
  scriptGet: 'script:get',
  scriptSave: 'script:save',
  scriptDelete: 'script:delete',
  scriptValidate: 'script:validate',
  // 执行
  runStart: 'run:start',
  runStop: 'run:stop',
  runPause: 'run:pause',
  runResume: 'run:resume',
  runList: 'run:list',
  runLogs: 'run:logs',
  runShot: 'run:shot',
  // 账号
  accountList: 'account:list',
  accountSave: 'account:save',
  accountDelete: 'account:delete',
  accountBind: 'account:bind',
  loginBegin: 'login:begin',
  loginCommand: 'login:command',
  loginSession: 'login:session',
  loginInput: 'login:input',
  loginVerify: 'login:verify',
  loginCancel: 'login:cancel',
  // 应用/系统
  appSettings: 'app:settings',
  appSaveSettings: 'app:saveSettings',
  appPaths: 'app:paths',
  appOpenPath: 'app:openPath',
  appHealth: 'app:health',
  appPickFile: 'app:pickFile'
} as const

// ── 路由表：通道名 -> [参数元组, 返回值] ──────────────────────────────────

export type IpcRoutes = {
  'login:begin': [[request: LoginRequest], LoginSession]
  'login:command': [[sessionId: string, command: LoginCommand], LoginSession]
  'login:session': [[instanceIndex: number], LoginSession | null]
  'login:input': [[sessionId: string, input: LoginInput], boolean]
  'login:verify': [[sessionId: string, identityConfirmed: boolean], LoginSession]
  'login:cancel': [[sessionId: string], void]
  // ── 实例生命周期（走 mumutool）──────────────────────────────────────────
  'instance:list': [[], MumuInstance[]]
  /** 强制立刻拉一次 mumutool info all，而不是等轮询。 */
  'instance:refresh': [[], MumuInstance[]]
  'instance:open': [[index: number], void]
  'instance:close': [[index: number], void]
  'instance:restart': [[index: number], void]
  /** 返回新建实例的 index 列表。 */
  'instance:create': [[opts: CreateInstanceOptions], number[]]
  'instance:clone': [[index: number], number[]]
  'instance:delete': [[index: number], void]
  /** 透传给 `mumutool config <i> -s '<json>'`。只有写入端可用，读取端在 Mac 版是坏的。 */
  'instance:config': [[index: number, settings: Record<string, unknown>], void]
  'instance:base': [[], BaseInstanceSelection | null]
  'instance:setBase': [[index: number | null], BaseInstanceSelection | null]

  // ── 设备（走 adb）──────────────────────────────────────────────────────
  /** 连接实例的 adb 端口并做四重就绪判定，成功返回设备信息。 */
  'device:attach': [[index: number], DeviceInfo]
  'device:detach': [[index: number], void]
  'device:info': [[index: number], DeviceInfo]
  'device:capture': [[index: number, opts?: CaptureOptions], CaptureShot]
  'device:capturePng': [[index: number, width?: number], PngCaptureShot]
  'device:tap': [[input: ManualInput], void]
  'device:swipe': [[input: ManualInput], void]
  'device:text': [[input: ManualInput], void]
  'device:key': [[input: ManualInput], void]
  'device:apps': [[index: number], AppInfo[]]
  'device:foreground': [[index: number], string | null]
  'device:launchApp': [[index: number, packageName: string, cold?: boolean], void]
  'device:stopApp': [[index: number, packageName: string], void]
  'device:installApk': [[index: number, apkPath: string], void]
  /** 安装并切换到 ADBKeyboard，让中文输入可用。返回是否成功。 */
  'device:setupIme': [[index: number], boolean]

  // ── 模板库 ─────────────────────────────────────────────────────────────
  'template:sets': [[], TemplateSet[]]
  'template:createSet': [[name: string, packageName?: string], TemplateSet]
  'template:list': [[setId: string], TemplateDef[]]
  'template:save': [[setId: string, input: TemplateSaveInput], TemplateDef]
  'template:delete': [[setId: string, templateId: string], void]
  /** 读模板 png 原图给编辑器显示。 */
  'template:image': [[setId: string, templateId: string], ArrayBuffer]
  'template:test': [[req: TemplateTestRequest], TemplateTestResult]
  /** 面板「再抓一帧去底」：按裁剪区做多帧差分，回洋红底预览与不透明占比。 */
  'template:alphaPreview': [[req: AlphaPreviewRequest], AlphaPreviewResult]

  // ── 脚本 ───────────────────────────────────────────────────────────────
  'script:list': [[], ScriptMeta[]]
  'script:get': [[scriptId: string], ScriptDef]
  'script:save': [[def: ScriptDef], ScriptMeta]
  'script:delete': [[scriptId: string], void]
  'script:validate': [[def: ScriptDef], ValidationIssue[]]

  // ── 执行 ───────────────────────────────────────────────────────────────
  'run:start': [[req: StartRunRequest], RunHandle]
  'run:stop': [[runId: string], void]
  'run:pause': [[runId: string], void]
  'run:resume': [[runId: string], void]
  'run:list': [[], RunSnapshot[]]
  /** 从 ndjson 读历史日志（实时日志走 MessagePort，不走这里）。 */
  'run:logs': [[query: LogQuery], LogEntry[]]
  /** 读一张留痕截图。 */
  'run:shot': [[runId: string, shot: string], ArrayBuffer]

  // ── 账号 ───────────────────────────────────────────────────────────────
  'account:list': [[], Account[]]
  'account:save': [[account: Account], Account]
  'account:delete': [[accountId: string], void]
  /** instanceIndex 传 null 表示解绑。 */
  'account:bind': [[accountId: string, instanceIndex: number | null], Account[]]

  // ── 应用 / 系统 ────────────────────────────────────────────────────────
  'app:settings': [[], AppSettings]
  'app:saveSettings': [[patch: Partial<AppSettings>], AppSettings]
  'app:paths': [[], ResolvedPaths]
  /** 在访达里打开某个约定目录。 */
  'app:openPath': [[key: keyof ResolvedPaths], void]
  'app:health': [[], HealthReport]
  /** 弹系统文件选择框，返回绝对路径；取消返回 null。 */
  'app:pickFile': [[filters?: { name: string; extensions: string[] }[]], string | null]
}

export type IpcChannel = keyof IpcRoutes
export type IpcArgs<K extends IpcChannel> = IpcRoutes[K][0]
export type IpcResult<K extends IpcChannel> = IpcRoutes[K][1]

// ── 主进程 -> 渲染进程的低频推送 ──────────────────────────────────────────

export type IpcEvents = {
  'login:changed': LoginSession
  'account:changed': Account[]
  'instance:baseChanged': BaseInstanceSelection | null
  /** 实例列表发生变化（轮询发现 / 用户操作后）。 */
  'instance:changed': MumuInstance[]
  /** 某次执行的状态变了。 */
  'run:changed': RunSnapshot
  /** 面板级日志（不属于任何 run 的那些）。run 内日志走 MessagePort。 */
  'log:line': LogEntry
  /** 全局提示。 */
  'app:toast': { level: 'info' | 'success' | 'warning' | 'error'; message: string }
  /** 设置被主进程改写（例如自检修正了 adb 路径）。 */
  'app:settingsChanged': AppSettings
  /** 环境自检结果更新。 */
  'app:health': HealthReport
}

export type IpcEventChannel = keyof IpcEvents

// ── preload 暴露的 API 形状 ───────────────────────────────────────────────

export interface IpcApi {
  /** 请求-响应。失败时 reject 的是 SerializedError。 */
  invoke<K extends IpcChannel>(channel: K, ...args: IpcArgs<K>): Promise<IpcResult<K>>
  /** 订阅推送，返回退订函数（useEffect 可以直接 return 它）。 */
  on<K extends IpcEventChannel>(channel: K, cb: (payload: IpcEvents[K]) => void): () => void
  /** 运行环境信息，渲染进程偶尔要判断 dev/prod。 */
  readonly env: { isDev: boolean; platform: string; versions: Record<string, string> }
}

declare global {
  interface Window {
    api: IpcApi
  }
}
