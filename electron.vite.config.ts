import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // ── 主进程 ────────────────────────────────────────────────────────────────
  // 两个 rollup 入口：index = Electron 主进程；runner = utilityProcess 里跑的脚本执行器。
  // 两者都产出到 out/main/，所以 utilityProcess.fork(join(__dirname,'runner.js')) 能直接找到。
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          runner: resolve(__dirname, 'src/worker/runner.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@vision': resolve('src/vision'),
        '@main': resolve('src/main'),
        '@worker': resolve('src/worker')
      }
    }
  },

  // ── preload ───────────────────────────────────────────────────────────────
  // ★ sandbox:true 要求 preload 是 CommonJS。工程是 "type":"module"，
  //   electron-vite 默认会输出 .mjs，运行时报
  //   "Unable to load preload script ... Cannot use import statement outside a module"，
  //   症状是 window.api === undefined。所以这里强制 cjs + .cjs 后缀。
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },

  // ── 渲染进程 ──────────────────────────────────────────────────────────────
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
