import { t, translateMessage as mt } from '../../shared/i18n'
import { CloudDownloadOutlined, DeleteOutlined, EditOutlined, FolderAddOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
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
  const [messageApi, contextHolder] = message.useMessage()

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
            <List.Item actions={[
              <Button
                key="edit"
                type="text"
                icon={<EditOutlined />}
                loading={opening === extension.id}
                onClick={() => void openSourceFolder(extension)}
              >{t("编辑")}</Button>,
              <Popconfirm
                key="remove"
                title={t("移除扩展“{0}”？", extension.name)}
                description={t("仍被环境或回收站引用时将拒绝移除。")}
                okText={t("移除")}
                cancelText={t("取消")}
                onConfirm={() => remove(extension)}
              >
                <Button danger type="text" icon={<DeleteOutlined />} loading={removing === extension.id}>{t("移除")}</Button>
              </Popconfirm>,
              <Space key="global-enabled" size={6}>
                <Typography.Text type="secondary">{t("全局启用")}</Typography.Text>
                <Switch
                  size="small"
                  checked={extension.globalEnabled}
                  loading={toggling === extension.id}
                  onChange={(enabled) => void setGlobalEnabled(extension, enabled)}
                />
              </Space>
            ]}>
              <List.Item.Meta
                title={
                  <Space>
                    <span>{extension.name}</span>
                    <Tag>v{extension.version}</Tag>
                    {extension.source === 'chrome-web-store' && (
                      <Tag color="blue" icon={<SafetyCertificateOutlined />}>{t("Chrome 商店")}</Tag>
                    )}
                  </Space>
                }
                description={
                  <div>
                    <div>{extension.description || t("无描述")}</div>
                    {extension.storeId && (
                      <Typography.Text type="secondary">{t("扩展 ID：{0}", extension.storeId)}</Typography.Text>
                    )}
                    <Typography.Text type="secondary" className="extension-path" copyable={{ text: extension.path }}>{extension.path}</Typography.Text>
                  </div>
                }
              />
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
    </Modal>
  )
}
