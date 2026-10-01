import type {
  DownstreamDependency,
  EventDefinition,
  EventProperty,
  GovernanceState,
  PlatformRule,
} from '@/models/domain'

let sequence = 0

export const makeProperty = (overrides: Partial<EventProperty> = {}): EventProperty => {
  sequence += 1
  const name = overrides.name ?? `prop_${sequence}`
  return {
    id: overrides.id ?? `prop-${sequence}`,
    eventId: overrides.eventId ?? 'evt-1',
    name,
    displayName: name,
    type: 'string',
    required: false,
    description: '',
    enumValues: [],
    owner: 'tester',
    synonyms: [],
    platforms: ['web'],
    ...overrides,
  }
}

export const makeRule = (overrides: Partial<PlatformRule> = {}): PlatformRule => ({
  id: overrides.id ?? 'rule-web',
  eventId: overrides.eventId ?? 'evt-1',
  platform: 'web',
  enabled: true,
  trigger: '页面加载时上报',
  owner: 'web 组',
  requiredPropertyIds: [],
  note: '',
  ...overrides,
})

export const makeEvent = (overrides: Partial<EventDefinition> = {}): EventDefinition => ({
  id: 'evt-1',
  key: 'test_event_submit',
  displayName: '测试事件',
  category: '测试',
  description: '',
  trigger: '',
  status: 'reviewing',
  version: '1.0.0',
  owner: 'tester',
  properties: [makeProperty({ id: 'prop-a', name: 'order_id', required: true })],
  platformRules: [makeRule()],
  scenarioIds: [],
  downstreamDependencyIds: [],
  updatedAt: '2026-10-01T10:00:00+08:00',
  ...overrides,
})

export const makeDependency = (
  overrides: Partial<DownstreamDependency> = {},
): DownstreamDependency => ({
  id: 'dep-1',
  name: '交易实时看板',
  type: 'dashboard',
  owner: '数据组',
  environment: 'production',
  eventIds: ['evt-1'],
  propertyRefs: [{ eventId: 'evt-1', propertyId: 'prop-a' }],
  status: 'active',
  ...overrides,
})

export const makeState = (overrides: Partial<GovernanceState> = {}): GovernanceState => ({
  events: [makeEvent()],
  scenarios: [],
  dependencies: [makeDependency()],
  baselines: [],
  releases: [],
  deprecations: [],
  rollbacks: [],
  audit: [],
  currentVersion: '2026.10.0',
  schemaVersion: 2,
  ...overrides,
})
