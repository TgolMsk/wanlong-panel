/**
 * 应用内更新（基于 GitHub Release）的公共契约（主进程 ⇄ 渲染进程）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【它怎么工作】
 *
 * 发版流程已经现成（README「发布安装包」）：推 `v*` 标签 → Actions 打包 →
 * softprops/action-gh-release 建 Release，附 nsis 安装包 + `.blockmap` + `latest.yml`。
 * 后两个正是 electron-updater 要的元数据：
 *   · latest.yml   版本号 + 文件名 + sha512（校验下载完整性）
 *   · .blockmap    分块指纹，**增量下载**只取变化的块（135MB 的包通常只下几 MB）
 *
 * 仓库 TgolMsk/wanlong-panel 是公开的，所以检查更新不需要任何 token。
 *
 * 【四条铁律】
 *
 *  1. ★ **绝不自作主张装。** autoDownload / autoInstallOnAppQuit 全部关掉：
 *     检查是自动的，下载和安装**必须**用户点。这是个挂机工具，半夜自己重启等于把活儿干断。
 *  2. ★ **有任务在跑就不许装。** 安装 = 退出应用 + 跑安装程序。脚本执行、自动采集、
 *     登录向导中途被掐，轻则白跑一轮，重则游戏卡在半个界面。由主进程拦，不靠 UI 自觉。
 *  3. ★ **免安装版（portable）不能自动装。** electron-updater 只会装 nsis；
 *     portable 检测到就退化成「打开下载页自己换」，而不是报一句看不懂的错。
 *  4. ★ **开发模式不检查。** 没打包时 electron-updater 会抛 dev-app-update.yml 相关的错，
 *     直接短路成「开发模式不检查更新」。
 * ══════════════════════════════════════════════════════════════════════════
 */

/** 更新流程的状态机。面板按它决定显示什么按钮。 */
export type UpdatePhase =
  /** 什么都没做过。 */
  | 'idle'
  /** 正在问 GitHub。 */
  | 'checking'
  /** 已经是最新版。 */
  | 'latest'
  /** 有新版本，等用户决定要不要下。 */
  | 'available'
  /** 正在下载。 */
  | 'downloading'
  /** 下载完了，等用户点「重启并安装」。 */
  | 'downloaded'
  /** 出错了（网络、限流、校验失败…）。 */
  | 'error'
  /** 这个运行环境不支持自动更新（开发模式 / 免安装版）。 */
  | 'unsupported'

export const UPDATE_PHASE_TEXT: Record<UpdatePhase, string> = {
  idle: '未检查',
  checking: '正在检查…',
  latest: '已是最新版',
  available: '有新版本',
  downloading: '正在下载…',
  downloaded: '下载完成，待安装',
  error: '检查失败',
  unsupported: '当前环境不支持自动更新'
}

/** 不支持自动更新的原因。面板据此给出**能照着做**的下一步。 */
export type UnsupportedReason =
  /** 开发模式（没打包）。 */
  | 'dev'
  /** 免安装版：electron-updater 只能装 nsis。 */
  | 'portable'

export interface UpdateProgress {
  /** 0~100。 */
  percent: number
  /** 已下载字节。 */
  transferred: number
  /** 总字节。 */
  total: number
  /** 字节/秒。 */
  bytesPerSecond: number
}

export interface UpdateState {
  phase: UpdatePhase
  /** 当前运行的版本。 */
  currentVersion: string
  /** 检查到的最新版本；没检查到为 null。 */
  latestVersion: string | null
  /** Release 里的更新说明（GitHub 自动生成的那段），可能为 null。 */
  releaseNotes: string | null
  /** Release 页面地址，「手动下载」按钮用。 */
  releaseUrl: string | null
  /** 上次检查完成的时刻；没检查过为 null。 */
  checkedAt: number | null
  progress: UpdateProgress | null
  /** 出错时的中文说明。 */
  error: string | null
  unsupportedReason: UnsupportedReason | null
  /**
   * 现在能不能装。有脚本在跑 / 有实例开着自动采集 / 登录向导进行中时为 false，
   * busyReason 说明是被什么挡住了。
   */
  installable: boolean
  busyReason: string | null
}

export function initialUpdateState(currentVersion: string): UpdateState {
  return {
    phase: 'idle',
    currentVersion,
    latestVersion: null,
    releaseNotes: null,
    releaseUrl: null,
    checkedAt: null,
    progress: null,
    error: null,
    unsupportedReason: null,
    installable: true,
    busyReason: null
  }
}

// ── 版本比较（纯函数）────────────────────────────────────────────────────

/**
 * 语义化版本比较：a > b 返回正数，相等 0，a < b 负数。
 *
 * 只认 `X.Y.Z` 与可选的预发布后缀（`1.2.3-beta.1`）。带后缀的**小于**同号正式版，
 * 这与 semver 一致 —— 否则装了 1.2.3 的人会被 1.2.3-beta.1 反向「更新」回去。
 * 认不出的版本号一律当 0.0.0，绝不猜。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i]
  }
  // 主版本号相同：没有预发布后缀的更大。
  if (!pa.pre && pb.pre) return 1
  if (pa.pre && !pb.pre) return -1
  if (pa.pre === pb.pre) return 0
  return pa.pre < pb.pre ? -1 : 1
}

function parseVersion(v: string): { nums: [number, number, number]; pre: string } {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim())
  if (!m) return { nums: [0, 0, 0], pre: '' }
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' }
}

/** latest 是不是比 current 新。 */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0
}

/** 下载速度 → 人话。 */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  if (bytesPerSecond >= 1e6) return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`
  return `${Math.max(1, Math.round(bytesPerSecond / 1000))} KB/s`
}

/** 字节 → 人话。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 MB'
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`
}

// ── IPC ───────────────────────────────────────────────────────────────────

export const UPDATE_CH = {
  /** 拉当前状态（打开设置页时用）。 */
  state: 'update:state',
  /** 手动检查一次。 */
  check: 'update:check',
  /** 开始下载（用户点了才调）。 */
  download: 'update:download',
  /** 退出并安装。有任务在跑时主进程会拒绝。 */
  install: 'update:install',
  /** 打开 Release 页面（免安装版 / 想手动换的人用）。 */
  openReleasePage: 'update:openReleasePage'
} as const

export type UpdateRoutes = {
  'update:state': [[], UpdateState]
  'update:check': [[], UpdateState]
  'update:download': [[], UpdateState]
  'update:install': [[], void]
  'update:openReleasePage': [[], void]
}

export type UpdateChannel = keyof UpdateRoutes
export type UpdateArgs<K extends UpdateChannel> = UpdateRoutes[K][0]
export type UpdateResult<K extends UpdateChannel> = UpdateRoutes[K][1]

export type UpdateEvents = {
  /** 状态变了（检查完成、下载进度、出错）。 */
  'update:changed': UpdateState
}

export type UpdateEventChannel = keyof UpdateEvents

// ── 渲染进程客户端（类型断言全部关在这里）────────────────────────────────

interface RawBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, cb: (payload: unknown) => void): () => void
}

function bridge(): RawBridge {
  const api = (globalThis as { api?: unknown }).api
  if (!api || typeof (api as RawBridge).invoke !== 'function') {
    throw new Error('window.api 尚未就绪：更新接口只能在渲染进程里调用。')
  }
  return api as RawBridge
}

export function callUpdate<K extends UpdateChannel>(
  channel: K,
  ...args: UpdateArgs<K>
): Promise<UpdateResult<K>> {
  return bridge().invoke(channel, ...args) as Promise<UpdateResult<K>>
}

export function onUpdateEvent<K extends UpdateEventChannel>(
  channel: K,
  cb: (payload: UpdateEvents[K]) => void
): () => void {
  return bridge().on(channel, (p) => cb(p as UpdateEvents[K]))
}
