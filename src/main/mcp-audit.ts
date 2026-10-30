import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { safeErrorText } from './redaction'

export type McpAuditAction =
  | 'permission-enable'
  | 'permission-disable'
  | 'permission-inherit'
  | 'policy-update'
  | 'profile-create'
  | 'profiles-create-batch'
  | 'profiles-list'
  | 'task-create'
  | 'tasks-list'
  | 'task-close'
  | 'profile-status'
  | 'profile-launch'
  | 'profile-close'
  | 'page-open'
  | 'page-read'
  | 'page-text'
  | 'page-attribute'
  | 'page-markdown'
  | 'page-table'
  | 'page-list'
  | 'page-find'
  | 'page-schema'
  | 'page-navigate'
  | 'page-back'
  | 'page-forward'
  | 'page-reload'
  | 'page-hover'
  | 'page-select-option'
  | 'page-scroll-into-view'
  | 'page-keys'
  | 'page-dialog'
  | 'page-full-screenshot'
  | 'page-wait-stable'
  | 'page-wait-element'
  | 'page-wait-text'
  | 'page-wait-url'
  | 'page-wait-download'
  | 'network-list'
  | 'network-get'
  | 'network-har-start'
  | 'network-har-stop'
  | 'network-offline'
  | 'page-click'
  | 'page-click-wait'
  | 'page-set-checked'
  | 'page-set-input-files'
  | 'page-type'
  | 'page-targets'
  | 'page-select'
  | 'page-wait'
  | 'page-screenshot'
  | 'page-click-and-hold'
  | 'page-drag'
  | 'page-rect'
  | 'page-click-point'
  | 'page-scroll'
  | 'page-key'
  | 'session-start'
  | 'session-stop'
  | 'emergency-stop'

export interface McpAuditEvent {
  action: McpAuditAction
  outcome: 'allowed' | 'success' | 'failure'
  profileId?: string
  profileIds?: string[]
  requestId?: string
  connectionId?: string
  taskSessionId?: string
  detail?: string
}

export class McpAuditLog {
  readonly path: string
  private queue: Promise<void> = Promise.resolve()

  constructor(vaultPath: string) {
    this.path = join(vaultPath, 'logs', 'mcp-audit.jsonl')
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    try {
      if ((await stat(this.path)).size >= 10 * 1024 * 1024) await rename(this.path, `${this.path}.previous`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writeFile(this.path, '', { flag: 'a', mode: 0o600 })
  }

  record(event: McpAuditEvent): void {
    const safe = {
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      ...event,
      profileId: event.profileId?.slice(0, 100),
      profileIds: event.profileIds?.slice(0, 50).map((id) => id.slice(0, 100)),
      requestId: event.requestId?.slice(0, 100),
      connectionId: event.connectionId?.slice(0, 100),
      taskSessionId: event.taskSessionId?.slice(0, 100),
      detail: event.detail ? safeErrorText(event.detail).slice(0, 300) : undefined
    }
    this.queue = this.queue
      .then(() => writeFile(this.path, `${JSON.stringify(safe)}\n`, { flag: 'a', encoding: 'utf8', mode: 0o600 }))
      .catch(() => undefined)
  }

  flush(): Promise<void> {
    return this.queue
  }
}
