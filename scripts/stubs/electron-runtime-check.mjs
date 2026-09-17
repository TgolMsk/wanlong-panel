export * from './electron-offline.mjs'
import { EventEmitter } from 'node:events'
import { app } from './electron-offline.mjs'
app.isPackaged = false
app.getAppPath = () => {
  if (!process.env.WL_RUNTIME_CHECK_DIR) throw new Error('Test app directory not configured')
  return process.env.WL_RUNTIME_CHECK_DIR
}

export class MessageChannelMain {
  port1 = { close() {} }
  port2 = { close() {} }
}

export const utilityProcess = {
  fork() {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.postMessage = (msg) => {
      if (msg.type === 'attach') setImmediate(() => child.emit('message', { type: 'attached' }))
      if (msg.type === 'stop' || msg.type === 'shutdown') child.kill()
    }
    let exited = false
    child.kill = () => {
      if (exited) return
      exited = true
      setImmediate(() => child.emit('exit', 0))
    }
    setImmediate(() => child.emit('message', { type: 'ready' }))
    return child
  }
}
