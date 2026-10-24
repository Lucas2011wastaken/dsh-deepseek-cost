/**
 * 多 TUI 实例共享台账：每进程一个 append-only JSONL，读取时跨文件汇总。
 *
 * 为什么不是「整份文档读改写」：插件存储的锁只覆盖单次 set，
 * 两个 TUI 各自读旧文档再写回，后写的会覆盖先写的。append-only 日志让每个
 * 进程只写自己的文件，天然没有跨进程丢更新；同时事件自带时间戳，能把
 * 「本周」精确对齐到 Ollama 周限窗口、「本月」精确对齐到付费月。
 *
 * 文件布局：
 *   <dir>/instances/<instanceId>.jsonl   每进程一个，只追加
 *   <dir>/migrated.json                  旧台账迁移标记
 *   <dir>/ledger.json                    旧文件后端（迁移后只读保留）
 *
 * 每个进程**不扫描自己的文件**（内存里已经有全部事件），只增量扫描别人的；
 * 文件被截断/压缩时整体重建一次。半行 JSON 直接忽略，崩溃不会污染台账。
 */
import { type LedgerDoc, type MoneySummary } from './ledger.js';
import { type CostSlots, type TokenCounts } from './pricing.js';
/** 一条已归因的用量事件。 */
export interface UsageEvent {
    /** 事件时间（ms，取 DSH 事件自带的 time）。 */
    readonly t: number;
    /** 会话 id；旧台账迁移出来的事件为空串。 */
    readonly sid: string;
    readonly provider: string;
    readonly model: string;
    /** 是否子代理会话的用量（用于「最近主会话」判断）。 */
    readonly subagent: boolean;
    /** 该事件落在官方高峰价（true）还是谷价（false）。 */
    readonly peak: boolean;
    readonly counts: TokenCounts;
}
/** 一个会话的只读汇总视图。 */
export interface SessionView {
    readonly id: string;
    readonly summary: MoneySummary;
    readonly subagent: boolean;
    readonly provider: string;
    readonly model: string;
    readonly lastAt: number;
}
export interface UsageLogOptions {
    /** 台账目录（`~` 会展开）。 */
    readonly dir: string;
    /** 保留天数。 */
    readonly keepDays: number;
    /** false = 只放内存，不读写磁盘。 */
    readonly persist: boolean;
}
/** 把 `~` 展开成 home；其余原样返回。 */
export declare function expandHome(path: string): string;
/** 事件 → 两槽。每笔事件只落峰或谷之一。 */
export declare function slotsOf(event: UsageEvent): CostSlots;
export declare function encodeEvent(event: UsageEvent): string;
/** 解析一行；任何形状不对的字段一律丢弃。 */
export declare function decodeEvent(line: string): UsageEvent | undefined;
/**
 * 每进程的台账。只追加自己的文件，读取时合并所有实例文件。
 *
 * 线程模型：JS 单线程；`append()` 立即更新内存，磁盘写进 promise 队列，
 * 不阻塞记账与面板。
 */
export declare class UsageLog {
    readonly dir: string;
    readonly instancesDir: string;
    readonly instanceId: string;
    readonly filePath: string;
    private readonly keepDays;
    private readonly persist;
    private events;
    private readonly sessions;
    private allByModel;
    private lastMainSessionId;
    private lastMainAt;
    private updatedAt;
    private instanceCount;
    /** 别的实例文件：已消费字节数 / 已知大小。 */
    private readonly offsets;
    private readonly sizes;
    private writeQueue;
    /** 裁剪期间挡住新的追加，避免「读旧文件 → 新追加 → rename 覆盖」丢账。 */
    private maintenance;
    private refreshPromise;
    private initialized;
    constructor(options: UsageLogOptions);
    /** 建目录、载入现有事件、裁剪旧数据。幂等。 */
    init(): Promise<void>;
    /** 内存里的当前快照（调用方不应修改）。 */
    get lastUpdatedAt(): number;
    get instances(): number;
    get lastMain(): string;
    /** 追加一笔用量：先更新内存，再排队落盘。 */
    append(event: UsageEvent): void;
    /** 把排队中的写盘等完（卸载/迁移前用）。 */
    flush(): Promise<void>;
    /** 增量读取其他实例；有新事件返回 true。 */
    refresh(): Promise<boolean>;
    private doRefresh;
    /** 有文件被截断/替换时整体重建一次。 */
    private rebuild;
    /** 往内存索引里加一条；重复/非法事件返回 false。 */
    private addEvent;
    /** 某会话的汇总；未知会话返回空汇总。 */
    summaryOfSession(sid: string): MoneySummary;
    /** 某时间窗的汇总；事件按时间有序，从尾部回扫并提前停。 */
    summaryOfWindow(from: number, to: number): MoneySummary;
    /** 全部会话视图（不含旧台账迁移出来的空 id 会话）。 */
    sessionViews(): Record<string, SessionView>;
    /** 裁剪自己的文件（只删自己，跨进程安全）。 */
    pruneOwn(): Promise<void>;
    /** 清掉超过保留期的死实例文件。 */
    pruneDead(): Promise<void>;
}
/**
 * 把旧版按日台账迁移成事件文件（只做一次）。
 *
 * 每天、每个模型、峰/谷两个桶各合成一条「日初时刻」事件：金额完全精确
 * （桶本身保留），只有历史区间的边界按日近似。目标文件是确定性的，多个
 * 进程同时迁移也只会得到同一份内容（原子 rename），不会重复计数。
 */
export declare function migrateLegacyDoc(doc: LedgerDoc, options: {
    readonly dir: string;
    readonly instancesDir: string;
}): Promise<number>;
