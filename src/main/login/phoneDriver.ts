import type { LoginCommand, LoginScreen } from '@shared/login'
import { AppError } from '@shared/errors'
import { key } from '@main/adb/input'
import { byId, clickNode, fillNode, readLoginUi, type NativeNode } from './nativeUi'

export function phoneScreen(nodes: NativeNode[]): LoginScreen {
  if (byId(nodes, 'phoneEditText')) return { step: 'phone', message: '请输入手机号并发送验证码。' }
  if (byId(nodes, 'digitsInput')) {
    const raw = byId(nodes, 'messageText')?.text ?? ''
    const phone = /1\d{10}/.exec(raw)?.[0]
    const seconds = /^(\d+)\s*秒/.exec(byId(nodes, 'resendButton')?.text ?? '')?.[1]
    return {
      step: 'code',
      phoneMasked: phone ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : undefined,
      retryAt: seconds ? Date.now() + Number(seconds) * 1000 : undefined,
      message: '请输入收到的 6 位验证码。填满后游戏会自动校验。'
    }
  }
  if (byId(nodes, 'unitySurfaceView'))
    return {
      step: 'game',
      message: '登录窗口已关闭。等待游戏加载后选择大区与角色，再检查游戏主界面。'
    }
  return { step: 'manual', message: '请在画面中处理当前提示，再刷新登录步骤。' }
}

const missing = (): AppError =>
  new AppError('DEVICE_NOT_READY', '当前页面与操作不符，请刷新登录步骤后重试。')

export interface PhoneDriverIo {
  read: typeof readLoginUi
  fill: typeof fillNode
  click: typeof clickNode
  key: typeof key
}
const defaultIo: PhoneDriverIo = { read: readLoginUi, fill: fillNode, click: clickNode, key }

/** 实测国服 SDK 控件适配；所有定位来自新鲜的 UI 树，不按历史屏幕坐标盲点。 */
export async function executePhoneCommand(
  serial: string,
  command: LoginCommand,
  signal: AbortSignal,
  io: PhoneDriverIo = defaultIo
): Promise<LoginScreen> {
  signal.throwIfAborted()
  let nodes = await io.read(serial)
  signal.throwIfAborted()
  if (command.action === 'inspect') return phoneScreen(nodes)
  if (command.action === 'requestSms') {
    if (!/^1[3-9]\d{9}$/.test(command.phone) || !command.agreementAccepted) {
      throw new AppError(
        'INVALID_ARGUMENT',
        '请填写有效手机号，并确认已阅读游戏用户协议及隐私条款。'
      )
    }
    const field = byId(nodes, 'phoneEditText')
    if (!field) throw missing()
    await io.fill(serial, field, command.phone, signal)
    await io.key(serial, 'BACK') // 收起键盘，再重新定位布局。
    signal.throwIfAborted()
    nodes = await io.read(serial)
    signal.throwIfAborted()
    if (byId(nodes, 'phoneEditText')?.text.replace(/\D/g, '') !== command.phone)
      throw new AppError('DEVICE_NOT_READY', '手机号未完整填入，请刷新后重试。')
    const agreement = byId(nodes, 'agreementCheckBox')
    if (!agreement) throw missing()
    if (!agreement.checked) {
      await io.click(serial, agreement, signal)
      nodes = await io.read(serial)
      signal.throwIfAborted()
    }
    if (!byId(nodes, 'agreementCheckBox')?.checked) throw missing()
    const submit = byId(nodes, 'submitButton')
    if (!submit || submit.text !== '登录') throw missing()
    await io.click(serial, submit, signal)
  } else if (command.action === 'submitCode') {
    if (!/^\d{6}$/.test(command.code))
      throw new AppError('INVALID_ARGUMENT', '验证码应为 6 位数字。')
    const input = byId(nodes, 'digitsInput')
    if (!input) throw missing()
    await io.fill(
      serial,
      { ...input, x: Math.round(input.x - input.width / 2 + input.width / 12) },
      command.code,
      signal
    )
  } else {
    if (!byId(nodes, 'digitsInput')) throw missing()
    const resend = byId(nodes, 'resendButton')
    // 倒计时结束仍须识别按钮文案；未知状态绝不重复发送短信。
    if (!resend || !/重新发送|重新获取|重发/.test(resend.text))
      throw new AppError('DEVICE_NOT_READY', '请等待短信倒计时结束后再重新发送。')
    await io.click(serial, resend, signal)
  }
  nodes = await io.read(serial)
  signal.throwIfAborted()
  return phoneScreen(nodes)
}
