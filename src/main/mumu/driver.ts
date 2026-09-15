/**
 * 模块 a 的驱动契约：实例的「生老病死」由具体模拟器的 CLI 实现，上层只认这个接口。
 *
 * 两个实现：
 *   · ldplayer/index.ts —— 雷电模拟器（Windows），CLI 是 <安装目录>\ldconsole.exe
 *   · instances.ts      —— MuMu Pro（macOS），CLI 是 mumutool（工程最初的实现，原样保留）
 *
 * 由 index.ts 按 AppSettings.emulator 选择当前驱动；注册表（轮询 + 内容 diff）与 IPC handler
 * 都只依赖这里的方法，不知道底下是哪家模拟器。
 *
 * 三条共同约定：
 *   1. list() 产出的 MumuInstance 里 adb / accountId / runId 一律填初始值，真实值由上层回填。
 *   2. 对不存在的 index 抛 AppError('MUMU_INSTANCE_MISSING')，带中文说明。
 *   3. open() 返回只代表「命令已下发」，画面就绪要靠 waitReady() 或轮询。
 */

import type { CreateInstanceOptions, EmulatorKind, MumuInstance } from '@shared/domain'

export interface EmulatorDriver {
  readonly kind: EmulatorKind
  /** 给日志与自检文案用的中文名，例如「雷电模拟器」。 */
  readonly label: string
  /** CLI 可执行文件路径。设置变更时由主进程调用；空串会抛 INVALID_ARGUMENT。 */
  setCliPath(path: string): void
  getCliPath(): string
  /** 列出全部实例（驼峰视图，按 index 升序）。 */
  list(): Promise<MumuInstance[]>
  open(index: number): Promise<void>
  close(index: number): Promise<void>
  restart(index: number): Promise<void>
  /** 返回新建实例的 index 列表。 */
  create(opts: CreateInstanceOptions): Promise<number[]>
  /** 克隆一个已有实例，返回新实例的 index 列表。 */
  clone(index: number): Promise<number[]>
  /** 删除实例。不可撤销，调用方必须先二次确认。 */
  remove(index: number): Promise<void>
  /** 写入实例配置（分辨率 / CPU / 内存 …）。多数配置项要重启实例才生效。 */
  config(index: number, settings: Record<string, unknown>): Promise<void>
  /** 等实例真正可用（Android 已启动、画面已出）。超时抛 TIMEOUT。 */
  waitReady(index: number, timeoutMs: number): Promise<MumuInstance>
}
