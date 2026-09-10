/**
 * 定时唤醒。地基里原本**没有任何延迟任务设施** ——
 * orchestrator 的 setTimeout 只用于 shutdown 超时，StartRunRequest 也没有 delay 字段，
 * 所以 ETA 调度必须自带这一层。
 *
 * 三条必须遵守的实现细节：
 *   ① `timer.unref()` —— 否则一个挂着的唤醒会把 Electron 主进程钉住不退出。
 *   ② setTimeout 的上限是 2^31-1 ms（约 24.8 天）。采集是分钟到小时量级，本来够用，
 *      但仍然做了**分段续接**，免得将来有人排一个超长任务时静默立刻触发。
 *   ③ 机器休眠会让 timer 滞后。所以到期只代表「该去看一眼了」，
 *      **绝不能**把「timer 到期」直接当成「队伍已经回来了」—— 到期后必须重新读面板校验。
 */

/** setTimeout 单次能等的最长时间，留一点余量。 */
const MAX_TIMEOUT_MS = 2_000_000_000

export interface WakeTask {
  /** 每个实例最多一个唤醒任务，key 就是 instanceIndex。 */
  key: number
  dueAt: number
  reason: string
  /** 已经退避了几次，0 表示不在退避中。 */
  backoffStep: number
}

interface Entry {
  task: WakeTask
  timer: NodeJS.Timeout
}

const tasks = new Map<number, Entry>()

/**
 * 排一个唤醒（同 key 的旧任务会被顶掉）。
 * @param fire 到期回调。它自己抛的错由调用方在回调里处理，这里只保证不会炸掉定时器链。
 */
export function scheduleWake(task: WakeTask, fire: (task: WakeTask) => void): void {
  cancelWake(task.key)
  arm(task, fire)
}

function arm(task: WakeTask, fire: (task: WakeTask) => void): void {
  const wait = Math.max(0, task.dueAt - Date.now())
  const slice = Math.min(wait, MAX_TIMEOUT_MS)

  const timer = setTimeout(() => {
    // 分段续接：还没到点就再排一段。
    if (Date.now() < task.dueAt - 50) {
      arm(task, fire)
      return
    }
    tasks.delete(task.key)
    try {
      fire(task)
    } catch (e) {
      // 到这里说明回调自己没接住异常。吞掉会让调度静默死掉，所以至少吼到终端。
      console.error(`[scheduler] 唤醒回调抛错（实例 ${task.key}）：${String(e)}`)
    }
  }, slice)

  // ★ 不 unref 的话，用户关掉窗口后主进程会被这个定时器吊着不退出。
  timer.unref?.()
  tasks.set(task.key, { task, timer })
}

export function cancelWake(key: number): void {
  const e = tasks.get(key)
  if (!e) return
  clearTimeout(e.timer)
  tasks.delete(key)
}

export function cancelAllWakes(): void {
  for (const key of [...tasks.keys()]) cancelWake(key)
}

export function getWake(key: number): WakeTask | null {
  return tasks.get(key)?.task ?? null
}

export function listWakes(): WakeTask[] {
  return [...tasks.values()].map((e) => e.task).sort((a, b) => a.dueAt - b.dueAt)
}
