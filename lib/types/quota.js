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
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expandHome } from './events.js';
const CACHE_FILE = 'quota.json';
const LEASE_FILE = 'quota.lock';
const LEASE_MS = 20_000;
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function isoMs(value) {
    if (typeof value !== 'string' || value.trim() === '')
        return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function parseLimit(value) {
    if (!isRecord(value))
        return undefined;
    const remaining = finiteNumber(value['remaining_percent']);
    const resetsAt = isoMs(value['resets_at']);
    if (remaining === undefined || resetsAt === undefined)
        return undefined;
    return { remainingPercent: Math.min(100, Math.max(0, remaining)), resetsAt };
}
/**
 * 解析 `/api/balance` 的响应。老/新两种形状都接受；认不出返回 undefined。
 * 解析器只产出数字，不保留原始响应，避免把无关字段带进面板/缓存。
 */
export function parseBalance(value, nowMs = Date.now()) {
    if (!isRecord(value))
        return undefined;
    const included = value['included'];
    if (!isRecord(included))
        return undefined;
    const session = parseLimit(included['session']);
    const weekly = parseLimit(included['weekly']);
    const balanceUsd = finiteNumber(included['balance_usd']);
    const allowanceUsd = finiteNumber(included['allowance_usd']);
    const periodRaw = included['period'];
    const period = isRecord(periodRaw)
        ? { from: isoMs(periodRaw['from']), until: isoMs(periodRaw['until']) }
        : undefined;
    const hasPeriod = period !== undefined
        && period.from !== undefined
        && period.until !== undefined
        && period.until > period.from;
    const purchased = value['purchased'];
    const purchasedUsd = isRecord(purchased) ? finiteNumber(purchased['balance_usd']) : undefined;
    if (session !== undefined || weekly !== undefined) {
        return {
            kind: 'legacy',
            ...(session === undefined ? {} : { session }),
            ...(weekly === undefined ? {} : { weekly }),
            ...(hasPeriod && balanceUsd !== undefined && allowanceUsd !== undefined
                ? {
                    included: {
                        balanceUsd,
                        allowanceUsd,
                        period: { from: period.from, until: period.until },
                    },
                }
                : {}),
            ...(purchasedUsd === undefined ? {} : { purchasedUsd }),
            fetchedAt: nowMs,
            stale: false,
        };
    }
    if (hasPeriod && balanceUsd !== undefined && allowanceUsd !== undefined && allowanceUsd > 0) {
        return {
            kind: 'monthly',
            included: {
                balanceUsd,
                allowanceUsd,
                period: { from: period.from, until: period.until },
            },
            ...(purchasedUsd === undefined ? {} : { purchasedUsd }),
            fetchedAt: nowMs,
            stale: false,
        };
    }
    return undefined;
}
/** 极简 YAML：只读顶层 `refs` 下的 `KEY: value`。不支持块标量/嵌套。 */
export function parseCredentialRefs(text) {
    const out = {};
    let inRefs = false;
    for (const rawLine of text.split(/\r?\n/)) {
        if (/^refs:\s*(#.*)?$/.test(rawLine)) {
            inRefs = true;
            continue;
        }
        if (!inRefs)
            continue;
        if (/^\S/.test(rawLine)) {
            // 下一个顶层键（records/version/...），refs 段结束。
            inRefs = false;
            continue;
        }
        const match = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(rawLine);
        if (match === null)
            continue;
        const [, name, rawValue] = match;
        if (name === undefined || rawValue === undefined)
            continue;
        let value = rawValue.trim();
        if (value === '' || value === '|' || value === '>')
            continue;
        // 去掉行尾注释（只有空白后才算注释）。
        value = value.replace(/\s+#.*$/, '').trim();
        if ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (value === '')
            continue;
        // 引用型值不在这里解析（env:/keyring:/file:/cmd:/op:/secret:）。
        if (/^(env|keyring|file|cmd|op|secret):/i.test(value))
            continue;
        out[name] = value;
    }
    return out;
}
/** 读凭据文件里的明文 refs；失败返回空对象。 */
export async function readCredentialRefs(file) {
    try {
        const text = await readFile(expandHome(file), 'utf8');
        return parseCredentialRefs(text);
    }
    catch {
        return {};
    }
}
/** 依次尝试 env 与凭据文件；只返回非空字符串。 */
export async function resolveApiKey(config) {
    for (const name of config.apiKeyEnv) {
        const value = process.env[name];
        if (typeof value === 'string' && value.trim() !== '')
            return value.trim();
    }
    const refs = await readCredentialRefs(config.credentialsFile);
    for (const name of config.apiKeyEnv) {
        const value = refs[name];
        if (typeof value === 'string' && value.trim() !== '')
            return value.trim();
    }
    return undefined;
}
/** 配额客户端：缓存、租约、轮询、错误分类。 */
export class QuotaClient {
    config;
    dir;
    fetchImpl;
    cachePath;
    leasePath;
    snapshot;
    reason = '';
    key;
    timer;
    bootTimer;
    bootAttempt = 0;
    polling = false;
    nextAllowedAt = 0;
    listeners = new Set();
    constructor(config, dir, fetchImpl = globalThis.fetch) {
        this.config = config;
        this.dir = expandHome(dir);
        this.fetchImpl = fetchImpl;
        this.cachePath = join(this.dir, CACHE_FILE);
        this.leasePath = join(this.dir, LEASE_FILE);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    getSnapshot() {
        return this.snapshot;
    }
    getReason() {
        return this.reason;
    }
    /** 启动：解析 key、用新鲜缓存、立即轮询一次，然后按 pollMs 轮询。 */
    async start() {
        if (!this.config.enabled)
            return;
        this.key = await resolveApiKey(this.config);
        if (this.key === undefined) {
            this.reason = `未找到 ${this.config.apiKeyEnv[0] ?? 'API key'}`;
            this.notify();
            return;
        }
        const cached = await this.readCache();
        if (cached !== undefined && Date.now() - cached.fetchedAt < this.freshMs()) {
            this.applyPayload(cached.payload, cached.fetchedAt);
        }
        await this.poll();
        this.timer = setInterval(() => { void this.poll(); }, this.config.pollMs);
        this.timer.unref?.();
    }
    stop() {
        if (this.timer !== undefined)
            clearInterval(this.timer);
        if (this.bootTimer !== undefined)
            clearTimeout(this.bootTimer);
        this.timer = undefined;
        this.bootTimer = undefined;
        void this.releaseLease();
    }
    /** 测试/手动刷新用：绕过缓存直接尝试一次（仍受租约与 nextAllowedAt 约束）。 */
    async refreshNow() {
        await this.poll();
    }
    freshMs() {
        return Math.max(5_000, this.config.pollMs - 5_000);
    }
    notify() {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            }
            catch {
                // 订阅者抛错不影响其他订阅者。
            }
        }
    }
    applyPayload(payload, fetchedAt) {
        const parsed = parseBalance(payload, fetchedAt);
        if (parsed === undefined)
            return;
        this.snapshot = { ...parsed, stale: Date.now() - fetchedAt > this.freshMs() };
        this.reason = '';
        this.notify();
    }
    async poll() {
        if (this.polling || this.key === undefined || !this.config.enabled)
            return;
        const now = Date.now();
        if (now < this.nextAllowedAt)
            return;
        const cached = await this.readCache();
        if (cached !== undefined && now - cached.fetchedAt < this.freshMs()) {
            this.applyPayload(cached.payload, cached.fetchedAt);
            return;
        }
        if (!(await this.acquireLease())) {
            // 另一个实例正在拉；过几秒读它的缓存，而不是等到下一个 60s。
            this.scheduleBootRetry();
            return;
        }
        this.polling = true;
        try {
            const response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/+$/, '')}/api/balance`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.key}`,
                    Accept: 'application/json',
                    'User-Agent': 'dsh-deepseek-cost/0.5',
                },
                signal: AbortSignal.timeout(this.config.timeoutMs),
            });
            if (!response.ok) {
                await this.handleHttpError(response);
                return;
            }
            const payload = await response.json();
            const parsed = parseBalance(payload);
            if (parsed === undefined) {
                this.reason = '配额响应形状无法识别';
                this.markStale();
                return;
            }
            await this.writeCache(payload, parsed.fetchedAt);
            this.snapshot = parsed;
            this.reason = '';
            this.nextAllowedAt = 0;
            this.notify();
        }
        catch {
            this.reason = '配额接口不可用（网络/代理）';
            this.markStale();
        }
        finally {
            this.polling = false;
            await this.releaseLease();
        }
    }
    async handleHttpError(response) {
        if (response.status === 429) {
            const retryAfter = Number(response.headers.get('retry-after'));
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(15 * 60_000, retryAfter * 1000)
                : 60_000;
            this.nextAllowedAt = Date.now() + waitMs;
            this.reason = '配额接口限流，稍后再试';
        }
        else if (response.status === 401 || response.status === 403) {
            this.nextAllowedAt = Date.now() + 5 * 60_000;
            this.reason = 'Ollama API key 无权限读取配额';
        }
        else {
            this.nextAllowedAt = Date.now() + 2 * 60_000;
            this.reason = `配额接口返回 ${String(response.status)}`;
        }
        this.markStale();
    }
    /** 失败时保留旧值，只标 stale；这样面板不会突然空一块。 */
    markStale() {
        if (this.snapshot !== undefined) {
            this.snapshot = { ...this.snapshot, stale: true, error: this.reason };
        }
        this.notify();
    }
    scheduleBootRetry() {
        if (this.snapshot !== undefined || this.bootAttempt >= 8 || this.bootTimer !== undefined)
            return;
        this.bootAttempt += 1;
        this.bootTimer = setTimeout(() => {
            this.bootTimer = undefined;
            void this.poll();
        }, 4_000);
        this.bootTimer.unref?.();
    }
    async readCache() {
        try {
            const raw = await readFile(this.cachePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!isRecord(parsed))
                return undefined;
            const fetchedAt = finiteNumber(parsed['fetchedAt']);
            if (fetchedAt === undefined)
                return undefined;
            return { fetchedAt, payload: parsed['payload'] };
        }
        catch {
            return undefined;
        }
    }
    async writeCache(payload, fetchedAt) {
        try {
            await mkdir(this.dir, { recursive: true, mode: 0o700 });
            const tmp = `${this.cachePath}.${process.pid.toString(36)}.tmp`;
            await writeFile(tmp, JSON.stringify({ fetchedAt, payload }), { mode: 0o600 });
            await rename(tmp, this.cachePath);
        }
        catch {
            // 缓存写失败不影响本次展示。
        }
    }
    async acquireLease() {
        const now = Date.now();
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const handle = await open(this.leasePath, 'wx', 0o600);
                try {
                    await handle.writeFile(JSON.stringify({ pid: process.pid, until: now + LEASE_MS }));
                }
                finally {
                    await handle.close();
                }
                return true;
            }
            catch {
                try {
                    const raw = await readFile(this.leasePath, 'utf8');
                    const parsed = JSON.parse(raw);
                    const until = isRecord(parsed) ? finiteNumber(parsed['until']) : undefined;
                    if (until !== undefined && until > now)
                        return false;
                    await unlink(this.leasePath);
                }
                catch {
                    // 租约文件刚被释放/损坏：重试一次。
                }
            }
        }
        return false;
    }
    async releaseLease() {
        try {
            const raw = await readFile(this.leasePath, 'utf8');
            const parsed = JSON.parse(raw);
            const pid = isRecord(parsed) ? finiteNumber(parsed['pid']) : undefined;
            if (pid === process.pid)
                await unlink(this.leasePath);
        }
        catch {
            // 不是自己的/已经没了，忽略。
        }
    }
}
