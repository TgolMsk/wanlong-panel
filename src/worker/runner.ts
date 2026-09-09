/**
 * utilityProcess 入口 —— 每个正在跑脚本的模拟器实例一个。
 *
 * 它被 electron.vite.config.ts 作为 main 段的第二个 rollup 入口打成 out/main/runner.js，
 * 由 src/main/orchestrator 用 utilityProcess.fork(join(__dirname,'runner.js')) 拉起。
 *
 * 这里是纯 Node 环境：有 sharp / opencv-js / child_process，但**没有 DOM、没有 WebCodecs**。
 *
 * ⚠️ 当前是握手骨架，脚本引擎主体由「模块 d」补齐。
 */

import type { MainToWorker, WorkerToMain } from '@shared/worker'

const parentPort = process.parentPort

function send(msg: WorkerToMain): void {
  parentPort.postMessage(msg)
}

const t0 = Date.now()

parentPort.on('message', (e) => {
  const msg = e.data as MainToWorker
  switch (msg.type) {
    case 'attach':
      // TODO(模块 d): 保存 e.ports[0] 作为通往渲染进程的 MessagePort，初始化引擎。
      send({ type: 'attached', runId: msg.payload.runId })
      break
    case 'shutdown':
      process.exit(0)
      break
    default:
      break
  }
})

send({ type: 'ready', pid: process.pid, initMs: Date.now() - t0 })
