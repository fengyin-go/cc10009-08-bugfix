<template>
  <section class="page" data-module="retry">
    <header class="page-head">
      <div>
        <h2>失败重试管理</h2>
        <p class="page-desc">
          失败转存、重试批次与恢复结果共用同一份持久化记录；成功重试只追加恢复结果，不覆盖失败证据。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出失败重试清单</button>
        <button class="btn" type="button" @click="exportArchive">导出失败转存清单</button>
        <button class="btn" type="button" @click="exportLedger">导出失败转存台账</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>重试批次</th>
          <th>重试进度</th>
          <th>失败转存路径</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row['重试批次'] || '—' }}</td>
          <td>{{ row['重试进度'] || '—' }}</td>
          <td>{{ row['失败转存路径'] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="selectRow(row)">详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 5" class="empty-state">暂无失败重试数据，可先登记重试策略</td>
        </tr>
      </tbody>
    </table>

    <section v-if="detail" class="panel">
      <header class="panel-head">
        <h3>重试详情 · {{ detail.taskId }}</h3>
        <span class="muted">
          批次 {{ detail.activeBatchId || '—' }} · {{ batchStatusLabel(detail.batchStatus) }} · 下次第
          {{ detail.nextAttempt }} 次尝试 · 剩余重试 {{ detail.remaining }}
        </span>
      </header>
      <p class="muted">失败转存路径：{{ detail.archivePath }}</p>

      <div class="retry-form">
        <label>
          <span>本次结果</span>
          <select v-model="attemptForm.success">
            <option :value="false">失败（写失败转存）</option>
            <option :value="true">成功（追加恢复结果）</option>
          </select>
        </label>
        <label>
          <span>HTTP 状态</span>
          <input v-model="attemptForm.httpStatus" type="number" placeholder="502" />
        </label>
        <label>
          <span>原因</span>
          <input v-model="attemptForm.reason" placeholder="Bad Gateway" />
        </label>
        <label v-if="attemptForm.success">
          <span>恢复回执</span>
          <input v-model="attemptForm.receipt" placeholder="回执编号" />
        </label>
        <button class="btn primary" type="button" @click="submitAttempt">记录本次尝试</button>
        <button class="btn" type="button" @click="downloadArchive">导出转存文件</button>
      </div>

      <table class="data-table">
        <thead>
          <tr>
            <th>尝试序号</th><th>批次</th><th>结果</th><th>HTTP</th><th>原因</th><th>时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="attempt in detail.attempts" :key="attempt.id">
            <td>{{ attempt.attempt }}</td>
            <td>{{ attempt.batchId }}</td>
            <td>{{ attempt.outcome === 'succeeded' ? '恢复成功' : '失败' }}</td>
            <td>{{ attempt.httpStatus ?? '—' }}</td>
            <td>{{ attempt.reason }}</td>
            <td>{{ attempt.at }}</td>
          </tr>
          <tr v-if="!detail.attempts.length">
            <td colspan="6" class="empty-state">该关联任务还没有重试记录</td>
          </tr>
        </tbody>
      </table>

      <div class="detail-grid">
        <div>
          <h4>失败转存历史（{{ detail.failures.length }}）</h4>
          <ul class="line-list">
            <li v-for="failure in detail.failures" :key="failure.id">
              第 {{ failure.attempt }} 次 · HTTP {{ failure.httpStatus ?? '—' }} · {{ failure.reason }} ·
              {{ failure.archivedAt }}
            </li>
          </ul>
        </div>
        <div>
          <h4>恢复结果（{{ detail.recoveries.length }}）</h4>
          <ul class="line-list">
            <li v-for="recovery in detail.recoveries" :key="recovery.id">
              第 {{ recovery.attempt }} 次 · {{ recovery.receipt }} · {{ recovery.recoveredAt }}
            </li>
          </ul>
        </div>
      </div>

      <details>
        <summary>转存文件内容（仅保留首次失败与最终恢复回执）</summary>
        <pre class="archive-preview">{{ detail.archiveFile || '（暂无转存内容）' }}</pre>
      </details>
    </section>

    <section class="panel">
      <header class="panel-head">
        <h3>失败转存清单</h3>
        <span class="muted">失败证据与恢复结果同步更新，共 {{ archiveRows.length }} 条</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>类型</th><th>关联任务</th><th>策略编号</th><th>重试批次</th><th>尝试</th>
            <th>HTTP</th><th>原因</th><th>恢复回执</th><th>时间</th><th>批次状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in archiveRows" :key="item.id">
            <td>{{ item.kind === 'recovery' ? '恢复结果' : '失败转存' }}</td>
            <td>{{ item.taskId }}</td>
            <td>{{ item.policyNo }}</td>
            <td>{{ item.batchId }}</td>
            <td>{{ item.attempt }}</td>
            <td>{{ item.httpStatus ?? '—' }}</td>
            <td>{{ item.reason }}</td>
            <td>{{ item.receipt ?? '—' }}</td>
            <td>{{ item.at }}</td>
            <td>{{ batchStatusLabel(item.batchStatus) }}</td>
          </tr>
          <tr v-if="!archiveRows.length">
            <td colspan="10" class="empty-state">暂无失败转存记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <header class="panel-head">
        <h3>失败转存台账</h3>
        <span class="muted">每次尝试都落账，恢复结果同样落账，共 {{ ledgerRows.length }} 条</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>关联任务</th><th>策略编号</th><th>重试批次</th><th>尝试</th><th>结果</th>
            <th>HTTP</th><th>原因</th><th>是否转存</th><th>剩余重试</th><th>下次序号</th><th>批次状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in ledgerRows" :key="item.id">
            <td>{{ item.taskId }}</td>
            <td>{{ item.policyNo }}</td>
            <td>{{ item.batchId }}</td>
            <td>{{ item.attempt }}</td>
            <td>{{ item.outcomeLabel }}</td>
            <td>{{ item.httpStatus ?? '—' }}</td>
            <td>{{ item.reason }}</td>
            <td>{{ item.archived ? '是' : '否' }}</td>
            <td>{{ item.remaining }}</td>
            <td>{{ item.nextAttempt }}</td>
            <td>{{ batchStatusLabel(item.batchStatus) }}</td>
          </tr>
          <tr v-if="!ledgerRows.length">
            <td colspan="11" class="empty-state">暂无失败转存台账记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条失败重试记录</span>
      <span v-if="message" class="info-text">{{ message }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  downloadText,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { subscribeDataChanges } from '@/data/local-store'
import {
  RETRY_STATUS_LABELS,
  exportFailureArchiveCsv,
  exportRetryArchive,
  exportRetryLedgerCsv,
  listFailureArchive,
  listRetryLedger,
  recordRetryAttempt,
  resumeRetry,
  retryDetail,
  retrySummary,
} from '@/data/retry-store'
import type { FailureArchiveView, RetryDetail, RetryLedgerView } from '@/data/retry-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('retry')
const columns = ['策略编号', '关联任务', '最大重试次数', '退避算法', '初始等待秒', '最大等待秒', '可重试异常', '失败转存']
const actions = ['提交校验', '启用策略', '停用策略']
const statuses = ['草稿', '待校验', '已启用', '已停用']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const message = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const archiveRows = ref<FailureArchiveView[]>([])
const ledgerRows = ref<RetryLedgerView[]>([])
const summary = ref(retrySummary())
const detail = ref<RetryDetail | null>(null)
const selectedTask = ref('')
const attemptForm = reactive({
  success: false,
  httpStatus: '502',
  reason: '',
  receipt: '',
})

const stats = computed(() => [
  { label: '重试策略总数', value: total.value },
  { label: '失败转存条数', value: summary.value.failures },
  { label: '恢复回执条数', value: summary.value.recoveries },
  { label: '重试批次', value: summary.value.batches },
  { label: '耗尽批次', value: summary.value.exhausted },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function batchStatusLabel(status: keyof typeof RETRY_STATUS_LABELS | undefined): string {
  return status ? RETRY_STATUS_LABELS[status] : RETRY_STATUS_LABELS.none
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function exportArchive() {
  const payload = exportFailureArchiveCsv()
  downloadText(payload.filename, payload.content)
}

function exportLedger() {
  const payload = exportRetryLedgerCsv()
  downloadText(payload.filename, payload.content)
}

function downloadArchive() {
  if (!detail.value) {
    return
  }
  const payload = exportRetryArchive(detail.value.taskId)
  if (!payload) {
    errorMessage.value = '该关联任务还没有可导出的失败转存文件'
    return
  }
  downloadText(payload.filename, payload.content, 'application/json')
}

function selectRow(row: EntryRow) {
  selectedTask.value = String(row['关联任务'] ?? '')
  detail.value = selectedTask.value ? retryDetail(selectedTask.value) : null
  attemptForm.reason = ''
  attemptForm.receipt = ''
  attemptForm.httpStatus = '502'
  attemptForm.success = false
  const resume = selectedTask.value ? resumeRetry(selectedTask.value) : null
  if (resume) {
    message.value = resume.message
  }
}

function submitAttempt() {
  if (!selectedTask.value) {
    errorMessage.value = '请先选择一条重试策略'
    return
  }
  errorMessage.value = ''
  message.value = ''
  const httpStatus = attemptForm.httpStatus.trim() === '' ? undefined : Number(attemptForm.httpStatus)
  const policyMaxRetries = Number(
    rows.value.find((row) => String(row['关联任务'] ?? '') === selectedTask.value)?.['最大重试次数'],
  )
  const result = recordRetryAttempt({
    taskId: selectedTask.value,
    success: attemptForm.success,
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : undefined,
    reason: attemptForm.reason,
    receipt: attemptForm.receipt,
    // 策略行上不是数字时交给数据层回退默认值，显式的 0 次重试也要保留。
    maxRetries: Number.isFinite(policyMaxRetries) ? policyMaxRetries : undefined,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    reload()
    return
  }
  message.value = result.message
  attemptForm.reason = ''
  attemptForm.receipt = ''
  reload()
  detail.value = retryDetail(selectedTask.value)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  message.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    reload()
    return
  }
  message.value = result.message
  reload()
  if (selectedTask.value === String(row['关联任务'] ?? '')) {
    detail.value = retryDetail(selectedTask.value)
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    archiveRows.value = listFailureArchive()
    ledgerRows.value = listRetryLedger()
    summary.value = retrySummary()
    if (selectedTask.value) {
      detail.value = retryDetail(selectedTask.value)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '失败重试列表读取失败'
  }
}

let unsubscribe: (() => void) | null = null

onMounted(() => {
  reload()
  // 另一个标签页写入后，本页列表 / 详情 / 台账一起刷新，不再读旧缓存。
  unsubscribe = subscribeDataChanges(reload)
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})
</script>

<style scoped>
.panel {
  margin-top: 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}
.panel-head h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.muted {
  color: var(--muted);
  font-size: 12px;
  margin: 0;
}
.retry-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  margin: 8px 0 12px;
}
.retry-form span {
  display: block;
  font-size: 12px;
  color: var(--muted);
}
.retry-form input,
.retry-form select {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.detail-grid {
  display: flex;
  gap: 20px;
  margin-top: 12px;
}
.detail-grid > div {
  flex: 1;
}
.line-list {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: #334155;
}
.archive-preview {
  background: #f8fafc;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  font-size: 12px;
  overflow: auto;
}
.info-text {
  color: #1f6feb;
}
</style>
