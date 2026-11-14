import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  clearRetryStore,
  closeRetryBatch,
  reconcileRetryRows,
  retryDetail,
  retryPolicyGuard,
  retrySummary,
} from '@/data/retry-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const RETRY_MODULE_KEY = 'retry'
const ASSOCIATED_TASK_FIELD = '关联任务'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  // 每次列表读取都从共享的失败重试记录重新投影，列表不会读到旧缓存。
  const source = key === RETRY_MODULE_KEY ? reconcileRetryRows() : listRows(key)
  const matched = filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/**
 * 失败重试模块的动作要顺着重试记录走：没有恢复之前不能直接改成普通启用态，
 * 失败原因、重试批次、转存路径都必须留在行上。
 */
function runRetryAction(row: EntryRow, action: string, target: string): ActionResult {
  const taskId = String(row[ASSOCIATED_TASK_FIELD] ?? '').trim()
  const meta = moduleMeta(RETRY_MODULE_KEY)
  const updated: EntryRow = { ...row }
  updated.status = target
  updated.pending = target !== meta.statuses[meta.statuses.length - 1]
  updated.abnormal = NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)) || Boolean(row.abnormal)

  if (action.startsWith('启用')) {
    const guard = retryPolicyGuard(taskId, action)
    if (!guard.ok) {
      return { ok: false, message: guard.message }
    }
    const detail = taskId ? retryDetail(taskId) : null
    if (detail && detail.failures.length > 0 && detail.batchStatus !== 'recovered') {
      // 失败转存还在，且批次没有恢复成功：不允许把记录改成普通启用态。
      return {
        ok: false,
        message: `关联任务 ${taskId} 的重试批次尚未恢复成功，失败转存仍保留，不能直接启用`,
      }
    }
    // 恢复成功后才回到启用态；失败证据继续留在行上，不被洗白。
    updated.status = '已启用'
    updated.pending = false
    if (detail) {
      updated.abnormal = detail.failures.length > 0
      updated['重试进度'] = `失败 ${detail.failures.length} / 恢复 ${detail.recoveries.length}`
      updated['失败转存路径'] = detail.archivePath
      updated['下次重试序号'] = String(detail.nextAttempt)
    }
  }

  if (action.startsWith('停用')) {
    // 停用结束批次：失败转存与恢复位置原样保留，行状态由批次状态投影出来。
    if (taskId) {
      closeRetryBatch(taskId, undefined, Number(row.id))
    }
    const detail = taskId ? retryDetail(taskId) : null
    if (detail) {
      updated['重试进度'] = `失败 ${detail.failures.length} / 恢复 ${detail.recoveries.length}`
      updated['失败转存路径'] = detail.archivePath
      updated['下次重试序号'] = String(detail.nextAttempt)
      if (detail.failures.length > 0) {
        updated.abnormal = true
      }
    }
  }

  if (action.startsWith('提交校验')) {
    const detail = taskId ? retryDetail(taskId) : null
    if (detail && detail.failures.length > 0) {
      updated.abnormal = true
    }
  }

  const rows = listRows(RETRY_MODULE_KEY)
  const index = rows.findIndex((item) => Number(item.id) === Number(row.id))
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${row.id} 的${meta.entity}` }
  }
  const next = [...rows]
  next[index] = updated
  saveRows(RETRY_MODULE_KEY, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${updated.status}」` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = key === RETRY_MODULE_KEY ? reconcileRetryRows() : listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return {
      ok: false,
      message: `${meta.entity}已经是「${current}」，不用重复操作`,
    }
  }

  if (key === RETRY_MODULE_KEY) {
    return runRetryAction(rows[index], action, target)
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  if (key === RETRY_MODULE_KEY) {
    resetRows(key)
    // 重置策略行时把重试台账一起清掉，避免列表和台账出现两套口径。
    clearRetryStore()
    return listEntries(key)
  }
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  const source = key === RETRY_MODULE_KEY ? reconcileRetryRows() : listRows(key)
  for (const row of source) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  downloadText(filename, content)
}

/** 失败转存导出与普通清单共用一套下载逻辑。 */
export function downloadText(filename: string, content: string, mime = 'text/csv'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  // 概览和列表使用同一份重试记录：先投影，再统计。
  reconcileRetryRows()
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const retry = retrySummary()
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    { label: '失败转存条数', value: retry.failures },
    { label: '恢复回执条数', value: retry.recoveries },
    { label: '重试批次', value: retry.batches },
    { label: '耗尽批次', value: retry.exhausted },
  ]
  return { cards, modules }
}
