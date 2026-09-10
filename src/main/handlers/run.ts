/**
 * 执行通道 —— 转发给模块 d 的 orchestrator（utilityProcess 池）。
 *
 * 这里刻意**什么判断都不做**：并发上限、实例是否已占用、参数三层合并、
 * WorkerAttachPayload 的组装，全部在编排器内部完成。
 * 同一条规则在两个地方各写一遍，迟早会漂移成两套行为，那种 bug 最难查。
 *
 * 主进程在这条链路上唯一多做的一件事，是把 runId 回填进实例注册表，
 * 让「实例」页的卡片能显示「正在执行」。
 */

import { CH } from '@shared/ipc'
import { handle } from '@main/ipc'
import type { MainDeps } from './index'

export function registerRunHandlers(deps: MainDeps): void {
  handle(CH.runStart, async (req) => {
    const runHandle = await deps.orchestrator.start(req)
    deps.mumu.patch(req.instanceIndex, { runId: runHandle.runId })
    return runHandle
  })

  handle(CH.runStop, (runId) => deps.orchestrator.stop(runId))
  handle(CH.runPause, (runId) => deps.orchestrator.pause(runId))
  handle(CH.runResume, (runId) => deps.orchestrator.resume(runId))
  handle(CH.runList, () => deps.orchestrator.list())

  // 实时日志走 MessagePort（worker 直连渲染进程），这里只读已经落盘的历史。
  handle(CH.runLogs, (query) => deps.logs.query(query))
  handle(CH.runShot, (runId, shot) => deps.logs.readShot(runId, shot))
}
