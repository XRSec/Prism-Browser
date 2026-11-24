import { t, translateMessage as mt } from '../../shared/i18n'
import { DeleteOutlined, DownloadOutlined, FolderOpenOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { Alert, Button, Descriptions, Modal, Popconfirm, Space, Spin, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import type { BrowserProfileView, ProfileStorageInfo } from '../../shared/types'

interface ProfileDataModalProps {
  open: boolean
  profile?: BrowserProfileView
  onClose: () => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`
}

function errorText(error: unknown): string {
  return mt(error instanceof Error ? error.message : String(error))
}

export function ProfileDataModal({ open, profile, onClose }: ProfileDataModalProps) {
  const [info, setInfo] = useState<ProfileStorageInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [cookieBusy, setCookieBusy] = useState<'import' | 'export' | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [messageApi, contextHolder] = message.useMessage()

  async function refresh(): Promise<void> {
    if (!profile) return
    setLoading(true)
    try {
      setInfo(await window.browserApi.profiles.storageInfo(profile.id))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open, profile?.id])

  async function clearCache(): Promise<void> {
    if (!profile) return
    setClearing(true)
    try {
      const previous = info?.cacheBytes ?? 0
      const next = await window.browserApi.profiles.clearCache(profile.id)
      setInfo(next)
      messageApi.success(t("已清理 {0} 缓存", formatBytes(Math.max(0, previous - next.cacheBytes))))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setClearing(false)
    }
  }

  async function openFolder(): Promise<void> {
    if (!profile) return
    try {
      await window.browserApi.profiles.openDataFolder(profile.id)
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function transferCookies(mode: 'import' | 'export'): Promise<void> {
    if (!profile) return
    setCookieBusy(mode)
    try {
      const result = mode === 'import'
        ? await window.browserApi.profiles.importCookies(profile.id)
        : await window.browserApi.profiles.exportCookies(profile.id)
      if (result) messageApi.success(t("已{0} {1} 条 Cookie", mode === 'import' ? t("导入") : t("导出"), result.count))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setCookieBusy(null)
    }
  }

  async function exportBackup(): Promise<void> {
    if (!profile) return
    setBackupBusy(true)
    try {
      const result = await window.browserApi.profiles.exportBackup(profile.id)
      if (result) messageApi.success(t("完整数据备份已导出，共 {0}、{1} 个文件", formatBytes(result.totalBytes), result.fileCount))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setBackupBusy(false)
    }
  }

  async function exportPortableSession(): Promise<void> {
    if (!profile) return
    setBackupBusy(true)
    try {
      const result = await window.browserApi.profiles.exportPortableSession(profile.id)
      if (result) messageApi.success(t("便携会话包已导出，共 {0}、{1} 个文件", formatBytes(result.totalBytes), result.fileCount))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setBackupBusy(false)
    }
  }

  const canClear = profile?.status === 'closed' || profile?.status === 'error'

  return (
    <Modal open={open} title={t("环境数据 · {0}", profile?.name ?? '')} width={680} footer={null} onCancel={onClose} destroyOnHidden>
      {contextHolder}
      <Alert
        type="info"
        showIcon
        title={t("缓存清理不会删除账号登录状态")}
        description={t("只清理缓存，Cookie、网站数据、书签和扩展不会被删除。")}
      />
      <Spin spinning={loading}>
        <Descriptions className="profile-data-details" column={1} bordered size="small">
          <Descriptions.Item label={t("数据总量")}>{info ? formatBytes(info.totalBytes) : '—'}</Descriptions.Item>
          <Descriptions.Item label={t("可清理缓存")}>{info ? formatBytes(info.cacheBytes) : '—'}</Descriptions.Item>
          <Descriptions.Item label={t("数据目录")}>
            <Typography.Text copyable={{ text: info?.path }} className="data-path">{info?.path ?? '—'}</Typography.Text>
          </Descriptions.Item>
        </Descriptions>
      </Spin>
      <Space className="profile-data-actions">
        <Button icon={<FolderOpenOutlined />} onClick={() => void openFolder()}>{t("打开数据目录")}</Button>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>{t("重新统计")}</Button>
        <Popconfirm
          title={t("清理该环境的浏览器缓存？")}
          description={t("必须先关闭环境。Cookie 和站点登录数据不会被删除。")}
          okText={t("清理缓存")}
          cancelText={t("取消")}
          onConfirm={clearCache}
        >
          <Button danger icon={<DeleteOutlined />} loading={clearing} disabled={!canClear}>{t("清理缓存")}</Button>
        </Popconfirm>
      </Space>
      <div className="cookie-transfer">
        <div>
          <Typography.Text strong>{t("完整数据备份")}</Typography.Text>
          <Typography.Text type="secondary">{t("备份可能包含账号登录信息，请妥善保管；跨系统恢复后部分网站可能需要重新登录。")}</Typography.Text>
        </div>
        <Space>
          <Button icon={<DownloadOutlined />} loading={backupBusy} disabled={!canClear || backupBusy} onClick={() => void exportPortableSession()}>{t("导出便携会话包")}</Button>
          <Button icon={<DownloadOutlined />} loading={backupBusy} disabled={!canClear || backupBusy} onClick={() => void exportBackup()}>{t("导出备份目录")}</Button>
        </Space>
      </div>
      <div className="cookie-transfer">
        <div>
          <Typography.Text strong>{t("Cookie 迁移")}</Typography.Text>
          <Typography.Text type="secondary">{t("支持常见 Cookie JSON 格式。导出文件包含登录信息，请妥善保管。")}</Typography.Text>
        </div>
        <Space>
          <Button icon={<UploadOutlined />} loading={cookieBusy === 'import'} disabled={!canClear || Boolean(cookieBusy)} onClick={() => void transferCookies('import')}>{t("导入 Cookie")}</Button>
          <Button icon={<DownloadOutlined />} loading={cookieBusy === 'export'} disabled={!canClear || Boolean(cookieBusy)} onClick={() => void transferCookies('export')}>{t("导出 Cookie")}</Button>
        </Space>
      </div>
    </Modal>
  )
}
