import { t } from '../../shared/i18n'
import { ClearOutlined, ExclamationCircleOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Modal, Radio, Space, Typography } from 'antd'
import { useState } from 'react'
import type { BatchOperationResult } from './BatchResultModal'
import type { BrowserProfileView, ClearProfileDataOptions } from '../../shared/types'

interface ClearDataModalProps {
  open: boolean
  selectedProfileIds: string[]
  allProfiles: BrowserProfileView[]
  onClose: () => void
  onCompleted: (result: BatchOperationResult) => void
}

const DEFAULT_OPTIONS: ClearProfileDataOptions = {
  cache: true,
  history: true,
  downloads: true,
  cookies: false,
  autofill: false,
  siteSettings: false,
  hostedAppData: false
}

export function ClearDataModal({ open, selectedProfileIds, allProfiles, onClose, onCompleted }: ClearDataModalProps) {
  const [scope, setScope] = useState<'all' | 'selected'>(selectedProfileIds.length ? 'selected' : 'all')
  const [options, setOptions] = useState<ClearProfileDataOptions>(DEFAULT_OPTIONS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const targetProfiles = scope === 'all'
    ? allProfiles
    : allProfiles.filter((p) => selectedProfileIds.includes(p.id))

  const hasAnySelected = Object.values(options).some(Boolean)

  const setOpt = (key: keyof ClearProfileDataOptions, val: boolean) => {
    setOptions((prev) => ({ ...prev, [key]: val }))
  }

  const applyPreset = (type: 'recommended' | 'all' | 'none') => {
    if (type === 'recommended') {
      setOptions({ cache: true, history: true, downloads: true, cookies: false, autofill: false, siteSettings: false, hostedAppData: false })
    } else if (type === 'all') {
      setOptions({ cache: true, history: true, downloads: true, cookies: true, autofill: true, siteSettings: true, hostedAppData: true })
    } else {
      setOptions({ cache: false, history: false, downloads: false, cookies: false, autofill: false, siteSettings: false, hostedAppData: false })
    }
  }

  async function handleClear(): Promise<void> {
    if (!targetProfiles.length || !hasAnySelected) return
    setBusy(true)
    setError('')

    const failures: { id: string; name: string; error: string }[] = []
    let successCount = 0

    for (const profile of targetProfiles) {
      try {
        await window.browserApi.profiles.clearData(profile.id, options)
        successCount++
      } catch (cause) {
        failures.push({
          id: profile.id,
          name: `#${profile.serialNumber} · ${profile.name}`,
          error: cause instanceof Error ? cause.message : String(cause)
        })
      }
    }

    setBusy(false)
    onClose()
    onCompleted({
      operation: '清理数据',
      total: targetProfiles.length,
      succeeded: successCount,
      errors: failures.map((f) => `${f.name}: ${f.error}`)
    })
  }

  return (
    <Modal
      open={open}
      title={<Space><ClearOutlined />{t("清理数据")}</Space>}
      okText={t("立即清理")}
      cancelText={t("取消")}
      okButtonProps={{ danger: true, disabled: !hasAnySelected || !targetProfiles.length, loading: busy }}
      cancelButtonProps={{ disabled: busy }}
      onCancel={() => { if (!busy) onClose() }}
      onOk={() => void handleClear()}
      width={560}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} orientation="vertical" size={14}>
        <div>
          <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>{t("目标范围")}</Typography.Text>
          <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)}>
            <Radio value="all">{t("全部环境 ({0} 个)", allProfiles.length)}</Radio>
            <Radio value="selected" disabled={selectedProfileIds.length === 0}>
              {t("当前选中环境 ({0} 个)", selectedProfileIds.length)}
            </Radio>
          </Radio.Group>
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Typography.Text strong>{t("清除项目 (可多选)")}</Typography.Text>
            <Space size={6}>
              <Button size="small" type="link" onClick={() => applyPreset('recommended')}>{t("推荐 (保留登录)")}</Button>
              <Button size="small" type="link" onClick={() => applyPreset('all')}>{t("全选")}</Button>
              <Button size="small" type="link" onClick={() => applyPreset('none')}>{t("清空")}</Button>
            </Space>
          </div>

          <Space direction="vertical" orientation="vertical" style={{ width: '100%', background: 'var(--surface-subtle)', padding: 12, borderRadius: 8 }} size={10}>
            <Checkbox checked={options.cache} onChange={(e) => setOpt('cache', e.target.checked)}>
              <strong>{t("缓存的图片和文件")}</strong>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t("释放磁盘空间并提升加载效率，不影响网站登录状态")}</div>
            </Checkbox>

            <Checkbox checked={options.history} onChange={(e) => setOpt('history', e.target.checked)}>
              <strong>{t("浏览历史记录")}</strong>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t("清除访问 URL 历史、常访网页与图标缓存")}</div>
            </Checkbox>

            <Checkbox checked={options.downloads} onChange={(e) => setOpt('downloads', e.target.checked)}>
              <strong>{t("下载记录")}</strong>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t("仅清除浏览器内部下载列表记录，不会删除磁盘上的实际文件")}</div>
            </Checkbox>

            <Checkbox checked={options.cookies} onChange={(e) => setOpt('cookies', e.target.checked)}>
              <strong style={{ color: options.cookies ? '#cf1322' : undefined }}>{t("Cookie 及其他网站数据")}</strong>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t("退出绝大多数网站的登录状态，重置本地存储与 IndexedDB (请谨慎勾选)")}</div>
            </Checkbox>

            <Checkbox checked={options.autofill} onChange={(e) => setOpt('autofill', e.target.checked)}>
              <strong>{t("自动填充表单数据")}</strong>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t("清除历史搜索建议、表单输入框记忆与自动填充数据")}</div>
            </Checkbox>

            <Checkbox checked={options.siteSettings} onChange={(e) => setOpt('siteSettings', e.target.checked)}>
              <strong>{t("网站设置与权限")}</strong>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t("重置各网站的权限配置（如麦克风、摄像头、通知、弹窗等）")}</div>
            </Checkbox>

            <Checkbox checked={options.hostedAppData} onChange={(e) => setOpt('hostedAppData', e.target.checked)}>
              <strong>{t("扩展应用数据")}</strong>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t("清除已安装浏览器扩展的本地设置与状态数据")}</div>
            </Checkbox>
          </Space>
        </div>

        {options.cookies && (
          <Alert
            type="warning"
            showIcon
            icon={<ExclamationCircleOutlined />}
            description={t("已勾选“Cookie 及其他网站数据”：执行后目标环境所有网站账号需要重新登录。")}
          />
        )}

        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {t("提示：正在运行中的环境需先关闭，以释放数据库与存储锁。")}
        </Typography.Text>

        {error && <Alert type="error" showIcon message={error} />}
      </Space>
    </Modal>
  )
}
