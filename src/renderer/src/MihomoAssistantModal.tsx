import { t } from '../../shared/i18n'
import { ApiOutlined, CheckOutlined, CopyOutlined, DownloadOutlined, GlobalOutlined, LinkOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { Alert, Button, Form, Input, InputNumber, Modal, Radio, Select, Space, Table, Tabs, Tag, Typography, message } from 'antd'
import { useMemo, useState } from 'react'
import type { BrowserProfileView, ProfileDraft, ProxyProtocol } from '../../shared/types'

interface MihomoAssistantModalProps {
  open: boolean
  selectedProfileIds: string[]
  allProfiles: BrowserProfileView[]
  onClose: () => void
  onProfileUpdated: (profile: BrowserProfileView) => void
}

export function MihomoAssistantModal({
  open,
  selectedProfileIds,
  allProfiles,
  onClose,
  onProfileUpdated
}: MihomoAssistantModalProps) {
  const [activeTab, setActiveTab] = useState<'assign' | 'zashboard'>('assign')
  const [scope, setScope] = useState<'all' | 'selected'>(selectedProfileIds.length ? 'selected' : 'all')
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState<number>(17890)
  const [protocol, setProtocol] = useState<ProxyProtocol>('socks5')
  const [prefix, setPrefix] = useState('node-')
  const [password, setPassword] = useState('prism')
  const [namingMode, setNamingMode] = useState<'order' | 'serial'>('order')
  const [copied, setCopied] = useState(false)
  const [applying, setApplying] = useState(false)

  // Zashboard / Controller settings
  const [controllerHost, setControllerHost] = useState('127.0.0.1')
  const [controllerPort, setControllerPort] = useState<number>(9090)
  const [controllerSecret, setControllerSecret] = useState('')
  const [dashboardSource, setDashboardSource] = useState<'jsdelivr' | 'local' | 'zash_online' | 'metacubexd'>('jsdelivr')
  const [iframeKey, setIframeKey] = useState(1)

  const targetProfiles = useMemo(() => {
    return scope === 'all'
      ? allProfiles
      : allProfiles.filter((p) => selectedProfileIds.includes(p.id))
  }, [scope, allProfiles, selectedProfileIds])

  // 计算每个环境分配的用户名
  const assignments = useMemo(() => {
    return targetProfiles.map((profile, index) => {
      const num = namingMode === 'order' ? index + 1 : profile.serialNumber
      const username = `${prefix}${String(num).padStart(4, '0')}`
      return {
        profile,
        username,
        proxyUrl: `${protocol}://${username}:${password}@${host}:${port}`,
        canApply: profile.status === 'closed' || profile.status === 'error'
      }
    })
  }, [targetProfiles, namingMode, prefix, password, protocol, host, port])

  // 生成标准的 Mihomo / Clash 配置文件补丁
  const yamlConfig = useMemo(() => {
    const lines = [
      '# === Prism Browser Mihomo 本地分流配置补丁 ===',
      `mixed-port: ${port}`,
      'allow-lan: false',
      `bind-address: ${host}`,
      `external-controller: ${controllerHost}:${controllerPort}`,
      'external-ui: ui',
      'external-ui-url: "https://github.com/Zephyruso/zashboard/releases/latest/download/dist-cdn-fonts.zip"',
      ...(controllerSecret ? [`secret: "${controllerSecret}"`] : []),
      'users:'
    ]
    assignments.forEach(({ username }) => {
      lines.push(`  - "${username}:${password}"`)
    })
    return lines.join('\n')
  }, [port, host, controllerHost, controllerPort, controllerSecret, password, assignments])

  // 计算 Zashboard / Web UI 的完整访问 URL
  const dashboardUrl = useMemo(() => {
    const secretParam = controllerSecret ? `&secret=${encodeURIComponent(controllerSecret)}` : ''
    if (dashboardSource === 'jsdelivr') {
      return `https://cdn.jsdelivr.net/gh/Zephyruso/zashboard@gh-pages/?host=${controllerHost}&port=${controllerPort}${secretParam}#/proxies`
    }
    if (dashboardSource === 'local') {
      return `http://${controllerHost}:${controllerPort}/ui/?host=${controllerHost}&port=${controllerPort}${secretParam}#/proxies`
    }
    if (dashboardSource === 'zash_online') {
      return `https://board.zash.run/?host=${controllerHost}&port=${controllerPort}${secretParam}#/proxies`
    }
    return `https://metacubex.github.io/metacubexd/?host=${controllerHost}&port=${controllerPort}${secretParam}#/proxies`
  }, [dashboardSource, controllerHost, controllerPort, controllerSecret])

  async function copyYaml(): Promise<void> {
    await navigator.clipboard.writeText(yamlConfig)
    setCopied(true)
    message.success(t("Mihomo 配置已复制到剪贴板"))
    setTimeout(() => setCopied(false), 2000)
  }

  async function copyDashboardUrl(): Promise<void> {
    await navigator.clipboard.writeText(dashboardUrl)
    message.success(t("Dashboard 地址已复制"))
  }

  function openExternalDashboard(): void {
    window.open(dashboardUrl, '_blank')
  }

  async function applyToProfiles(): Promise<void> {
    if (!assignments.length) return
    setApplying(true)
    let successCount = 0
    const errors: string[] = []

    for (const item of assignments) {
      if (!item.canApply) {
        errors.push(`#${item.profile.serialNumber} · ${item.profile.name}：环境运行中，无法修改代理`)
        continue
      }
      try {
        const draft: ProfileDraft = {
          name: item.profile.name,
          note: item.profile.note,
          group: item.profile.group,
          tags: [...item.profile.tags],
          extensionIds: [...item.profile.extensionIds],
          color: item.profile.color,
          startUrls: [...item.profile.startUrls],
          kernelVersion: item.profile.kernelVersion,
          window: { ...item.profile.window },
          fingerprint: { ...item.profile.fingerprint },
          proxy: {
            protocol,
            host,
            port,
            username: item.username,
            password,
            passwordStored: true,
            bypassList: item.profile.proxy?.bypassList || 'localhost;127.0.0.1'
          }
        }
        const saved = await window.browserApi.profiles.update(item.profile.id, draft)
        onProfileUpdated(saved)
        successCount++
      } catch (cause) {
        errors.push(`#${item.profile.serialNumber} · ${item.profile.name}：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }

    setApplying(false)
    if (errors.length) {
      message.warning(t("已为 {0} 个环境应用代理，{1} 个失败或跳过", successCount, errors.length))
    } else {
      message.success(t("已成功为全部 {0} 个环境应用 Mihomo 本地代理", successCount))
    }
  }

  return (
    <Modal
      open={open}
      title={<Space><ApiOutlined />{t("Mihomo 代理分流助手")}</Space>}
      footer={null}
      width={860}
      style={{ top: 20 }}
      onCancel={onClose}
      destroyOnClose
    >
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'assign' | 'zashboard')}
        items={[
          {
            key: 'assign',
            label: <Space><ThunderboltOutlined />{t("凭据池与批量分配")}</Space>,
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={14}>
                <Alert
                  type="info"
                  showIcon
                  description={t("根据环境自动生成统一端口、独立用户名（分流标签）与通用密码的本地凭据。将下方配置复制至本地 Mihomo / Clash 即可生效。")}
                />

                <Form layout="vertical" size="small">
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
                    <Form.Item label={t("目标环境范围")}>
                      <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)}>
                        <Radio value="all">{t("全部环境 ({0} 个)", allProfiles.length)}</Radio>
                        <Radio value="selected" disabled={selectedProfileIds.length === 0}>
                          {t("当前选中 ({0} 个)", selectedProfileIds.length)}
                        </Radio>
                      </Radio.Group>
                    </Form.Item>

                    <Form.Item label={t("编号规则")}>
                      <Radio.Group value={namingMode} onChange={(e) => setNamingMode(e.target.value)}>
                        <Radio value="order">{t("顺序递增 (0001, 0002...)")}</Radio>
                        <Radio value="serial">{t("匹配环境序号 (#01 -> 0001)")}</Radio>
                      </Radio.Group>
                    </Form.Item>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0 12px' }}>
                    <Form.Item label={t("本地监听主机")}>
                      <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" />
                    </Form.Item>

                    <Form.Item label={t("Mihomo 混合端口")}>
                      <InputNumber
                        value={port}
                        min={1024}
                        max={65535}
                        style={{ width: '100%' }}
                        onChange={(val) => setPort(val || 17890)}
                      />
                    </Form.Item>

                    <Form.Item label={t("代理协议")}>
                      <Select
                        value={protocol}
                        options={[
                          { value: 'socks5', label: 'SOCKS5' },
                          { value: 'http', label: 'HTTP' }
                        ]}
                        onChange={setProtocol}
                      />
                    </Form.Item>

                    <Form.Item label={t("账号前缀")}>
                      <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="node-" />
                    </Form.Item>
                  </div>

                  <Form.Item label={t("统一代理密码 (本地回环作为身份标记，无需复杂密码)")}>
                    <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="prism" />
                  </Form.Item>
                </Form>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography.Text strong>{t("Mihomo 配置补丁 (复制至 config.yaml)")}</Typography.Text>
                  <Button
                    type="primary"
                    icon={copied ? <CheckOutlined /> : <CopyOutlined />}
                    onClick={() => void copyYaml()}
                  >
                    {copied ? t("已复制配置") : t("复制 Mihomo 配置")}
                  </Button>
                </div>
                <Input.TextArea
                  value={yamlConfig}
                  readOnly
                  autoSize={{ minRows: 4, maxRows: 7 }}
                  style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }}
                />

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                  <Typography.Text strong>{t("分配预览 ({0} 个环境)", assignments.length)}</Typography.Text>
                  <Button
                    type="primary"
                    danger
                    icon={<ThunderboltOutlined />}
                    loading={applying}
                    disabled={!assignments.length}
                    onClick={() => void applyToProfiles()}
                  >
                    {t("一键批量应用到这 {0} 个环境", assignments.length)}
                  </Button>
                </div>

                <Table
                  dataSource={assignments}
                  rowKey={(item) => item.profile.id}
                  size="small"
                  pagination={{ pageSize: 5 }}
                  columns={[
                    {
                      title: t("环境"),
                      key: 'name',
                      render: (_, item) => (
                        <Space>
                          <Tag>#{String(item.profile.serialNumber).padStart(2, '0')}</Tag>
                          <span>{item.profile.name}</span>
                        </Space>
                      )
                    },
                    {
                      title: t("分配账号"),
                      dataIndex: 'username',
                      key: 'username',
                      render: (username) => <Tag color="blue">{username}</Tag>
                    },
                    {
                      title: t("统一密码"),
                      key: 'password',
                      render: () => <Typography.Text code>{password}</Typography.Text>
                    },
                    {
                      title: t("本地代理"),
                      key: 'endpoint',
                      render: () => <span>{protocol}://{host}:{port}</span>
                    },
                    {
                      title: t("状态"),
                      key: 'status',
                      render: (_, item) => item.canApply ? (
                        <Tag color="green">{t("可更新")}</Tag>
                      ) : (
                        <Tag color="orange">{t("运行中需先关闭")}</Tag>
                      )
                    }
                  ]}
                />
              </Space>
            )
          },
          {
            key: 'zashboard',
            label: <Space><GlobalOutlined />{t("Zashboard 可视化面板")}</Space>,
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={12}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <Space wrap size={10}>
                    <Select
                      size="small"
                      value={dashboardSource}
                      onChange={setDashboardSource}
                      options={[
                        { value: 'jsdelivr', label: 'Zashboard (jsDelivr CDN 直连推荐)' },
                        { value: 'local', label: t("内置 UI (127.0.0.1:9090/ui)") },
                        { value: 'zash_online', label: 'Zashboard 官方托管 (board.zash.run)' },
                        { value: 'metacubexd', label: 'MetaCubeXD 官方托管' }
                      ]}
                      style={{ width: 240 }}
                    />
                    <Input
                      size="small"
                      addonBefore="Host"
                      value={controllerHost}
                      onChange={(e) => setControllerHost(e.target.value)}
                      style={{ width: 140 }}
                    />
                    <InputNumber
                      size="small"
                      addonBefore="Port"
                      value={controllerPort}
                      onChange={(v) => setControllerPort(v || 9090)}
                      style={{ width: 120 }}
                    />
                    <Input
                      size="small"
                      placeholder="Secret (选填)"
                      value={controllerSecret}
                      onChange={(e) => setControllerSecret(e.target.value)}
                      style={{ width: 120 }}
                    />
                  </Space>
                  <Space size={8}>
                    <Button size="small" icon={<ReloadOutlined />} onClick={() => setIframeKey((k) => k + 1)}>
                      {t("刷新面板")}
                    </Button>
                    <Button size="small" icon={<CopyOutlined />} onClick={() => void copyDashboardUrl()}>
                      {t("复制链接")}
                    </Button>
                    <Button size="small" type="primary" icon={<LinkOutlined />} onClick={openExternalDashboard}>
                      {t("新窗口打开")}
                    </Button>
                  </Space>
                </div>

                <div style={{ position: 'relative', width: '100%', height: '520px', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line)' }}>
                  <iframe
                    key={iframeKey}
                    src={dashboardUrl}
                    style={{ width: '100%', height: '100%', border: 'none' }}
                    title="Mihomo Web Dashboard"
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {t("提示：需确保本地 Mihomo 开启了 external-controller。若想本地离线运行面板，可下载发行包解压至 Mihomo 的 ui 目录。")}
                  </Typography.Text>
                  <Button
                    size="small"
                    type="link"
                    icon={<DownloadOutlined />}
                    href="https://github.com/Zephyruso/zashboard/releases/latest/download/dist-cdn-fonts.zip"
                    target="_blank"
                  >
                    {t("下载离线面板 (dist-cdn-fonts.zip)")}
                  </Button>
                </div>
              </Space>
            )
          }
        ]}
      />
    </Modal>
  )
}
