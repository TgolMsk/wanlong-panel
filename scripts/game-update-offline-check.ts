/** No emulator or network access. Real button/text crops, synthetic surrounding UI, fake time. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp, { type OverlayOptions } from 'sharp'
import { GameUpdateRecovery, type UpdateContext } from '@main/game/update'
import { GAME_PACKAGE } from '@main/game/gather/geometry'
import { parseAdvice } from '@main/ai/advisor'
import { riskRejection } from '@main/ai/risk'
import type { RawFrame } from '@shared/vision'
import { AppError } from '@shared/errors'
import { prepareTemplate } from '@vision/index'
import { sampleTroopPanel, type SampleOptions } from '@main/scheduler/troopPanel'
import { TPL, type SchedulerTemplates } from '@main/scheduler/templates'

const resources = resolve('resources')
const message = await readFile(resolve(resources, 'game-update/message.png'))
const confirm = await readFile(resolve(resources, 'game-update/confirm.png'))
async function makeFrame(text = true, button = true, dx = 0, width = 2560): Promise<RawFrame> {
  const overlays: OverlayOptions[] = []
  if (text) overlays.push({ input: message, left: 844, top: 570 })
  if (button) overlays.push({ input: confirm, left: 1320 + dx, top: 827 })
  const png = await sharp({
    create: { width: 2560, height: 1440, channels: 4, background: '#f6f6f6' }
  })
    .composite(overlays)
    .png()
    .toBuffer()
  const { data, info } = await sharp(png)
    .resize(width)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return {
    data: new Uint8Array(data),
    width: info.width,
    height: info.height,
    format: 1,
    capturedAt: 0
  }
}
const prompt = await makeFrame()
const ready = await makeFrame(false, false)
const matcher = new GameUpdateRecovery(() => resources)
assert.ok(await matcher.detect(prompt))
assert.ok(await matcher.detect(await makeFrame(true, true, 0, 1280)))
assert.equal(
  await matcher.detect(await makeFrame(false, true)),
  null,
  'ordinary confirmation cannot authorize an update'
)
assert.equal(await matcher.detect(await makeFrame(true, false)), null)
assert.equal(
  await matcher.detect(await makeFrame(true, true, 70)),
  null,
  'unrelated button must not match'
)

function scenario(
  options: {
    maxWait?: number
    frame?: (n: number) => RawFrame
    abortAt?: number
    foreground?: () => string
  } = {}
) {
  let time = 0
  let captures = 0
  const taps: [number, number][] = []
  const messages: string[] = []
  const updater = new GameUpdateRecovery(
    () => resources,
    () => time,
    async (ms) => {
      time += ms
    },
    options.maxWait ?? 60_000
  )
  const ctx: UpdateContext = {
    raw: prompt,
    refWidth: 2560,
    refHeight: 1440,
    io: {
      capture: async () => {
        captures++
        return options.frame ? options.frame(captures) : captures === 1 ? prompt : ready
      },
      foregroundPackage: async () => options.foreground?.() ?? GAME_PACKAGE,
      tap: async (x, y) => {
        taps.push([x, y])
      }
    },
    check: () => {
      if (options.abortAt !== undefined && time >= options.abortAt)
        throw new AppError('RUN_ABORTED', 'stopped')
    },
    recognize: async (raw) => raw === ready,
    log: (message) => {
      messages.push(message)
    }
  }
  return { updater, ctx, taps, messages, time: () => time }
}
const complete = scenario()
assert.equal(await complete.updater.handle(complete.ctx), true)
assert.equal(complete.taps.length, 1)
assert.ok(Math.abs(complete.taps[0]![0] - 1545) <= 2)

const stale = scenario({ frame: () => ready })
assert.equal(await stale.updater.handle(stale.ctx), true)
assert.equal(stale.taps.length, 0, 'fresh screenshot must be checked before tap')

const cancel = scenario({ frame: () => prompt, abortAt: 100 })
await assert.rejects(cancel.updater.handle(cancel.ctx), { code: 'RUN_ABORTED' })
assert.equal(cancel.taps.length, 1)
assert.equal(cancel.time(), 100, 'cancellation must interrupt download waiting promptly')
const cancelledBeforeStart = scenario({ abortAt: 0 })
await assert.rejects(cancelledBeforeStart.updater.handle(cancelledBeforeStart.ctx), {
  code: 'RUN_ABORTED'
})
assert.equal(cancelledBeforeStart.taps.length, 0)

const unchanged = scenario({ frame: () => prompt })
await assert.rejects(unchanged.updater.handle(unchanged.ctx), { code: 'GAME_UPDATE_REQUIRED' })
assert.equal(unchanged.taps.length, 1, 'never repeatedly click update confirmation')

const timeout = scenario({ maxWait: 6000, frame: (n) => (n === 1 ? prompt : ready) })
timeout.ctx.recognize = async () => false
await assert.rejects(timeout.updater.handle(timeout.ctx), { code: 'GAME_UPDATE_REQUIRED' })
assert.equal(timeout.taps.length, 1)

const wrongApp = scenario({ foreground: () => 'android.settings' })
await assert.rejects(wrongApp.updater.handle(wrongApp.ctx), { code: 'GAME_UPDATE_REQUIRED' })
assert.equal(wrongApp.taps.length, 0)

const slow = scenario({ maxWait: 120_000 })
slow.ctx.recognize = async () => slow.time() >= 75_000
let overlayChecks = 0
slow.ctx.recoverOverlay = async () => {
  overlayChecks++
  return false
}
assert.equal(await slow.updater.handle(slow.ctx), true)
assert.equal(slow.taps.length, 1)
assert.equal(overlayChecks, 2, 'slow update waits without exhausting the AI request budget')
assert.ok(slow.messages.some((m) => m.includes('等待游戏更新')))

const downloadPng = await readFile(resolve(resources, 'game-update/downloading.png'))
const downloadingPixels = await sharp({
  create: { width: 2560, height: 1440, channels: 4, background: '#444444' }
})
  .composite([{ input: downloadPng, left: 1010, top: 1207 }])
  .raw()
  .toBuffer()
const downloading: RawFrame = {
  data: new Uint8Array(downloadingPixels),
  width: 2560,
  height: 1440,
  format: 1,
  capturedAt: 0
}
const resumed = scenario({ maxWait: 120_000, frame: () => downloading })
resumed.ctx.raw = downloading
resumed.ctx.recognize = async () => resumed.time() >= 75_000
let unnecessaryAiCalls = 0
resumed.ctx.recoverOverlay = async () => {
  unnecessaryAiCalls++
  return false
}
assert.equal(await resumed.updater.handle(resumed.ctx), true)
assert.equal(resumed.taps.length, 0, 'resume an existing download without another confirmation')
assert.equal(unnecessaryAiCalls, 0, 'known download progress should not consume AI requests')

const unknown = parseAdvice(
  JSON.stringify({
    screen: 'update',
    action: 'none',
    confidence: 1,
    reason: '资源更新',
    target: null
  }),
  1280,
  720
)
assert.ok(unknown.ok && unknown.screen === 'update')
assert.equal(
  parseAdvice(
    JSON.stringify({
      screen: 'update',
      action: 'tap_purchase',
      confidence: 1,
      target: { x: 1, y: 2, w: 50, h: 30 }
    }),
    1280,
    720
  ).ok,
  false
)
const updateWithoutRisk = parseAdvice(
  JSON.stringify({
    screen: 'update',
    action: 'tap_close',
    confidence: 1,
    target: { x: 1, y: 2, w: 50, h: 30 }
  }),
  1280,
  720
)
assert.ok(updateWithoutRisk.ok)
if (updateWithoutRisk.ok)
  assert.ok(riskRejection({ ...updateWithoutRisk, model: 'fake', latencyMs: 0, refined: false }))

// Exercise the actual sampler: an update block must never fall through to BACK;
// waiting two minutes must not exhaust its ordinary one-minute sampling budget.
const title = await prepareTemplate(message, {
  id: TPL.panelTitle,
  name: 'synthetic title',
  refW: 2560,
  authoredWidth: 10000,
  shrink: 2
})
const templates = { ui: new Map([[TPL.panelTitle, title]]) } as SchedulerTemplates
const opts = (): SampleOptions => ({
  refWidth: 2560,
  refHeight: 1440,
  maxRows: 5,
  readOptionalFields: false,
  closePanelAfterSample: false,
  deadlineAt: Date.now() + 60_000
})
let keys = 0
for (const errorCode of ['GAME_UPDATE_REQUIRED', 'AI_RISK_BLOCKED'] as const) {
  await assert.rejects(
    sampleTroopPanel(
      {
        serial: 'fake',
        capture: async () => ready,
        tapRef: async () => {},
        key: async () => {
          keys++
        },
        onUnrecognized: async () => {
          throw new AppError(errorCode, 'automation blocked')
        }
      },
      templates,
      opts()
    ),
    { code: errorCode }
  )
  assert.equal(keys, 0)
}
const realNow = Date.now
let offset = 0
Date.now = () => realNow() + offset
const waitingOptions = opts()
let reads = 0
try {
  await assert.rejects(
    sampleTroopPanel(
      {
        serial: 'fake',
        capture: async () => {
          if (++reads > 3) throw new Error('resumed capture')
          return ready
        },
        tapRef: async () => {},
        key: async () => {
          keys++
        },
        onUnrecognized: async () => {
          offset += 120_000
          return 'updated'
        }
      },
      templates,
      waitingOptions
    ),
    /resumed capture/
  )
  assert.ok(waitingOptions.deadlineAt > Date.now())
} finally {
  Date.now = realNow
}
assert.equal(keys, 0)
console.log(
  'PASS: update text + button matching, scaled screens, stale frames, one click, stop, foreground, timeout, slow download, AI action boundary'
)
