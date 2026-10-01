import { describe, expect, it } from 'vitest'
import {
  affectedDependencies,
  compareEventContract,
  contractDifferences,
} from '@/services/selectors'
import {
  eventContractFingerprint,
  isReleaseStale,
} from '@/services/contractVersion'
import {
  canPublishRelease,
  createReleaseCandidate,
  isReleaseWaitingRecompute,
  recomputeRelease,
} from '@/services/releaseWorkflow'
import type { EventVersionSnapshot, GovernanceState, ReleaseCandidate } from '@/models/domain'
import { makeDependency, makeEvent, makeProperty, makeRule, makeState } from './factory'

const baselineFor = (event: ReturnType<typeof makeEvent>): EventVersionSnapshot => ({
  id: 'base-1',
  eventId: event.id,
  version: '0.9.0',
  createdAt: '2026-09-01T10:00:00+08:00',
  status: 'published',
  properties: event.properties.map((property) => ({ ...property })),
  platformRules: event.platformRules.map((rule) => ({ ...rule })),
})

describe('契约指纹与候选失效', () => {
  it('属性类型变化后事件指纹改变，候选变为待重算', () => {
    const state = makeState()
    const event = state.events[0]!
    const before = eventContractFingerprint(event)

    const { release } = createReleaseCandidate(state, '2026.11.0', '十一月发布', [event.id])
    expect(release).toBeDefined()
    expect(isReleaseStale(release!, state)).toBe(false)

    event.properties[0]!.type = 'number'
    expect(eventContractFingerprint(event)).not.toBe(before)
    expect(isReleaseStale(release!, state)).toBe(true)
    expect(isReleaseWaitingRecompute(release!, state)).toBe(true)
  })

  it('平台规则（必填属性、触发时机、启用状态）变化同样使候选失效', () => {
    const state = makeState()
    const event = state.events[0]!
    const { release } = createReleaseCandidate(state, '2026.11.0', '十一月发布', [event.id])
    const before = eventContractFingerprint(event)

    event.platformRules[0]!.requiredPropertyIds = ['prop-a']
    expect(eventContractFingerprint(event)).not.toBe(before)
    expect(isReleaseStale(release!, state)).toBe(true)

    const fpAfterRequired = eventContractFingerprint(event)
    event.platformRules[0]!.trigger = '按钮点击后立即上报'
    expect(eventContractFingerprint(event)).not.toBe(fpAfterRequired)

    const fpAfterTrigger = eventContractFingerprint(event)
    event.platformRules[0]!.enabled = false
    expect(eventContractFingerprint(event)).not.toBe(fpAfterTrigger)
  })

  it('负责人、描述等元数据变化不改变指纹', () => {
    const event = makeEvent()
    const before = eventContractFingerprint(event)
    event.owner = '另一个组'
    event.description = '新的描述'
    event.properties[0]!.description = '字段口径备注更新'
    event.properties[0]!.synonyms = ['order_no']
    expect(eventContractFingerprint(event)).toBe(before)
  })
})

describe('失效重算：差异、受影响依赖、迁移确认与审批', () => {
  it('重算后差异更新，已确认迁移与已通过审批归档且不再放行', () => {
    const state = makeState()
    const event = state.events[0]!
    const baseline = baselineFor(event)
    state.baselines = [baseline]

    // 初次候选没有属性差异
    const { release } = createReleaseCandidate(state, '2026.11.0', '十一月发布', [event.id])
    expect(release!.migrationConfirmations).toHaveLength(0)

    // 新增一个必填属性，依赖引用该属性后应进入受影响清单
    event.properties[0]!.required = true
    baseline.properties = [{ ...event.properties[0]!, required: false }]
    recomputeRelease(state, release!, '测试：必填规则变化')
    expect(release!.affectedDependencyIds).toContain('dep-1')
    expect(release!.migrationConfirmations).toHaveLength(1)

    // 完成迁移确认与四角色审批
    release!.migrationConfirmations[0]!.status = 'confirmed'
    release!.migrationConfirmations[0]!.confirmedAt = '2026-10-01T11:00:00+08:00'
    release!.approvals.forEach((approval) => {
      approval.status = 'approved'
      approval.comment = '通过'
      approval.createdAt = '2026-10-01T11:05:00+08:00'
    })
    expect(canPublishRelease(release!)).toBe(true)

    // 属性类型变化 -> 重算
    event.properties[0]!.type = 'number'
    expect(isReleaseWaitingRecompute(release!, state)).toBe(true)
    expect(canPublishRelease(release!, state)).toBe(false)
    recomputeRelease(state, release!, '属性 order_id 类型调整为 number')

    // 迁移确认与审批全部回到 pending，旧记录归档
    expect(release!.migrationConfirmations[0]!.status).toBe('pending')
    expect(release!.migrationConfirmations[0]!.history).toHaveLength(1)
    expect(release!.migrationConfirmations[0]!.history![0]!.reason).toContain('order_id')
    expect(release!.approvals.every((approval) => approval.status === 'pending')).toBe(true)
    expect(release!.approvals.every((approval) => approval.history!.length === 1)).toBe(true)
    expect(canPublishRelease(release!)).toBe(false)
  })

  it('重算只重置受影响事件范围内的候选', () => {
    const other = makeEvent({
      id: 'evt-2',
      key: 'other_event_view',
      properties: [makeProperty({ id: 'prop-b', eventId: 'evt-2', name: 'page_name' })],
      platformRules: [makeRule({ id: 'rule-other', eventId: 'evt-2', platform: 'ios' })],
    })
    const state = makeState({
      events: [makeEvent(), other],
      dependencies: [
        makeDependency(),
        makeDependency({
          id: 'dep-2',
          eventIds: ['evt-2'],
          propertyRefs: [{ eventId: 'evt-2', propertyId: 'prop-b' }],
        }),
      ],
    })
    const first = createReleaseCandidate(state, '2026.11.0', 'A', ['evt-1']).release!
    const second = createReleaseCandidate(state, '2026.12.0', 'B', ['evt-2']).release!

    state.events[0]!.properties[0]!.type = 'number'
    expect(isReleaseWaitingRecompute(first, state)).toBe(true)
    expect(isReleaseWaitingRecompute(second, state)).toBe(false)
  })
})

describe('平台规则差异', () => {
  it('比较启用状态、触发时机和必填属性增删', () => {
    const event = makeEvent({
      properties: [
        makeProperty({ id: 'prop-a', name: 'order_id' }),
        makeProperty({ id: 'prop-b', eventId: 'evt-1', name: 'amount' }),
      ],
      platformRules: [
        makeRule({
          trigger: '新触发时机',
          enabled: false,
          requiredPropertyIds: ['prop-b'],
        }),
      ],
    })
    const baseline: EventVersionSnapshot = {
      ...baselineFor(event),
      properties: event.properties.map((property) => ({ ...property })),
      platformRules: [makeRule({ trigger: '旧触发时机', enabled: true, requiredPropertyIds: ['prop-a'] })],
    }
    const difference = compareEventContract(event, baseline)
    expect(difference.platformChanges).toHaveLength(1)
    const change = difference.platformChanges[0]!
    expect(change.triggerChange).toBe(true)
    expect(change.enabledChange).toContain('停用')
    expect(change.requiredPropertyAdded).toEqual(['amount'])
    expect(change.requiredPropertyRemoved).toEqual(['order_id'])
  })

  it('平台触发时机变化影响该事件的全部下游依赖', () => {
    const event = makeEvent()
    const state = makeState({
      events: [event],
      dependencies: [makeDependency({ propertyRefs: [] })],
    })
    const differences = contractDifferences(state, [event.id])
    // 没有基线时无差异；构造一个触发时机差异
    state.baselines = [{ ...baselineFor(event) }]
    event.platformRules[0]!.trigger = '完全不同的触发时机'
    const changed = contractDifferences(state, [event.id])
    expect(affectedDependencies(state, changed)).toEqual(['dep-1'])
  })
})
