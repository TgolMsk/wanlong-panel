import {
  AI_EFFECTS,
  AI_RISK_LEVELS,
  AI_RISK_LABEL,
  type AiAdvice,
  type AiRiskAssessment
} from '@shared/ai'

export function parseRisk(value: unknown): AiRiskAssessment {
  const o = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const str = (key: string, max = 240): string =>
    typeof o[key] === 'string' ? (o[key] as string).trim().slice(0, max) : ''
  const level = AI_RISK_LEVELS.find((v) => v === o.level) ?? 'unknown'
  const effect = AI_EFFECTS.find((v) => v === o.effect) ?? 'unknown'
  const validHazards =
    Array.isArray(o.hazards) &&
    o.hazards.length <= 20 &&
    o.hazards.every((v) => typeof v === 'string' && v.trim())
  return {
    level: validHazards ? level : 'unknown',
    effect,
    buttonText: str('buttonText', 80),
    dialogText: str('dialogText', 600),
    consequence: str('consequence'),
    reason: str('reason'),
    hazards: validHazards
      ? (o.hazards as string[]).map((v) => v.slice(0, 120))
      : ['缺少有效风险清单']
  }
}

const LOW_EFFECTS = new Set([
  'dismiss',
  'acknowledge',
  'retry_connection',
  'continue_loading',
  'download_update',
  'navigate'
])
export const isLowEffect = (effect: string): boolean => LOW_EFFECTS.has(effect)

/** 独立于模型提示词执行；“low”标签不能覆盖购买、删除等实际操作后果。 */
export function riskRejection(advice: AiAdvice): string | null {
  const risk = advice.risk
  if (!risk) return '模型未提供操作风险评估。'
  if (
    advice.action === 'tap_confirm' &&
    (advice.screen === 'kicked' || advice.screen === 'unknown')
  )
    return '涉及账号登录或界面不明，需要人工处理。'
  if (risk.level !== 'low')
    return `${AI_RISK_LABEL[risk.level] ?? '风险不明'}：${risk.reason || '无法确认点击后果'}。`
  if (!LOW_EFFECTS.has(risk.effect)) return `操作涉及 ${risk.effect}，需要人工处理。`
  if (risk.hazards.length) return `仍存在风险：${risk.hazards.join('；')}。`
  if (!risk.buttonText || !risk.dialogText || !risk.consequence || !risk.reason)
    return '按钮、界面证据或点击后果不完整。'
  if (advice.action === 'tap_confirm' && risk.effect === 'dismiss')
    return '确认动作与关闭/取消的后果描述不一致。'
  if (
    (advice.action === 'tap_close' || advice.action === 'tap_cancel') &&
    risk.effect !== 'dismiss'
  )
    return '关闭/取消动作与后果描述不一致。'
  return null
}
