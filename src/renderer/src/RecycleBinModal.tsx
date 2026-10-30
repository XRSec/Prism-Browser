import { t, getLocale, translateMessage as mt } from '../../shared/i18n'
import { DeleteOutlined, ReloadOutlined, UndoOutlined } from '@ant-design/icons'
import { Button, Empty, List, Modal, Popconfirm, Select, Space, Spin, Tabs, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import type { AppSettings, BrowserProfileView, DeletedKernelSummary, DeletedProfileSummary, EngineStatus } from '../../shared/types'

interface RecycleBinModalProps {
  open: boolean
  onClose: () => void
  onRestored: (profile: BrowserProfileView) => void
  onKernelRestored?: (status: EngineStatus) => void
}

function errorText(error: unknown): string {
  return mt(error instanceof Error ? error.message : String(error))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function RecycleBinModal({ open, onClose, onRestored, onKernelRestored }: RecycleBinModalProps) {
  const [activeTab, setActiveTab] = useState<'profiles' | 'kernels'>('profiles')
  const [items, setItems] = useState<DeletedProfileSummary[]>([])
  const [kernelItems, setKernelItems] = useState<DeletedKernelSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [purging, setPurging] = useState<string | null>(null)
  const [restoringKernel, setRestoringKernel] = useState<string | null>(null)
  const [purgingKernel, setPurgingKernel] = useState<string | null>(null)
  const [retention, setRetention] = useState<AppSettings['recycleRetentionDays']>(0)
  const [messageApi, contextHolder] = message.useMessage()

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const [trash, kernelTrash, days] = await Promise.all([
        window.browserApi.profiles.trash(),
        window.browserApi.engine.trash(),
        window.browserApi.profiles.recycleRetention()
      ])
      setItems(trash)
      setKernelItems(kernelTrash)
      setRetention(days)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  async function restore(item: DeletedProfileSummary): Promise<void> {
    setRestoring(item.trashId)
    try {
      const profile = await window.browserApi.profiles.restore(item.trashId)
      onRestored(profile)
      setItems((current) => current.filter((entry) => entry.trashId !== item.trashId))
      messageApi.success(t("“{0}”及其浏览器数据已恢复", profile.name))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setRestoring(null)
    }
  }

  async function purge(item: DeletedProfileSummary): Promise<void> {
    setPurging(item.trashId)
    try {
      await window.browserApi.profiles.purgeTrash(item.trashId)
      setItems((current) => current.filter((entry) => entry.trashId !== item.trashId))
      messageApi.success(t("“{0}”已永久删除", item.name))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setPurging(null)
    }
  }

  async function emptyTrash(): Promise<void> {
    setPurging('__all__')
    try {
      const count = await window.browserApi.profiles.emptyTrash()
      setItems([])
      messageApi.success(t("已永久删除 {0} 个环境", count))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setPurging(null)
    }
  }

  async function restoreKernel(item: DeletedKernelSummary): Promise<void> {
    setRestoringKernel(item.trashId)
    try {
      const status = await window.browserApi.engine.restoreTrash(item.trashId)
      onKernelRestored?.(status)
      setKernelItems((current) => current.filter((entry) => entry.trashId !== item.trashId))
      messageApi.success(t("“{0}”及其浏览器数据已恢复", `Chromium ${item.version}`))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setRestoringKernel(null)
    }
  }

  async function purgeKernel(item: DeletedKernelSummary): Promise<void> {
    setPurgingKernel(item.trashId)
    try {
      await window.browserApi.engine.purgeTrash(item.trashId)
      setKernelItems((current) => current.filter((entry) => entry.trashId !== item.trashId))
      messageApi.success(t("“{0}”已永久删除", `Chromium ${item.version}`))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setPurgingKernel(null)
    }
  }

  async function emptyKernelTrash(): Promise<void> {
    setPurgingKernel('__all__')
    try {
      await window.browserApi.engine.emptyTrash()
      setKernelItems([])
      messageApi.success(t("环境回收站已清空"))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setPurgingKernel(null)
    }
  }

  async function changeRetention(days: AppSettings['recycleRetentionDays']): Promise<void> {
    try {
      setRetention(await window.browserApi.profiles.setRecycleRetention(days))
      await refresh()
      messageApi.success(days ? t("将在应用启动时自动删除超过 {0} 天的环境", days) : t("已关闭自动清理"))
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  function requestRetention(days: AppSettings['recycleRetentionDays']): void {
    if (!days) {
      void changeRetention(days)
      return
    }
    Modal.confirm({
      title: t("自动删除超过 {0} 天的回收站环境？", days),
      content: t("该策略会在应用启动时永久删除过期环境及全部浏览器数据，删除后无法恢复。现有未过期环境不受影响。"),
      okText: t("启用自动清理"),
      okButtonProps: { danger: true },
      cancelText: t("取消"),
      onOk: () => changeRetention(days)
    })
  }

  return (
    <Modal open={open} title={t("环境回收站")} width={650} footer={null} onCancel={onClose} destroyOnHidden>
      {contextHolder}
      <div className="recycle-toolbar">
        <div>
          <Typography.Text type="secondary">{t("删除的环境保留在本机，恢复时会带回原浏览器数据和指纹。")}</Typography.Text>
          <Space size="small" className="recycle-policy">
            <Typography.Text type="secondary">{t("自动清理")}</Typography.Text>
            <Select
              size="small"
              value={retention}
              onChange={requestRetention}
              options={[
                { value: 0, label: t("永不") },
                { value: 7, label: t("保留 7 天") },
                { value: 30, label: t("保留 30 天") },
                { value: 90, label: t("保留 90 天") }
              ]}
            />
          </Space>
        </div>
        <Space>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>{t("刷新")}</Button>
          {activeTab === 'profiles' ? (
            <Popconfirm
              title={t("清空环境回收站？")}
              description={t("所有列表中的环境配置和浏览器数据将永久删除，无法恢复。")}
              okText={t("永久删除")}
              okButtonProps={{ danger: true }}
              cancelText={t("取消")}
              onConfirm={emptyTrash}
            >
              <Button size="small" danger disabled={!items.length} loading={purging === '__all__'}>{t("清空")}</Button>
            </Popconfirm>
          ) : (
            <Popconfirm
              title={t("清空环境回收站？")}
              description={t("所有列表中的环境配置和浏览器数据将永久删除，无法恢复。")}
              okText={t("永久删除")}
              okButtonProps={{ danger: true }}
              cancelText={t("取消")}
              onConfirm={emptyKernelTrash}
            >
              <Button size="small" danger disabled={!kernelItems.length} loading={purgingKernel === '__all__'}>{t("清空")}</Button>
            </Popconfirm>
          )}
        </Space>
      </div>
      <Spin spinning={loading && items.length === 0 && kernelItems.length === 0}>
        <Tabs
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key as 'profiles' | 'kernels')}
          items={[
            {
              key: 'profiles',
              label: `${t("环境")} (${items.length})`,
              children: (
                <List
                  dataSource={items}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("回收站为空")} /> }}
                  renderItem={(item) => (
                    <List.Item actions={[
                      <Button key="restore" type="primary" ghost icon={<UndoOutlined />} loading={restoring === item.trashId} disabled={Boolean(purging)} onClick={() => void restore(item)}>{t("恢复")}</Button>,
                      <Popconfirm
                        key="purge"
                        title={t("永久删除“{0}”？", item.name)}
                        description={t("该环境的 Cookie、站点数据和配置将无法恢复。")}
                        okText={t("永久删除")}
                        okButtonProps={{ danger: true }}
                        cancelText={t("取消")}
                        onConfirm={() => purge(item)}
                      >
                        <Button danger type="text" icon={<DeleteOutlined />} loading={purging === item.trashId}>{t("永久删除")}</Button>
                      </Popconfirm>
                    ]}>
                      <List.Item.Meta
                        title={item.name}
                        description={<Space split="·"><span>{item.serialNumber ? `#${item.serialNumber}` : t("旧环境")}</span><span>{formatBytes(item.sizeBytes)}</span><span>{new Date(item.deletedAt).toLocaleString(getLocale())}</span></Space>}
                      />
                    </List.Item>
                  )}
                />
              )
            },
            {
              key: 'kernels',
              label: `${t("内核")} (${kernelItems.length})`,
              children: (
                <List
                  dataSource={kernelItems}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("回收站为空")} /> }}
                  renderItem={(item) => (
                    <List.Item actions={[
                      <Button key="restore" type="primary" ghost icon={<UndoOutlined />} loading={restoringKernel === item.trashId} disabled={Boolean(purgingKernel)} onClick={() => void restoreKernel(item)}>{t("恢复")}</Button>,
                      <Popconfirm
                        key="purge"
                        title={t("永久删除“{0}”？", `Chromium ${item.version}`)}
                        description={t("该环境的 Cookie、站点数据和配置将无法恢复。")}
                        okText={t("永久删除")}
                        okButtonProps={{ danger: true }}
                        cancelText={t("取消")}
                        onConfirm={() => purgeKernel(item)}
                      >
                        <Button danger type="text" icon={<DeleteOutlined />} loading={purgingKernel === item.trashId}>{t("永久删除")}</Button>
                      </Popconfirm>
                    ]}>
                      <List.Item.Meta
                        title={`Chromium ${item.version}`}
                        description={<Space split="·"><span>{t("内核")}</span><span>{formatBytes(item.sizeBytes)}</span><span>{new Date(item.deletedAt).toLocaleString(getLocale())}</span></Space>}
                      />
                    </List.Item>
                  )}
                />
              )
            }
          ]}
        />
      </Spin>
    </Modal>
  )
}
