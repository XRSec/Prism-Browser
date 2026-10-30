import { t, translateMessage as mt } from '../../shared/i18n'
import {
  CheckCircleFilled,
  CrownOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  PauseOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons'
import { Alert, Button, List, Modal, Popconfirm, Progress, Space, Spin, Tag, Typography, message } from 'antd'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { EngineStatus, KernelHealth, KernelInstallProgress, KernelRelease } from '../../shared/types'
import { kernelRequiresPro } from '../../shared/kernel-policy'

interface KernelManagerModalProps {
  open: boolean
  engine: EngineStatus | null
  onClose: () => void
  onEngineChanged: (engine: EngineStatus) => void
  proActive: boolean
}

function sizeLabel(size: number): string {
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function errorText(error: unknown): string {
  return mt(error instanceof Error ? error.message : String(error))
}

export function KernelManagerModal({ open, engine, onClose, onEngineChanged, proActive }: KernelManagerModalProps) {
  const [progress, setProgress] = useState<KernelInstallProgress | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [catalogError, setCatalogError] = useState<string>('')
  const [releases, setReleases] = useState<KernelRelease[]>([])
  const [loading, setLoading] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [verifying, setVerifying] = useState<string | null>(null)
  const [health, setHealth] = useState<Record<string, KernelHealth>>({})
  const [bundled, setBundled] = useState<EngineStatus | null>(null)
  const [rollbackAvailable, setRollbackAvailable] = useState(false)
  const [messageApi, contextHolder] = message.useMessage()

  const currentVersion = useMemo(
    () => releases.find((release) => release.executable && release.executable === engine?.executable)?.version,
    [engine?.executable, releases]
  )

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const [items, bundledEngine, canRollback] = await Promise.all([
        window.browserApi.engine.installed(),
        window.browserApi.engine.bundled(),
        window.browserApi.engine.rollbackAvailable()
      ])
      setReleases(items)
      setBundled(bundledEngine)
      setRollbackAvailable(canRollback)
      try {
        setReleases(await window.browserApi.engine.releases())
        setCatalogError('')
      } catch (error) {
        setCatalogError(errorText(error))
      }
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  useEffect(() => {
    void window.browserApi.engine.installProgress().then(setProgress)
    return window.browserApi.engine.onInstallProgress?.(setProgress)
  }, [])

  const busyVersion = installing ?? (progress && ['downloading', 'verifying', 'installing'].includes(progress.stage) ? progress.version : null)

  async function install(version: string): Promise<void> {
    setInstalling(version)
    try {
      const status = await window.browserApi.engine.install(version)
      onEngineChanged(status)
      messageApi.success(t("内核已安装，可点击“切换使用”，或在环境设置中指定版本"))
    } catch (error) {
      messageApi.info(errorText(error))
    } finally {
      setInstalling(null)
      await refresh()
    }
  }

  async function activate(version: string): Promise<void> {
    try {
      onEngineChanged(await window.browserApi.engine.activate(version))
      messageApi.success(t("已切换到内核 {0}", version))
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function selectManual(): Promise<void> {
    try {
      const status = await window.browserApi.engine.select()
      onEngineChanged(status)
      if (status.fingerprintKernel) messageApi.success(t("自定义指纹内核已启用"))
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function activateBundled(): Promise<void> {
    try {
      onEngineChanged(await window.browserApi.engine.activateBundled())
      messageApi.success(t("已启用内置内核 {0}", bundled?.version ?? ''))
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function useSystem(): Promise<void> {
    try {
      onEngineChanged(await window.browserApi.engine.useSystem())
      messageApi.success(t("已切换到系统浏览器兼容模式"))
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function rollback(): Promise<void> {
    try {
      const status = await window.browserApi.engine.rollback()
      onEngineChanged(status)
      setRollbackAvailable(false)
      await refresh()
      messageApi.success(t("已回滚到 {0}", status.version ?? status.label))
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function importLocal(): Promise<void> {
    try {
      const status = await window.browserApi.engine.importLocal()
      onEngineChanged(status)
      await refresh()
      if (status.fingerprintKernel) messageApi.success(t("本地构建 {0} 已导入并启用", status.version ?? ''))
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function remove(version: string): Promise<void> {
    setRemoving(version)
    try {
      await window.browserApi.engine.remove(version)
      await refresh()
      onEngineChanged(await window.browserApi.engine.status())
      messageApi.success(t("内核 {0} 已移入回收目录", version))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setRemoving(null)
    }
  }

  async function verify(version: string): Promise<void> {
    setVerifying(version)
    try {
      const result = await window.browserApi.engine.verify(version)
      setHealth((current) => ({ ...current, [version]: result }))
      if (result.status === 'healthy') messageApi.success(t("内核 {0} 检查通过", version))
      else messageApi.warning(mt(result.message))
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setVerifying(null)
    }
  }

  return (
    <Modal open={open} title={t("浏览器内核")} width={760} footer={null} onCancel={onClose} destroyOnHidden>
      {contextHolder}
      <Alert
        className="kernel-notice"
        type="info"
        showIcon
        title={t("按需下载，多个版本独立保存")}
        description={t("Pro 用户可下载 Pro 内核。下载完成后自行选择是否切换；固定版本的环境不会随软件升级改变内核。")}
      />

      {catalogError && (
        <Alert type="warning" showIcon title={mt(catalogError)} style={{ marginTop: 12 }} />
      )}

      {progress && (
        <div className="kernel-progress" style={{ marginTop: 12, padding: 12 }}>
          <Typography.Text>
            Chromium {progress.version} · {mt(progress.message)}
          </Typography.Text>
          <Progress
            percent={progress.percent}
            status={progress.stage === 'error' ? 'exception' : progress.stage === 'ready' ? 'success' : 'normal'}
          />
          <Space>
            <Typography.Text type="secondary">
              {sizeLabel(progress.receivedBytes)} / {sizeLabel(progress.totalBytes)}
            </Typography.Text>
            {busyVersion && progress.stage === 'downloading' && (
              <Button
                size="small"
                icon={<PauseOutlined />}
                onClick={() => void window.browserApi.engine.cancelInstall(busyVersion).catch((error) => messageApi.error(errorText(error)))}
              >
                {t("暂停下载")}
              </Button>
            )}
          </Space>
        </div>
      )}

      <div className="kernel-toolbar" style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Typography.Text strong style={{ display: 'block' }}>Fingerprint Chromium</Typography.Text>
          <Typography.Text type="secondary">{t("当前：{0}", mt(engine?.label ?? t("未配置")))}</Typography.Text>
        </div>
        <Space wrap>
          {bundled?.executable && engine?.executable !== bundled.executable && (
            <Button type="primary" onClick={() => void activateBundled()}>{t("使用内置 {0}", bundled.version)}</Button>
          )}
          <Button type="primary" icon={<FolderOpenOutlined />} onClick={() => void importLocal()}>{t("导入本地构建")}</Button>
          <Button onClick={() => void selectManual()}>{t("外部路径")}</Button>
          <Button onClick={() => void useSystem()}>{t("系统兼容模式")}</Button>
          {rollbackAvailable && (
            <Popconfirm
              title={t("回滚到上一个健康内核？")}
              description={t("请先关闭全部浏览器环境。")}
              onConfirm={() => rollback()}
            >
              <Button danger>{t("回滚上一个")}</Button>
            </Popconfirm>
          )}
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>{t("刷新")}</Button>
        </Space>
      </div>

      <Spin spinning={loading && releases.length === 0}>
        <List
          className="kernel-list"
          style={{ marginTop: 16 }}
          dataSource={releases}
          locale={{ emptyText: t("暂无可用版本，请刷新目录或导入本地构建") }}
          renderItem={(release) => {
            const active = currentVersion === release.version
            const bundledRelease = release.origin === 'bundled'
            const proKernel = kernelRequiresPro(release.version)
            const proLocked = proKernel && !proActive
            const actions: ReactNode[] = [
              active ? (
                <Tag key="active" color="success" icon={<CheckCircleFilled />}>{t("正在使用")}</Tag>
              ) : !release.installed ? (
                <Button
                  key="download"
                  type="primary"
                  icon={<DownloadOutlined />}
                  disabled={proLocked || Boolean(busyVersion)}
                  loading={busyVersion === release.version}
                  onClick={() => void install(release.version)}
                >
                  {proLocked
                    ? t("升级 Pro 后下载")
                    : progress?.version === release.version && ['cancelled', 'error'].includes(progress.stage)
                      ? t("继续下载")
                      : t("下载并安装")}
                </Button>
              ) : (
                <Button key="use" disabled={proLocked} onClick={() => void activate(release.version)}>
                  {proLocked ? t("升级 Pro 后使用") : t("切换使用")}
                </Button>
              )
            ]

            if (release.installed && !active && !bundledRelease) {
              actions.push(
                <Popconfirm
                  key="remove"
                  title={t("移除内核 {0}？", release.version)}
                  description={t("文件会移动到本机回收目录。")}
                  okText={t("移除")}
                  cancelText={t("取消")}
                  onConfirm={() => remove(release.version)}
                >
                  <Button danger type="text" icon={<DeleteOutlined />} loading={removing === release.version}>{t("移除")}</Button>
                </Popconfirm>
              )
            }

            if (release.installed) {
              actions.push(
                <Button
                  key="verify"
                  type="text"
                  icon={<SafetyCertificateOutlined />}
                  loading={verifying === release.version}
                  onClick={() => void verify(release.version)}
                >
                  {t("检查")}
                </Button>
              )
            }

            return (
              <List.Item actions={actions}>
                <List.Item.Meta
                  title={
                    <Space wrap>
                      <span>Chromium {release.version}</span>
                      {release.installed && <Tag>{t("已安装")}</Tag>}
                      {bundledRelease && <Tag color="blue">{t("随应用内置")}</Tag>}
                      {release.origin === 'local-build' && <Tag color="purple">{t("本地构建")}</Tag>}
                      {!release.installed && release.remoteAvailable && <Tag>{t("可下载")}</Tag>}
                      {proKernel && <Tag color="gold" icon={<CrownOutlined />}>Pro</Tag>}
                      {health[release.version]?.status === 'healthy' && <Tag color="success">{t("文件正常")}</Tag>}
                      {health[release.version]?.status === 'unverified' && <Tag color="warning">{t("建议重新导入")}</Tag>}
                      {health[release.version]?.status === 'corrupt' && (
                        <Tag color="error">{t("文件异常，请安装新版 Prism Browser 或重新导入本地构建")}</Tag>
                      )}
                    </Space>
                  }
                  description={
                    <div className="kernel-meta">
                      <span>{release.size ? sizeLabel(release.size) : t("本地安装")}</span>
                    </div>
                  }
                />
              </List.Item>
            )
          }}
        />
      </Spin>
    </Modal>
  )
}
