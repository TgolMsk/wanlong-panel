import { CH } from '@shared/ipc'
import { handle } from '@main/ipc'
import type { MainDeps } from './index'

export function registerLoginHandlers(deps: MainDeps): void {
  handle(CH.loginCommand, (id, command) => deps.login.command(id, command))
  handle(CH.loginBegin, (request) => deps.login.begin(request))
  handle(CH.loginSession, (index) => deps.login.session(index))
  handle(CH.loginInput, (id, input) => deps.login.input(id, input))
  handle(CH.loginVerify, (id, confirmed) => deps.login.verify(id, confirmed))
  handle(CH.loginCancel, (id) => deps.login.cancel(id))
}
