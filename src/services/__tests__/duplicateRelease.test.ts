import { describe, expect, it } from 'vitest'
import { createReleaseCandidate, findVersionOwner } from '@/services/releaseWorkflow'
import { makeEvent, makeState } from './factory'

describe('两个窗口并行提交同一版本', () => {
  it('只放行一份候选，另一份标记为重复并保留处理记录', () => {
    const state = makeState()
    const eventIds = [state.events[0]!.id]

    const first = createReleaseCandidate(state, '2026.11.0', '窗口A的提交', eventIds)
    expect(first.release).toBeDefined()
    expect(first.duplicateOf).toBeUndefined()

    const second = createReleaseCandidate(state, '2026.11.0', '窗口B的提交', eventIds)
    expect(second.release).toBeUndefined()
    expect(second.duplicateRecord).toBeDefined()
    expect(second.duplicateOf?.id).toBe(first.release!.id)

    const duplicate = second.duplicateRecord!
    expect(duplicate.duplicateOf).toBe(first.release!.id)
    expect(duplicate.status).toBe('draft')
    expect(duplicate.duplicateNote).toContain('契约已更新')
    expect(duplicate.duplicateNote).toContain('2026.11.0')
    expect(duplicate.eventIds).toEqual(eventIds)

    // 版本归属者仍是最早进入评审的候选
    expect(findVersionOwner(state.releases, '2026.11.0')?.id).toBe(first.release!.id)
  })

  it('第三个窗口重复提交同样只保留记录，不改变放行归属', () => {
    const state = makeState()
    const first = createReleaseCandidate(state, '2026.11.0', 'A', ['evt-1'])
    createReleaseCandidate(state, '2026.11.0', 'B', ['evt-1'])
    const third = createReleaseCandidate(state, '2026.11.0', 'C', ['evt-1'])
    expect(third.duplicateOf?.id).toBe(first.release!.id)
    expect(state.releases.filter((release) => release.duplicateOf)).toHaveLength(2)
    expect(state.releases.filter((release) => !release.duplicateOf && release.status === 'reviewing')).toHaveLength(1)
  })

  it('发布完成后同版本再次提交仍判定为重复', () => {
    const state = makeState()
    const first = createReleaseCandidate(state, '2026.11.0', 'A', ['evt-1']).release!
    first.status = 'published'
    const second = createReleaseCandidate(state, '2026.11.0', '迟到的提交', ['evt-1'])
    expect(second.duplicateOf?.id).toBe(first.id)
  })

  it('不同版本互不影响', () => {
    const state = makeState()
    const a = createReleaseCandidate(state, '2026.11.0', 'A', ['evt-1'])
    const b = createReleaseCandidate(state, '2026.12.0', 'B', ['evt-1'])
    expect(a.release).toBeDefined()
    expect(b.release).toBeDefined()
    expect(b.duplicateOf).toBeUndefined()
  })
})
