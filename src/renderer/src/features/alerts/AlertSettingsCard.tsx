/**
 * 设置页里的「异常检测与 Telegram 推送」区块。
 *
 * 三件事：
 *   1. Telegram 推送配置（开关 / Bot Token / Chat ID / 冷却 / 重试 / 超时 / 订阅哪些事件）
 *   2. 一个「测试推送」按钮 —— 填完点一下就知道通不通，失败给的是分好类的中文原因
 *   3. 第一层通用兜底的检测阈值（连续几轮失败触发暂停等）
 *
 * ★★ 凭据纪律（比功能不可用严重得多）：
 *   · 主进程给的 AlertsConfigView **类型上就没有 botToken 这个键**，
 *     面板永远拿不到完整 token，只有打码值（后 4 位）。
 *   · 用户新填的 token 只在这个组件的表单里存在一瞬间，随保存补丁送走后即丢弃，
 *     不写进 store、不写进 localStorage、不打日志。
 *   · Token 输入框留空 = **不修改**（补丁里干脆不带 botToken 这个键）；
 *     要清掉得点「清除 Token」按钮，那才会显式送一个空串。
 *
 * ★ 默认值只有一个权威来源 `defaultAlertsConfig()`（@shared/alerts）。
 *   本文件里**不允许**出现 600 / 2 / 3 这类默认数字字面量 —— 那是当年采集配置
 *   「三份默认值互相打架」的老路。下面出现的 min/max 是**取值范围**，
 *   与 normalizeAlertsConfig() 里的 clamp 一一对应，不是默认值。
 */

import React, { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Space,
  Switch,
  Tooltip,
  Typography
} from 'antd'
import { BellOutlined, QuestionCircleOutlined, SaveOutlined, SendOutlined } from '@ant-design/icons'
import {
  ALERT_HISTORY_LIMIT,
  SUBSCRIBABLE_ALERT_TYPES,
  alertSpec,
  defaultAlertsConfig,
  formatCst,
  pausesInstance,
  toAlertsConfigView,
  validateTelegramConfig,
  type AlertType,
  type AlertsConfigPatch,
  type AlertsConfigView
} from '@shared/alerts'
import GlassCard from '@/components/GlassCard'
import { toast } from '@/ipc/useIpc'
import { useAlertStore } from './alertStore'
import './alerts.css'

/**
 * 取值范围，与 @shared/alerts 的 normalizeAlertsConfig() 里的 clamp 保持一致。
 * ★ 这些是**边界**不是默认值；默认值一律从 defaultAlertsConfig() 来。
 */
const RANGE = {
  cooldownSeconds: [0, 86_400],
  retryCount: [0, 5],
  timeoutMs: [2_000, 120_000],
  threshold: [1, 20],
  stalledMinutes: [5, 1440],
  freezeMinutes: [2, 60],
  freezeRestartLimit: [1, 10],
  freezeRestartWindowMin: [10, 1440]
} as const

/**
 * 只用于**本地体检**的占位 token：用户没有重新输入 token 时，
 * 拿一个形状合法的串顶上，让 validateTelegramConfig 只去挑 Chat ID 的毛病。
 * 它不会被提交，也不会离开这个文件。
 */
const SHAPE_OK_PLACEHOLDER = '00000000:PLACEHOLDER_LOCAL_SHAPE_CHECK_ONLY'

interface AlertFormValues {
  enabled: boolean
  /** 新填的 token；留空表示「不修改」。 */
  botToken: string
  chatId: string
  cooldownSeconds: number
  retryCount: number
  timeoutMs: number
  subscribedTypes: AlertType[]
  remoteControl: boolean
  autoPauseEnabled: boolean
  cycleFailThreshold: number
  recoveryFailThreshold: number
  sampleFailThreshold: number
  stalledMinutes: number
  kickedProbeEnabled: boolean
  freezeRestartEnabled: boolean
  freezeMinutes: number
  freezeRestartLimit: number
  freezeRestartWindowMin: number
}

/** 打码视图 -> 表单值。★ botToken 永远填空串（面板根本拿不到明文）。 */
function toFormValues(view: AlertsConfigView): AlertFormValues {
  return {
    enabled: view.telegram.enabled,
    botToken: '',
    chatId: view.telegram.chatId,
    cooldownSeconds: view.telegram.cooldownSeconds,
    retryCount: view.telegram.retryCount,
    timeoutMs: view.telegram.timeoutMs,
    subscribedTypes: [...view.telegram.subscribedTypes],
    remoteControl: view.telegram.remoteControl,
    autoPauseEnabled: view.detect.autoPauseEnabled,
    cycleFailThreshold: view.detect.cycleFailThreshold,
    recoveryFailThreshold: view.detect.recoveryFailThreshold,
    sampleFailThreshold: view.detect.sampleFailThreshold,
    stalledMinutes: view.detect.stalledMinutes,
    kickedProbeEnabled: view.detect.kickedProbeEnabled,
    freezeRestartEnabled: view.detect.freezeRestartEnabled,
    freezeMinutes: view.detect.freezeMinutes,
    freezeRestartLimit: view.detect.freezeRestartLimit,
    freezeRestartWindowMin: view.detect.freezeRestartWindowMin
  }
}

/** 表单值 -> 保存补丁。★ botToken 只在用户真的输入了东西时才带上。 */
function toPatch(v: AlertFormValues): AlertsConfigPatch {
  const token = (v.botToken ?? '').trim()
  return {
    detect: {
      autoPauseEnabled: v.autoPauseEnabled,
      cycleFailThreshold: v.cycleFailThreshold,
      recoveryFailThreshold: v.recoveryFailThreshold,
      sampleFailThreshold: v.sampleFailThreshold,
      stalledMinutes: v.stalledMinutes,
      kickedProbeEnabled: v.kickedProbeEnabled,
      freezeRestartEnabled: v.freezeRestartEnabled,
      freezeMinutes: v.freezeMinutes,
      freezeRestartLimit: v.freezeRestartLimit,
      freezeRestartWindowMin: v.freezeRestartWindowMin
    },
    telegram: {
      enabled: v.enabled,
      chatId: (v.chatId ?? '').trim(),
      cooldownSeconds: v.cooldownSeconds,
      retryCount: v.retryCount,
      timeoutMs: v.timeoutMs,
      subscribedTypes: v.subscribedTypes ?? [],
      remoteControl: v.remoteControl,
      // 留空 = 不修改：补丁里干脆不出现这个键（mergeAlertsConfig 的三态语义）。
      ...(token === '' ? {} : { botToken: token })
    }
  }
}

/** 保存前的本地体检，省得为了看一句「Token 没填」还去跑一趟网络。 */
function preflight(v: AlertFormValues, view: AlertsConfigView): string[] {
  const typed = (v.botToken ?? '').trim()
  const probe = typed !== '' ? typed : view.telegram.botTokenSet ? SHAPE_OK_PLACEHOLDER : ''
  return validateTelegramConfig({
      remoteControl: v.remoteControl,
    enabled: v.enabled,
    botToken: probe,
    chatId: (v.chatId ?? '').trim(),
    cooldownSeconds: v.cooldownSeconds,
    retryCount: v.retryCount,
    timeoutMs: v.timeoutMs,
    subscribedTypes: v.subscribedTypes ?? []
  })
}

export default function AlertSettingsCard(): React.JSX.Element {
  const configView = useAlertStore((s) => s.configView)
  const configFromMain = useAlertStore((s) => s.configFromMain)
  const loaded = useAlertStore((s) => s.loaded)
  const error = useAlertStore((s) => s.error)
  const saving = useAlertStore((s) => s.saving)
  const testing = useAlertStore((s) => s.testing)
  const testResult = useAlertStore((s) => s.testResult)
  const history = useAlertStore((s) => s.history)
  const load = useAlertStore((s) => s.load)
  const saveConfig = useAlertStore((s) => s.saveConfig)
  const testPush = useAlertStore((s) => s.testPush)
  const clearTestResult = useAlertStore((s) => s.clearTestResult)

  const [form] = Form.useForm<AlertFormValues>()
  const [dirty, setDirty] = useState(false)
  const [problems, setProblems] = useState<string[]>([])

  useEffect(() => {
    void load()
  }, [load])

  // 主进程推来新配置时回填表单。★ 用户正在改（dirty）就不要覆盖他手上的输入。
  useEffect(() => {
    if (!dirty) form.setFieldsValue(toFormValues(configView))
  }, [configView, form, dirty])

  const readForm = async (): Promise<AlertFormValues | null> => {
    try {
      return await form.validateFields()
    } catch {
      return null
    }
  }

  const save = async (): Promise<string | null> => {
    const v = await readForm()
    if (!v) return '表单里还有没填对的项。'
    const err = await saveConfig(toPatch(v))
    if (err) {
      toast().error(`推送设置保存失败：${err}`)
      return err
    }
    setDirty(false)
    setProblems(preflight(v, configView))
    // 保存成功后把输入框里的 token 清掉：它已经落到主进程了，没必要继续留在界面上。
    form.setFieldValue('botToken', '')
    toast().success('推送设置已保存')
    return null
  }

  const test = async (): Promise<void> => {
    const v = await readForm()
    if (!v) return
    const p = preflight(v, configView)
    setProblems(p)
    if (p.length > 0) {
      toast().warning('配置还不完整，先按下面的提示补齐再测。')
      return
    }
    // 「测试推送」用的是**主进程已保存的**配置，所以有未保存的改动时先保存。
    if (dirty) {
      const err = await save()
      if (err) return
    }
    clearTestResult()
    const r = await testPush()
    if (!r) return
    if (r.ok) toast().success('测试推送已发出，去手机上的 Telegram 看一眼。')
    else toast().error(`测试推送失败：${r.message}`)
  }

  const clearToken = async (): Promise<void> => {
    const err = await saveConfig({ telegram: { botToken: '' } })
    if (err) {
      toast().error(`清除 Token 失败：${err}`)
      return
    }
    form.setFieldValue('botToken', '')
    toast().success('已清除保存的 Bot Token。')
  }

  const tokenPlaceholder = configView.telegram.botTokenSet
    ? `已配置 ${configView.telegram.botTokenMasked}（留空表示不修改）`
    : '形如 123456789:AAE…（找 @BotFather 发 /newbot 拿）'

  const recent = history.slice(0, 5)

  return (
    <GlassCard
      padding="sm"
      title={
        <Space>
          <BellOutlined />
          <span>异常检测与 Telegram 推送</span>
        </Space>
      }
      extra={
        <Space>
          <Button
            onClick={() => {
              // 默认值只有一个权威来源；这里过一遍打码视图，形状与主进程给的完全一致。
              form.setFieldsValue({
                ...toFormValues(toAlertsConfigView(defaultAlertsConfig())),
                // 恢复默认值不该顺手把已填的联系方式抹掉：Token 留空 = 不修改。
                chatId: (form.getFieldValue('chatId') as string | undefined) ?? '',
                botToken: ''
              })
              setDirty(true)
              toast().info('已填入默认值，记得点「保存」才会生效（Token 与 Chat ID 保持不变）')
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
      {loaded && error && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 'var(--wl-space-3)' }}
          message="告警设置没能读到"
          description={error}
        />
      )}
      {loaded && !error && !configFromMain && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 'var(--wl-space-3)' }}
          message="当前显示的是默认值"
          description="还没有从主进程读到已保存的告警配置，点「保存」会以这里的值为准写入。"
        />
      )}

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 'var(--wl-space-4)' }}
        message="被顶号、掉线时自动暂停并推送到 Telegram；模拟器卡死则自动重启"
        description={
          <div className="wla-form-note">
            账号在别的设备登录（顶号）、弹了维护/更新公告、模拟器崩了、网络断了 ——
            这些都会让采集卡在一个认不出来的界面上。面板的兜底判定是：
            「未知界面恢复阶梯连续用尽」或「连续多轮采集都失败」就判为需要人工介入，
            <b>关掉这个实例的自动调度</b>（不再排唤醒，不再操作游戏）、留一张现场截图，并推送到
            Telegram。 处理完之后到「群控倒计时」页点那张红卡上的「恢复」。
            <br />
            模拟器<b>卡死</b>（画面长时间纹丝不动、或截图一直超时但进程还在）是另一条路：
            面板会<b>自动重启该实例、重新拉起游戏并接着跑</b>，只推一条通知，不需要人工介入；
            重启失败或一小时内反复卡死才会转成「掉线」暂停。
          </div>
        }
      />

      <Form<AlertFormValues>
        form={form}
        layout="vertical"
        initialValues={toFormValues(configView)}
        onValuesChange={() => setDirty(true)}
      >
        <Divider titlePlacement="start" style={{ margin: '4px 0 12px' }}>
          Telegram 推送
        </Divider>

        <Form.Item
          name="enabled"
          label="开启推送"
          valuePropName="checked"
          extra="关掉之后异常照样检测、照样暂停，只是不往外发消息。"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="remoteControl"
          label="允许手机远程操作"
          valuePropName="checked"
          extra="打开后告警消息下面会带「恢复自动调度」「重启游戏并恢复」「查看状态」按钮，也可以直接发 /status、/resume 0、/relaunch 0 这类命令。只响应上面那个 Chat ID 的会话，其它人发来的一律忽略。"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="botToken"
          label="Bot Token"
          extra={
            <span className="wla-form-note">
              在 Telegram 里搜 <b>@BotFather</b> → 发 <code>/newbot</code> → 按提示起名字，
              它会回一行 <code>123456789:AAE…</code>，<b>只复制冒号连着的那一整串</b>
              （别把前面的「HTTP API:」一起粘进来）。 Token
              等同于密码：面板只在本机配置文件里保存，界面上永远只显示后 4 位，
              也不会写进任何日志或错误信息。留空表示不修改已保存的值。
            </span>
          }
        >
          <Input.Password autoComplete="off" placeholder={tokenPlaceholder} />
        </Form.Item>

        <Form.Item>
          <Space wrap>
            <span className="wl-micro">
              当前：
              {configView.telegram.botTokenSet
                ? `已配置 ${configView.telegram.botTokenMasked}`
                : '未配置'}
            </span>
            <Popconfirm
              title="清除已保存的 Bot Token？"
              description="清掉之后推送会立刻停止工作，需要重新填一个才能恢复。"
              okText="清除"
              cancelText="取消"
              onConfirm={() => void clearToken()}
            >
              <Button size="small" danger disabled={!configView.telegram.botTokenSet}>
                清除 Token
              </Button>
            </Popconfirm>
          </Space>
        </Form.Item>

        <Form.Item
          name="chatId"
          label="Chat ID"
          extra={
            <span className="wla-form-note">
              先给你刚建的机器人随便发一条消息（否则它没权限主动找你）， 然后搜 <b>@userinfobot</b>{' '}
              发一句话，它会回你的数字 id。 推到群里就把机器人拉进群，用 <b>@getidsbot</b> 拿群
              id（群和频道是负数，形如 -1001234567890）。 这里只认数字，@用户名 的写法不支持。
            </span>
          }
        >
          <Input autoComplete="off" placeholder="例如 123456789 或 -1001234567890" />
        </Form.Item>

        <Row gutter={12}>
          <Col span={8}>
            <Form.Item
              name="cooldownSeconds"
              label="同类事件冷却（秒）"
              extra="同一实例同一原因在这段时间内只推一次，避免坏状态下狂轰滥炸。期间被压掉几条会在下次推送里带出来。"
            >
              <InputNumber
                min={RANGE.cooldownSeconds[0]}
                max={RANGE.cooldownSeconds[1]}
                step={60}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="retryCount"
              label="失败重试次数"
              extra="不含首次。Token / Chat ID 配错这类错误不会重试（重试一万次也没用）。"
            >
              <InputNumber
                min={RANGE.retryCount[0]}
                max={RANGE.retryCount[1]}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="timeoutMs"
              label="单次请求超时（ms）"
              extra="国内直连 api.telegram.org 经常连不上，需要代理时把这个调大一点。"
            >
              <InputNumber
                min={RANGE.timeoutMs[0]}
                max={RANGE.timeoutMs[1]}
                step={1000}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="subscribedTypes"
          label="推送哪些事件"
          extra="不勾的事件仍然会被检测、该暂停还是会暂停，只是不往 Telegram 发。"
        >
          <Checkbox.Group style={{ width: '100%' }}>
            <div className="wla-event-list">
              {SUBSCRIBABLE_ALERT_TYPES.map((t) => (
                <div className="wla-event-item" key={t}>
                  <Checkbox value={t}>
                    <span className="wla-event-name">{alertSpec(t).title}</span>
                  </Checkbox>
                  {pausesInstance(t) && <span className="wla-event-pauses">会暂停任务</span>}
                  <Tooltip title={alertSpec(t).summary}>
                    <QuestionCircleOutlined style={{ color: 'var(--wl-text-tertiary)' }} />
                  </Tooltip>
                </div>
              ))}
            </div>
          </Checkbox.Group>
        </Form.Item>

        <Form.Item>
          <Space wrap>
            <Button icon={<SendOutlined />} loading={testing} onClick={() => void test()}>
              测试推送
            </Button>
            <span className="wl-micro">
              用的是<b>已保存</b>的配置；有没保存的改动会先自动保存再测。
            </span>
          </Space>
        </Form.Item>

        {problems.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 'var(--wl-space-3)' }}
            message="配置还不完整"
            description={
              <ul style={{ margin: 0, paddingInlineStart: '1.2em' }}>
                {problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            }
          />
        )}

        {testResult && (
          <Alert
            type={testResult.ok ? 'success' : 'error'}
            showIcon
            closable
            onClose={() => clearTestResult()}
            style={{ marginBottom: 'var(--wl-space-3)' }}
            message={testResult.ok ? '测试推送成功' : '测试推送失败'}
            description={
              <div className="wla-form-note">
                <div>{testResult.message}</div>
                <div className="wl-micro">
                  尝试 {testResult.attempts} 次 · 耗时 {testResult.elapsedMs} ms ·
                  {formatCst(testResult.at)}（北京时间）
                  {testResult.retryAfterSec != null &&
                    ` · 对方要求等待 ${testResult.retryAfterSec} 秒`}
                </div>
              </div>
            }
          />
        )}

        <Divider titlePlacement="start" style={{ margin: '4px 0 12px' }}>
          异常判定阈值
        </Divider>

        <Form.Item
          name="autoPauseEnabled"
          label="判定为异常时自动暂停"
          valuePropName="checked"
          extra="关掉之后只记录告警、只推送，不动自动调度开关（排查期可能想让它继续跑）。"
        >
          <Switch />
        </Form.Item>

        <Row gutter={12}>
          <Col span={8}>
            <Form.Item
              name="cycleFailThreshold"
              label="连续几轮采集失败判异常"
              extra="调小会因为一次偶发的截图超时就误暂停；调大会让坏状态多跑十几分钟。"
            >
              <InputNumber
                min={RANGE.threshold[0]}
                max={RANGE.threshold[1]}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="recoveryFailThreshold"
              label="恢复阶梯连续几次用尽判异常"
              extra="「通用关闭 → BACK → 回家 → 冷启动」全走完还回不到世界地图。这是比普通失败强得多的信号，所以默认比上一项小。"
            >
              <InputNumber
                min={RANGE.threshold[0]}
                max={RANGE.threshold[1]}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="sampleFailThreshold"
              label="连续几次采样失败判掉线"
              extra="连着读不出「部队管理」面板，通常是模拟器关了或 adb 断了。"
            >
              <InputNumber
                min={RANGE.threshold[0]}
                max={RANGE.threshold[1]}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item
              name="stalledMinutes"
              label="多久派不出队算「停摆」（分钟）"
              extra="兵力不够 / 队列一直满 / 搜不到合格资源点。这是提醒，不会暂停任务，自动调度照常继续。"
            >
              <InputNumber
                min={RANGE.stalledMinutes[0]}
                max={RANGE.stalledMinutes[1]}
                step={10}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="kickedProbeEnabled"
              label="尝试精确识别「被顶号」"
              valuePropName="checked"
              extra="对应的界面模板还没采集到，所以现在打开也只是空跑，不会报错、不会影响采集；等补上顶号截图后自动生效。在此之前顶号会被上面的通用兜底接住。"
            >
              <Switch />
            </Form.Item>
          </Col>
        </Row>

        <Divider titlePlacement="start" style={{ margin: '4px 0 12px' }}>
          卡死自动重启
        </Divider>

        <Form.Item
          name="freezeRestartEnabled"
          label="画面长时间不动时自动重启模拟器"
          valuePropName="checked"
          extra="判据是像素级的：健康探针（默认每 3 分钟）和采样截到的图连续一模一样、或截图一直超时但模拟器进程还在，就判定卡死。之后自动重启该实例 → 重连 adb → 用 monkey 拉起游戏 → 等主界面，全程约 3~5 分钟，自动调度接着跑。关掉之后卡死会按原来的「连续采样失败 → 掉线暂停」处理。"
        >
          <Switch />
        </Form.Item>

        <Row gutter={12}>
          <Col span={8}>
            <Form.Item
              name="freezeMinutes"
              label="多久不动判卡死（分钟）"
              extra="至少要跨两次健康探针，所以实际发现时间 ≈ 这个值 + 一个探针间隔。活着的游戏几分钟内不可能一个像素都不变，不必设太大。"
            >
              <InputNumber
                min={RANGE.freezeMinutes[0]}
                max={RANGE.freezeMinutes[1]}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="freezeRestartLimit"
              label="窗口内最多自动重启几次"
              extra="超过就不再重启，改判「模拟器或游戏掉线」暂停并推送。这是防「重启 → 又卡 → 再重启」死循环的熔断。"
            >
              <InputNumber
                min={RANGE.freezeRestartLimit[0]}
                max={RANGE.freezeRestartLimit[1]}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="freezeRestartWindowMin"
              label="统计窗口（分钟）"
              extra="上一项按这个时间窗口滚动计数。"
            >
              <InputNumber
                min={RANGE.freezeRestartWindowMin[0]}
                max={RANGE.freezeRestartWindowMin[1]}
                step={10}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>
      </Form>

      {recent.length > 0 && (
        <>
          <Divider titlePlacement="start" style={{ margin: '4px 0 12px' }}>
            最近告警
          </Divider>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {recent.map((r) => (
              <div key={r.event.id} className="wla-event-item">
                <span className="wl-micro">{formatCst(r.event.at, false)}</span>
                <span className="wla-event-name">
                  实例 #{r.event.instanceIndex}｜{alertSpec(r.event.type).title}
                </span>
                <Tooltip title={r.event.reason}>
                  <Typography.Text
                    type="secondary"
                    style={{ maxWidth: 260, display: 'inline-block' }}
                    ellipsis
                  >
                    {r.event.reason}
                  </Typography.Text>
                </Tooltip>
                <span className="wl-micro">
                  {r.suppressed
                    ? '（冷却期内已去重，未推送）'
                    : r.results.some((x) => x.ok)
                      ? '已推送'
                      : `未推送：${r.results[0]?.message ?? '没有可用通道'}`}
                </span>
              </div>
            ))}
            <span className="wl-micro">
              主进程最多保留 {ALERT_HISTORY_LIMIT} 条历史，重启后清空。
            </span>
          </Space>
        </>
      )}
    </GlassCard>
  )
}
