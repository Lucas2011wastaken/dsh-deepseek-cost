/**
 * 台账区间：今日 / 本周 / 本月 / 累计。
 *
 * 「本周」优先对齐 Ollama 周限：以 `weekly.resets_at` 为终点、减 7 天为起点；
 * 拿不到配额时退回北京时间周一 00:00 的自然周。
 *
 * 「本月」优先对齐付费月：新套餐用 `/api/balance` 的 `period.from/until`；
 * 老套餐没有月度 period，用配置的 `billing.anchor`（订阅续费日）按月推算；
 * 两者都没有才退回自然月。
 *
 * 所有边界都是 UTC 毫秒；北京时区固定 UTC+8（无夏令时）。
 */
export declare const BEIJING_OFFSET_MS: number;
/** 区间 id（本会话不在表里，单独做主卡）。 */
export type RangeId = 'today' | 'week' | 'month' | 'all';
/** 一个时间窗。`note` 用于面板上标明这是哪种口径。 */
export interface RangeWindow {
    readonly from: number;
    readonly to: number;
    /** `''` = 默认口径；否则显示在面板上（如 `自然周` / `付费月`）。 */
    readonly note: string;
}
export interface RangeSet {
    readonly today: RangeWindow;
    readonly week: RangeWindow;
    readonly month: RangeWindow;
    readonly all: RangeWindow;
}
/** 配额快照里与区间有关的最小结构（避免 ranges ↔ quota 循环依赖）。 */
export interface QuotaLike {
    readonly weekly?: {
        readonly resetsAt: number;
    } | undefined;
    readonly included?: {
        readonly period: {
            readonly from: number;
            readonly until: number;
        };
    } | undefined;
}
/** 北京时间当天 00:00。 */
export declare function beijingDayStart(nowMs: number): number;
/** 北京时间当月 1 日 00:00。 */
export declare function beijingMonthStart(nowMs: number): number;
/** 北京时间本周一 00:00（自然周兜底）。 */
export declare function beijingWeekStart(nowMs: number): number;
/**
 * 在锚点上加减整月，日期超出目标月天数时夹到月末（1/31 + 1 月 → 2/28）。
 * 锚点带时区偏移时，偏移已体现在 UTC 分量里；北京无夏令时，所以直接用 UTC 分量。
 */
export declare function addMonthsClamped(anchorMs: number, delta: number): number;
/** now 所在的付费月周期；锚点无效返回 undefined。 */
export declare function billingCycle(anchorMs: number | undefined, nowMs: number): {
    from: number;
    to: number;
} | undefined;
/** 把配置里的 ISO 锚点解析成 ms；空串/非法值返回 undefined。 */
export declare function parseAnchor(value: string): number | undefined;
/** Ollama 周限窗口：以 resets_at 为终点，向前 7 天。 */
export declare function quotaWeekWindow(quota: QuotaLike | undefined): {
    from: number;
    to: number;
} | undefined;
/** 付费月窗口：新套餐的 period 直接给 from/until。 */
export declare function quotaMonthWindow(quota: QuotaLike | undefined): {
    from: number;
    to: number;
} | undefined;
/** 组装四个区间。配额/锚点缺席时自动退回自然周期并带上 note。 */
export declare function buildRangeSet(nowMs: number, quota: QuotaLike | undefined, billingAnchorMs: number | undefined): RangeSet;
