import { t, translateMessage as mt } from '../../shared/i18n'
import { ApiOutlined, CopyOutlined, LockOutlined, RocketOutlined, SafetyCertificateOutlined, StopOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Modal, Popconfirm, Space, Tabs, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import type { AutomationStartResult, AutomationStatus } from '../../shared/types'

interface AutomationModalProps {
  open: boolean
  status: AutomationStatus | null
  proEnabled: boolean
  onChanged: (status: AutomationStatus) => void
  onClose: () => void
}

export function AutomationModal({ open, status, proEnabled, onChanged, onClose }: AutomationModalProps) {
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) {
      setToken('')
      setError('')
    }
  }, [open])

  async function run(operation: () => Promise<AutomationStatus | AutomationStartResult>, keepToken = false): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const result = await operation()
      onChanged(result)
      setToken(keepToken && 'accessToken' in result ? result.accessToken : '')
    } catch (cause) {
      setError((cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally {
      setBusy(false)
    }
  }

  const running = status?.state === 'running'
  const stateLabel = status?.state === 'running' ? t("运行中")
    : status?.state === 'starting' ? t("启动中")
      : status?.state === 'error' ? t("异常")
        : status?.state === 'unavailable' ? t("不可用") : t("已停止")

  return (
    <Modal
      centered
      open={open}
      width={780}
      title={<Space><ApiOutlined />{t("本地自动化 API")}</Space>}
      footer={null}
      onCancel={onClose}
      className="automation-modal"
      destroyOnHidden
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type={running ? 'success' : 'info'}
          showIcon
          icon={<SafetyCertificateOutlined />}
          title={running ? t("API 已启动，仅当前设备可访问") : t("默认关闭，按需启动")}
          description={t("API 可以创建、批量创建、查询、启动和关闭环境；仅限本机令牌访问。")}
        />

        <div className="automation-status-row">
          <div>
            <Typography.Text type="secondary">{t("状态")}</Typography.Text>
            <div>
              <Tag color={running ? 'green' : status?.state === 'error' ? 'red' : 'default'}>
                {status ? stateLabel : t("正在检查")}
              </Tag>
              {mt(status?.message)}
            </div>
          </div>
        </div>

        {running && status?.endpoint && (
          <div className="automation-credential-box">
            <Typography.Text strong>{t("API 地址")}</Typography.Text>
            <Input value={status.endpoint} readOnly />
            <Typography.Text strong><LockOutlined /> {t("本次访问令牌")}</Typography.Text>
            {token ? (
              <Input.Password
                value={token}
                readOnly
                addonAfter={<Button type="text" size="small" icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(token)}>{t("复制")}</Button>}
              />
            ) : (
              <Typography.Text type="secondary">{t("令牌只在启动成功时显示一次。需要新令牌时请停止并重新启动 API。")}</Typography.Text>
            )}
          </div>
        )}

        {status?.controlledProfileIds.length ? (
          <Typography.Text type="secondary">{t("当前由 API 启动的环境：{0} 个", status.controlledProfileIds.length)}</Typography.Text>
        ) : null}
        {error && <Alert type="error" showIcon title={mt(error)} />}

        <section className="mcp-configuration">
          <Typography.Text strong>{t("创建环境 API")}</Typography.Text>
          <Typography.Paragraph type="secondary">{t("仅需填写要覆盖的参数，其他使用默认值。批量创建每次最多 50 个，全部校验通过后保存。")}</Typography.Paragraph>
          <Tabs
            size="small"
            items={[
              {
                key: 'single',
                label: t("单个创建"),
                children: (
                  <pre className="api-example">
                    {`POST /v1/profiles\nAuthorization: Bearer <token>\nContent-Type: application/json\nIdempotency-Key: project-a-001\n\n` +
                      JSON.stringify({ name: 'Profile A', group: 'Project A', startUrls: ['https://prismbrowser.app/'] }, null, 2)}
                  </pre>
                )
              },
              {
                key: 'batch',
                label: t("批量创建"),
                children: (
                  <pre className="api-example">
                    {`POST /v1/profiles/batch\nAuthorization: Bearer <token>\nContent-Type: application/json\nIdempotency-Key: project-a-batch-001\n\n` +
                      JSON.stringify(
                        {
                          profiles: [
                            { name: 'Profile A' },
                            { name: 'Profile B', proxy: { protocol: 'socks5', host: '127.0.0.1', port: 1080 } }
                          ]
                        },
                        null,
                        2
                      )}
                  </pre>
                )
              }
            ]}
          />
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            {t("重试请使用相同请求标识和内容，24 小时内不会重复创建；重启后仍有效。")}
          </Typography.Paragraph>
        </section>

        <div className="automation-actions">
          {!running ? (
            <Button
              type="primary"
              icon={<RocketOutlined />}
              loading={busy}
              disabled={status?.state === 'starting'}
              onClick={() => void run(() => window.browserApi.automation.start(), true)}
            >
              {t("启动本地 API")}
            </Button>
          ) : (
            <Button loading={busy} onClick={() => void run(() => window.browserApi.automation.stop())}>
              {t("停止 API")}
            </Button>
          )}
          <Popconfirm
            title={t("紧急停止自动化？")}
            description={t("这会停止 API，并关闭本次由 API 启动的浏览器环境。")}
            okText={t("紧急停止")}
            cancelText={t("取消")}
            okButtonProps={{ danger: true }}
            onConfirm={() => run(() => window.browserApi.automation.emergencyStop())}
          >
            <Button danger icon={<StopOutlined />} disabled={!running || busy}>{t("紧急停止")}</Button>
          </Popconfirm>
        </div>
      </Space>
    </Modal>
  )
}
