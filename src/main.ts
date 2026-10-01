import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { VueQueryPlugin } from '@tanstack/vue-query'
import TDesign from 'tdesign-vue-next'
import 'tdesign-vue-next/es/style/index.css'
import './styles/global.css'
import App from './App.vue'
import router from './router'
import { journalStatus, simulateWriteFault } from './services/repository'

createApp(App)
  .use(createPinia())
  .use(router)
  .use(VueQueryPlugin, {
    queryClientConfig: {
      defaultOptions: {
        queries: {
          staleTime: 10_000,
          retry: 1,
          refetchOnWindowFocus: false,
        },
      },
    },
  })
  .use(TDesign)
  .mount('#app')

// 开发环境演示“写入中途失败后恢复”：
// __eventrailDebug.crashOnNextWrite('journal' | 'commit') 触发下一次保存中断，
// 刷新页面后自动按暂存区恢复；__eventrailDebug.storage() 查看提交区/暂存区状态
if (import.meta.env.DEV) {
  ;(window as unknown as { __eventrailDebug?: unknown }).__eventrailDebug = {
    crashOnNextWrite: simulateWriteFault,
    storage: journalStatus,
  }
}

