# 本机多端共享

本机网页、Codex 和 Claude Code 可读取同一份 DSH-Memory 数据。所有客户端按工作目录绑定项目；MCP 只提供检索，明确保存由真实用户输入钩子或网页确认触发。

## 启动网页

从终端运行 Node.js 22.19 或更新版本，并把 `--root` 指向已有的 DSH-Memory 数据目录（其中包含 `data-owner.json`）：

```sh
node /path/to/dsh-memory/local-server.js start --root "/path/to/dsh-memory-data"
node /path/to/dsh-memory/local-server.js status --root "/path/to/dsh-memory-data"
node /path/to/dsh-memory/local-server.js stop --root "/path/to/dsh-memory-data"
```

也可以设置 `DSH_MEMORY_ROOT` 后省略 `--root`。从 **DSH 设置 → 记忆 → 设置 → 备份与迁移 → 本机共享记忆** 可启动网页或停止服务。服务只监听 `127.0.0.1`。启动地址带有本机访问令牌，请仅在本机使用。

命令行里的 `node` 必须是独立 Node 可执行文件。DSH 的设置按钮会优先使用应用 `Resources/runtime/primary-runtime/dependencies/node/bin/node` 中的独立运行时，不会把 Electron/DSH 主程序当作 Node 启动。

## 生成客户端配置

对每个需要使用记忆的项目，运行：

```sh
node /path/to/dsh-memory/local-server.js print-config \
  --root "/path/to/dsh-memory-data" \
  --project "/path/to/project"
```

输出的 `claudeMcpJson`、`claudeHooksJson`、`codexConfigToml` 和 `codexHooksJson` 可分别复制到对应客户端配置。MCP 绑定到指定项目；每个项目应使用自己的 MCP 配置。Claude 和 Codex 的事件钩子从真实事件 `cwd` 推导项目，不读取助手或工具输出作为用户原话。

### Claude Code

将 `claudeMcpJson.mcpServers` 的 `dsh_memory` 条目加到 Claude Code 的 MCP 配置。在终端也可使用 Claude Code 自己写入本地配置：

```sh
claude mcp add dsh_memory --scope local --transport stdio -- \
  "/absolute/path/to/node" \
  "/absolute/path/to/dsh-memory/local-server.js" mcp \
  --root "/path/to/dsh-memory-data" --project "/path/to/project"
```

把 `claudeHooksJson.hooks` 合并进该项目的 `.claude/settings.local.json`。其中 `UserPromptSubmit` 会将用户问题的历史证据作为上下文；`Stop` 记录本轮助手回答的逐项覆盖情况。`claude-hook` 命令不需要先启动网页服务。

### Codex

将 `codexConfigToml` 的内容合并进 `config.toml` 中，并把 `codexHooksJson` 写入受信项目的 `.codex/hooks.json`。项目钩子在该项目的 `.codex/hooks.json` 中配置。Codex 会要求审阅并信任新钩子：CLI 使用 `/hooks`；桌面应用选择 **Review hooks** 或打开 **Settings → Hooks**。不要绕过钩子信任流程。

Codex `UserPromptSubmit` 使用 `prompt` 和 `turn_id`，`Stop` 使用 `last_assistant_message` 和同一 `turn_id`。这样单独发送「记住」时只会绑定同一会话上一条真实用户输入。

## 保存与遗忘

- MCP 工具 `memory_search`、`memory_project_brief`、`memory_core_rules` 和 `memory_recent_reports` 只读。
- 只有来自客户端钩子的实际用户事件，或网页中明确确认的保存操作，才会写入。MCP 参数不能指定来源、其他项目或遗忘对象。
- 网页中的“遗忘”需要确认，并通过当前项目校验来源和撤回权限。遗忘原文会同时撤回同来源的派生记录和召回报告。
- 停止网页服务不会关闭 MCP stdio 服务；从 Claude Code 的 `/mcp` 或 Codex MCP 设置中禁用或删除条目，可停止该客户端接入。

## 协议参考

- [Codex hooks](https://learn.chatgpt.com/docs/hooks) · [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=desktop)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks) · [Claude Code MCP](https://code.claude.com/docs/en/mcp)
