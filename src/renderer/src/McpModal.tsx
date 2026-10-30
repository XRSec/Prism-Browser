import { t, translateMessage as mt } from '../../shared/i18n'
import { CopyOutlined, LockOutlined, RobotOutlined, SafetyCertificateOutlined, StopOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Modal, Popconfirm, Select, Space, Switch, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { BrowserProfileView, McpConnection, McpPolicy, McpProfilePermission, McpStatus } from '../../shared/types'

interface McpModalProps {
  open: boolean
  status: (McpStatus & { policy?: McpPolicy }) | null
  permissions: McpProfilePermission[]
  profiles: BrowserProfileView[]
  proEnabled: boolean
  onStatusChanged: (status: McpStatus) => void
  onPermissionsChanged: (permissions: McpProfilePermission[]) => void
  onClose: () => void
}

function connectionJson(connection: McpConnection): string {
  return JSON.stringify({
    mcpServers: {
      prism: { command: connection.command, args: connection.args, env: connection.env }
    }
  }, null, 2)
}

export function McpModal({ open, status, permissions, profiles, proEnabled, onStatusChanged, onPermissionsChanged, onClose }: McpModalProps) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [configuration, setConfiguration] = useState('')
  const [copied, setCopied] = useState(false)
  const [search, setSearch] = useState('')

  const policy: McpPolicy = status?.policy ?? { enabled: true, defaultAccess: 'deny', allowProfileCreation: false }
  const overrides = useMemo(() => new Map(permissions.map((p) => [p.profileId, p.enabled])), [permissions])
  const enabled = useMemo(
    () => new Set(profiles.filter((p) => policy.enabled && (overrides.get(p.id) ?? policy.defaultAccess === 'allow')).map((p) => p.id)),
    [profiles, policy.enabled, policy.defaultAccess, overrides]
  )
  const visibleProfiles = profiles.filter((p) => `${p.serialNumber} ${p.name} ${p.group}`.toLowerCase().includes(search.toLowerCase()))

  useEffect(() => {
    if (!open) {
      setConfiguration('')
      setError('')
      setCopied(false)
      setBusy('')
    }
  }, [open])

  function humanError(cause: unknown): string {
    return (cause instanceof Error ? cause.message : String(cause))
  }

  async function setPermission(profileId: string, allow: boolean | null): Promise<void> {
    setBusy(profileId)
    setError('')
    try {
      if (allow === null) {
        onPermissionsChanged(await window.browserApi.mcp.setPermission(profileId, false))
      } else {
        onPermissionsChanged(await window.browserApi.mcp.setPermission(profileId, allow))
      }
    } catch (cause) {
      setError(humanError(cause))
    } finally {
      setBusy('')
    }
  }

  async function setPolicy(patch: Partial<McpPolicy>): Promise<void> {
    setBusy('policy')
    setError('')
    try {
      onStatusChanged(await window.browserApi.mcp.setPolicy(patch))
    } catch (cause) {
      setError(humanError(cause))
    } finally {
      setBusy('')
    }
  }

  async function resetPermissions(): Promise<void> {
    setBusy('reset')
    setError('')
    try {
      onPermissionsChanged(await window.browserApi.mcp.resetPermissions())
    } catch (cause) {
      setError(humanError(cause))
    } finally {
      setBusy('')
    }
  }

  async function start(): Promise<void> {
    setBusy('start')
    setError('')
    setCopied(false)
    try {
      const connection = await window.browserApi.mcp.start()
      onStatusChanged(connection)
      setConfiguration(connectionJson(connection))
    } catch (cause) {
      setError(humanError(cause))
    } finally {
      setBusy('')
    }
  }

  async function stop(emergency: boolean): Promise<void> {
    setBusy(emergency ? 'emergency' : 'stop')
    setError('')
    try {
      const next = emergency ? await window.browserApi.mcp.emergencyStop() : await window.browserApi.mcp.stop()
      onStatusChanged(next)
      setConfiguration('')
      setCopied(false)
    } catch (cause) {
      setError(humanError(cause))
    } finally {
      setBusy('')
    }
  }

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(configuration)
    setCopied(true)
  }

  const stateLabel = status?.state === 'running' ? t("AI 已连接")
    : status?.state === 'ready' ? t("等待连接")
      : status?.state === 'error' ? t("异常")
        : t("已停止")
  const active = status?.state === 'running' || status?.state === 'ready'
  const canEmergencyStop = active || Boolean(status?.controlledProfileIds.length)

  return (
    <Modal
      open={open}
      width={920}
      style={{ top: 24 }}
      title={<Space><RobotOutlined />{t("本地 AI · MCP")}</Space>}
      footer={null}
      onCancel={onClose}
      className="mcp-modal"
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Alert
          type={active ? 'success' : 'info'}
          showIcon
          icon={<SafetyCertificateOutlined />}
          title={mt(status?.message) || t("本地 MCP 会话未启动")}
          description={t("AI 只能操作下方授权的环境，可以访问网页、读取内容、点击并填写表单，包括你提供的密码。")}
        />

        <div className="mcp-status-row">
          <Space>
            <Typography.Text type="secondary">{t("状态")}</Typography.Text>
            <Tag color={status?.state === 'running' ? 'green' : status?.state === 'ready' ? 'blue' : 'default'}>{stateLabel}</Tag>
          </Space>
          <Space wrap>
            <Button
              type="primary"
              icon={<RobotOutlined />}
              loading={busy === 'start'}
              disabled={!policy.enabled || Boolean(busy && busy !== 'start') || (!enabled.size && !policy.allowProfileCreation && policy.defaultAccess !== 'allow')}
              onClick={() => void start()}
            >
              {active ? t("复制 MCP 配置") : t("启用 MCP")}
            </Button>
            {active && (
              <Button loading={busy === 'stop'} onClick={() => void stop(false)}>
                {t("停止 MCP")}
              </Button>
            )}
            <Popconfirm
              title={t("紧急停止 AI 控制？")}
              description={t("将断开 MCP，并关闭本次由 MCP 启动的环境。共享的本地自动化 API 也会停止。")}
              okText={t("紧急停止")}
              cancelText={t("取消")}
              okButtonProps={{ danger: true }}
              onConfirm={() => stop(true)}
            >
              <Button danger icon={<StopOutlined />} disabled={!canEmergencyStop || Boolean(busy)}>
                {t("紧急停止")}
              </Button>
            </Popconfirm>
          </Space>
        </div>

        {error && <Alert type="error" showIcon title={mt(error)} closable onClose={() => setError('')} />}

        <section className="mcp-permissions mcp-access-policy">
          <div className="mcp-policy-row">
            <div>
              <strong>{t("MCP 全局开关")}</strong>
              <Typography.Paragraph type="secondary">
                {t("关闭后暂停全部 AI 操作，环境保持打开；重新开启恢复原授权。")}
              </Typography.Paragraph>
            </div>
            <Switch
              aria-label={t("MCP 全局开关")}
              checked={policy.enabled}
              loading={busy === 'policy'}
              disabled={Boolean(busy)}
              onChange={(val) => void setPolicy({ enabled: val })}
            />
          </div>
          <div className="mcp-policy-row">
            <div>
              <strong>{t("环境授权方式")}</strong>
              <Typography.Paragraph type="secondary">
                {t("新建和导入的环境自动跟随；单独设置的环境优先。")}
              </Typography.Paragraph>
            </div>
            <Select
              aria-label={t("环境授权方式")}
              className="mcp-policy-select"
              value={policy.defaultAccess}
              disabled={Boolean(busy)}
              options={[
                { value: 'deny', label: t("逐个授权") },
                { value: 'allow', label: t("全部环境（含新建）") }
              ]}
              onChange={(val) => void setPolicy({ defaultAccess: val })}
            />
          </div>
          <div className="mcp-policy-row">
            <div>
              <strong>{t("允许 AI 创建环境")}</strong>
              <Typography.Paragraph type="secondary">
                {t("支持单个或批量创建，每次最多 50 个；创建后不自动启动。")}
              </Typography.Paragraph>
            </div>
            <Switch
              aria-label={t("允许 AI 创建环境")}
              checked={policy.allowProfileCreation}
              disabled={Boolean(busy)}
              onChange={(val) => void setPolicy({ allowProfileCreation: val })}
            />
          </div>
        </section>

        <section className="mcp-permissions">
          <div className="mcp-section-heading">
            <div>
              <strong>{t("环境单独设置")}</strong>
              <span>{t("已授权 {0} 个环境", enabled.size)}</span>
            </div>
            <Popconfirm
              title={t("恢复全部跟随全局？")}
              description={t("清除单独设置，所有环境跟随全局授权方式。")}
              okText={t("确认")}
              cancelText={t("取消")}
              onConfirm={resetPermissions}
            >
              <Button size="small" disabled={Boolean(busy) || !permissions.length}>
                {t("全部跟随全局")}
              </Button>
            </Popconfirm>
          </div>
          <Input.Search
            aria-label={t("搜索环境")}
            placeholder={t("搜索环境")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
            style={{ marginBottom: 10 }}
          />
          <div className="mcp-profile-list mcp-profile-overrides">
            {visibleProfiles.map((profile) => {
              const allowed = enabled.has(profile.id)
              const override = overrides.get(profile.id)
              return (
                <div className="mcp-profile" key={profile.id}>
                  <span className="profile-color" style={{ background: profile.color }} />
                  <div>
                    <strong>#{profile.serialNumber} · {profile.name}</strong>
                    <small>{profile.group || t("未分组")} · {allowed ? t("允许 AI 控制") : t("禁止 AI 控制")}</small>
                  </div>
                  <Select
                    aria-label={`${t("环境单独设置")} ${profile.name}`}
                    value={override === undefined ? 'inherit' : override ? 'allow' : 'deny'}
                    loading={busy === profile.id}
                    disabled={Boolean(busy)}
                    className="mcp-override-select"
                    options={[
                      { value: 'inherit', label: t("跟随全局") },
                      { value: 'allow', label: t("单独允许") },
                      { value: 'deny', label: t("单独禁止") }
                    ]}
                    onChange={(val) => void setPermission(profile.id, val === 'inherit' ? null : val === 'allow')}
                  />
                </div>
              )
            })}
            {!visibleProfiles.length && (
              <Typography.Text type="secondary">{t("暂无匹配的环境")}</Typography.Text>
            )}
          </div>
        </section>

        {configuration && (
          <section className="mcp-configuration">
            <div className="mcp-section-heading">
              <div>
                <strong><LockOutlined /> {t("MCP 客户端配置")}</strong>
                <span>{t("保存一次即可，Prism 重启后会自动恢复连接")}</span>
              </div>
              <Button icon={<CopyOutlined />} onClick={() => void copy()}>
                {copied ? t("已复制") : t("复制配置")}
              </Button>
            </div>
            <Input.TextArea value={configuration} readOnly autoSize={{ minRows: 7, maxRows: 12 }} spellCheck={false} />
            <Alert type="info" showIcon title={t("首次添加后请按 AI 客户端提示重启")} description={t("之后无需重新复制；AI 使用时会自动连接或启动 Prism 本地服务。")} />
          </section>
        )}
      </Space>
    </Modal>
  )
}
