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
      toast().success('设置已保存')
      await refreshPaths()
    } catch {
      /* 已提示 */
    } finally {
      setSaving(false)
    }
  }

  const pick = async (field: 'adbPath' | 'mumutoolPath'): Promise<void> => {
    const p = await tryCall('app:pickFile', [{ name: '可执行文件', extensions: ['*'] }])
    if (p) form.setFieldValue(field, p)
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
                <Button
                  onClick={() => {
                    form.setFieldsValue(defaultSettings(settings.dataDir))
                    toast().info('已填入默认值，记得点「保存」才会生效')
                  }}
                >
                  恢复默认值
                </Button>
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
                可执行文件路径
              </Divider>

              <Form.Item
                label="adb 路径"
                extra="系统 PATH 里通常没有 adb，必须指到 MuMu 自带的那一个。"
              >
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item
                    name="adbPath"
                    noStyle
                    rules={[{ required: true, message: '必须填写 adb 路径' }]}
                  >
                    <Input placeholder="/Applications/MuMuPlayer.app/.../tools/adb" />
                  </Form.Item>
                  <Button onClick={() => void pick('adbPath')}>选择文件</Button>
                </Space.Compact>
              </Form.Item>

              <Form.Item
                label="mumutool 路径"
                extra="MuMu 的多实例管理 CLI，实例的开关机 / 克隆 / 删除都靠它。"
              >
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item
                    name="mumutoolPath"
                    noStyle
                    rules={[{ required: true, message: '必须填写 mumutool 路径' }]}
                  >
                    <Input placeholder="/Applications/MuMuPlayer.app/Contents/MacOS/mumutool" />
                  </Form.Item>
                  <Button onClick={() => void pick('mumutoolPath')}>选择文件</Button>
                </Space.Compact>
              </Form.Item>

              <Form.Item
                name="dataDir"
                label="数据根目录"
                extra="模板、日志、截图、账号都存在这里。由主进程决定，只读。"
              >
                <Input readOnly />
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
                    extra="每次轮询会调一次 mumutool info all，太快没必要。"
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
