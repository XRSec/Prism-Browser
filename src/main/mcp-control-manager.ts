import { randomUUID } from 'node:crypto'
import type { BrowserProfile, McpPolicy, McpProfilePermission, McpStatus } from '../shared/types'
import type { BrowserLauncher } from './browser-launcher'
import type { McpAuditAction, McpAuditLog } from './mcp-audit'
import type { McpPermissionStore } from './mcp-permission-store'
import type { ProfileCreationService } from './profile-creation-service'
import type { ProfileStore } from './profile-store'
import { safeErrorText } from './redaction'

interface McpLicenseAuthority {
  has(entitlement: 'mcp'): boolean
}

export class McpControlError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly suggestedTool?: string

  constructor(code: string, message: string, retryable = false, suggestedTool?: string) {
    super(message)
    this.code = code
    this.retryable = retryable
    this.suggestedTool = suggestedTool
    this.name = 'McpControlError'
  }
}

const notAllowed = () => new McpControlError('PROFILE_NOT_ALLOWED', '该环境尚未允许本地 AI 控制')

function publicMcpProfile(profile: BrowserProfile) {
  return {
    id: profile.id,
    serialNumber: profile.serialNumber,
    name: profile.name,
    group: profile.group,
    tags: [...profile.tags],
    status: profile.status,
    lastOpenedAt: profile.lastOpenedAt
  }
}

interface PageControllerLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [method: string]: any
  release(): Promise<void>
  cancelPendingInput?(force?: boolean): void
}

interface McpTaskSession {
  id: string
  connectionId: string
  profileId: string
  implicit: boolean
  createdAt: string
  lastActivityAt: string
  controller: PageControllerLike
  queue: Promise<unknown>
  closed: boolean
}

interface McpSessionConnection {
  id: string
  tasks: Map<string, McpTaskSession>
  implicitTasks: Map<string, string>
}

export class McpControlManager {
  private controlled = new Set<string>()
  private profileCreator?: ProfileCreationService
  private sessions = new Map<string, McpSessionConnection>()
  private profileLeases = new Map<string, Set<string>>()

  constructor(
    private readonly permissions: McpPermissionStore,
    private readonly profiles: ProfileStore,
    private readonly launcher: BrowserLauncher,
    private readonly licensing: McpLicenseAuthority,
    private readonly audit: McpAuditLog,
    private readonly onChanged: (status: McpStatus) => void
  ) {}

  setProfileCreator(creator: ProfileCreationService): void {
    this.profileCreator = creator
  }

  async initialize(): Promise<void> {
    await this.permissions.initialize()
  }

  permissionList(): McpProfilePermission[] {
    return this.permissions.list()
  }

  async setPermission(profileId: string, enabled: boolean | null): Promise<McpProfilePermission[]> {
    this.profiles.get(profileId)
    const result = await this.permissions.set(profileId, enabled)
    if (!this.permissions.enabled(profileId)) await this.releaseProfileTasks(profileId)
    this.audit.record({
      action: enabled === null ? 'permission-inherit' : enabled ? 'permission-enable' : 'permission-disable',
      outcome: 'success',
      profileId
    })
    this.changed()
    return result
  }

  async setPolicy(patch: Partial<McpPolicy>): Promise<McpStatus> {
    await this.permissions.setPolicy(patch)
    const revoked = [...this.profileLeases.keys()].filter((id) => !this.permissions.enabled(id))
    await Promise.allSettled(revoked.map((id) => this.releaseProfileTasks(id)))
    this.audit.record({ action: 'policy-update', outcome: 'success' })
    this.changed()
    return this.status()
  }

  async resetPermissions(): Promise<McpProfilePermission[]> {
    const result = await this.permissions.resetOverrides()
    await Promise.allSettled(
      [...this.profileLeases.keys()]
        .filter((id) => !this.permissions.enabled(id))
        .map((id) => this.releaseProfileTasks(id))
    )
    this.audit.record({ action: 'permission-inherit', outcome: 'success' })
    this.changed()
    return result
  }

  canStart(): boolean {
    const policy = this.permissions.getPolicy()
    return policy.enabled && (policy.allowProfileCreation || this.profiles.list().some((profile) => this.permissions.enabled(profile.id)))
  }

  async removeProfile(profileId: string): Promise<void> {
    await this.releaseProfileTasks(profileId)
    if (this.permissions.override(profileId) === true) await this.permissions.remove(profileId)
  }

  async pruneOrphanedPermissions(knownProfileIds: Iterable<string>): Promise<void> {
    const known = new Set(knownProfileIds)
    for (const profile of this.profiles.list()) known.add(profile.id)
    if (await this.permissions.prune((profileId) => known.has(profileId))) this.changed()
  }

  status(agentRunning = this.sessions.size > 0): McpStatus {
    const policy = this.permissions.getPolicy()
    const enabledProfileIds = this.profiles.list().filter((profile) => this.permissions.enabled(profile.id)).map((profile) => profile.id)
    return {
      policy,
      state: !policy.enabled ? 'stopped' : this.sessions.size ? 'running' : agentRunning ? 'ready' : 'stopped',
      message: !policy.enabled
        ? 'MCP 全局开关已关闭'
        : this.sessions.size
          ? `${this.sessions.size} 个本地 AI 客户端已连接 MCP`
          : agentRunning
            ? 'MCP 连接配置已就绪，等待本地 AI 连接'
            : '本地 MCP 会话未启动',
      enabledProfileIds,
      controlledProfileIds: [...this.controlled]
    }
  }

  resetSessions(): void {
    if (!this.sessions.size) return
    const tasks = [...this.sessions.values()].flatMap((connection) => [...connection.tasks.values()])
    this.sessions.clear()
    this.profileLeases.clear()
    void Promise.allSettled(tasks.map((task) => this.releaseTask(task)))
    this.changed()
  }

  async handleAgentRequest(method: string, params: Record<string, unknown> | undefined, requestId: string): Promise<unknown> {
    if (!this.permissions.getPolicy().enabled && method !== 'mcp.session.stop') {
      throw new McpControlError('MCP_GLOBAL_DISABLED', 'MCP is disabled by the user; enable it in Prism settings')
    }
    if (method === 'mcp.session.start' || method === 'mcp.session.stop') {
      const sessionId = params?.sessionId
      if (typeof sessionId !== 'string' || !/^[a-f\d-]{36}$/i.test(sessionId)) throw new Error('MCP 会话 ID 无效')
      if (method === 'mcp.session.start') {
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, { id: sessionId, tasks: new Map(), implicitTasks: new Map() })
        }
      } else {
        await this.releaseConnection(sessionId)
      }
      this.audit.record({ action: method === 'mcp.session.start' ? 'session-start' : 'session-stop', outcome: 'success', requestId: sessionId })
      this.changed()
      return this.status()
    }

    const profileId = params?.profileId
    const action: McpAuditAction | null =
      method === 'mcp.profiles.create' ? 'profile-create'
      : method === 'mcp.profiles.createBatch' ? 'profiles-create-batch'
      : method === 'mcp.profiles.list' ? 'profiles-list'
      : method === 'mcp.tasks.create' ? 'task-create'
      : method === 'mcp.tasks.list' ? 'tasks-list'
      : method === 'mcp.tasks.close' ? 'task-close'
      : method === 'mcp.profiles.status' ? 'profile-status'
      : method === 'mcp.profiles.launch' ? 'profile-launch'
      : method === 'mcp.profiles.close' ? 'profile-close'
      : method === 'mcp.pages.open' ? 'page-open'
      : method === 'mcp.pages.read' ? 'page-read'
      : method === 'mcp.pages.text' ? 'page-text'
      : method === 'mcp.pages.attribute' ? 'page-attribute'
      : method === 'mcp.pages.markdown' ? 'page-markdown'
      : method === 'mcp.pages.table' ? 'page-table'
      : method === 'mcp.pages.list' ? 'page-list'
      : method === 'mcp.pages.find' ? 'page-find'
      : method === 'mcp.pages.schema' ? 'page-schema'
      : method === 'mcp.pages.navigate' ? 'page-navigate'
      : method === 'mcp.pages.back' ? 'page-back'
      : method === 'mcp.pages.forward' ? 'page-forward'
      : method === 'mcp.pages.reload' ? 'page-reload'
      : method === 'mcp.pages.hover' ? 'page-hover'
      : method === 'mcp.pages.selectOption' ? 'page-select-option'
      : method === 'mcp.pages.scrollIntoView' ? 'page-scroll-into-view'
      : method === 'mcp.pages.keys' ? 'page-keys'
      : method === 'mcp.pages.dialog' ? 'page-dialog'
      : method === 'mcp.pages.fullScreenshot' ? 'page-full-screenshot'
      : method === 'mcp.pages.waitStable' ? 'page-wait-stable'
      : method === 'mcp.pages.waitElement' ? 'page-wait-element'
      : method === 'mcp.pages.waitText' ? 'page-wait-text'
      : method === 'mcp.pages.waitUrl' ? 'page-wait-url'
      : method === 'mcp.pages.waitDownload' ? 'page-wait-download'
      : method === 'mcp.network.list' ? 'network-list'
      : method === 'mcp.network.get' ? 'network-get'
      : method === 'mcp.network.harStart' ? 'network-har-start'
      : method === 'mcp.network.harStop' ? 'network-har-stop'
      : method === 'mcp.network.offline' ? 'network-offline'
      : method === 'mcp.pages.click' ? 'page-click'
      : method === 'mcp.pages.clickAndWait' ? 'page-click-wait'
      : method === 'mcp.pages.setChecked' ? 'page-set-checked'
      : method === 'mcp.pages.setInputFiles' ? 'page-set-input-files'
      : method === 'mcp.pages.type' ? 'page-type'
      : method === 'mcp.pages.targets' ? 'page-targets'
      : method === 'mcp.pages.select' ? 'page-select'
      : method === 'mcp.pages.wait' ? 'page-wait'
      : method === 'mcp.pages.screenshot' ? 'page-screenshot'
      : method === 'mcp.pages.clickAndHold' ? 'page-click-and-hold'
      : method === 'mcp.pages.drag' ? 'page-drag'
      : method === 'mcp.pages.rect' ? 'page-rect'
      : method === 'mcp.pages.clickPoint' ? 'page-click-point'
      : method === 'mcp.pages.scroll' ? 'page-scroll'
      : method === 'mcp.pages.key' ? 'page-key'
      : null

    if (!action) throw new Error('MCP 方法不在白名单中')

    try {
      const connectionId = this.connectionId(params)
      const connection = this.connection(connectionId)

      if (method === 'mcp.profiles.create' || method === 'mcp.profiles.createBatch') {
        const authorize = () => {
          const policy = this.permissions.getPolicy()
          if (!policy.enabled || !policy.allowProfileCreation) {
            throw new McpControlError('PROFILE_CREATION_DISABLED', 'Allow AI to create profiles in Prism MCP settings first')
          }
        }
        authorize()
        if (!this.profileCreator) throw new Error('Profile creation is unavailable')
        const created = await this.profileCreator.create(params?.input, method.endsWith('createBatch'), 'mcp', authorize)
        const result = created.map((profile) =>
          this.permissions.enabled(profile.id)
            ? { ...publicMcpProfile(profile), mcpEnabled: true }
            : { id: profile.id, serialNumber: profile.serialNumber, mcpEnabled: false }
        )
        this.audit.record({ action, outcome: 'success', requestId, profileIds: created.map((profile) => profile.id) })
        this.changed()
        return method.endsWith('createBatch') ? { profiles: result, count: result.length } : result[0]
      }

      if (method === 'mcp.tasks.list') {
        const result = [...connection.tasks.values()].map((task) => this.publicTask(task))
        this.audit.record({ action, outcome: 'success', requestId })
        return result
      }

      if (method === 'mcp.tasks.create') {
        if (typeof profileId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(profileId)) throw new Error('环境 ID 无效')
        if (!this.permissions.enabled(profileId)) throw notAllowed()
        if (params?.targetId !== undefined && (typeof params.targetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(params.targetId))) {
          throw new Error('页面目标 ID 无效')
        }
        const task = await this.createTask(connection, profileId, false)
        if (typeof params?.targetId === 'string') {
          try {
            await this.enqueue(task, () => task.controller.selectTarget(params.targetId))
          } catch (error) {
            await this.releaseTask(task)
            throw error
          }
        }
        this.controlled.add(profileId)
        this.changed()
        const result = this.publicTask(task)
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }

      if (method === 'mcp.tasks.close') {
        const taskSessionId = params?.taskSessionId
        if (typeof taskSessionId !== 'string' || !/^[a-f\d-]{36}$/i.test(taskSessionId)) throw new Error('MCP 任务会话 ID 无效')
        const task = connection.tasks.get(taskSessionId)
        if (!task) throw new McpControlError('TASK_SESSION_NOT_FOUND', 'MCP 任务会话不存在或不属于当前连接', false, 'prism_list_task_sessions')
        const result = this.publicTask(task)
        await this.releaseTask(task)
        this.audit.record({ action, outcome: 'success', requestId, profileId: task.profileId })
        return { ...result, state: 'closed' }
      }

      if (method === 'mcp.profiles.list') {
        this.audit.record({ action, outcome: 'allowed', requestId })
        const result = this.profiles.list().filter((profile) => this.permissions.enabled(profile.id)).map(publicMcpProfile)
        this.audit.record({ action, outcome: 'success', requestId })
        return result
      }

      if (typeof profileId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(profileId)) throw new Error('环境 ID 无效')
      if (!this.permissions.enabled(profileId)) throw notAllowed()
      this.audit.record({ action, outcome: 'allowed', requestId, profileId })

      const pageTask = method.startsWith('mcp.pages.') || method.startsWith('mcp.network.')
        ? await this.taskFor(connection, profileId, params?.taskSessionId)
        : undefined

      if (method === 'mcp.profiles.status') {
        const result = publicMcpProfile(this.profiles.get(profileId))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.profiles.launch') {
        const profile = await this.launcher.launch(profileId)
        this.controlled.add(profileId)
        this.changed()
        const result = publicMcpProfile(profile)
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.open') {
        if (typeof params?.url !== 'string') throw new Error('网页地址无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.open(params.url))
        this.controlled.add(profileId)
        this.changed()
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.read') {
        if (params?.cursor !== undefined && typeof params.cursor !== 'string') throw new Error('页面快照游标无效')
        if (params?.pageSize !== undefined && !Number.isInteger(params.pageSize)) throw new Error('页面快照分页数量无效')
        if (params?.previousSnapshotId !== undefined && typeof params.previousSnapshotId !== 'string') throw new Error('页面增量快照 ID 无效')
        if (params?.compact !== undefined && typeof params.compact !== 'boolean') throw new Error('页面紧凑读取参数无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.snapshot({
          cursor: params?.cursor,
          pageSize: params?.pageSize,
          previousSnapshotId: params?.previousSnapshotId,
          compact: params?.compact
        }))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.text') {
        if (params?.ref !== undefined && typeof params.ref !== 'string') throw new Error('页面元素引用无效')
        if (params?.maxChars !== undefined && !Number.isInteger(params.maxChars)) throw new Error('页面读取字符数无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.readText({ ref: params?.ref, maxChars: params?.maxChars }))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.attribute') {
        if (typeof params?.ref !== 'string' || typeof params?.name !== 'string') throw new Error('页面属性读取参数无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.readAttribute(params.ref, params.name))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.markdown') {
        if (params?.maxChars !== undefined && !Number.isInteger(params.maxChars)) throw new Error('Markdown 读取字符数无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.readMarkdown({ maxChars: params?.maxChars }))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.table') {
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.readTable({
          ref: params?.ref,
          index: params?.index,
          maxRows: params?.maxRows,
          maxColumns: params?.maxColumns
        }))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.list') {
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.readList({
          ref: params?.ref,
          index: params?.index,
          maxItems: params?.maxItems
        }))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.find') {
        if (typeof params?.query !== 'string') throw new Error('页面查找文本无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.find(params.query, params?.maxResults))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.schema') {
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.pageSchema())
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.navigate') {
        if (typeof params?.url !== 'string') throw new Error('网页地址无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.navigate(params.url))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.back' || method === 'mcp.pages.forward') {
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.history(method === 'mcp.pages.back' ? 'back' : 'forward'))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.reload') {
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.reload(params?.ignoreCache === true))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.hover' || method === 'mcp.pages.scrollIntoView') {
        if (typeof params?.ref !== 'string') throw new Error('页面元素引用无效')
        const result = await this.enqueue(pageTask!, () =>
          method === 'mcp.pages.hover' ? pageTask!.controller.hover(params.ref) : pageTask!.controller.scrollElementIntoView(params.ref)
        )
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.selectOption') {
        if (typeof params?.ref !== 'string' || !Array.isArray(params?.values) || params.values.some((value) => typeof value !== 'string')) {
          throw new Error('下拉选项参数无效')
        }
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.selectOptions(params.ref, params.values))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.keys') {
        if (typeof params?.shortcut !== 'string') throw new Error('组合键无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.pressKeys(params.shortcut, params.durationMs))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.dialog') {
        if (typeof params?.accept !== 'boolean' || (params?.promptText !== undefined && typeof params.promptText !== 'string')) {
          throw new Error('对话框处理参数无效')
        }
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.handleDialog(params.accept, params.promptText))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.fullScreenshot') {
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.fullPageScreenshot())
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.waitStable') {
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.waitForStable({
          timeoutMs: params?.timeoutMs,
          networkIdleMs: params?.networkIdleMs,
          domQuietMs: params?.domQuietMs
        }))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.waitElement') {
        if (typeof params?.query !== 'string') throw new Error('等待元素查询无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.waitForElement(params.query, { timeoutMs: params?.timeoutMs }))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.waitText') {
        if (typeof params?.text !== 'string') throw new Error('等待页面文本无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.waitForText(params.text, { timeoutMs: params?.timeoutMs }))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.waitUrl') {
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.waitForUrl({
          contains: params?.contains,
          equals: params?.equals,
          timeoutMs: params?.timeoutMs
        }))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.waitDownload') {
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.waitForDownload({
          filenameContains: params?.filenameContains,
          timeoutMs: params?.timeoutMs
        }))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.network.list') {
        const result = await this.enqueue(pageTask!, async () => pageTask!.controller.listNetworkRequests({
          resourceTypes: params?.resourceTypes,
          limit: params?.limit
        }))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.network.get') {
        if (typeof params?.id !== 'string') throw new Error('网络请求 ID 无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.networkRequest(params.id, params?.includeBody === true))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.network.harStart') {
        const result = await this.enqueue(pageTask!, async () => pageTask!.controller.startHar())
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.network.harStop') {
        const result = await this.enqueue(pageTask!, async () => pageTask!.controller.stopHar())
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.network.offline') {
        if (typeof params?.offline !== 'boolean') throw new Error('离线状态无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.setOffline(params.offline))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.click') {
        if (typeof params?.ref !== 'string') throw new Error('页面元素引用无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.click(params.ref))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.clickAndWait') {
        if (typeof params?.ref !== 'string') throw new Error('页面元素引用无效')
        if (params?.kind !== undefined && !['web', 'extension'].includes(String(params.kind))) throw new Error('页面目标类型无效')
        if (params?.titleContains !== undefined && typeof params.titleContains !== 'string') throw new Error('页面标题条件无效')
        if (params?.urlContains !== undefined && typeof params.urlContains !== 'string') throw new Error('页面地址条件无效')
        if (params?.timeoutMs !== undefined && !Number.isInteger(params.timeoutMs)) throw new Error('等待时间无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.clickAndWaitForTarget(params.ref, {
          kind: params?.kind,
          titleContains: params?.titleContains,
          urlContains: params?.urlContains,
          timeoutMs: params?.timeoutMs
        }))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.setChecked') {
        if (typeof params?.ref !== 'string' || typeof params?.checked !== 'boolean') throw new Error('页面选中状态参数无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.setChecked(params.ref, params.checked))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.setInputFiles') {
        if (typeof params?.ref !== 'string' || !Array.isArray(params?.paths) || params.paths.some((path) => typeof path !== 'string')) {
          throw new Error('页面上传文件参数无效')
        }
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.setInputFiles(params.ref, params.paths))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.type') {
        if (typeof params?.ref !== 'string' || typeof params?.text !== 'string'
          || (params.clear !== undefined && typeof params.clear !== 'boolean')) throw new Error('页面输入参数无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.type(params.ref, params.text, params.clear !== false))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.targets') {
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.listTargets())
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.select') {
        if (typeof params?.targetId !== 'string') throw new Error('页面目标 ID 无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.selectTarget(params.targetId))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.wait') {
        if (params?.kind !== undefined && !['web', 'extension'].includes(String(params.kind))) throw new Error('页面目标类型无效')
        if (params?.titleContains !== undefined && typeof params.titleContains !== 'string') throw new Error('页面标题条件无效')
        if (params?.urlContains !== undefined && typeof params.urlContains !== 'string') throw new Error('页面地址条件无效')
        if (params?.timeoutMs !== undefined && !Number.isInteger(params.timeoutMs)) throw new Error('等待时间无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.waitForTarget({
          kind: params?.kind,
          titleContains: params?.titleContains,
          urlContains: params?.urlContains,
          timeoutMs: params?.timeoutMs
        }))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.screenshot') {
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.screenshot())
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.clickAndHold' || method === 'mcp.pages.drag') {
        const input = method === 'mcp.pages.clickAndHold'
          ? { ref: params?.ref, x: params?.x, y: params?.y, durationMs: params?.durationMs, button: params?.button, pointerType: params?.pointerType }
          : { from: params?.from, to: params?.to, steps: params?.steps, durationMs: params?.durationMs, button: params?.button, pointerType: params?.pointerType }
        const result = await this.enqueue(pageTask!, () =>
          method === 'mcp.pages.clickAndHold' ? pageTask!.controller.clickAndHold(input) : pageTask!.controller.drag(input)
        )
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.rect') {
        if (typeof params?.ref !== 'string') throw new Error('Element ref is required')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.elementRect(params.ref))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.clickPoint') {
        if (typeof params?.x !== 'number' || typeof params?.y !== 'number') throw new Error('页面点击坐标无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.clickPoint(params.x, params.y))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.scroll') {
        if (typeof params?.deltaX !== 'number' || typeof params?.deltaY !== 'number') throw new Error('页面滚动距离无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.scroll(params.deltaX, params.deltaY))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }
      if (method === 'mcp.pages.key') {
        if (typeof params?.key !== 'string') throw new Error('页面按键无效')
        const result = await this.enqueue(pageTask!, () => pageTask!.controller.pressKey(params.key, params.durationMs))
        this.audit.record({ action, outcome: 'success', requestId, profileId })
        return result
      }

      await this.releaseImplicitTask(connection, profileId)
      if ((this.profileLeases.get(profileId)?.size ?? 0) > 0) {
        throw new McpControlError(
          'PROFILE_IN_USE',
          '该环境仍被一个或多个 MCP 任务会话使用，请先关闭对应任务会话',
          false,
          'prism_list_task_sessions'
        )
      }
      const profile = await this.launcher.close(profileId)
      this.controlled.delete(profileId)
      this.changed()
      const result = publicMcpProfile(profile)
      this.audit.record({ action, outcome: 'success', requestId, profileId })
      return result
    } catch (error) {
      this.audit.record({
        action,
        outcome: 'failure',
        requestId,
        profileId: typeof profileId === 'string' ? profileId : undefined,
        detail: safeErrorText(error)
      })
      throw error
    }
  }

  async emergencyStop(): Promise<McpStatus> {
    await this.releaseAllTasks()
    await Promise.allSettled([...this.controlled].map((profileId) => this.launcher.close(profileId)))
    this.controlled.clear()
    this.sessions.clear()
    this.profileLeases.clear()
    this.audit.record({ action: 'emergency-stop', outcome: 'success' })
    this.changed()
    return this.status(false)
  }

  async shutdown(): Promise<void> {
    await this.releaseAllTasks()
    this.sessions.clear()
    this.profileLeases.clear()
    await this.audit.flush()
  }

  private connectionId(params: Record<string, unknown> | undefined): string {
    const value = params?.connectionId
    if (value === undefined) return 'legacy-local-connection'
    if (typeof value !== 'string' || !/^[a-f\d-]{36}$/i.test(value)) {
      throw new McpControlError('INVALID_CONNECTION_SESSION', 'MCP 连接会话无效', true, 'prism_get_connection_status')
    }
    return value
  }

  private connection(id: string): McpSessionConnection {
    let connection = this.sessions.get(id)
    if (!connection) {
      connection = { id, tasks: new Map(), implicitTasks: new Map() }
      this.sessions.set(id, connection)
      this.changed()
    }
    return connection
  }

  private async createTask(connection: McpSessionConnection, profileId: string, implicit: boolean): Promise<McpTaskSession> {
    const launcherAny = this.launcher as unknown as {
      createPageControlSession?: (id: string) => Promise<PageControllerLike>
    }
    if (typeof launcherAny.createPageControlSession !== 'function') {
      throw new Error('当前内核会话不支持页面控制')
    }
    const controller = await launcherAny.createPageControlSession(profileId)
    if (!this.permissions.enabled(profileId) || this.sessions.get(connection.id) !== connection) {
      await controller.release()
      throw new McpControlError('MCP_PERMISSION_REVOKED', 'MCP permission changed while connecting to the profile')
    }
    const now = new Date().toISOString()
    const task: McpTaskSession = {
      id: randomUUID(),
      connectionId: connection.id,
      profileId,
      implicit,
      createdAt: now,
      lastActivityAt: now,
      controller,
      queue: Promise.resolve(),
      closed: false
    }
    connection.tasks.set(task.id, task)
    if (implicit) connection.implicitTasks.set(profileId, task.id)
    const leases = this.profileLeases.get(profileId) ?? new Set<string>()
    leases.add(task.id)
    this.profileLeases.set(profileId, leases)
    return task
  }

  private async taskFor(connection: McpSessionConnection, profileId: string, requestedTaskId: unknown): Promise<McpTaskSession> {
    if (requestedTaskId !== undefined) {
      if (typeof requestedTaskId !== 'string' || !/^[a-f\d-]{36}$/i.test(requestedTaskId)) throw new Error('MCP 任务会话 ID 无效')
      const task = connection.tasks.get(requestedTaskId)
      if (!task) throw new McpControlError('TASK_SESSION_NOT_FOUND', 'MCP 任务会话不存在或不属于当前连接', false, 'prism_list_task_sessions')
      if (task.profileId !== profileId) throw new McpControlError('TASK_PROFILE_MISMATCH', 'MCP 任务会话不属于指定环境')
      return task
    }
    const existingId = connection.implicitTasks.get(profileId)
    const existing = existingId ? connection.tasks.get(existingId) : undefined
    if (existing && !existing.closed) return existing
    return this.createTask(connection, profileId, true)
  }

  private enqueue<T>(task: McpTaskSession, operation: () => Promise<T>): Promise<T> {
    if (task.closed) return Promise.reject(new McpControlError('TASK_SESSION_CLOSED', 'MCP 任务会话已关闭'))
    const run = (): Promise<T> => {
      if (task.closed) throw new McpControlError('TASK_SESSION_CLOSED', 'MCP 任务会话已关闭')
      if (!this.permissions.enabled(task.profileId)) throw new McpControlError('MCP_PERMISSION_REVOKED', 'MCP permission was revoked')
      return operation()
    }
    const result = task.queue.then(run, run)
    task.queue = result.then(() => undefined, () => undefined)
    task.lastActivityAt = new Date().toISOString()
    return result
  }

  private publicTask(task: McpTaskSession) {
    return {
      taskSessionId: task.id,
      profileId: task.profileId,
      mode: task.implicit ? 'implicit-legacy' : 'explicit',
      state: task.closed ? 'closed' : 'active',
      createdAt: task.createdAt,
      lastActivityAt: task.lastActivityAt
    }
  }

  private async releaseTask(task: McpTaskSession): Promise<void> {
    if (task.closed) return
    task.closed = true
    task.controller.cancelPendingInput?.(true)
    await task.queue.catch(() => undefined)
    await task.controller.release()
    const connection = this.sessions.get(task.connectionId)
    connection?.tasks.delete(task.id)
    if (connection?.implicitTasks.get(task.profileId) === task.id) connection.implicitTasks.delete(task.profileId)
    const leases = this.profileLeases.get(task.profileId)
    leases?.delete(task.id)
    if (!leases?.size) this.profileLeases.delete(task.profileId)
  }

  private async releaseImplicitTask(connection: McpSessionConnection, profileId: string): Promise<void> {
    const taskId = connection.implicitTasks.get(profileId)
    const task = taskId ? connection.tasks.get(taskId) : undefined
    if (task) await this.releaseTask(task)
  }

  private async releaseConnection(connectionId: string): Promise<void> {
    const connection = this.sessions.get(connectionId)
    if (!connection) return
    await Promise.allSettled([...connection.tasks.values()].map((task) => this.releaseTask(task)))
    this.sessions.delete(connectionId)
  }

  private async releaseProfileTasks(profileId: string): Promise<void> {
    const tasks = [...this.sessions.values()]
      .flatMap((connection) => [...connection.tasks.values()])
      .filter((task) => task.profileId === profileId)
    await Promise.allSettled(tasks.map((task) => this.releaseTask(task)))
  }

  private async releaseAllTasks(): Promise<void> {
    const tasks = [...this.sessions.values()].flatMap((connection) => [...connection.tasks.values()])
    await Promise.allSettled(tasks.map((task) => this.releaseTask(task)))
  }

  private changed(): void {
    this.onChanged(this.status())
  }
}
