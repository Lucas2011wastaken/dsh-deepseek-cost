/**
 * Ollama Cloud 配额：`GET https://ollama.com/api/balance`。
 *
 * - 老套餐：`included.session`（5 小时窗口）与 `included.weekly`（周窗口），
 *   各带 `remaining_percent` 与 `resets_at`；
 * - 新套餐：`included.balance_usd` / `allowance_usd` / `period {from, until}`；
 * - 官方限流 10 次/分钟，建议每分钟一次。多开时用共享缓存 + 租约，保证同一
 *   时刻只有一个实例真正发请求。
 *
 * 凭据：优先 `process.env`，其次 `~/.dsh/.credentials.yaml` 的 `refs.<NAME>`。
 * 只读、只在内存里持有；绝不写日志、绝不写进缓存文件。
 */
export interface QuotaConfig {
    readonly enabled: boolean;
    /** 依次尝试的环境变量/凭据名。 */
    readonly apiKeyEnv: readonly string[];
    /** DSH 凭据文件；`~` 会展开。 */
    readonly credentialsFile: string;
    readonly baseUrl: string;
    readonly pollMs: number;
    readonly timeoutMs: number;
}
export interface QuotaLimit {
    /** 剩余百分比 0–100（接口原义）。 */
    readonly remainingPercent: number;
    /** 下一次重置的 UTC 毫秒。 */
    readonly resetsAt: number;
}
export interface QuotaPeriod {
    readonly from: number;
    readonly until: number;
}
export interface QuotaSnapshot {
    readonly kind: 'legacy' | 'monthly';
    readonly session?: QuotaLimit;
    readonly weekly?: QuotaLimit;
    readonly included?: {
        readonly balanceUsd: number;
        readonly allowanceUsd: number;
        readonly period: QuotaPeriod;
    };
    readonly purchasedUsd?: number;
    readonly fetchedAt: number;
    /** 数据来自缓存且已经超过一个轮询周期。 */
    readonly stale: boolean;
    readonly error?: string;
}
/**
 * 解析 `/api/balance` 的响应。老/新两种形状都接受；认不出返回 undefined。
 * 解析器只产出数字，不保留原始响应，避免把无关字段带进面板/缓存。
 */
export declare function parseBalance(value: unknown, nowMs?: number): QuotaSnapshot | undefined;
/** 极简 YAML：只读顶层 `refs` 下的 `KEY: value`。不支持块标量/嵌套。 */
export declare function parseCredentialRefs(text: string): Record<string, string>;
/** 读凭据文件里的明文 refs；失败返回空对象。 */
export declare function readCredentialRefs(file: string): Promise<Record<string, string>>;
/** 依次尝试 env 与凭据文件；只返回非空字符串。 */
export declare function resolveApiKey(config: QuotaConfig): Promise<string | undefined>;
/** 配额客户端：缓存、租约、轮询、错误分类。 */
export declare class QuotaClient {
    private readonly config;
    private readonly dir;
    private readonly fetchImpl;
    private readonly cachePath;
    private readonly leasePath;
    private snapshot;
    private reason;
    private key;
    private timer;
    private bootTimer;
    private bootAttempt;
    private polling;
    private nextAllowedAt;
    private readonly listeners;
    constructor(config: QuotaConfig, dir: string, fetchImpl?: typeof fetch);
    subscribe(listener: () => void): () => void;
    getSnapshot(): QuotaSnapshot | undefined;
    getReason(): string;
    /** 启动：解析 key、用新鲜缓存、立即轮询一次，然后按 pollMs 轮询。 */
    start(): Promise<void>;
    stop(): void;
    /** 测试/手动刷新用：绕过缓存直接尝试一次（仍受租约与 nextAllowedAt 约束）。 */
    refreshNow(): Promise<void>;
    private freshMs;
    private notify;
    private applyPayload;
    private poll;
    private handleHttpError;
    /** 失败时保留旧值，只标 stale；这样面板不会突然空一块。 */
    private markStale;
    private scheduleBootRetry;
    private readCache;
    private writeCache;
    private acquireLease;
    private releaseLease;
}
