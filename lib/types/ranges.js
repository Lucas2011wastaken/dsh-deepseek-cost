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
export const BEIJING_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
/** 北京时间当天 00:00。 */
export function beijingDayStart(nowMs) {
    const shifted = new Date(nowMs + BEIJING_OFFSET_MS);
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - BEIJING_OFFSET_MS;
}
/** 北京时间当月 1 日 00:00。 */
export function beijingMonthStart(nowMs) {
    const shifted = new Date(nowMs + BEIJING_OFFSET_MS);
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - BEIJING_OFFSET_MS;
}
/** 北京时间本周一 00:00（自然周兜底）。 */
export function beijingWeekStart(nowMs) {
    const shifted = new Date(nowMs + BEIJING_OFFSET_MS);
    const daysSinceMonday = (shifted.getUTCDay() + 6) % 7;
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - daysSinceMonday) - BEIJING_OFFSET_MS;
}
/**
 * 在锚点上加减整月，日期超出目标月天数时夹到月末（1/31 + 1 月 → 2/28）。
 * 锚点带时区偏移时，偏移已体现在 UTC 分量里；北京无夏令时，所以直接用 UTC 分量。
 */
export function addMonthsClamped(anchorMs, delta) {
    const base = new Date(anchorMs);
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth() + delta;
    const day = base.getUTCDate();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Date.UTC(year, month, Math.min(day, lastDay), base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(), base.getUTCMilliseconds());
}
/** now 所在的付费月周期；锚点无效返回 undefined。 */
export function billingCycle(anchorMs, nowMs) {
    if (anchorMs === undefined || !Number.isFinite(anchorMs) || !Number.isFinite(nowMs))
        return undefined;
    const anchor = new Date(anchorMs);
    const current = new Date(nowMs);
    let index = (current.getUTCFullYear() - anchor.getUTCFullYear()) * 12
        + (current.getUTCMonth() - anchor.getUTCMonth());
    let from = addMonthsClamped(anchorMs, index);
    if (nowMs < from) {
        index -= 1;
        from = addMonthsClamped(anchorMs, index);
    }
    let to = addMonthsClamped(anchorMs, index + 1);
    // 跨年/闰月时最多再走一步（正常情况上面已经落位）。
    while (nowMs >= to) {
        index += 1;
        from = to;
        to = addMonthsClamped(anchorMs, index + 1);
    }
    return { from, to };
}
/** 把配置里的 ISO 锚点解析成 ms；空串/非法值返回 undefined。 */
export function parseAnchor(value) {
    if (typeof value !== 'string' || value.trim() === '')
        return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
/** Ollama 周限窗口：以 resets_at 为终点，向前 7 天。 */
export function quotaWeekWindow(quota) {
    const resetsAt = quota?.weekly?.resetsAt;
    if (resetsAt === undefined || !Number.isFinite(resetsAt))
        return undefined;
    return { from: resetsAt - 7 * DAY_MS, to: resetsAt };
}
/** 付费月窗口：新套餐的 period 直接给 from/until。 */
export function quotaMonthWindow(quota) {
    const period = quota?.included?.period;
    if (period === undefined)
        return undefined;
    if (!Number.isFinite(period.from) || !Number.isFinite(period.until))
        return undefined;
    return { from: period.from, to: period.until };
}
/** 组装四个区间。配额/锚点缺席时自动退回自然周期并带上 note。 */
export function buildRangeSet(nowMs, quota, billingAnchorMs) {
    const today = { from: beijingDayStart(nowMs), to: nowMs, note: '' };
    const weekWindow = quotaWeekWindow(quota);
    const week = weekWindow === undefined
        ? { from: beijingWeekStart(nowMs), to: nowMs, note: '自然周' }
        : { from: weekWindow.from, to: Math.min(nowMs, weekWindow.to), note: 'Ollama 周限' };
    const monthWindow = quotaMonthWindow(quota);
    const cycle = monthWindow ?? billingCycle(billingAnchorMs, nowMs);
    const month = cycle === undefined
        ? { from: beijingMonthStart(nowMs), to: nowMs, note: '自然月' }
        : { from: cycle.from, to: Math.min(nowMs, cycle.to), note: '付费月' };
    const all = { from: Number.NEGATIVE_INFINITY, to: nowMs, note: '' };
    return { today, week, month, all };
}
