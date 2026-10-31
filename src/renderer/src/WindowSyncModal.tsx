import { t, translateMessage as mt } from '../../shared/i18n'
import {
  AppstoreOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  CopyOutlined,
  EyeOutlined,
  GlobalOutlined,
  PlayCircleOutlined,
  StopOutlined,
  SyncOutlined
} from '@ant-design/icons'
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Select, Space, Switch, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { BrowserProfileView, WindowSyncSettings, WindowSyncStatus } from '../../shared/types'

interface WindowSyncModalProps {
  open: boolean
  profiles: BrowserProfileView[]
  status: WindowSyncStatus | null
  proEnabled: boolean
  onChanged: (status: WindowSyncStatus) => void
  onClose: () => void
}

const fallbackSettings: WindowSyncSettings = {
  syncClicks: true,
  syncTyping: true,
  syncKeys: true,
  syncScroll: true,
  delayMinMs: 0,
  delayMaxMs: 120
}

function errorText(error: unknown): string {
  return mt(error instanceof Error ? error.message : String(error))
}

export function WindowSyncModal({ open, profiles, status, proEnabled, onChanged, onClose }: WindowSyncModalProps) {
  const runningProfiles = useMemo(
    () => profiles.filter((profile) => profile.status === 'running').sort((a, b) => a.serialNumber - b.serialNumber),
    [profiles]
  )
  const [mainId, setMainId] = useState('')
  const [followerIds, setFollowerIds] = useState<string[]>([])
  const [settings, setSettings] = useState<WindowSyncSettings>(fallbackSettings)
  const [url, setUrl] = useState('')
  const [newTab, setNewTab] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [uniformSize, setUniformSize] = useState(true)

  const active = status?.state === 'running' || status?.state === 'starting'

  useEffect(() => {
    if (!open) return
    if (active && status?.mainProfileId) {
      setMainId(status.mainProfileId)
      setFollowerIds(status.followerProfileIds)
      setSettings(status.settings)
      return
    }
    const first = runningProfiles[0]?.id ?? ''
    setMainId((current) => (runningProfiles.some((profile) => profile.id === current) ? current : first))
    setFollowerIds((current) => {
      const available = current.filter((id) => id !== first && runningProfiles.some((profile) => profile.id === id))
      return available.length ? available : runningProfiles.slice(1).map((profile) => profile.id)
    })
    setSettings(status?.settings ?? fallbackSettings)
  }, [open, active, status?.mainProfileId, runningProfiles])

  const selectedIds = [mainId, ...followerIds].filter(Boolean)
  const options = runningProfiles.map((profile) => ({
    value: profile.id,
    label: `#${profile.serialNumber} · ${profile.name}`
  }))

  async function operation(name: string, task: () => Promise<unknown>): Promise<void> {
    setBusy(name)
    setError('')
    try {
      await task()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('')
    }
  }

  async function start(): Promise<void> {
    await operation('start', async () =>
      onChanged(await window.browserApi.windowSync.start({ mainProfileId: mainId, followerProfileIds: followerIds, settings }))
    )
  }

  async function stop(): Promise<void> {
    await operation('stop', async () => onChanged(await window.browserApi.windowSync.stop()))
  }

  function setSetting<K extends keyof WindowSyncSettings>(key: K, value: WindowSyncSettings[K]): void {
    setSettings((current) => ({ ...current, [key]: value }))
  }

  return (
    <Modal
      open={open}
      width={860}
      title={
        <Space size={8}>
          <SyncOutlined style={{ color: 'var(--accent, #315c50)' }} />
          <span>{t("多窗口同步器")}</span>
        </Space>
      }
      footer={null}
      onCancel={onClose}
      className="window-sync-modal"
      destroyOnHidden
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type={active ? 'success' : 'info'}
          showIcon
          title={active ? mt(status?.message) : t("选择主控窗口和受控窗口后开始同步")}
          description={
            active
              ? status?.errorCount
                ? t("已同步 {0} 次操作，失败 {1} 次", status.actionCount ?? 0, status.errorCount)
                : t("已同步 {0} 次操作", status?.actionCount ?? 0)
              : t("主控窗口的网页操作、地址跳转与标签页新建、切换、关闭会复制到受控窗口。所有操作仅在本机传递。")
          }
        />

        {runningProfiles.length < 2 && !active && (
          <Alert
            type="warning"
            showIcon
            title={t("请先打开至少两个浏览器环境")}
            description={t("多窗口同步需要至少一个主控环境与一个受控环境同时处于运行中。")}
          />
        )}

        {active && status?.addressBarSync === 'permission-required' && (
          <Alert
            type="warning"
            showIcon
            title={t("请允许 Prism Browser 使用辅助功能")}
            description={t("在 macOS 系统设置中允许后，停止并重新开始同步，即可实时显示地址栏输入。")}
          />
        )}
        {active && status?.addressBarSync === 'error' && (
          <Alert type="warning" showIcon title={t("地址栏实时同步未启用，网页内操作仍会继续同步")} />
        )}
        {error && <Alert type="error" showIcon title={error} closable onClose={() => setError('')} />}

        {/* 窗口选择区 */}
        <div className="window-sync-selection-grid">
          <div className="window-sync-field">
            <div className="window-sync-field-header">
              <Typography.Text strong>{t("主控窗口")}</Typography.Text>
              <Typography.Text type="secondary" className="window-sync-field-hint">
                {t("操作发起源")}
              </Typography.Text>
            </div>
            <Select
              className="window-sync-select"
              value={mainId || undefined}
              options={options}
              disabled={active}
              placeholder={t("选择主控环境")}
              onChange={(id) => {
                setMainId(id)
                setFollowerIds((items) => items.filter((item) => item !== id))
              }}
            />
          </div>

          <div className="window-sync-field">
            <div className="window-sync-field-header">
              <Typography.Text strong>{t("受控窗口")}</Typography.Text>
              <Typography.Text type="secondary" className="window-sync-field-hint">
                {followerIds.length > 0 ? t("已选择 {0} 项", followerIds.length) : t("跟随同步")}
              </Typography.Text>
            </div>
            <Select
              mode="multiple"
              className="window-sync-select"
              value={followerIds}
              options={options.filter((item) => item.value !== mainId)}
              disabled={active}
              placeholder={t("至少选择一个受控环境")}
              maxTagCount="responsive"
              onChange={setFollowerIds}
            />
          </div>
        </div>

        {/* 同步配置与延时区 */}
        <div className="window-sync-card">
          <div className="window-sync-card-title">
            <Typography.Text strong>{t("同步行为与延时")}</Typography.Text>
          </div>
          <div className="window-sync-switches-grid">
            <div className="window-sync-switch-item">
              <span>{t("同步点击")}</span>
              <Switch size="small" checked={settings.syncClicks} disabled={active} onChange={(val) => setSetting('syncClicks', val)} />
            </div>
            <div className="window-sync-switch-item">
              <span>{t("同步输入")}</span>
              <Switch size="small" checked={settings.syncTyping} disabled={active} onChange={(val) => setSetting('syncTyping', val)} />
            </div>
            <div className="window-sync-switch-item">
              <span>{t("同步按键")}</span>
              <Switch size="small" checked={settings.syncKeys} disabled={active} onChange={(val) => setSetting('syncKeys', val)} />
            </div>
            <div className="window-sync-switch-item">
              <span>{t("同步滚动")}</span>
              <Switch size="small" checked={settings.syncScroll} disabled={active} onChange={(val) => setSetting('syncScroll', val)} />
            </div>
          </div>

          <div className="window-sync-delay-row">
            <span className="window-sync-delay-label">{t("操作延迟")}</span>
            <Space.Compact className="window-sync-delay-inputs">
              <InputNumber
                min={0}
                max={5000}
                value={settings.delayMinMs}
                disabled={active}
                addonAfter="ms"
                style={{ width: 110 }}
                onChange={(val) => setSetting('delayMinMs', val ?? 0)}
              />
              <InputNumber
                min={settings.delayMinMs}
                max={5000}
                value={settings.delayMaxMs}
                disabled={active}
                addonBefore={t("至")}
                addonAfter="ms"
                style={{ width: 130 }}
                onChange={(val) => setSetting('delayMaxMs', val ?? settings.delayMinMs)}
              />
            </Space.Compact>
          </div>
        </div>

        {/* 窗口与标签控制动作区 */}
        <div className="window-sync-card">
          <div className="window-sync-card-title">
            <Typography.Text strong>{t("窗口与标签控制")}</Typography.Text>
          </div>
          <div className="window-sync-button-clusters">
            <div className="window-sync-cluster">
              {!active ? (
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  loading={busy === 'start'}
                  disabled={!mainId || followerIds.length < 1}
                  onClick={() => void start()}
                  className="window-sync-action-btn primary"
                >
                  {t("开始同步")}
                </Button>
              ) : (
                <Button
                  danger
                  type="primary"
                  icon={<StopOutlined />}
                  loading={busy === 'stop'}
                  onClick={() => void stop()}
                  className="window-sync-action-btn"
                >
                  {t("停止同步")}
                </Button>
              )}
            </div>

            <div className="window-sync-cluster">
              <Button
                icon={<AppstoreOutlined />}
                loading={busy === 'grid'}
                disabled={selectedIds.length < 2}
                onClick={() => void operation('grid', () => window.browserApi.windowSync.tile(selectedIds, 'grid', { x: 0, y: 0, width: window.screen.availWidth, height: window.screen.availHeight }, !uniformSize))}
              >
                {t("网格平铺")}
              </Button>
              <Button
                icon={<AppstoreOutlined />}
                loading={busy === 'overlap'}
                disabled={selectedIds.length < 2}
                onClick={() => void operation('overlap', () => window.browserApi.windowSync.tile(selectedIds, 'overlap', { x: 0, y: 0, width: window.screen.availWidth, height: window.screen.availHeight }))}
              >
                {t("重叠排列")}
              </Button>
              <Checkbox
                checked={uniformSize}
                disabled={!mainId || followerIds.length < 1}
                onChange={(e) => {
                  const checked = e.target.checked
                  setUniformSize(checked)
                  if (checked && mainId && followerIds.length >= 1) {
                    void operation('size', () => window.browserApi.windowSync.uniformSize(mainId, followerIds))
                  }
                }}
                style={{ marginLeft: 6, marginRight: 6, userSelect: 'none' }}
              >
                {t("统一大小")}
              </Checkbox>
              <Button
                icon={<EyeOutlined />}
                loading={busy === 'front'}
                disabled={!selectedIds.length}
                onClick={() => void operation('front', () => window.browserApi.windowSync.bringToFront(selectedIds))}
              >
                {t("显示窗口")}
              </Button>
            </div>

            <div className="window-sync-cluster">
              <Button
                icon={<CopyOutlined />}
                loading={busy === 'tabs'}
                disabled={!mainId || followerIds.length < 1}
                onClick={() => void operation('tabs', () => window.browserApi.windowSync.sameTabs(mainId, followerIds))}
              >
                {t("统一标签页")}
              </Button>
              <Button
                icon={<CloseCircleOutlined />}
                loading={busy === 'close-current'}
                disabled={!selectedIds.length}
                onClick={() => void operation('close-current', () => window.browserApi.windowSync.closeTabs(selectedIds, 'current'))}
              >
                {t("关闭当前标签")}
              </Button>
              <Button
                loading={busy === 'close-others'}
                disabled={!selectedIds.length}
                onClick={() => void operation('close-others', () => window.browserApi.windowSync.closeTabs(selectedIds, 'others'))}
              >
                {t("关闭其他标签")}
              </Button>
              <Button
                loading={busy === 'close-blank'}
                disabled={!selectedIds.length}
                onClick={() => void operation('close-blank', () => window.browserApi.windowSync.closeTabs(selectedIds, 'blank'))}
              >
                {t("关闭空白标签")}
              </Button>
            </div>
          </div>
        </div>

        {/* 批量访问网址 */}
        <div className="window-sync-card">
          <div className="window-sync-card-title">
            <Typography.Text strong>{t("批量访问网址")}</Typography.Text>
            <Typography.Text type="secondary" className="window-sync-field-hint">
              {t("在全部选中窗口打开同一网页")}
            </Typography.Text>
          </div>
          <div className="window-sync-visit-bar">
            <Input
              prefix={<GlobalOutlined style={{ color: 'var(--muted, #848980)' }} />}
              value={url}
              placeholder="https://example.com"
              onChange={(event) => setUrl(event.target.value)}
              onPressEnter={() => void operation('visit', () => window.browserApi.windowSync.visit(selectedIds, url, newTab))}
              className="window-sync-url-input"
            />
            <Checkbox checked={newTab} onChange={(event) => setNewTab(event.target.checked)}>
              {t("新标签页")}
            </Checkbox>
            <Button
              type="primary"
              loading={busy === 'visit'}
              disabled={!url.trim() || !selectedIds.length}
              onClick={() => void operation('visit', () => window.browserApi.windowSync.visit(selectedIds, url, newTab))}
            >
              {t("打开")}
            </Button>
          </div>
        </div>
      </Space>
    </Modal>
  )
}
