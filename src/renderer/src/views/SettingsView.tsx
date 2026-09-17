/**
 * 设置 + 环境自检 + 设备工具。
 *
 * 这里的每一项默认值都来自实测，改之前先看字段下面的说明：
 *   · 参考分辨率 2560x1440：MuMu 默认实例横屏尺寸，改了会让已有模板全部错位。
 *   · 降采样 2：全屏匹配 87ms -> 22ms，抗混叠余量仍有 0.927（阈值 0.85）。
 *   · 阈值 0.85：正样本 0.975~0.985，负样本 0.452~0.535，0.85 正好落中间。
 *   · 截图间隔 400ms：模拟器 screencap 吞吐硬上限约 4.3 帧/秒，调更小只会排队。
 *   · 并发 4：单实例实测 45.7% CPU + 1.2GB 内存。
 */

import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Col,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Tooltip,
  Typography
} from 'antd'
import {
  FolderOpenOutlined,
  ReloadOutlined,
  SaveOutlined,
  SettingOutlined
} from '@ant-design/icons'
import { defaultSettings } from '@shared/defaults'
import {
  ADB_KEYBOARD_PACKAGE,
  MAX_CONCURRENT_INSTANCES,
  MIN_CAPTURE_INTERVAL_MS
} from '@shared/constants'
import type { AppSettings, ResolvedPaths } from '@shared/domain'
import { isInstanceUp, useAppStore } from '../store/appStore'
import { call, tryCall, toast } from '../ipc/useIpc'
import { AlertSettingsCard } from '../features/alerts'
import { BotTestCard } from '../features/bot'
import HealthBadge from '../components/HealthBadge'
import GlassCard from '../components/GlassCard'
import ThemeToggle from '../components/ThemeToggle'

const PATH_LABELS: Partial<Record<keyof ResolvedPaths, string>> = {
  dataDir: '数据根目录',
  templatesDir: '模板库',
  shotsDir: '截图留痕',
  logsDir: '运行日志',
  accountsDir: '账号配置',
  scriptsDir: '脚本目录',
  resourcesDir: '随包资源'
}

export default function SettingsView(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const paths = useAppStore((s) => s.paths)
  const instances = useAppStore((s) => s.instances)
  const setSettings = useAppStore((s) => s.setSettings)
  const refreshPaths = useAppStore((s) => s.refreshPaths)

  const [form] = Form.useForm<AppSettings>()
  const [saving, setSaving] = useState(false)
  const [imeIndex, setImeIndex] = useState<number | null>(null)
  const [imeBusy, setImeBusy] = useState(false)
  const [apkBusy, setApkBusy] = useState(false)

  useEffect(() => {
    form.setFieldsValue(settings)
  }, [settings, form])

  // 表单里当前选的模拟器种类（还没保存也要即时切换下面两个路径框的文案）。
  const emulator = Form.useWatch('emulator', form) ?? settings.emulator
  const isLd = emulator === 'ldplayer'
  const platform = window.api?.env.platform ?? ''
  const isWin = platform === 'win32'

  const save = async (): Promise<void> => {
    let v: AppSettings
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    setSaving(true)
    try {
      const next = await call('app:saveSettings', v)
      setSettings(next)
      toast().success(
        next.restartRequired ? '设置已保存，设备与目录变更将在重启面板后生效' : '设置已保存'
      )
      await refreshPaths()
    } catch {
      /* 已提示 */
    } finally {
      setSaving(false)
    }
  }

  const pick = async (field: 'adbPath' | 'mumutoolPath'): Promise<void> => {
    const p = await tryCall('app:pickFile', [
      { name: '可执行文件', extensions: isWin ? ['exe'] : ['*'] }
    ])
    if (p) form.setFieldValue(field, p)
  }

  /** 「恢复默认值」：Windows 上默认路径是空串（等主进程探测），别把用户已填好的路径清掉。 */
  const restoreDefaults = (): void => {
    const d = defaultSettings(settings.dataDir, platform)
    form.setFieldsValue({
      ...d,
      adbPath: d.adbPath || settings.adbPath,
      mumutoolPath: d.mumutoolPath || settings.mumutoolPath
    })
    toast().info('已填入默认值，记得点「保存」才会生效')
  }

  const openPath = async (key: keyof ResolvedPaths): Promise<void> => {
    await tryCall('app:openPath', key)
  }

  const setupIme = async (): Promise<void> => {
    if (imeIndex === null) {
      toast().warning('请先选一个实例')
      return
    }
    setImeBusy(true)
    try {
      const ok = await call('device:setupIme', imeIndex)
      if (ok) toast().success(`实例 ${imeIndex} 的中文输入法已就绪`)
      else toast().warning('输入法安装或切换没有成功，请看日志里的 adb 输出')
    } catch {
      /* 已提示 */
    } finally {
      setImeBusy(false)
    }
  }

  const installApk = async (): Promise<void> => {
    if (imeIndex === null) {
      toast().warning('请先选一个实例')
      return
    }
    const apk = await tryCall('app:pickFile', [{ name: 'Android 安装包', extensions: ['apk'] }])
    if (!apk) return
    setApkBusy(true)
    try {
      await call('device:installApk', imeIndex, apk)
      toast().success('APK 安装完成')
    } catch {
      /* 已提示 */
    } finally {
      setApkBusy(false)
    }
  }

  const instanceOptions = instances.map((i) => ({
    value: i.index,
    label: `${i.index} · ${i.name}${i.adb === 'connected' ? '' : '（adb 未连接）'}`,
    disabled: !isInstanceUp(i) || i.adb !== 'connected'
  }))

  return (
    <Row gutter={12}>
      <Col span={14}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type={settings.restartRequired ? 'warning' : 'info'}
            showIcon
            message={settings.restartRequired ? '有设置等待重启生效' : '设备与数据设置在重启后生效'}
            description="模拟器、程序路径、数据目录和参考分辨率会在下次启动时切换。不同模拟器安装各自保存账号、调度和运行记录，共享模板与脚本。"
          />
          <GlassCard
            padding="sm"
            title={
              <Space>
                <SettingOutlined />
                <span>面板设置</span>
              </Space>
            }
            extra={
              <Space>
                <Button onClick={restoreDefaults}>恢复默认值</Button>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={saving}
                  onClick={() => void save()}
                >
                  保存
                </Button>
              </Space>
            }
          >
            <Form form={form} layout="vertical" initialValues={settings}>
              <Divider titlePlacement="start" style={{ margin: '4px 0 12px' }}>
                模拟器与可执行文件路径
              </Divider>

              <Form.Item
                name="emulator"
                label="模拟器"
                extra={
                  isWin
                    ? 'Windows 可选雷电（ldconsole.exe）或 MuMu（MuMuManager.exe）。切换后把下面两个路径清空再保存，面板会按注册表自动探测；也可以手动选文件。'
                    : 'macOS 用 MuMu（mumutool）。切换后下面两个路径要跟着改。'
                }
              >
                <Select
                  options={[
                    {
                      value: 'mumu',
                      label: isWin ? 'MuMu 模拟器（Windows，默认）' : 'MuMu 模拟器（macOS，默认）'
                    },
                    { value: 'ldplayer', label: '雷电模拟器（Windows）' }
                  ]}
                />
              </Form.Item>

              <Form.Item
                label="adb 路径"
                extra={
                  isLd
                    ? '系统 PATH 里通常没有 adb，必须指到雷电自带的那一个（<雷电安装目录>\\adb.exe）。面板启动时会按注册表自动探测。'
                    : isWin
                      ? '必须指到 MuMu 自带的那一个：<MuMu 安装目录>\\nx_main\\adb.exe（MuMu 12 是 \\shell\\adb.exe）。留空保存会按卸载注册表自动探测。'
                      : '系统 PATH 里通常没有 adb，必须指到 MuMu 自带的那一个。'
                }
              >
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item
                    name="adbPath"
                    noStyle
                    rules={[{ required: !isWin, message: '必须填写 adb 路径' }]}
                  >
                    <Input
                      placeholder={
                        isLd
                          ? 'D:\\leidian\\LDPlayer14\\adb.exe'
                          : isWin
                            ? 'D:\\tool\\MuMuPlayer\\nx_main\\adb.exe'
                            : '/Applications/MuMuPlayer.app/.../tools/adb'
                      }
                    />
                  </Form.Item>
                  <Button onClick={() => void pick('adbPath')}>选择文件</Button>
                </Space.Compact>
              </Form.Item>

              <Form.Item
                label={
                  isLd
                    ? '雷电 ldconsole.exe 路径'
                    : isWin
                      ? 'MuMu MuMuManager.exe 路径'
                      : 'mumutool 路径'
                }
                extra={
                  isLd
                    ? '雷电的命令行管理工具，实例的开关机 / 克隆 / 删除 / 改分辨率都靠它，与 adb.exe 在同一目录。'
                    : isWin
                      ? 'MuMu 的命令行管理工具（<MuMu 安装目录>\\nx_main\\MuMuManager.exe），实例的开关机 / 克隆 / 删除 / 改分辨率都靠它，与 adb.exe 在同一目录。留空保存会自动探测。'
                      : 'MuMu 的多实例管理 CLI，实例的开关机 / 克隆 / 删除都靠它。'
                }
              >
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item
                    name="mumutoolPath"
                    noStyle
                    rules={[
                      {
                        required: !isWin,
                        message: isLd
                          ? '必须填写 ldconsole.exe 路径'
                          : isWin
                            ? '必须填写 MuMuManager.exe 路径'
                            : '必须填写 mumutool 路径'
                      }
                    ]}
                  >
                    <Input
                      placeholder={
                        isLd
                          ? 'D:\\leidian\\LDPlayer14\\ldconsole.exe'
                          : isWin
                            ? 'D:\\tool\\MuMuPlayer\\nx_main\\MuMuManager.exe'
                            : '/Applications/MuMuPlayer.app/Contents/MacOS/mumutool'
                      }
                    />
                  </Form.Item>
                  <Button onClick={() => void pick('mumutoolPath')}>选择文件</Button>
                </Space.Compact>
              </Form.Item>

              <Form.Item
                name="dataDir"
                label="数据根目录"
                rules={[{ required: true, message: '请填写数据目录的完整路径' }]}
                extra="重启后使用这个目录。已有目录会读取其中数据，空目录用于新建数据；原目录保留，文件不会自动搬迁。"
              >
                <Input />
              </Form.Item>

              <Divider titlePlacement="start" style={{ margin: '4px 0 12px' }}>
                视觉参数
              </Divider>

              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item
                    name="refWidth"
                    label="参考分辨率宽"
                    extra="改了会让已有模板全部错位，除非你打算重截一遍。"
                  >
                    <InputNumber min={640} max={4096} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="refHeight" label="参考分辨率高">
                    <InputNumber min={360} max={4096} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item
                    name="shrink"
                    label="匹配降采样倍率"
                    extra="2 是实测甜点：全屏匹配 87ms 降到 22ms，判别余量仍充足。"
                  >
                    <InputNumber min={1} max={4} step={1} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="matchThreshold"
                    label="默认命中阈值"
                    extra="低于 0.7 会开始误判，高于 0.95 会漏判。"
                  >
                    <InputNumber min={0.5} max={0.999} step={0.01} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>

              <Divider titlePlacement="start" style={{ margin: '4px 0 12px' }}>
                运行参数
              </Divider>

              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item
                    name="maxConcurrentInstances"
                    label="同时运行实例上限"
                    extra={`默认 ${MAX_CONCURRENT_INSTANCES}。单实例实测 45.7% CPU + 1.2GB 内存，调高前先掂量机器。`}
                  >
                    <InputNumber min={1} max={16} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="minCaptureIntervalMs"
                    label="单实例最小截图间隔（ms）"
                    extra={`低于 ${MIN_CAPTURE_INTERVAL_MS} 没有意义：模拟器 screencap 吞吐上限约 4.3 帧/秒，调小只会排队。`}
                  >
                    <InputNumber min={200} max={5000} step={50} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item
                    name="shotPolicy"
                    label="截图留痕策略"
                    extra="「每步都留痕」很占磁盘，只在排查问题时临时开。"
                  >
                    <Select
                      options={[
                        { value: 'never', label: '不留痕' },
                        { value: 'onFail', label: '仅失败时留痕（推荐）' },
                        { value: 'always', label: '每步都留痕' }
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    name="instancePollIntervalMs"
                    label="实例状态轮询间隔（ms）"
                    extra={`每次轮询会调一次 ${isLd ? 'ldconsole list2' : 'mumutool info all'}，太快没必要。`}
                  >
                    <InputNumber min={1000} max={30000} step={500} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </Row>

              <Form.Item name="locale" label="界面语言">
                <Select disabled options={[{ value: 'zh-CN', label: '简体中文' }]} />
              </Form.Item>
            </Form>
          </GlassCard>

          {/* 异常检测 / 自动暂停 / Telegram 推送。整块由 features/alerts 自带，
            配置存在 <dataDir>/alerts.json，不进 settings.json —— 里面有凭据。 */}
          <AlertSettingsCard />

          {/* AI 顾问的配置与处理记录在侧边栏「AI 处理」页（features/ai/AiView）。 */}

          {/* 机器人动作测试：不方便用手机时，在面板内走同一条 bot:perform 通道验证动作。 */}
          <BotTestCard />
        </Space>
      </Col>

      <Col span={10}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {/* 外观：与顶栏共用同一个 ThemeToggle 组件，切换逻辑只有一份。 */}
          <GlassCard padding="sm" title="外观">
            <Space align="center" size={12}>
              <ThemeToggle />
              <span className="wl-micro">
                默认暗色（靛蓝渐变底 + 薄荷绿强调）。切换会立即生效并记住选择。
              </span>
            </Space>
          </GlassCard>

          <GlassCard padding="sm" title="环境自检">
            <HealthBadge compact={false} />
          </GlassCard>

          <GlassCard padding="sm" title="数据目录">
            {paths ? (
              <Descriptions size="small" column={1} styles={{ label: { width: 90 } }}>
                {(Object.keys(PATH_LABELS) as (keyof ResolvedPaths)[]).map((k) => (
                  <Descriptions.Item key={k} label={PATH_LABELS[k]}>
                    <Space size={4}>
                      <Tooltip title={paths[k]}>
                        <Typography.Text
                          style={{ maxWidth: 210, display: 'inline-block' }}
                          ellipsis
                          copyable={{ text: paths[k] }}
                        >
                          {paths[k]}
                        </Typography.Text>
                      </Tooltip>
                      <Button
                        size="small"
                        type="link"
                        icon={<FolderOpenOutlined />}
                        onClick={() => void openPath(k)}
                      />
                    </Space>
                  </Descriptions.Item>
                ))}
              </Descriptions>
            ) : (
              <Space direction="vertical">
                <Typography.Text type="secondary">还没拿到路径信息。</Typography.Text>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => void refreshPaths()}>
                  重新获取
                </Button>
              </Space>
            )}
          </GlassCard>

          <GlassCard padding="sm" title="设备工具">
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 'var(--wl-space-3)' }}
              message="中文输入必须装 ADBKeyboard"
              description={`adb 自带的 input text 会静默丢弃所有非 ASCII 字符 —— 打 80 个汉字和什么都不打耗时一样。中文只能走 ${ADB_KEYBOARD_PACKAGE} 的 base64 广播。`}
            />
            <Space direction="vertical" style={{ width: '100%' }}>
              <Select
                style={{ width: '100%' }}
                placeholder="选择目标实例"
                value={imeIndex ?? undefined}
                onChange={(v: number) => setImeIndex(v)}
                options={instanceOptions}
                notFoundContent="没有已连接 adb 的实例"
              />
              <Space>
                <Button
                  loading={imeBusy}
                  onClick={() => void setupIme()}
                  disabled={imeIndex === null}
                >
                  安装并启用中文输入法
                </Button>
                <Button
                  loading={apkBusy}
                  onClick={() => void installApk()}
                  disabled={imeIndex === null}
                >
                  安装 APK…
                </Button>
              </Space>
            </Space>
          </GlassCard>
        </Space>
      </Col>
    </Row>
  )
}
