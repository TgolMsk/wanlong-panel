/**
 * 运行时校验（zod）。
 *
 * 为什么需要：mumutool 的 JSON 字段可能随 MuMu 版本变化，磁盘上的账号/脚本/模板文件可能被手改，
 * TS 类型在运行时是不存在的。所有「从进程外进来的数据」都必须先过一遍这里再当成领域对象用。
 */

import { z } from 'zod'
import { AppError } from './errors'
import type { ErrorCode } from './errors'
import type { Condition, ScriptStep } from './script'

// ── mumutool 输出信封 ─────────────────────────────────────────────────────

/**
 * ★ mumutool 的错误语义（实测）：
 *   · CLI 用法错误 -> 退出码 64，stderr 是非 JSON 文本
 *   · 业务错误     -> **退出码仍是 0**，stdout 是 {"errcode":42001,...}
 *   所以判错必须解析 errcode，不能只看退出码。
 */
export const mumuEnvelopeSchema = z.object({
  errcode: z.number(),
  message: z.string(),
  return: z.unknown().optional()
})
export type MumuEnvelope = z.infer<typeof mumuEnvelopeSchema>

export const mumuInstanceRawSchema = z.object({
  index: z.number(),
  name: z.string(),
  adb_port: z.number().optional(),
  pid: z.number().optional(),
  state: z.string(),
  state_detail: z.object({ enableScreen: z.boolean().optional() }).optional(),
  bundle_path: z.string().optional()
})

export const mumuInfoReturnSchema = z.object({
  count: z.number(),
  results: z.array(mumuInstanceRawSchema)
})

/**
 * 解析 mumutool 的 stdout。
 * @throws AppError('MUMU_BAD_OUTPUT') 输出不是合法信封
 * @throws AppError('MUMU_API_ERROR' | 'MUMU_API_UNSUPPORTED') errcode != 0
 */
export function parseMumuEnvelope(stdout: string): unknown {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    throw new AppError('MUMU_BAD_OUTPUT', 'mumutool 输出不是合法 JSON', {
      stdout: stdout.slice(0, 500)
    })
  }
  const parsed = mumuEnvelopeSchema.safeParse(raw)
  if (!parsed.success) {
    throw new AppError('MUMU_BAD_OUTPUT', 'mumutool 输出结构与预期不符', {
      issues: parsed.error.issues
    })
  }
  const env = parsed.data
  if (env.errcode !== 0) {
    // errcode 42000 = invalidApi，说明 Mac 版根本没实现这个接口（control 子命令族全军覆没），
    // 属于永久性失败，调用方不要重试、不要写 fallback 分支。
    const code = env.errcode === 42000 ? 'MUMU_API_UNSUPPORTED' : 'MUMU_API_ERROR'
    throw new AppError(code, `mumutool 返回错误 errcode=${env.errcode}: ${env.message}`, {
      errcode: env.errcode,
      message: env.message
    })
  }
  return env.return
}

// ── 几何 ─────────────────────────────────────────────────────────────────

export const pointSchema = z.object({ x: z.number(), y: z.number() })
export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive()
})

// ── 模板 ──────────────────────────────────────────────────────────────────

export const templateDefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  file: z.string().min(1),
  authoredWidth: z.number().positive(),
  authoredHeight: z.number().positive(),
  bounds: rectSchema,
  defaultRoi: rectSchema.optional(),
  threshold: z.number().min(0).max(1).optional(),
  std: z.number().optional(),
  maskCoverage: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  note: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number()
})

export const templateSetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  packageName: z.string().optional(),
  refWidth: z.number().positive(),
  refHeight: z.number().positive(),
  templates: z.array(templateDefSchema),
  updatedAt: z.number()
})

// ── 脚本 DSL ──────────────────────────────────────────────────────────────

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal('always') }),
    z.object({ kind: z.literal('never') }),
    z.object({
      kind: z.literal('template'),
      templateId: z.string().min(1),
      roi: rectSchema.optional(),
      threshold: z.number().min(0).max(1).optional(),
      present: z.boolean().optional()
    }),
    z.object({
      kind: z.literal('anyTemplate'),
      templateIds: z.array(z.string().min(1)).min(1),
      roi: rectSchema.optional(),
      threshold: z.number().min(0).max(1).optional()
    }),
    z.object({
      kind: z.literal('foreground'),
      packageName: z.string().min(1),
      equals: z.boolean().optional()
    }),
    z.object({ kind: z.literal('and'), all: z.array(conditionSchema) }),
    z.object({ kind: z.literal('or'), any: z.array(conditionSchema) }),
    z.object({ kind: z.literal('not'), of: conditionSchema })
  ])
) as z.ZodType<Condition>

export const failPolicySchema = z.union([
  z.object({ kind: z.literal('abort') }),
  z.object({ kind: z.literal('continue') }),
  z.object({ kind: z.literal('goto'), label: z.string().min(1) }),
  z.object({ kind: z.literal('restartApp') })
])

const stepBaseShape = {
  id: z.string().min(1),
  name: z.string().optional(),
  when: conditionSchema.optional(),
  timeoutMs: z.number().positive().optional(),
  retry: z.number().int().min(0).optional(),
  retryDelayMs: z.number().min(0).optional(),
  onFail: failPolicySchema.optional(),
  afterDelayMs: z.number().min(0).optional(),
  capture: z.boolean().optional()
}

const androidKeySchema = z.enum([
  'BACK',
  'HOME',
  'ENTER',
  'MENU',
  'APP_SWITCH',
  'DEL',
  'ESCAPE',
  'VOLUME_UP',
  'VOLUME_DOWN'
])

export const scriptStepSchema: z.ZodType<ScriptStep> = z.lazy(() =>
  z.union([
    z.object({ ...stepBaseShape, kind: z.literal('tap'), at: pointSchema }),
    z.object({
      ...stepBaseShape,
      kind: z.literal('tapTemplate'),
      templateId: z.string().min(1),
      roi: rectSchema.optional(),
      threshold: z.number().min(0).max(1).optional(),
      offset: pointSchema.optional(),
      waitMs: z.number().min(0).optional(),
      pollMs: z.number().positive().optional()
    }),
    z.object({
      ...stepBaseShape,
      kind: z.literal('waitFor'),
      cond: conditionSchema,
      waitMs: z.number().min(0),
      pollMs: z.number().positive().optional()
    }),
    z.object({
      ...stepBaseShape,
      kind: z.literal('swipe'),
      from: pointSchema,
      to: pointSchema,
      durationMs: z.number().positive().optional()
    }),
    z.object({
      ...stepBaseShape,
      kind: z.literal('longPress'),
      at: pointSchema,
      durationMs: z.number().positive()
    }),
    z.object({ ...stepBaseShape, kind: z.literal('text'), text: z.string() }),
    z.object({ ...stepBaseShape, kind: z.literal('key'), key: androidKeySchema }),
    z.object({ ...stepBaseShape, kind: z.literal('sleep'), ms: z.number().min(0) }),
    z.object({
      ...stepBaseShape,
      kind: z.literal('launchApp'),
      packageName: z.string().optional(),
      cold: z.boolean().optional()
    }),
    z.object({
      ...stepBaseShape,
      kind: z.literal('stopApp'),
      packageName: z.string().optional()
    }),
    z.object({ ...stepBaseShape, kind: z.literal('screenshot'), label: z.string().optional() }),
    z.object({
      ...stepBaseShape,
      kind: z.literal('log'),
      level: z.enum(['debug', 'info', 'warn', 'error']),
      message: z.string()
    }),
    z.object({ ...stepBaseShape, kind: z.literal('label'), label: z.string().min(1) }),
    z.object({
      ...stepBaseShape,
      kind: z.literal('goto'),
      label: z.string().min(1),
      maxTimes: z.number().int().positive().optional()
    }),
    z.object({
      ...stepBaseShape,
      kind: z.literal('if'),
      cond: conditionSchema,
      then: z.array(scriptStepSchema),
      else: z.array(scriptStepSchema).optional()
    }),
    z.object({
      ...stepBaseShape,
      kind: z.literal('loop'),
      steps: z.array(scriptStepSchema),
      repeat: z.number().int().positive().optional(),
      while: conditionSchema.optional(),
      maxIterations: z.number().int().positive().optional()
    })
  ])
) as z.ZodType<ScriptStep>

export const scriptParamDefSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'enum']),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  note: z.string().optional()
})

export const scriptDefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().min(1),
  packageName: z.string().optional(),
  templateSetId: z.string().optional(),
  refWidth: z.number().positive(),
  refHeight: z.number().positive(),
  params: z.array(scriptParamDefSchema).optional(),
  steps: z.array(scriptStepSchema),
  loop: z.boolean().optional(),
  loopIntervalMs: z.number().min(0).optional(),
  updatedAt: z.number()
})

// ── 账号 ──────────────────────────────────────────────────────────────────

export const accountSchema = z.object({
  setup: z
    .object({
      status: z.enum(['pending', 'ready']),
      instanceIdentity: z.string().nullable(),
      verifiedAt: z.number().nullable()
    })
    .optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  packageName: z.string().optional(),
  instanceIndex: z.number().int().nullable(),
  note: z.string().optional(),
  defaultScriptId: z.string().optional(),
  scriptParams: z
    .record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])))
    .optional(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number()
})

export const accountsFileSchema = z.object({
  version: z.literal(1),
  accounts: z.array(accountSchema)
})

// ── 设置 ──────────────────────────────────────────────────────────────────

export const emulatorKindSchema = z.enum(['ldplayer', 'mumu'])

export const appSettingsSchema = z.object({
  emulator: emulatorKindSchema,
  // ★ 两个路径允许空串：Windows 上表示「尚未探测到雷电安装目录」，由主进程启动时回填，
  //   自检项会把「路径为空」翻译成可操作的中文指引；写成 min(1) 会让整份设置回退成默认值。
  adbPath: z.string(),
  mumutoolPath: z.string(),
  dataDir: z.string().min(1),
  refWidth: z.number().int().positive(),
  refHeight: z.number().int().positive(),
  shrink: z.number().int().min(1).max(8),
  matchThreshold: z.number().min(0).max(1),
  maxConcurrentInstances: z.number().int().min(1).max(16),
  minCaptureIntervalMs: z.number().int().min(0),
  shotPolicy: z.enum(['never', 'onFail', 'always']),
  instancePollIntervalMs: z.number().int().min(500),
  locale: z.literal('zh-CN')
})

// ── 通用 helper ───────────────────────────────────────────────────────────

/** 校验失败时抛出带中文说明的 AppError，而不是 zod 的英文堆栈。 */
export function parseOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  what: string,
  code: ErrorCode = 'INVALID_ARGUMENT'
): T {
  const r = schema.safeParse(value)
  if (!r.success) {
    throw new AppError(code, `${what} 数据校验失败`, { issues: r.error.issues })
  }
  return r.data
}
