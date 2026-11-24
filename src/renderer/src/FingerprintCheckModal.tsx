import { t, getLocale, translateMessage as mt } from '../../shared/i18n'
import { CheckCircleFilled, CloseCircleFilled, InfoCircleFilled } from '@ant-design/icons'
import { Alert, List, Modal, Space, Tag, Typography } from 'antd'
import type { BrowserProfileView } from '../../shared/types'
import type { FingerprintCheckReport } from '../../shared/fingerprint-check'

interface FingerprintCheckModalProps {
  profile?: BrowserProfileView
  report?: FingerprintCheckReport
  open: boolean
  onClose: () => void
}

export function FingerprintCheckModal({ profile, report, open, onClose }: FingerprintCheckModalProps) {
  const statusView = {
    match: { color: 'success', text: t("一致"), icon: <CheckCircleFilled /> },
    mismatch: { color: 'error', text: t("偏差"), icon: <CloseCircleFilled /> },
    info: { color: 'default', text: t("信息"), icon: <InfoCircleFilled /> }
  } as const

  const alertConfig = report
    ? report.overallStatus === 'pass'
      ? { type: 'success' as const, title: t("运行时指纹与预期配置一致") }
      : report.overallStatus === 'fail'
        ? { type: 'error' as const, title: t("存在运行时指纹偏差或泄漏风险") }
        : { type: 'warning' as const, title: t("当前为兼容模式，仅完成基础信息采集") }
    : null

  return (
    <Modal open={open} title={t("指纹自检{0}", profile ? ` · ${profile.name}` : '')} footer={null} onCancel={onClose} width={640} destroyOnHidden>
      {report && alertConfig && (
        <>
          <Alert
            type={alertConfig.type}
            showIcon
            title={alertConfig.title}
            description={report.summary.highlights.length ? report.summary.highlights.join('；') : undefined}
          />
          <List
            className="diagnostics-list"
            dataSource={report.checks}
            renderItem={(check) => {
              const view = statusView[check.status]
              return (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Space>
                        <Tag color={view.color} icon={view.icon}>{view.text}</Tag>
                        <Typography.Text strong>{mt(check.label)}</Typography.Text>
                      </Space>
                    }
                    description={
                      <Space direction="vertical" size={2}>
                        <Typography.Text type="secondary">{t("预期：{0}", check.expected)}</Typography.Text>
                        <Typography.Text>{t("实测：{0}", check.runtime)}</Typography.Text>
                        {check.detail ? <Typography.Text type="danger">{mt(check.detail)}</Typography.Text> : null}
                      </Space>
                    }
                  />
                </List.Item>
              )
            }}
          />
          <Typography.Text type="secondary">{t("检查时间：{0}", new Date(report.checkedAt).toLocaleString(getLocale()))}</Typography.Text>
        </>
      )}
    </Modal>
  )
}
