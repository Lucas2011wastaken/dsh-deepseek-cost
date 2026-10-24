/**
 * 台账：把每个模型的峰/谷 token 按北京日历日累计起来，并提供
 * 「本会话 / 今日 / 本月 / 累计」四个口径的金额汇总。
 *
 * 纯函数（除日期读取用传入的 nowMs），持久化在 index.ts 里接。
 */
import { type CostSlots, type ModelPrice, type PriceClass, type TokenCounts } from './pricing.js';
/**
 * 计价与日历原语从本模块再导出：调用方（index.ts / 面板）只需要
 * `ledger.js` 一个入口，不必同时 import pricing.js。
 */
export { addCounts, addSlots, beijingDateKey, costOfSlots, slotsTotal, ZERO_COUNTS, ZERO_SLOTS } from './pricing.js';
/** 台账里的模型键：`provider|model`，让不同 provider 的同名模型分开累计。 */
export declare function modelKey(provider: string, model: string): string;
export declare function splitModelKey(key: string): {
    provider: string;
    model: string;
};
/** 一天的台账：模型键 → 峰/谷两槽。 */
export type DayLedger = Record<string, CostSlots>;
/**
 * 落盘文档（`days` 只保留最近 N 天，避免无界增长）。
 * v2 起槽位是 `peak` / `idle`；v1 的 `dsPeak` / `dsIdle` 仍按同义读回。
 */
export interface LedgerDoc {
    readonly version: 2;
    /** 首次记账时刻（ms）。 */
    readonly since: number;
    /** 最后一次写入时刻（ms）。 */
    readonly updatedAt: number;
    /** 北京日历日 → 台账。 */
    readonly days: Record<string, DayLedger>;
}
export declare function emptyDoc(nowMs: number): LedgerDoc;
/** 往某天某模型上累加一笔（返回新文档，不改入参）。 */
export declare function addUsage(doc: LedgerDoc, dateKey: string, key: string, slots: CostSlots, nowMs: number): LedgerDoc;
/** 只保留最近 `keepDays` 天（含今天）。返回原文档当无需裁剪。 */
export declare function pruneDays(doc: LedgerDoc, keepDays: number, nowMs: number): LedgerDoc;
/** 容错读回：任何形状不对的字段一律丢弃，绝不让坏文档拖垮插件。 */
export declare function normalizeDoc(value: unknown, nowMs: number): LedgerDoc;
/** 台账口径。 */
export type LedgerRange = 'session' | 'today' | 'month' | 'all';
/** 取某口径下的模型键 → 峰/谷两槽。 */
export declare function slotsInRange(doc: LedgerDoc, range: LedgerRange, nowMs: number, session?: DayLedger): DayLedger;
/** 一次口径汇总的金额拆解。 */
export interface MoneySummary {
    /** 四个互斥 token 计数（缓存写入在展示上并入输入）。 */
    readonly tokens: TokenCounts;
    /** DeepSeek 官方口径人民币（官方 CNY 价目 × 官方峰谷时钟）。 */
    readonly officialCny: number;
    /** 认不出计价档的 token（只展示，不计钱）。 */
    readonly unpricedTokens: number;
    /** 参与计价的模型条数。 */
    readonly pricedKeys: readonly string[];
    /** 未计价明细：`provider|model` → token。 */
    readonly unpriced: Readonly<Record<string, number>>;
}
export declare function summarize(byModel: DayLedger, tables?: {
    readonly cny?: Readonly<Record<PriceClass, ModelPrice>>;
}): MoneySummary;
