# Obsidian DLC · 设计

> 2026-11-03 设计。目标：让 DSH Memory 与本地 Obsidian vault 双向同步，仍然零依赖、纯文件、可审计。

## 形态

- 不是 Obsidian 插件，而是 DSH Memory 的可选模块：只需在「记忆设置 → Obsidian」填 vault 路径与文件夹，点导出/导入。
- 一个记忆 = 一个 Markdown 文件，文件名 `<id>.md`；YAML frontmatter 保存结构化字段，正文保存 `content`。
- 导出与导入都幂等：导出按内容比较决定是否重写；导入按 frontmatter 的 `id` 更新已有记忆，不重复创建。

## 文件格式

```md
---
dsh_memory: true
id: mem_abc123
kind: fact
scope: project
projectKey: DSH-Memory-c9287021b1b1
status: active
topic: 存储
tags: ["jsonl", "memory"]
confidence: 0.9
importance: 0.7
revision: 3
createdAt: 2026-11-01T00:00:00.000Z
updatedAt: 2026-11-02T00:00:00.000Z
---

记忆正文。
```

- 只导出 `active` / `candidate` / `archived`，默认跳过 `deleted`。
- 导入只处理 `dsh_memory: true` 且 `id` 合法、`kind`/`scope` 合法的文件；缺字段走默认值，正文为内容。
- 不删除 vault 中的文件；vault 文件被删也不删除记忆（只报告跳过）。

## 设置

- `obsidian.vaultPath`：绝对路径，必须是已存在目录。
- `obsidian.folder`：vault 内子目录，默认 `DSH Memory`，拒绝 `..`、绝对路径和空值。
- 上次同步摘要写入 `~/.dsh/dsh-memory/obsidian-sync.json`，面板显示条数。

## 操作

- 导出：写入/更新 Markdown；返回 `written / skipped / dir`。
- 导入：解析 Markdown；返回 `imported / updated / skipped / preview`；默认 dry-run 由面板显式关闭。
- 所有写入使用临时文件 + rename；校验失败不落盘。

## 不做

- 不做 Obsidian 插件/API 依赖、不做实时文件监听（DLC 第一版手动同步）、不删除任何 vault 文件。


## 知识层（v0.8）

- 「提升为知识」把一条记忆写成 `~/.dsh/dsh-memory/knowledge/<id>.md`：frontmatter 标记 `dsh_knowledge: true`，正文是记忆内容，末尾带 `[[主题]]`。
- 知识图谱读取这些笔记，作为 note 节点与对应记忆连线。
- 这批笔记本身就是 Obsidian 兼容 Markdown，后续可直接同步到 vault；目前 Obsidian 导出/导入仍只处理记忆文件。
