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
import { createId, loadState, resetState, saveState } from '@/services/repository'
import {
  releaseReadiness,
  validateGovernance,
} from '@/services/selectors'
import {
  eventContractFingerprint,
  releaseScopeFingerprint,
} from '@/services/contractVersion'
import {
  canPublishRelease,
  createReleaseCandidate,
  isReleaseOperable,
  isReleaseWaitingRecompute,
  recomputeRelease,
  type CreateReleaseResult,
} from '@/services/releaseWorkflow'

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())

  const issues = computed(() => validateGovernance(data.value))

  const persist = (): void => {
    // 整份状态作为一个序列化负载原子提交，契约快照与依赖状态不会只写一半
    saveState(data.value)
    lastSavedAt.value = new Date().toISOString()
  }

  const audit = (
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    data.value.audit.unshift({
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor: '当前用户',
      detail,
      createdAt: new Date().toISOString(),
    })
  }

  /**
   * 属性或平台规则变化后，使覆盖该事件的评审中候选差异、受影响依赖、
   * 迁移确认与审批全部失效，等待重算；旧审批不能继续放行。
   */
  const invalidateReleasesForEvent = (event: EventDefinition, reason: string): void => {
    data.value.releases.forEach((release) => {
      if (!isReleaseOperable(release) || !release.eventIds.includes(event.id)) return
      if (!isReleaseWaitingRecompute(release, data.value)) return
      release.invalidation = {
        reason,
        changedEventId: event.id,
        changedEventKey: event.key,
        at: new Date().toISOString(),
      }
    })
  }

  const saveEvent = (event: EventDefinition): void => {
    const index = data.value.events.findIndex((item) => item.id === event.id)
    const previous = index >= 0 ? data.value.events[index] : undefined
    const saved: EventDefinition = {
      ...event,
      updatedAt: new Date().toISOString(),
      contractFingerprint: eventContractFingerprint({ ...event }),
    }
    if (index >= 0) {
      data.value.events[index] = saved
    } else {
      data.value.events.unshift(saved)
    }
    if (previous) invalidateReleasesForEvent(saved, `事件 ${event.key} 契约内容更新，旧评审结果失效`)
    audit('event', event.id, index >= 0 ? '更新事件' : '创建事件', `${event.key} 契约已保存`)
    persist()
  }

  const touchEvent = (eventId: string, reason: string): EventDefinition | undefined => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return undefined
    event.updatedAt = new Date().toISOString()
    event.contractFingerprint = eventContractFingerprint(event)
    invalidateReleasesForEvent(event, reason)
    return event
  }

  const saveProperty = (eventId: string, property: EventProperty): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.properties.findIndex((item) => item.id === property.id)
    if (index >= 0) {
      event.properties[index] = property
    } else {
      event.properties.push(property)
    }
    const saved = touchEvent(eventId, `属性 ${property.name} 变更，候选差异与门禁结果失效待重算`)
    audit(
      'property',
      property.id,
      index >= 0 ? '更新属性' : '新增属性',
      `${event.key}.${property.name}`,
    )
    if (saved) persist()
  }

  const deleteProperty = (eventId: string, propertyId: string): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    const property = event?.properties.find((item) => item.id === propertyId)
    if (!event || !property) return
    property.deletedAt = new Date().toISOString()
    touchEvent(eventId, `属性 ${property.name} 删除，候选差异与门禁结果失效待重算`)
    audit('property', property.id, '标记删除', `${event.key}.${property.name} 进入删除兼容期`)
    persist()
  }

  const savePlatformRule = (eventId: string, rule: PlatformRule): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.platformRules.findIndex((item) => item.id === rule.id)
    if (index >= 0) {
      event.platformRules[index] = rule
    } else {
      event.platformRules.push(rule)
    }
    touchEvent(eventId, `平台规则 ${rule.platform} 变更，候选差异与门禁结果失效待重算`)
    audit(
      'platform_rule',
      rule.id,
      index >= 0 ? '更新平台规则' : '新增平台规则',
      `${event.key}/${rule.platform}`,
    )
    persist()
  }

  const createRelease = (version: string, title: string, eventIds: string[]): CreateReleaseResult => {
    const result = createReleaseCandidate(data.value, version, title, eventIds)
    if (result.release) {
      audit(
        'release',
        result.release.id,
        '创建发布候选',
        `${version} 包含 ${eventIds.length} 个事件，影响 ${result.release.affectedDependencyIds.length} 个下游依赖`,
      )
    } else if (result.duplicateRecord && result.duplicateOf) {
      audit(
        'release',
        result.duplicateRecord.id,
        '重复版本提交',
        `${version} 已由候选 ${result.duplicateOf.id} 先行放行，重复提交保留处理记录`,
      )
    }
    persist()
    return result
  }

  /** 候选因契约更新失效后，评审窗口首次打开时按最新契约重算 */
  const refreshStaleRelease = (releaseId: string): ReleaseCandidate | undefined => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release || !isReleaseOperable(release)) return release
    if (!isReleaseWaitingRecompute(release, data.value)) return release
    const reason =
      release.invalidation?.reason ?? '契约已更新，差异、受影响依赖与迁移确认按最新契约重算'
    recomputeRelease(data.value, release, reason)
    audit('release', release.id, '候选失效重算', `${release.version}：${reason}`)
    persist()
    return release
  }

  const confirmMigration = (
    releaseId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const confirmation = release?.migrationConfirmations.find((item) => item.id === confirmationId)
    if (!release || !confirmation || !isReleaseOperable(release)) return
    // 迁移确认只对当前版本指纹有效；候选已失效时必须先重算
    if (isReleaseWaitingRecompute(release, data.value)) return
    confirmation.status = 'confirmed'
    confirmation.reviewer = reviewer
    confirmation.note = note
    confirmation.confirmedAt = new Date().toISOString()
    const dependency = data.value.dependencies.find((item) => item.id === confirmation.dependencyId)
    if (dependency) dependency.status = 'migrated'
    audit('dependency', confirmation.dependencyId, '确认迁移', `${reviewer}：${note}`)
    persist()
  }

  const updateApproval = (
    releaseId: string,
    role: ReleaseApproval['role'],
    status: ReleaseApproval['status'],
    actor: string,
    comment: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const approval = release?.approvals.find((item) => item.role === role)
    if (!release || !approval || !isReleaseOperable(release)) return
    // 旧审批不能放行变更后的契约；候选失效后先重算再审批
    if (isReleaseWaitingRecompute(release, data.value)) return
    approval.status = status
    approval.actor = actor
    approval.comment = comment
    approval.createdAt = new Date().toISOString()
    audit('release', releaseId, status === 'approved' ? '审批通过' : '审批驳回', `${role}：${comment}`)
    persist()
  }

  const publishRelease = (releaseId: string): boolean => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release || !canPublishRelease(release, data.value)) return false
    // 最后一道保险：指纹与当前契约不一致绝不放行
    if (release.contractFingerprint !== releaseScopeFingerprint(data.value, release.eventIds)) {
      return false
    }
    const readiness = releaseReadiness(release, issues.value)
    if (readiness < 90) return false
    release.status = 'published'
    release.publishedAt = new Date().toISOString()
    release.eventIds.forEach((eventId) => {
      const event = data.value.events.find((item) => item.id === eventId)
      if (event) {
        event.status = 'published'
        data.value.baselines.unshift({
          id: createId('base'),
          eventId,
          version: event.version,
          properties: JSON.parse(JSON.stringify(event.properties)),
          platformRules: JSON.parse(JSON.stringify(event.platformRules)),
          createdAt: new Date().toISOString(),
          status: 'published',
        })
      }
    })
    audit('release', release.id, '发布契约', `${release.version} 已发布`)
    persist()
    return true
  }

  const saveDeprecation = (plan: DeprecationPlan): void => {
    const index = data.value.deprecations.findIndex((item) => item.id === plan.id)
    if (index >= 0) {
      data.value.deprecations[index] = plan
    } else {
      data.value.deprecations.unshift(plan)
    }
    const event = data.value.events.find((item) => item.id === plan.eventId)
    if (event && plan.status === 'stopped') event.status = 'deprecated'
    if (event && plan.status === 'retired') event.status = 'retired'
    audit('deprecation', plan.id, '更新废弃计划', `${event?.key ?? plan.eventId}：${plan.status}`)
    persist()
  }

  const executeRollback = (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
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
    data.value.rollbacks.unshift(record)
    release.status = 'rolled_back'
    audit('rollback', record.id, '执行回滚', `${release.version}：${reason}`)
    persist()
  }

  const verifyRollback = (rollbackId: string, evidence: string): void => {
    const record = data.value.rollbacks.find((item) => item.id === rollbackId)
    if (!record) return
    record.status = 'verified'
    record.evidence = evidence
    audit('rollback', record.id, '验证回滚', evidence)
    persist()
  }

  const resetDemo = (): void => {
    data.value = resetState()
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
    issues,
    saveEvent,
    saveProperty,
    deleteProperty,
    savePlatformRule,
    createRelease,
    refreshStaleRelease,
    confirmMigration,
    updateApproval,
    publishRelease,
    saveDeprecation,
    executeRollback,
    verifyRollback,
    resetDemo,
    exportContract,
  }
})
