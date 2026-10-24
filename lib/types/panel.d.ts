/**
 * 侧栏台账面板（接缝：`ctx.tuiPanels`）。
 *
 * 布局：
 *  - 顶部：provider + 当前峰/谷；
 *  - 主卡：当前活跃会话（`host.snapshot().sessionId`）的官价 + 输入/缓存读/输出；
 *  - 配额：Ollama `/api/balance` 的 5h / 周 / 付费月剩余量与重置倒计时；
 *  - 区间表：今日 / 本周 / 本月 / 累计（跨 TUI 实例汇总）；
 *  - 脚注：峰谷窗口与下一次切换、台账后端与实例数、未计价模型。
 *
 * 不再展示缓存命中率：内置底栏是「主会话最后一次请求」，这里的任何累计口径
 * 都会和它不一致，混在一起只会让人困惑。
 *
 * 四条纪律：
 *  1. hook 必须用 props 注入的宿主 React（`props.React`），不能 import 自己的；
 *  2. 元素必须由宿主 React 产出 —— 本文件**不用 JSX**，一律
 *     `React.createElement`，因此编译产物里没有 jsx-runtime 依赖；
 *  3. 组件内唯一的定时源是 `ui.useAnimationTime`（宿主共享时钟，离屏自动暂停）；
 *  4. 数据更新仍走 `useSyncExternalStore` 订阅本插件自己的台账 store。
 */
import type { TuiPanelProps } from '@deepseek-harness-tui/dsh-tui/api';
import type { SessionView } from './events.js';
import type { MoneySummary } from './ledger.js';
import { type PeakRule } from './pricing.js';
import type { QuotaSnapshot } from './quota.js';
export interface PanelRangeView {
    readonly id: 'today' | 'week' | 'month' | 'all';
    readonly label: string;
    readonly summary: MoneySummary;
    readonly from: number;
    readonly to: number;
    /** 口径说明：`''` / `Ollama 周限` / `自然周` / `付费月` / `自然月`。 */
    readonly note: string;
}
export interface PanelSnapshotData {
    readonly providers: readonly string[];
    readonly sessions: Readonly<Record<string, SessionView>>;
    readonly lastMainSessionId: string;
    readonly ranges: readonly PanelRangeView[];
    readonly peakRule: PeakRule;
    readonly nowMs: number;
    readonly quota: QuotaSnapshot | undefined;
    readonly quotaReason: string;
    readonly storage: 'shared-log' | 'memory';
    readonly instances: number;
    readonly updatedAt: number;
    readonly note: string;
}
/** 面板订阅的只读 store；`get` 必须返回稳定引用（useSyncExternalStore 契约）。 */
export interface PanelStore {
    subscribe: (listener: () => void) => () => void;
    get: () => PanelSnapshotData;
}
/** 面板组件工厂：闭包持有 store，返回宿主可挂载的组件。 */
export declare function createLedgerPanel(store: PanelStore): (props: TuiPanelProps) => unknown;
