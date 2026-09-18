/**
 * Windows 版 MuMu 驱动（MuMuManager.exe）的离线自检：不碰模拟器，只验证纯函数部分——
 *   · `info -v all` / `info -v N` 的 JSON 解析（真机抄下来的三个实例 + 合成的启动中 / 启动失败 + 空对象 + 垃圾）
 *   · 原样结构 -> MumuInstance 的状态 / 端口 / serial / 分辨率映射
 *   · 成败判定（errcode -200 = 实例不存在 / 其它 errcode / 用法文本 / 非 JSON 且退出码非 0 / 空输出）
 *   · `setting -v all` 分辨率解析（"2560.000000" 这种带小数的字符串）
 *   · setting 参数拼装（分辨率四键 + custom 模式、cpu / memory 换算、布尔、原始键透传、未知键报错）
 *   · 安装目录候选路径与卸载注册表输出解析、控制台工具函数
 *
 *   npm run check:mumu
 */

import { AppError } from '@shared/errors'
import { decodeConsoleText, toSigned32 } from '@main/mumu/console'
import {
  isMumuWinUsageText,
  judgeMumuWinOutput,
  type MumuWinExecResult
} from '@main/mumu/mumuwin/cli'
import { mumuWinPathsOf, parseRegInstallLocations } from '@main/mumu/mumuwin/detect'
import {
  CORNER_CASCADE,
  CORNER_CASCADE_WRAP,
  CORNER_MARGIN,
  CORNER_WINDOW_SIZE,
  cornerWindowRect
} from '@main/mumu/window'
import { buildMumuWinSettingArgs, MUMU_WIN_SETTING_KEYS } from '@main/mumu/mumuwin/index'
import {
  mumuWinRawToInstance,
  parseMumuWinInfo,
  parseMumuWinResolutions
} from '@main/mumu/mumuwin/parse'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function throwsCode(fn: () => unknown, code: string): boolean {
  try {
    fn()
    return false
  } catch (e) {
    return AppError.from(e).code === code
  }
}

function res(stdout: string, code: number | null = 0, stderr = ''): MumuWinExecResult {
  return { stdout, stderr, code, elapsedMs: 1 }
}

// 真机抄录（MuMu 模拟器 6.6.4.0，2026-09-14）：实例 0「已登录」在跑，1 / 2 停机。
const RUNNING_0 = {
  adb_host_ip: '127.0.0.1',
  adb_port: 16384,
  android_version: '15.0',
  created_timestamp: 1789360564667697,
  disk_size_bytes: 3731167714,
  error_code: 0,
  hyperv_enabled: true,
  index: '0',
  info_source: 'rpc',
  is_android_started: true,
  is_main: false,
  is_process_started: true,
  launch_err_code: 0,
  launch_err_msg: '',
  launch_time: 9751,
  main_wnd: '001F08AC',
  name: '已登录',
  pid: 22488,
  player_state: 'start_finished',
  render_wnd: '000E086A',
  vt_enabled: true
}
const STOPPED_1 = {
  android_version: '15.0',
  created_timestamp: 1789386878222692,
  disk_size_bytes: 3771040716,
  error_code: 0,
  hyperv_enabled: true,
  index: '1',
  info_source: 'rpc',
  is_android_started: false,
  is_main: false,
  is_process_started: false,
  name: '基础游戏包'
}
const STOPPED_2 = {
  ...STOPPED_1,
  index: '2',
  name: '基础游戏包-1',
  created_timestamp: 1789386993431637
}
/** 合成：launch 刚返回时的样子（实测 t=4s：process=true android=false state=starting_rom port=16384）。 */
const STARTING_3 = {
  ...RUNNING_0,
  index: '3',
  name: '启动中',
  is_android_started: false,
  player_state: 'starting_rom',
  pid: 777
}
/** 合成：启动失败。 */
const BROKEN_4 = {
  ...STOPPED_1,
  index: '4',
  name: '坏了',
  launch_err_code: 1,
  launch_err_msg: 'vt disabled'
}

const INFO_ALL = { '0': RUNNING_0, '1': STOPPED_1, '2': STOPPED_2 }
const INFO_ALL_TEXT = JSON.stringify(INFO_ALL, null, 2)

// ── 1. info 解析 ─────────────────────────────────────────────────────────

console.log('【一、info 解析】')
{
  const rows = parseMumuWinInfo(INFO_ALL)
  check('三个实例全部解析', rows.length === 3, `得到 ${rows.length} 个`)
  const r0 = rows[0]!
  check(
    'index 字符串 -> 数字 / 名字',
    r0.index === 0 && r0.name === '已登录',
    `${r0.index}「${r0.name}」`
  )
  check(
    '运行中：进程 / Android / 端口 / pid / state',
    r0.processStarted &&
      r0.androidStarted &&
      r0.adbPort === 16384 &&
      r0.pid === 22488 &&
      r0.playerState === 'start_finished'
  )
  check(
    'adb_host_ip / android_version / 磁盘',
    r0.adbHostIp === '127.0.0.1' && r0.androidVersion === '15.0' && r0.diskSizeBytes === 3731167714
  )
  const r1 = rows[1]!
  check(
    '停机实例：没有端口 / pid / player_state 的键 -> null',
    !r1.processStarted && r1.adbPort === null && r1.pid === null && r1.playerState === null
  )
  check('停机实例 launch_err_* 缺省为 0 / 空串', r1.launchErrCode === 0 && r1.launchErrMsg === '')

  // 单实例形状（info -v N）
  const single = parseMumuWinInfo(RUNNING_0)
  check(
    'info -v N 的单对象形状',
    single.length === 1 && single[0]!.index === 0 && single[0]!.adbPort === 16384
  )

  // 键与 index 不一致时以对象里的 index 为准；没有 index 字段时用键
  const noIndex = parseMumuWinInfo({ '7': { name: 'x', is_process_started: false } })
  check('对象里没有 index 时用键当 index', noIndex.length === 1 && noIndex[0]!.index === 7)

  // 乱序 -> 升序
  const unordered = parseMumuWinInfo({ '2': STOPPED_2, '0': RUNNING_0 })
  check('按 index 升序', unordered.map((r) => r.index).join(',') === '0,2')

  check('空对象 -> 零个实例', parseMumuWinInfo({}).length === 0)
  check('不是实例的键被忽略', parseMumuWinInfo({ info_source: 'rpc', '0': RUNNING_0 }).length === 1)
  check(
    '非对象 -> MUMU_BAD_OUTPUT',
    throwsCode(() => parseMumuWinInfo('abc'), 'MUMU_BAD_OUTPUT')
  )
  check(
    'null -> MUMU_BAD_OUTPUT',
    throwsCode(() => parseMumuWinInfo(null), 'MUMU_BAD_OUTPUT')
  )
  check(
    'index 非法 -> MUMU_BAD_OUTPUT',
    throwsCode(() => parseMumuWinInfo({ abc: { index: 'abc', name: 'x' } }), 'MUMU_BAD_OUTPUT')
  )
}

// ── 2. 原样结构 -> MumuInstance ──────────────────────────────────────────

console.log('【二、实例视图映射】')
{
  const [running, stopped] = parseMumuWinInfo(INFO_ALL).map((r) => mumuWinRawToInstance(r))
  check(
    '运行中 -> running / 16384 / 127.0.0.1:16384 / screenReady',
    running!.state === 'running' &&
      running!.adbPort === 16384 &&
      running!.serial === '127.0.0.1:16384' &&
      running!.screenReady &&
      running!.pid === 22488
  )
  check(
    '停机 -> stopped / adbPort null / serial null / pid null',
    stopped!.state === 'stopped' &&
      stopped!.adbPort === null &&
      stopped!.serial === null &&
      stopped!.pid === null &&
      !stopped!.screenReady
  )
  const starting = mumuWinRawToInstance(parseMumuWinInfo(STARTING_3)[0]!)
  check(
    '进程起了但 Android 没好 -> starting，端口已有但 screenReady=false',
    starting.state === 'starting' && starting.adbPort === 16384 && !starting.screenReady
  )
  const broken = mumuWinRawToInstance(parseMumuWinInfo(BROKEN_4)[0]!)
  check(
    'launch_err_code 非 0 且没起来 -> error',
    broken.state === 'error' && broken.adbPort === null
  )
  check(
    '上层字段一律初始值',
    running!.adb === 'disconnected' && running!.accountId === null && running!.runId === null
  )
  const withRes = mumuWinRawToInstance(parseMumuWinInfo(RUNNING_0)[0]!, {
    width: 2560,
    height: 1440,
    dpi: 360
  })
  check('分辨率透传', withRes.resolution?.width === 2560 && withRes.resolution?.dpi === 360)
  check('不给分辨率 -> null', running!.resolution === null)
  const unnamed = mumuWinRawToInstance(
    parseMumuWinInfo({ '5': { index: '5', is_process_started: false } })[0]!
  )
  check('没有名字时给「MuMu 实例 N」', unnamed.name === 'MuMu 实例 5')
}

// ── 3. 成败判定 ──────────────────────────────────────────────────────────

console.log('【三、成败判定】')
{
  const ok = judgeMumuWinOutput(res(INFO_ALL_TEXT), ['info', '-v', 'all'], '列出实例')
  check('info JSON -> 原样返回', typeof ok === 'object' && ok !== null && '0' in (ok as object))
  const okEnvelope = judgeMumuWinOutput(
    res('{\n  "errcode": 0,\n  "errmsg": ""\n}\n'),
    ['control'],
    '启动'
  )
  check('errcode 0 信封 -> 成功', typeof okEnvelope === 'object')
  check(
    '空输出 + 退出码 0 -> null（成功）',
    judgeMumuWinOutput(res(''), ['delete'], '删除') === null
  )
  check(
    'errcode -200 player index not found -> MUMU_INSTANCE_MISSING',
    throwsCode(
      () =>
        judgeMumuWinOutput(
          res('{"errcode": -200, "errmsg": "player index not found", "info_source": "rpc"}', -200),
          ['info', '-v', '99'],
          '读取实例 99'
        ),
      'MUMU_INSTANCE_MISSING'
    )
  )
  check(
    'setting 的 not exists in vms 文案 -> MUMU_INSTANCE_MISSING',
    throwsCode(
      () =>
        judgeMumuWinOutput(
          res('{"errcode": -200, "errmsg": "player index not exists in vms"}', -200),
          ['setting'],
          '读配置'
        ),
      'MUMU_INSTANCE_MISSING'
    )
  )
  check(
    '其它 errcode -> MUMU_API_ERROR',
    throwsCode(
      () =>
        judgeMumuWinOutput(res('{"errcode": -300, "errmsg": "busy"}', -300), ['control'], '启动'),
      'MUMU_API_ERROR'
    )
  )
  const usage =
    '\nOVERVIEW: A utility for control mumu player.\n\nUSAGE: <subcommand>\n\nSUBCOMMANDS:\n  version   Get player version.\n'
  check('用法文本识别', isMumuWinUsageText(usage))
  check('JSON 不当成用法文本', !isMumuWinUsageText(INFO_ALL_TEXT))
  check(
    '用法文本（命令拼错，退出码 -1）-> MUMU_CLI_USAGE',
    throwsCode(() => judgeMumuWinOutput(res(usage, -1), ['frobnicate'], '测试'), 'MUMU_CLI_USAGE')
  )
  check(
    '非 JSON 且退出码非 0 -> MUMU_API_ERROR',
    throwsCode(
      () => judgeMumuWinOutput(res('something broke', 1), ['clone'], '克隆实例'),
      'MUMU_API_ERROR'
    )
  )
  check(
    '非 JSON 但退出码 0 -> 成功（null）',
    judgeMumuWinOutput(res('done'), ['rename'], '改名') === null
  )
  let msg = ''
  try {
    judgeMumuWinOutput(
      res('{"errcode": -200, "errmsg": "player index not found"}', -200),
      ['info'],
      '读取实例 99'
    )
  } catch (e) {
    msg = AppError.from(e).message
  }
  check(
    '错误信息带动作名与原文',
    msg.includes('读取实例 99') && msg.includes('player index not found'),
    msg
  )
}

// ── 4. 分辨率解析 ────────────────────────────────────────────────────────

console.log('【四、setting 分辨率解析】')
{
  const keyed = parseMumuWinResolutions({
    '0': {
      player_name: '已登录',
      resolution_dpi: '360.000000',
      resolution_height: '1440.000000',
      resolution_width: '2560.000000'
    },
    '1': {
      resolution_dpi: '280.000000',
      resolution_height: '1080.000000',
      resolution_width: '1920.000000'
    }
  })
  check(
    '按 index 键解析、带小数的字符串取整',
    keyed.get(0)?.width === 2560 && keyed.get(0)?.height === 1440 && keyed.get(0)?.dpi === 360
  )
  check('第二个实例', keyed.get(1)?.width === 1920 && keyed.get(1)?.dpi === 280)
  const flat = parseMumuWinResolutions(
    {
      resolution_dpi: '360.000000',
      resolution_height: '1440.000000',
      resolution_width: '2560.000000'
    },
    0
  )
  check('单实例扁平对象 + singleIndex', flat.get(0)?.width === 2560)
  check(
    '扁平对象但没给 singleIndex -> 空',
    parseMumuWinResolutions({ resolution_width: '2560.000000', resolution_height: '1440.000000' })
      .size === 0
  )
  check('errcode 信封 -> 空', parseMumuWinResolutions({ errcode: -200, errmsg: 'x' }).size === 0)
  check(
    '缺高度 -> 该实例跳过',
    parseMumuWinResolutions({ '0': { resolution_width: '2560.000000' } }).size === 0
  )
  check(
    '非对象 -> 空',
    parseMumuWinResolutions('x').size === 0 && parseMumuWinResolutions(null).size === 0
  )
}

// ── 5. setting 参数 ──────────────────────────────────────────────────────

console.log('【五、setting 参数拼装】')
{
  const args = buildMumuWinSettingArgs({ resolution: '2560,1440,360' })
  check(
    '分辨率 -> custom 模式 + 三个 .custom 键',
    args.join(' ') ===
      '-k resolution_mode -val custom -k resolution_width.custom -val 2560 -k resolution_height.custom -val 1440 -k resolution_dpi.custom -val 360',
    args.join(' ')
  )
  check(
    '分辨率对象写法',
    buildMumuWinSettingArgs({ resolution: { width: 1920, height: 1080, dpi: 280 } })
      .join(' ')
      .includes('resolution_width.custom -val 1920')
  )
  check(
    '分辨率 "2560x1440@360" 写法',
    buildMumuWinSettingArgs({ resolution: '2560x1440@360' })
      .join(' ')
      .includes('resolution_dpi.custom -val 360')
  )
  check(
    '分辨率非法',
    throwsCode(() => buildMumuWinSettingArgs({ resolution: '2560,1440' }), 'INVALID_ARGUMENT')
  )
  const perf = buildMumuWinSettingArgs({ cpu: 4, memory: 4096 })
  check(
    'cpu + memory：performance_mode 只出现一次，内存 MB -> GB',
    perf.filter((a) => a === 'performance_mode').length === 1 &&
      perf.join(' ').includes('performance_cpu.custom -val 4') &&
      perf.join(' ').includes('performance_mem.custom -val 4.000000'),
    perf.join(' ')
  )
  check(
    'memory 6144 -> 6.000000',
    buildMumuWinSettingArgs({ memory: 6144 }).join(' ').includes('6.000000')
  )
  check(
    'cpu 非法',
    throwsCode(() => buildMumuWinSettingArgs({ cpu: 0 }), 'INVALID_ARGUMENT')
  )
  check(
    'memory 太小',
    throwsCode(() => buildMumuWinSettingArgs({ memory: 100 }), 'INVALID_ARGUMENT')
  )
  const bools = buildMumuWinSettingArgs({ root: true, autorotate: 0, lockwindow: 'true' })
  check(
    '布尔 -> "true"/"false" 字符串',
    bools.join(' ') ===
      '-k root_permission -val true -k window_auto_rotate -val false -k window_size_fixed -val true',
    bools.join(' ')
  )
  check(
    '布尔非法',
    throwsCode(() => buildMumuWinSettingArgs({ root: 'yes' }), 'INVALID_ARGUMENT')
  )
  check(
    '字符串键映射到 phone_*',
    buildMumuWinSettingArgs({ manufacturer: 'Xiaomi', model: '12', imei: '864039045198424' }).join(
      ' '
    ) === '-k phone_brand -val Xiaomi -k phone_model -val 12 -k phone_imei -val 864039045198424'
  )
  check(
    '字符串空值非法',
    throwsCode(() => buildMumuWinSettingArgs({ model: '' }), 'INVALID_ARGUMENT')
  )
  const raw = buildMumuWinSettingArgs({
    performance_mode: 'high',
    'gpu_model.custom': 'Adreno (TM) 740',
    show_frame_rate: true,
    max_frame_rate: 60
  })
  check(
    '原始键透传（字符串 / 布尔 / 数字）',
    raw.join(' ') ===
      '-k performance_mode -val high -k gpu_model.custom -val Adreno (TM) 740 -k show_frame_rate -val true -k max_frame_rate -val 60',
    raw.join(' ')
  )
  check(
    '未知键报错',
    throwsCode(() => buildMumuWinSettingArgs({ vmCpuCount: 4 }), 'INVALID_ARGUMENT')
  )
  check(
    '大写 / 带空格的键不当原始键',
    throwsCode(() => buildMumuWinSettingArgs({ 'Performance Mode': 'x' }), 'INVALID_ARGUMENT')
  )
  check(
    '空配置报错',
    throwsCode(() => buildMumuWinSettingArgs({}), 'INVALID_ARGUMENT')
  )
  check(
    '友好键与雷电同名',
    ['resolution', 'cpu', 'memory', 'root', 'autorotate', 'lockwindow'].every(
      (k) => k in MUMU_WIN_SETTING_KEYS
    )
  )
}

// ── 6. 探测与控制台工具 ──────────────────────────────────────────────────

console.log('【六、安装目录候选与控制台工具】')
{
  const cands = mumuWinPathsOf('D:\\tool\\MuMuPlayer\\')
  check(
    '安装目录 -> nx_main / shell / 本身 三个候选',
    cands.length === 3 &&
      cands[0]!.cliPath === 'D:\\tool\\MuMuPlayer\\nx_main\\MuMuManager.exe' &&
      cands[1]!.adbPath === 'D:\\tool\\MuMuPlayer\\shell\\adb.exe' &&
      cands[2]!.binDir === 'D:\\tool\\MuMuPlayer',
    cands.map((c) => c.cliPath).join(' | ')
  )
  const regText =
    '\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MuMuPlayer\n' +
    '    InstallLocation    REG_SZ    D:\\tool\\MuMuPlayer\\\n\n'
  check(
    '卸载注册表输出解析（去尾部反斜杠）',
    parseRegInstallLocations(regText).join() === 'D:\\tool\\MuMuPlayer'
  )
  check(
    '带引号的 REG_EXPAND_SZ',
    parseRegInstallLocations(
      '    InstallLocation    REG_EXPAND_SZ    "C:\\Program Files\\Netease\\MuMuPlayer"'
    ).join() === 'C:\\Program Files\\Netease\\MuMuPlayer'
  )
  check(
    '无关输出 -> 空',
    parseRegInstallLocations(
      'ERROR: The system was unable to find the specified registry key or value.'
    ).length === 0
  )
  check(
    '退出码 -200 的无符号换算',
    toSigned32(4294967096) === -200 && toSigned32(0) === 0 && toSigned32(3) === 3
  )
  check(
    'UTF-8 的「已登录」原样解码',
    decodeConsoleText(Buffer.from('"name": "已登录"', 'utf8')) === '"name": "已登录"'
  )
  check('空缓冲', decodeConsoleText(Buffer.alloc(0)) === '')
}

console.log('【七、缩到角落的位置计算】')
{
  // 1920x1080 全屏、任务栏 40px：可用区 1920x1040。
  const area = { x: 0, y: 0, width: 1920, height: 1040 }
  const r0 = cornerWindowRect(0, area)
  check(
    '实例 0 贴右下角',
    r0.x === 1920 - CORNER_WINDOW_SIZE.width - CORNER_MARGIN &&
      r0.y === 1040 - CORNER_WINDOW_SIZE.height - CORNER_MARGIN,
    `(${r0.x}, ${r0.y})`
  )
  check('尺寸就是请求的小窗尺寸', r0.width === 480 && r0.height === 270)

  const r1 = cornerWindowRect(1, area)
  check(
    '实例 1 往左上错开一格',
    r1.x === r0.x - CORNER_CASCADE && r1.y === r0.y - CORNER_CASCADE,
    `(${r1.x}, ${r1.y})`
  )
  check(
    '错开 WRAP 次之后绕回原点（实例多了也不会一路铺到屏幕中间）',
    cornerWindowRect(CORNER_CASCADE_WRAP, area).x === r0.x
  )

  // 多显示器：workArea 的原点不是 (0,0)，位置要跟着平移。
  const second = { x: 1920, y: 0, width: 2560, height: 1400 }
  const rs = cornerWindowRect(0, second)
  check(
    '副屏上按该屏的可用区算，不是绝对 0,0',
    rs.x === 1920 + 2560 - 480 - CORNER_MARGIN && rs.y === 1400 - 270 - CORNER_MARGIN,
    `(${rs.x}, ${rs.y})`
  )

  // 极端小屏：绝不把窗口摆到可用区外面（用户会以为「点了没反应」）。
  const tiny = { x: 100, y: 50, width: 320, height: 200 }
  const rt = cornerWindowRect(3, tiny)
  check('屏幕比小窗还小时夹回可用区左上角', rt.x === 100 && rt.y === 50, `(${rt.x}, ${rt.y})`)

  check('负数 index 不会算出负偏移', cornerWindowRect(-5, area).x === r0.x)
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
if (fail > 0) process.exitCode = 1
