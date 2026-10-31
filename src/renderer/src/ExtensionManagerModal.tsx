import { t, translateMessage as mt } from '../../shared/i18n'
import { CloudDownloadOutlined, DeleteOutlined, EditOutlined, FolderAddOutlined, ReloadOutlined, SafetyCertificateOutlined, ShareAltOutlined } from '@ant-design/icons'
import { Alert, Button, Input, List, Modal, Popconfirm, Select, Space, Spin, Switch, Tag, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import type { BrowserExtension, BrowserProfileView, ExtensionDownloadNetwork } from '../../shared/types'

interface ExtensionManagerModalProps {
  open: boolean
  extensions: BrowserExtension[]
  profiles: BrowserProfileView[]
  onClose: () => void
  onChanged: (extensions: BrowserExtension[]) => void
}

function errorText(error: unknown): string {
  return mt(error instanceof Error ? error.message : String(error))
}

export function ExtensionManagerModal({ open, extensions, profiles, onClose, onChanged }: ExtensionManagerModalProps) {
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [storeOpen, setStoreOpen] = useState(false)
  const [storeUrl, setStoreUrl] = useState('')
  const [storeNetwork, setStoreNetwork] = useState('direct')
  const [storeImporting, setStoreImporting] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [sharingModalExtension, setSharingModalExtension] = useState<BrowserExtension | null>(null)
  const [sharingEnabled, setSharingEnabled] = useState(false)
  const [sharingSourceProfileId, setSharingSourceProfileId] = useState<string | undefined>()
  const [sharingTargetProfileIds, setSharingTargetProfileIds] = useState<string[]>([])
  const [savingSharing, setSavingSharing] = useState(false)
  const [messageApi, contextHolder] = message.useMessage()

  function openDataSharingModal(extension: BrowserExtension): void {
    setSharingModalExtension(extension)
    setSharingEnabled(Boolean(extension.dataSharing?.enabled))
    setSharingSourceProfileId(extension.dataSharing?.sourceProfileId || profiles[0]?.id)
    setSharingTargetProfileIds(extension.dataSharing?.targetProfileIds || profiles.map((p) => p.id))
  }

  async function saveDataSharing(): Promise<void> {
    if (!sharingModalExtension) return
    setSavingSharing(true)
    try {
      const updated = await window.browserApi.extensions.updateDataSharing(sharingModalExtension.id, {
        enabled: sharingEnabled,
        sourceProfileId: sharingSourceProfileId,
        targetProfileIds: sharingTargetProfileIds
      })
      onChanged(extensions.map((ext) => (ext.id === updated.id ? updated : ext)))
      messageApi.success(t("已更新扩展数据共享设置"))
      setSharingModalExtension(null)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setSavingSharing(false)
    }
  }

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      onChanged(await window.browserApi.extensions.list())
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  async function importDirectory(): Promise<void> {
    setImporting(true)
    try {
      const imported = await window.browserApi.extensions.importDirectory()
      if (!imported) return
      onChanged([...extensions.filter((item) => item.id !== imported.id), imported])
      messageApi.success(t("扩展“{0}”已导入", imported.name))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setImporting(false)
    }
  }

  async function importWebStore(): Promise<void> {
    if (!storeUrl.trim()) {
      messageApi.warning(t("请粘贴 Chrome 应用商店扩展地址"))
      return
    }
    setStoreImporting(true)
    try {
      const network: ExtensionDownloadNetwork = storeNetwork === 'system'
        ? { mode: 'system' }
        : storeNetwork.startsWith('profile:')
          ? { mode: 'profile', profileId: storeNetwork.slice('profile:'.length) }
          : { mode: 'direct' }
      const imported = await window.browserApi.extensions.importWebStore(storeUrl.trim(), network)
      onChanged([...extensions.filter((item) => item.id !== imported.id), imported])
      setStoreUrl('')
      setStoreOpen(false)
      messageApi.success(t("扩展“{0}”已安全导入，可在环境设置中启用", imported.name))
    } catch (error) {
      messageApi.error(errorText(error), 6)
    } finally {
      setStoreImporting(false)
    }
  }

  async function remove(extension: BrowserExtension): Promise<void> {
    setRemoving(extension.id)
    try {
      await window.browserApi.extensions.remove(extension.id)
      onChanged(extensions.filter((item) => item.id !== extension.id))
      messageApi.success(t("扩展“{0}”已移入回收目录", extension.name))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setRemoving(null)
    }
  }

  async function openSourceFolder(extension: BrowserExtension): Promise<void> {
    setOpening(extension.id)
    try {
      await window.browserApi.extensions.openSourceFolder(extension.id)
      messageApi.info(t("已定位到当前扩展的 manifest.json；修改完成后请关闭并重新打开相关环境"))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setOpening(null)
    }
  }

  async function setGlobalEnabled(extension: BrowserExtension, enabled: boolean): Promise<void> {
    setToggling(extension.id)
    try {
      const updated = await window.browserApi.extensions.setGlobalEnabled(extension.id, enabled)
      onChanged(extensions.map((item) => item.id === updated.id ? updated : item))
      messageApi.success(enabled
        ? t("扩展“{0}”已对所有环境启用；重新打开运行中的环境后生效", extension.name)
        : t("扩展“{0}”已取消全局启用；重新打开运行中的环境后生效", extension.name))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setToggling(null)
    }
  }

  return (
    <Modal open={open} title={t("浏览器扩展")} width={720} footer={null} onCancel={onClose} destroyOnHidden>
      {contextHolder}
      <Alert
        type="warning"
        showIcon
        title={t("扩展拥有读取和修改网页数据的能力")}
        description={t("仅导入你信任的扩展。")}
      />
      <div className="extension-toolbar">
        <Typography.Text type="secondary">{t("导入一次后，可在不同环境中选择不同扩展组合。")}</Typography.Text>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>{t("刷新")}</Button>
          <Button icon={<FolderAddOutlined />} loading={importing} onClick={() => void importDirectory()}>{t("导入本地扩展")}</Button>
          <Button type="primary" icon={<CloudDownloadOutlined />} onClick={() => setStoreOpen(true)}>{t("从 Chrome 商店安装")}</Button>
        </Space>
      </div>
      <Spin spinning={loading && extensions.length === 0}>
        <List
          className="wrap-actions-list"
          dataSource={extensions}
          locale={{ emptyText: t("尚未导入浏览器扩展") }}
          renderItem={(extension) => (
            <List.Item key={extension.id} style={{ display: 'block', padding: '12px 0' }}>
              <div style={{ marginBottom: 6 }}>
                <Space wrap>
                  <Typography.Text strong style={{ fontSize: 13 }}>{extension.name}</Typography.Text>
                  <Tag>v{extension.version}</Tag>
                  {extension.source === 'chrome-web-store' && (
                    <Tag color="blue" icon={<SafetyCertificateOutlined />}>{t("Chrome 商店")}</Tag>
                  )}
                  {extension.dataSharing?.enabled && (
                    <Tag color="green">{t("数据共享中")}</Tag>
                  )}
                </Space>
              </div>

              <div>
                <div style={{ float: 'right', marginLeft: 16, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Button
                    size="small"
                    key="share"
                    type="text"
                    icon={<ShareAltOutlined />}
                    onClick={() => openDataSharingModal(extension)}
                  >{t("数据共享")}</Button>
                  <Button
                    size="small"
                    key="edit"
                    type="text"
                    icon={<EditOutlined />}
                    loading={opening === extension.id}
                    onClick={() => void openSourceFolder(extension)}
                  >{t("编辑")}</Button>
                  <Popconfirm
                    key="remove"
                    title={t("移除扩展“{0}”？", extension.name)}
                    description={t("仍被环境或回收站引用时将拒绝移除。")}
                    okText={t("移除")}
                    cancelText={t("取消")}
                    onConfirm={() => remove(extension)}
                  >
                    <Button size="small" danger type="text" icon={<DeleteOutlined />} loading={removing === extension.id}>{t("移除")}</Button>
                  </Popconfirm>
                  <Space key="global-enabled" size={4}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t("全局启用")}</Typography.Text>
                    <Switch
                      size="small"
                      checked={extension.globalEnabled}
                      loading={toggling === extension.id}
                      onChange={(enabled) => void setGlobalEnabled(extension, enabled)}
                    />
                  </Space>
                </div>

                <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6 }}>
                  {extension.description || t("无描述")}
                </div>

                <div style={{ clear: 'both', paddingTop: 6 }}>
                  {extension.storeId && (
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>{t("扩展 ID：{0}", extension.storeId)}</Typography.Text>
                    </div>
                  )}
                  <Typography.Text type="secondary" className="extension-path" copyable={{ text: extension.path }}>{extension.path}</Typography.Text>
                </div>
              </div>
            </List.Item>
          )}
        />
      </Spin>
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>{t("“全局启用”会让所有现有及以后新建的环境加载该扩展；扩展开关或源码修改需关闭并重新打开环境后生效。")}</Typography.Paragraph>
      <Modal
        open={storeOpen}
        title={t("从 Chrome 应用商店安装")}
        okText={t("下载并安装")}
        cancelText={t("取消")}
        confirmLoading={storeImporting}
        okButtonProps={{ disabled: !storeUrl.trim() }}
        closable={!storeImporting}
        maskClosable={!storeImporting}
        onOk={() => void importWebStore()}
        onCancel={() => { if (!storeImporting) setStoreOpen(false) }}
      >
        <Typography.Paragraph type="secondary">{t("粘贴扩展详情页地址。Prism 会从 Google 官方服务下载并校验扩展，安装后可在环境设置中启用。")}</Typography.Paragraph>
        <Input
          autoFocus
          value={storeUrl}
          disabled={storeImporting}
          placeholder={t("https://chromewebstore.google.com/detail/.../扩展ID")}
          onChange={(event) => setStoreUrl(event.target.value)}
          onPressEnter={() => { if (!storeImporting && storeUrl.trim()) void importWebStore() }}
        />
        <div style={{ marginTop: 16 }}>
          <Typography.Text strong>{t("下载网络")}</Typography.Text>
          <Select
            value={storeNetwork}
            disabled={storeImporting}
            style={{ width: '100%', marginTop: 8 }}
            options={[
              { value: 'direct', label: t("本机直连") },
              { value: 'system', label: t("跟随系统代理") },
              ...profiles.filter((profile) => profile.proxy.protocol !== 'direct').map((profile) => ({
                value: `profile:${profile.id}`,
                label: `#${profile.serialNumber} · ${profile.name} (${profile.proxy.protocol.toUpperCase()} ${profile.proxy.host}:${profile.proxy.port})`
              }))
            ]}
            onChange={setStoreNetwork}
          />
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            {t("无法直接访问 Google 服务时，可使用系统代理或已有环境的代理下载。这里只用于下载扩展，不会启动该环境。")}
          </Typography.Paragraph>
        </div>
      </Modal>
      <Modal
        open={Boolean(sharingModalExtension)}
        title={t("配置扩展数据共享") + (sharingModalExtension ? ` · ${sharingModalExtension.name}` : '')}
        okText={t("保存")}
        cancelText={t("取消")}
        confirmLoading={savingSharing}
        onOk={() => void saveDataSharing()}
        onCancel={() => setSharingModalExtension(null)}
      >
        <Typography.Paragraph type="secondary">
          {t("启用后，勾选的环境将共享同一份数据（启动时拉取，窗口关闭后自动写回）；未勾选的环境保留自己独立的本地数据。")}
        </Typography.Paragraph>
        <div style={{ marginBottom: 16 }}>
          <Space size={12}>
            <Typography.Text strong>{t("共享插件数据")}</Typography.Text>
            <Switch
              checked={sharingEnabled}
              onChange={setSharingEnabled}
            />
          </Space>
        </div>
        {sharingEnabled && (
          <>
            <div style={{ marginBottom: 16 }}>
              <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>{t("主数据源环境")}</Typography.Text>
              <Select
                value={sharingSourceProfileId}
                style={{ width: '100%' }}
                placeholder={t("选择提供初始数据的环境")}
                options={profiles.map((p) => ({
                  value: p.id,
                  label: `#${p.serialNumber} · ${p.name}`
                }))}
                onChange={setSharingSourceProfileId}
              />
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <Typography.Text strong>{t("接入环境")}</Typography.Text>
                <Button
                  size="small"
                  type="link"
                  onClick={() => {
                    if (sharingTargetProfileIds.length === profiles.length) {
                      setSharingTargetProfileIds([])
                    } else {
                      setSharingTargetProfileIds(profiles.map((p) => p.id))
                    }
                  }}
                >
                  {sharingTargetProfileIds.length === profiles.length ? t("取消全选") : t("全选所有环境")}
                </Button>
              </div>
              <Select
                mode="multiple"
                value={sharingTargetProfileIds}
                style={{ width: '100%' }}
                placeholder={t("请勾选接入共享数据的环境")}
                maxTagCount="responsive"
                options={profiles.map((p) => ({
                  value: p.id,
                  label: `#${p.serialNumber} · ${p.name}`
                }))}
                onChange={setSharingTargetProfileIds}
              />
            </div>
          </>
        )}
      </Modal>
    </Modal>
  )
}
