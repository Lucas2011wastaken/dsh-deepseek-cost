/**
 * 台账：把每个模型的峰/谷 token 按北京日历日累计起来，并提供
 * 「本会话 / 今日 / 本月 / 累计」四个口径的金额汇总。
 *
 * 纯函数（除日期读取用传入的 nowMs），持久化在 index.ts 里接。
 */

import {
  addCounts,
  addSlots,
  beijingDateKey,
  classifyModel,
  costOfSlots,
  countsTotal,
  DEEPSEEK_CNY,
  ZERO_COUNTS,
  ZERO_SLOTS,
  type CostSlots,
  type ModelPrice,
  type PriceClass,
  type TokenCounts,
} from './pricing.js'

/**
 * 计价与日历原语从本模块再导出：调用方（index.ts / 面板）只需要
 * `ledger.js` 一个入口，不必同时 import pricing.js。
 */
export { addCounts, addSlots, beijingDateKey, costOfSlots, slotsTotal, ZERO_COUNTS, ZERO_SLOTS } from './pricing.js'

/** 台账里的模型键：`provider|model`，让不同 provider 的同名模型分开累计。 */
export function modelKey(provider: string, model: string): string {
  return `${provider}|${model}`
}

export function splitModelKey(key: string): { provider: string; model: string } {
  const at = key.indexOf('|')
  return at === -1
    ? { provider: '', model: key }
    : { provider: key.slice(0, at), model: key.slice(at + 1) }
}

/** 一天的台账：模型键 → 峰/谷两槽。 */
export type DayLedger = Record<string, CostSlots>

/**
 * 落盘文档（`days` 只保留最近 N 天，避免无界增长）。
 * v2 起槽位是 `peak` / `idle`；v1 的 `dsPeak` / `dsIdle` 仍按同义读回。
 */
export interface LedgerDoc {
  readonly version: 2
  /** 首次记账时刻（ms）。 */
  readonly since: number
  /** 最后一次写入时刻（ms）。 */
  readonly updatedAt: number
  /** 北京日历日 → 台账。 */
  readonly days: Record<string, DayLedger>
}

export function emptyDoc(nowMs: number): LedgerDoc {
  return { version: 2, since: nowMs, updatedAt: nowMs, days: {} }
}

/** 往某天某模型上累加一笔（返回新文档，不改入参）。 */
export function addUsage(
  doc: LedgerDoc,
  dateKey: string,
  key: string,
  slots: CostSlots,
  nowMs: number,
): LedgerDoc {
  const day = doc.days[dateKey] ?? {}
  return {
    ...doc,
    updatedAt: nowMs,
    days: { ...doc.days, [dateKey]: { ...day, [key]: addSlots(day[key] ?? ZERO_SLOTS, slots) } },
  }
}

/** 只保留最近 `keepDays` 天（含今天）。返回原文档当无需裁剪。 */
export function pruneDays(doc: LedgerDoc, keepDays: number, nowMs: number): LedgerDoc {
  if (!Number.isFinite(keepDays) || keepDays <= 0) return doc
  const keep = new Set<string>()
  for (let offset = 0; offset < keepDays; offset += 1) {
    keep.add(beijingDateKey(nowMs - offset * 86_400_000))
  }
  const days: Record<string, DayLedger> = {}
  let dropped = false
  for (const [dateKey, day] of Object.entries(doc.days)) {
    if (keep.has(dateKey)) days[dateKey] = day
    else dropped = true
  }
  return dropped ? { ...doc, days } : doc
}

/** 容错读回：任何形状不对的字段一律丢弃，绝不让坏文档拖垮插件。 */
export function normalizeDoc(value: unknown, nowMs: number): LedgerDoc {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptyDoc(nowMs)
  const record = value as Record<string, unknown>
  const days: Record<string, DayLedger> = {}
  const rawDays = record['days']
  if (rawDays !== null && typeof rawDays === 'object' && !Array.isArray(rawDays)) {
    for (const [dateKey, rawDay] of Object.entries(rawDays as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue
      if (rawDay === null || typeof rawDay !== 'object' || Array.isArray(rawDay)) continue
      const day: DayLedger = {}
      for (const [key, rawSlots] of Object.entries(rawDay as Record<string, unknown>)) {
        const slots = normalizeSlots(rawSlots)
        if (slots !== undefined) day[key] = slots
      }
      if (Object.keys(day).length > 0) days[dateKey] = day
    }
  }
  const since = numberOr(record['since'], nowMs)
  const updatedAt = numberOr(record['updatedAt'], nowMs)
  return { version: 2, since, updatedAt, days }
}

/**
 * 槽位读回：v2 用 `peak`/`idle`；v1 的 `dsPeak`/`dsIdle` 同义兼容。
 * v1 文档里的 Ollama 槽（`olPeak`/`olIdle`）直接忽略——它们不再参与计价。
 */
function normalizeSlots(value: unknown): CostSlots | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const peak = normalizeCounts(record['peak'] ?? record['dsPeak'])
  const idle = normalizeCounts(record['idle'] ?? record['dsIdle'])
  if (peak === undefined || idle === undefined) return undefined
  return { peak, idle }
}

function normalizeCounts(value: unknown): TokenCounts | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const field = (name: keyof TokenCounts): number | undefined => {
    const raw = record[name]
    if (raw === undefined) return 0
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined
  }
  const input = field('input')
  const cacheRead = field('cacheRead')
  const cacheWrite = field('cacheWrite')
  const output = field('output')
  if (input === undefined || cacheRead === undefined || cacheWrite === undefined || output === undefined) {
    return undefined
  }
  return { input, cacheRead, cacheWrite, output }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 台账口径。 */
export type LedgerRange = 'session' | 'today' | 'month' | 'all'

/** 取某口径下的模型键 → 峰/谷两槽。 */
export function slotsInRange(
  doc: LedgerDoc,
  range: LedgerRange,
  nowMs: number,
  session: DayLedger = {},
): DayLedger {
  if (range === 'session') return session
  const today = beijingDateKey(nowMs)
  const month = today.slice(0, 7)
  const out: DayLedger = {}
  for (const [dateKey, day] of Object.entries(doc.days)) {
    if (range === 'today' && dateKey !== today) continue
    if (range === 'month' && !dateKey.startsWith(month)) continue
    for (const [key, slots] of Object.entries(day)) {
      out[key] = addSlots(out[key] ?? ZERO_SLOTS, slots)
    }
  }
  return out
}

/** 一次口径汇总的金额拆解。 */
export interface MoneySummary {
  /** 四个互斥 token 计数（缓存写入在展示上并入输入）。 */
  readonly tokens: TokenCounts
  /** DeepSeek 官方口径人民币（官方 CNY 价目 × 官方峰谷时钟）。 */
  readonly officialCny: number
  /** 认不出计价档的 token（只展示，不计钱）。 */
  readonly unpricedTokens: number
  /** 参与计价的模型条数。 */
  readonly pricedKeys: readonly string[]
  /** 未计价明细：`provider|model` → token。 */
  readonly unpriced: Readonly<Record<string, number>>
}

export function summarize(
  byModel: DayLedger,
  tables: {
    readonly cny?: Readonly<Record<PriceClass, ModelPrice>>
  } = {},
): MoneySummary {
  const cny = tables.cny ?? DEEPSEEK_CNY
  let tokens = ZERO_COUNTS
  let officialCny = 0
  let unpricedTokens = 0
  const pricedKeys: string[] = []
  const unpriced: Record<string, number> = {}
  for (const [key, slots] of Object.entries(byModel)) {
    const { model } = splitModelKey(key)
    const cls = classifyModel(model)
    if (cls === undefined) {
      // 认不出计价档：只报 token，不给金额（与主包同一纪律）。
      const total = countsTotal(addCounts(slots.peak, slots.idle))
      unpricedTokens += total
      if (total > 0) unpriced[key] = total
      continue
    }
    // 每笔 usage 恰好落进 peak / idle 之一，两槽相加就是真实 token 口径。
    tokens = addCounts(tokens, addCounts(slots.peak, slots.idle))
    officialCny += costOfSlots(slots, cny[cls])
    pricedKeys.push(key)
  }
  return { tokens, officialCny, unpricedTokens, pricedKeys, unpriced }
}
