import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  GovernanceState,
  PlatformRule,
  ReleaseApproval,
  ReleaseCandidate,
  RollbackRecord,
} from '@/models/domain'
import {
  consumeMigrationChanges,
  createId,
  loadState,
  peekCommittedState,
  resetState,
  saveState,
  subscribeStateChanges,
} from '@/services/repository'
import {
  activeMigrationConfirmations,
  affectedDependencies,
  contractDifferences,
  contractFingerprint,
  recalculateRelease,
  releaseReadiness,
  validateGovernance,
} from '@/services/selectors'

export type CreateReleaseOutcome =
  | { kind: 'created'; release: ReleaseCandidate }
  | { kind: 'duplicate'; existing: ReleaseCandidate }
  | { kind: 'write_failed'; message: string }

export type PublishOutcome =
  | { kind: 'published'; release: ReleaseCandidate }
  | { kind: 'duplicate'; existing: ReleaseCandidate }
  | { kind: 'blocked'; release: ReleaseCandidate; message: string }
  | { kind: 'write_failed'; message: string }

/** 其他窗口提交了同版本候选时记录的拦截原因 */
const DUPLICATE_DETAIL = '另一窗口已提交同版本候选，契约已更新，本次提交不再放行，处理记录已保留'

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())
  /** 旧数据首次打开时按当前契约回填版本指纹的提示 */
  const backfillNotices = ref<string[]>([])

  const issues = computed(() => validateGovernance(data.value))

  /**
   * 在同一份 draft 上完成变更并原子落盘。发布候选、契约快照、依赖状态都在
   * 这次写入内一起提交，保证中途失败可恢复、不会只写一半。
   */
  const commit = (mutate: (draft: GovernanceState) => void): void => {
    const draft = structuredClone(data.value)
    mutate(draft)
    saveState(draft)
    data.value = draft
    lastSavedAt.value = new Date().toISOString()
  }

  /**
   * 基于已提交的最新状态落盘（用于并发冲突处理）：本窗口内存可能落后，
   * 直接覆盖会冲掉其他窗口刚提交的候选，因此必须在最新提交之上追加记录。
   */
  const commitOnCommitted = (mutate: (draft: GovernanceState) => void): void => {
    const draft = structuredClone(peekCommittedState())
    mutate(draft)
    saveState(draft)
    data.value = draft
    lastSavedAt.value = new Date().toISOString()
  }

  const audit = (
    draft: GovernanceState,
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    draft.audit.unshift({
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor: '当前用户',
      detail,
      createdAt: new Date().toISOString(),
    })
  }

  /** 属性或平台规则一变，评审中的候选差异、受影响依赖、迁移确认和旧审批全部失效重算 */
  const invalidateReviewingReleases = (draft: GovernanceState, reason: string): void => {
    draft.releases.forEach((release, index) => {
      const result = recalculateRelease(draft, release, reason)
      if (!result.changed) return
      draft.releases[index] = result.release
      result.affectedDependencyIds.forEach((dependencyId) => {
        const dependency = draft.dependencies.find((item) => item.id === dependencyId)
        if (dependency && dependency.status === 'migrated') {
          dependency.status = 'migration_required'
        }
      })
      audit(
        draft,
        'release',
        release.id,
        '契约更新，门禁重算',
        `${reason}；${release.version} 的差异、受影响依赖与迁移确认已重算，旧审批作废`,
      )
    })
  }

  const buildRelease = (
    draft: GovernanceState,
    version: string,
    title: string,
    eventIds: string[],
  ): ReleaseCandidate => {
    const differences = contractDifferences(draft, eventIds)
    const affected = affectedDependencies(draft, differences)
    return {
      id: createId('rel'),
      version,
      title,
      status: 'reviewing',
      eventIds,
      affectedDependencyIds: affected,
      differences,
      contractFingerprint: contractFingerprint(draft, eventIds),
      migrationConfirmations: affected.map((dependencyId) => ({
        id: createId('mig'),
        dependencyId,
        version,
        status: 'pending',
        reviewer:
          draft.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
        note: '',
      })),
      approvals: [
        { id: createId('appr'), role: 'data', actor: '顾清', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'product', actor: '丁禾', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'client', actor: '江驰', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'qa', actor: '余安', status: 'pending', comment: '' },
      ],
      createdAt: new Date().toISOString(),
    }
  }

  const findActiveVersion = (
    state: GovernanceState,
    version: string,
  ): ReleaseCandidate | undefined =>
    state.releases.find(
      (release) => release.version === version && release.status !== 'rolled_back',
    )

  const saveEvent = (event: EventDefinition): void => {
    commit((draft) => {
      const index = draft.events.findIndex((item) => item.id === event.id)
      const saved = { ...event, updatedAt: new Date().toISOString() }
      if (index >= 0) {
        draft.events[index] = saved
      } else {
        draft.events.unshift(saved)
      }
      invalidateReviewingReleases(draft, `事件 ${event.key} 契约已保存`)
      audit(draft, 'event', event.id, index >= 0 ? '更新事件' : '创建事件', `${event.key} 契约已保存`)
    })
  }

  const saveProperty = (eventId: string, property: EventProperty): void => {
    commit((draft) => {
      const event = draft.events.find((item) => item.id === eventId)
      if (!event) return
      const index = event.properties.findIndex((item) => item.id === property.id)
      if (index >= 0) {
        event.properties[index] = property
      } else {
        event.properties.push(property)
      }
      event.updatedAt = new Date().toISOString()
      invalidateReviewingReleases(draft, `属性 ${event.key}.${property.name} 已更新`)
      audit(
        draft,
        'property',
        property.id,
        index >= 0 ? '更新属性' : '新增属性',
        `${event.key}.${property.name}`,
      )
    })
  }

  const deleteProperty = (eventId: string, propertyId: string): void => {
    commit((draft) => {
      const event = draft.events.find((item) => item.id === eventId)
      const property = event?.properties.find((item) => item.id === propertyId)
      if (!event || !property) return
      property.deletedAt = new Date().toISOString()
      event.updatedAt = new Date().toISOString()
      invalidateReviewingReleases(draft, `属性 ${event.key}.${property.name} 进入删除兼容期`)
      audit(
        draft,
        'property',
        property.id,
        '标记删除',
        `${event.key}.${property.name} 进入删除兼容期`,
      )
    })
  }

  const savePlatformRule = (eventId: string, rule: PlatformRule): void => {
    commit((draft) => {
      const event = draft.events.find((item) => item.id === eventId)
      if (!event) return
      const index = event.platformRules.findIndex((item) => item.id === rule.id)
      if (index >= 0) {
        event.platformRules[index] = rule
      } else {
        event.platformRules.push(rule)
      }
      event.updatedAt = new Date().toISOString()
      invalidateReviewingReleases(draft, `平台规则 ${event.key}/${rule.platform} 已更新`)
      audit(
        draft,
        'platform_rule',
        rule.id,
        index >= 0 ? '更新平台规则' : '新增平台规则',
        `${event.key}/${rule.platform}`,
      )
    })
  }

  /**
   * 两个窗口同时提交同一版本时只放行一份：以已提交存储做 CAS 校验，
   * 落后窗口不再创建候选，只追加“契约已更新”的处理记录。
   */
  const createRelease = (
    version: string,
    title: string,
    eventIds: string[],
  ): CreateReleaseOutcome => {
    const committed = peekCommittedState()
    const existing = findActiveVersion(committed, version)
    if (existing) {
      // 在其他窗口的最新提交之上追加拦截记录，不能用本窗口落后的内存状态覆盖
      commitOnCommitted((draft) => {
        audit(
          draft,
          'release',
          existing.id,
          '同版本提交被拦截',
          `${DUPLICATE_DETAIL}（${version}）`,
        )
      })
      const latest = findActiveVersion(data.value, version)
      return { kind: 'duplicate', existing: latest ?? existing }
    }

    try {
      const draft = structuredClone(data.value)
      const created = buildRelease(draft, version, title, eventIds)
      draft.releases.unshift(created)
      draft.currentVersion = version
      audit(
        draft,
        'release',
        created.id,
        '创建发布候选',
        `${version} 包含 ${eventIds.length} 个事件，影响 ${created.affectedDependencyIds.length} 个下游依赖`,
      )
      saveState(draft)
      data.value = draft
      lastSavedAt.value = new Date().toISOString()
      return { kind: 'created', release: created }
    } catch (error) {
      return { kind: 'write_failed', message: error instanceof Error ? error.message : '写入失败' }
    }
  }

  const confirmMigration = (
    releaseId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
  ): void => {
    commit((draft) => {
      const release = draft.releases.find((item) => item.id === releaseId)
      const confirmation = release?.migrationConfirmations.find((item) => item.id === confirmationId)
      if (!release || !confirmation) return
      // 迁移确认只对当前版本有效：作废确认不能被重新确认
      if (confirmation.version !== release.version || confirmation.invalidatedAt) return
      confirmation.status = 'confirmed'
      confirmation.reviewer = reviewer
      confirmation.note = note
      confirmation.confirmedAt = new Date().toISOString()
      const dependency = draft.dependencies.find((item) => item.id === confirmation.dependencyId)
      if (dependency) dependency.status = 'migrated'
      audit(draft, 'dependency', confirmation.dependencyId, '确认迁移', `${reviewer}：${note}`)
    })
  }

  const updateApproval = (
    releaseId: string,
    role: ReleaseApproval['role'],
    status: ReleaseApproval['status'],
    actor: string,
    comment: string,
  ): void => {
    commit((draft) => {
      const release = draft.releases.find((item) => item.id === releaseId)
      const approval = release?.approvals.find((item) => item.role === role)
      if (!release || !approval) return
      // 契约更新后旧审批作废，提交新意见即按当前版本重新审批
      approval.status = status
      approval.actor = actor
      approval.comment = comment
      approval.createdAt = new Date().toISOString()
      approval.invalidatedAt = undefined
      approval.invalidatedReason = undefined
      audit(
        draft,
        'release',
        releaseId,
        status === 'approved' ? '审批通过' : '审批驳回',
        `${role}：${comment}`,
      )
    })
  }

  const publishRelease = (releaseId: string): PublishOutcome => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) {
      return { kind: 'blocked', release: null as unknown as ReleaseCandidate, message: '发布候选不存在' }
    }

    try {
      let published: ReleaseCandidate | undefined
      let winner: ReleaseCandidate | undefined
      let blocked = false
      // 以已提交状态为基准，避免用本窗口落后的内存状态覆盖其他窗口刚发布的版本
      commitOnCommitted((draft) => {
        const target = draft.releases.find((item) => item.id === releaseId)
        if (!target) return
        // 与其他窗口的同版本发布竞争：已发布的一份放行，本份不重复发布
        const duplicate = findActiveVersion(draft, target.version)
        if (duplicate && duplicate.id !== target.id && duplicate.status === 'published') {
          winner = duplicate
          audit(draft, 'release', target.id, '同版本发布被拦截', DUPLICATE_DETAIL)
          return
        }
        // 提交时按最新契约做新鲜度重算：属性或平台规则在审批后变化，旧审批不放行
        const recalculation = recalculateRelease(draft, target, '发布提交时契约已更新')
        const targetIndex = draft.releases.findIndex((item) => item.id === releaseId)
        draft.releases[targetIndex] = recalculation.release
        if (recalculation.changed) {
          audit(
            draft,
            'release',
            target.id,
            '契约更新，门禁重算',
            `发布提交时检测到契约更新，${target.version} 旧审批与旧迁移确认已作废`,
          )
        }
        const readinessNow = releaseReadiness(recalculation.release, validateGovernance(draft))
        const migrationsReady = activeMigrationConfirmations(recalculation.release).every(
          (item) => item.status === 'confirmed',
        )
        const approvalsReady = recalculation.release.approvals.every(
          (item) => item.status === 'approved' && !item.invalidatedAt,
        )
        if (!migrationsReady || !approvalsReady || readinessNow < 90) {
          blocked = true
          audit(draft, 'release', target.id, '发布被门禁拦截', '迁移确认或四角色审批未完成或已失效')
          return
        }
        recalculation.release.status = 'published'
        recalculation.release.publishedAt = new Date().toISOString()
        recalculation.release.eventIds.forEach((eventId) => {
          const event = draft.events.find((item) => item.id === eventId)
          if (event) {
            event.status = 'published'
            // 契约快照与依赖状态在同一次原子写入内落盘
            draft.baselines.unshift({
              id: createId('base'),
              eventId,
              version: event.version,
              properties: structuredClone(event.properties),
              createdAt: new Date().toISOString(),
              status: 'published',
            })
          }
        })
        published = recalculation.release
        audit(draft, 'release', target.id, '发布契约', `${target.version} 已发布`)
      })

      if (published) return { kind: 'published', release: published }
      if (winner) return { kind: 'duplicate', existing: winner }
      const current = data.value.releases.find((item) => item.id === releaseId) ?? release
      return {
        kind: 'blocked',
        release: current,
        message: blocked
          ? '迁移确认或四角色审批尚未完成（或已因契约更新作废），当前不可发布'
          : '发布被拦截',
      }
    } catch (error) {
      return { kind: 'write_failed', message: error instanceof Error ? error.message : '写入失败' }
    }
  }

  const saveDeprecation = (plan: DeprecationPlan): void => {
    commit((draft) => {
      const index = draft.deprecations.findIndex((item) => item.id === plan.id)
      if (index >= 0) {
        draft.deprecations[index] = plan
      } else {
        draft.deprecations.unshift(plan)
      }
      const event = draft.events.find((item) => item.id === plan.eventId)
      if (event && plan.status === 'stopped') event.status = 'deprecated'
      if (event && plan.status === 'retired') event.status = 'retired'
      audit(
        draft,
        'deprecation',
        plan.id,
        '更新废弃计划',
        `${event?.key ?? plan.eventId}：${plan.status}`,
      )
    })
  }

  const executeRollback = (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
  ): void => {
    commit((draft) => {
      const release = draft.releases.find((item) => item.id === releaseId)
      if (!release) return
      const record: RollbackRecord = {
        id: createId('rollback'),
        releaseId,
        version: release.version,
        reason,
        operator: '当前用户',
        scope,
        createdAt: new Date().toISOString(),
        status: 'executed',
        evidence,
      }
      draft.rollbacks.unshift(record)
      release.status = 'rolled_back'
      audit(draft, 'rollback', record.id, '执行回滚', `${release.version}：${reason}`)
    })
  }

  const verifyRollback = (rollbackId: string, evidence: string): void => {
    commit((draft) => {
      const record = draft.rollbacks.find((item) => item.id === rollbackId)
      if (!record) return
      record.status = 'verified'
      record.evidence = evidence
      audit(draft, 'rollback', record.id, '验证回滚', evidence)
    })
  }

  const resetDemo = (): void => {
    data.value = resetState()
    backfillNotices.value = []
    lastSavedAt.value = new Date().toISOString()
  }

  /** 旧数据回填提示：首次打开旧版本数据时 loadState 已按当前契约补齐指纹 */
  const hydrateBackfillNotices = (): void => {
    backfillNotices.value = consumeMigrationChanges()
  }

  /** 其他窗口提交后同步内存状态（提交本身已是原子写入，直接替换即可） */
  const syncFromCommitted = (next: GovernanceState): void => {
    data.value = next
    lastSavedAt.value = new Date().toISOString()
  }

  const exportContract = (eventIds?: string[]): string => {
    const selectedEvents = eventIds
      ? data.value.events.filter((event) => eventIds.includes(event.id))
      : data.value.events
    return JSON.stringify(
      {
        version: data.value.currentVersion,
        generatedAt: new Date().toISOString(),
        events: selectedEvents.map((event) => ({
          key: event.key,
          displayName: event.displayName,
          version: event.version,
          trigger: event.trigger,
          platforms: event.platformRules.map((rule) => ({
            platform: rule.platform,
            enabled: rule.enabled,
            trigger: rule.trigger,
          })),
          properties: event.properties
            .filter((property) => !property.deletedAt)
            .map(({ name, type, required, enumValues, description }) => ({
              name,
              type,
              required,
              enumValues,
              description,
            })),
        })),
      },
      null,
      2,
    )
  }

  return {
    data,
    lastSavedAt,
    backfillNotices,
    issues,
    hydrateBackfillNotices,
    syncFromCommitted,
    saveEvent,
    saveProperty,
    deleteProperty,
    savePlatformRule,
    createRelease,
    confirmMigration,
    updateApproval,
    publishRelease,
    saveDeprecation,
    executeRollback,
    verifyRollback,
    resetDemo,
    exportContract,
    subscribeStateChanges,
  }
})
