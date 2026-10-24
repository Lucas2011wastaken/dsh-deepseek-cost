# Security

## 凭据

- 插件只读取 Ollama 配额所需的 API key：优先 `process.env` 的
  `OLLAMA_PRO_API_KEY` / `OLLAMA_API_KEY`，其次 `~/.dsh/.credentials.yaml`
  的 `refs.<NAME>`。
- key 只存在于进程内存；**不会**写入日志、事件台账、`quota.json` 或任何仓库文件。
- 事件台账只记录：时间、会话 id、provider、模型名、token 计数、峰/谷标记；
  不含 prompt、回复正文或凭据。

## 网络

- 唯一的外呼是 `GET https://ollama.com/api/balance`（Bearer 鉴权），用于读取
  配额。可用 `quota.enabled: false` 完全关闭。
- 不经过宿主的 `ctx.web.fetch`（该接口不支持自定义 Bearer 头），因此这是插件
  直接发起的 HTTPS 请求；如果你在代理环境，需确保进程能直连 `ollama.com`。

## 数据文件

- `~/.dsh-tui/deepseek-cost/` 下：目录 0700，事件/缓存/标记文件 0600。
- 多实例共享台账是 append-only 日志；每个进程只写自己的
  `instances/<pid>-<start>-<rand>.jsonl`。

## 报告问题

请勿在 issue 中粘贴 API key、完整凭据文件或未脱敏的会话内容。需要贴日志时，
先把 key、session id、路径中的用户名替换掉。
