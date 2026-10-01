import type { GovernanceState } from '@/models/domain'
import { contractFingerprint } from '@/services/selectors'

/** 存储信封版本，裸数据（旧版本直接写入的 GovernanceState）视为版本 0 */
export const STORAGE_SCHEMA_VERSION = 1

export interface StateEnvelope {
  meta: {
    schema: typeof STORAGE_SCHEMA_VERSION
    checksum: string
    writtenAt: string
  }
  state: GovernanceState
}

export interface MigrationResult {
  state: GovernanceState
  backfilled: boolean
  changes: string[]
}

/**
 * 旧数据没有版本指纹：首次打开时按当前契约回填候选指纹，
 * 迁移确认只对当前版本有效，其他版本的旧确认一律作废并保留处理记录。
 */
export const migrateState = (raw: unknown): MigrationResult => {
  const state = structuredClone(raw) as GovernanceState
  const changes: string[] = []

  state.releases.forEach((release) => {
    if (!release.contractFingerprint) {
      release.contractFingerprint = contractFingerprint(state, release.eventIds)
      changes.push(`发布候选 ${release.version} 已按当前契约回填版本指纹`)
    }

    const now = new Date().toISOString()
    release.migrationConfirmations.forEach((confirmation) => {
      if (confirmation.version !== release.version && confirmation.status !== 'pending') {
        confirmation.status = 'pending'
        confirmation.invalidatedAt ??= now
        confirmation.invalidatedReason ??= `迁移确认仅对 ${release.version} 当前版本有效`
        changes.push(`下游迁移确认（${confirmation.dependencyId}）不属于 ${release.version}，已作废重算`)
      }
    })

    release.approvals.forEach((approval) => {
      if (approval.invalidatedAt && approval.status !== 'pending') {
        approval.status = 'pending'
      }
    })
  })

  return { state, backfilled: changes.length > 0, changes }
}

export const isEnvelope = (value: unknown): value is StateEnvelope => {
  if (typeof value !== 'object' || value === null) return false
  const envelope = value as Partial<StateEnvelope>
  return (
    envelope.meta?.schema === STORAGE_SCHEMA_VERSION &&
    typeof envelope.meta.checksum === 'string' &&
    typeof envelope.state === 'object' &&
    envelope.state !== null &&
    Array.isArray(envelope.state.events)
  )
}

export const isBareState = (value: unknown): value is GovernanceState => {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Partial<GovernanceState>
  return Array.isArray(state.events) && Array.isArray(state.releases)
}
