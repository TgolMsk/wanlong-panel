/**
 * 「AI 处理」页里折叠起来的接口配置：OpenAI 兼容接口 + 限额 + 视觉能力测试。
 *
 * ★ **总开关不在这里。** enabled 由页面顶部那个 Switch 直接保存（AiView），
 *   本表单的字段里刻意没有它 —— 否则在折叠区点一次「保存」就会把顶部开关按旧值悄悄翻回去，
 *   而且不会有任何报错。
 * ★ 最近问询记录也不在这里：AiView 下半部分就是完整的记录表，同一份数据摆两遍只会让人怀疑哪份是真的。
 * ★ 凭据纪律：主进程给的 AiConfigView 类型上就没有 apiKey；输入框留空 = 不修改；
 *   要清掉得点「清除 Key」按钮。用户新填的 Key 随保存补丁送走后即丢弃。
 * ★ 默认值只有一个权威来源 defaultAiConfig()（@shared/ai）。这里出现的 min/max 是取值范围（AI_RANGE）。
 */

import React, { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch
} from 'antd'
import { ExperimentOutlined, SaveOutlined } from '@ant-design/icons'
import {
  AI_PRESETS,
  AI_RANGE,
  defaultAiConfig,
  toAiConfigView,
  type AiConfigPatch,
  type AiConfigView
} from '@shared/ai'
import GlassCard from '@/components/GlassCard'
import { toast } from '@/ipc/useIpc'
import { useAiStore } from './aiStore'

interface AiFormValues {
  baseUrl: string
  /** 新填的 Key；留空 = 不修改。 */
  apiKey: string
  model: string
  timeoutMs: number
  maxCallsPerHour: number
  cooldownSeconds: number
  imageWidth: number
  minConfidence: number
  refine: boolean
  autoHarvest: boolean
}

function toFormValues(view: AiConfigView): AiFormValues {
  return {
    baseUrl: view.baseUrl,
    apiKey: '',
    model: view.model,
    timeoutMs: view.timeoutMs,
    maxCallsPerHour: view.maxCallsPerHour,
    cooldownSeconds: view.cooldownSeconds,
    imageWidth: view.imageWidth,
    minConfidence: view.minConfidence,
    refine: view.refine,
    autoHarvest: view.autoHarvest
  }
}

function toPatch(v: AiFormValues): AiConfigPatch {
  const key = (v.apiKey ?? '').trim()
  return {
    baseUrl: (v.baseUrl ?? '').trim(),
    model: (v.model ?? '').trim(),
    timeoutMs: v.timeoutMs,
    maxCallsPerHour: v.maxCallsPerHour,
    cooldownSeconds: v.cooldownSeconds,
    imageWidth: v.imageWidth,
    minConfidence: v.minConfidence,
    refine: v.refine,
    autoHarvest: v.autoHarvest,
    ...(key === '' ? {} : { apiKey: key })
  }
}

export default function AiSettingsCard(): React.JSX.Element {
  const configView = useAiStore((s) => s.configView)
  const configFromMain = useAiStore((s) => s.configFromMain)
  const loaded = useAiStore((s) => s.loaded)
  const error = useAiStore((s) => s.error)
  const saving = useAiStore((s) => s.saving)
  const testing = useAiStore((s) => s.testing)
  const testResult = useAiStore((s) => s.testResult)
  const load = useAiStore((s) => s.load)
  const saveConfig = useAiStore((s) => s.saveConfig)
  const test = useAiStore((s) => s.test)
  const clearTestResult = useAiStore((s) => s.clearTestResult)

  const [form] = Form.useForm<AiFormValues>()
  const [dirty, setDirty] = useState(false)

  // 订阅（ai:configChanged / ai:consulted）在 AiView 里做 —— 配置折叠起来时也要继续收推送。
  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!dirty) form.setFieldsValue(toFormValues(configView))
  }, [configView, form, dirty])

  const readForm = async (): Promise<AiFormValues | null> => {
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
      toast().error(`AI 顾问设置保存失败：${err}`)
      return err
    }
    setDirty(false)
    form.setFieldValue('apiKey', '')
    toast().success('AI 顾问设置已保存')
    return null
  }

  const runTest = async (): Promise<void> => {
    // 测试用的是主进程已保存的配置，有未保存的改动先保存。
    if (dirty) {
      const err = await save()
      if (err) return
    }
    clearTestResult()
    const r = await test()
    if (!r) return
    if (r.ok) toast().success('模型能看图，可以启用 AI 顾问。')
    else toast().error(`测试未通过：${r.message}`)
  }

  const clearKey = async (): Promise<void> => {
    const err = await saveConfig({ apiKey: '' })
    if (err) {
      toast().error(`清除 Key 失败：${err}`)
      return
    }
    form.setFieldValue('apiKey', '')
    toast().success('已清除保存的 API Key。')
  }

  const applyPreset = (idx: number): void => {
    const p = AI_PRESETS[idx]
    if (!p) return
    form.setFieldsValue({ baseUrl: p.baseUrl, model: p.models[0] ?? '' })
    setDirty(true)
  }

  const keyPlaceholder = configView.apiKeySet
    ? `已配置 ${configView.apiKeyMasked}（留空表示不修改）`
    : '例如 sk-…（在模型平台的「API Key 管理」里创建）'

  return (
    <GlassCard
      padding="sm"
      title="接口配置"
      extra={
        <Space>
          <Button
            onClick={() => {
              form.setFieldsValue({
                ...toFormValues(toAiConfigView(defaultAiConfig())),
                apiKey: ''
              })
              setDirty(true)
              toast().info('已填入默认值，记得点「保存」才会生效（Key 保持不变）')
            }}
          >
            恢复默认值
          </Button>
          <Button icon={<ExperimentOutlined />} loading={testing} onClick={() => void runTest()}>
            测试连接与视觉能力
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
          message="AI 顾问设置没能读到"
          description={error}
        />
      )}
      {loaded && !error && !configFromMain && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 'var(--wl-space-3)' }}
          message="当前显示的是默认值"
          description="还没有从主进程读到已保存的配置，点「保存」会以这里的值为准写入。"
        />
      )}

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 'var(--wl-space-4)' }}
        message="按点击后果评估风险，低风险确认可自动执行，确认前会重新看图复核"
        description={
          <div className="wla-form-note">
            AI 会结合正文、按钮和点击后果判断风险。低风险的
            <b>关闭、取消、确认更新、重试连接、继续加载、信息确认</b>可自动处理。
            确认动作要求两次判断一致、置信度至少 85%，并在点击前检查画面和前台应用；相同确认 60
            秒内不重复执行。
            购买、消耗资源、删除、账号或权限变更、战斗等操作，以及风险不明的情况会暂停并说明原因。
            已校准的游戏更新仍优先使用本地流程；其它布局可由 AI 评估后确认，再等待加载完成。
            只有关闭按钮会自动学习成模板，确认按钮每次重新评估。处理记录可查看风险等级、理由和复核结果。
            截图会发送到你填写的 AI 接口。
          </div>
        }
      />

      {testResult && (
        <Alert
          type={testResult.ok ? 'success' : 'error'}
          showIcon
          closable
          onClose={clearTestResult}
          style={{ marginBottom: 'var(--wl-space-3)' }}
          message={
            testResult.ok
              ? `✅ 模型「${testResult.model}」支持图片输入（${testResult.latencyMs}ms）`
              : testResult.vision === false
                ? `❌ 模型「${testResult.model}」不支持图片输入`
                : `❌ 连接失败（${testResult.kind ?? '未知'}）`
          }
          description={
            <span className="wla-form-note">
              {testResult.message}
              {testResult.reply ? `（模型原话：${testResult.reply}）` : ''}
            </span>
          }
        />
      )}

      <Form<AiFormValues>
        form={form}
        layout="vertical"
        initialValues={toFormValues(configView)}
        onValuesChange={() => setDirty(true)}
      >
        <Row gutter={12}>
          <Col span={24}>
            <Form.Item
              label="快速填入平台预设"
              extra="只是把接口地址和一个示例模型名填进下面两个框，模型名以平台最新文档为准。"
            >
              <Select
                placeholder="选一个平台…"
                options={AI_PRESETS.map((p, i) => ({
                  value: i,
                  label: `${p.label}（${p.models.join(' / ')}）`
                }))}
                onChange={(v: number) => applyPreset(v)}
                allowClear
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="baseUrl"
          label="接口地址（OpenAI 兼容，填到 /v1 这一层）"
          rules={[{ required: true, message: '必须填写接口地址' }]}
          extra="面板会自己拼 /chat/completions。阿里云百炼：https://dashscope.aliyuncs.com/compatible-mode/v1"
        >
          <Input
            autoComplete="off"
            placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
          />
        </Form.Item>

        <Form.Item
          name="apiKey"
          label="API Key"
          extra="等同于密码：只存本机配置文件，界面上永远只显示后 4 位，不写进日志或错误信息。留空表示不修改已保存的值。"
        >
          <Input.Password autoComplete="off" placeholder={keyPlaceholder} />
        </Form.Item>
        <Form.Item>
          <Space wrap>
            <span className="wl-micro">
              当前：{configView.apiKeySet ? `已配置 ${configView.apiKeyMasked}` : '未配置'}
            </span>
            <Popconfirm
              title="清除已保存的 API Key？"
              description="清掉之后 AI 顾问会立刻停止工作。"
              okText="清除"
              cancelText="取消"
              onConfirm={() => void clearKey()}
            >
              <Button size="small" danger disabled={!configView.apiKeySet}>
                清除 Key
              </Button>
            </Popconfirm>
          </Space>
        </Form.Item>

        <Form.Item
          name="model"
          label="模型名"
          rules={[{ required: true, message: '必须填写模型名' }]}
          extra="必须是支持图片输入的模型（名字里通常带 vl / vision / v，百炼的 qwen3.8-flash 也支持）。填完点上面的「测试连接与视觉能力」，它会发一张合成图让模型认字母。"
        >
          <Input autoComplete="off" placeholder="qwen3.8-flash" />
        </Form.Item>

        <Divider titlePlacement="start" style={{ margin: '4px 0 12px' }}>
          执行与限额
        </Divider>

        <Row gutter={12}>
          <Col span={8}>
            <Form.Item
              name="maxCallsPerHour"
              label="每小时最多问几次"
              extra="所有实例合计；0 = 不限。识别出错反复认不出界面时它是防止烧钱的熔断。"
            >
              <InputNumber
                min={AI_RANGE.maxCallsPerHour[0]}
                max={AI_RANGE.maxCallsPerHour[1]}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="cooldownSeconds" label="同一实例冷却（秒）">
              <InputNumber
                min={AI_RANGE.cooldownSeconds[0]}
                max={AI_RANGE.cooldownSeconds[1]}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="timeoutMs" label="请求超时（ms）">
              <InputNumber
                min={AI_RANGE.timeoutMs[0]}
                max={AI_RANGE.timeoutMs[1]}
                step={1000}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item
              name="imageWidth"
              label="发送截图宽度（px）"
              extra="越大越准也越贵，1280 够看清按钮。"
            >
              <InputNumber
                min={AI_RANGE.imageWidth[0]}
                max={AI_RANGE.imageWidth[1]}
                step={64}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="minConfidence"
              label="最低置信度"
              extra="模型自报置信度低于它的建议不执行。"
            >
              <InputNumber
                min={AI_RANGE.minConfidence[0]}
                max={AI_RANGE.minConfidence[1]}
                step={0.05}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item
              name="refine"
              label="局部放大精定位"
              valuePropName="checked"
              extra="多问一次，裁的模板更贴合。"
            >
              <Switch />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item
              name="autoHarvest"
              label="自学模板"
              valuePropName="checked"
              extra="关掉后只点不学。"
            >
              <Switch />
            </Form.Item>
          </Col>
        </Row>
      </Form>

    </GlassCard>
  )
}
