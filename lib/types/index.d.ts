/**
 * deepseek-cost —— 给 ollama-pro 上的 DeepSeek 模型套上 DeepSeek 官方计价系统。
 *
 * 为什么需要它：dsh-tui 内建的花费估算（`src/deepseekPricing.ts`）只对
 * `deepseek-official` 路由渲染，且价目表按前缀匹配、认不出 ollama 的
 * `deepseek-v4.1-flash` / `deepseek-v4-pro:0813`。本插件在**不改主包**的前提下，
 * 用官方价目给 ollama-pro 的用量记账，并把结果放回 TUI：
 *
 *  - 底栏字段：`ctx.tuiStatus.setField`（提示框下方那行，紧跟内建 model/cost；
 *    悬停给 token/金额明细，点击打开台账面板）；宿主没有这个加法时回退到
 *    `ctx.tuiStatus.set`（提示框上方一行）；
 *  - 侧栏台账：`ctx.tuiPanels`，本会话/今日/本周/本月/累计 × 输入/缓存读/输出 × 官价；
 *  - Ollama 配额：`GET /api/balance`（老套餐 session/weekly，新套餐 monthly period）。
 *
 * 多开：每进程一个 append-only JSONL（`instances/<id>.jsonl`），启动/定时增量
 * 读取其他实例的文件；「本会话」只算当前进程/当前会话，跨实例只汇总时间窗。
 *
 * 设计取舍：
 *  - **零运行时依赖**：没有 JSX、没有 YAML 库、没有 npm import。
 *  - 只读会话事件，不 append 到会话：不会让会话不可 resume。
 *  - 认不出的模型只报 token 不给金额（宁可不显示，不给错数）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
export declare const name = "deepseek-cost";
export { Config };
export type { CostConfig } from './config.js';
export declare function apply(ctx: Context, rawConfig?: unknown): void;
