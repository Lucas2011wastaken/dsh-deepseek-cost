/**
 * 展示层：token/金额格式化 + 底栏/悬停文案 + 峰谷时钟。
 * 面板组件在 panel.ts（那边要用宿主注入的 React）。
 */
import { type PeakRule, type TokenCounts } from './pricing.js';
import type { MoneySummary } from './ledger.js';
/** `1234567` → `1.23M` / `12345` → `12.3k`。 */
export declare function formatTokens(value: number): string;
/** 人民币：元以下给 4 位小数，元以上 2 位。 */
export declare function formatCny(value: number): string;
/** 美元（配额余额用）：元以下给 2 位，以上也 2 位。 */
export declare function formatUsd(value: number): string;
export declare function formatPct(fraction: number): string;
/**
 * 表格里的紧凑人民币：累计金额上千后 `¥1234.56` 会挤爆窄列，改用 `¥1.23k`。
 * 主卡仍用完整精度（`formatCny`）。
 */
export declare function formatCnyCompact(value: number): string;
/**
 * 按官方口径参与「未命中输入」计费的 token：`input + cacheWrite`。
 * 缓存写入没有独立价目（官方按未命中价计），所以展示上也并进「输入」，
 * 不再单列「缓存写」。
 */
export declare function billedInputTokens(counts: TokenCounts): number;
export interface StatusLineInput {
    readonly summary: MoneySummary;
    readonly peakRule: PeakRule;
    readonly nowMs: number;
    readonly label: string;
    readonly showWindow: boolean;
}
/** 状态行一行文案（上限 200 cell，超了截断）。 */
export declare function statusLineText(input: StatusLineInput): string;
/**
 * 底栏字段的短文案：只放官价总额与峰/谷，长度必须能塞进一格
 * （宿主 `maxCells` 默认 16，本插件默认 28）。
 */
export declare function statusFieldText(input: StatusLineInput): string;
export interface StatusDetailInput extends StatusLineInput {
    /** 点击能打开台账面板时，把这件事写进悬停说明（宿主也要求可点必有说明）。 */
    readonly clickable: boolean;
}
/**
 * 悬停详情（补充行，≤160 cell）：本会话 token + 官价 + 当前峰谷窗口。
 * 字段本身只有一格，「为什么是这个数」放在这里。
 */
export declare function statusFieldDetail(input: StatusDetailInput): string;
/** 峰谷窗口一行说明（不含「当前峰/谷」，那由调用方单独展示）。 */
export declare function peakWindowLine(peakRule: PeakRule): string;
export interface PeakSwitch {
    /** 下一次峰↔谷切换的时刻（ms）。 */
    readonly atMs: number;
    /** 切换后是否进入高峰。 */
    readonly toPeak: boolean;
}
/**
 * 下一次峰↔谷切换。做法是把未来 14 个自然日的每个窗口端点都算出来取最小
 * 大于 now 的那个（14 天覆盖春节/国庆这种长假；周末与节假日直接跳过）。
 */
export declare function nextPeakSwitch(peakRule: PeakRule, nowMs: number): PeakSwitch | undefined;
/** 剩余时长：`14h12m` / `3d5h` / `12m`。 */
export declare function formatDuration(ms: number): string;
