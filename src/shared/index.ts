/**
 * shared 层的统一出口。
 *
 * 四端（main / worker / preload / renderer）都从 '@shared' 或 '@shared/xxx' 导入。
 * 本目录下不允许出现任何有副作用的模块（不得 import electron / node:fs / sharp / opencv）。
 */

export * from './constants'
export * from './defaults'
export * from './domain'
export * from './errors'
export * from './ipc'
export * from './schemas'
export * from './script'
export * from './vision'
export * from './worker'
