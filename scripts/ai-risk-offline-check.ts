import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AiAdvisor, setAiFetch, aiRecoverUnknownScreen } from '@main/ai'
import { saveAiFile } from '@main/ai/store'
import { parseAdvice } from '@main/ai/advisor'
import { parseRisk, riskRejection } from '@main/ai/risk'
import { defaultAiConfig, type AiRiskAssessment } from '@shared/ai'
import { GAME_PACKAGE } from '@main/game/gather/geometry'
import type { RawFrame } from '@shared/vision'
import { AppError } from '@shared/errors'

const dir = await mkdtemp(join(tmpdir(), 'wanlong-ai-risk-'))
const low: AiRiskAssessment = {
  level: 'low',
  effect: 'acknowledge',
  buttonText: '确定',
  dialogText: '连接已恢复，点击确定继续',
  consequence: '关闭提示继续游戏',
  reason: '仅确认信息，无付费、资源消耗或账号变更',
  hazards: []
}
const body = (risk: unknown = low, extra: Record<string, unknown> = {}) => ({
  screen: 'dialog',
  action: 'tap_confirm',
  target: { x: 600, y: 430, w: 180, h: 80 },
  confidence: 0.95,
  reason: '信息确认',
  risk,
  ...extra
})
const frame = (v: number): RawFrame => {
  const data = new Uint8Array(1280 * 720 * 4)
  for (let i = 0; i < 1280 * 720; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v + (i % 31 < 10 ? 10 : 0)
    data[i * 4 + 3] = 255
  }
  return { width: 1280, height: 720, format: 1, capturedAt: 0, data }
}
const before = frame(180),
  after = frame(60)
let sequence = 0
async function run(
  replies: unknown[],
  options: {
    cfg?: Record<string, unknown>
    stale?: boolean
    abortReview?: boolean
    wrongApp?: boolean
    captureError?: boolean
    tapError?: boolean
  } = {}
) {
  const advisor = new AiAdvisor()
  let now = 1_000_000
  advisor.setConfigForTest(
    {
      ...defaultAiConfig(),
      enabled: true,
      apiKey: 'fake-test-key',
      imageWidth: 1280,
      cooldownSeconds: 20,
      refine: false,
      ...options.cfg
    },
    {
      dataDir: () => dir,
      now: () => now,
      log: () => {}
    }
  )
  const taps: number[][] = []
  let calls = 0,
    captures = 0
  const controller = new AbortController()
  setAiFetch(async () => {
    const value = replies[calls++]
    if (options.abortReview && calls === 2) controller.abort()
    if (value === 'http-error') return { status: 500, text: async () => 'offline injected error' }
    return {
      status: 200,
      text: async () =>
        JSON.stringify({
          model: 'fake-risk-model',
          choices: [{ message: { content: JSON.stringify(value) } }]
        })
    }
  })
  const ctx = {
    instanceIndex: ++sequence,
    context: 'risk-test',
    raw: before,
    refWidth: 1280,
    refHeight: 720,
    setId: null,
    attempt: 1,
    checkAlive: () => {
      if (controller.signal.aborted) throw new AppError('RUN_ABORTED', 'stopped')
    },
    foregroundPackage: async () => (options.wrongApp ? 'other.app' : GAME_PACKAGE),
    io: {
      capture: async () => {
        if (options.captureError) throw new Error('capture failed')
        captures++
        return taps.length || (options.stale && captures >= 2) ? after : before
      },
      tap: async (x: number, y: number) => {
        if (options.tapError) throw new Error('tap failed')
        taps.push([x, y])
      },
      key: async () => {
        throw new Error('must not press BACK')
      }
    },
    recognize: async (raw: RawFrame) => raw === after,
    log: () => {}
  }
  const result = await aiRecoverUnknownScreen(advisor, ctx)
  return {
    result,
    taps,
    calls,
    advisor,
    ctx,
    advance: () => {
      now += 21_000
    }
  }
}

try {
  const success = await run([body(), body()])
  assert.equal(success.result.outcome, 'verified')
  assert.equal(success.result.advice?.riskRechecked, true)
  assert.equal(success.calls, 2, 'review bypasses per-instance cooldown but consumes quota')
  assert.deepEqual(success.taps, [[690, 470]])
  assert.equal(
    success.result.harvestedTemplateId,
    null,
    'confirmation must not become a reusable close template'
  )

  for (const effect of [
    'download_update',
    'retry_connection',
    'continue_loading',
    'navigate'
  ] as const) {
    const risk = { ...low, effect }
    const result = await run([body(risk), body(risk)])
    assert.equal(result.result.outcome, 'verified', effect)
    assert.equal(result.taps.length, 1)
  }
  for (const effect of [
    'purchase',
    'spend_resource',
    'delete',
    'account_change',
    'permission_change',
    'send_message',
    'combat',
    'exit_game',
    'unknown'
  ] as const) {
    const result = await run([body({ ...low, effect })])
    assert.equal(
      result.result.requiresAttention,
      true,
      'low label cannot override effect ' + effect
    )
    assert.equal(result.taps.length, 0)
    assert.equal(result.calls, 1)
  }
  for (const risk of [
    undefined,
    { ...low, level: 'high' },
    { ...low, level: 'medium' },
    { ...low, level: 'unknown' },
    { ...low, hazards: ['消耗钻石'] },
    { ...low, hazards: undefined },
    { ...low, dialogText: '' }
  ]) {
    const first = body()
    first.risk = risk as AiRiskAssessment
    const result = await run([first])
    assert.equal(result.result.requiresAttention, true)
    assert.equal(result.taps.length, 0)
  }
  const secondRisk = await run([body(), body({ ...low, level: 'high', effect: 'purchase' })])
  assert.equal(secondRisk.result.requiresAttention, true)
  assert.equal(secondRisk.taps.length, 0)
  const changedButton = await run([body(), body({ ...low, buttonText: '领取' })])
  assert.equal(changedButton.result.requiresAttention, true)
  assert.equal(changedButton.taps.length, 0)
  const stale = await run([body(), body()], { stale: true })
  assert.equal(stale.result.handled, true, 'reanalyse the changed screen instead of pressing BACK')
  assert.equal(stale.taps.length, 0)
  const cancelled = await run([body(), body()], { abortReview: true })
  assert.equal(cancelled.taps.length, 0)
  const wrongApp = await run([body()], { wrongApp: true })
  assert.equal(wrongApp.taps.length, 0)
  assert.equal(wrongApp.result.requiresAttention, true)
  const budget = await run([body()], { cfg: { maxCallsPerHour: 1 } })
  assert.equal(budget.calls, 1)
  assert.equal(budget.result.requiresAttention, true)
  assert.equal(budget.taps.length, 0)
  const network = await run([body(), 'http-error'])
  assert.equal(network.result.requiresAttention, true)
  assert.equal(network.taps.length, 0)
  for (const failure of [{ captureError: true }, { tapError: true }]) {
    const failedIo = await run([body(), body()], failure)
    assert.equal(
      failedIo.result.requiresAttention,
      true,
      'uncertain confirmation must not fall through to BACK on IO failure'
    )
    assert.equal(failedIo.taps.length, 0)
  }
  success.advance()
  assert.equal(
    success.advisor.claimConfirmation(success.ctx.instanceIndex, success.result.advice!),
    false
  )
  assert.equal(
    success.advisor.claimConfirmation(success.ctx.instanceIndex + 100, success.result.advice!),
    true
  )

  const decline = await run([
    body({ ...low, level: 'high', effect: 'delete' }, { action: 'none', target: null })
  ])
  assert.equal(
    decline.result.requiresAttention,
    true,
    'none on a risky dialog cannot fall through to BACK'
  )
  const mislabeledNone = await run([
    body({ ...low, effect: 'delete' }, { action: 'none', target: null })
  ])
  assert.equal(mislabeledNone.result.requiresAttention, true)

  // ★ 2026-09-18 真机：派完兵后一个半透明引导气泡盖在世界地图上，G0 认不出 → 问 AI →
  //   AI 答「这本来就是世界地图，气泡没有 × 可关，强行点反而偏离主界面」→ 被判风险未通过 →
  //   实例被暂停等人处理。back / none 本函数根本不会去点，拿一个不会发生的点击的风险去暂停实例，
  //   是把安全闸门用错了地方。模型认出是主界面时必须交回兜底阶梯，而不是暂停。
  for (const screen of ['world_map', 'city', 'troop_panel']) {
    const onMain = await run([
      body({ ...low, level: 'high', effect: 'delete' }, { action: 'none', target: null, screen })
    ])
    assert.equal(
      onMain.result.requiresAttention,
      false,
      `none on ${screen} must not pause the instance`
    )
    assert.equal(onMain.result.outcome, 'no_action')
    assert.equal(onMain.taps.length, 0)
  }
  // 但顶号 / 看不出来这类仍然要暂停 —— 那才是闸门该拦的。
  for (const screen of ['kicked', 'maintenance', 'unknown']) {
    const risky = await run([
      body({ ...low, level: 'high', effect: 'delete' }, { action: 'none', target: null, screen })
    ])
    assert.equal(risky.result.requiresAttention, true, `none on ${screen} must still pause`)
  }
  for (const screen of ['kicked', 'unknown']) {
    const ambiguous = await run([body(low, { screen })])
    assert.equal(ambiguous.result.requiresAttention, true)
    assert.equal(ambiguous.taps.length, 0)
  }
  const disguised = await run([body({ ...low, effect: 'purchase' }, { action: 'tap_close' })])
  assert.equal(disguised.taps.length, 0)
  assert.equal(disguised.result.requiresAttention, true)
  const parsed = parseAdvice(
    JSON.stringify(body({ ...low, effect: 'download_update' }, { screen: 'update' })),
    1280,
    720
  )
  assert.ok(parsed.ok, 'unknown update layouts can use risk-based confirmation')
  if (parsed.ok)
    assert.equal(riskRejection({ ...parsed, model: 'fake', latencyMs: 0, refined: false }), null)
  assert.equal(parseRisk({ ...low, hazards: 'none' }).level, 'unknown')
  assert.equal(parseRisk({ ...low, level: 'safe' }).level, 'unknown')
  console.log(
    'PASS: semantic confirmation, risky effects, missing evidence, two fresh assessments, changed screen, foreground, stop, quota, failed review, duplicate prevention, no confirmation template learning'
  )
} finally {
  await saveAiFile(dir, { version: 1, config: defaultAiConfig(), history: [] })
  assert.ok(resolve(dir).startsWith(resolve(tmpdir(), 'wanlong-ai-risk-')))
  await rm(dir, { recursive: true, force: true })
}
