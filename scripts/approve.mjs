// npm 11 引入了 install-scripts 白名单：依赖的 postinstall 默认不跑，esbuild / sharp 会缺二进制，
// 必须 `npm install-scripts approve <pkg>` 逐个批准。npm 10 及以下没有这个机制（postinstall 默认就跑），
// 直接调 install-scripts 会报 "Unknown command"。这里按 npm 版本决定要不要批准，两边都能 `npm run setup`。
import { spawnSync } from 'node:child_process'

const isWin = process.platform === 'win32'
// Windows 上 npm 是 npm.cmd，Node 20+ 禁止不带 shell 直接 spawn .cmd，所以统一走 shell。
const npm = (args) =>
  spawnSync('npm', args, { encoding: 'utf8', shell: isWin, stdio: ['ignore', 'pipe', 'inherit'] })

const ver = (npm(['--version']).stdout ?? '').trim()
const major = Number.parseInt(ver.split('.')[0] ?? '0', 10)

if (major >= 11) {
  for (const pkg of ['electron', 'esbuild', 'sharp']) {
    const r = spawnSync('npm', ['install-scripts', 'approve', pkg], {
      shell: isWin,
      stdio: 'inherit'
    })
    if (r.status !== 0) process.exit(r.status ?? 1)
  }
  console.log(`npm ${ver}：已批准 electron / esbuild / sharp 的安装脚本。`)
} else {
  console.log(
    `npm ${ver}：没有 install-scripts 白名单机制，依赖的 postinstall 已在 npm install 时自动执行，无需批准。`
  )
}
