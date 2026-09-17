import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Input,
  Select,
  Space,
  Spin,
  Steps,
  Typography
} from 'antd'
import { makeId } from '@shared/defaults'
import { isLoginActive, type LoginCommand, type LoginSession } from '@shared/login'
import { call, silentCall, useIpcEvent } from '../ipc/useIpc'
import { useAppStore } from '../store/appStore'
import PreviewPane from './PreviewPane'

interface Props {
  instanceIndices: number[]
  onClose(): void
}

export default function AccountLoginDrawer({ instanceIndices, onClose }: Props): React.JSX.Element {
  const [position, setPosition] = useState(0)
  const [locked, setLocked] = useState(false)
  const instances = useAppStore((s) => s.instances)
  const index = instanceIndices[position]
  const closeRef = useRef<() => Promise<void>>(async () => undefined)
  return (
    <Drawer
      open
      title="账号登录"
      size={1040}
      destroyOnHidden
      maskClosable={false}
      closable={!locked}
      keyboard={!locked}
      onClose={() => void closeRef.current()}
      styles={{ body: { background: 'var(--wl-bg)' } }}
    >
      {instanceIndices.length > 1 && (
        <Space style={{ marginBottom: 18 }}>
          <Typography.Text>本次新建 {instanceIndices.length} 个实例 · 逐个登录</Typography.Text>
          <Select
            value={position}
            disabled={locked}
            style={{ width: 260 }}
            onChange={setPosition}
            options={instanceIndices.map((id, p) => ({
              value: p,
              label: `#${id} ${instances.find((i) => i.index === id)?.name ?? ''}`
            }))}
          />
        </Space>
      )}
      <LoginContent
        key={index}
        index={index}
        setLocked={setLocked}
        closeRef={closeRef}
        onClose={onClose}
        onNext={position < instanceIndices.length - 1 ? () => setPosition(position + 1) : undefined}
      />
    </Drawer>
  )
}

function LoginContent({
  index,
  setLocked,
  closeRef,
  onClose,
  onNext
}: {
  index: number
  setLocked(value: boolean): void
  closeRef: React.RefObject<() => Promise<void>>
  onClose(): void
  onNext?: () => void
}): React.JSX.Element {
  const accounts = useAppStore((s) => s.accounts)
  const instances = useAppStore((s) => s.instances)
  const refreshAccounts = useAppStore((s) => s.refreshAccounts)
  const owner = accounts.find((a) => a.instanceIndex === index)
  const instance = instances.find((i) => i.index === index)
  const [selected, setSelected] = useState(owner?.id ?? '__new')
  const [name, setName] = useState('')
  const newId = useRef(makeId('acc'))
  const [session, setSession] = useState<LoginSession | null>(null)
  const sessionRef = useRef<LoginSession | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [agreement, setAgreement] = useState(false)
  const commandBusy = useRef(false)
  const active = !!session && isLoginActive(session.phase)
  const waiting = session?.phase === 'awaitingLogin'
  const finished = session?.phase === 'completed'
  const preparing = session?.phase === 'preparing' || session?.phase === 'starting'

  function accept(value: LoginSession | null): void {
    if (value && sessionRef.current && value.updatedAt < sessionRef.current.updatedAt) return
    sessionRef.current = value
    setSession(value)
  }
  useIpcEvent('login:changed', (value) => {
    if (value.instanceIndex === index) accept(value)
  })
  useEffect(() => {
    let mounted = true
    void call('login:session', index)
      .then((value) => {
        if (mounted) accept(value)
      })
      .catch(() => {
        if (mounted) setLoadError(true)
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
      const value = sessionRef.current
      if (value && isLoginActive(value.phase))
        void silentCall('login:cancel', value.id).catch(() => undefined)
    }
  }, [index])

  // 登录过程中不可切换实例；关闭按钮由本页等待取消完成后再卸载。
  useEffect(() => {
    setLocked(busy || loading || active)
  }, [busy, loading, active, setLocked])
  closeRef.current = async () => {
    if (busy || loading || session?.phase === 'verifying') return
    setBusy(true)
    try {
      if (session && isLoginActive(session.phase)) await call('login:cancel', session.id)
      onClose()
    } catch {
      /* 保留向导，允许重试结束操作 */
    } finally {
      setBusy(false)
    }
  }

  async function begin(): Promise<void> {
    setBusy(true)
    setConfirmed(false)
    try {
      // 失败后继续使用同一账号，避免启动失败后反复创建记录。
      const accountId =
        session && !finished ? session.accountId : selected === '__new' ? newId.current : selected
      const next = await call('login:begin', {
        instanceIndex: index,
        accountId,
        newAccountName:
          selected === '__new' ? name.trim() || session?.accountName || undefined : undefined
      })
      accept(next)
    } catch {
      /* call 已提示 */
    } finally {
      setBusy(false)
    }
  }
  async function verify(): Promise<void> {
    if (!session) return
    setBusy(true)
    try {
      accept(await call('login:verify', session.id, confirmed))
      await refreshAccounts()
    } catch {
      /* 状态事件会保留失败原因 */
    } finally {
      setBusy(false)
    }
  }

  async function command(input: LoginCommand): Promise<void> {
    if (!session || commandBusy.current) return
    commandBusy.current = true
    setBusy(true)
    if (input.action === 'submitCode') setCode('')
    try {
      accept(await call('login:command', session.id, input))
      if (input.action === 'requestSms') setPhone('')
    } catch {
      /* call 已提示 */
    } finally {
      commandBusy.current = false
      setBusy(false)
    }
  }
  useEffect(() => {
    if (!waiting || session?.screen || commandBusy.current) return
    void command({ requestId: makeId('req'), action: 'inspect' })
  }, [waiting, session?.id])

  return (
    <Space orientation="vertical" size={18} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          #{index} · {instance?.name ?? '实例'}
        </Typography.Title>
        <Typography.Text type="secondary">绑定账号 → 手机号与验证码 → 进入游戏</Typography.Text>
      </div>
      <Steps
        size="small"
        current={finished ? 3 : waiting || session?.phase === 'verifying' ? 2 : preparing ? 1 : 0}
        items={[
          { title: '设置账号' },
          { title: '启动游戏' },
          { title: '登录与检查' },
          { title: '完成' }
        ]}
      />
      {loading ? (
        <Spin description="读取登录状态…" />
      ) : loadError ? (
        <Alert type="error" showIcon title="读取登录状态失败，请关闭后重新打开。" />
      ) : (
        <>
          {!active && !finished && (
            <>
              <Alert
                type="info"
                showIcon
                title="在副本中登录自己的游戏账号"
                description="若副本继承了登录状态，请先在游戏中切换为目标账号。已有角色通常会自动进入游戏。"
              />
              <Space orientation="vertical" style={{ width: '100%' }}>
                <Typography.Text>面板账号</Typography.Text>
                <Select
                  style={{ width: '100%' }}
                  value={selected}
                  disabled={!!session && !finished}
                  onChange={setSelected}
                  options={[
                    ...(!owner ? [{ value: '__new', label: '新建面板账号' }] : []),
                    ...accounts
                      .filter((a) =>
                        owner
                          ? a.id === owner.id
                          : a.instanceIndex === null || a.instanceIndex === index
                      )
                      .map((a) => ({ value: a.id, label: a.name }))
                  ]}
                />
                {selected === '__new' && (
                  <Input
                    value={name}
                    maxLength={100}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="账号备注名，例如：一区·采集号02（无需填写密码）"
                  />
                )}
              </Space>
            </>
          )}
          {session && (
            <Alert
              showIcon
              type={finished ? 'success' : session.phase === 'failed' ? 'error' : 'info'}
              title={session.accountName ? `账号：${session.accountName}` : '账号登录'}
              description={session.message}
            />
          )}
          {preparing && <Spin description="正在准备，首次启动可能需要一两分钟…" />}
          {(waiting || session?.phase === 'verifying') && (
            <>
              <Space wrap>
                <Typography.Text strong>
                  {session.screen?.step === 'code'
                    ? '输入验证码'
                    : session.screen?.step === 'phone'
                      ? '手机号登录'
                      : '等待游戏画面'}
                </Typography.Text>
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() => void command({ requestId: makeId('req'), action: 'inspect' })}
                >
                  刷新登录步骤
                </Button>
              </Space>
              {session.screen?.step === 'phone' && (
                <Space orientation="vertical" style={{ width: '100%' }}>
                  <Input
                    value={phone}
                    maxLength={11}
                    autoComplete="off"
                    inputMode="tel"
                    style={{ maxWidth: 360 }}
                    placeholder="请输入 11 位手机号"
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                  />
                  <Checkbox checked={agreement} onChange={(e) => setAgreement(e.target.checked)}>
                    我已阅读并同意游戏画面中的用户协议与隐私条款
                  </Checkbox>
                  <Button
                    type="primary"
                    loading={busy}
                    disabled={!/^1[3-9]\d{9}$/.test(phone) || !agreement}
                    onClick={() =>
                      void command({
                        requestId: makeId('req'),
                        action: 'requestSms',
                        phone,
                        agreementAccepted: agreement
                      })
                    }
                  >
                    发送验证码
                  </Button>
                </Space>
              )}
              {session.screen?.step === 'code' && (
                <Space wrap>
                  <Typography.Text>{session.screen.phoneMasked ?? '手机'} 的验证码</Typography.Text>
                  <Input.Password
                    value={code}
                    maxLength={6}
                    autoComplete="off"
                    inputMode="numeric"
                    style={{ width: 185 }}
                    placeholder="6 位验证码"
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  />
                  <Button
                    type="primary"
                    loading={busy}
                    disabled={!/^\d{6}$/.test(code)}
                    onClick={() =>
                      void command({ requestId: makeId('req'), action: 'submitCode', code })
                    }
                  >
                    提交验证码
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => void command({ requestId: makeId('req'), action: 'resendCode' })}
                  >
                    重新发送
                  </Button>
                </Space>
              )}
              <Typography.Text type="secondary">
                登录后关闭公告，回到城内或世界地图，再检查登录结果。若出现额外验证，可在下方画面手动处理。
              </Typography.Text>
              <div style={busy ? { pointerEvents: 'none', opacity: 0.7 } : undefined}>
                <PreviewPane
                  key={session.id}
                  instanceIndex={index}
                  loginSessionId={session.id}
                  height={430}
                />
              </div>
              <Checkbox
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmed(e.target.checked)}
              >
                我已确认进入了目标账号的游戏角色
              </Checkbox>
            </>
          )}
          <Space wrap>
            {!active && !finished && (
              <Button
                type="primary"
                loading={busy}
                disabled={selected === '__new' && !name.trim() && !session?.accountName}
                onClick={() => void begin()}
              >
                {session ? '继续登录' : '绑定账号并启动游戏'}
              </Button>
            )}
            {(waiting || session?.phase === 'verifying') && (
              <Button
                type="primary"
                loading={busy}
                disabled={!confirmed}
                onClick={() => void verify()}
              >
                检查登录并启用账号
              </Button>
            )}
            {finished && onNext && (
              <Button type="primary" onClick={onNext}>
                登录下一个实例
              </Button>
            )}
            <Button
              disabled={busy || session?.phase === 'verifying'}
              onClick={() => void closeRef.current()}
            >
              {finished ? '完成' : '稍后继续'}
            </Button>
          </Space>
        </>
      )}
    </Space>
  )
}
