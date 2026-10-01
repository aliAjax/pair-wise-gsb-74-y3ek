import type {
  ContractDifference,
  GovernanceState,
  ReleaseCandidate,
} from '@/models/domain'
import {
  CURRENT_SCHEMA_VERSION,
  eventContractFingerprint,
  isEmptyDifference,
  releaseScopeFingerprint,
} from '@/services/contractVersion'
import { createSeedState } from '@/models/seed'

const STORAGE_KEY = 'eventrail-governance-v1'
const STAGING_KEY = `${STORAGE_KEY}-staging`

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const assertCompleteState = (value: unknown): GovernanceState => {
  if (!isObject(value)) throw new Error('持久化内容不是有效对象')
  const state = value as unknown as GovernanceState
  const requiredArrays: Array<keyof GovernanceState> = [
    'events',
    'scenarios',
    'dependencies',
    'baselines',
    'releases',
    'deprecations',
    'rollbacks',
    'audit',
  ]
  requiredArrays.forEach((key) => {
    if (!Array.isArray(state[key])) {
      throw new Error(`持久化状态缺少完整字段：${String(key)}`)
    }
  })
  if (typeof state.currentVersion !== 'string') {
    throw new Error('持久化状态缺少完整字段：currentVersion')
  }
  return state
}

const completeDifference = (difference: Partial<ContractDifference>): ContractDifference => ({
  eventId: difference.eventId ?? '',
  eventKey: difference.eventKey ?? '',
  addedProperties: difference.addedProperties ?? [],
  removedProperties: difference.removedProperties ?? [],
  requiredChanges: difference.requiredChanges ?? [],
  typeChanges: difference.typeChanges ?? [],
  enumChanges: difference.enumChanges ?? [],
  platformChanges: difference.platformChanges ?? [],
})

const completeRelease = (release: Partial<ReleaseCandidate>): ReleaseCandidate =>
  ({
    ...release,
    affectedDependencyIds: release.affectedDependencyIds ?? [],
    differences: (release.differences ?? []).map(completeDifference),
    migrationConfirmations: (release.migrationConfirmations ?? []).map((confirmation) => ({
      ...confirmation,
      history: confirmation.history ?? [],
    })),
    approvals: (release.approvals ?? []).map((approval) => ({
      ...approval,
      history: approval.history ?? [],
    })),
  }) as ReleaseCandidate

/**
 * 旧数据没有版本指纹：首次打开时按当前契约回填。
 * 事件固化当前指纹；候选若没有任何实质差异，视为与当前契约一致并固化指纹，
 * 仍有差异的候选不回填指纹，由评审窗口首次打开时按最新契约重算。
 * 迁移确认记录保留，但只对其所属版本有效。
 */
const migrateLegacyState = (state: GovernanceState): GovernanceState => {
  const migrated: GovernanceState = {
    ...state,
    events: state.events.map((event) => ({
      ...event,
      contractFingerprint: event.contractFingerprint ?? eventContractFingerprint(event),
    })),
    releases: state.releases.map(completeRelease),
    schemaVersion: CURRENT_SCHEMA_VERSION,
  }

  migrated.releases = migrated.releases.map((release) => {
    if (release.contractFingerprint) return release
    const differences = release.differences.map(completeDifference)
    const hasRealDifference = differences.some((difference) => !isEmptyDifference(difference))
    return hasRealDifference
      ? { ...release, differences }
      : { ...release, differences, contractFingerprint: releaseScopeFingerprint(migrated, release.eventIds) }
  })

  return migrated
}

/** 恢复路径：暂存完整则前滚提交；暂存损坏则丢弃并保留已提交版本；提交也损坏则重建 */
const recoverFromStorage = (): GovernanceState | null => {
  const staging = localStorage.getItem(STAGING_KEY)
  if (staging) {
    try {
      const candidate = assertCompleteState(JSON.parse(staging))
      localStorage.setItem(STORAGE_KEY, JSON.stringify(candidate))
      localStorage.removeItem(STAGING_KEY)
      return candidate
    } catch {
      localStorage.removeItem(STAGING_KEY)
    }
  }
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      return assertCompleteState(JSON.parse(raw))
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    }
  }
  return null
}

export const loadState = (): GovernanceState => {
  const recovered = recoverFromStorage()
  if (!recovered) {
    const seed = migrateLegacyState(createSeedState())
    commitState(seed)
    return seed
  }
  if (recovered.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    const migrated = migrateLegacyState(recovered)
    commitState(migrated)
    return migrated
  }
  return recovered
}

const commitState = (state: GovernanceState): void => {
  // 契约快照与依赖状态在同一序列化负载内原子提交：先写暂存、回读校验，再替换正式键。
  // JSON 序列化同时承担深拷贝职责，Vue 响应式代理与 undefined 字段都会被安全归一化。
  const payload = JSON.stringify(state)
  assertCompleteState(JSON.parse(payload))
  localStorage.setItem(STAGING_KEY, payload)
  const staged = localStorage.getItem(STAGING_KEY)
  if (staged !== payload) throw new Error('暂存状态写入不完整，已放弃提交')
  localStorage.setItem(STORAGE_KEY, staged)
  localStorage.removeItem(STAGING_KEY)
}

export const saveState = (state: GovernanceState): void => {
  commitState(state)
}

export const resetState = (): GovernanceState => {
  const seed = migrateLegacyState(createSeedState())
  commitState(seed)
  return seed
}

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
