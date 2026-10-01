import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GovernanceState } from '@/models/domain'
import { createId, loadState, saveState } from '@/services/repository'
import { CURRENT_SCHEMA_VERSION } from '@/services/contractVersion'
import { makeState } from './factory'

const STORAGE_KEY = 'eventrail-governance-v1'
const STAGING_KEY = `${STORAGE_KEY}-staging`

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('原子写入与失败恢复', () => {
  it('正常保存只落正式键，不留暂存', () => {
    const state = loadState()
    saveState(state)
    expect(localStorage.getItem(STAGING_KEY)).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull()
  })

  it('写正式键中途失败时，暂存保持完整，下次加载前滚恢复', () => {
    const state = makeState({ currentVersion: '2026.11.0' })
    const nativeSetItem = Storage.prototype.setItem
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    setItem.mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === STORAGE_KEY) {
        // 模拟正式键写到一半失败：仅写入截断内容并抛错，暂存键保持完整
        nativeSetItem.call(this, key, String(value).slice(0, Math.floor(String(value).length / 2)))
        throw new DOMException('写入中断', 'QuotaExceededError')
      }
      return nativeSetItem.call(this, key, value)
    })

    expect(() => saveState(state)).toThrow('写入中断')
    const staging = localStorage.getItem(STAGING_KEY)
    expect(staging).not.toBeNull()
    expect(JSON.parse(staging!).currentVersion).toBe('2026.11.0')

    setItem.mockRestore()
    const recovered = loadState()
    expect(recovered.currentVersion).toBe('2026.11.0')
    // 前滚后暂存被清理
    expect(localStorage.getItem(STAGING_KEY)).toBeNull()
  })

  it('暂存内容损坏时丢弃暂存，保留已提交版本', () => {
    const committed = makeState({ currentVersion: '2026.09.0' })
    saveState(committed)
    localStorage.setItem(STAGING_KEY, '{这不是完整JSON')
    const recovered = loadState()
    expect(recovered.currentVersion).toBe('2026.09.0')
    expect(localStorage.getItem(STAGING_KEY)).toBeNull()
  })

  it('正式键只写一半且无暂存时，重建有效状态而不是抛出半截数据', () => {
    localStorage.setItem(STORAGE_KEY, '{"events":[')
    const state = loadState()
    expect(Array.isArray(state.events)).toBe(true)
    expect(state.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('契约快照与依赖状态处于同一负载，不存在只更新其一半的提交', () => {
    const state = makeState()
    saveState(state)
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as GovernanceState
    expect(persisted.baselines).toBeDefined()
    expect(persisted.dependencies).toBeDefined()
    expect(persisted.releases).toBeDefined()
  })
})

describe('旧数据回填（无版本指纹）', () => {
  it('首次打开时按当前契约回填事件与候选指纹，迁移确认版本保持不变', () => {
    const state = makeState()
    // 模拟 v1 旧数据：无 schemaVersion、无指纹
    const legacy: GovernanceState = {
      ...state,
      events: state.events.map(({ contractFingerprint: _omit, ...event }) => event),
      releases: [
        {
          id: 'rel-old',
          version: '2026.10.0',
          title: '进行中的评审',
          status: 'reviewing',
          eventIds: ['evt-1'],
          affectedDependencyIds: [],
          differences: [],
          migrationConfirmations: [
            {
              id: createId('mig'),
              dependencyId: 'dep-1',
              version: '2026.10.0',
              status: 'confirmed',
              reviewer: '数据组',
              note: '旧版本已确认',
              confirmedAt: '2026-09-28T10:00:00+08:00',
            },
          ],
          approvals: [],
          createdAt: '2026-09-25T10:00:00+08:00',
        },
      ],
    } as GovernanceState
    delete (legacy as Partial<GovernanceState>).schemaVersion
    localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy))

    const migrated = loadState()
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(migrated.events[0]!.contractFingerprint).toBeTruthy()
    const release = migrated.releases[0]!
    // 无实质差异的旧候选按当前契约回填，不强制要求重算
    expect(release.contractFingerprint).toBeTruthy()
    // 迁移确认保留且仍只属于原版本
    expect(release.migrationConfirmations[0]!.version).toBe('2026.10.0')
    expect(release.migrationConfirmations[0]!.status).toBe('confirmed')

    // 再次加载不会重复迁移
    const secondLoad = loadState()
    expect(secondLoad.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('仍有实质差异的旧候选不回填指纹，首次打开评审窗口时会触发重算', () => {
    const state = makeState()
    const legacy: GovernanceState = {
      ...state,
      schemaVersion: 1,
      events: state.events.map((event) => ({ ...event })),
      releases: [
        {
          id: 'rel-diff',
          version: '2026.10.0',
          title: '带未完成差异的评审',
          status: 'reviewing',
          eventIds: ['evt-1'],
          affectedDependencyIds: ['dep-1'],
          differences: [
            {
              eventId: 'evt-1',
              eventKey: 'test_event_submit',
              addedProperties: [],
              removedProperties: [],
              requiredChanges: [],
              typeChanges: ['order_id: number → string'],
              enumChanges: [],
            },
          ],
          migrationConfirmations: [],
          approvals: [],
          createdAt: '2026-09-25T10:00:00+08:00',
        },
      ],
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy))

    const migrated = loadState()
    expect(migrated.releases[0]!.contractFingerprint).toBeUndefined()
    expect(migrated.releases[0]!.differences[0]!.platformChanges).toEqual([])
    expect(migrated.events[0]!.contractFingerprint).toBeTruthy()
  })
})
