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
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { addSlots, modelKey, splitModelKey, summarize, } from './ledger.js';
import { countsTotal, ZERO_COUNTS, ZERO_SLOTS } from './pricing.js';
/** 把 `~` 展开成 home；其余原样返回。 */
export function expandHome(path) {
    if (path === '~')
        return homedir();
    if (path.startsWith('~/'))
        return join(homedir(), path.slice(2));
    return path;
}
/** 事件 → 两槽。每笔事件只落峰或谷之一。 */
export function slotsOf(event) {
    return event.peak
        ? { peak: event.counts, idle: ZERO_COUNTS }
        : { peak: ZERO_COUNTS, idle: event.counts };
}
export function encodeEvent(event) {
    const wire = {
        t: event.t,
        ...(event.sid === '' ? {} : { sid: event.sid }),
        p: event.provider,
        m: event.model,
        ...(event.subagent ? { sub: 1 } : {}),
        pk: event.peak ? 1 : 0,
        i: event.counts.input,
        cr: event.counts.cacheRead,
        cw: event.counts.cacheWrite,
        o: event.counts.output,
    };
    return JSON.stringify(wire);
}
/** 解析一行；任何形状不对的字段一律丢弃。 */
export function decodeEvent(line) {
    let raw;
    try {
        raw = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    const record = raw;
    const num = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    const t = num(record['t']);
    const i = num(record['i']);
    const cr = num(record['cr']);
    const cw = num(record['cw']);
    const o = num(record['o']);
    const p = record['p'];
    const m = record['m'];
    const sid = record['sid'];
    const sub = record['sub'];
    const pk = record['pk'];
    if (t === undefined || i === undefined || cr === undefined || cw === undefined || o === undefined)
        return undefined;
    if (typeof p !== 'string' || p.trim() === '' || typeof m !== 'string' || m.trim() === '')
        return undefined;
    if (sid !== undefined && typeof sid !== 'string')
        return undefined;
    const counts = { input: i, cacheRead: cr, cacheWrite: cw, output: o };
    if (countsTotal(counts) <= 0)
        return undefined;
    return {
        t,
        sid: typeof sid === 'string' ? sid : '',
        provider: p,
        model: m,
        subagent: sub === 1 || sub === true,
        peak: pk === 1 || pk === true,
        counts,
    };
}
/** 解析完整文本里的所有完整行；最后一行没有换行符时忽略。 */
function decodeLines(text) {
    const out = [];
    for (const line of text.split('\n')) {
        if (line.trim() === '')
            continue;
        const event = decodeEvent(line);
        if (event !== undefined)
            out.push(event);
    }
    return out;
}
/**
 * 每进程的台账。只追加自己的文件，读取时合并所有实例文件。
 *
 * 线程模型：JS 单线程；`append()` 立即更新内存，磁盘写进 promise 队列，
 * 不阻塞记账与面板。
 */
export class UsageLog {
    dir;
    instancesDir;
    instanceId;
    filePath;
    keepDays;
    persist;
    events = [];
    sessions = new Map();
    allByModel = {};
    lastMainSessionId = '';
    lastMainAt = Number.NEGATIVE_INFINITY;
    updatedAt = 0;
    instanceCount = 1;
    /** 别的实例文件：已消费字节数 / 已知大小。 */
    offsets = new Map();
    sizes = new Map();
    writeQueue = Promise.resolve();
    /** 裁剪期间挡住新的追加，避免「读旧文件 → 新追加 → rename 覆盖」丢账。 */
    maintenance = Promise.resolve();
    refreshPromise;
    initialized = false;
    constructor(options) {
        this.dir = expandHome(options.dir);
        this.instancesDir = join(this.dir, 'instances');
        this.keepDays = options.keepDays > 0 ? options.keepDays : 45;
        this.persist = options.persist;
        this.instanceId = `${process.pid.toString(36)}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
        this.filePath = join(this.instancesDir, `${this.instanceId}.jsonl`);
    }
    /** 建目录、载入现有事件、裁剪旧数据。幂等。 */
    async init() {
        if (this.initialized)
            return;
        this.initialized = true;
        if (!this.persist)
            return;
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        await mkdir(this.instancesDir, { recursive: true, mode: 0o700 });
        await this.refresh();
        await this.pruneOwn();
        await this.pruneDead();
    }
    /** 内存里的当前快照（调用方不应修改）。 */
    get lastUpdatedAt() {
        return this.updatedAt;
    }
    get instances() {
        return this.instanceCount;
    }
    get lastMain() {
        return this.lastMainSessionId;
    }
    /** 追加一笔用量：先更新内存，再排队落盘。 */
    append(event) {
        if (!this.addEvent(event))
            return;
        if (!this.persist)
            return;
        const line = `${encodeEvent(event)}\n`;
        // 捕获当前的 maintenance gate：已经排队的追加不会被后来启动的裁剪挡住，
        // 裁剪期间新来的追加会等裁剪结束再写，避免被 rename 覆盖。
        const gate = this.maintenance;
        this.writeQueue = this.writeQueue
            .then(async () => {
            await gate;
            // 首次 append 可能早于 init() 的 mkdir；这里兜一层。
            await mkdir(this.instancesDir, { recursive: true, mode: 0o700 });
            await appendFile(this.filePath, line, { mode: 0o600 });
        })
            .catch(() => {
            // 落盘失败只影响跨进程/重启可见性，不影响当前进程的展示。
        });
    }
    /** 把排队中的写盘等完（卸载/迁移前用）。 */
    async flush() {
        await this.writeQueue;
    }
    /** 增量读取其他实例；有新事件返回 true。 */
    async refresh() {
        if (!this.persist)
            return false;
        if (this.refreshPromise !== undefined)
            return this.refreshPromise;
        this.refreshPromise = this.doRefresh().finally(() => {
            this.refreshPromise = undefined;
        });
        return this.refreshPromise;
    }
    async doRefresh() {
        let entries;
        try {
            entries = await readdir(this.instancesDir, { withFileTypes: true });
        }
        catch {
            return false;
        }
        const files = entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
            .map(entry => join(this.instancesDir, entry.name))
            .sort();
        const own = this.filePath;
        const instanceFiles = files.filter(file => basename(file) !== 'legacy.jsonl');
        // 当前进程也算一个实例；自己的文件可能还没创建。
        this.instanceCount = new Set([...instanceFiles, own]).size;
        let added = false;
        let truncated = false;
        for (const file of files) {
            if (file === own)
                continue;
            let info;
            try {
                info = await stat(file);
            }
            catch {
                continue;
            }
            const previousSize = this.sizes.get(file) ?? 0;
            if (info.size === previousSize)
                continue;
            if (info.size < previousSize) {
                truncated = true;
                break;
            }
            let buffer;
            try {
                buffer = await readFile(file);
            }
            catch {
                continue;
            }
            const offset = this.offsets.get(file) ?? 0;
            if (offset > buffer.length) {
                truncated = true;
                break;
            }
            const chunk = buffer.subarray(offset);
            const lastNewline = chunk.lastIndexOf(0x0a);
            if (lastNewline === -1) {
                // 只有半行：保留 offset，等下次补齐。
                continue;
            }
            const text = chunk.subarray(0, lastNewline).toString('utf8');
            for (const event of decodeLines(text)) {
                if (this.addEvent(event))
                    added = true;
            }
            this.offsets.set(file, offset + lastNewline + 1);
            this.sizes.set(file, buffer.length);
        }
        if (truncated) {
            await this.rebuild(files);
            return true;
        }
        return added;
    }
    /** 有文件被截断/替换时整体重建一次。 */
    async rebuild(files) {
        await this.flush();
        this.events = [];
        this.sessions.clear();
        this.allByModel = {};
        this.lastMainSessionId = '';
        this.lastMainAt = Number.NEGATIVE_INFINITY;
        this.updatedAt = 0;
        this.offsets.clear();
        this.sizes.clear();
        for (const file of files) {
            let buffer;
            try {
                buffer = await readFile(file);
            }
            catch {
                continue;
            }
            const lastNewline = buffer.lastIndexOf(0x0a);
            if (lastNewline === -1)
                continue;
            const text = buffer.subarray(0, lastNewline).toString('utf8');
            for (const event of decodeLines(text))
                this.addEvent(event);
            this.offsets.set(file, lastNewline + 1);
            this.sizes.set(file, buffer.length);
        }
        this.instanceCount = new Set([
            ...files.filter(file => basename(file) !== 'legacy.jsonl'),
            this.filePath,
        ]).size;
    }
    /** 往内存索引里加一条；重复/非法事件返回 false。 */
    addEvent(event) {
        if (!Number.isFinite(event.t) || countsTotal(event.counts) <= 0)
            return false;
        // 按时间有序插入：绝大多数是追加，只有重建/乱序时才走二分插入。
        const last = this.events.at(-1);
        if (last === undefined || event.t >= last.t) {
            this.events.push(event);
        }
        else {
            let low = 0;
            let high = this.events.length;
            while (low < high) {
                const mid = (low + high) >>> 1;
                const probe = this.events[mid];
                if (probe !== undefined && probe.t <= event.t)
                    low = mid + 1;
                else
                    high = mid;
            }
            this.events.splice(low, 0, event);
        }
        const key = modelKey(event.provider, event.model);
        const slots = slotsOf(event);
        this.allByModel[key] = addSlots(this.allByModel[key] ?? ZERO_SLOTS, slots);
        const sid = event.sid;
        let state = this.sessions.get(sid);
        if (state === undefined) {
            state = {
                id: sid,
                provider: event.provider,
                model: event.model,
                subagent: event.subagent,
                lastEvent: undefined,
                byModel: {},
            };
            this.sessions.set(sid, state);
        }
        state.byModel[key] = addSlots(state.byModel[key] ?? ZERO_SLOTS, slots);
        if (state.lastEvent === undefined || event.t >= state.lastEvent.t) {
            state.lastEvent = event;
            state.provider = event.provider;
            state.model = event.model;
            state.subagent = event.subagent;
        }
        if (!event.subagent && event.t >= this.lastMainAt) {
            this.lastMainAt = event.t;
            this.lastMainSessionId = sid;
        }
        if (event.t > this.updatedAt)
            this.updatedAt = event.t;
        return true;
    }
    /** 某会话的汇总；未知会话返回空汇总。 */
    summaryOfSession(sid) {
        return summarize(this.sessions.get(sid)?.byModel ?? {});
    }
    /** 某时间窗的汇总；事件按时间有序，从尾部回扫并提前停。 */
    summaryOfWindow(from, to) {
        const first = this.events[0]?.t ?? Number.POSITIVE_INFINITY;
        if (from <= first && to >= this.updatedAt)
            return summarize(this.allByModel);
        const byModel = {};
        for (let index = this.events.length - 1; index >= 0; index -= 1) {
            const event = this.events[index];
            if (event === undefined)
                continue;
            if (event.t >= to)
                continue;
            if (event.t < from)
                break;
            const key = modelKey(event.provider, event.model);
            byModel[key] = addSlots(byModel[key] ?? ZERO_SLOTS, slotsOf(event));
        }
        return summarize(byModel);
    }
    /** 全部会话视图（不含旧台账迁移出来的空 id 会话）。 */
    sessionViews() {
        const out = {};
        for (const [sid, state] of this.sessions) {
            if (sid === '')
                continue;
            out[sid] = {
                id: sid,
                summary: summarize(state.byModel),
                subagent: state.subagent,
                provider: state.provider,
                model: state.model,
                lastAt: state.lastEvent?.t ?? 0,
            };
        }
        return out;
    }
    /** 裁剪自己的文件（只删自己，跨进程安全）。 */
    async pruneOwn() {
        if (!this.persist)
            return;
        // 必须在调用时同步捕获：之后的新追加会挂在新的 maintenance gate 上，
        // 不能把它们也等进来（否则 await 彼此，死锁）。
        const pending = this.writeQueue;
        const run = this.maintenance.then(async () => {
            await pending;
            let buffer;
            try {
                buffer = await readFile(this.filePath);
            }
            catch {
                return;
            }
            const cutoff = Date.now() - this.keepDays * 86_400_000;
            const kept = [];
            let dropped = false;
            for (const event of decodeLines(buffer.toString('utf8'))) {
                if (event.t >= cutoff)
                    kept.push(event);
                else
                    dropped = true;
            }
            if (!dropped)
                return;
            const tmp = `${this.filePath}.${process.pid.toString(36)}.tmp`;
            try {
                await writeFile(tmp, kept.map(encodeEvent).join('\n') + (kept.length > 0 ? '\n' : ''), { mode: 0o600 });
                await rename(tmp, this.filePath);
            }
            catch {
                // 裁剪失败不影响记账；下次再试。
            }
        });
        this.maintenance = run.catch(() => { });
        await this.maintenance;
    }
    /** 清掉超过保留期的死实例文件。 */
    async pruneDead() {
        if (!this.persist)
            return;
        let entries;
        try {
            entries = await readdir(this.instancesDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        const cutoff = Date.now() - (this.keepDays + 1) * 86_400_000;
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl'))
                continue;
            const file = join(this.instancesDir, entry.name);
            if (file === this.filePath)
                continue;
            try {
                const info = await stat(file);
                if (info.mtimeMs < cutoff)
                    await unlink(file);
            }
            catch {
                // 竞争删除/文件消失都算正常。
            }
        }
    }
}
/**
 * 把旧版按日台账迁移成事件文件（只做一次）。
 *
 * 每天、每个模型、峰/谷两个桶各合成一条「日初时刻」事件：金额完全精确
 * （桶本身保留），只有历史区间的边界按日近似。目标文件是确定性的，多个
 * 进程同时迁移也只会得到同一份内容（原子 rename），不会重复计数。
 */
export async function migrateLegacyDoc(doc, options) {
    const marker = join(options.dir, 'migrated.json');
    const target = join(options.instancesDir, 'legacy.jsonl');
    let targetExists = false;
    try {
        await stat(target);
        targetExists = true;
    }
    catch {
        targetExists = false;
    }
    const lines = [];
    if (!targetExists) {
        for (const [day, models] of Object.entries(doc.days)) {
            const t = Date.parse(`${day}T00:00:00+08:00`);
            if (!Number.isFinite(t))
                continue;
            for (const [key, slots] of Object.entries(models)) {
                const { provider, model } = splitModelKey(key);
                for (const peak of [true, false]) {
                    const counts = peak ? slots.peak : slots.idle;
                    if (countsTotal(counts) <= 0)
                        continue;
                    lines.push(encodeEvent({ t, sid: '', provider, model, subagent: false, peak, counts }));
                }
            }
        }
        if (lines.length > 0) {
            const tmp = `${target}.${process.pid.toString(36)}.tmp`;
            try {
                await writeFile(tmp, `${lines.join('\n')}\n`, { mode: 0o600 });
                await rename(tmp, target);
            }
            catch {
                // 另一个进程先完成了迁移；它的内容与这里等价。
            }
        }
    }
    try {
        await writeFile(marker, JSON.stringify({ migratedAt: Date.now(), events: lines.length, target: basename(target) }), { mode: 0o600 });
    }
    catch {
        // 标记写失败最多导致下次重复检查；目标文件已存在时不会重复写入。
    }
    return lines.length;
}
