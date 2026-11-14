/** 失败重试领域模型：失败转存、重试批次、恢复回执共用同一份持久化记录。 */

export type RetryOutcome = 'failed' | 'succeeded'

/** 重试批次的生命周期。失败数达到上限后进入 exhausted，成功恢复后进入 recovered。 */
export type RetryBatchStatus = 'pending' | 'failed' | 'recovered' | 'exhausted'

/** 单次尝试的流水，失败与成功都记在这里，作为台账的原始依据。 */
export type RetryAttemptRecord = {
  id: string
  taskId: string
  batchId: string
  attempt: number
  outcome: RetryOutcome
  httpStatus?: number
  reason: string
  at: string
  source: 'retry' | 'manual'
  submissionId?: string
}

/** 失败转存是不可覆盖的证据：每次失败都追加一条，冲突时以它为准。 */
export type FailureArchiveRecord = {
  id: string
  taskId: string
  batchId: string
  attempt: number
  httpStatus?: number
  reason: string
  archivedAt: string
  archivePath: string
}

/** 成功重试只追加恢复结果，不改写任何失败转存。 */
export type RecoveryRecord = {
  id: string
  taskId: string
  batchId: string
  attempt: number
  httpStatus?: number
  reason: string
  receipt: string
  recoveredAt: string
  source: 'retry' | 'manual'
}

export type RetryBatch = {
  batchId: string
  taskId: string
  maxRetries: number
  status: RetryBatchStatus
  /** 下一次允许提交的尝试序号，断线重开后从这里继续。 */
  cursor: number
  attempts: RetryAttemptRecord[]
  failures: FailureArchiveRecord[]
  recoveries: RecoveryRecord[]
  /** 转存文件：只保留首次失败证据与最终恢复回执，中间尝试留在台账里。 */
  archiveFile: string
  archivePath: string
  /** 已生效的整批提交指纹：重复提交同一批次只生效一次。 */
  submissions: string[]
  startedAt: string
  updatedAt: string
}

export type RetryState = {
  taskId: string
  maxRetries: number
  activeBatchId: string
  archivePath: string
  batches: Record<string, RetryBatch>
  updatedAt: string
}

export type RetryAttemptInput = {
  /** 可选的策略记录 id，一旦给出就必须与 taskId 指向同一条关联任务。 */
  id?: number
  taskId: string
  batchId?: string
  /** 省略时从当前批次的 cursor 继续；显式给出时必须正好等于 cursor。 */
  attempt?: number
  /** 幂等键：同一批次内重复提交同一个键只生效一次。 */
  submissionId?: string
  success: boolean
  httpStatus?: number
  reason?: string
  receipt?: string
  /** 最大重试次数（不含首次尝试），省略时取策略行上的值。 */
  maxRetries?: number
  at?: string
  source?: 'retry' | 'manual'
}

export type RetryBatchInput = {
  taskId: string
  batchId?: string
  maxRetries?: number
  attempts: Array<Omit<RetryAttemptInput, 'taskId' | 'id' | 'batchId'>>
}

export type RetryErrorCode =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'TASK_MISMATCH'
  | 'BATCH_COMPLETED'
  | 'EXHAUSTED'
  | 'OUT_OF_ORDER'
  | 'CONFLICT'
  | 'STORAGE'

export type RetryAttemptResult = {
  ok: boolean
  code: RetryErrorCode | 'OK' | 'DUPLICATE'
  duplicate?: boolean
  message: string
  taskId?: string
  batchId?: string
  attempt?: number
  status?: RetryBatchStatus
  nextAttempt?: number
  remaining?: number
  record?: RetryDetail
  rolledBack?: boolean
}

export type RetryDetailBatch = RetryBatch & {
  totalAttempts: number
  failedAttempts: number
  recovered: boolean
  remainingRetries: number
}

export type RetryDetail = {
  rowId: number
  policyNo: string
  taskId: string
  status: string
  pending: boolean
  abnormal: boolean
  archivePath: string
  activeBatchId: string
  maxRetries: number
  batches: RetryDetailBatch[]
  attempts: RetryAttemptRecord[]
  failures: FailureArchiveRecord[]
  recoveries: RecoveryRecord[]
  archiveFile: string
  nextAttempt: number
  batchStatus: RetryBatchStatus | 'none'
  remaining: number
}

/** 失败转存清单的一行：既有失败证据，也有同步追加的恢复结果。 */
export type FailureArchiveView = {
  id: string
  kind: 'failure' | 'recovery'
  taskId: string
  batchId: string
  attempt: number
  httpStatus?: number
  reason: string
  receipt?: string
  at: string
  archivePath: string
  policyId: number
  policyNo: string
  batchStatus: RetryBatchStatus
}

/** 失败转存台账的一行：每次尝试都落账，恢复结果同样落账。 */
export type RetryLedgerView = {
  id: string
  taskId: string
  policyId: number
  policyNo: string
  batchId: string
  attempt: number
  outcome: RetryOutcome
  outcomeLabel: '失败' | '恢复成功'
  httpStatus?: number
  reason: string
  receipt?: string
  at: string
  archived: boolean
  maxRetries: number
  remaining: number
  nextAttempt: number
  batchStatus: RetryBatchStatus
}

export type RetryResumeState = {
  ok: boolean
  code: RetryErrorCode | 'OK' | 'DUPLICATE'
  message: string
  taskId?: string
  batchId?: string
  batchStatus?: RetryBatchStatus | 'none'
  /** 断线重开后下一次应当提交的尝试序号。 */
  nextAttempt?: number
  remaining?: number
  canRetry?: boolean
  failures?: number
  recoveries?: number
  record?: RetryDetail
}

export type RetryArchiveExport = {
  filename: string
  content: string
}
