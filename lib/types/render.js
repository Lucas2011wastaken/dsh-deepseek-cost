/**
 * 展示层：token/金额格式化 + 底栏/悬停文案 + 峰谷时钟。
 * 面板组件在 panel.ts（那边要用宿主注入的 React）。
 */
import { isPeak } from './pricing.js';
/** `1234567` → `1.23M` / `12345` → `12.3k`。 */
export function formatTokens(value) {
    if (!Number.isFinite(value) || value <= 0)
        return '0';
    if (value >= 1_000_000)
        return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 100_000)
        return `${Math.round(value / 1000).toString()}k`;
    if (value >= 1000)
        return `${(value / 1000).toFixed(1)}k`;
    return String(Math.round(value));
}
/** 人民币：元以下给 4 位小数，元以上 2 位。 */
export function formatCny(value) {
    if (!Number.isFinite(value) || value <= 0)
        return '¥0';
    return `¥${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
}
/** 美元（配额余额用）：元以下给 2 位，以上也 2 位。 */
export function formatUsd(value) {
    if (!Number.isFinite(value) || value <= 0)
        return '$0';
    return `$${value.toFixed(2)}`;
}
export function formatPct(fraction) {
    if (!Number.isFinite(fraction) || fraction <= 0)
        return '0%';
    return `${(fraction * 100).toFixed(1)}%`;
}
/**
 * 表格里的紧凑人民币：累计金额上千后 `¥1234.56` 会挤爆窄列，改用 `¥1.23k`。
 * 主卡仍用完整精度（`formatCny`）。
 */
export function formatCnyCompact(value) {
    if (!Number.isFinite(value) || value <= 0)
        return '¥0';
    if (value >= 1_000_000)
        return `¥${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 10_000)
        return `¥${(value / 1000).toFixed(1)}k`;
    if (value >= 1000)
        return `¥${(value / 1000).toFixed(2)}k`;
    return formatCny(value);
}
/**
 * 按官方口径参与「未命中输入」计费的 token：`input + cacheWrite`。
 * 缓存写入没有独立价目（官方按未命中价计），所以展示上也并进「输入」，
 * 不再单列「缓存写」。
 */
export function billedInputTokens(counts) {
    return counts.input + counts.cacheWrite;
}
/** 状态行一行文案（上限 200 cell，超了截断）。 */
export function statusLineText(input) {
    const { summary } = input;
    const parts = [];
    if (summary.officialCny > 0) {
        parts.push(`${input.label}≈${formatCny(summary.officialCny)}`);
    }
    else if (summary.unpricedTokens > 0) {
        parts.push(`${input.label} 未计价 ${formatTokens(summary.unpricedTokens)}`);
    }
    else {
        return '';
    }
    if (input.showWindow && summary.officialCny > 0) {
        parts.push(isPeak(input.peakRule, input.nowMs) ? '峰' : '谷');
    }
    const text = parts.join(' ');
    return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}
/**
 * 底栏字段的短文案：只放官价总额与峰/谷，长度必须能塞进一格
 * （宿主 `maxCells` 默认 16，本插件默认 28）。
 */
export function statusFieldText(input) {
    const { summary } = input;
    if (summary.officialCny > 0) {
        const parts = [`${input.label}≈${formatCny(summary.officialCny)}`];
        if (input.showWindow)
            parts.push(isPeak(input.peakRule, input.nowMs) ? '峰' : '谷');
        return parts.join(' ');
    }
    if (summary.unpricedTokens > 0) {
        return `${input.label} 未计价 ${formatTokens(summary.unpricedTokens)}`;
    }
    return '';
}
/**
 * 悬停详情（补充行，≤160 cell）：本会话 token + 官价 + 当前峰谷窗口。
 * 字段本身只有一格，「为什么是这个数」放在这里。
 */
export function statusFieldDetail(input) {
    const { summary } = input;
    const parts = [
        `本会话 输入 ${formatTokens(billedInputTokens(summary.tokens))} · 缓存读 ${formatTokens(summary.tokens.cacheRead)} · 输出 ${formatTokens(summary.tokens.output)}`,
    ];
    if (summary.officialCny > 0)
        parts.push(`官价 ${formatCny(summary.officialCny)}`);
    if (summary.unpricedTokens > 0)
        parts.push(`未计价 ${formatTokens(summary.unpricedTokens)}`);
    parts.push(`现在${isPeak(input.peakRule, input.nowMs) ? '峰' : '谷'}（工作日 ${hoursText(input.peakRule)}）`);
    if (input.clickable)
        parts.push('点击打开台账');
    return parts.join(' · ');
}
function hoursText(rule) {
    return rule.weekdayHours.map(([start, end]) => `${String(start)}-${String(end)}`).join('/');
}
/** 峰谷窗口一行说明（不含「当前峰/谷」，那由调用方单独展示）。 */
export function peakWindowLine(peakRule) {
    const offset = peakRule.offsetMinutes === 480
        ? '北京'
        : `UTC${peakRule.offsetMinutes >= 0 ? '+' : ''}${String(peakRule.offsetMinutes / 60)}`;
    return `${offset} 工作日 ${hoursText(peakRule)}${peakRule.holidays.length > 0 ? ` · 节假日 ${String(peakRule.holidays.length)} 天` : ''}`;
}
/**
 * 下一次峰↔谷切换。做法是把未来 14 个自然日的每个窗口端点都算出来取最小
 * 大于 now 的那个（14 天覆盖春节/国庆这种长假；周末与节假日直接跳过）。
 */
export function nextPeakSwitch(peakRule, nowMs) {
    if (!Number.isFinite(nowMs) || peakRule.weekdayHours.length === 0)
        return undefined;
    const shifted = new Date(nowMs + peakRule.offsetMinutes * 60_000);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth();
    const day = shifted.getUTCDate();
    let best;
    for (let offset = 0; offset <= 14; offset += 1) {
        const localDate = new Date(Date.UTC(year, month, day + offset));
        const weekday = localDate.getUTCDay();
        if (weekday === 0 || weekday === 6)
            continue;
        const dateKey = localDate.toISOString().slice(0, 10);
        if (peakRule.holidays.includes(dateKey))
            continue;
        const dayStartMs = localDate.getTime() - peakRule.offsetMinutes * 60_000;
        for (const [start, end] of peakRule.weekdayHours) {
            for (const hour of [start, end]) {
                const atMs = dayStartMs + hour * 3_600_000;
                if (atMs > nowMs && (best === undefined || atMs < best))
                    best = atMs;
            }
        }
        // 日子是递增的：当天已经找到端点，就一定是最近的切换点。
        if (best !== undefined)
            break;
    }
    return best === undefined ? undefined : { atMs: best, toPeak: !isPeak(peakRule, nowMs) };
}
/** 剩余时长：`14h12m` / `3d5h` / `12m`。 */
export function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0)
        return '0m';
    const totalMinutes = Math.ceil(ms / 60_000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0)
        return `${String(days)}d${String(hours)}h`;
    if (hours > 0)
        return `${String(hours)}h${String(minutes).padStart(2, '0')}m`;
    return `${String(minutes)}m`;
}
