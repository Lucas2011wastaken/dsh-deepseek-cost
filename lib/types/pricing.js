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
/**
 * DeepSeek 官方人民币价目（元/百万 tokens）。
 * 2026-09-10 起 Flash 系列降价后的价目；Pro 为 Flash 的 3 倍价。
 */
export const DEEPSEEK_CNY = Object.freeze({
    flash: { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
    pro: { hit: [0.15, 0.30], miss: [4.5, 9.0], out: [13.5, 27.0] },
});
/**
 * 中国法定节假日（2026）。节假日全天按空闲价 —— 官方脚注明写
 * "excluding Chinese public holidays"，但官方**不提供机读列表**，只能硬编码。
 * 这份表跟 小鲸鱼记账（MeteorNOX/DeepSeek-Balance-Whale-Widget）的同名表对齐，
 * 每年 11 月国务院公布次年安排后需要更新（配置里可覆盖，见 config.holidays）。
 */
export const CN_HOLIDAYS_2026 = Object.freeze([
    // 元旦
    '2026-01-01', '2026-01-02', '2026-01-03',
    // 春节
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    // 清明
    '2026-04-04', '2026-04-05', '2026-04-06',
    // 劳动节
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    // 端午
    '2026-06-19', '2026-06-20', '2026-06-21',
    // 中秋 + 国庆
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
    '2026-10-06', '2026-10-07',
]);
/**
 * DeepSeek 官方峰谷规则：北京（UTC+8）周一至周五 9:00-12:00、14:00-18:00，
 * 排除法定节假日。与 dsh-tui 内建 `deepseekPricing.ts` 同口径，本插件额外
 * 补上了官方脚注里的"法定节假日"这一条（内建版没有）。
 */
export const DEEPSEEK_PEAK = Object.freeze({
    offsetMinutes: 480,
    weekdayHours: Object.freeze([[9, 12], [14, 18]]),
    holidays: CN_HOLIDAYS_2026,
});
const pad2 = (value) => (value < 10 ? `0${String(value)}` : String(value));
/** 把 UTC 毫秒按固定偏移换算成规则时区的日历读数。 */
export function readLocal(rule, timeMs) {
    const shifted = new Date(timeMs + rule.offsetMinutes * 60_000);
    const year = shifted.getUTCFullYear();
    const month = pad2(shifted.getUTCMonth() + 1);
    const day = pad2(shifted.getUTCDate());
    return {
        weekday: shifted.getUTCDay(),
        hour: shifted.getUTCHours(),
        dateKey: `${String(year)}-${month}-${day}`,
    };
}
/** 北京时间（UTC+8）的 `YYYY-MM-DD` —— 台账按北京日历日归档。 */
export function beijingDateKey(timeMs) {
    return readLocal(DEEPSEEK_PEAK, timeMs).dateKey;
}
/** 该时刻在给定规则下是否按高峰价计费。 */
export function isPeak(rule, timeMs) {
    if (!Number.isFinite(timeMs))
        return false;
    const { weekday, hour, dateKey } = readLocal(rule, timeMs);
    if (weekday === 0 || weekday === 6)
        return false;
    if (rule.holidays.includes(dateKey))
        return false;
    return rule.weekdayHours.some(([start, end]) => hour >= start && hour < end);
}
/**
 * 模型 id → 计价档。只认 `deepseek*` 前缀：ollama-pro 上还有 glm/kimi/minimax
 * 等非 DS 模型（其中 `glm-5.3-flash` 也带 "flash" 字样），绝不能拿 DS 官方
 * 价目去给它们计价 —— 认不出就返回 undefined，界面显示"未计价"而不是编一个数。
 * `:tag` 后缀（`deepseek-v4-pro:0813`）先剥掉。
 */
export function classifyModel(model) {
    const id = model.trim().toLowerCase();
    if (id === '' || !id.startsWith('deepseek'))
        return undefined;
    const colon = id.indexOf(':');
    const base = colon === -1 ? id : id.slice(0, colon);
    if (base.includes('pro'))
        return 'pro';
    if (base.includes('flash'))
        return 'flash';
    return undefined;
}
export const ZERO_COUNTS = Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
export function countsOf(usage) {
    const num = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    return {
        input: num(usage.inputTokens),
        output: num(usage.outputTokens),
        cacheRead: num(usage.cacheReadTokens),
        cacheWrite: num(usage.cacheWriteTokens),
    };
}
export function addCounts(a, b) {
    return {
        input: a.input + b.input,
        cacheRead: a.cacheRead + b.cacheRead,
        cacheWrite: a.cacheWrite + b.cacheWrite,
        output: a.output + b.output,
    };
}
export function countsTotal(counts) {
    return counts.input + counts.cacheRead + counts.cacheWrite + counts.output;
}
export const ZERO_SLOTS = Object.freeze({
    peak: ZERO_COUNTS,
    idle: ZERO_COUNTS,
});
/** 按官方峰谷时钟给一笔 usage 分槽。 */
export function slotsFor(counts, timeMs, rule = DEEPSEEK_PEAK) {
    const peak = isPeak(rule, timeMs);
    return {
        peak: peak ? counts : ZERO_COUNTS,
        idle: peak ? ZERO_COUNTS : counts,
    };
}
export function addSlots(a, b) {
    return {
        peak: addCounts(a.peak, b.peak),
        idle: addCounts(a.idle, b.idle),
    };
}
export function slotsTotal(slots) {
    return addCounts(slots.peak, slots.idle);
}
/** 一次计价：`input×未命中价 + cacheRead×命中价 + cacheWrite×未命中价 + output×输出价`。 */
export function costOfCounts(counts, price, rate) {
    const billed = counts.input * price.miss[rate] +
        counts.cacheRead * price.hit[rate] +
        counts.cacheWrite * price.miss[rate] +
        counts.output * price.out[rate];
    return billed / 1_000_000;
}
/** 按官方峰谷桶计价（单位与传入价目表一致）。 */
export function costOfSlots(slots, price) {
    return costOfCounts(slots.idle, price, 0) + costOfCounts(slots.peak, price, 1);
}
