import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'scraper-config-studio:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function parseRows(raw: string): Record<string, EntryRow[]> {
  const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
  return { ...clone(SEED_ROWS), ...parsed }
}

function seedRaw(): string {
  return JSON.stringify(clone(SEED_ROWS))
}

// 缓存跟着 localStorage 的原始内容走：另一个标签页写入后，下一次读取一定会重新解析，
// 不再拿进程里的旧对象回答列表 / 详情 / 概览。
let cache: Record<string, EntryRow[]> | null = null
let cacheRaw: string | null = null

const listeners = new Set<() => void>()
const watchedKeys = new Set<string>([STORAGE_KEY])
let listening = false

function ensureStorageListener(): void {
  if (listening || typeof window === 'undefined') {
    return
  }
  listening = true
  window.addEventListener('storage', (event: StorageEvent) => {
    // key 为 null 表示另一个标签页调用了 clear()。
    if (event.key === null || watchedKeys.has(event.key)) {
      cacheRaw = null
      emitChange()
    }
  })
}

function emitChange(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // 页面监听器失败不应该影响存储层。
    }
  }
}

function readFresh(): Record<string, EntryRow[]> {
  if (!hasStorage()) {
    if (cache === null) {
      cache = clone(SEED_ROWS)
      cacheRaw = JSON.stringify(cache)
    }
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw === null) {
    const seeded = clone(SEED_ROWS)
    const serialized = JSON.stringify(seeded)
    window.localStorage.setItem(STORAGE_KEY, serialized)
    cache = seeded
    cacheRaw = serialized
    return seeded
  }
  if (raw === cacheRaw && cache !== null) {
    return cache
  }
  try {
    cache = parseRows(raw)
    cacheRaw = raw
  } catch {
    const seeded = clone(SEED_ROWS)
    const serialized = JSON.stringify(seeded)
    window.localStorage.setItem(STORAGE_KEY, serialized)
    cache = seeded
    cacheRaw = serialized
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  ensureStorageListener()
  return readFresh()
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  ensureStorageListener()
  // 先重新读一次，避免把另一个标签页刚写入的其他模块数据覆盖掉。
  const current = readFresh()
  const next = { ...current, [key]: clone(rows) }
  const serialized = JSON.stringify(next)
  if (hasStorage()) {
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = next
  cacheRaw = serialized
  emitChange()
}

export function replaceAllRows(rows: Record<string, EntryRow[]>): void {
  ensureStorageListener()
  const next = clone(rows)
  const serialized = JSON.stringify(next)
  if (hasStorage()) {
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = next
  cacheRaw = serialized
  emitChange()
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 订阅数据变化：同标签页写入、另一个标签页的 storage 事件都会触发。 */
export function subscribeDataChanges(listener: () => void): () => void {
  ensureStorageListener()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 让其他数据层（例如失败重试台账）也能接入同一套跨标签页失效通知。 */
export function registerStorageKey(key: string): void {
  watchedKeys.add(key)
}

export function notifyDataChange(): void {
  emitChange()
}

/** 强制丢弃缓存，下一次读取回到 localStorage 中的最新内容。 */
export function invalidateCache(): void {
  cacheRaw = null
}
