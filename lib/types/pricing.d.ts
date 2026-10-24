/**
 * 计价核心：DeepSeek 官方价目 + 官方峰谷时钟。
 *
 * 纯函数、零依赖、零 IO —— 单测直接跑，插件运行时不需要任何 bare import。
 *
 * 数据来源（快照 2026-10-15）：
 *  - DeepSeek 官方：https://api-docs.deepseek.com/quick_start/pricing
 *    （zh-cn 页为人民币价目；本插件只按人民币口径记账）
 *
 * 口径：每笔用量按**事件发生时刻**落进官方峰/谷两个桶，金额不会被当前
 * 时段重新定价。缓存写入没有单独价目——官方按未命中输入价计费，所以它和
 * `input` 一起进「未命中」桶，展示时也并进「输入」。
 *
 * 计价规则（官方页面原文口径）：
 *  - 扣减费用 = token 消耗量 × 模型单价；
 *  - 缓存命中的输入按命中价计费，其余输入（含**写入缓存**）按未命中价计费；
 *  - 空闲价为高峰价的一半；
 *  - 高峰时段：北京时间周一至周五 9:00-12:00、14:00-18:00，**不含中国法定
 *    节假日**；其余时段（含周末与法定节假日全天）为空闲时段。
 */
/** 单价对 `[空闲价, 高峰价]`，单位 货币/百万 tokens。 */
export type Rate = readonly [idle: number, peak: number];
/** 一个模型的完整价目（单位：货币/百万 tokens）。 */
export interface ModelPrice {
    /** 输入（缓存命中）。 */
    readonly hit: Rate;
    /** 输入（缓存未命中）；缓存写入量按此价另计。 */
    readonly miss: Rate;
    /** 输出（reasoning 已含在 outputTokens 内，不另计）。 */
    readonly out: Rate;
}
/**
 * 计价档：ollama-pro 上的 deepseek 模型归到官方两档之一。
 * `flash` = DeepSeek-V4.1-Flash（官方 id `deepseek-flash`）；
 * `pro`   = DeepSeek-V4-Pro-0813（官方 id `deepseek-v4-pro`）。
 */
export type PriceClass = 'flash' | 'pro';
/**
 * DeepSeek 官方人民币价目（元/百万 tokens）。
 * 2026-09-10 起 Flash 系列降价后的价目；Pro 为 Flash 的 3 倍价。
 */
export declare const DEEPSEEK_CNY: Readonly<Record<PriceClass, ModelPrice>>;
/** 一条峰谷规则：某个固定偏移时区下的工作日高峰小时区间 + 法定节假日。 */
export interface PeakRule {
    /** 相对 UTC 的固定偏移（分钟）。北京 = 480（无夏令时）。 */
    readonly offsetMinutes: number;
    /** 该时区日历日的星期一至星期五内的 `[start, end)` 小时区间。 */
    readonly weekdayHours: readonly (readonly [number, number])[];
    /** 该时区日历日的法定节假日（`YYYY-MM-DD`），全天按空闲价。 */
    readonly holidays: readonly string[];
}
/**
 * 中国法定节假日（2026）。节假日全天按空闲价 —— 官方脚注明写
 * "excluding Chinese public holidays"，但官方**不提供机读列表**，只能硬编码。
 * 这份表跟 小鲸鱼记账（MeteorNOX/DeepSeek-Balance-Whale-Widget）的同名表对齐，
 * 每年 11 月国务院公布次年安排后需要更新（配置里可覆盖，见 config.holidays）。
 */
export declare const CN_HOLIDAYS_2026: readonly string[];
/**
 * DeepSeek 官方峰谷规则：北京（UTC+8）周一至周五 9:00-12:00、14:00-18:00，
 * 排除法定节假日。与 dsh-tui 内建 `deepseekPricing.ts` 同口径，本插件额外
 * 补上了官方脚注里的"法定节假日"这一条（内建版没有）。
 */
export declare const DEEPSEEK_PEAK: PeakRule;
/** 峰谷规则时区下的日历读数。 */
export interface LocalReading {
    /** 0 = 周日 … 6 = 周六（该时区的日历日）。 */
    readonly weekday: number;
    readonly hour: number;
    /** 该时区的 `YYYY-MM-DD`。 */
    readonly dateKey: string;
}
/** 把 UTC 毫秒按固定偏移换算成规则时区的日历读数。 */
export declare function readLocal(rule: PeakRule, timeMs: number): LocalReading;
/** 北京时间（UTC+8）的 `YYYY-MM-DD` —— 台账按北京日历日归档。 */
export declare function beijingDateKey(timeMs: number): string;
/** 该时刻在给定规则下是否按高峰价计费。 */
export declare function isPeak(rule: PeakRule, timeMs: number): boolean;
/**
 * 模型 id → 计价档。只认 `deepseek*` 前缀：ollama-pro 上还有 glm/kimi/minimax
 * 等非 DS 模型（其中 `glm-5.3-flash` 也带 "flash" 字样），绝不能拿 DS 官方
 * 价目去给它们计价 —— 认不出就返回 undefined，界面显示"未计价"而不是编一个数。
 * `:tag` 后缀（`deepseek-v4-pro:0813`）先剥掉。
 */
export declare function classifyModel(model: string): PriceClass | undefined;
/** 一笔 usage 的四个互斥计数（DSH `TokenUsage` 契约的计价字段）。 */
export interface TokenCounts {
    readonly input: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly output: number;
}
export declare const ZERO_COUNTS: TokenCounts;
export declare function countsOf(usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
}): TokenCounts;
export declare function addCounts(a: TokenCounts, b: TokenCounts): TokenCounts;
export declare function countsTotal(counts: TokenCounts): number;
/**
 * 一次请求在官方峰/谷两个价格槽上的落点。
 * 旧版台账里的 `dsPeak` / `dsIdle` 与这里的 `peak` / `idle` 同义
 * （读回时由 ledger.normalizeDoc 兼容）。
 */
export interface CostSlots {
    readonly peak: TokenCounts;
    readonly idle: TokenCounts;
}
export declare const ZERO_SLOTS: CostSlots;
/** 按官方峰谷时钟给一笔 usage 分槽。 */
export declare function slotsFor(counts: TokenCounts, timeMs: number, rule?: PeakRule): CostSlots;
export declare function addSlots(a: CostSlots, b: CostSlots): CostSlots;
export declare function slotsTotal(slots: CostSlots): TokenCounts;
/** 一次计价：`input×未命中价 + cacheRead×命中价 + cacheWrite×未命中价 + output×输出价`。 */
export declare function costOfCounts(counts: TokenCounts, price: ModelPrice, rate: 0 | 1): number;
/** 按官方峰谷桶计价（单位与传入价目表一致）。 */
export declare function costOfSlots(slots: CostSlots, price: ModelPrice): number;
