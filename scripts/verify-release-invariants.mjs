// 用 esbuild 把 TS 源码打包后在 Node 中运行，localStorage 用内存 shim 模拟
import { build } from 'esbuild'
import { writeFileSync, mkdirSync } from 'node:fs'

const makeShim = () => {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (globalThis.__crashOn === key) {
        globalThis.__crashOn = null
        throw new Error(`simulated quota write failure at ${key}`)
      }
      map.set(key, value)
    },
    removeItem: (key) => map.delete(key),
    _setRaw: (key, value) => map.set(key, value),
    _peek: (key) => map.get(key),
  }
}

const results = []
const test = (name, fn) => {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.stack ?? error.message : String(error),
    })
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

mkdirSync('/workspace/node_modules/.tmp', { recursive: true })
const bundled = await build({
  entryPoints: ['/workspace/src/test-entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  external: ['vue', 'pinia'],
  alias: { '@': '/workspace/src' },
})
const bundlePath = '/workspace/node_modules/.tmp/test-bundle.mjs'
writeFileSync(bundlePath, bundled.outputFiles[0].text)

// 每个测试批次使用独立模块实例；localStorage shim 在同批次内共享以模拟两个窗口
const loadModule = async (sharedShim) => {
  const shim = sharedShim ?? makeShim()
  globalThis.localStorage = shim
  // Node 的 structuredClone 不接受 Vue 响应式 Proxy，浏览器可以；测试环境用 JSON 深拷贝代替
  globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value))
  globalThis.window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
  const url = `file://${bundlePath}?t=${Date.now()}-${Math.random()}`
  const mod = await import(url)
  return { mod, shim }
}

// ---------- 测试 1：属性变化导致差异/依赖/迁移/审批失效 ----------
{
  const { mod } = await loadModule()
  const store = mod.createTestStore()
  const releaseId = 'rel-001'
  const rel = () => store.data.releases.find((r) => r.id === releaseId)
  assert(rel().approvals[0].status === 'approved', '种子数据角色审批应为已通过')
  assert(
    rel().migrationConfirmations.find((m) => m.id === 'mig-002').status === 'confirmed',
    'dep-004 迁移应已确认',
  )

  const evt3 = store.data.events.find((e) => e.id === 'evt-003')
  const prop = evt3.properties.find((p) => p.id === 'prop-013')
  store.saveProperty('evt-003', { ...prop, enumValues: [...prop.enumValues, 'gesture'] })

  test('契约变更后旧审批作废为 pending 且保留作废原因', () => {
    const after = rel()
    const dataApproval = after.approvals.find((a) => a.role === 'data')
    assert(dataApproval.status === 'pending', '旧审批状态必须重置为 pending')
    assert(Boolean(dataApproval.invalidatedAt), '必须记录作废时间')
    assert(dataApproval.invalidatedReason.includes('属性'), '必须记录作废原因')
    assert(Boolean(dataApproval.comment), '旧审批意见应保留为处理记录')
  })
  test('契约变更后差异重算（枚举变化进入 enumChanges）', () => {
    const diff = rel().differences.find((d) => d.eventId === 'evt-003')
    assert(diff.enumChanges.some((c) => c.includes('gesture')), '差异必须包含新枚举 gesture')
  })
  test('契约变更后已确认迁移被作废', () => {
    const mig = rel().migrationConfirmations.find((m) => m.id === 'mig-002')
    assert(mig.status === 'pending', '旧迁移确认必须回到 pending')
    assert(Boolean(mig.invalidatedAt), '旧迁移确认必须标记作废')
  })
  test('发布门禁拒绝放行作废审批', () => {
    const outcome = store.publishRelease(releaseId)
    assert(outcome.kind === 'blocked', `应被门禁拦截，实际 ${outcome.kind}`)
  })
  test('重算幂等：指纹未再变化时不重复作废', () => {
    const sameProp = store.data.events
      .find((e) => e.id === 'evt-003')
      .properties.find((p) => p.id === 'prop-013')
    store.saveProperty('evt-003', { ...sameProp })
    const recalcs = store.data.audit.filter((a) => a.action === '契约更新，门禁重算').length
    assert(recalcs === 1, `重算应只发生一次，实际 ${recalcs}`)
  })
}

// ---------- 测试 2：平台规则变化同样触发失效 ----------
{
  const { mod } = await loadModule()
  const store = mod.createTestStore()
  const evt1 = store.data.events.find((e) => e.id === 'evt-001')
  const rule = evt1.platformRules.find((r) => r.id === 'rule-001')
  store.savePlatformRule('evt-001', { ...rule, trigger: '变更后的触发时机说明' })
  test('平台规则变化触发候选指纹失效与重算', () => {
    const rel = store.data.releases.find((r) => r.id === 'rel-001')
    assert(rel.recalculatedAt, '必须记录重算时间')
    assert(rel.recalculationReason.includes('平台规则'), '必须记录平台规则原因')
    assert(
      rel.approvals.every((a) => a.status === 'pending'),
      '所有审批必须回到 pending',
    )
  })
}

// ---------- 测试 3：两个窗口同时提交同一版本只放行一份 ----------
{
  const shim = makeShim()
  const { mod } = await loadModule(shim)
  const storeA = mod.createTestStore()
  const storeB = mod.createTestStore()
  const outcomeA = storeA.createRelease('2026.11.0', 'A 窗口提交', ['evt-002'])
  const outcomeB = storeB.createRelease('2026.11.0', 'B 窗口提交', ['evt-002'])
  test('同版本并发提交只创建一份候选', () => {
    assert(outcomeA.kind === 'created', `A 应成功，实际 ${outcomeA.kind}`)
    assert(outcomeB.kind === 'duplicate', `B 必须被标记 duplicate，实际 ${outcomeB.kind}`)
    assert(outcomeB.existing.id === outcomeA.release.id, 'duplicate 应指向已放行的候选')
  })
  test('被拦截窗口保留“契约已更新”处理记录', () => {
    const hits = storeB.data.audit.filter((a) => a.action === '同版本提交被拦截')
    assert(hits.length >= 1, '必须保留拦截审计')
    assert(hits[0].detail.includes('契约已更新'), '审计必须说明契约已更新')
  })
  test('被拦截窗口未创建第二条候选', () => {
    const sameVersion = storeB.data.releases.filter((r) => r.version === '2026.11.0')
    assert(sameVersion.length === 1, `同版本只能有一份，实际 ${sameVersion.length}`)
  })
}

// ---------- 测试 4：写入中途失败恢复，提交区始终完整 ----------
{
  const { mod, shim } = await loadModule()
  const store = mod.createTestStore()
  const beforeCommit = shim._peek('eventrail-governance-v1:commit')
  assert(beforeCommit, '初始提交区必须存在')

  globalThis.__crashOn = 'eventrail-governance-v1:commit'
  let threw = false
  try {
    const evt3 = store.data.events.find((e) => e.id === 'evt-003')
    const prop = evt3.properties.find((p) => p.id === 'prop-012')
    store.saveProperty('evt-003', { ...prop, description: '崩溃前的修改不应进入提交区' })
  } catch {
    threw = true
  }
  test('暂存后提交前崩溃：抛错且提交区仍是上一份完整数据', () => {
    assert(threw, '必须向上抛出写入错误')
    assert(shim._peek('eventrail-governance-v1:commit') === beforeCommit, '提交区不得被半写')
    assert(shim._peek('eventrail-governance-v1:journal'), '暂存区必须保留完整新状态')
  })

  const store2 = mod.createTestStore()
  test('重启后从暂存区恢复丢失的写入且数据完整', () => {
    const prop = store2.data.events
      .find((e) => e.id === 'evt-003')
      .properties.find((p) => p.id === 'prop-012')
    assert(prop.description.includes('崩溃前的修改'), '暂存区的完整修改必须恢复')
    assert(!shim._peek('eventrail-governance-v1:journal'), '恢复后暂存区应被清理')
    const reviewing = store2.data.releases.filter((r) => r.status === 'reviewing')
    assert(
      reviewing.every((r) => r.contractFingerprint),
      '候选指纹必须随整批状态一起恢复',
    )
  })
}

// ---------- 测试 5：旧数据回填 + 迁移确认只对当前版本有效 ----------
{
  const { mod, shim } = await loadModule()
  const store0 = mod.createTestStore()
  const state = JSON.parse(JSON.stringify(store0.data))
  // 清掉信封，模拟只有旧版本裸数据的现场
  shim.removeItem('eventrail-governance-v1:commit')
  shim.removeItem('eventrail-governance-v1:journal')
  state.releases.forEach((r) => delete r.contractFingerprint)
  const stale = state.releases.find((r) => r.id === 'rel-001')
  stale.migrationConfirmations[0].version = '2026.09.0'
  stale.migrationConfirmations[0].status = 'confirmed'
  shim._setRaw('eventrail-governance-v1', JSON.stringify(state))

  const store = mod.createTestStore()
  test('首次打开按当前契约回填版本指纹并迁移信封', () => {
    const rel = store.data.releases.find((r) => r.id === 'rel-001')
    assert(rel.contractFingerprint && rel.contractFingerprint.startsWith('fp-'), '必须回填指纹')
    assert(!shim._peek('eventrail-governance-v1'), '旧裸主键应迁移')
    assert(shim._peek('eventrail-governance-v1:commit'), '新提交区必须写入')
  })
  test('跨版本旧迁移确认作废且不放行', () => {
    const rel = store.data.releases.find((r) => r.id === 'rel-001')
    const old = rel.migrationConfirmations[0]
    assert(old.status === 'pending', '跨版本确认必须回到 pending')
    assert(old.invalidatedAt, '必须标记作废时间')
  })
}

// ---------- 汇总 ----------
let failed = 0
for (const r of results) {
  if (r.ok) {
    console.log(`  ✓ ${r.name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${r.name}\n${r.detail}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
