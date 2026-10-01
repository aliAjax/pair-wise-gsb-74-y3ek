import type { GovernanceState } from '@/models/domain'
import { createSeedState } from '@/models/seed'
import { createId } from '@/services/id'
import {
  STORAGE_SCHEMA_VERSION,
  isBareState,
  isEnvelope,
  migrateState,
  type StateEnvelope,
} from '@/services/migrate'
import { stableHash } from '@/services/selectors'

const STORAGE_KEY = 'eventrail-governance-v1'
const COMMIT_KEY = `${STORAGE_KEY}:commit`
const JOURNAL_KEY = `${STORAGE_KEY}:journal`

export { createId }

type StorageListener = (state: GovernanceState) => void
const listeners = new Set<StorageListener>()

/** 最近一次 loadState 对旧数据执行的迁移说明，供首屏提示 */
let lastMigrationChanges: string[] = []
export const consumeMigrationChanges = (): string[] => {
  const changes = lastMigrationChanges
  lastMigrationChanges = []
  return changes
}

const buildEnvelope = (state: GovernanceState): StateEnvelope => ({
  meta: {
    schema: STORAGE_SCHEMA_VERSION,
    checksum: stableHash(JSON.stringify(state)),
    writtenAt: new Date().toISOString(),
  },
  state,
})

const readEnvelope = (key: string): StateEnvelope | null => {
  const raw = localStorage.getItem(key)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isEnvelope(parsed)) return null
    if (stableHash(JSON.stringify(parsed.state)) !== parsed.meta.checksum) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 恢复顺序：提交区与暂存区都完整时取较新的一次写入；
 * 写入中途失败会留下“有暂存、无提交/提交旧”的现场，重启后自动按暂存恢复，
 * 契约快照和依赖状态永远不会只写一半。
 */
const recoverEnvelope = (): StateEnvelope | null => {
  const committed = readEnvelope(COMMIT_KEY)
  const journal = readEnvelope(JOURNAL_KEY)
  if (journal && (!committed || journal.meta.writtenAt >= committed.meta.writtenAt)) {
    localStorage.setItem(COMMIT_KEY, JSON.stringify(journal))
    localStorage.removeItem(JOURNAL_KEY)
    return journal
  }
  if (committed && journal) {
    localStorage.removeItem(JOURNAL_KEY)
  }
  return committed
}

const persistSeed = (): GovernanceState => {
  const seed = createSeedState()
  localStorage.setItem(COMMIT_KEY, JSON.stringify(buildEnvelope(seed)))
  localStorage.removeItem(JOURNAL_KEY)
  localStorage.removeItem(STORAGE_KEY)
  return seed
}

export const loadState = (): GovernanceState => {
  const recovered = recoverEnvelope()
  if (recovered) return recovered.state

  // 兼容旧版本直接写在主键上的裸数据：首次打开时按当前契约回填版本指纹
  const legacyRaw = localStorage.getItem(STORAGE_KEY)
  if (legacyRaw) {
    try {
      const parsed: unknown = JSON.parse(legacyRaw)
      if (isBareState(parsed)) {
        const result = migrateState(parsed)
        lastMigrationChanges = result.changes
        localStorage.setItem(COMMIT_KEY, JSON.stringify(buildEnvelope(result.state)))
        localStorage.removeItem(JOURNAL_KEY)
        localStorage.removeItem(STORAGE_KEY)
        return result.state
      }
    } catch {
      // 落到种子数据
    }
  }

  return persistSeed()
}

type FaultStage = 'journal' | 'commit' | null
let faultStage: FaultStage = null

/**
 * 原子写入：先把完整状态（含契约快照与依赖状态）写入暂存区，
 * 再覆盖提交区，最后清理暂存区。任一步失败后，提交区仍是上一份完整数据，
 * 重启时 recoverEnvelope 会从暂存区补齐这次写入。
 */
export const saveState = (state: GovernanceState): void => {
  const envelope = buildEnvelope(structuredClone(state))
  const serialized = JSON.stringify(envelope)

  localStorage.setItem(JOURNAL_KEY, serialized)
  if (faultStage === 'journal') {
    faultStage = null
    throw new Error('模拟故障：暂存区写入后中断，提交区保持上一份完整数据')
  }
  localStorage.setItem(COMMIT_KEY, serialized)
  if (faultStage === 'commit') {
    faultStage = null
    throw new Error('模拟故障：提交区写入时中断，重启后将按暂存区恢复')
  }
  localStorage.removeItem(JOURNAL_KEY)
  listeners.forEach((listener) => listener(state))
}

export const resetState = (): GovernanceState => {
  const seed = persistSeed()
  listeners.forEach((listener) => listener(seed))
  return seed
}

/** 直接读取已提交的最新状态（含其他窗口刚提交的写入），用于提交前的并发校验 */
export const peekCommittedState = (): GovernanceState => {
  const envelope = readEnvelope(COMMIT_KEY)
  return envelope ? envelope.state : loadState()
}

/** 供开发环境演示“写入中途失败后恢复”，在 dev 控制台通过 __eventrailDebug 调用 */
export const simulateWriteFault = (stage: Exclude<FaultStage, null>): string => {
  faultStage = stage
  return stage === 'journal'
    ? '下一次保存将在暂存区写入后中断；刷新页面会自动恢复到这次的完整状态'
    : '下一次保存将在提交区写入时中断；暂存区完整，刷新页面自动恢复'
}

export const journalStatus = (): { commit: boolean; journal: boolean } => ({
  commit: readEnvelope(COMMIT_KEY) !== null,
  journal: readEnvelope(JOURNAL_KEY) !== null,
})

/** 其他窗口/标签页完成一次提交后，同步本窗口的内存状态并刷新查询缓存 */
export const subscribeStateChanges = (listener: StorageListener): (() => void) => {
  listeners.add(listener)

  const onStorage = (event: StorageEvent): void => {
    if (event.key !== COMMIT_KEY || !event.newValue) return
    const envelope = readEnvelope(COMMIT_KEY)
    if (envelope) listener(envelope.state)
  }
  window.addEventListener('storage', onStorage)

  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}
