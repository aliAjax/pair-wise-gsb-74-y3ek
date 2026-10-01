<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import { RouterView } from 'vue-router'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const queryClient = useQueryClient()

// 旧数据没有版本指纹：首次打开时按当前契约回填
store.hydrateBackfillNotices()

let unsubscribe: (() => void) | undefined
onMounted(() => {
  // 其他窗口提交发布/契约后，本窗口同步内存状态并刷新查询缓存
  unsubscribe = store.subscribeStateChanges((next) => {
    store.syncFromCommitted(next)
    void queryClient.invalidateQueries()
  })
})
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <RouterView />
</template>
