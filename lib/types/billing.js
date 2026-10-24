/**
 * 本机付费月锚点的文件覆盖。
 *
 * 老套餐的 `/api/balance` 没有 monthly period；除了插件 config 的
 * `billing.anchor`，也支持在台账目录放一行 ISO 时间：
 *
 *   ~/.dsh-tui/deepseek-cost/billing-anchor
 *
 * 这样用户不必手改 profile 的 `cordis.patch.yml`；卸载插件时也不会留下
 * 指向不存在行的 profile 补丁。config 里的非空 `billing.anchor` 优先。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome } from './events.js';
export const BILLING_ANCHOR_FILE = 'billing-anchor';
/** 读取本地锚点文件；不存在/空/读失败都返回 ''，绝不抛错。 */
export function readBillingAnchorFile(dir) {
    try {
        const text = readFileSync(join(expandHome(dir), BILLING_ANCHOR_FILE), 'utf8');
        return text.split(/\r?\n/, 1)[0]?.trim() ?? '';
    }
    catch {
        return '';
    }
}
