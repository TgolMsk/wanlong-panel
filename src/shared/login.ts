import type { AndroidKey } from './script'
import type { Point } from './vision'

export interface AccountSetup {
  status: 'pending' | 'ready'
  instanceIdentity: string | null
  verifiedAt: number | null
}

export interface LoginRequest {
  instanceIndex: number
  /** 新建账号时也由界面生成稳定 id，重复点击不会生成第二个账号。 */
  accountId: string
  /** 账号不存在时必填；已存在时使用原名称。 */
  newAccountName?: string
}

export type LoginPhase =
  'preparing' | 'starting' | 'awaitingLogin' | 'verifying' | 'completed' | 'cancelled' | 'failed'
export interface LoginSession {
  id: string
  instanceIndex: number
  accountId: string
  accountName: string
  phase: LoginPhase
  message: string
  updatedAt: number
  screen?: LoginScreen
}

export interface LoginScreen {
  step: 'phone' | 'code' | 'game' | 'manual'
  phoneMasked?: string
  retryAt?: number
  message: string
}

/** 与传输方式无关；请求编号供面板或后续 HTTP 调用方幂等重试。 */
export type LoginCommand =
  | { requestId: string; action: 'inspect' }
  | { requestId: string; action: 'requestSms'; phone: string; agreementAccepted: boolean }
  | { requestId: string; action: 'submitCode'; code: string }
  | { requestId: string; action: 'resendCode' }

export type LoginInput =
  | { kind: 'tap'; at: Point }
  | { kind: 'swipe'; at: Point; to: Point; durationMs: number }
  | { kind: 'key'; key: AndroidKey }
  | { kind: 'text'; text: string }

export function isLoginActive(phase: LoginPhase): boolean {
  return (
    phase === 'preparing' ||
    phase === 'starting' ||
    phase === 'awaitingLogin' ||
    phase === 'verifying'
  )
}
