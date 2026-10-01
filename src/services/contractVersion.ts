import type {
  ContractDifference,
  EventDefinition,
  GovernanceState,
  Platform,
  PlatformRule,
  PlatformRuleDifference,
  ReleaseCandidate,
} from '@/models/domain'

/** 当前持久化状态的结构版本，旧数据缺少该字段时需要迁移回填 */
export const CURRENT_SCHEMA_VERSION = 2

const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_key, current) => {
    if (current === null || typeof current !== 'object') return current
    const record = current as Record<string, unknown>
    if (seen.has(record)) return undefined
    seen.add(record)
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = record[key]
        return sorted
      }, {})
  })
}

const digest = (input: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fp${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 事件契约指纹：只覆盖参与发布评审的契约要素——
 * 有效属性（名称、类型、必填、枚举）与平台规则（启用、触发、必填属性）。
 * 负责人、描述、同义词等元数据变化不构成候选失效。
 */
export const eventContractFingerprint = (event: EventDefinition): string => {
  const properties = event.properties
    .filter((property) => !property.deletedAt)
    .map((property) => ({
      id: property.id,
      name: property.name,
      type: property.type,
      required: property.required,
      enumValues: [...property.enumValues].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  const rules = event.platformRules
    .map((rule) => ({
      platform: rule.platform,
      enabled: rule.enabled,
      trigger: rule.trigger,
      requiredPropertyIds: [...rule.requiredPropertyIds].sort(),
    }))
    .sort((left, right) => left.platform.localeCompare(right.platform))
  return digest(stableStringify({ id: event.id, properties, rules }))
}

/** 候选范围内所有事件指纹的聚合，候选创建时固化 */
export const releaseScopeFingerprint = (
  state: GovernanceState,
  eventIds: string[],
): string => {
  const fingerprints = eventIds
    .map((eventId) => state.events.find((event) => event.id === eventId))
    .filter((event): event is EventDefinition => Boolean(event))
    .map(eventContractFingerprint)
    .sort()
  return digest(fingerprints.join('|'))
}

export const comparePlatformRules = (
  event: EventDefinition,
  before: PlatformRule[] | undefined,
  after: PlatformRule[],
): PlatformRuleDifference[] => {
  // 旧快照没有平台规则时不臆造差异，避免回填后产生破坏性噪音
  if (!before) return []
  const beforeMap = new Map<Platform, PlatformRule>(before.map((rule) => [rule.platform, rule]))
  const afterMap = new Map<Platform, PlatformRule>(after.map((rule) => [rule.platform, rule]))
  const platforms = Array.from(
    new Set<Platform>([...beforeMap.keys(), ...afterMap.keys()]),
  ).sort()
  const propertyName = (propertyId: string): string =>
    event.properties.find((property) => property.id === propertyId)?.name ?? propertyId

  return platforms.flatMap((platform): PlatformRuleDifference[] => {
    const previous = beforeMap.get(platform)
    const current = afterMap.get(platform)
    if (!previous && current) {
      return [
        {
          platform,
          enabledChange: `新增平台规则（${current.enabled ? '启用' : '停用'}）`,
          requiredPropertyAdded: current.requiredPropertyIds.map(propertyName),
          requiredPropertyRemoved: [],
        },
      ]
    }
    if (previous && !current) {
      return [
        {
          platform,
          enabledChange: '平台规则已移除',
          requiredPropertyAdded: [],
          requiredPropertyRemoved: previous.requiredPropertyIds.map(propertyName),
        },
      ]
    }
    if (!previous || !current) return []

    const added = current.requiredPropertyIds.filter((id) => !previous.requiredPropertyIds.includes(id))
    const removed = previous.requiredPropertyIds.filter((id) => !current.requiredPropertyIds.includes(id))
    const enabledChange =
      previous.enabled === current.enabled
        ? undefined
        : `${previous.enabled ? '启用' : '停用'} → ${current.enabled ? '启用' : '停用'}`
    const triggerChanged = previous.trigger.trim() !== current.trigger.trim()

    if (
      enabledChange === undefined &&
      !triggerChanged &&
      added.length === 0 &&
      removed.length === 0
    ) {
      return []
    }
    return [
      {
        platform,
        enabledChange,
        triggerChange: triggerChanged ? true : undefined,
        requiredPropertyAdded: added.map(propertyName),
        requiredPropertyRemoved: removed.map(propertyName),
      },
    ]
  })
}

export const isEmptyDifference = (difference: ContractDifference): boolean =>
  difference.addedProperties.length === 0 &&
  difference.removedProperties.length === 0 &&
  difference.requiredChanges.length === 0 &&
  difference.typeChanges.length === 0 &&
  difference.enumChanges.length === 0 &&
  difference.platformChanges.length === 0

/** 候选是否仍与当前契约一致；契约更新后返回 false，需要失效重算 */
export const isReleaseStale = (release: ReleaseCandidate, state: GovernanceState): boolean => {
  if (!release.contractFingerprint) return true
  return release.contractFingerprint !== releaseScopeFingerprint(state, release.eventIds)
}

/** 同版本是否已有更早放行（评审中或已发布）的候选 */
export const findVersionOwner = (
  releases: ReleaseCandidate[],
  version: string,
  exceptId?: string,
): ReleaseCandidate | undefined =>
  releases
    .filter(
      (release) =>
        release.id !== exceptId &&
        release.version === version &&
        !release.duplicateOf &&
        (release.status === 'reviewing' || release.status === 'published'),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0]
