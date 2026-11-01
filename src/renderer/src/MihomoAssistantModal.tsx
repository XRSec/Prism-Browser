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
  PartitionOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import { Alert, Button, Card, Checkbox, Input, InputNumber, Modal, Segmented, Space, Tabs, Tag, Typography, message } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { getLocale, t } from '../../shared/i18n'
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
  const [activeTab, setActiveTab] = useState<'prompts' | 'rules' | 'hosting'>('prompts')
  const [configViewMode, setConfigViewMode] = useState<'script' | 'yaml'>('script')
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
  const [dashboardSource, setDashboardSource] = useState<'local' | 'zash_online' | 'metacubexd' | 'yacd'>('local')
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
  const [autoStart, setAutoStart] = useState(false)
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
        if (status.autoStart !== undefined) setAutoStart(Boolean(status.autoStart))
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
      if (status.autoStart !== undefined) setAutoStart(Boolean(status.autoStart))
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
    const isZh = getLocale() === 'zh-CN' || getLocale() === 'zh-TW'
    const headerComment = isZh
      ? '# === Prism Browser Mihomo 本地多环境分流配置 ==='
      : '# === Prism Browser Mihomo Local Multi-Profile Proxy Configuration ==='
    const usersComment = isZh
      ? '# 1. 本地入站用户名凭据池 (环境分流路由标签)'
      : '# 1. Inbound user credential pool (Profile routing tags)'
    const rulesComment = isZh
      ? '# 2. 根据入站用户名 (IN-USER) 定向分流至指定节点\n# 说明：单机独立运行默认出口为 DIRECT；若配合机场订阅使用，可将 DIRECT 替换为真实节点或策略组名称'
      : '# 2. Route to target outbounds based on inbound user (IN-USER)\n# Note: Default outbound is DIRECT; replace DIRECT with your actual node or proxy-group name'
    const exampleComment = isZh
      ? '  # 示例: 让特定环境分组（如带有 Pro 标签的环境）走专用节点/策略组 (替换 DIRECT)\n  # - IN-USER,node-pro-*,🚀 Pro专线池'
      : '  # Example: Route specific group (e.g. Pro profiles) to dedicated group (replace DIRECT)\n  # - IN-USER,node-pro-*,🚀 Pro-Group'

    const lines = [
      headerComment,
      `mixed-port: ${port}`,
      'allow-lan: false',
      `bind-address: ${host}`,
      `external-controller: ${normalizedControllerAddress}`,
      'external-ui: ui',
      'external-ui-url: "https://github.com/Zephyruso/zashboard/releases/latest/download/dist-cdn-fonts.zip"',
      ...(controllerSecret ? [`secret: "${controllerSecret}"`] : []),
      '',
      usersComment,
      'users:'
    ]
    usersList.forEach((username) => {
      lines.push(`  - "${username}:${password}"`)
    })

    lines.push('')
    lines.push(rulesComment)
    lines.push('rules:')
    if (usersList.length > 0) {
      lines.push(`  - IN-USER,${usersList[0]},DIRECT`)
      if (usersList.length > 1) {
        lines.push(`  - IN-USER,${usersList[1]},DIRECT`)
      }
      lines.push(exampleComment)
    }
    lines.push('  - MATCH,DIRECT')

    return lines.join('\n')
  }, [port, host, normalizedControllerAddress, controllerSecret, password, usersList])

  // 动态生成适合 Clash Verge / Flclash / Mihomo Party 的 JavaScript 扩展脚本
  const jsScriptConfig = useMemo(() => {
    const isZh = getLocale() === 'zh-CN' || getLocale() === 'zh-TW'
    const groupPrefix = isZh ? 'Prism-环境-' : 'Prism-Env-'
    const listenerUsers = usersList.map((u) => `        { username: '${u}', password: '${password}' }`).join(',\n')
    const groupNames = usersList.map((_u, i) => `'${groupPrefix}${String(i + 1).padStart(2, '0')}'`).join(', ')
    const defaultGroup = `'${groupPrefix}01'`
    const ruleList = usersList.map((u, i) => `    'IN-USER,${u},${groupPrefix}${String(i + 1).padStart(2, '0')}'`).join(',\n')

    const header = isZh
      ? '// ====================================================================\n// 适用于：Clash Verge Rev / Flclash / Mihomo Party 扩展脚本 (Script)\n// ===================================================================='
      : '// ====================================================================\n// Compatible with: Clash Verge Rev / Flclash / Mihomo Party Script\n// ===================================================================='
    const step1 = isZh
      ? '  // 1. 动态过滤有效物理节点 (自动剔除流量提示等占位符)'
      : '  // 1. Filter out traffic notices and placeholder nodes'
    const step2 = isZh
      ? '  // 2. 开启选择记忆持久化 (确保手动选定后绝不自动跳变)'
      : '  // 2. Enable persistent selection memory across restarts'
    const step3 = isZh
      ? '  // 3. 【核心解耦】：专门为 Prism 开辟专属监听端口，主端口彻底保持无密码'
      : '  // 3. Core Decoupling: Dedicated listener for Prism (main port remains no-auth)'
    const step4 = isZh
      ? '  // 4. 生成专属手动单选策略组 (纯 select 模式，不自动切换)'
      : '  // 4. Dedicated manual select groups (pure select, no auto latency test)'
    const step5 = isZh
      ? '  // 5. 追加在 proxy-groups 末尾，原有的第一主策略 (如 🚀 节点选择) 保持在最顶部不变'
      : '  // 5. Append to proxy-groups end (preserving original top selector)'
    const step6 = isZh
      ? '  // 6. 规则置顶：IN-USER 规则依然最高优先级命中'
      : '  // 6. Prepend IN-USER routing rules at top priority'

    return `${header}
function main(config) {
${step1}
  const allProxyNames = (config.proxies || [])
    .map((p) => p.name)
    .filter((name) => name && !/remaining|expire|website|group|update|traffic|剩余流量|套餐到期|官网|群组|更新/i.test(name));

  const providerNames = config['proxy-providers'] ? Object.keys(config['proxy-providers']) : [];

${step2}
  config['profile'] = {
    ...(config['profile'] || {}),
    'store-selected': true
  };

${step3}
  config.listeners = [
    ...(config.listeners || []),
    {
      name: 'prism-inbound',
      type: 'mixed',
      port: ${port},
      listen: '${host}',
      users: [
${listenerUsers || `        { username: '${prefix}0001', password: '${password}' }`}
      ]
    }
  ];

${step4}
  const prismGroupNames = [${groupNames || defaultGroup}];
  const newProxyGroups = prismGroupNames.map((groupName) => {
    const group = {
      name: groupName,
      type: 'select',
      proxies: ['DIRECT', ...allProxyNames]
    };
    if (providerNames.length > 0) group.use = providerNames;
    return group;
  });

${step5}
  config['proxy-groups'] = [...(config['proxy-groups'] || []), ...newProxyGroups];

${step6}
  const prismRules = [
${ruleList || `    'IN-USER,${prefix}0001,${groupPrefix}01'`}
  ];
  config.rules = [...prismRules, ...(config.rules || [])];

  return config;
}`
  }, [usersList, password, port, host, prefix])

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
    const query = `hostname=${controllerHost}&host=${controllerHost}&port=${controllerPort}&protocol=http&http=true${secretParam}`
    if (dashboardSource === "local") {
      return `http://${controllerHost}:${controllerPort}/ui/#/setup?${query}`
    }
    if (dashboardSource === "zash_online") {
      return `https://board.zash.run.place/#/setup?${query}`
    }
    if (dashboardSource === "yacd") {
      return `https://yacd.metacubex.one/?hostname=${controllerHost}&port=${controllerPort}${secretParam}`
    }
    return `https://metacubex.github.io/metacubexd/#/setup?${query}`
  }, [dashboardSource, controllerHost, controllerPort, controllerSecret])

  const isZh = getLocale() === 'zh-CN' || getLocale() === 'zh-TW'

  const promptTreeText = useMemo(() => {
    if (isZh) {
      return `请首先阅读 Mihomo 本地分流专属技能规范 (SKILL.md)：
- macOS 应用路径：/Applications/Prism Browser.app/Contents/Resources/skills/mihomo-routing/SKILL.md
- 源码/项目相对路径：resources/skills/mihomo-routing/SKILL.md

基于上述 mihomo-routing 技能中的分流架构与 Go 解析器约束，读取当前 Prism 浏览器所有存量 Profile 的名称、分组 (Group) 和序号，构建树状分流拓扑：
1. 提取所有分组（如 vps1、pro-team 等），为每个分组建立对应的独立策略组；
2. 为关键独立环境建立专属单选节点策略组，并将策略组追加在 proxy-groups 末尾；
3. 输出一份适用于 Clash Verge / Mihomo 的 JS 覆写脚本与 IN-USER 树状分流规则。`
    }
    return `Please first inspect the dedicated Mihomo routing skill specification (SKILL.md):
- macOS app path: /Applications/Prism Browser.app/Contents/Resources/skills/mihomo-routing/SKILL.md
- Repo/project path: resources/skills/mihomo-routing/SKILL.md

Based on the mihomo-routing skill architecture and Go parser constraints, read the names, groups, and indices of all existing Prism browser profiles, and build a tree-structured routing topology:
1. Extract all profile groups (e.g. vps1, pro-team), and create an independent proxy group for each;
2. Create dedicated single-selection proxy groups for critical profiles and append them to the end of proxy-groups;
3. Output a Clash Verge / Mihomo JS script override and matching IN-USER routing rules.`
  }, [isZh])

  const promptProxyText = useMemo(() => {
    if (isZh) {
      return `使用 Prism 的 profile 批量更新工具，将当前选中的所有环境网络代理配置为本地分流端口：
- 协议：HTTP 或 SOCKS5
- 主机：127.0.0.1
- 端口：${port} (若用 Verge 专属监听器) 或 7897
- 统一密码：${password}
- 用户名：按环境序号自动填充（例如环境 #28 填 ${prefix}0028）
- 绕过列表：保留默认 localhost;127.0.0.1`
    }
    return `Use Prism's batch profile update tool to configure proxy settings for all target browser profiles to the local routing port:
- Protocol: HTTP or SOCKS5
- Host: 127.0.0.1
- Port: ${port} (if using Verge dedicated listener) or 7897
- Password: ${password}
- Username: auto-fill based on profile index (e.g. Profile #28 -> ${prefix}0028)
- Bypass list: preserve default localhost;127.0.0.1`
  }, [isZh, port, password, prefix])

  const promptAuditText = useMemo(() => {
    if (isZh) {
      return `通过 Prism 自动化 API / MCP 依次检查目标环境的网络连通性与出口隔离状态：
1. 启动目标环境并打开探针页 https://api.ipify.org 或 https://ipwho.is；
2. 读取页面返回的真实外网 IP、ASN 与国家归属；
3. 验证各环境是否成功分配了不同的独立出口 IP，输出巡检结果表格。`
    }
    return `Use Prism automation API / MCP to inspect network connectivity and outbound isolation across target profiles:
1. Launch target profile and open probe page https://api.ipify.org or https://ipwho.is;
2. Read public IP, ASN, and country returned by the page;
3. Verify that each profile is allocated a distinct outbound IP and output an audit table.`
  }, [isZh])

  async function copyText(text: string, id: string): Promise<void> {
    await navigator.clipboard.writeText(text)
    setCopiedSection(id)
    message.success(t("已复制"))
    setTimeout(() => setCopiedSection(''), 2000)
  }

  async function openLocalDoc(docPath = 'docs/clash-verge-guide.md'): Promise<void> {
    try {
      const currentLocale = getLocale()
      const isZhDoc = currentLocale === 'zh-CN' || currentLocale === 'zh-TW'
      const isGuideDoc = docPath.endsWith('-guide.md')
      const targetDoc = (!isZhDoc && isGuideDoc) ? docPath.replace(/\.md$/, '.en.md') : docPath
      let res = await window.browserApi.docs.openPath(targetDoc)
      if (!res.success && !isZhDoc && isGuideDoc) {
        res = await window.browserApi.docs.openPath(docPath)
      }
      if (res.success) {
        message.success(t("已在默认查看器中打开本地手册"))
      } else {
        message.info(t("文档位于: {0}", res.path))
      }
    } catch {
      message.error(t("打开失败，请直接查看 {0}", docPath))
    }
  }

  async function openDocFolder(docPath = 'docs/clash-verge-guide.md'): Promise<void> {
    try {
      const currentLocale = getLocale()
      const isZhDoc = currentLocale === 'zh-CN' || currentLocale === 'zh-TW'
      const targetDoc = isZhDoc ? docPath : docPath.replace(/\.md$/, '.en.md')
      const res = await window.browserApi.docs.showInFolder(targetDoc)
      if (res.success) {
        message.success(t("已在访达 (Finder) 中打开文档目录"))
      } else {
        await window.browserApi.docs.showInFolder(docPath)
      }
    } catch {
      message.error(t("定位目录失败"))
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
      message.success(t("Mihomo 进程启动成功"))
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
      message.success(t("已应用最新端口与分流配置并重启 Mihomo"))
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
      message.info(t("Mihomo 进程已停止"))
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
      message.success(t("分流配置已保存到金库并成功启动 Mihomo！"))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      message.error(msg)
    } finally {
      setIsStartingMihomo(false)
    }
  }

  const handleToggleAutoStart = async (checked: boolean) => {
    setAutoStart(checked)
    try {
      const status = await window.browserApi.mihomo.setAutoStart(checked)
      setMihomoStatus(status)
      message.success(checked ? t("已开启随 app 启动启动") : t("已关闭随 app 启动启动"))
    } catch (err) {
      setAutoStart(!checked)
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
          <ThunderboltOutlined style={{ color: 'var(--accent)' }} />
          <span>{t("Mihomo 本地代理分流与轻量托管")}</span>
        </Space>
      }
      footer={null}
      width={960}
      style={{ top: 20 }}
      onCancel={onClose}
      destroyOnClose
    >
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'prompts' | 'rules' | 'hosting')}
        size="small"
        style={{ marginTop: -4 }}
        tabBarExtraContent={
          <Space size={6}>
            <Button size="small" type="text" icon={<FileTextOutlined />} onClick={() => void openLocalDoc('docs/clash-verge-guide.md')}>
              {t("Clash Verge 专属手册")}
            </Button>
            <Button size="small" type="text" icon={<FileTextOutlined />} onClick={() => void openLocalDoc('docs/mihomo-routing-guide.md')}>
              {t("通用分流手册")}
            </Button>
            <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => void openDocFolder()}>
              {t("打开文档目录")}
            </Button>
          </Space>
        }
        items={[
          {
            key: 'prompts',
            label: (
              <Space>
                <RobotOutlined />
                <span>{t("AI 提示词")}</span>
              </Space>
            ),
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={10}>
                <Alert
                  type={mihomoStatus?.running ? 'success' : 'info'}
                  showIcon
                  icon={<ThunderboltOutlined />}
                  title={
                    mihomoStatus?.running
                      ? `${t("Mihomo 运行中")} (PID: ${mihomoStatus.pid}) · ${t("混合代理端口")} ${host}:${port} · ${t("外部控制")} ${externalController}`
                      : t("Mihomo 轻量托管 · 单核心多环境分流")
                  }
                  description={t("无需安装外部臃肿客户端，Prism 可在后台静默托管拉起 Mihomo 核心，依据环境账号 (IN-USER 规则) 定向分流至不同物理出口节点。")}
                  style={{ marginBottom: 4 }}
                />

                <Card
                  size="small"
                  title={
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Space>
                        <PartitionOutlined style={{ color: 'var(--accent)' }} />
                        <Typography.Text strong>{t("提示词 1：读取环境并构建树状分流策略树")}</Typography.Text>
                      </Space>
                      <Button
                        size="small"
                        icon={copiedSection === 'prompt_tree' ? <CheckOutlined /> : <CopyOutlined />}
                        onClick={() => void copyText(promptTreeText, 'prompt_tree')}
                      >
                        {copiedSection === 'prompt_tree' ? t("已复制") : t("复制提示词")}
                      </Button>
                    </div>
                  }
                >
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                    {t("让 AI 扫描存量环境，按分组（Group）与标签（Tag）构建清晰的树状分流规则，并在 Clash Verge 中追加专属策略组：")}
                  </Typography.Paragraph>
                  <pre style={{ margin: 0, padding: '8px 12px', borderRadius: 6, background: 'var(--surface-subtle)', fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
{promptTreeText}
                  </pre>
                </Card>

                <Card
                  size="small"
                  title={
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Space>
                        <ThunderboltOutlined style={{ color: '#1677ff' }} />
                        <Typography.Text strong>{t("提示词 2：批量配置环境网络代理与染色账号")}</Typography.Text>
                      </Space>
                      <Button
                        size="small"
                        icon={copiedSection === 'prompt_proxy' ? <CheckOutlined /> : <CopyOutlined />}
                        onClick={() => void copyText(promptProxyText, 'prompt_proxy')}
                      >
                        {copiedSection === 'prompt_proxy' ? t("已复制") : t("复制提示词")}
                      </Button>
                    </div>
                  }
                >
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                    {t("让 AI 自动将目标环境的代理批量配置到本地分流端口（17890 或 7897），无需人工逐个修改：")}
                  </Typography.Paragraph>
                  <pre style={{ margin: 0, padding: '8px 12px', borderRadius: 6, background: 'var(--surface-subtle)', fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
{promptProxyText}
                  </pre>
                </Card>

                <Card
                  size="small"
                  title={
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Space>
                        <SafetyCertificateOutlined style={{ color: '#52c41a' }} />
                        <Typography.Text strong>{t("提示词 3：无头巡检各环境实际出口 IP 与连通性")}</Typography.Text>
                      </Space>
                      <Button
                        size="small"
                        icon={copiedSection === 'prompt_audit' ? <CheckOutlined /> : <CopyOutlined />}
                        onClick={() => void copyText(promptAuditText, 'prompt_audit')}
                      >
                        {copiedSection === 'prompt_audit' ? t("已复制") : t("复制提示词")}
                      </Button>
                    </div>
                  }
                >
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                    {t("命令 AI 批量唤起环境，通过探针页自动获取并比对出口 IP，输出连通性报告表格：")}
                  </Typography.Paragraph>
                  <pre style={{ margin: 0, padding: '8px 12px', borderRadius: 6, background: 'var(--surface-subtle)', fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
{promptAuditText}
                  </pre>
                </Card>

                <div style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, marginTop: 4 }}>
                  <span>{t("内置技能")}: <code>mihomo-routing</code></span>
                  <span>{t("唤醒指令")}: <code>/skill:mihomo-routing</code></span>
                  <span>{t("技能文档")}: <code>/Applications/Prism Browser.app/Contents/Resources/skills/mihomo-routing/SKILL.md</code></span>
                </div>
              </Space>
            )
          },
          {
            key: 'rules',
            label: (
              <Space>
                <ThunderboltOutlined />
                <span>{t("分流规则与脚本")}</span>
              </Space>
            ),
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={10}>
                <Card
                  size="small"
                  styles={{ body: { padding: '10px 12px' } }}
                  title={
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <Segmented
                        value={configViewMode}
                        onChange={(val) => setConfigViewMode(val as 'script' | 'yaml')}
                        size="small"
                        options={[
                          { value: 'script', label: t("客户端覆写脚本 (JavaScript)") },
                          { value: 'yaml', label: t("独立配置文件 (YAML)") }
                        ]}
                      />
                      {configViewMode === 'script' ? (
                        <Button
                          size="small"
                          type="primary"
                          icon={copiedSection === 'jsscript' ? <CheckOutlined /> : <CopyOutlined />}
                          onClick={() => void copyText(jsScriptConfig, 'jsscript')}
                        >
                          {copiedSection === 'jsscript' ? t("已复制") : t("复制 JS 脚本")}
                        </Button>
                      ) : (
                        <Button
                          size="small"
                          type="primary"
                          icon={copiedSection === 'yaml' ? <CheckOutlined /> : <CopyOutlined />}
                          onClick={() => void copyText(yamlConfig, 'yaml')}
                        >
                          {copiedSection === 'yaml' ? t("已复制") : t("复制 YAML 配置")}
                        </Button>
                      )}
                    </div>
                  }
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 14px', marginBottom: 10, padding: '6px 10px', background: 'var(--surface-subtle)', borderRadius: 6 }}>
                    <Space size={4}>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t("生成 User 数量")}:</span>
                      <InputNumber
                        size="small"
                        min={1}
                        max={500}
                        value={userCount}
                        onChange={(v) => setUserCount(v || 10)}
                        style={{ width: 68 }}
                      />
                    </Space>
                    <Space size={4}>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t("账号前缀")}:</span>
                      <Input
                        size="small"
                        value={prefix}
                        onChange={(e) => setPrefix(e.target.value)}
                        placeholder="node-"
                        style={{ width: 80 }}
                      />
                    </Space>
                    <Space size={4}>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{configViewMode === 'script' ? t("专属监听端口") : t("监听混合端口")}:</span>
                      <InputNumber
                        size="small"
                        min={1024}
                        max={65535}
                        value={port}
                        onChange={(v) => setPort(v || 17890)}
                        style={{ width: 78 }}
                      />
                    </Space>
                    <Space size={4}>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t("统一密码")}:</span>
                      <Input
                        size="small"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="prism"
                        style={{ width: 78 }}
                      />
                    </Space>
                    {configViewMode === 'yaml' && (
                      <Space size={4}>
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>external-controller:</span>
                        <Input
                          size="small"
                          value={externalController}
                          onChange={(e) => setExternalController(e.target.value)}
                          placeholder="127.0.0.1:9090"
                          style={{ width: 115 }}
                        />
                      </Space>
                    )}
                  </div>

                  <Input.TextArea
                    value={configViewMode === 'script' ? jsScriptConfig : yamlConfig}
                    readOnly
                    autoSize={{ minRows: 14, maxRows: 20 }}
                    style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, lineHeight: 1.45, background: 'var(--surface-subtle)', borderRadius: 6 }}
                  />
                </Card>
              </Space>
            )
          },
          {
            key: 'hosting',
            label: (
              <Space>
                <PlayCircleOutlined />
                <span>{t("进程轻量托管")}</span>
              </Space>
            ),
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={14}>
                {/* 核心轻量托管控制面板 */}
                <Card
                  size="small"
                  title={
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <Space size={8}>
                        <Typography.Text strong>{t("Mihomo 进程轻量托管")}</Typography.Text>
                        {mihomoStatus?.running ? (
                          <Tag color="success" icon={<CheckOutlined />}>
                            {`${t("运行中")} (PID: ${mihomoStatus.pid})`}
                          </Tag>
                        ) : (
                          <Tag color="default">{t("已停止")}</Tag>
                        )}
                        <Checkbox
                          checked={autoStart}
                          onChange={(e) => void handleToggleAutoStart(e.target.checked)}
                          style={{ marginLeft: 6, userSelect: 'none' }}
                        >
                          {t("随 app 启动启动")}
                        </Checkbox>
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
                              {t("重启并应用配置")}
                            </Button>
                            <Button
                              size="small"
                              danger
                              icon={<PoweroffOutlined />}
                              loading={isStoppingMihomo}
                              onClick={handleStopMihomo}
                            >
                              {t("停止进程")}
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
                              {t("启动进程")}
                            </Button>
                            <Button
                              size="small"
                              icon={<SaveOutlined />}
                              loading={isStartingMihomo}
                              onClick={handleSaveAndStart}
                            >
                              {t("保存配置并启动")}
                            </Button>
                          </>
                        )}
                        <Button
                          size="small"
                          type={showLogs ? 'primary' : 'default'}
                          icon={<FileTextOutlined />}
                          onClick={() => setShowLogs(!showLogs)}
                        >
                          {t("实时控制台日志 ({0})", liveLogs.length)}
                        </Button>
                      </Space>
                    </div>
                  }
                >
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                    {t("日常只用 Shadowrocket 或直连的用户，无需安装复杂的客户端。在此指定核心路径与已有配置，由后台静默拉起子进程，浏览器关闭时自动退出：")}
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
                      <Typography.Text strong style={{ fontSize: 11 }}>{t("Mihomo 二进制文件路径")}</Typography.Text>
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
                            title={t("选择二进制文件")}
                          />
                        }
                      />
                    </div>
                    <div>
                      <Typography.Text strong style={{ fontSize: 11 }}>{t("使用的配置文件路径 (或订阅)")}</Typography.Text>
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
                            title={t("选择配置文件")}
                          />
                        }
                      />
                    </div>
                  </div>

                  <div style={{ background: 'var(--surface-subtle)', padding: 8, borderRadius: 6, fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace' }}>
                    <div style={{ color: 'var(--muted)' }}>{t("# 后台静默执行命令（自动绑定沙盒运行目录与覆写配置）：")}</div>
                    <div>{`${mihomoBinaryPath} -d "~/Library/Application Support/prism-browser/vault/mihomo" -f "${mihomoConfigPath}"`}</div>
                  </div>

                  {showLogs && (
                    <div style={{ marginTop: 8, background: '#1e1e1e', color: '#d4d4d4', padding: '8px 10px', borderRadius: 6, fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', maxHeight: 180, overflowY: 'auto' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#888', borderBottom: '1px solid #333', paddingBottom: 4, marginBottom: 6 }}>
                        <span>{t("Mihomo 控制台输出 (最近 {0} 行)", liveLogs.length)}</span>
                        <Space size={12}>
                          <span style={{ cursor: 'pointer', color: '#1890ff' }} onClick={() => void copyText(liveLogs.join('\n'), 'logs')}>
                            {copiedSection === 'logs' ? t("已复制") : t("复制全部")}
                          </span>
                          <span style={{ cursor: 'pointer', color: '#ff4d4f' }} onClick={() => setLiveLogs([])}>
                            {t("清空显示")}
                          </span>
                        </Space>
                      </div>
                      {liveLogs.length === 0 ? (
                        <div style={{ color: '#666', fontStyle: 'italic' }}>{t("暂无日志输出。启动进程后将显示 stdout/stderr。")}</div>
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
              </Space>
            )
          }
        ]}
      />
    </Modal>
  )
}
