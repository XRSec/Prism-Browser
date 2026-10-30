import { t, translateMessage as mt } from '../../shared/i18n'
import { Alert, List, Modal, Typography } from 'antd'

export interface BatchOperationResult {
  operation: '启动' | '关闭' | '清理缓存'
  total: number
  succeeded: number
  errors: string[]
}

interface BatchResultModalProps {
  result?: BatchOperationResult
  onClose: () => void
}

export function BatchResultModal({ result, onClose }: BatchResultModalProps) {
  return (
    <Modal open={Boolean(result)} title={t("批量操作结果")} footer={null} onCancel={onClose} destroyOnHidden>
      {result && (
        <>
          <Alert
            type={result.errors.length ? 'warning' : 'success'}
            showIcon
            title={t("批量{0}完成：成功 {1}，失败 {2}", t(result.operation), result.succeeded, result.errors.length)}
          />
          {result.errors.length > 0 && (
            <List
              dataSource={result.errors}
              renderItem={(error) => (
                <List.Item>
                  <Typography.Text type="danger" copyable>{mt(error)}</Typography.Text>
                </List.Item>
              )}
            />
          )}
        </>
      )}
    </Modal>
  )
}
