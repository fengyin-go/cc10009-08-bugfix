import { listRows, notifyDataChange, registerStorageKey, saveRows } from './local-store'
import type { EntryRow } from './types'
import type {
  FailureArchiveRecord,
  FailureArchiveView,
  RecoveryRecord,
  RetryAttemptInput,
  RetryAttemptRecord,
  RetryAttemptResult,
  RetryArchiveExport,
  RetryBatch,
  RetryBatchInput,
  RetryBatchStatus,
  RetryDetail,
  RetryDetailBatch,
  RetryLedgerView,
  RetryResumeState,
  RetryState,
} from './retry-types'

/**
 * 失败重试的唯一事实来源。
 *
 * 失败转存、重试批次、恢复结果、失败转存清单、失败转存台账和概览全部从这一份
 * localStorage 记录投影出来，不再各存一份缓存。
 *
 * 口径：
 * - 「最大重试次数」是首次尝试失败后还能再试的次数，总尝试上限 = 1 + 最大重试次数。
 *   例如最大重试次数 3，则第 1 次是原始尝试，第 2/3/4 次是重试；第 4 次成功即恢复，
 *   第 4 次再失败即耗尽并停止。
 * - 失败只能追加失败转存，成功只能追加恢复结果，两者都不覆盖既有证据。
 * - 写入采用「读最新 -> 合并 -> 整体写」，冲突时以失败转存记录为准；写失败时
 *   退回写入前的 storage 并保留 cursor（恢复位置）。
 */
export const RETRY_STORAGE_KEY = 'scraper-config-studio:retry-records'
const RETRY_MODULE_KEY = 'retry'
const DEFAULT_MAX_RETRIES = 3
const ASSOCIATED_TASK_FIELD = '关联任务'
const POLICY_NO_FIELD = '策略编号'
const MAX_RETRIES_FIELD = '最大重试次数'

export const RETRY_STATUS_LABELS: Record<RetryBatchStatus | 'none', string> = {
  none: '未开始',
  pending: '待执行',
  failed: '重试中',
  recovered: '已恢复',
  exhausted: '已耗尽',
}

type RetryStoreShape = {
  version: number
  tasks: Record<string, RetryState>
  updatedAt: string
}

let memoryRaw: string | null = null

registerStorageKey(RETRY_STORAGE_KEY)

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasBrowserStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function readRaw(): string | null {
  if (hasBrowserStorage()) {
    return window.localStorage.getItem(RETRY_STORAGE_KEY)
  }
  return memoryRaw
}

function writeRaw(raw: string): void {
  if (hasBrowserStorage()) {
    window.localStorage.setItem(RETRY_STORAGE_KEY, raw)
    return
  }
  memoryRaw = raw
}

function nowIso(): string {
  return new Date().toISOString()
}

function emptyStore(): RetryStoreShape {
  return { version: 1, tasks: {}, updatedAt: '' }
}

function lastOf<T>(items: T[]): T | undefined {
  return items.length > 0 ? items[items.length - 1] : undefined
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isBatchStatus(value: unknown): value is RetryBatchStatus {
  return value === 'pending' || value === 'failed' || value === 'recovered' || value === 'exhausted'
}

/** 总尝试上限：1 次原始尝试 + 最大重试次数。 */
export function maxAttemptsOf(maxRetries: number): number {
  return Math.max(1, 1 + Math.max(0, maxRetries))
}

function sortByAttempt<T extends { attempt: number }>(items: T[], timeOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    if (a.attempt !== b.attempt) {
      return a.attempt - b.attempt
    }
    return timeOf(a).localeCompare(timeOf(b))
  })
}

function sortAttempts(items: RetryAttemptRecord[]): RetryAttemptRecord[] {
  return sortByAttempt(items, (item) => item.at)
}

function sortFailures(items: FailureArchiveRecord[]): FailureArchiveRecord[] {
  return sortByAttempt(items, (item) => item.archivedAt)
}

function sortRecoveries(items: RecoveryRecord[]): RecoveryRecord[] {
  return sortByAttempt(items, (item) => item.recoveredAt)
}

/** 计入重试预算的失败次数：原始尝试（第 1 次）失败不占重试名额。 */
function retryFailuresOf(batch: RetryBatch): number {
  return batch.failures.filter((failure) => failure.attempt > 1).length
}

function remainingRetriesOf(batch: RetryBatch): number {
  return Math.max(0, batch.maxRetries - retryFailuresOf(batch))
}

function normalizeBatch(raw: Partial<RetryBatch> | undefined, taskId: string): RetryBatch | null {
  if (!raw || typeof raw.batchId !== 'string' || raw.batchId === '') {
    return null
  }
  const attempts = Array.isArray(raw.attempts) ? raw.attempts : []
  const failures = Array.isArray(raw.failures) ? raw.failures : []
  const recoveries = Array.isArray(raw.recoveries) ? raw.recoveries : []
  const submissions = Array.isArray(raw.submissions) ? raw.submissions : []
  const maxRetries = Number.isFinite(Number(raw.maxRetries))
    ? Math.max(0, Number(raw.maxRetries))
    : DEFAULT_MAX_RETRIES
  const sortedAttempts = sortAttempts(attempts)
  const lastAttempt = lastOf(sortedAttempts)
  const cursor = Number.isFinite(Number(raw.cursor))
    ? Number(raw.cursor)
    : (lastAttempt ? lastAttempt.attempt : 0) + 1
  const sortedFailures = sortFailures(failures)
  const sortedRecoveries = sortRecoveries(recoveries)
  let status: RetryBatchStatus = isBatchStatus(raw.status) ? raw.status : 'pending'
  if (sortedRecoveries.length > 0) {
    status = 'recovered'
  } else if (sortedFailures.length > 0) {
    // 旧数据里即便写着 pending，只要重试预算已经用完就不能再继续尝试。
    const budgetLeft = Math.max(0, maxRetries - sortedFailures.filter((item) => item.attempt > 1).length)
    const attemptsLeft = maxAttemptsOf(maxRetries) - cursor + 1
    if (status !== 'exhausted' && (budgetLeft <= 0 || attemptsLeft <= 0)) {
      status = 'exhausted'
    } else if (status !== 'exhausted') {
      status = 'failed'
    }
  }
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : lastAttempt ? lastAttempt.at : nowIso()
  const batch: RetryBatch = {
    batchId: raw.batchId,
    taskId,
    maxRetries,
    status,
    cursor,
    attempts: sortedAttempts,
    failures: sortedFailures,
    recoveries: sortedRecoveries,
    archiveFile: typeof raw.archiveFile === 'string' ? raw.archiveFile : '',
    archivePath: typeof raw.archivePath === 'string' ? raw.archivePath : '',
    submissions: submissions.map(String),
    startedAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : startedAt,
  }
  if (!batch.archiveFile) {
    batch.archiveFile = buildArchiveFile(batch)
  }
  return batch
}

function normalizeState(raw: Partial<RetryState> | undefined, taskId: string): RetryState | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const batches: Record<string, RetryBatch> = {}
  const source = raw.batches && typeof raw.batches === 'object' ? raw.batches : {}
  for (const [batchId, batch] of Object.entries(source)) {
    const candidate = batch as RetryBatch
    const normalized = normalizeBatch({ ...candidate, batchId: candidate?.batchId ?? batchId }, taskId)
    if (normalized) {
      batches[normalized.batchId] = normalized
    }
  }
  const batchIds = Object.keys(batches)
  if (batchIds.length === 0) {
    return null
  }
  const activeRaw = typeof raw.activeBatchId === 'string' ? raw.activeBatchId : ''
  const activeBatchId = activeRaw && batches[activeRaw] ? activeRaw : batchIds[batchIds.length - 1]
  const maxRetries = Number.isFinite(Number(raw.maxRetries))
    ? Math.max(0, Number(raw.maxRetries))
    : batches[activeBatchId].maxRetries
  return {
    taskId,
    maxRetries,
    activeBatchId,
    archivePath: typeof raw.archivePath === 'string' ? raw.archivePath : batches[activeBatchId].archivePath,
    batches,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : batches[activeBatchId].updatedAt,
  }
}

function parseStore(raw: string | null): RetryStoreShape {
  if (!raw) {
    return emptyStore()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RetryStoreShape>
    const tasks: Record<string, RetryState> = {}
    const source = parsed && typeof parsed.tasks === 'object' && parsed.tasks ? parsed.tasks : {}
    for (const [taskId, state] of Object.entries(source)) {
      const normalized = normalizeState(state, taskId)
      if (normalized) {
        tasks[taskId] = normalized
      }
    }
    return { version: 1, tasks, updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : '' }
  } catch {
    return emptyStore()
  }
}

/** 每次都从 localStorage 重新解析，另一个标签页写入后这里能立刻看到。 */
export function readRetryStore(): RetryStoreShape {
  return parseStore(readRaw())
}

function persistStore(store: RetryStoreShape): void {
  const snapshot = clone(store)
  snapshot.updatedAt = nowIso()
  const serialized = JSON.stringify(snapshot)
  const previous = readRaw()
  try {
    writeRaw(serialized)
  } catch {
    // 事务失败：退回写入前的原始失败转存，cursor 等恢复位置一并保留。
    try {
      if (previous === null) {
        if (hasBrowserStorage()) {
          window.localStorage.removeItem(RETRY_STORAGE_KEY)
        } else {
          memoryRaw = null
        }
      } else {
        writeRaw(previous)
      }
    } catch {
      // 回滚也失败时保留原 storage 内容，下一次读取仍从 storage 取。
    }
    throw new Error('失败转存写入失败，已退回原记录并保留恢复位置')
  }
  // 同标签页里的列表 / 详情 / 概览共享同一次变更通知。
  notifyDataChange()
}

/** 冲突口径：失败转存永远优先，恢复结果只能追加。 */
function mergeBatch(local: RetryBatch, incoming: RetryBatch): RetryBatch {
  const attemptsById = new Map<string, RetryAttemptRecord>()
  for (const attempt of local.attempts) {
    attemptsById.set(attempt.id, attempt)
  }
  for (const attempt of incoming.attempts) {
    const existing = attemptsById.get(attempt.id)
    if (!existing) {
      attemptsById.set(attempt.id, attempt)
      continue
    }
    // 同一尝试在两边口径不一致时以失败证据为准。
    if (existing.outcome !== attempt.outcome) {
      attemptsById.set(attempt.id, existing.outcome === 'failed' ? existing : attempt)
    }
  }
  const failuresById = new Map<string, FailureArchiveRecord>()
  for (const failure of [...local.failures, ...incoming.failures]) {
    const existing = failuresById.get(failure.id)
    if (!existing || failure.archivedAt >= existing.archivedAt) {
      failuresById.set(failure.id, failure)
    }
  }
  const recoveriesById = new Map<string, RecoveryRecord>()
  for (const recovery of [...local.recoveries, ...incoming.recoveries]) {
    const existing = recoveriesById.get(recovery.id)
    if (!existing || recovery.recoveredAt >= existing.recoveredAt) {
      recoveriesById.set(recovery.id, recovery)
    }
  }
  const failures = sortFailures([...failuresById.values()])
  // 冲突口径：同一尝试既有失败证据又有恢复结果时，以失败转存为准，
  // 丢弃该尝试上的恢复结果，避免成功结果覆盖失败证据。
  const conflictedAttempts = new Set(failures.map((failure) => failure.attempt))
  const recoveries = sortRecoveries(
    [...recoveriesById.values()].filter((recovery) => !conflictedAttempts.has(recovery.attempt)),
  )
  for (const [attemptId, attempt] of attemptsById) {
    if (attempt.outcome === 'succeeded' && conflictedAttempts.has(attempt.attempt)) {
      attemptsById.set(attemptId, { ...attempt, outcome: 'failed' })
    }
  }
  const attempts = sortAttempts([...attemptsById.values()])
  const maxRetries = Math.max(local.maxRetries, incoming.maxRetries)
  const cursor = Math.max(local.cursor, incoming.cursor, (lastOf(attempts)?.attempt ?? 0) + 1)
  const submissions = [...new Set([...local.submissions, ...incoming.submissions])]
  let status: RetryBatchStatus = incoming.status
  if (recoveries.length > 0) {
    status = 'recovered'
  } else if (retryFailuresCount(failures) >= maxRetries) {
    status = 'exhausted'
  } else if (failures.length > 0) {
    // 冲突里恢复结果被失败证据覆盖后，批次必须回到未完成态，不能停在 recovered。
    status = 'failed'
  } else if (attempts.length === 0) {
    status = 'pending'
  }
  const merged: RetryBatch = {
    batchId: local.batchId,
    taskId: local.taskId,
    maxRetries,
    status,
    cursor,
    attempts,
    failures,
    recoveries,
    archiveFile: '',
    archivePath: incoming.archivePath || local.archivePath,
    submissions,
    startedAt: local.startedAt || incoming.startedAt,
    updatedAt: incoming.updatedAt >= local.updatedAt ? incoming.updatedAt : local.updatedAt,
  }
  merged.archiveFile = buildArchiveFile(merged)
  return merged
}

function retryFailuresCount(failures: FailureArchiveRecord[]): number {
  return failures.filter((failure) => failure.attempt > 1).length
}

/**
 * 把当前标签页算出来的状态写回去。写入前会重新读一次 storage，
 * 与另一个标签页的并发结果合并，避免后写的一方把失败转存抹掉。
 */
function commitState(taskId: string, state: RetryState | null): RetryState | null {
  const store = readRetryStore()
  if (!state) {
    if (taskId in store.tasks) {
      delete store.tasks[taskId]
      persistStore(store)
    }
    return null
  }
  const existing = store.tasks[taskId]
  let merged = state
  if (existing) {
    const batches: Record<string, RetryBatch> = { ...existing.batches }
    for (const [batchId, batch] of Object.entries(state.batches)) {
      batches[batchId] = batches[batchId] ? mergeBatch(batches[batchId], batch) : batch
    }
    const activeBatchId = state.batches[state.activeBatchId] ? state.activeBatchId : existing.activeBatchId
    merged = {
      taskId,
      maxRetries: Math.max(existing.maxRetries, state.maxRetries),
      activeBatchId,
      archivePath: state.archivePath || existing.archivePath,
      batches,
      updatedAt: nowIso(),
    }
  }
  store.tasks[taskId] = merged
  persistStore(store)
  return merged
}

function nextBatchId(state: RetryState | undefined, taskId: string): string {
  const existing = state ? Object.keys(state.batches).length : 0
  const stamp = Date.now().toString(36)
  return `${taskId}-B${String(existing + 1).padStart(2, '0')}-${stamp}`
}

function activeBatch(state: RetryState): RetryBatch | null {
  return state.batches[state.activeBatchId] ?? null
}

function taskArchiveRoot(taskId: string): string {
  return `failure-archive/${taskId}`
}

function batchArchivePath(taskId: string, batchId: string): string {
  return batchId ? `${taskArchiveRoot(taskId)}/${batchId}.json` : `${taskArchiveRoot(taskId)}/`
}

function defaultReason(success: boolean, httpStatus?: number): string {
  if (success) {
    return httpStatus ? `HTTP ${httpStatus} 成功回执` : '重试成功'
  }
  if (httpStatus) {
    return `HTTP ${httpStatus} 采集失败`
  }
  return '采集失败'
}

/** 转存文件只保留首次失败证据与最终恢复回执，中间尝试继续留在台账里。 */
function buildArchiveFile(batch: RetryBatch): string {
  const firstFailure = batch.failures[0]
  const lastRecovery = lastOf(batch.recoveries)
  const envelope = {
    taskId: batch.taskId,
    batchId: batch.batchId,
    maxRetries: batch.maxRetries,
    status: batch.status,
    firstFailure: firstFailure
      ? {
          attempt: firstFailure.attempt,
          httpStatus: firstFailure.httpStatus ?? null,
          reason: firstFailure.reason,
          archivedAt: firstFailure.archivedAt,
        }
      : null,
    finalReceipt: lastRecovery
      ? {
          attempt: lastRecovery.attempt,
          httpStatus: lastRecovery.httpStatus ?? null,
          receipt: lastRecovery.receipt,
          recoveredAt: lastRecovery.recoveredAt,
        }
      : null,
  }
  return JSON.stringify(envelope, null, 2)
}

function findPolicyRow(taskId: string): { row: EntryRow; index: number } | null {
  const rows = listRows(RETRY_MODULE_KEY)
  const index = rows.findIndex((row) => String(row[ASSOCIATED_TASK_FIELD] ?? '') === taskId)
  if (index < 0) {
    return null
  }
  return { row: rows[index], index }
}

function findPolicyRowById(id: number): { row: EntryRow; index: number } | null {
  const rows = listRows(RETRY_MODULE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return null
  }
  return { row: rows[index], index }
}

function taskMaxRetries(taskId: string, fallback: number | undefined): number {
  if (fallback !== undefined && Number.isFinite(fallback)) {
    return Math.max(0, fallback)
  }
  const located = findPolicyRow(taskId)
  const parsed = toNumber(located?.row[MAX_RETRIES_FIELD])
  return parsed !== undefined ? Math.max(0, parsed) : DEFAULT_MAX_RETRIES
}

type RowProjection = { status: string; pending: boolean; abnormal: boolean }

/** 批次状态决定策略行的业务状态；已恢复的批次不强制覆盖手工流转过的状态。 */
function projectBatch(batch: RetryBatch | null, currentStatus: string): RowProjection {
  if (!batch) {
    return { status: currentStatus, pending: true, abnormal: false }
  }
  switch (batch.status) {
    case 'recovered':
      // 恢复后回到可用态；但手工停用要保留，失败证据仍然算异常，不能被洗白。
      return {
        status: currentStatus === '已停用' ? currentStatus : '已启用',
        pending: false,
        abnormal: batch.failures.length > 0,
      }
    case 'exhausted':
      return { status: '已停用', pending: true, abnormal: true }
    case 'failed':
      return { status: '待校验', pending: true, abnormal: true }
    case 'pending':
    default:
      return {
        status: currentStatus === '待校验' ? currentStatus : '待校验',
        pending: true,
        abnormal: batch.failures.length > 0,
      }
  }
}

/** 把重试记录投影回策略行；列表 / 详情 / 概览读到的都是这一份结果。 */
function projectRow(row: EntryRow, state: RetryState | null): EntryRow {
  const batch = state ? activeBatch(state) : null
  if (!batch) {
    // 没有重试记录时不动原有状态，只补上空的批次字段。
    return {
      ...row,
      '重试批次': '',
      '重试进度': '无',
      '下次重试序号': '1',
      '失败转存路径': taskArchiveRoot(String(row[ASSOCIATED_TASK_FIELD] ?? '')),
    }
  }
  const projection = projectBatch(batch, String(row.status ?? ''))
  return {
    ...row,
    status: projection.status,
    pending: projection.pending,
    abnormal: projection.abnormal,
    '重试批次': batch.batchId,
    '重试进度': `失败 ${batch.failures.length} / 恢复 ${batch.recoveries.length}`,
    '下次重试序号': String(batch.cursor),
    '失败转存路径': batch.archivePath,
  }
}

function syncPolicyRow(taskId: string, state: RetryState | null): void {
  const located = findPolicyRow(taskId)
  if (!located) {
    return
  }
  try {
    const rows = [...listRows(RETRY_MODULE_KEY)]
    const index = rows.findIndex((row) => Number(row.id) === Number(located.row.id))
    if (index < 0) {
      return
    }
    const projected = projectRow(located.row, state)
    // 内容没变就不写，避免变更通知触发列表重复刷新。
    const changed = Object.keys(projected).some((key) => projected[key] !== located.row[key])
    if (!changed) {
      return
    }
    rows[index] = projected
    saveRows(RETRY_MODULE_KEY, rows)
  } catch {
    // 策略行投影失败不影响已经落盘的失败转存；下次读取列表时会重新投影。
  }
}

/** 从共享的失败重试记录重新投影整个重试模块，列表和概览因此口径一致。 */
export function reconcileRetryRows(): EntryRow[] {
  const store = readRetryStore()
  const rows = [...listRows(RETRY_MODULE_KEY)]
  let changed = false
  for (let index = 0; index < rows.length; index += 1) {
    const taskId = String(rows[index][ASSOCIATED_TASK_FIELD] ?? '')
    const state = taskId ? store.tasks[taskId] ?? null : null
    const projected = projectRow(rows[index], state)
    const keys = Object.keys(projected)
    const differs = keys.some((key) => projected[key] !== rows[index][key])
    if (differs) {
      rows[index] = projected
      changed = true
    }
  }
  if (changed) {
    saveRows(RETRY_MODULE_KEY, rows)
  }
  return rows
}

/** 策略行上是否存在未恢复的失败转存证据。 */
export function retryPolicyGuard(taskId: string, action: string): { ok: boolean; message: string } {
  const trimmed = String(taskId ?? '').trim()
  if (!trimmed) {
    return { ok: false, message: '重试策略缺少关联任务，无法更新' }
  }
  const state = readState(trimmed)
  const batch = state ? activeBatch(state) : null
  if (!batch || batch.failures.length === 0) {
    // 没有任何失败证据时按普通流转处理。
    return { ok: true, message: '' }
  }
  if (batch.recoveries.length > 0) {
    return { ok: true, message: '' }
  }
  if (action.startsWith('启用')) {
    return {
      ok: false,
      message: batch.status === 'exhausted'
        ? `批次 ${batch.batchId} 已达最大重试次数 ${batch.maxRetries}，失败转存仍保留，需成功重试后才能恢复`
        : `批次 ${batch.batchId} 存在 ${batch.failures.length} 条未恢复的失败转存记录，成功重试只能追加恢复结果，不能直接启用`,
    }
  }
  return { ok: true, message: '' }
}

function ensureBatch(
  state: RetryState,
  taskId: string,
  input: RetryAttemptInput,
  createIfMissing: boolean,
): RetryBatch | null {
  const requested = input.batchId?.trim()
  if (requested) {
    const found = state.batches[requested]
    if (found) {
      return found
    }
    if (!createIfMissing) {
      return null
    }
    const batch: RetryBatch = {
      batchId: requested,
      taskId,
      maxRetries: taskMaxRetries(taskId, input.maxRetries ?? state.maxRetries),
      status: 'pending',
      cursor: 1,
      attempts: [],
      failures: [],
      recoveries: [],
      archiveFile: '',
      archivePath: batchArchivePath(taskId, requested),
      submissions: [],
      startedAt: nowIso(),
      updatedAt: nowIso(),
    }
    state.batches[requested] = batch
    state.activeBatchId = requested
    return batch
  }
  const current = activeBatch(state)
  if (current) {
    // 已有批次一律在它上面继续，是否允许写入交给状态检查（已恢复 / 已耗尽会拒绝）。
    // 需要重新开批次时必须显式给出新的 batchId，避免重复提交意外生成新批次。
    return current
  }
  if (!createIfMissing) {
    return null
  }
  const batchId = nextBatchId(state, taskId)
  const batch: RetryBatch = {
    batchId,
    taskId,
    maxRetries: taskMaxRetries(taskId, input.maxRetries),
    status: 'pending',
    cursor: 1,
    attempts: [],
    failures: [],
    recoveries: [],
    archiveFile: '',
    archivePath: batchArchivePath(taskId, batchId),
    submissions: [],
    startedAt: nowIso(),
    updatedAt: nowIso(),
  }
  state.batches[batchId] = batch
  state.activeBatchId = batchId
  return batch
}

function readState(taskId: string): RetryState | null {
  return readRetryStore().tasks[taskId] ?? null
}

function emptyState(taskId: string, maxRetries: number): RetryState {
  return {
    taskId,
    maxRetries,
    activeBatchId: '',
    archivePath: taskArchiveRoot(taskId),
    batches: {},
    updatedAt: '',
  }
}

function submissionFingerprint(batchId: string, attempt: number, input: RetryAttemptInput): string {
  if (input.submissionId && input.submissionId.trim()) {
    return `sub:${input.submissionId.trim()}`
  }
  return `fp:${batchId}|${attempt}|${input.success ? 'ok' : 'fail'}|${input.httpStatus ?? ''}|${input.reason ?? ''}|${input.receipt ?? ''}`
}

function batchFingerprint(batchId: string, attempts: RetryBatchInput['attempts']): string {
  const payload = attempts.map((item) => [
    item.success ? 'ok' : 'fail',
    item.httpStatus ?? '',
    item.reason ?? '',
    item.receipt ?? '',
  ])
  return `batch:${batchId}|${JSON.stringify(payload)}`
}

function applyAttempt(
  state: RetryState,
  input: RetryAttemptInput,
  createIfMissing: boolean,
  persist = true,
): RetryAttemptResult {
  const taskId = input.taskId.trim()
  if (!taskId) {
    return { ok: false, code: 'INVALID', message: '必须提供关联任务编号' }
  }
  const located = findPolicyRow(taskId)
  if (!located) {
    return { ok: false, code: 'NOT_FOUND', message: `没有找到关联任务 ${taskId} 对应的重试策略` }
  }
  if (input.id !== undefined && Number(located.row.id) !== Number(input.id)) {
    return {
      ok: false,
      code: 'TASK_MISMATCH',
      message: `编号 ${input.id} 的策略关联任务是「${located.row[ASSOCIATED_TASK_FIELD]}」，不能写入 ${taskId}`,
    }
  }

  const batch = ensureBatch(state, taskId, input, createIfMissing)
  if (!batch) {
    const current = activeBatch(state)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: current
        ? `批次 ${input.batchId} 不存在，当前批次是 ${current.batchId}`
        : '当前没有可续跑的重试批次',
      taskId,
    }
  }

  const requestedAttempt = input.attempt !== undefined ? Number(input.attempt) : undefined
  if (requestedAttempt !== undefined && !Number.isFinite(requestedAttempt)) {
    return { ok: false, code: 'INVALID', message: '重试序号必须是数字', taskId, batchId: batch.batchId }
  }
  const attemptNo = requestedAttempt !== undefined ? requestedAttempt : batch.cursor
  const fingerprint = submissionFingerprint(batch.batchId, attemptNo, input)

  const alreadyApplied = batch.attempts.find((item) => item.attempt === attemptNo)
  if (
    batch.submissions.includes(fingerprint) ||
    (alreadyApplied &&
      alreadyApplied.outcome === (input.success ? 'succeeded' : 'failed') &&
      alreadyApplied.httpStatus === input.httpStatus &&
      alreadyApplied.reason === (input.reason?.trim() || defaultReason(input.success, input.httpStatus)))
  ) {
    // 重复提交同一批次 / 同一次尝试只生效一次。
    return {
      ok: true,
      code: 'DUPLICATE',
      duplicate: true,
      message: `第 ${attemptNo} 次尝试已记录，重复提交未重复生效`,
      taskId,
      batchId: batch.batchId,
      attempt: attemptNo,
      status: batch.status,
      nextAttempt: batch.cursor,
      remaining: remainingRetriesOf(batch),
      record: buildDetailFromState(state, located.row),
    }
  }

  if (alreadyApplied) {
    return {
      ok: false,
      code: 'CONFLICT',
      message: `第 ${attemptNo} 次尝试已存在不同结果，以失败转存记录为准`,
      taskId,
      batchId: batch.batchId,
      attempt: attemptNo,
      status: batch.status,
      nextAttempt: batch.cursor,
    }
  }

  if (batch.status === 'recovered') {
    return {
      ok: false,
      code: 'BATCH_COMPLETED',
      message: `批次 ${batch.batchId} 已经恢复成功，不能继续写入`,
      taskId,
      batchId: batch.batchId,
      status: batch.status,
      nextAttempt: batch.cursor,
      remaining: remainingRetriesOf(batch),
    }
  }
  if (batch.status === 'exhausted') {
    return {
      ok: false,
      code: 'EXHAUSTED',
      message: `批次 ${batch.batchId} 已达最大重试次数 ${batch.maxRetries}，重试已停止`,
      taskId,
      batchId: batch.batchId,
      status: 'exhausted',
      nextAttempt: batch.cursor,
      remaining: 0,
    }
  }

  if (requestedAttempt !== undefined && requestedAttempt !== batch.cursor) {
    return {
      ok: false,
      code: 'OUT_OF_ORDER',
      message: `批次 ${batch.batchId} 当前应从第 ${batch.cursor} 次尝试继续，不能跳到第 ${requestedAttempt} 次`,
      taskId,
      batchId: batch.batchId,
      status: batch.status,
      nextAttempt: batch.cursor,
      remaining: remainingRetriesOf(batch),
    }
  }
  if (attemptNo > maxAttemptsOf(batch.maxRetries)) {
    // 连原始尝试带重试都用完了，后续提交一律停止。
    return {
      ok: false,
      code: 'EXHAUSTED',
      message: `批次 ${batch.batchId} 最多允许 ${maxAttemptsOf(batch.maxRetries)} 次尝试（含首次），已停止`,
      taskId,
      batchId: batch.batchId,
      status: 'exhausted',
      nextAttempt: batch.cursor,
      remaining: 0,
    }
  }

  const at = input.at ?? nowIso()
  const httpStatus = input.httpStatus
  const reason = input.reason?.trim() || defaultReason(input.success, httpStatus)
  const source = input.source === 'manual' ? 'manual' : 'retry'
  const baseId = `${batch.batchId}-A${String(attemptNo).padStart(2, '0')}`

  // 成功只能追加恢复结果；失败必须追加转存证据。两者都不覆盖已有记录。
  const attempt: RetryAttemptRecord = {
    id: baseId,
    taskId,
    batchId: batch.batchId,
    attempt: attemptNo,
    outcome: input.success ? 'succeeded' : 'failed',
    httpStatus,
    reason,
    at,
    source,
    submissionId: input.submissionId?.trim() || undefined,
  }
  batch.attempts.push(attempt)
  if (input.success) {
    batch.recoveries.push({
      id: `${baseId}-R`,
      taskId,
      batchId: batch.batchId,
      attempt: attemptNo,
      httpStatus,
      reason,
      receipt: input.receipt?.trim() || `recovery-receipt/${taskId}/${batch.batchId}-A${attemptNo}`,
      recoveredAt: at,
      source,
    })
    batch.status = 'recovered'
  } else {
    batch.failures.push({
      id: `${baseId}-F`,
      taskId,
      batchId: batch.batchId,
      attempt: attemptNo,
      httpStatus,
      reason,
      archivedAt: at,
      archivePath: batch.archivePath,
    })
    const retryFailures = retryFailuresOf(batch)
    batch.status =
      retryFailures >= batch.maxRetries || attemptNo >= maxAttemptsOf(batch.maxRetries) ? 'exhausted' : 'failed'
  }
  batch.cursor = attemptNo + 1
  batch.updatedAt = at
  if (!batch.submissions.includes(fingerprint)) {
    batch.submissions.push(fingerprint)
  }
  batch.archiveFile = buildArchiveFile(batch)
  state.updatedAt = at
  state.maxRetries = batch.maxRetries

  if (!persist) {
    // 批量提交先在内存副本上验证与写入，整批通过后才落盘。
    return {
      ok: true,
      code: 'OK',
      message: input.success
        ? `第 ${attemptNo} 次尝试成功，恢复结果已追加`
        : `第 ${attemptNo} 次尝试失败，失败转存已追加`,
      taskId,
      batchId: batch.batchId,
      attempt: attemptNo,
      status: batch.status,
      nextAttempt: batch.cursor,
      remaining: remainingRetriesOf(batch),
    }
  }

  const committed = commitState(taskId, state)
  syncPolicyRow(taskId, committed)
  return {
    ok: true,
    code: 'OK',
    message: input.success
      ? `第 ${attemptNo} 次尝试成功，恢复结果已追加`
      : `第 ${attemptNo} 次尝试失败，失败转存已追加`,
    taskId,
    batchId: batch.batchId,
    attempt: attemptNo,
    status: batch.status,
    nextAttempt: batch.cursor,
    remaining: remainingRetriesOf(batch),
    record: committed ? buildDetailFromState(committed, located.row) : undefined,
  }
}

function buildDetailFromState(state: RetryState, row: EntryRow): RetryDetail {
  const batch = activeBatch(state)
  const batches: RetryDetailBatch[] = Object.values(state.batches).map((item) => ({
    ...clone(item),
    totalAttempts: item.attempts.length,
    failedAttempts: item.failures.length,
    recovered: item.recoveries.length > 0,
    remainingRetries: remainingRetriesOf(item),
  }))
  const failureHistory = batches.flatMap((item) =>
    item.failures.map((failure) => ({ ...failure, batchId: item.batchId })),
  )
  const recoveryHistory = batches.flatMap((item) =>
    item.recoveries.map((recovery) => ({ ...recovery, batchId: item.batchId })),
  )
  const attemptHistory = batches.flatMap((item) =>
    item.attempts.map((attempt) => ({ ...attempt, batchId: item.batchId })),
  )
  const projected = projectRow(row, state)
  return {
    rowId: Number(row.id),
    policyNo: String(row[POLICY_NO_FIELD] ?? ''),
    taskId: state.taskId,
    status: projected.status,
    pending: projected.pending,
    abnormal: projected.abnormal,
    archivePath: batch?.archivePath ?? state.archivePath,
    activeBatchId: state.activeBatchId,
    maxRetries: batch?.maxRetries ?? state.maxRetries,
    batches,
    attempts: sortAttempts(attemptHistory),
    failures: sortFailures(failureHistory),
    recoveries: sortRecoveries(recoveryHistory),
    archiveFile: batch?.archiveFile ?? '',
    nextAttempt: batch?.cursor ?? 1,
    batchStatus: batch?.status ?? 'none',
    remaining: batch ? remainingRetriesOf(batch) : state.maxRetries,
  }
}

/** 按关联任务读取详情；只有这条关联任务的记录会参与计算。 */
export function retryDetail(taskId: string, policyId?: number): RetryDetail | null {
  const trimmed = String(taskId ?? '').trim()
  if (!trimmed) {
    return null
  }
  const located = policyId !== undefined ? findPolicyRowById(policyId) : findPolicyRow(trimmed)
  if (!located || String(located.row[ASSOCIATED_TASK_FIELD] ?? '') !== trimmed) {
    return null
  }
  const state = readState(trimmed) ?? emptyState(trimmed, taskMaxRetries(trimmed, undefined))
  return buildDetailFromState(state, located.row)
}

export function retryDetailByRow(id: number): RetryDetail | null {
  const located = findPolicyRowById(id)
  if (!located) {
    return null
  }
  return retryDetail(String(located.row[ASSOCIATED_TASK_FIELD] ?? ''), id)
}

/** 提交一次重试尝试：失败写转存，成功只追加恢复结果。 */
export function recordRetryAttempt(input: RetryAttemptInput): RetryAttemptResult {
  const taskId = String(input.taskId ?? '').trim()
  if (!taskId) {
    return { ok: false, code: 'INVALID', message: '必须提供关联任务编号' }
  }
  try {
    const store = readRetryStore()
    const state = store.tasks[taskId]
      ? clone(store.tasks[taskId])
      : emptyState(taskId, taskMaxRetries(taskId, input.maxRetries))
    return applyAttempt(state, { ...input, taskId }, true)
  } catch (error) {
    return {
      ok: false,
      code: 'STORAGE',
      message: error instanceof Error ? error.message : '失败转存写入失败，已退回原记录',
      taskId,
      rolledBack: true,
    }
  }
}

/** 批量提交：整批只生效一次，任何一条不合法都整批回退。 */
export function recordRetryBatch(input: RetryBatchInput): RetryAttemptResult {
  const taskId = String(input.taskId ?? '').trim()
  if (!taskId || !Array.isArray(input.attempts) || input.attempts.length === 0) {
    return { ok: false, code: 'INVALID', message: '批量提交需要关联任务与至少一次尝试', taskId }
  }
  try {
    const located = findPolicyRow(taskId)
    if (!located) {
      return { ok: false, code: 'NOT_FOUND', message: `没有找到关联任务 ${taskId} 对应的重试策略` }
    }
    const store = readRetryStore()
    const state = store.tasks[taskId]
      ? clone(store.tasks[taskId])
      : emptyState(taskId, taskMaxRetries(taskId, input.maxRetries))
    const probeInput: RetryAttemptInput = {
      taskId,
      batchId: input.batchId,
      maxRetries: input.maxRetries,
      success: input.attempts[0].success,
    }
    const batch = ensureBatch(state, taskId, probeInput, true)
    if (!batch) {
      return { ok: false, code: 'NOT_FOUND', message: '当前没有可续跑的重试批次', taskId }
    }
    const fingerprint = batchFingerprint(batch.batchId, input.attempts)
    if (batch.submissions.includes(fingerprint)) {
      return {
        ok: true,
        code: 'DUPLICATE',
        duplicate: true,
        message: `批次 ${batch.batchId} 的这批重试已记录，重复提交未重复生效`,
        taskId,
        batchId: batch.batchId,
        status: batch.status,
        nextAttempt: batch.cursor,
        remaining: remainingRetriesOf(batch),
        record: buildDetailFromState(state, located.row),
      }
    }
    // 整批共用同一个存储事务：先在内存副本上按顺序写，全部通过才一次性落盘。
    let last: RetryAttemptResult = { ok: false, code: 'INVALID', message: '未执行任何尝试' }
    for (const attempt of input.attempts) {
      last = applyAttempt(state, { ...attempt, taskId, batchId: batch.batchId, maxRetries: input.maxRetries }, false, false)
      if (!last.ok) {
        // 整批不生效：state 只是内存副本，未写盘，原失败转存与恢复位置保持不动。
        return last
      }
      if (last.status === 'recovered' || last.status === 'exhausted') {
        break
      }
    }
    const currentBatch = state.batches[batch.batchId] ?? batch
    currentBatch.submissions.push(fingerprint)
    currentBatch.archiveFile = buildArchiveFile(currentBatch)
    state.updatedAt = nowIso()
    const committed = commitState(taskId, state)
    syncPolicyRow(taskId, committed)
    return { ...last, record: committed ? buildDetailFromState(committed, located.row) : last.record }
  } catch (error) {
    return {
      ok: false,
      code: 'STORAGE',
      message: error instanceof Error ? error.message : '失败转存写入失败，已退回原记录',
      taskId,
      rolledBack: true,
    }
  }
}

/** 结束一个批次：失败证据留在原处，只更新批次状态。 */
export function closeRetryBatch(taskId: string, batchId?: string, policyId?: number): RetryAttemptResult {
  const trimmed = String(taskId ?? '').trim()
  const located = policyId !== undefined ? findPolicyRowById(policyId) : findPolicyRow(trimmed)
  if (!trimmed || !located || String(located.row[ASSOCIATED_TASK_FIELD] ?? '') !== trimmed) {
    return { ok: false, code: 'NOT_FOUND', message: `没有找到关联任务 ${trimmed} 对应的重试策略` }
  }
  try {
    const store = readRetryStore()
    const state = store.tasks[trimmed]
    if (!state) {
      return { ok: false, code: 'NOT_FOUND', message: `关联任务 ${trimmed} 还没有重试记录`, taskId: trimmed }
    }
    const target = batchId ? state.batches[batchId] : activeBatch(state)
    if (!target) {
      return { ok: false, code: 'NOT_FOUND', message: `批次 ${batchId ?? ''} 不存在`, taskId: trimmed }
    }
    if (target.recoveries.length > 0) {
      return {
        ok: true,
        code: 'DUPLICATE',
        duplicate: true,
        message: `批次 ${target.batchId} 已恢复，无需重复结束`,
        taskId: trimmed,
        batchId: target.batchId,
        status: target.status,
      }
    }
    if (target.status === 'exhausted') {
      return {
        ok: true,
        code: 'DUPLICATE',
        duplicate: true,
        message: `批次 ${target.batchId} 已停止，失败转存与恢复位置保留`,
        taskId: trimmed,
        batchId: target.batchId,
        status: target.status,
        nextAttempt: target.cursor,
        remaining: remainingRetriesOf(target),
      }
    }
    target.status = 'exhausted'
    target.updatedAt = nowIso()
    target.archiveFile = buildArchiveFile(target)
    state.updatedAt = target.updatedAt
    const committed = commitState(trimmed, state)
    syncPolicyRow(trimmed, committed)
    return {
      ok: true,
      code: 'OK',
      message: `批次 ${target.batchId} 已停止，失败转存与恢复位置保留`,
      taskId: trimmed,
      batchId: target.batchId,
      status: target.status,
      nextAttempt: target.cursor,
      remaining: 0,
      record: committed ? buildDetailFromState(committed, located.row) : undefined,
    }
  } catch (error) {
    return {
      ok: false,
      code: 'STORAGE',
      message: error instanceof Error ? error.message : '失败转存写入失败，已退回原记录',
      taskId: trimmed,
      rolledBack: true,
    }
  }
}

/** 断线重开后的续跑状态：读取最后失败的尝试，给出下一次应该提交的序号。 */
export function resumeRetry(taskId: string): RetryResumeState {
  const trimmed = String(taskId ?? '').trim()
  const located = findPolicyRow(trimmed)
  if (!trimmed || !located) {
    return { ok: false, code: 'NOT_FOUND', message: `没有找到关联任务 ${trimmed} 对应的重试策略` }
  }
  const state = readState(trimmed)
  const batch = state ? activeBatch(state) : null
  if (!state || !batch) {
    return {
      ok: true,
      code: 'OK',
      message: `关联任务 ${trimmed} 还没有失败记录，将从第 1 次尝试开始`,
      taskId: trimmed,
      batchStatus: 'none',
      nextAttempt: 1,
      remaining: taskMaxRetries(trimmed, undefined),
      canRetry: true,
      failures: 0,
      recoveries: 0,
      record: retryDetail(trimmed) ?? undefined,
    }
  }
  const canRetry = batch.status !== 'recovered' && batch.status !== 'exhausted'
  const lastFailure = lastOf(batch.failures)
  let message = `批次 ${batch.batchId} 将从第 ${batch.cursor} 次尝试继续`
  if (batch.status === 'recovered') {
    message = `批次 ${batch.batchId} 已恢复成功，无需继续重试`
  } else if (batch.status === 'exhausted') {
    message = `批次 ${batch.batchId} 已耗尽最大重试次数，重试已停止`
  } else if (lastFailure) {
    message = `批次 ${batch.batchId} 上次失败在第 ${lastFailure.attempt} 次（${lastFailure.reason}），将从第 ${batch.cursor} 次继续`
  }
  return {
    ok: true,
    code: 'OK',
    message,
    taskId: trimmed,
    batchId: batch.batchId,
    batchStatus: batch.status,
    nextAttempt: batch.cursor,
    remaining: remainingRetriesOf(batch),
    canRetry,
    failures: batch.failures.length,
    recoveries: batch.recoveries.length,
    record: buildDetailFromState(state, located.row),
  }
}

/** 失败转存清单：失败证据 + 同步追加的恢复结果。 */
export function listFailureArchive(filters: Record<string, string> = {}): FailureArchiveView[] {
  const store = readRetryStore()
  const views: FailureArchiveView[] = []
  for (const state of Object.values(store.tasks)) {
    const located = findPolicyRow(state.taskId)
    if (!located) {
      continue
    }
    for (const batch of Object.values(state.batches)) {
      for (const failure of batch.failures) {
        views.push({
          id: failure.id,
          kind: 'failure',
          taskId: state.taskId,
          batchId: batch.batchId,
          attempt: failure.attempt,
          httpStatus: failure.httpStatus,
          reason: failure.reason,
          at: failure.archivedAt,
          archivePath: failure.archivePath,
          policyId: Number(located.row.id),
          policyNo: String(located.row[POLICY_NO_FIELD] ?? ''),
          batchStatus: batch.status,
        })
      }
      for (const recovery of batch.recoveries) {
        views.push({
          id: recovery.id,
          kind: 'recovery',
          taskId: state.taskId,
          batchId: batch.batchId,
          attempt: recovery.attempt,
          httpStatus: recovery.httpStatus,
          reason: recovery.reason,
          receipt: recovery.receipt,
          at: recovery.recoveredAt,
          archivePath: batch.archivePath,
          policyId: Number(located.row.id),
          policyNo: String(located.row[POLICY_NO_FIELD] ?? ''),
          batchStatus: batch.status,
        })
      }
    }
  }
  return applyFilters(views, filters)
}

/** 失败转存台账：每次尝试都落账，恢复结果同样落账。 */
export function listRetryLedger(filters: Record<string, string> = {}): RetryLedgerView[] {
  const store = readRetryStore()
  const views: RetryLedgerView[] = []
  for (const state of Object.values(store.tasks)) {
    const located = findPolicyRow(state.taskId)
    if (!located) {
      continue
    }
    for (const batch of Object.values(state.batches)) {
      for (const attempt of batch.attempts) {
        views.push({
          id: attempt.id,
          taskId: state.taskId,
          policyId: Number(located.row.id),
          policyNo: String(located.row[POLICY_NO_FIELD] ?? ''),
          batchId: batch.batchId,
          attempt: attempt.attempt,
          outcome: attempt.outcome,
          outcomeLabel: attempt.outcome === 'succeeded' ? '恢复成功' : '失败',
          httpStatus: attempt.httpStatus,
          reason: attempt.reason,
          receipt: batch.recoveries.find((item) => item.attempt === attempt.attempt)?.receipt,
          at: attempt.at,
          archived: batch.failures.some((item) => item.attempt === attempt.attempt),
          maxRetries: batch.maxRetries,
          remaining: remainingRetriesOf(batch),
          nextAttempt: batch.cursor,
          batchStatus: batch.status,
        })
      }
    }
  }
  return applyFilters(views, filters)
}

function applyFilters<T extends Record<string, unknown>>(views: T[], filters: Record<string, string>): T[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return views
  }
  return views.filter((view) =>
    pairs.every(([field, value]) => String(view[field] ?? '').includes(value.trim())),
  )
}

/** 台账统计：概览里的数字必须和清单、详情完全一致。 */
export function retrySummary(): {
  tasks: number
  batches: number
  failures: number
  recoveries: number
  exhausted: number
  retrying: number
} {
  const store = readRetryStore()
  let batches = 0
  let failures = 0
  let recoveries = 0
  let exhausted = 0
  let retrying = 0
  for (const state of Object.values(store.tasks)) {
    for (const batch of Object.values(state.batches)) {
      batches += 1
      failures += batch.failures.length
      recoveries += batch.recoveries.length
      if (batch.status === 'exhausted') {
        exhausted += 1
      }
      if (batch.status === 'pending' || batch.status === 'failed') {
        retrying += 1
      }
    }
  }
  return { tasks: Object.keys(store.tasks).length, batches, failures, recoveries, exhausted, retrying }
}

/** 导出某个任务的转存文件：只有首次失败与最终成功回执。 */
export function exportRetryArchive(taskId: string): RetryArchiveExport | null {
  const trimmed = String(taskId ?? '').trim()
  const located = findPolicyRow(trimmed)
  if (!trimmed || !located) {
    return null
  }
  const state = readState(trimmed)
  const batch = state ? activeBatch(state) : null
  if (!batch) {
    return null
  }
  return {
    filename: `${trimmed}-${batch.batchId}-failure-archive.json`,
    content: batch.archiveFile || buildArchiveFile(batch),
  }
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/** 导出失败转存台账 CSV，供另一个业务面对账。 */
export function exportRetryLedgerCsv(): RetryArchiveExport {
  const header = [
    '台账编号',
    '关联任务',
    '策略编号',
    '重试批次',
    '尝试序号',
    '结果',
    'HTTP状态',
    '原因',
    '回执',
    '时间',
    '是否转存',
    '最大重试次数',
    '剩余重试',
    '下次序号',
    '批次状态',
  ]
  const lines = [header.join(',')]
  for (const row of listRetryLedger()) {
    lines.push(
      [
        row.id,
        row.taskId,
        row.policyNo,
        row.batchId,
        row.attempt,
        row.outcomeLabel,
        row.httpStatus ?? '',
        csvCell(row.reason),
        csvCell(row.receipt ?? ''),
        row.at,
        row.archived ? '是' : '否',
        row.maxRetries,
        row.remaining,
        row.nextAttempt,
        RETRY_STATUS_LABELS[row.batchStatus],
      ].join(','),
    )
  }
  return { filename: '失败转存台账.csv', content: `﻿${lines.join('\n')}` }
}

/** 导出失败转存清单 CSV。 */
export function exportFailureArchiveCsv(): RetryArchiveExport {
  const header = [
    '清单编号',
    '类型',
    '关联任务',
    '策略编号',
    '重试批次',
    '尝试序号',
    'HTTP状态',
    '原因',
    '恢复回执',
    '时间',
    '转存路径',
    '批次状态',
  ]
  const lines = [header.join(',')]
  for (const row of listFailureArchive()) {
    lines.push(
      [
        row.id,
        row.kind === 'recovery' ? '恢复结果' : '失败转存',
        row.taskId,
        row.policyNo,
        row.batchId,
        row.attempt,
        row.httpStatus ?? '',
        csvCell(row.reason),
        csvCell(row.receipt ?? ''),
        row.at,
        row.archivePath,
        RETRY_STATUS_LABELS[row.batchStatus],
      ].join(','),
    )
  }
  return { filename: '失败转存清单.csv', content: `﻿${lines.join('\n')}` }
}

/** 清除某个关联任务的重试记录（重置模块时一并使用）。 */
export function clearRetryTask(taskId: string): void {
  const trimmed = String(taskId ?? '').trim()
  if (!trimmed) {
    return
  }
  const store = readRetryStore()
  if (!(trimmed in store.tasks)) {
    return
  }
  delete store.tasks[trimmed]
  persistStore(store)
}

/** 重置整个失败重试台账（清空 / 恢复示例数据时调用）。 */
export function clearRetryStore(): void {
  const previous = readRaw()
  try {
    writeRaw(JSON.stringify(emptyStore()))
  } catch {
    if (previous === null) {
      writeRaw(JSON.stringify(emptyStore()))
    } else {
      writeRaw(previous)
    }
    throw new Error('失败转存写入失败，已退回原记录')
  }
  notifyDataChange()
}

/** 重试模块被重置时，把台账里已不存在的关联任务一并清掉。 */
export function pruneRetryStore(): void {
  const store = readRetryStore()
  const taskIds = new Set(
    listRows(RETRY_MODULE_KEY).map((row) => String(row[ASSOCIATED_TASK_FIELD] ?? '')).filter(Boolean),
  )
  let changed = false
  for (const taskId of Object.keys(store.tasks)) {
    if (!taskIds.has(taskId)) {
      delete store.tasks[taskId]
      changed = true
    }
  }
  if (changed) {
    persistStore(store)
  }
}
