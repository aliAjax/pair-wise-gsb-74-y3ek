<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  AddIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CloseCircleIcon,
  DownloadIcon,
  RefreshIcon,
} from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useReleaseQuery, useReleasesQuery } from '@/composables/useGovernanceQueries'
import type { ReleaseApproval } from '@/models/domain'
import { isReleaseOperable, isReleaseWaitingRecompute } from '@/services/releaseWorkflow'
import { releaseReadiness } from '@/services/selectors'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const queryClient = useQueryClient()
const releasesQuery = useReleasesQuery()
const releaseId = ref(
  store.data.releases.find((release) => release.status === 'reviewing')?.id ??
    store.data.releases[0]?.id ??
    '',
)
const releaseQuery = useReleaseQuery(releaseId)
const release = computed(
  () =>
    releaseQuery.data.value ??
    store.data.releases.find((item) => item.id === releaseId.value) ??
    null,
)
const releases = computed(() => releasesQuery.data.value ?? store.data.releases)
const isStale = computed(
  () => Boolean(release.value) && isReleaseWaitingRecompute(release.value!, store.data),
)
const operable = computed(() => Boolean(release.value) && isReleaseOperable(release.value!))
const duplicateOwner = computed(() =>
  release.value?.duplicateOf
    ? store.data.releases.find((item) => item.id === release.value!.duplicateOf)
    : undefined,
)
const readiness = computed(() =>
  release.value && operable.value && !isStale.value
    ? releaseReadiness(release.value, store.issues)
    : 0,
)

const platformLabel = (platform: string): string =>
  ({ web: 'Web', ios: 'iOS', android: 'Android', server: '服务端', miniprogram: '小程序' })[
    platform
  ] ?? platform

const createVisible = ref(false)
const migrationVisible = ref(false)
const approvalVisible = ref(false)
const createForm = reactive({
  version: '',
  title: '',
  eventIds: [] as string[],
})
const migrationForm = reactive({
  confirmationId: '',
  reviewer: '',
  note: '',
})
const selectedApprovalIds = ref<string[]>([])
const approvalComment = ref('')
const singleApproval = ref<ReleaseApproval | null>(null)

const eventName = (eventId: string): string => {
  const event = store.data.events.find((item) => item.id === eventId)
  return event ? `${event.displayName} (${event.key})` : eventId
}
const dependencyName = (dependencyId: string): string =>
  store.data.dependencies.find((dependency) => dependency.id === dependencyId)?.name ?? dependencyId
const roleLabel = (role: ReleaseApproval['role']): string =>
  ({ data: '数据负责人', product: '产品负责人', client: '客户端负责人', qa: '测试负责人' })[role]

const invalidate = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: ['release'] })
  await queryClient.invalidateQueries({ queryKey: ['releases'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  await queryClient.invalidateQueries({ queryKey: ['lineage'] })
}

/**
 * 候选首次打开或切换打开时：若契约已更新（含旧数据没有版本指纹），
 * 按当前契约自动重算差异、受影响依赖与迁移确认；旧审批归档不再放行。
 */
watch(
  release,
  (current) => {
    if (!current || !isReleaseWaitingRecompute(current, store.data)) return
    store.refreshStaleRelease(current.id)
    void invalidate().then(() => {
      void MessagePlugin.warning(
        `候选 ${current.version} 已按最新契约重算，旧审批与旧迁移确认失效`,
      )
    })
  },
  { immediate: true },
)

const openCreate = (): void => {
  createForm.version = `2026.${String(Number(store.data.currentVersion.split('.')[1] ?? 10) + 1).padStart(2, '0')}.0`
  createForm.title = ''
  createForm.eventIds = []
  createVisible.value = true
}

const createRelease = async (): Promise<void> => {
  if (!createForm.version.trim() || !createForm.title.trim() || createForm.eventIds.length === 0) {
    await MessagePlugin.error('版本号、标题和事件范围不能为空')
    return
  }
  const result = store.createRelease(createForm.version, createForm.title, createForm.eventIds)
  if (result.duplicateRecord && result.duplicateOf) {
    releaseId.value = result.duplicateRecord.id
    createVisible.value = false
    await invalidate()
    await MessagePlugin.warning(
      `版本 ${createForm.version} 已由「${result.duplicateOf.title}」先行提交并进入评审，本次提交仅保留处理记录`,
    )
    return
  }
  if (result.release) {
    releaseId.value = result.release.id
  }
  createVisible.value = false
  await invalidate()
  await MessagePlugin.success('发布候选已创建，已生成下游迁移清单')
}

const recompute = async (): Promise<void> => {
  if (!release.value) return
  store.refreshStaleRelease(release.value.id)
  await invalidate()
  await MessagePlugin.warning('契约已更新，差异、受影响依赖与迁移确认已按最新契约重算，旧审批失效')
}

const openMigration = (confirmationId: string): void => {
  if (!release.value || isStale.value) return
  const confirmation = release.value.migrationConfirmations.find(
    (item) => item.id === confirmationId,
  )
  if (!confirmation) return
  migrationForm.confirmationId = confirmationId
  migrationForm.reviewer = confirmation.reviewer
  migrationForm.note = confirmation.note
  migrationVisible.value = true
}

const confirmMigration = async (): Promise<void> => {
  if (!release.value || !migrationForm.reviewer.trim() || !migrationForm.note.trim()) {
    await MessagePlugin.error('确认人和迁移说明不能为空')
    return
  }
  store.confirmMigration(
    release.value.id,
    migrationForm.confirmationId,
    migrationForm.reviewer,
    migrationForm.note,
  )
  migrationVisible.value = false
  await invalidate()
  await MessagePlugin.success('下游迁移已确认，仅对当前版本契约有效')
}

const openApproval = (approval: ReleaseApproval): void => {
  if (isStale.value) return
  singleApproval.value = approval
  approvalComment.value = approval.comment
  approvalVisible.value = true
}

const submitApproval = async (status: ReleaseApproval['status']): Promise<void> => {
  if (!release.value || !singleApproval.value || !approvalComment.value.trim()) {
    await MessagePlugin.error('审批意见不能为空')
    return
  }
  store.updateApproval(
    release.value.id,
    singleApproval.value.role,
    status,
    singleApproval.value.actor,
    approvalComment.value,
  )
  approvalVisible.value = false
  await invalidate()
  await MessagePlugin.success(status === 'approved' ? '审批已通过' : '审批已驳回')
}

const batchApprove = async (): Promise<void> => {
  if (!release.value || isStale.value) return
  if (selectedApprovalIds.value.length === 0 || !approvalComment.value.trim()) {
    await MessagePlugin.error('请选择审批项并填写批量审批意见')
    return
  }
  selectedApprovalIds.value.forEach((id) => {
    const approval = release.value?.approvals.find((item) => item.id === id)
    if (approval) {
      store.updateApproval(
        release.value!.id,
        approval.role,
        'approved',
        approval.actor,
        approvalComment.value,
      )
    }
  })
  selectedApprovalIds.value = []
  approvalComment.value = ''
  await invalidate()
  await MessagePlugin.success('批量审批已提交')
}

const publish = async (): Promise<void> => {
  if (!release.value) return
  if (isStale.value) {
    await MessagePlugin.error('契约已更新，请先重算候选后再发布')
    return
  }
  if (!store.publishRelease(release.value.id)) {
    await MessagePlugin.error('迁移确认或四角色审批尚未完成，当前不可发布')
    return
  }
  await invalidate()
  await MessagePlugin.success('事件契约版本已发布')
}

const downloadDiff = (): void => {
  if (!release.value) return
  const content = JSON.stringify(
    {
      release: release.value.version,
      events: release.value.eventIds.map(eventName),
      differences: release.value.differences,
      affectedDependencies: release.value.affectedDependencyIds.map(dependencyName),
      migrationConfirmations: release.value.migrationConfirmations,
    },
    null,
    2,
  )
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${release.value.version}-contract-diff.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

const setApprovalChecked = (approvalId: string, checked: unknown): void => {
  selectedApprovalIds.value = checked
    ? [...selectedApprovalIds.value, approvalId]
    : selectedApprovalIds.value.filter((id) => id !== approvalId)
}
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="发布门禁"
      title="版本差异与发布评审"
      description="比较发布候选契约，生成受影响依赖，要求迁移确认并完成数据、产品、客户端和测试四角色审批。"
    />

    <section class="panel filter-panel">
      <div class="toolbar-row">
        <div class="toolbar-field release-field">
          <span>发布候选</span>
          <t-select
            v-model="releaseId"
            :options="releases.map((item) => ({
              label: `${item.duplicateOf ? '（重复提交）' : ''}${item.version} ${item.title}`,
              value: item.id,
            }))"
          />
        </div>
        <div class="filter-actions">
          <t-button
            variant="outline"
            :disabled="!release || !operable"
            @click="downloadDiff"
          >
            <template #icon><DownloadIcon /></template>
            导出差异
          </t-button>
          <t-button theme="primary" @click="openCreate">
            <template #icon><AddIcon /></template>
            创建发布候选
          </t-button>
        </div>
      </div>
    </section>

    <section v-if="release?.duplicateOf" class="panel duplicate-banner">
      <CloseCircleIcon />
      <div>
        <strong>同一版本的重复提交，未参与发布放行</strong>
        <p>{{ release.duplicateNote }}</p>
        <p v-if="duplicateOwner" class="muted">
          已放行候选：{{ duplicateOwner.version }} {{ duplicateOwner.title }}
          （<StatusTag :value="duplicateOwner.status" />），提交于
          {{ new Date(duplicateOwner.createdAt).toLocaleString('zh-CN') }}
        </p>
        <p class="muted">本记录提交于 {{ new Date(release.createdAt).toLocaleString('zh-CN') }}，保留事件范围：{{ release.eventIds.map(eventName).join('、') }}</p>
      </div>
    </section>

    <section v-else-if="isStale" class="panel stale-banner">
      <RefreshIcon />
      <div>
        <strong>契约已更新，当前候选的差异、受影响依赖与迁移确认已失效</strong>
        <p>
          {{ release?.invalidation?.reason ?? '属性或平台规则在上次评审后发生变化。' }}
          <template v-if="release?.invalidation?.changedEventKey">
            变更事件：{{ release.invalidation.changedEventKey }}
          </template>
          旧审批不再放行，请按最新契约重算后重新确认与审批。
        </p>
      </div>
      <t-button theme="warning" @click="recompute">
        <template #icon><RefreshIcon /></template>
        按最新契约重算
      </t-button>
    </section>

    <template v-if="release && !release.duplicateOf">
      <section class="release-overview">
        <div>
          <span>版本</span>
          <strong>{{ release.version }}</strong>
          <StatusTag :value="release.status" />
        </div>
        <div>
          <span>标题</span>
          <strong>{{ release.title }}</strong>
        </div>
        <div>
          <span>事件范围</span>
          <strong>{{ release.eventIds.length }} 个</strong>
        </div>
        <div>
          <span>发布就绪度</span>
          <strong>{{ readiness }}%</strong>
        </div>
        <t-button
          theme="primary"
          :disabled="!operable || isStale || release.status === 'published' || release.status === 'rolled_back'"
          @click="publish"
        >
          发布契约
          <template #suffix><ChevronRightIcon /></template>
        </t-button>
      </section>

      <div class="release-grid">
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">契约差异</h2>
            <span class="muted">{{ release.differences.length }} 个事件发生变化</span>
          </div>
          <div class="diff-list">
            <article v-for="difference in release.differences" :key="difference.eventId" class="diff-event">
              <div class="diff-event-head">
                <strong>{{ difference.eventKey }}</strong>
                <span>{{ eventName(difference.eventId) }}</span>
              </div>
              <div class="diff-columns">
                <div class="diff-block">
                  <h4>新增与删除</h4>
                  <ul>
                    <li v-for="item in difference.addedProperties" :key="`add-${item}`">
                      新增属性 {{ item }}
                    </li>
                    <li v-for="item in difference.removedProperties" :key="`remove-${item}`">
                      删除属性 {{ item }}
                    </li>
                  </ul>
                  <span
                    v-if="
                      difference.addedProperties.length === 0 &&
                      difference.removedProperties.length === 0
                    "
                    class="muted"
                  >
                    无属性增删
                  </span>
                </div>
                <div class="diff-block">
                  <h4>兼容性变化</h4>
                  <ul>
                    <li v-for="item in difference.requiredChanges" :key="item">{{ item }}</li>
                    <li v-for="item in difference.typeChanges" :key="item">{{ item }}</li>
                    <li v-for="item in difference.enumChanges" :key="item">{{ item }}</li>
                    <li
                      v-for="item in difference.platformChanges"
                      :key="difference.eventId + '-' + item.platform"
                      class="platform-diff"
                    >
                      {{ platformLabel(item.platform) }} 平台规则：
                      <template v-if="item.enabledChange">{{ item.enabledChange }}；</template>
                      <template v-if="item.triggerChange">触发时机变化；</template>
                      <template v-if="item.requiredPropertyAdded.length">
                        必填新增 {{ item.requiredPropertyAdded.join('、') }}；
                      </template>
                      <template v-if="item.requiredPropertyRemoved.length">
                        必填移除 {{ item.requiredPropertyRemoved.join('、') }}；
                      </template>
                    </li>
                  </ul>
                  <span
                    v-if="
                      difference.requiredChanges.length === 0 &&
                      difference.typeChanges.length === 0 &&
                      difference.enumChanges.length === 0 &&
                      difference.platformChanges.length === 0
                    "
                    class="muted"
                  >
                    无破坏性变化
                  </span>
                </div>
              </div>
            </article>
            <div v-if="release.differences.length === 0" class="empty-state">该版本没有契约差异。</div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">发布门禁</h2>
          </div>
          <div class="gate-list">
            <div class="gate-row">
              <CheckCircleIcon :class="{ pending: isStale }" />
              <div>
                <strong>契约差异已生成</strong>
                <span>{{ release.differences.length }} 个事件参与比较</span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{
                  pending: isStale || release.migrationConfirmations.some((item) => item.status !== 'confirmed'),
                }"
              />
              <div>
                <strong>下游迁移确认（仅当前版本有效）</strong>
                <span>
                  {{
                    release.migrationConfirmations.filter((item) => item.status === 'confirmed').length
                  }}/{{ release.migrationConfirmations.length }} 已确认
                </span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{ pending: isStale || release.approvals.some((item) => item.status !== 'approved') }"
              />
              <div>
                <strong>四角色批量审批</strong>
                <span>
                  {{ release.approvals.filter((item) => item.status === 'approved').length }}/{{
                    release.approvals.length
                  }}
                  已通过
                </span>
              </div>
            </div>
            <div v-if="isStale" class="stale-note">
              契约指纹与当前不一致，门禁暂停，需先重算；旧审批与旧迁移确认保留在各自历史中但不放行。
            </div>
            <div class="readiness">
              <span>综合就绪度</span>
              <strong>{{ readiness }}%</strong>
              <t-progress :percentage="readiness" :label="false" />
            </div>
          </div>
        </section>
      </div>

      <div class="review-columns">
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">下游迁移确认</h2>
          </div>
          <div class="migration-list">
            <article
              v-for="confirmation in release.migrationConfirmations"
              :key="confirmation.id"
              class="migration-card"
            >
              <div>
                <strong>{{ dependencyName(confirmation.dependencyId) }}</strong>
                <span>{{ confirmation.reviewer || '未指定确认人' }} · 版本 {{ confirmation.version }}</span>
              </div>
              <StatusTag :value="isStale ? 'pending' : confirmation.status" />
              <p>{{ confirmation.note || '尚未填写迁移确认说明。' }}</p>
              <details v-if="confirmation.history && confirmation.history.length > 0" class="history-box">
                <summary>历史确认记录（{{ confirmation.history.length }} 条，不对当前版本放行）</summary>
                <ul>
                  <li v-for="(record, index) in confirmation.history" :key="`${confirmation.id}-hist-${index}`">
                    {{ record.version }} · {{ record.status === 'confirmed' ? '已确认' : '已驳回' }} ·
                    {{ record.reviewer }} · {{ new Date(record.confirmedAt).toLocaleDateString('zh-CN') }}
                    <span class="muted">失效原因：{{ record.reason }}</span>
                    <span v-if="record.note" class="muted">说明：{{ record.note }}</span>
                  </li>
                </ul>
              </details>
              <t-button
                variant="outline"
                size="small"
                :disabled="isStale || confirmation.status === 'confirmed'"
                @click="openMigration(confirmation.id)"
              >
                {{ isStale ? '契约已更新，待重算' : '确认迁移' }}
              </t-button>
            </article>
            <div v-if="release.migrationConfirmations.length === 0" class="empty-state">
              当前差异不影响已登记的下游依赖。
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">四角色审批</h2>
          </div>
          <div class="approval-list">
            <label v-for="approval in release.approvals" :key="approval.id" class="approval-row">
              <t-checkbox
                :value="selectedApprovalIds.includes(approval.id)"
                :disabled="isStale || approval.status === 'approved'"
                @change="setApprovalChecked(approval.id, $event)"
              />
              <div>
                <strong>{{ roleLabel(approval.role) }}</strong>
                <span>{{ approval.actor }} · {{ approval.comment || '待填写意见' }}</span>
                <details v-if="approval.history && approval.history.length > 0" class="history-box">
                  <summary>历史审批（{{ approval.history.length }} 条，不对变更后契约放行）</summary>
                  <ul>
                    <li v-for="(record, index) in approval.history" :key="`${approval.id}-hist-${index}`">
                      {{ record.status === 'approved' ? '已通过' : '已驳回' }} · {{ record.actor }} ·
                      {{ record.createdAt ? new Date(record.createdAt).toLocaleDateString('zh-CN') : '' }}
                      <span class="muted">失效原因：{{ record.reason }}</span>
                      <span v-if="record.comment" class="muted">意见：{{ record.comment }}</span>
                    </li>
                  </ul>
                </details>
              </div>
              <StatusTag :value="isStale ? 'pending' : approval.status" />
              <t-button variant="text" size="small" :disabled="isStale" @click.prevent="openApproval(approval)">
                审批
              </t-button>
            </label>
          </div>
          <div class="batch-bar">
            <t-input v-model="approvalComment" :disabled="isStale" placeholder="批量审批意见" />
            <t-button theme="primary" :disabled="isStale" @click="batchApprove">批量通过</t-button>
          </div>
        </section>
      </div>
    </template>

    <div v-else class="panel empty-state">暂无发布候选。</div>

    <t-dialog v-model:visible="createVisible" header="创建发布候选" width="720px" :footer="false">
      <div class="editor-form">
        <div class="field">
          <label>版本号</label>
          <t-input v-model="createForm.version" />
        </div>
        <div class="field">
          <label>发布标题</label>
          <t-input v-model="createForm.title" />
        </div>
        <div class="field field-wide">
          <label>参与发布的事件</label>
          <t-select
            v-model="createForm.eventIds"
            :options="
              store.data.events
                .filter((event) => event.status !== 'retired')
                .map((event) => ({
                  label: `${event.displayName} (${event.key})`,
                  value: event.id,
                }))
            "
            multiple
            filterable
          />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="createVisible = false">取消</t-button>
        <t-button theme="primary" @click="createRelease">创建并比较</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="migrationVisible" header="确认下游迁移" width="620px" :footer="false">
      <div class="editor-form">
        <div class="field">
          <label>确认人</label>
          <t-input v-model="migrationForm.reviewer" />
        </div>
        <div class="field field-wide">
          <label>迁移说明</label>
          <t-textarea v-model="migrationForm.note" :autosize="{ minRows: 5, maxRows: 8 }" />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="migrationVisible = false">取消</t-button>
        <t-button theme="primary" @click="confirmMigration">确认迁移</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="approvalVisible" header="提交审批" width="620px" :footer="false">
      <div v-if="singleApproval" class="selected-approval">
        <strong>{{ roleLabel(singleApproval.role) }}</strong>
        <span>{{ singleApproval.actor }}</span>
      </div>
      <div class="field">
        <label>审批意见</label>
        <t-textarea v-model="approvalComment" :autosize="{ minRows: 5, maxRows: 8 }" />
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="approvalVisible = false">取消</t-button>
        <t-button theme="danger" @click="submitApproval('rejected')">
          <template #icon><CloseCircleIcon /></template>
          驳回
        </t-button>
        <t-button theme="primary" @click="submitApproval('approved')">
          <template #icon><CheckCircleIcon /></template>
          通过
        </t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.filter-panel {
  padding: 14px 16px;
}

.duplicate-banner,
.stale-banner {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 14px 16px;
}

.duplicate-banner svg {
  color: #c42d2d;
}

.stale-banner svg {
  color: #c46a00;
}

.duplicate-banner p,
.stale-banner p {
  margin: 4px 0 0;
  color: #5c6778;
  font-size: 12px;
  line-height: 1.6;
}

.stale-note {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 4px;
  background: #fdf3e7;
  color: #a35a00;
  font-size: 12px;
  line-height: 1.5;
}

.platform-diff {
  color: #8a5a00;
}

.history-box {
  margin-top: 4px;
  font-size: 11px;
}

.history-box summary {
  color: #8a4b4b;
  cursor: pointer;
}

.history-box ul {
  display: grid;
  gap: 4px;
  margin: 6px 0 0;
  padding-left: 16px;
}

.history-box li {
  display: grid;
  gap: 2px;
  line-height: 1.5;
}

.release-field {
  min-width: 390px;
}

.release-overview {
  display: grid;
  grid-template-columns: 180px minmax(260px, 1fr) 130px 140px auto;
  align-items: center;
  gap: 1px;
  overflow: hidden;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #dfe3e8;
}

.release-overview > div,
.release-overview > button {
  align-self: stretch;
}

.release-overview > div {
  display: grid;
  gap: 6px;
  padding: 14px 16px;
  background: #fff;
}

.release-overview span {
  color: #717c8e;
  font-size: 11px;
}

.release-overview > button {
  border-radius: 0;
}

.release-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.55fr);
  gap: 16px;
  align-items: start;
}

.diff-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.diff-event {
  padding: 16px;
  background: #fff;
}

.diff-event-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.diff-event-head strong {
  font-family: monospace;
  font-size: 12px;
}

.diff-event-head span {
  color: #737e90;
  font-size: 11px;
}

.gate-list {
  padding: 10px 16px 18px;
}

.gate-row {
  display: grid;
  grid-template-columns: 30px 1fr;
  gap: 10px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
}

.gate-row svg {
  color: #0f8a62;
}

.gate-row svg.pending {
  color: #c46a00;
}

.gate-row > div {
  display: grid;
  gap: 4px;
}

.gate-row strong {
  font-size: 12px;
}

.gate-row span,
.readiness span {
  color: #727d8f;
  font-size: 11px;
}

.readiness {
  display: grid;
  gap: 7px;
  padding-top: 16px;
}

.readiness strong {
  font-size: 24px;
}

.review-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.migration-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.migration-card {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 9px;
  padding: 15px 16px;
  background: #fff;
}

.migration-card > div {
  display: grid;
  gap: 4px;
}

.migration-card span,
.migration-card p {
  color: #6d788b;
  font-size: 11px;
}

.migration-card p {
  grid-column: 1 / -1;
  margin: 0;
  line-height: 1.5;
}

.migration-card :deep(.t-button) {
  grid-column: 1 / -1;
  justify-self: start;
}

.approval-list {
  display: grid;
  padding: 6px 16px;
}

.approval-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
  cursor: pointer;
}

.approval-row > div {
  display: grid;
  gap: 4px;
}

.approval-row span {
  color: #717c8e;
  font-size: 11px;
}

.batch-bar {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid #e8ebef;
}

.selected-approval {
  display: flex;
  justify-content: space-between;
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #fafbfc;
}

.selected-approval span {
  color: #717c8e;
  font-size: 12px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid #e8ebef;
}
</style>
