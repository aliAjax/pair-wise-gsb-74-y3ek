import type {
  GovernanceState,
  MigrationConfirmation,
  ReleaseApproval,
  ReleaseCandidate,
} from '@/models/domain'
import { createId } from '@/services/repository'
import {
  affectedDependencies,
  contractDifferences,
} from '@/services/selectors'
import {
  findVersionOwner,
  isEmptyDifference,
  releaseScopeFingerprint,
} from '@/services/contractVersion'

export interface CreateReleaseResult {
  release?: ReleaseCandidate
  /** 同版本已有候选先行放行时，返回该候选 */
  duplicateOf?: ReleaseCandidate
  duplicateRecord?: ReleaseCandidate
}

const APPROVAL_SEED: Array<Pick<ReleaseApproval, 'role' | 'actor'>> = [
  { role: 'data', actor: '顾清' },
  { role: 'product', actor: '丁禾' },
  { role: 'client', actor: '江驰' },
  { role: 'qa', actor: '余安' },
]

/**
 * 事件契约、下游依赖、发布候选并行更新时的候选重算。
 * 差异与受影响依赖重新生成；保留下来的迁移确认若来自上一版内容，连同旧审批一起归档失效，
 * 归档记录仅用于追溯，不参与当前版本放行。
 */
export const recomputeRelease = (
  state: GovernanceState,
  release: ReleaseCandidate,
  reason: string,
  changedEventKey?: string,
): void => {
  const differences = contractDifferences(state, release.eventIds)
  const affected = affectedDependencies(state, differences)
  const now = new Date().toISOString()

  const previousById = new Map(
    release.migrationConfirmations.map((item) => [item.dependencyId, item]),
  )

  release.differences = differences
  release.affectedDependencyIds = affected
  release.migrationConfirmations = affected.map((dependencyId) => {
    const previous = previousById.get(dependencyId)
    const history = previous?.history ?? []
    if (previous && (previous.status === 'confirmed' || previous.status === 'rejected')) {
      history.unshift({
        version: previous.version,
        status: previous.status,
        reviewer: previous.reviewer,
        note: previous.note,
        confirmedAt: previous.confirmedAt ?? now,
        reason,
      })
    }
    return {
      id: createId('mig'),
      dependencyId,
      version: release.version,
      status: 'pending',
      reviewer:
        previous?.reviewer ||
        state.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ||
        '',
      note: '',
      history,
    }
  })

  release.approvals = release.approvals.map((approval) => {
    const history = approval.history ?? []
    if (approval.status === 'approved' || approval.status === 'rejected') {
      history.unshift({
        status: approval.status,
        actor: approval.actor,
        comment: approval.comment,
        createdAt: approval.createdAt ?? now,
        reason,
      })
    }
    return {
      ...approval,
      status: 'pending',
      comment: '',
      createdAt: undefined,
      history,
    }
  })

  release.contractFingerprint = releaseScopeFingerprint(state, release.eventIds)
  release.invalidation = changedEventKey
    ? {
        reason,
        changedEventId:
          state.events.find((event) => event.key === changedEventKey)?.id ?? '',
        changedEventKey,
        at: now,
      }
    : { reason, changedEventId: '', changedEventKey: '', at: now }
}

const buildRelease = (
  version: string,
  title: string,
  eventIds: string[],
): ReleaseCandidate => ({
  id: createId('rel'),
  version,
  title,
  status: 'reviewing',
  eventIds,
  affectedDependencyIds: [],
  differences: [],
  migrationConfirmations: [],
  approvals: APPROVAL_SEED.map((seed) => ({
    id: createId('appr'),
    role: seed.role,
    actor: seed.actor,
    status: 'pending',
    comment: '',
    history: [],
  })),
  createdAt: new Date().toISOString(),
})

/**
 * 创建发布候选。两个窗口并行提交同一版本时只放行一份：
 * 已存在评审中/已发布的同版本候选时，新候选标记为重复并保留完整处理记录，
 * 不参与差异重算与门禁。
 */
export const createReleaseCandidate = (
  state: GovernanceState,
  version: string,
  title: string,
  eventIds: string[],
): CreateReleaseResult => {
  const owner = findVersionOwner(state.releases, version)
  const candidate = buildRelease(version, title, eventIds)

  if (owner) {
    candidate.status = 'draft'
    candidate.duplicateOf = owner.id
    candidate.duplicateNote = `契约已更新：版本 ${version} 已由候选 ${owner.title} 先行提交并进入评审，本窗口提交仅保留处理记录，不再参与发布门禁。`
    state.releases.unshift(candidate)
    return { duplicateOf: owner, duplicateRecord: candidate }
  }

  recomputeRelease(state, candidate, '发布候选创建')
  state.releases.unshift(candidate)
  state.currentVersion = version
  return { release: candidate }
}

/** 候选是否可操作门禁（重复记录与非评审状态不允许审批、迁移确认或发布） */
export const isReleaseOperable = (release: ReleaseCandidate): boolean =>
  !release.duplicateOf && release.status === 'reviewing'

/** 候选当前是否处于契约已更新、等待重算的状态 */
export const isReleaseWaitingRecompute = (
  release: ReleaseCandidate,
  state: GovernanceState,
): boolean =>
  isReleaseOperable(release) &&
  (!release.contractFingerprint ||
    release.contractFingerprint !== releaseScopeFingerprint(state, release.eventIds))

/**
 * 发布门禁判定：旧审批/旧迁移确认在契约更新后已重置，
 * 这里只统计当前指纹下的确认与审批；重复候选与失效候选一律不放行。
 */
export const canPublishRelease = (
  release: ReleaseCandidate,
  state?: GovernanceState,
): boolean => {
  if (!isReleaseOperable(release)) return false
  if (state && isReleaseWaitingRecompute(release, state)) return false
  if (release.migrationConfirmations.some((item) => item.status !== 'confirmed')) return false
  if (release.approvals.some((item) => item.status !== 'approved')) return false
  return true
}

export { findVersionOwner }

/** 候选中是否仍有可比较的实质差异 */
export const releaseHasDifferences = (release: ReleaseCandidate): boolean =>
  release.differences.some((difference) => !isEmptyDifference(difference))

export type { MigrationConfirmation }
