// 仅供 scripts/verify-release-invariants.mjs 打包用：每个 Pinia 实例对应一个“浏览器窗口”
import { createPinia, setActivePinia } from 'pinia'
import { useGovernanceStore } from '@/stores/governance'

export const createTestStore = () => {
  setActivePinia(createPinia())
  return useGovernanceStore()
}
