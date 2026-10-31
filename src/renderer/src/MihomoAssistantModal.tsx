import {
  AppstoreOutlined,
  BookOutlined,
  CheckOutlined,
  CopyOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SaveOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import { Alert, Button, Card, Collapse, Form, Input, InputNumber, Modal, Select, Space, Tabs, Tag, Typography, message } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { BrowserProfileView, MihomoStatus } from '../../shared/types'

interface MihomoAssistantModalProps {
  open: boolean
  selectedProfileIds?: string[]
  allProfiles?: BrowserProfileView[]
  onClose: () => void
  onProfileUpdated?: (profile: BrowserProfileView) => void
}

export function MihomoAssistantModal({
  open,
  allProfiles = [],
  onClose
}: MihomoAssistantModalProps) {
  const [activeTab, setActiveTab] = useState<'generator' | 'clients' | 'zashboard' | 'docs'>('generator')
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState<number>(17890)
  const [prefix, setPrefix] = useState('node-')
  const [password, setPassword] = useState('prism')
  const [userCount, setUserCount] = useState<number>(() => Math.max(allProfiles.length || 0, 10))
  const [copiedSection, setCopiedSection] = useState<string>('')

  // 二进制路径与配置文件路径
  const [mihomoBinaryPath, setMihomoBinaryPath] = useState('/opt/homebrew/bin/mihomo')
  const [mihomoConfigPath, setMihomoConfigPath] = useState('~/Library/Application Support/prism-browser/vault/mihomo/config.yaml')

  // Zashboard / Controller settings
  const [externalController, setExternalController] = useState('127.0.0.1:9090')
  const [controllerSecret, setControllerSecret] = useState('')
  const [dashboardSource, setDashboardSource] = useState<'local' | 'zash_online' | 'metacubexd'>('local')
  const [iframeKey, setIframeKey] = useState(1)

  const { controllerHost, controllerPort, normalizedControllerAddress } = useMemo(() => {
    const raw = externalController.trim() || '127.0.0.1:9090'
    if (/^\d+$/.test(raw)) {
      return { controllerHost: '127.0.0.1', controllerPort: Number(raw), normalizedControllerAddress: `127.0.0.1:${raw}` }
    }
    if (raw.startsWith(':')) {
      return { controllerHost: '127.0.0.1', controllerPort: Number(raw.slice(1)) || 9090, normalizedControllerAddress: `127.0.0.1${raw}` }
    }
    const idx = raw.lastIndexOf(':')
    if (idx !== -1) {
      const h = raw.slice(0, idx).trim() || '127.0.0.1'
      const p = Number(raw.slice(idx + 1).trim()) || 9090
      return { controllerHost: h, controllerPort: p, normalizedControllerAddress: `${h}:${p}` }
    }
    return { controllerHost: raw, controllerPort: 9090, normalizedControllerAddress: `${raw}:9090` }
  }, [externalController])

  // Mihomo 后台轻量托管进程控制状态
  const [mihomoStatus, setMihomoStatus] = useState<MihomoStatus | null>(null)
  const [isStartingMihomo, setIsStartingMihomo] = useState(false)
  const [isStoppingMihomo, setIsStoppingMihomo] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [liveLogs, setLiveLogs] = useState<string[]>([])
  const [isConfigLoaded, setIsConfigLoaded] = useState(false)

  useEffect(() => {
    if (!open) {
      setIsConfigLoaded(false)
      return
    }

    // 1. 获取运行状态并从配置文件回显所有参数
    window.browserApi.mihomo
      .getStatus()
      .then(async (status) => {
        setMihomoStatus(status)
        if (status.binaryPath) setMihomoBinaryPath(status.binaryPath)
        const configPathToUse = status.configPath || mihomoConfigPath
        if (status.configPath) setMihomoConfigPath(status.configPath)
        setLiveLogs(status.recentLogs || [])

        // 2. 真实读取磁盘配置文件中的内容，回显用户的 externalController、port、users 等
        try {
          const parsed = await window.browserApi.mihomo.readConfig(configPathToUse)
          if (parsed.externalController) setExternalController(parsed.externalController)
          if (parsed.port) setPort(parsed.port)
          if (parsed.secret !== undefined) setControllerSecret(parsed.secret)
          if (parsed.userCount) setUserCount(parsed.userCount)
          if (parsed.prefix) setPrefix(parsed.prefix)
          if (parsed.password) setPassword(parsed.password)
        } catch {
          // ignore
        } finally {
          setIsConfigLoaded(true)
        }
      })
      .catch(() => {
        setIsConfigLoaded(true)
      })

    const unsubscribe = window.browserApi.mihomo.onStatusChanged((status) => {
      setMihomoStatus(status)
      if (status.binaryPath) setMihomoBinaryPath(status.binaryPath)
      if (status.configPath) setMihomoConfigPath(status.configPath)
      setLiveLogs(status.recentLogs || [])
    })

    return () => unsubscribe()
  }, [open])

  // 生成用户名凭据池
  const usersList = useMemo(() => {
    const list: string[] = []
    const count = Math.max(1, Math.min(userCount || 10, 500))
    for (let i = 1; i <= count; i++) {
      const username = `${prefix}${String(i).padStart(4, '0')}`
      list.push(username)
    }
    return list
  }, [userCount, prefix])

  // 生成标准的 Mihomo / Clash 配置文件补丁 (包含 users 与 IN-USER 规则示例)
  const yamlConfig = useMemo(() => {
    const lines = [
      '# === Prism Browser Mihomo 本地多环境分流配置 ===',
      `mixed-port: ${port}`,
      'allow-lan: false',
      `bind-address: ${host}`,
      `external-controller: ${normalizedControllerAddress}`,
      'external-ui: ui',
      'external-ui-url: "https://github.com/Zephyruso/zashboard/releases/latest/download/dist-cdn-fonts.zip"',
      ...(controllerSecret ? [`secret: "${controllerSecret}"`] : []),
      '',
      '# 1. 本地入站用户名凭据池 (环境分流路由标签)',
      'users:'
    ]
    usersList.forEach((username) => {
      lines.push(`  - "${username}:${password}"`)
    })

    lines.push('')
    lines.push('# 2. 根据入站用户名 (IN-USER) 定向分流至指定节点')
    lines.push('# 说明：单机独立运行默认出口为 DIRECT；若配合机场订阅使用，可将 DIRECT 替换为真实节点或策略组名称')
    lines.push('rules:')
    if (usersList.length > 0) {
      lines.push(`  - IN-USER,${usersList[0]},DIRECT`)
      if (usersList.length > 1) {
        lines.push(`  - IN-USER,${usersList[1]},DIRECT`)
      }
      lines.push('  # 示例: 让特定环境分组（如带有 Pro 标签的环境）走专用节点/策略组 (替换 DIRECT)')
      lines.push('  # - IN-USER,node-pro-*,🚀 Pro专线池')
    }
    lines.push('  - MATCH,DIRECT')

    return lines.join('\n')
  }, [port, host, normalizedControllerAddress, controllerSecret, password, usersList])

  // 动态生成适合 Clash Verge / Flclash / Mihomo Party 的 JavaScript 扩展脚本
  const jsScriptConfig = useMemo(() => {
    const userList = usersList.map((u) => `    '${u}:${password}'`).join(',\n')
    const ruleList = usersList.slice(0, 3).map((u, i) => `    'IN-USER,${u},DIRECT'`).join(',\n')
    return `// 适用于：Clash Verge Rev / Flclash / Mihomo Party 扩展脚本 (Script)
function main(config) {
  // 1. 设置本地入站端口与外部控制器
  config['mixed-port'] = ${port};
  config['allow-lan'] = false;
  config['bind-address'] = '${host}';
  config['external-controller'] = '${normalizedControllerAddress}';

  // 2. 注入 Prism 环境 User 认证池 (环境路由标签)
  config['users'] = [
${userList || "    'node-0001:prism'"}
  ];

  // 3. 注入 IN-USER 规则（插入至 rules 顶部优先匹配，请将 DIRECT 替换为机场节点名）
  const prismRules = [
${ruleList || "    'IN-USER,node-0001,DIRECT'"}
  ];
  config.rules = [...prismRules, ...(config.rules || [])];

  return config;
}`
  }, [usersList, password, port, host, normalizedControllerAddress])

  // 监听分流配置参数变化，当使用金库内置配置时，自动静默同步写入到 config.yaml
  // 关键保护：必须在 isConfigLoaded 为 true 后才允许触发自动保存，避免组件初次挂载时用默认值冲掉磁盘！
  useEffect(() => {
    if (!open || !isConfigLoaded) return
    const isVaultConfig = !mihomoConfigPath || mihomoConfigPath.includes('vault/mihomo')
    if (isVaultConfig && yamlConfig) {
      const timer = setTimeout(() => {
        window.browserApi.mihomo.saveConfig(yamlConfig, mihomoConfigPath).catch(() => undefined)
      }, 400)
      return () => clearTimeout(timer)
    }
  }, [open, isConfigLoaded, yamlConfig, mihomoConfigPath])

  // 计算 Zashboard / Web UI 的完整访问 URL
  const dashboardUrl = useMemo(() => {
    const secretParam = controllerSecret ? "&secret=" + encodeURIComponent(controllerSecret) : ""
    const query = `hostname=${controllerHost}&host=${controllerHost}&port=${controllerPort}&protocol=http${secretParam}`
    if (dashboardSource === "local") {
      return `http://${controllerHost}:${controllerPort}/ui/#/setup?${query}`
    }
    if (dashboardSource === "zash_online") {
      return `https://board.zash.run.place/#/setup?${query}`
    }
    return `https://metacubex.github.io/metacubexd/#/setup?${query}`
  }, [dashboardSource, controllerHost, controllerPort, controllerSecret])

  async function copyText(text: string, id: string): Promise<void> {
    await navigator.clipboard.writeText(text)
    setCopiedSection(id)
    message.success('已复制到剪贴板')
    setTimeout(() => setCopiedSection(''), 2000)
  }

  async function openLocalDoc(): Promise<void> {
    try {
      const res = await window.browserApi.docs.openPath('docs/mihomo-routing-guide.md')
      if (res.success) {
        message.success('已在默认查看器中打开本地手册')
      } else {
        message.info(`文档位于: ${res.path}`)
      }
    } catch {
      message.error('打开失败，请直接查看 docs/mihomo-routing-guide.md')
    }
  }

  async function openDocFolder(): Promise<void> {
    try {
      const res = await window.browserApi.docs.showInFolder('docs/mihomo-routing-guide.md')
      if (res.success) {
        message.success('已在访达 (Finder) 中打开文档目录')
      } else {
        message.info(`目录位于: ${res.path}`)
      }
    } catch {
      message.error('定位目录失败')
    }
  }

  const handleSelectBinary = async () => {
    try {
      const selected = await window.browserApi.mihomo.selectFile('binary')
      if (selected) {
        setMihomoBinaryPath(selected)
      }
    } catch (err) {
      message.error(String(err))
    }
  }

  const handleSelectConfig = async () => {
    try {
      const selected = await window.browserApi.mihomo.selectFile('config')
      if (selected) {
        setMihomoConfigPath(selected)
        try {
          const parsed = await window.browserApi.mihomo.readConfig(selected)
          if (parsed.externalController) setExternalController(parsed.externalController)
          if (parsed.port) setPort(parsed.port)
          if (parsed.secret !== undefined) setControllerSecret(parsed.secret)
          if (parsed.userCount) setUserCount(parsed.userCount)
          if (parsed.prefix) setPrefix(parsed.prefix)
          if (parsed.password) setPassword(parsed.password)
        } catch {
          // ignore
        }
      }
    } catch (err) {
      message.error(String(err))
    }
  }

  const handleStartMihomo = async () => {
    setIsStartingMihomo(true)
    try {
      // 启动前确保最新分流配置已同步写入配置文件
      const isVaultConfig = !mihomoConfigPath || mihomoConfigPath.includes('vault/mihomo')
      let targetPath = mihomoConfigPath
      if (isVaultConfig) {
        targetPath = await window.browserApi.mihomo.saveConfig(yamlConfig, mihomoConfigPath)
        setMihomoConfigPath(targetPath)
      }
      const status = await window.browserApi.mihomo.start({
        binaryPath: mihomoBinaryPath,
        configPath: targetPath
      })
      setMihomoStatus(status)
      message.success('Mihomo 进程启动成功')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      message.error(msg)
    } finally {
      setIsStartingMihomo(false)
    }
  }

  const handleRestartMihomo = async () => {
    setIsStartingMihomo(true)
    try {
      // 保存最新配置并平滑重启核心
      const isVaultConfig = !mihomoConfigPath || mihomoConfigPath.includes('vault/mihomo')
      let targetPath = mihomoConfigPath
      if (isVaultConfig) {
        targetPath = await window.browserApi.mihomo.saveConfig(yamlConfig, mihomoConfigPath)
        setMihomoConfigPath(targetPath)
      }
      const status = await window.browserApi.mihomo.start({
        binaryPath: mihomoBinaryPath,
        configPath: targetPath
      })
      setMihomoStatus(status)
      message.success('已应用最新端口与分流配置并重启 Mihomo')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      message.error(msg)
    } finally {
      setIsStartingMihomo(false)
    }
  }

  const handleStopMihomo = async () => {
    setIsStoppingMihomo(true)
    try {
      const status = await window.browserApi.mihomo.stop()
      setMihomoStatus(status)
      message.info('Mihomo 进程已停止')
    } catch (error) {
      message.error(String(error))
    } finally {
      setIsStoppingMihomo(false)
    }
  }

  const handleSaveAndStart = async () => {
    setIsStartingMihomo(true)
    try {
      const savedPath = await window.browserApi.mihomo.saveConfig(yamlConfig)
      setMihomoConfigPath(savedPath)
      const status = await window.browserApi.mihomo.start({
        binaryPath: mihomoBinaryPath,
        configPath: savedPath
      })
      setMihomoStatus(status)
      message.success('分流配置已保存到金库并成功启动 Mihomo！')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      message.error(msg)
    } finally {
      setIsStartingMihomo(false)
    }
  }

  const handleSaveConfigOnly = async () => {
    try {
      const savedPath = await window.browserApi.mihomo.saveConfig(yamlConfig)
      setMihomoConfigPath(savedPath)
      message.success(`分流配置已写入金库: ${savedPath}`)
    } catch (err) {
      message.error(String(err))
    }
  }

  function openExternalDashboard(): void {
    window.open(dashboardUrl, '_blank')
  }

  return (
    <Modal
      open={open}
      title={
        <Space>
          <ThunderboltOutlined style={{ color: '#1677ff' }} />
          <span>Mihomo 本地代理分流与轻量托管</span>
        </Space>
      }
      footer={null}
      width={960}
      style={{ top: 20 }}
      onCancel={onClose}
      destroyOnClose
    >
      <Alert
        type={mihomoStatus?.running ? 'success' : 'info'}
        showIcon
        icon={<ThunderboltOutlined />}
        title={
          mihomoStatus?.running
            ? `Mihomo 运行中 (PID: ${mihomoStatus.pid}) · 混合代理端口 ${host}:${port} · 控制台 ${externalController}`
            : 'Mihomo 轻量托管 · 单核心多环境分流'
        }
        description="无需安装外部臃肿客户端，Prism 可在后台静默托管拉起 Mihomo 核心，依据环境账号 (IN-USER 规则) 定向分流至不同物理出口节点。"
        style={{ marginBottom: 12 }}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          单核心多环境分流指南、轻量托管参数与可视化 Zashboard 面板
        </Typography.Text>
        <Space size={8}>
          <Button size="small" type="primary" ghost icon={<FileTextOutlined />} onClick={() => void openLocalDoc()}>
            打开本地权威手册
          </Button>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void openDocFolder()}>
            打开文档目录
          </Button>
          <Button size="small" icon={<CopyOutlined />} onClick={() => void copyText('docs/mihomo-routing-guide.md', 'docpath')}>
            {copiedSection === 'docpath' ? '已复制路径' : '复制文档路径'}
          </Button>
        </Space>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'generator' | 'clients' | 'zashboard' | 'docs')}
        items={[
          {
            key: 'generator',
            label: (
              <Space>
                <ThunderboltOutlined />
                <span>轻量托管与分流配置</span>
              </Space>
            ),
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={14}>
                {/* 1. 核心轻量托管控制面板 */}
                <Card
                  size="small"
                  title={
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <Space>
                        <Typography.Text strong>Mihomo 进程轻量托管</Typography.Text>
                        {mihomoStatus?.running ? (
                          <Tag color="success" icon={<CheckOutlined />}>
                            {`运行中 (PID: ${mihomoStatus.pid})`}
                          </Tag>
                        ) : (
                          <Tag color="default">已停止</Tag>
                        )}
                      </Space>
                      <Space wrap size={6}>
                        {mihomoStatus?.running ? (
                          <>
                            <Button
                              size="small"
                              type="primary"
                              icon={<ReloadOutlined />}
                              loading={isStartingMihomo}
                              onClick={handleRestartMihomo}
                            >
                              重启并应用配置
                            </Button>
                            <Button
                              size="small"
                              danger
                              icon={<PoweroffOutlined />}
                              loading={isStoppingMihomo}
                              onClick={handleStopMihomo}
                            >
                              停止进程
                            </Button>
                            <Button
                              size="small"
                              icon={<GlobalOutlined />}
                              onClick={() => setActiveTab('zashboard')}
                            >
                              进入监控面板
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="small"
                              type="primary"
                              icon={<PlayCircleOutlined />}
                              loading={isStartingMihomo}
                              onClick={handleStartMihomo}
                            >
                              启动进程
                            </Button>
                            <Button
                              size="small"
                              icon={<SaveOutlined />}
                              loading={isStartingMihomo}
                              onClick={handleSaveAndStart}
                            >
                              保存配置并启动
                            </Button>
                          </>
                        )}
                        <Button
                          size="small"
                          type={showLogs ? 'primary' : 'default'}
                          icon={<FileTextOutlined />}
                          onClick={() => setShowLogs(!showLogs)}
                        >
                          {`实时控制台日志 (${liveLogs.length})`}
                        </Button>
                      </Space>
                    </div>
                  }
                >
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                    日常只用 Shadowrocket 或直连的用户，无需安装复杂的客户端。在此指定核心路径与已有配置，由后台静默拉起子进程，浏览器关闭时自动退出：
                  </Typography.Paragraph>

                  {mihomoStatus?.error && (
                    <Alert
                      type="error"
                      showIcon
                      message={mihomoStatus.error}
                      style={{ marginBottom: 10 }}
                    />
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 8 }}>
                    <div>
                      <Typography.Text strong style={{ fontSize: 11 }}>Mihomo 二进制文件路径</Typography.Text>
                      <Input
                        size="small"
                        value={mihomoBinaryPath}
                        onChange={(e) => setMihomoBinaryPath(e.target.value)}
                        placeholder="/opt/homebrew/bin/mihomo"
                        style={{ marginTop: 4 }}
                        suffix={
                          <Button
                            size="small"
                            type="text"
                            icon={<FolderOpenOutlined />}
                            onClick={handleSelectBinary}
                            title="选择二进制文件"
                          />
                        }
                      />
                    </div>
                    <div>
                      <Typography.Text strong style={{ fontSize: 11 }}>使用的配置文件路径 (或订阅)</Typography.Text>
                      <Input
                        size="small"
                        value={mihomoConfigPath}
                        onChange={(e) => setMihomoConfigPath(e.target.value)}
                        placeholder="~/Library/Application Support/prism-browser/vault/mihomo/config.yaml"
                        style={{ marginTop: 4 }}
                        suffix={
                          <Button
                            size="small"
                            type="text"
                            icon={<FolderOpenOutlined />}
                            onClick={handleSelectConfig}
                            title="选择配置文件"
                          />
                        }
                      />
                    </div>
                  </div>

                  <div style={{ background: 'var(--surface-subtle)', padding: 8, borderRadius: 6, fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace' }}>
                    <div style={{ color: 'var(--muted)' }}># 后台静默执行命令（自动绑定沙盒运行目录与覆写配置）：</div>
                    <div>{`${mihomoBinaryPath} -d "~/Library/Application Support/prism-browser/vault/mihomo" -f "${mihomoConfigPath}"`}</div>
                  </div>

                  {showLogs && (
                    <div style={{ marginTop: 8, background: '#1e1e1e', color: '#d4d4d4', padding: '8px 10px', borderRadius: 6, fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', maxHeight: 180, overflowY: 'auto' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#888', borderBottom: '1px solid #333', paddingBottom: 4, marginBottom: 6 }}>
                        <span>{`Mihomo 控制台输出 (最近 ${liveLogs.length} 行)`}</span>
                        <Space size={12}>
                          <span style={{ cursor: 'pointer', color: '#1890ff' }} onClick={() => void copyText(liveLogs.join('\n'), 'logs')}>
                            {copiedSection === 'logs' ? '已复制' : '复制全部'}
                          </span>
                          <span style={{ cursor: 'pointer', color: '#ff4d4f' }} onClick={() => setLiveLogs([])}>
                            清空显示
                          </span>
                        </Space>
                      </div>
                      {liveLogs.length === 0 ? (
                        <div style={{ color: '#666', fontStyle: 'italic' }}>暂无日志输出。启动进程后将显示 stdout/stderr。</div>
                      ) : (
                        liveLogs.map((log, i) => (
                          <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.4 }}>
                            {log}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </Card>

                {/* 2. 环境 Users 凭据池与分流规则生成器 */}
                <Card size="small" title="环境 Users 凭据池与分流规则生成">
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 10 }}>
                    在本地回环网络 (127.0.0.1) 中，Mihomo 通过入站用户名 (IN-USER 规则) 定向匹配出口节点。在此自定义参数，生成配置补丁或扩展脚本：
                  </Typography.Paragraph>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 12 }}>
                    <div>
                      <Typography.Text strong style={{ fontSize: 11 }}>生成 User 数量</Typography.Text>
                      <InputNumber
                        size="small"
                        min={1}
                        max={500}
                        value={userCount}
                        onChange={(v) => setUserCount(v || 10)}
                        style={{ width: '100%', marginTop: 4 }}
                      />
                    </div>
                    <div>
                      <Typography.Text strong style={{ fontSize: 11 }}>账号前缀</Typography.Text>
                      <Input
                        size="small"
                        value={prefix}
                        onChange={(e) => setPrefix(e.target.value)}
                        placeholder="node-"
                        style={{ marginTop: 4 }}
                      />
                    </div>
                    <div>
                      <Typography.Text strong style={{ fontSize: 11 }}>监听混合端口</Typography.Text>
                      <InputNumber
                        size="small"
                        min={1024}
                        max={65535}
                        value={port}
                        onChange={(v) => setPort(v || 17890)}
                        style={{ width: '100%', marginTop: 4 }}
                      />
                    </div>
                    <div>
                      <Typography.Text strong style={{ fontSize: 11 }}>统一密码</Typography.Text>
                      <Input
                        size="small"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="prism"
                        style={{ marginTop: 4 }}
                      />
                    </div>
                    <div>
                      <Typography.Text strong style={{ fontSize: 11 }}>external-controller</Typography.Text>
                      <Input
                        size="small"
                        value={externalController}
                        onChange={(e) => setExternalController(e.target.value)}
                        placeholder="127.0.0.1:9090"
                        style={{ marginTop: 4 }}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <Typography.Text strong style={{ fontSize: 12 }}>Mihomo 配置文件补丁 (YAML)</Typography.Text>
                        <Space size={4}>
                          <Button
                            size="small"
                            type="link"
                            icon={copiedSection === 'yaml' ? <CheckOutlined /> : <CopyOutlined />}
                            onClick={() => void copyText(yamlConfig, 'yaml')}
                          >
                            {copiedSection === 'yaml' ? '已复制' : '复制配置'}
                          </Button>
                          <Button
                            size="small"
                            type="link"
                            icon={<SaveOutlined />}
                            onClick={() => void handleSaveConfigOnly()}
                          >
                            保存到金库
                          </Button>
                        </Space>
                      </div>
                      <Input.TextArea
                        value={yamlConfig}
                        readOnly
                        autoSize={{ minRows: 8, maxRows: 12 }}
                        style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }}
                      />
                    </div>

                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <Typography.Text strong style={{ fontSize: 12 }}>客户端覆写扩展脚本 (JavaScript)</Typography.Text>
                        <Button
                          size="small"
                          type="link"
                          icon={copiedSection === 'jsscript' ? <CheckOutlined /> : <CopyOutlined />}
                          onClick={() => void copyText(jsScriptConfig, 'jsscript')}
                        >
                          {copiedSection === 'jsscript' ? '已复制' : '复制 JS 脚本'}
                        </Button>
                      </div>
                      <Input.TextArea
                        value={jsScriptConfig}
                        readOnly
                        autoSize={{ minRows: 8, maxRows: 12 }}
                        style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }}
                      />
                    </div>
                  </div>
                </Card>
              </Space>
            )
          },
          {
            key: 'clients',
            label: (
              <Space>
                <AppstoreOutlined />
                <span>客户端覆写模式教程 (Flclash / Verge)</span>
              </Space>
            ),
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={14}>
                <Alert
                  type="success"
                  showIcon
                  title="为什么强烈推荐使用“覆写 (Override) / 扩展脚本 (Script)”模式？"
                  description={
                    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                      机场订阅通常每隔一段时间就会自动更新，如果直接在订阅下载的 YAML 里手写规则，一点击“更新订阅”修改就会全部被冲掉！使用覆写或扩展脚本，客户端在内存中将 Prism 规则与机场订阅动态合并，机场随便更新，Prism 分流永久有效！
                    </div>
                  }
                />

                <Collapse
                  defaultActiveKey={['flclash', 'verge']}
                  size="small"
                  items={[
                    {
                      key: 'flclash',
                      label: <Typography.Text strong>1. Flclash 覆写配置步骤</Typography.Text>,
                      children: (
                        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                          <ol style={{ paddingLeft: 18, margin: '4px 0' }}>
                            <li>打开 Flclash 客户端，点击左侧导航栏的【设置 (Settings)】。</li>
                            <li>找到【覆写 (Override)】或【扩展脚本 (Script)】选项。</li>
                            <li>新建或编辑覆写配置，推荐选择【JavaScript 脚本】模式（也可选择 YAML Merge）。</li>
                            <li>将第一个 Tab 动态生成的 JavaScript 脚本代码贴入编辑器中，保存并开启开关。</li>
                            <li>返回主界面刷新配置，即可在 17890 端口上同时生效原订阅节点与 Prism 多环境分流！</li>
                          </ol>
                        </div>
                      )
                    },
                    {
                      key: 'verge',
                      label: <Typography.Text strong>2. Clash Verge Rev 覆写配置步骤</Typography.Text>,
                      children: (
                        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                          <ol style={{ paddingLeft: 18, margin: '4px 0' }}>
                            <li>打开 Clash Verge Rev，点击左侧【订阅 (Profiles)】。</li>
                            <li>在右上角点击【新建】，类型选择【Script (扩展脚本)】，名称填写如 Prism-Override。</li>
                            <li>右键新建的脚本点击【编辑】，将第一个 Tab 生成的 JavaScript 脚本完全覆盖贴入并保存。</li>
                            <li>右键该脚本点击【启用 (Enable)】。此时无论原机场订阅如何更新，分流规则均自动置顶生效！</li>
                          </ol>
                        </div>
                      )
                    },
                    {
                      key: 'mihomo_party',
                      label: <Typography.Text strong>3. Mihomo Party 覆写配置步骤</Typography.Text>,
                      children: (
                        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                          <ol style={{ paddingLeft: 18, margin: '4px 0' }}>
                            <li>进入 Mihomo Party 左侧导航的【覆写 (Overrides)】菜单。</li>
                            <li>点击右上角【新建覆写】，类型选择【JavaScript】，命名为 Prism-Split。</li>
                            <li>将第一个 Tab 生成的 JavaScript 代码填入代码框，点击右下角保存并激活生效。</li>
                          </ol>
                        </div>
                      )
                    },
                    {
                      key: 'cfw',
                      label: <Typography.Text strong>4. Clash for Windows (CFW) Mixin 模式</Typography.Text>,
                      children: (
                        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                          <ol style={{ paddingLeft: 18, margin: '4px 0' }}>
                            <li>进入 CFW 的【Settings】页面，滚动至【Mixin】模块。</li>
                            <li>点击【YAML】右侧的【Edit】，贴入第一个 Tab 提供的 YAML 片段。</li>
                            <li>返回开启【Mixin】右侧的开关即可。</li>
                          </ol>
                        </div>
                      )
                    }
                  ]}
                />
              </Space>
            )
          },
          {
            key: 'zashboard',
            label: (
              <Space>
                <GlobalOutlined />
                <span>Zashboard 监控面板</span>
              </Space>
            ),
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={12}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <Space wrap size={10}>
                    <Select
                      size="small"
                      value={dashboardSource}
                      onChange={setDashboardSource}
                      options={[
                        { value: 'local', label: `本地内置 UI (${normalizedControllerAddress}/ui)` },
                        { value: 'zash_online', label: 'Zashboard 官方在线托管 (board.zash.run.place)' },
                        { value: 'metacubexd', label: 'MetaCubeXD 官方在线托管' }
                      ]}
                      style={{ width: 280 }}
                    />
                    <Input
                      size="small"
                      addonBefore="Controller"
                      value={externalController}
                      onChange={(e) => setExternalController(e.target.value)}
                      style={{ width: 220 }}
                      placeholder="127.0.0.1:9090"
                    />
                    <Input
                      size="small"
                      placeholder="Secret (选填)"
                      value={controllerSecret}
                      onChange={(e) => setControllerSecret(e.target.value)}
                      style={{ width: 130 }}
                    />
                  </Space>

                  <Space size={8}>
                    <Button size="small" icon={<ReloadOutlined />} onClick={() => setIframeKey((k) => k + 1)}>
                      刷新面板
                    </Button>
                    <Button size="small" icon={<CopyOutlined />} onClick={() => void copyText(dashboardUrl, 'zashurl')}>
                      {copiedSection === 'zashurl' ? '已复制' : '复制链接'}
                    </Button>
                    <Button size="small" type="primary" ghost icon={<LinkOutlined />} onClick={openExternalDashboard}>
                      新窗口打开
                    </Button>
                  </Space>
                </div>

                <div style={{ width: '100%', height: 480, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
                  <iframe
                    key={iframeKey}
                    src={dashboardUrl}
                    style={{ width: '100%', height: '100%', border: 'none' }}
                    title="Zashboard Controller"
                  />
                </div>
              </Space>
            )
          },
          {
            key: 'docs',
            label: (
              <Space>
                <BookOutlined />
                <span>技术原理解析与手册</span>
              </Space>
            ),
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={14}>
                <Alert
                  type="info"
                  showIcon
                  icon={<InfoCircleOutlined />}
                  title="为什么需要单核心本地分流？"
                  description={
                    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                      <p style={{ margin: '4px 0' }}>
                        指纹浏览器多账号防关联的核心是“不同环境必须有不同的出口 IP”。传统做法要么购买大量昂贵的独立静态代理，要么为每个节点开启单独的代理软件，导致内存占用过大且极易混淆。
                      </p>
                      <p style={{ margin: '4px 0' }}>
                        Mihomo (Clash.Meta) 原生支持在单一后台进程中，通过用户认证信息进行分流（IN-USER 规则），实现让 Profile A 走节点 1、Profile B (或 Pro 组) 走节点 2，极度节省系统资源。
                      </p>
                    </div>
                  }
                />

                <Card size="small" title="核心原理解析：Listen Users 本质是“分流路由标签”">
                  <Typography.Paragraph style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 8 }}>
                    在 127.0.0.1 本地回环网络中，不需要复杂的密码防破解。我们可以把用户名（Username）直接作为该环境的唯一“路由身份标签”，密码统一填写（如 prism）：
                  </Typography.Paragraph>

                  <div style={{ background: 'var(--surface-subtle)', padding: 10, borderRadius: 6, fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace' }}>
                    <div><strong>Profile 代理配置:</strong> socks5://node-0001:prism@127.0.0.1:17890</div>
                    <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                      流量带着 [node-0001] 标签进入 Mihomo 17890 端口 $\rightarrow$ 触发 IN-USER 规则 $\rightarrow$ 精准由对应的物理出口节点送出。
                    </div>
                  </div>
                </Card>

                <Card size="small" title="典型分流场景实战：Pro 环境组走指定节点">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      将以下规则片段添加到你的 Mihomo / Clash 配置文件中：
                    </Typography.Text>
                    <Button
                      size="small"
                      type="link"
                      icon={copiedSection === 'rules' ? <CheckOutlined /> : <CopyOutlined />}
                      onClick={() =>
                        void copyText(
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
  - MATCH,DIRECT`,
                          'rules'
                        )
                      }
                    >
                      {copiedSection === 'rules' ? '已复制示例' : '复制示例 YAML'}
                    </Button>
                  </div>
                  <Input.TextArea
                    readOnly
                    autoSize={{ minRows: 7, maxRows: 10 }}
                    style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }}
                    value={`mixed-port: 17890
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
  - MATCH,DIRECT`}
                  />
                </Card>
              </Space>
            )
          }
        ]}
      />
    </Modal>
  )
}
