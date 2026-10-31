import { t } from '../../shared/i18n'
import { ApiOutlined, AppstoreOutlined, BookOutlined, CheckOutlined, CopyOutlined, DownloadOutlined, FileTextOutlined, GlobalOutlined, InfoCircleOutlined, LinkOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Collapse, Form, Input, InputNumber, Modal, Radio, Select, Space, Table, Tabs, Tag, Typography, message } from 'antd'
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
  const [activeTab, setActiveTab] = useState<'docs' | 'clients' | 'generator' | 'zashboard'>('docs')
  const [scope, setScope] = useState<'all' | 'selected'>(selectedProfileIds.length ? 'selected' : 'all')
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState<number>(17890)
  const [protocol, setProtocol] = useState<ProxyProtocol>('socks5')
  const [prefix, setPrefix] = useState('node-')
  const [password, setPassword] = useState('prism')
  const [namingMode, setNamingMode] = useState<'order' | 'serial'>('order')
  const [copiedSection, setCopiedSection] = useState<string>('')
  const [applying, setApplying] = useState(false)

  // 简短的启动配置：二进制路径与配置文件路径
  const [mihomoBinaryPath, setMihomoBinaryPath] = useState('/opt/homebrew/bin/mihomo')
  const [mihomoConfigPath, setMihomoConfigPath] = useState('~/Library/Application Support/prism-browser/vault/mihomo/config.yaml')

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
        proxyUrl: `${protocol}://${username}:[REDACTED_PASSWORD]@${host}:${port}`,
        canApply: profile.status === 'closed' || profile.status === 'error'
      }
    })
  }, [targetProfiles, namingMode, prefix, password, protocol, host, port])

  // 生成标准的 Mihomo / Clash 配置文件补丁 (包含 users 与 IN-USER 规则示例)
  const yamlConfig = useMemo(() => {
    const lines = [
      '# === Prism Browser Mihomo 本地多环境分流配置补丁 ===',
      `mixed-port: ${port}`,
      'allow-lan: false',
      `bind-address: ${host}`,
      `external-controller: ${controllerHost}:${controllerPort}`,
      'external-ui: ui',
      'external-ui-url: "https://github.com/Zephyruso/zashboard/releases/latest/download/dist-cdn-fonts.zip"',
      ...(controllerSecret ? [`secret: "${controllerSecret}"`] : []),
      '',
      '# 1. 本地入站用户名凭据池 (作为环境路由标签)',
      'users:'
    ]
    assignments.forEach(({ username }) => {
      lines.push(`  - "${username}:${password}"`)
    })

    lines.push('')
    lines.push('# 2. 根据入站用户名 (IN-USER) 定向分流至指定节点')
    lines.push('rules:')
    if (assignments.length > 0) {
      lines.push(`  - IN-USER,${assignments[0].username},🇺🇸 专线节点-01`)
      if (assignments.length > 1) {
        lines.push(`  - IN-USER,${assignments[1].username},🇯🇵 专线节点-02`)
      }
      lines.push('  # 让特定环境分组（如带有 Pro 标签的环境）走高速出口')
      lines.push('  - IN-USER,node-pro-*,🚀 Pro专线池')
    }
    lines.push('  - MATCH,DIRECT')

    return lines.join('\n')
  }, [port, host, controllerHost, controllerPort, controllerSecret, password, assignments])

  // 动态生成适合 Clash Verge / Flclash / Mihomo Party 的 JavaScript 扩展脚本
  const jsScriptConfig = useMemo(() => {
    const userList = assignments.map(a => `    '${a.username}:${password}'`).join(',\n')
    const ruleList = assignments.slice(0, 3).map((a, i) => `    'IN-USER,${a.username},节点名称-${i + 1}'`).join(',\n')
    return `// 适用于：Clash Verge Rev / Flclash / Mihomo Party 扩展脚本 (Script)
// 原订阅更新时，该脚本自动在内存中合并分流规则，绝不冲掉配置！
function main(config) {
  // 1. 设置本地监听与用户认证
  config['mixed-port'] = ${port};
  config['allow-lan'] = false;
  config['bind-address'] = '${host}';

  // 2. 注入多用户认证标签
  config['users'] = [
${userList || "    'node-0001:prism'"}
  ];

  // 3. 注入 IN-USER 规则（插入至 rules 顶部优先匹配）
  const prismRules = [
${ruleList || "    'IN-USER,node-0001,指定节点'"}
  ];
  config.rules = [...prismRules, ...(config.rules || [])];

  return config;
}`
  }, [assignments, password, port, host])

  // 计算 Zashboard / Web UI 的完整访问 URL
  const dashboardUrl = useMemo(() => {
    const secretParam = controllerSecret ? `&secret=[REDACTED_CREDENTIAL](controllerSecret)}` : ''
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

  async function copyText(text: string, id: string): Promise<void> {
    await navigator.clipboard.writeText(text)
    setCopiedSection(id)
    message.success(t("已复制到剪贴板"))
    setTimeout(() => setCopiedSection(''), 2000)
  }

  async function openLocalDoc(): Promise<void> {
    try {
      const res = await window.browserApi.docs.openPath('docs/mihomo-routing-guide.md')
      if (res.success) {
        message.success(t("已在默认程序中打开本地手册"))
      } else {
        message.info(t("文档位于: {0}", res.path))
      }
    } catch {
      message.error(t("打开失败，请直接查看 docs/mihomo-routing-guide.md"))
    }
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
      title={<Space><ApiOutlined />{t("Mihomo 本地分流方案与助手")}</Space>}
      footer={null}
      width={900}
      style={{ top: 20 }}
      onCancel={onClose}
      destroyOnClose
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t("单核心多环境分流指南、轻量托管参数与可视化 Zashboard 面板")}
        </Typography.Text>
        <Space size={8}>
          <Button size="small" type="primary" ghost icon={<FileTextOutlined />} onClick={() => void openLocalDoc()}>
            {t("打开本地权威手册")}
          </Button>
          <Button size="small" icon={<CopyOutlined />} onClick={() => void copyText('docs/mihomo-routing-guide.md', 'docpath')}>
            {copiedSection === 'docpath' ? t("已复制路径") : t("复制文档路径")}
          </Button>
        </Space>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'docs' | 'clients' | 'generator' | 'zashboard')}
        items={[
          {
            key: 'docs',
            label: <Space><BookOutlined />{t("技术原理解析与分流指南")}</Space>,
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={14}>
                <Alert
                  type="info"
                  showIcon
                  icon={<InfoCircleOutlined />}
                  title={t("为什么需要单核心本地分流？")}
                  description={
                    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                      <p style={{ margin: '4px 0' }}>
                        {t("指纹浏览器多账号防关联的核心是“不同环境必须有不同的出口 IP”。传统做法要么购买大量昂贵的独立静态代理，要么为每个节点开启单独的代理软件，导致内存占用过大且极易混淆。")}
                      </p>
                      <p style={{ margin: '4px 0' }}>
                        {t("Mihomo (Clash.Meta) 原生支持在单一后台进程中，通过用户认证信息进行分流（IN-USER 规则），实现让 Profile A 走节点 1、Profile B (或 Pro 组) 走节点 2，极度节省系统资源。")}
                      </p>
                    </div>
                  }
                />

                <Card size="small" title={t("核心原理解析：Listen Users 本质是“分流路由标签”")}>
                  <Typography.Paragraph style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 8 }}>
                    {t("在 127.0.0.1 本地回环网络中，不需要复杂的密码防破解。我们可以把用户名（Username）直接作为该环境的唯一“路由身份标签”，密码统一填写（如 prism）：")}
                  </Typography.Paragraph>

                  <div style={{ background: 'var(--surface-subtle)', padding: 10, borderRadius: 6, fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace' }}>
                    <div><strong>Profile 代理配置:</strong> socks5://node-0001:prism@127.0.0.1:17890</div>
                    <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                      流量带着 [node-0001] 标签进入 Mihomo 17890 端口 $\rightarrow$ 触发 IN-USER 规则 $\rightarrow$ 精准由对应的物理出口节点送出。
                    </div>
                  </div>
                </Card>

                <Card size="small" title={t("典型分流场景实战：Pro 环境组走指定节点")}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {t("将以下规则片段添加到你的 Mihomo / Clash 配置文件中：")}
                    </Typography.Text>
                    <Button
                      size="small"
                      type="link"
                      icon={copiedSection === 'rules' ? <CheckOutlined /> : <CopyOutlined />}
                      onClick={() => void copyText(
`mixed-port: 17890
allow-lan: false
bind-address: 127.0.0.1

users:
  - "node-0001:prism"
  - "node-0002:prism"
  - "pro-vps1:prism"

rules:
  # 1. 单独指定环境走特定出口
  - IN-USER,node-0001,🇺🇸 专线节点-美国-01
  - IN-USER,node-0002,🇯🇵 专线节点-日本-02
  # 2. 让特定 Pro 分组或业务环境走专用高纯净节点池
  - IN-USER,pro-*,🚀 Pro专线自动选择
  # 3. 兜底
  - MATCH,DIRECT`, 'rules')}
                    >
                      {copiedSection === 'rules' ? t("已复制示例") : t("复制示例 YAML")}
                    </Button>
                  </div>
                  <Input.TextArea
                    readOnly
                    autoSize={{ minRows: 7, maxRows: 10 }}
                    style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }}
                    value={
`mixed-port: 17890
allow-lan: false
bind-address: 127.0.0.1

users:
  - "node-0001:prism"
  - "node-0002:prism"
  - "pro-vps1:prism"

rules:
  # 1. 单独指定环境走特定出口
  - IN-USER,node-0001,🇺🇸 专线节点-美国-01
  - IN-USER,node-0002,🇯🇵 专线节点-日本-02
  # 2. 让特定 Pro 分组或业务环境走专用高纯净节点池
  - IN-USER,pro-*,🚀 Pro专线自动选择
  # 3. 兜底
  - MATCH,DIRECT`
                    }
                  />
                </Card>
              </Space>
            )
          },
          {
            key: 'generator',
            label: <Space><ThunderboltOutlined />{t("轻量启动与凭据配置")}</Space>,
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={14}>
                <Card size="small" title={t("替用户省掉一个启动器：Mihomo 轻量托管参数")}>
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                    {t("日常只用 Shadowrocket 或直连的用户，无需安装复杂的客户端。在此指定核心路径与已有配置，由后台静默拉起子进程，浏览器关闭时自动退出：")}
                  </Typography.Paragraph>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 8 }}>
                    <div>
                      <Typography.Text strong style={{ fontSize: 11 }}>{t("Mihomo 二进制文件路径")}</Typography.Text>
                      <Input
                        size="small"
                        value={mihomoBinaryPath}
                        onChange={(e) => setMihomoBinaryPath(e.target.value)}
                        placeholder="/opt/homebrew/bin/mihomo"
                        style={{ marginTop: 4 }}
                      />
                    </div>
                    <div>
                      <Typography.Text strong style={{ fontSize: 11 }}>{t("使用的配置文件路径 (或订阅)")}</Typography.Text>
                      <Input
                        size="small"
                        value={mihomoConfigPath}
                        onChange={(e) => setMihomoConfigPath(e.target.value)}
                        placeholder="~/Downloads/config.yaml"
                        style={{ marginTop: 4 }}
                      />
                    </div>
                  </div>

                  <div style={{ background: 'var(--surface-subtle)', padding: 8, borderRadius: 6, fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace' }}>
                    <div style={{ color: 'var(--muted)' }}># 后台静默执行命令（自动绑定沙盒运行目录与覆写配置）：</div>
                    <div>{mihomoBinaryPath} -d "~/Library/Application Support/prism-browser/vault/mihomo" -f "{mihomoConfigPath}"</div>
                  </div>
                </Card>

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

                    <Form.Item label={t("Mihomo 端口")}>
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

                  <Form.Item label={t("统一代理密码 (本地回环使用统一密码即可)")}>
                    <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="prism" />
                  </Form.Item>
                </Form>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography.Text strong>{t("Mihomo 配置补丁 (包含 Users 与规则模板)")}</Typography.Text>
                  <Button
                    type="primary"
                    icon={copiedSection === 'yaml' ? <CheckOutlined /> : <CopyOutlined />}
                    onClick={() => void copyText(yamlConfig, 'yaml')}
                  >
                    {copiedSection === 'yaml' ? t("已复制配置") : t("复制 Mihomo 配置")}
                  </Button>
                </div>
                <Input.TextArea
                  value={yamlConfig}
                  readOnly
                  autoSize={{ minRows: 4, maxRows: 7 }}
                  style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }}
                />

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                  <Typography.Text strong>{t("环境代理分配预览 ({0} 个环境)", assignments.length)}</Typography.Text>
                  <Button
                    type="primary"
                    danger
                    icon={<ThunderboltOutlined />}
                    loading={applying}
                    disabled={!assignments.length}
                    onClick={() => void applyToProfiles()}
                  >
                    {t("一键批量应用代理到环境", assignments.length)}
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
                      title: t("分配账号 (分流标识)"),
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
                      title: t("本地端点"),
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
            key: 'clients',
            label: <Space><AppstoreOutlined />{t("客户端覆写模式教程 (Flclash / Verge)")}</Space>,
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={14}>
                <Alert
                  type="success"
                  showIcon
                  title={t("为什么强烈推荐使用“覆写 (Override) / 扩展脚本 (Script)”模式？")}
                  description={
                    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                      {t("机场订阅通常每隔一段时间就会自动更新，如果直接在订阅下载的 YAML 里手写规则，一点击“更新订阅”你的修改就会全部被冲掉！使用覆写或扩展脚本，客户端在内存中将 Prism 规则与机场订阅动态合并，机场随便更新，Prism 分流永久有效！")}
                    </div>
                  }
                />

                <Collapse
                  defaultActiveKey={['flclash', 'verge']}
                  size="small"
                  items={[
                    {
                      key: 'flclash',
                      label: <Typography.Text strong>{t("1. Flclash 覆写配置步骤")}</Typography.Text>,
                      children: (
                        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                          <ol style={{ paddingLeft: 18, margin: '4px 0' }}>
                            <li>{t("打开 Flclash 客户端，点击左侧导航栏的【设置 (Settings)】。")}</li>
                            <li>{t("找到【覆写 (Override)】或【扩展脚本 (Script)】选项。")}</li>
                            <li>{t("新建或编辑覆写配置，推荐选择【JavaScript 脚本】模式（也可选择 YAML Merge）。")}</li>
                            <li>{t("将下方动态生成的 JavaScript 脚本代码贴入编辑器中，保存并开启开关。")}</li>
                            <li>{t("返回主界面刷新配置，即可在 17890 端口上同时生效原订阅节点与 Prism 多环境分流！")}</li>
                          </ol>
                        </div>
                      )
                    },
                    {
                      key: 'verge',
                      label: <Typography.Text strong>{t("2. Clash Verge Rev 覆写配置步骤")}</Typography.Text>,
                      children: (
                        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                          <ol style={{ paddingLeft: 18, margin: '4px 0' }}>
                            <li>{t("打开 Clash Verge Rev，点击左侧【订阅 (Profiles)】。")}</li>
                            <li>{t("在右上角点击【新建】，类型选择【Script (扩展脚本)】，名称填写如 Prism-Override。")}</li>
                            <li>{t("右键新建的脚本点击【编辑】，将下方的 JavaScript 脚本完全覆盖贴入并保存。")}</li>
                            <li>{t("右键该脚本点击【启用 (Enable)】。此时无论原机场订阅如何更新，分流规则均自动置顶生效！")}</li>
                          </ol>
                        </div>
                      )
                    },
                    {
                      key: 'mihomo_party',
                      label: <Typography.Text strong>{t("3. Mihomo Party 覆写配置步骤")}</Typography.Text>,
                      children: (
                        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                          <ol style={{ paddingLeft: 18, margin: '4px 0' }}>
                            <li>{t("进入 Mihomo Party 左侧导航的【覆写 (Overrides)】菜单。")}</li>
                            <li>{t("点击右上角【新建覆写】，类型选择【JavaScript】，命名为 Prism-Split。")}</li>
                            <li>{t("将下方的 JavaScript 代码填入代码框，点击右下角保存并激活生效。")}</li>
                          </ol>
                        </div>
                      )
                    },
                    {
                      key: 'cfw',
                      label: <Typography.Text strong>{t("4. Clash for Windows (CFW) Mixin 模式")}</Typography.Text>,
                      children: (
                        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                          <ol style={{ paddingLeft: 18, margin: '4px 0' }}>
                            <li>{t("进入 CFW 的【Settings】页面，滚动至【Mixin】模块。")}</li>
                            <li>{t("点击【YAML】右侧的【Edit】，贴入第三个 Tab 提供的 YAML 片段。")}</li>
                            <li>{t("返回开启【Mixin】右侧的开关即可。")}</li>
                          </ol>
                        </div>
                      )
                    }
                  ]}
                />

                <Card size="small" title={t("针对你当前环境动态生成的 JavaScript 扩展脚本代码 (一键复制)")}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {t("该脚本会自动将当前 {0} 个环境的 users 凭据与 IN-USER 置顶规则合并至主配置中：", assignments.length)}
                    </Typography.Text>
                    <Button
                      type="primary"
                      size="small"
                      icon={copiedSection === 'jsscript' ? <CheckOutlined /> : <CopyOutlined />}
                      onClick={() => void copyText(jsScriptConfig, 'jsscript')}
                    >
                      {copiedSection === 'jsscript' ? t("已复制 JS 脚本") : t("复制 JS 脚本代码")}
                    </Button>
                  </div>
                  <Input.TextArea
                    readOnly
                    autoSize={{ minRows: 6, maxRows: 10 }}
                    style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }}
                    value={jsScriptConfig}
                  />
                </Card>
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
                    <Button size="small" icon={<CopyOutlined />} onClick={() => void copyText(dashboardUrl, 'dashUrl')}>
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
