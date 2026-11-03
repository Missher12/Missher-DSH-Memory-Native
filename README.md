# DSH Memory

本地优先的 DeepSeek Harness 长期记忆插件。自动捕获、按需注入、可视化管理——不依赖外部数据库或云服务。

[仓库](https://github.com/Missher12/Missher-DSH-Memory-Native) · [Releases 下载](https://github.com/Missher12/Missher-DSH-Memory-Native/releases) · [设计文档](docs/design.md) · [验证记录](docs/verification.md)

## 能做什么

- **自动记忆**：每个完成的 turn 结束后，后台用当前模型抽取事实 / 偏好 / 决策 / 经验，写入本地；长对话自动分块抽取，近重复语句合并为一条并提升置信度；值/否定冲突（如 Node 22 → 24）走 SUPERSEDE。
- **数据安全**：写入带跨进程锁与 fsync，压缩前锁内重读；坏行隔离到 `corrupt-lines.jsonl`；schema 版本可迁移、拒绝更新版本；支持导出/导入/备份。
- **越用越懂反馈**：面板批准候选 → 置信度 +0.1、重要度 +0.05；编辑内容 → 重要度 +0.05；固定 → 重要度拉到 0.9，直接影响后续召回排序。
- **自维护（自己掌控）**：启动后自动执行维护——按保留期归档低置信度旧片段（默认 90 天、不碰固定/高置信）、每天自动备份、只保留最近 7 份备份，结果写入 `maintenance.json`；可用 `maintenance.enabled` 关闭。
- **设置可写**：面板「记忆设置」卡可改自动捕获、上下文注入、注入预算、片段保留天数、自维护开关；写入 `settings.json`，即时生效、重启保留。
- **抗崩溃**：存储初始化/召回/捕获/定时器/panel 全部异常隔离；存储不可用时插件自动禁用而不是让 Host 报错；50k 规模可加载（构建 772ms、heap 290MB，查询偏慢待 v0.8 优化）。
- **八个一级标签**：记忆 / 用户画像 / 知识图谱 / 知识库 / 捕获与注入 / 保留与维护 / 数据 / Obsidian；知识库管理提升出的长期笔记并同步 Obsidian。
- **知识图谱（v0.8）**：面板「知识图谱」标签把记忆按主题渲染成星座图（主题为中心节点、共享标签为虚线），点击节点看详情，可一键「提升为知识」写成长期 Markdown 笔记。
- **知识库编辑（v0.10）**：知识库 tab 点任意笔记打开编辑器，可改标题 / 主题 / 标签 / 正文；保存原子写回 `knowledge/<id>.md`，保留 frontmatter 与 memoryId；文件被外部修改时提示重新加载，不静默覆盖。
- **Obsidian DLC**：设置里填 vault 路径与文件夹，一键把每条记忆导出为带 YAML frontmatter 的 `.md`；改完笔记可导入回记忆（按 id 更新，不重复、不删除）。
- **好管理（v0.7）**：回收站（恢复 / 彻底删除）、批量归档/删除/加标签（失败自动回滚）、版本历史与 diff、主题筛选与合并建议。
- **数据可搬运**：面板支持「导出 / 导入 / 立即备份」——导出为 JSON 下载，导入按 revision 去重合并并重建索引，备份写入 `backups/`。
- **省 token**：注入预算按命中数自适应（1/3/6 条 → 200/256/352，短续问 220），记忆行去掉 id/日期/置信度等元信息；抽取规则与 GUIDANCE 精简，每次最多 4 条、每条 ≤120 字、输出上限 400 token，截断时保留已写完的条目；面板「捕获与注入」显示近 7 天注入/抽取 token 趋势与超预算次数。典型单轮 token 估算从 4113 降到 2392（−42%）。
- **召回门控**：内容词 + 绝对 BM25 分段（S_bi、区分度、加权覆盖率，按 I1 随语料规模缩放）；「你好/好的/今天天气」以及「数据库迁移/翻译/灰度发布」等弱查询不再注入；灰区写入 `recall-gate.jsonl` 待模型判定；「继续/然后呢」等短续问自动使用上一条用户消息检索。
- **画像防误合并**：同 topic 也要求 bigram 相似度 ≥0.5；否定（不/不必）、反义（深/浅、可写/只读）与数字/版本冲突不合并。
- **越用越懂（v0.3）**：抽取时附带主题标签；偏好聚合成带证据的用户画像（面板可见、注入时优先）；episodic 90 天 / profile 60 天半衰期衰减；偏好与决策使用 0.85 灰区合并。
- **按需注入**：每步推理前用当前用户消息检索（BM25 + 时间 + 重要度 + 置信度），把一小段 `<memory-context>` 注入上下文，默认 600 token 上限。
- **本地可读**：权威数据是 `~/.dsh/dsh-memory/**/memories.jsonl` 明文，可直接查看、备份、删除；索引是内存派生数据，可随时重建。
- **可管理**：Settings → 记忆 面板支持查看、搜索、编辑、审批、归档、删除（M4）。
- **可控成本**：每日抽取调用上限、单次输出上限、注入预算都可配，也可一键关闭捕获或注入。

## 记忆模型

四类 × 双作用域：

| kind | 含义 | 默认作用域 |
|---|---|---|
| `preference` | 用户偏好、习惯、沟通方式 | global |
| `fact` | 项目/技术事实、约束 | project |
| `decision` | 已做出的选择及理由 | project |
| `episode` | 一次任务经历中的可复用教训 | project |

记录带 `confidence`、`importance`、`observedAt` / `validFrom` / `validTo`、`revision`、`supersedesId`，支持冲突替换和墓碑删除。

## 存储布局

```
~/.dsh/dsh-memory/
├── meta.json
├── usage.jsonl            # 注入/抽取 token 遥测（有界，可删）
├── global/memories.jsonl
└── projects/<projectKey>/memories.jsonl
```

- 每行一条完整的 revision 快照；加载时按 id 取 revision 最大者。
- `projectKey` = 工作目录 basename + 绝对路径哈希，避免同名项目冲突。
- 单文件超过 2000 行或 4MB 时压缩（保留最新 revision，临时文件 + 原子 rename）。

## 配置

`cordis.patch.yml` 里按需覆盖：

```yaml
- insert:
    - id: dsh-memory
      name: '@missher/dsh-memory'
      config:
        capture:
          enabled: true
          minTurnChars: 200
          maxCallsPerDay: 50
          autoApproveConfidence: 0.75
        extraction:
          provider: null        # null = 跟随当前会话模型
          model: null
          maxOutputTokens: 800
        inject:
          enabled: true
          maxTokens: 600
          maxItems: 12
          minScore: 0.15
        retention:
          episodeDays: 90
```

## 安装

从 [Releases](https://github.com/Missher12/Missher-DSH-Memory-Native/releases) 下载 `missher-dsh-memory-0.1.0.tgz`，在 DSH 的「插件 → 添加插件」中选择该文件；也可以执行：

```bash
dsh plugin --profile <profile> add /absolute/path/to/missher-dsh-memory-0.1.0.tgz
```

安装后刷新页面，「设置 → 记忆」出现记忆面板即生效。开发时也可用 linked 目录安装。

## 开发

```bash
# 单元测试（需要 Node ≥ 22.19）
node --test tests/*.test.js
```

安装到当前 profile 时可使用 linked 目录方式，通过 Harness 的 plugin_manager install_bundle 指定本目录绝对路径。

设计文档：[docs/design.md](docs/design.md)；行业调研：[docs/memory-landscape.md](docs/memory-landscape.md)；DSH API 侦察：[research/dsh-api-brief.md](research/dsh-api-brief.md)。

## 状态

- M1 存储 + 索引：完成（85 个单元测试通过）。
- M2 自动捕获：完成并实测——本会话已自动写入 14 条记忆（11 active / 3 candidate），含偏好、事实、决策、经历。
- M3 召回注入：完成并实测——`<memory-context>` 块已在真实会话中出现，且随步骤幂等刷新。
- M4 管理面板：完成——列表/统计/筛选/编辑/审批/归档/双确认删除/重建索引；Typert RPC 已通过真实网关自检（stats + list），浏览器端真实调用已确认（修复 `remove`/`removeMemory` 命名冲突后出现独立 stats 记录）；组件在夹具中验证了浅色/深色/窄宽/编辑弹窗/空态/错误态。
- M5 安装验收：bundle 已安装（application=applied）；重启后重新激活并自检通过；卸载→重装循环（Host 侧）已验证、数据保留；仅「卸载后浏览器槽位消失」待刷新确认。

## 面板预览

以下为 Settings → 记忆 组件的测试夹具渲染（非应用内截图，数据为模拟；真实页面使用宿主主题 token）：

| 列表 | 编辑弹窗 |
|---|---|
| ![列表](docs/images/panel-light.png) | ![编辑](docs/images/panel-edit.png) |

面板采用卡片分区：指标卡（大数字 + 捕获/注入状态）、记忆活动卡（每日/每周/累计、可换配色、悬浮提示、等宽洞察条）、**用户画像卡（偏好聚类 + 证据条数 + 置信度）**、筛选卡、类型页签（全部/偏好/事实/决策/片段 + 条数）、带分页（10/20/50 条每页）与类型色条的记忆卡片。

![记忆活动](docs/images/panel-light.png)

| 每周 | 配色菜单 |
|---|---|
| ![每周](docs/images/panel-weekly.png) | ![配色](docs/images/panel-palette.png) |

| 深色 | 错误态 |
|---|---|
| ![深色](docs/images/panel-dark.png) | ![错误](docs/images/panel-error.png) |

窄宽（430px，统计 4 列自适应）：![窄宽](docs/images/panel-narrow.png)

## 验证证据

完整记录见 [docs/verification.md](docs/verification.md)。

| 项目 | 结果 | 证据 |
|---|---|---|
| 单元测试 | 170/170 通过 | `node --test tests/*.test.js` |
| 自动捕获 | 17 条真实记忆（14 active / 3 candidate） | `~/.dsh/dsh-memory/**/memories.jsonl` |
| 上下文注入 | 真实轮次出现 `<memory-context>` 块 | 会话日志 |
| 面板 RPC | Typert 传输 + 网关自检 stats/list 通过 | `panel-transport.json`、`panel-calls.jsonl` |
| 面板渲染/交互 | 浅色/深色/540px/编辑保存/Esc 关闭/批准/双确认删除/空态/错误态 | `docs/images/panel-*.png`（夹具渲染） |
| Token 遥测 | 近 7 天注入/抽取趋势、平均注入、超预算计数 | `~/.dsh/dsh-memory/usage.jsonl`；`docs/demo/v09-token-trend.png` |
| 知识笔记编辑 | 打开/编辑/保存/冲突检测/重新加载，735 与 430 无溢出 | `docs/demo/v10-knowledge-editor.png`、`docs/demo/v10-knowledge-list.png` |
| 召回性能 | 5000 条：建索引 114ms，中位 4.69ms，p95 8.91ms | `node scripts/bench-recall.mjs` |

待验证：浏览器端首次 list 调用（刷新页面后在 `panel-calls.jsonl` 出现），以及重启/卸载验收。

## 诊断文件

- `~/.dsh/dsh-memory/panel-transport.json`：面板传输方式（typert / web-server）与网关自检结果。
- `~/.dsh/dsh-memory/panel-calls.jsonl`：面板 RPC 调用日志。客户端激活时会做一次只读 `stats` 预热调用，
  所以**刷新页面**就会出现一条浏览器来源的 `stats`；打开「设置 → 记忆」还会追加 `list`。

## 限制（v1）

- 无向量/图检索；中文靠 CJK bigram，纯 JS 实现。
- 自动整理（合并/衰减）默认关闭，只有手动删除/归档。
- 不跨设备同步，不做多用户/多 Agent 权限治理。
- 与 @missher/dsh-memory-tdai 数据不互通；两者同时启用会造成重复注入，建议只启用一个。
