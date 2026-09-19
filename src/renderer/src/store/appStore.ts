/**
 * 面板全局状态（zustand）。
 *
 * 这里只放**低频、体量小**的东西：实例列表、执行快照、账号、脚本元信息、模板集、设置、自检结果。
 * 明确不放这里的：
 *   · 实时日志  -> logStore 的 ring buffer
 *   · 预览帧    -> PreviewPane 里的 ref + canvas，绝不进 React state
 * 所有写操作都经 window.api，渲染进程不碰 adb / mumutool / fs。
 */

import { create } from 'zustand'
import { defaultSettings } from '@shared/defaults'
import type {
  Account,
  AppSettings,
  HealthReport,
  MumuInstance,
  ResolvedPaths
} from '@shared/domain'
import type { RunSnapshot, ScriptMeta } from '@shared/script'
import type { TemplateSet } from '@shared/vision'
import { silentCall, tryCall } from '../ipc/useIpc'
import { applyThemeMode, readStoredThemeMode, type WlThemeMode } from '../styles/antd-theme'

export type ViewKey =
  | 'instances'
  | 'runs'
  /** 群控倒计时总览（features/gather）。 */
  | 'gatherOverview'
  /** 每日数据统计（features/stats，按北京日期分桶）。 */
  | 'stats'
  /** AI 顾问：左侧一级入口「AI 处理」，顶部总开关 + 折叠的接口配置（features/ai）。 */
  | 'ai'
  | 'templates'
  | 'scripts'
  /** 任务计划：账号勾选脚本 + 运行时间（src/main/plan）。 */
  | 'plans'
  | 'accounts'
  | 'settings'

/** 记住上次停在哪一页的 localStorage 键。 */
const VIEW_STORAGE_KEY = 'wl.view'

const VIEW_KEYS: readonly ViewKey[] = [
  'instances',
  'runs',
  'gatherOverview',
  'stats',
  'ai',
  'templates',
  'scripts',
  'plans',
  'accounts',
  'settings'
]

/**
 * 下线掉的旧页面 -> 现在的落点。
 * 删导航入口时必须在这里留一条：老用户 localStorage 里还记着旧 key，
 * 不映射的话会被当成未知值扔掉、莫名回到实例页（还以为面板把设置弄丢了）。
 */
const RETIRED_VIEWS: Record<string, ViewKey> = {
  // 采集配置不再是独立页面，改成总览页/实例列表里就地展开的抽屉。
  gatherConfig: 'gatherOverview'
}

/**
 * 读上次停留的页面。
 * localStorage 在隐私窗口 / 被禁站点数据时读写都会抛，所以整段包 try/catch，
 * 读不到就回到实例管理页 —— 记住页面只是便利功能，绝不能因此白屏。
 */
function readStoredView(): ViewKey {
  try {
    const raw = window.localStorage.getItem(VIEW_STORAGE_KEY)
    if (raw && (VIEW_KEYS as readonly string[]).includes(raw)) return raw as ViewKey
    const moved = raw ? RETIRED_VIEWS[raw] : undefined
    if (moved) {
      storeView(moved)
      return moved
    }
  } catch {
    // 忽略：下面回默认值
  }
  return 'instances'
}

function storeView(v: ViewKey): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, v)
  } catch {
    // 忽略：记不住也不影响使用
  }
}

/** 执行是否仍占着实例。 */
export function isRunActive(status: RunSnapshot['status']): boolean {
  return (
    status === 'pending' ||
    status === 'starting' ||
    status === 'running' ||
    status === 'paused' ||
    status === 'stopping'
  )
}

/** 实例是否处于「已开机」状态（用于并发上限计数）。 */
export function isInstanceUp(inst: MumuInstance): boolean {
  return inst.state === 'running' || inst.state === 'starting'
}

interface AppState {
  /** 首屏数据是否拉过一次（无论成功失败）。 */
  bootstrapped: boolean
  /** 首屏拉取失败的说明。主进程模块尚未接线时会命中这里，属于预期情况。 */
  bootError: string | null

  instances: MumuInstance[]
  runs: RunSnapshot[]
  accounts: Account[]
  scripts: ScriptMeta[]
  templateSets: TemplateSet[]
  settings: AppSettings
  paths: ResolvedPaths | null
  health: HealthReport | null

  view: ViewKey
  /** 当前在实例/模板/预览里选中的实例 index。 */
  selectedInstance: number | null
  /** 当前在执行监控里选中的执行 id。 */
  selectedRunId: string | null

  /** 外观：暗色（默认）/ 亮色。真正生效靠 <html data-theme>，见 styles/antd-theme.ts。 */
  themeMode: WlThemeMode
  /** 切换外观：写 store 的同时落 <html data-theme> 与 localStorage。 */
  setThemeMode: (m: WlThemeMode) => void

  setView: (v: ViewKey) => void
  selectInstance: (i: number | null) => void
  selectRun: (id: string | null) => void

  setInstances: (list: MumuInstance[]) => void
  setRuns: (list: RunSnapshot[]) => void
  upsertRun: (snap: RunSnapshot) => void
  setAccounts: (list: Account[]) => void
  setScripts: (list: ScriptMeta[]) => void
  setTemplateSets: (list: TemplateSet[]) => void
  setSettings: (s: AppSettings) => void
  setHealth: (h: HealthReport) => void

  refreshInstances: (force?: boolean) => Promise<void>
  refreshRuns: () => Promise<void>
  refreshAccounts: () => Promise<void>
  refreshScripts: () => Promise<void>
  refreshTemplateSets: () => Promise<void>
  refreshSettings: () => Promise<void>
  refreshPaths: () => Promise<void>
  refreshHealth: () => Promise<void>
  /** 首屏并发拉取。失败不弹 toast，只记 bootError，避免主进程未就绪时糊一屏红条。 */
  bootstrap: () => Promise<void>
}

export const useAppStore = create<AppState>()((set, get) => ({
  bootstrapped: false,
  bootError: null,

  instances: [],
  runs: [],
  accounts: [],
  scripts: [],
  templateSets: [],
  settings: defaultSettings(),
  paths: null,
  health: null,

  view: readStoredView(),
  selectedInstance: null,
  selectedRunId: null,

  // 初值取上次选的（读不到就回落默认暗色）。main.tsx 在挂载前已经调过一次
  // applyThemeMode，所以这里只需要把同一个值同步进 store，不重复写 DOM。
  themeMode: readStoredThemeMode(),
  setThemeMode: (m) => {
    applyThemeMode(m)
    set({ themeMode: m })
  },

  setView: (v) => {
    storeView(v)
    set({ view: v })
  },
  selectInstance: (i) => set({ selectedInstance: i }),
  selectRun: (id) => set({ selectedRunId: id }),

  setInstances: (list) => {
    const sorted = list.slice().sort((a, b) => a.index - b.index)
    const cur = get().selectedInstance
    // 选中的实例被删掉了就自动改选第一个，避免各视图拿着幽灵 index 反复报错。
    const stillThere = cur !== null && sorted.some((i) => i.index === cur)
    set({
      instances: sorted,
      selectedInstance: stillThere ? cur : (sorted[0]?.index ?? null)
    })
  },

  setRuns: (list) => {
    const cur = get().selectedRunId
    const stillThere = cur !== null && list.some((r) => r.runId === cur)
    // 没选中过（或选中的那次已经不在列表里）时，自动挑一条：优先进行中的，否则最近一条。
    const fallback = list.find((r) => isRunActive(r.status))?.runId ?? list[0]?.runId ?? null
    set({ runs: list, selectedRunId: stillThere ? cur : fallback })
  },

  upsertRun: (snap) => {
    const runs = get().runs.slice()
    const at = runs.findIndex((r) => r.runId === snap.runId)
    if (at >= 0) runs[at] = snap
    else runs.unshift(snap)
    const patch: Partial<AppState> = { runs }
    if (get().selectedRunId === null && isRunActive(snap.status)) patch.selectedRunId = snap.runId
    set(patch)
  },

  setAccounts: (list) => set({ accounts: list }),
  setScripts: (list) => set({ scripts: list }),
  setTemplateSets: (list) => set({ templateSets: list }),
  setSettings: (s) => set({ settings: s }),
  setHealth: (h) => set({ health: h }),

  refreshInstances: async (force = false) => {
    const list = await tryCall(force ? 'instance:refresh' : 'instance:list')
    if (list) get().setInstances(list)
  },
  refreshRuns: async () => {
    const list = await tryCall('run:list')
    if (list) get().setRuns(list)
  },
  refreshAccounts: async () => {
    const list = await tryCall('account:list')
    if (list) set({ accounts: list })
  },
  refreshScripts: async () => {
    const list = await tryCall('script:list')
    if (list) set({ scripts: list })
  },
  refreshTemplateSets: async () => {
    const list = await tryCall('template:sets')
    if (list) set({ templateSets: list })
  },
  refreshSettings: async () => {
    const s = await tryCall('app:settings')
    if (s) set({ settings: s })
  },
  refreshPaths: async () => {
    const p = await tryCall('app:paths')
    if (p) set({ paths: p })
  },
  refreshHealth: async () => {
    const h = await tryCall('app:health')
    if (h) set({ health: h })
  },

  bootstrap: async () => {
    const results = await Promise.allSettled([
      silentCall('app:settings'),
      silentCall('app:paths'),
      silentCall('instance:list'),
      silentCall('run:list'),
      silentCall('account:list'),
      silentCall('script:list'),
      silentCall('template:sets'),
      silentCall('app:health')
    ])
    const [settings, paths, instances, runs, accounts, scripts, templateSets, health] = results

    if (settings.status === 'fulfilled') set({ settings: settings.value })
    if (paths.status === 'fulfilled') set({ paths: paths.value })
    if (instances.status === 'fulfilled') get().setInstances(instances.value)
    if (runs.status === 'fulfilled') get().setRuns(runs.value)
    if (accounts.status === 'fulfilled') set({ accounts: accounts.value })
    if (scripts.status === 'fulfilled') set({ scripts: scripts.value })
    if (templateSets.status === 'fulfilled') set({ templateSets: templateSets.value })
    if (health.status === 'fulfilled') set({ health: health.value })

    const failed = results.filter((r) => r.status === 'rejected')
    const first = failed[0] as PromiseRejectedResult | undefined
    set({
      bootstrapped: true,
      bootError:
        failed.length === 0
          ? null
          : `有 ${failed.length} 项初始数据未能载入（主进程可能尚未接线）：${
              (first?.reason as { message?: string })?.message ?? '未知错误'
            }`
    })
  }
}))

// ── 派生查询（放在 store 外，避免无谓的重渲染）────────────────────────────

/** 已开机的实例数，用来卡并发上限。 */
export function countRunningInstances(instances: MumuInstance[]): number {
  return instances.filter(isInstanceUp).length
}

export function accountOfInstance(accounts: Account[], index: number): Account | undefined {
  return accounts.find((a) => a.instanceIndex === index)
}

export function activeRunOfInstance(runs: RunSnapshot[], index: number): RunSnapshot | undefined {
  return runs.find((r) => r.instanceIndex === index && isRunActive(r.status))
}

export function instanceOf(
  instances: MumuInstance[],
  index: number | null
): MumuInstance | undefined {
  if (index === null) return undefined
  return instances.find((i) => i.index === index)
}
