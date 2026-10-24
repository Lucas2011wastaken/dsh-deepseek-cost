/**
 * 台账：把每个模型的峰/谷 token 按北京日历日累计起来，并提供
 * 「本会话 / 今日 / 本月 / 累计」四个口径的金额汇总。
 *
 * 纯函数（除日期读取用传入的 nowMs），持久化在 index.ts 里接。
 */
import { addCounts, addSlots, beijingDateKey, classifyModel, costOfSlots, countsTotal, DEEPSEEK_CNY, ZERO_COUNTS, ZERO_SLOTS, } from './pricing.js';
/**
 * 计价与日历原语从本模块再导出：调用方（index.ts / 面板）只需要
 * `ledger.js` 一个入口，不必同时 import pricing.js。
 */
export { addCounts, addSlots, beijingDateKey, costOfSlots, slotsTotal, ZERO_COUNTS, ZERO_SLOTS } from './pricing.js';
/** 台账里的模型键：`provider|model`，让不同 provider 的同名模型分开累计。 */
export function modelKey(provider, model) {
    return `${provider}|${model}`;
}
export function splitModelKey(key) {
    const at = key.indexOf('|');
    return at === -1
        ? { provider: '', model: key }
        : { provider: key.slice(0, at), model: key.slice(at + 1) };
}
export function emptyDoc(nowMs) {
    return { version: 2, since: nowMs, updatedAt: nowMs, days: {} };
}
/** 往某天某模型上累加一笔（返回新文档，不改入参）。 */
export function addUsage(doc, dateKey, key, slots, nowMs) {
    const day = doc.days[dateKey] ?? {};
    return {
        ...doc,
        updatedAt: nowMs,
        days: { ...doc.days, [dateKey]: { ...day, [key]: addSlots(day[key] ?? ZERO_SLOTS, slots) } },
    };
}
/** 只保留最近 `keepDays` 天（含今天）。返回原文档当无需裁剪。 */
export function pruneDays(doc, keepDays, nowMs) {
    if (!Number.isFinite(keepDays) || keepDays <= 0)
        return doc;
    const keep = new Set();
    for (let offset = 0; offset < keepDays; offset += 1) {
        keep.add(beijingDateKey(nowMs - offset * 86_400_000));
    }
    const days = {};
    let dropped = false;
    for (const [dateKey, day] of Object.entries(doc.days)) {
        if (keep.has(dateKey))
            days[dateKey] = day;
        else
            dropped = true;
    }
    return dropped ? { ...doc, days } : doc;
}
/** 容错读回：任何形状不对的字段一律丢弃，绝不让坏文档拖垮插件。 */
export function normalizeDoc(value, nowMs) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return emptyDoc(nowMs);
    const record = value;
    const days = {};
    const rawDays = record['days'];
    if (rawDays !== null && typeof rawDays === 'object' && !Array.isArray(rawDays)) {
        for (const [dateKey, rawDay] of Object.entries(rawDays)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey))
                continue;
            if (rawDay === null || typeof rawDay !== 'object' || Array.isArray(rawDay))
                continue;
            const day = {};
            for (const [key, rawSlots] of Object.entries(rawDay)) {
                const slots = normalizeSlots(rawSlots);
                if (slots !== undefined)
                    day[key] = slots;
            }
            if (Object.keys(day).length > 0)
                days[dateKey] = day;
        }
    }
    const since = numberOr(record['since'], nowMs);
    const updatedAt = numberOr(record['updatedAt'], nowMs);
    return { version: 2, since, updatedAt, days };
}
/**
 * 槽位读回：v2 用 `peak`/`idle`；v1 的 `dsPeak`/`dsIdle` 同义兼容。
 * v1 文档里的 Ollama 槽（`olPeak`/`olIdle`）直接忽略——它们不再参与计价。
 */
function normalizeSlots(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    const peak = normalizeCounts(record['peak'] ?? record['dsPeak']);
    const idle = normalizeCounts(record['idle'] ?? record['dsIdle']);
    if (peak === undefined || idle === undefined)
        return undefined;
    return { peak, idle };
}
function normalizeCounts(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    const field = (name) => {
        const raw = record[name];
        if (raw === undefined)
            return 0;
        return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
    };
    const input = field('input');
    const cacheRead = field('cacheRead');
    const cacheWrite = field('cacheWrite');
    const output = field('output');
    if (input === undefined || cacheRead === undefined || cacheWrite === undefined || output === undefined) {
        return undefined;
    }
    return { input, cacheRead, cacheWrite, output };
}
function numberOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
/** 取某口径下的模型键 → 峰/谷两槽。 */
export function slotsInRange(doc, range, nowMs, session = {}) {
    if (range === 'session')
        return session;
    const today = beijingDateKey(nowMs);
    const month = today.slice(0, 7);
    const out = {};
    for (const [dateKey, day] of Object.entries(doc.days)) {
        if (range === 'today' && dateKey !== today)
            continue;
        if (range === 'month' && !dateKey.startsWith(month))
            continue;
        for (const [key, slots] of Object.entries(day)) {
            out[key] = addSlots(out[key] ?? ZERO_SLOTS, slots);
        }
    }
    return out;
}
export function summarize(byModel, tables = {}) {
    const cny = tables.cny ?? DEEPSEEK_CNY;
    let tokens = ZERO_COUNTS;
    let officialCny = 0;
    let unpricedTokens = 0;
    const pricedKeys = [];
    const unpriced = {};
    for (const [key, slots] of Object.entries(byModel)) {
        const { model } = splitModelKey(key);
        const cls = classifyModel(model);
        if (cls === undefined) {
            // 认不出计价档：只报 token，不给金额（与主包同一纪律）。
            const total = countsTotal(addCounts(slots.peak, slots.idle));
            unpricedTokens += total;
            if (total > 0)
                unpriced[key] = total;
            continue;
        }
        // 每笔 usage 恰好落进 peak / idle 之一，两槽相加就是真实 token 口径。
        tokens = addCounts(tokens, addCounts(slots.peak, slots.idle));
        officialCny += costOfSlots(slots, cny[cls]);
        pricedKeys.push(key);
    }
    return { tokens, officialCny, unpricedTokens, pricedKeys, unpriced };
}
