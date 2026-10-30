import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { McpPolicy, McpProfilePermission } from '../shared/types'

const DEFAULT_POLICY: McpPolicy = { enabled: false, defaultAccess: 'deny', allowProfileCreation: false }

function validatePolicy(value: unknown): McpPolicy {
  const p = value as Partial<McpPolicy>
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('MCP 访问策略格式无效')
  return {
    enabled: p.enabled === true,
    defaultAccess: p.defaultAccess === 'allow' ? 'allow' : 'deny',
    allowProfileCreation: p.allowProfileCreation === true
  }
}

interface StoredPermissions {
  schemaVersion: 1 | 2
  permissions: McpProfilePermission[]
  policy?: McpPolicy
}

function validatePermission(value: unknown): McpProfilePermission {
  const permission = value as Partial<McpProfilePermission>
  if (!permission || typeof permission.profileId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(permission.profileId)
    || typeof permission.enabled !== 'boolean' || typeof permission.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(permission.updatedAt))) throw new Error('MCP 环境权限记录无效')
  return permission as McpProfilePermission
}

export class McpPermissionStore {
  readonly path: string
  readonly backupPath: string
  private permissions = new Map<string, McpProfilePermission>()
  private policy: McpPolicy = { ...DEFAULT_POLICY }
  private mutation: Promise<unknown> = Promise.resolve()

  constructor(vaultPath: string, private readonly now: () => Date = () => new Date()) {
    this.path = join(vaultPath, 'mcp', 'permissions.json')
    this.backupPath = `${this.path}.backup`
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    try {
      await this.load(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { await this.load(this.backupPath); await this.persist(false) }
        catch (backupError) {
          if ((backupError as NodeJS.ErrnoException).code !== 'ENOENT') throw backupError
          await this.persist()
        }
        return
      }
      await this.load(this.backupPath)
      await this.persist(false)
    }
  }

  list(): McpProfilePermission[] {
    return [...this.permissions.values()].sort((first, second) => first.profileId.localeCompare(second.profileId)).map((item) => ({ ...item }))
  }

  getPolicy(): McpPolicy { return { ...this.policy } }

  enabled(profileId: string): boolean {
    return this.policy.enabled && (this.permissions.get(profileId)?.enabled ?? this.policy.defaultAccess === 'allow')
  }

  override(profileId: string): boolean | undefined { return this.permissions.get(profileId)?.enabled }

  setPolicy(patch: Partial<McpPolicy>): Promise<McpPolicy> {
    return this.mutate(async () => {
      this.policy = validatePolicy({ ...this.policy, ...patch })
      await this.persist()
      return this.getPolicy()
    })
  }

  resetOverrides(): Promise<McpProfilePermission[]> {
    return this.mutate(async () => {
      this.permissions.clear()
      await this.persist()
      return this.list()
    })
  }

  prune(keep: (profileId: string) => boolean): Promise<number> {
    return this.mutate(async () => {
      const orphaned = [...this.permissions.keys()].filter((profileId) => !keep(profileId))
      if (!orphaned.length) return 0
      for (const profileId of orphaned) this.permissions.delete(profileId)
      await this.persist()
      return orphaned.length
    })
  }

  set(profileId: string, enabled: boolean): Promise<McpProfilePermission[]> {
    return this.mutate(async () => {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(profileId) || typeof enabled !== 'boolean') throw new Error('MCP 环境权限参数无效')
      this.permissions.set(profileId, { profileId, enabled, updatedAt: this.now().toISOString() })
      await this.persist()
      return this.list()
    })
  }

  remove(profileId: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.permissions.delete(profileId)) return
      await this.persist()
    })
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.mutation.then(operation, operation)
    this.mutation = current.then(() => undefined, () => undefined)
    return current
  }

  private async load(path: string): Promise<void> {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<StoredPermissions>
    if (![1, 2].includes(value.schemaVersion as number) || !Array.isArray(value.permissions) || value.permissions.length > 1e5) throw new Error('MCP 权限文件格式无效')
    const permissions = value.permissions.map(validatePermission)
    if (new Set(permissions.map((item) => item.profileId)).size !== permissions.length) throw new Error('MCP 权限文件包含重复环境')
    this.permissions = new Map(permissions.map((item) => [item.profileId, item]))
    this.policy = value.policy === undefined && value.schemaVersion === 1 ? { ...DEFAULT_POLICY } : validatePolicy(value.policy)
  }

  private async persist(backupExisting = true): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    if (backupExisting) {
      try { await access(this.path); await copyFile(this.path, this.backupPath) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const temporary = `${this.path}.tmp`
    const value: StoredPermissions = { schemaVersion: 2, permissions: this.list(), policy: this.getPolicy() }
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
  }
}
