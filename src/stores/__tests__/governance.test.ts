import { beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useGovernanceStore } from '@/stores/governance'
import {
  canPublishRelease,
  isReleaseWaitingRecompute,
} from '@/services/releaseWorkflow'
import type { EventProperty, PlatformRule } from '@/models/domain'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('store：契约编辑与评审并行更新', () => {
  it('属性修改使评审中候选失效，旧审批不放行，重算后恢复可评审', () => {
    const store = useGovernanceStore()
    // 种子数据自带一个评审中的 2026.10.0 候选
    const release = store.data.releases.find((item) => item.status === 'reviewing')
    expect(release).toBeDefined()

    // 已存在一条 data 角色的通过审批（种子数据）
    const dataApproval = release!.approvals.find((item) => item.role === 'data')!
    expect(dataApproval.status).toBe('approved')

    // 修改候选范围内事件 evt-001 的属性
    const event = store.data.events.find((item) => item.id === 'evt-001')!
    const property = event.properties[0]!
    const updated: EventProperty = {
      ...property,
      description: '口径描述更新不影响指纹，但这里同时改必填',
      required: !property.required,
    }
    store.saveProperty(event.id, updated)

    expect(isReleaseWaitingRecompute(release!, store.data)).toBe(true)
    expect(release!.invalidation).toBeTruthy()
    expect(release!.invalidation?.changedEventKey).toBe(event.key)

    // 旧审批还挂在原位（UI 显示历史），但门禁不放行失效候选
    expect(dataApproval.status).toBe('approved')
    expect(canPublishRelease(release!, store.data)).toBe(false)

    // 首次打开评审窗口触发重算
    store.refreshStaleRelease(release!.id)
    expect(isReleaseWaitingRecompute(release!, store.data)).toBe(false)
    expect(release!.approvals.find((item) => item.role === 'data')!.status).toBe('pending')
    expect(
      release!.approvals.find((item) => item.role === 'data')!.history?.[0]?.reason,
    ).toContain('失效')
    // 差异中仍能看到平台规则变化（种子基线与当前契约不一致）
    const diffs = release!.differences.flatMap((difference) => difference.platformChanges)
    expect(diffs.length).toBeGreaterThan(0)
  })

  it('平台规则修改同样触发失效', () => {
    const store = useGovernanceStore()
    const release = store.data.releases.find((item) => item.status === 'reviewing')!
    const event = store.data.events.find((item) => item.id === 'evt-003')!
    const rule: PlatformRule = {
      ...event.platformRules[0]!,
      trigger: '用户点击搜索结果后延迟上报',
    }
    store.savePlatformRule(event.id, rule)
    expect(isReleaseWaitingRecompute(release, store.data)).toBe(true)
  })

  it('候选失效期间审批与迁移确认被拒绝写入', () => {
    const store = useGovernanceStore()
    const release = store.data.releases.find((item) => item.status === 'reviewing')!
    const event = store.data.events.find((item) => item.id === 'evt-001')!
    store.saveProperty(event.id, { ...event.properties[0]!, required: !event.properties[0]!.required })

    expect(isReleaseWaitingRecompute(release, store.data)).toBe(true)
    store.updateApproval(release.id, 'qa', 'approved', '余安', '尝试在失效时通过')
    expect(release.approvals.find((item) => item.role === 'qa')!.status).toBe('pending')

    const confirmation = release.migrationConfirmations[0]
    if (confirmation) {
      store.confirmMigration(release.id, confirmation.id, '某人', '尝试在失效时确认')
      expect(confirmation.status).toBe('pending')
    }
  })

  it('同版本并行提交只放行一份，重复候选不能发布，记录保留可查', () => {
    const store = useGovernanceStore()
    const eventIds = ['evt-002']
    const first = store.createRelease('2099.01.0', '窗口一', eventIds)
    const second = store.createRelease('2099.01.0', '窗口二', eventIds)
    expect(first.release).toBeDefined()
    expect(second.duplicateOf?.id).toBe(first.release!.id)

    expect(canPublishRelease(second.duplicateRecord!, store.data)).toBe(false)
    const persisted = store.data.releases.find((item) => item.id === second.duplicateRecord!.id)
    expect(persisted?.duplicateNote).toContain('契约已更新')
    expect(persisted?.eventIds).toEqual(eventIds)
  })
})
