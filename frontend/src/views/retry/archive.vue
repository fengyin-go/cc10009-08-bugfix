<template>
  <section class="page" data-module="retry-archive">
    <header class="page-head">
      <div>
        <h2>失败转存清单</h2>
        <p class="page-desc">
          失败证据与恢复结果来自同一份失败重试记录，清单随重试写入同步更新。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportCsv">导出失败转存清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>关联任务</span>
        <input v-model="filters.taskId" placeholder="按关联任务检索" />
      </label>
      <label class="filter-item">
        <span>批次状态</span>
        <input v-model="filters.batchStatus" placeholder="recovered / exhausted" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>类型</th><th>关联任务</th><th>策略编号</th><th>重试批次</th><th>尝试</th>
          <th>HTTP</th><th>原因</th><th>恢复回执</th><th>时间</th><th>转存路径</th><th>批次状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in rows" :key="item.id">
          <td>{{ item.kind === 'recovery' ? '恢复结果' : '失败转存' }}</td>
          <td>{{ item.taskId }}</td>
          <td>{{ item.policyNo }}</td>
          <td>{{ item.batchId }}</td>
          <td>{{ item.attempt }}</td>
          <td>{{ item.httpStatus ?? '—' }}</td>
          <td>{{ item.reason }}</td>
          <td>{{ item.receipt ?? '—' }}</td>
          <td>{{ item.at }}</td>
          <td>{{ item.archivePath }}</td>
          <td>{{ RETRY_STATUS_LABELS[item.batchStatus] }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="11" class="empty-state">暂无失败转存记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条失败转存清单记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { downloadText } from '@/api/local-service'
import { subscribeDataChanges } from '@/data/local-store'
import {
  RETRY_STATUS_LABELS,
  exportFailureArchiveCsv,
  listFailureArchive,
  retrySummary,
} from '@/data/retry-store'
import type { FailureArchiveView } from '@/data/retry-types'

const rows = ref<FailureArchiveView[]>([])
const allRows = ref<FailureArchiveView[]>([])
const summary = ref(retrySummary())
const filters = ref<Record<string, string>>({})
const errorMessage = ref('')

const stats = computed(() => [
  { label: '失败转存条数', value: allRows.value.filter((item) => item.kind === 'failure').length },
  { label: '恢复结果条数', value: allRows.value.filter((item) => item.kind === 'recovery').length },
  { label: '涉及批次', value: summary.value.batches },
])

function reload() {
  errorMessage.value = ''
  try {
    allRows.value = listFailureArchive()
    rows.value = listFailureArchive(filters.value)
    summary.value = retrySummary()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '失败转存清单读取失败'
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportCsv() {
  const payload = exportFailureArchiveCsv()
  downloadText(payload.filename, payload.content)
}

let unsubscribe: (() => void) | null = null

onMounted(() => {
  reload()
  unsubscribe = subscribeDataChanges(reload)
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})
</script>
