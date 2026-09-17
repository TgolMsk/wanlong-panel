/** No device IO or production data. Controlled promises exercise the actual scheduler/runner. */
import assert from 'node:assert/strict'
import { getScheduler } from '@main/scheduler'
import { getOrchestrator, type RunDeps } from '@main/orchestrator'
import { instanceAccess } from '@main/instanceAccess'
import { defaultSettings } from '@shared/defaults'
import type { InstanceQueueState } from '@shared/scheduler'
import type { ScriptDef } from '@shared/script'
import type { ResolvedPaths } from '@shared/domain'
import { GatherSession, type GatherIo } from '@main/game/gather/session'
import { normalizeGatherConfig } from '@main/game/gather/config'
import type { GatherTemplates } from '@main/game/gather/templates'

function gate() {
  let release!: () => void
  return {
    promise: new Promise<void>((r) => {
      release = r
    }),
    release: () => release()
  }
}
const scheduler = getScheduler()
const internals = scheduler as unknown as {
  rt(i: number): { state: InstanceQueueState; autoController?: AbortController }
  sample(i: number): Promise<void>
  persist(): Promise<void>
  rearm(): void
  onWake(i: number, reason: string, step: number): Promise<void>
  withLock<T>(i: number, fn: () => Promise<T>): Promise<T>
}
internals.persist = async () => {}
internals.rearm = () => {}
const oldSample = gate()
const entered = gate()
let first = true
internals.sample = async (i) => {
  if (first) {
    first = false
    entered.release()
    await oldSample.promise
  }
  const rt = internals.rt(i)
  rt.state.queueUsed = 0
  rt.state.queueTotal = 5
}
let dispatches = 0
scheduler.setQueueFreeHook(async () => {
  dispatches++
})
await scheduler.setAuto(10, false)
internals.rt(10).state.auto = true
const wake = internals.onWake(10, 'test', 0)
await entered.promise
await scheduler.setAuto(10, false)
// Re-enable before the old sample resolves: old work must remain cancelled.
await scheduler.setAuto(10, true)
oldSample.release()
await wake
assert.equal(dispatches, 0)
await internals.onWake(10, 'new wake', 0)
assert.equal(dispatches, 1)

const gathering = gate()
const finishGather = gate()
let lateTap = 0
scheduler.setQueueFreeHook(async (_state, signal) => {
  const session = new GatherSession({
    io: {
      tap: async () => {
        lateTap++
      }
    } as unknown as GatherIo,
    templates: {} as GatherTemplates,
    config: normalizeGatherConfig({}),
    signal
  })
  gathering.release()
  await finishGather.promise
  await assert.rejects(session.io.tap(1, 1)) // Includes direct IO used by the AI advisor.
})
const running = internals.onWake(10, 'gather', 0)
await gathering.promise
await scheduler.setAuto(10, false)
finishGather.release()
await running
assert.equal(lateTap, 0)

// Pause after sampling, while dispatch is waiting for the per-instance lock.
await scheduler.setAuto(10, true)
const lockEntered = gate()
const releaseLock = gate()
const holder = internals.withLock(10, async () => {
  lockEntered.release()
  await releaseLock.promise
})
await lockEntered.promise
let queuedDispatches = 0
scheduler.setQueueFreeHook(async () => {
  queuedDispatches++
})
const queuedWake = internals.onWake(10, 'queued dispatch', 0)
await new Promise<void>((r) => setImmediate(r))
await scheduler.setAuto(10, false)
releaseLock.release()
await Promise.all([holder, queuedWake])
assert.equal(queuedDispatches, 0)

const orch = getOrchestrator()
const settings = { ...defaultSettings('unused', 'win32'), maxConcurrentInstances: 1 }
const deps: RunDeps = {
  settings,
  paths: {} as ResolvedPaths,
  resolveSerial: async () => 'offline',
  loadScript: async () => ({ id: 'test', name: 'test', steps: [] }) as unknown as ScriptDef
}
const resolving = gate()
const resolved = gate()
const starting = orch.start(
  null,
  { instanceIndex: 20, scriptId: 'test' },
  {
    ...deps,
    resolveSerial: async () => {
      resolving.release()
      await resolved.promise
      return 'offline'
    }
  }
)
await resolving.promise
assert.ok(orch.runIdOfInstance(20))
await assert.rejects(orch.start(null, { instanceIndex: 20, scriptId: 'test' }, deps), {
  code: 'CONCURRENCY_LIMIT'
})
await assert.rejects(orch.start(null, { instanceIndex: 21, scriptId: 'test' }, deps), {
  code: 'CONCURRENCY_LIMIT'
})
await assert.rejects(
  internals.withLock(20, async () => {}),
  { code: 'CONCURRENCY_LIMIT' }
)
resolved.release()
const handle = await starting
await assert.rejects(
  internals.withLock(20, async () => {}),
  { code: 'CONCURRENCY_LIMIT' }
)
await orch.stop(handle.runId)
await internals.withLock(20, async () => {})

const release = instanceAccess.acquire(21, '自动采集')
await assert.rejects(orch.start(null, { instanceIndex: 21, scriptId: 'test' }, deps), {
  code: 'CONCURRENCY_LIMIT'
})
release()
await assert.rejects(
  orch.start(
    null,
    { instanceIndex: 21, scriptId: 'test' },
    {
      ...deps,
      resolveSerial: async () => {
        throw new Error('offline device error')
      }
    }
  )
)
assert.equal(orch.runIdOfInstance(21), null)
const retry = await orch.start(null, { instanceIndex: 21, scriptId: 'test' }, deps)
await orch.stop(retry.runId)
console.log(
  'PASS: pause/resume generation, in-flight gather cancellation, two-way exclusion, pending start limit, failure release'
)
