#!/bin/sh
# 开发期把类型依赖链进本包（插件运行时**不需要**它们，只有 tsc 需要）：
#   - @deepseek-ai/cordis        Context / Events 类型
#   - @deepseek-ai/dsh-agent     `session/event` 的 cordis 事件声明（type-only import 触发）
#   - @types/node                node:fs / node:path 等
#   - @deepseek-harness-tui/dsh-tui  /api 子路径的接缝类型
#
# 源目录默认取全局 dsh 安装与用户 profile；都可以用环境变量覆盖。
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
dsh_pkg=${DSH_COST_DSH_PKG:-$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules}
profile_nm=${DSH_COST_PROFILE_NM:-$HOME/.dsh/profiles/dsh-tui/node_modules}

mkdir -p "$here/node_modules/@deepseek-ai" "$here/node_modules/@deepseek-harness-tui" "$here/node_modules/@types"
for pkg in cordis dsh-agent dsh-session dsh-llm schemastery; do
  [ -d "$dsh_pkg/@deepseek-ai/$pkg" ] && ln -sfn "$dsh_pkg/@deepseek-ai/$pkg" "$here/node_modules/@deepseek-ai/$pkg"
done
[ -d "$dsh_pkg/@types/node" ] && ln -sfn "$dsh_pkg/@types/node" "$here/node_modules/@types/node"
[ -d "$profile_nm/@deepseek-harness-tui/dsh-tui" ] && \
  ln -sfn "$profile_nm/@deepseek-harness-tui/dsh-tui" "$here/node_modules/@deepseek-harness-tui/dsh-tui"

echo "linked into $here/node_modules:"
ls -l "$here/node_modules/@deepseek-ai" "$here/node_modules/@types" "$here/node_modules/@deepseek-harness-tui" 2>/dev/null | sed 's/^/  /'
