<template>
  <section class="page" data-module="retry-ledger">
    <header class="page-head">
      <div>
        <h2>失败转存台账</h2>
        <p class="page-desc">
          每次重试尝试都落账；恢复结果同样落账，不只在概览里改一个数字。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportCsv">导出失败转存台账</button>
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
        <span>结果</span>
        <input v-model="filters.outcomeLabel" placeholder="失败 / 恢复成功" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>关联任务</th><th>策略编号</th><th>重试批次</th><th>尝试</th><th>结果</th>
          <th>HTTP</th><th>原因</th><th>恢复回执</th><th>是否转存</th><th>剩余重试</th><th>下次序号</th><th>批次状态</th><th>时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in rows" :key="item.id">
          <td>{{ item.taskId }}</td>
          <td>{{ item.policyNo }}</td>
          <td>{{ item.batchId }}</td>
          <td>{{ item.attempt }}</td>
          <td>{{ item.outcomeLabel }}</td>
          <td>{{ item.httpStatus ?? '—' }}</td>
          <td>{{ item.reason }}</td>
          <td>{{ item.receipt ?? '—' }}</td>
          <td>{{ item.archived ? '是' : '否' }}</td>
          <td>{{ item.remaining }}</td>
          <td>{{ item.nextAttempt }}</td>
          <td>{{ RETRY_STATUS_LABELS[item.batchStatus] }}</td>
          <td>{{ item.at }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="13" class="empty-state">暂无失败转存台账记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条台账记录</span>
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
  exportRetryLedgerCsv,
  listRetryLedger,
  retrySummary,
} from '@/data/retry-store'
import type { RetryLedgerView } from '@/data/retry-types'

const rows = ref<RetryLedgerView[]>([])
const allRows = ref<RetryLedgerView[]>([])
const summary = ref(retrySummary())
const filters = ref<Record<string, string>>({})
const errorMessage = ref('')

const stats = computed(() => [
  { label: '台账条数', value: allRows.value.length },
  { label: '失败落账', value: allRows.value.filter((item) => item.outcome === 'failed').length },
  { label: '恢复落账', value: allRows.value.filter((item) => item.outcome === 'succeeded').length },
  { label: '耗尽批次', value: summary.value.exhausted },
])

function reload() {
  errorMessage.value = ''
  try {
    allRows.value = listRetryLedger()
    rows.value = listRetryLedger(filters.value)
    summary.value = retrySummary()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '失败转存台账读取失败'
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportCsv() {
  const payload = exportRetryLedgerCsv()
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
