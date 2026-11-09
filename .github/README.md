<div align="center">

<h1>DSH Memory · 本地长期记忆</h1>

<p><img src="../docs/images/overview.svg" alt="Memory Native 功能示意" width="100%"></p>

<p>把值得记住的内容留在本地，在需要时带回对话。</p>

<p>
  <a href="https://github.com/Missher12/Missher-DSH-Memory-Native/releases/tag/v1.3.8-native.20261107.0"><img src="https://img.shields.io/badge/%E9%A2%84%E5%8F%91%E8%A1%8C-1.3.8--native.20261107.0-4D6BFE?style=flat-square" alt="原生预发行版: 1.3.8-native.20261107.0"></a>
  <a href="https://github.com/Missher12/Missher-DSH-Memory-Native"><img src="https://img.shields.io/badge/%E6%96%87%E6%A1%A3-%E4%B8%AD%E6%96%87-4D6BFE?style=flat-square" alt="文档: 中文"></a>
</p>

<p><a href="#功能一览">功能一览</a> · <a href="#快速开始">快速开始</a> · <a href="#使用场景">使用场景</a> · <a href="#常见问题">常见问题</a> · <a href="#详细文档">详细文档</a></p>

</div>

---

<!-- current-source -->
当前开发源码：**1.3.8-native.20261107.0** · [分支 `codex/memory-evidence-navigation`](https://github.com/Missher12/Missher-DSH-Memory-Native/tree/codex/memory-evidence-navigation)。[同版预发行安装包](https://github.com/Missher12/Missher-DSH-Memory-Native/releases/tag/v1.3.8-native.20261107.0)。
<!-- /current-source -->

## 功能一览

| 能做什么 | 说明 |
| --- | --- |
| **自动记忆** | 从允许采集的对话中提取事实、偏好、决策与经验。 |
| **相关召回** | 依据当前问题查找记忆，在有限预算内注入上下文。 |
| **可视化管理** | 搜索、编辑、批准、归档、遗忘，并查看历史与来源。 |
| **知识与 Obsidian** | 把记忆提升为 Markdown 笔记，管理关联与双向同步。 |

## 快速开始

1. 从 [Releases](https://github.com/Missher12/Missher-DSH-Memory-Native/releases/tag/v1.3.8-native.20261107.0) 下载对应版本的 `.tgz` 安装包。
2. 在 DSH **插件 → 添加插件** 中选择下载的文件，安装并启用；按宿主提示重新加载或正常重启。
3. 打开 **设置 → 记忆**，检查自动捕获与注入设置，再浏览已有记忆。

## 使用前了解

- 自动提炼可能调用配置的模型并产生费用；记忆以本地 JSONL 为权威数据，派生索引可重建。
- 项目记忆与全局记忆分开召回；与旧 Memory TDAI 数据不互通，避免同时启用造成重复注入。


<!-- readme-expansion -->
## 使用场景

| 遇到的情况 | 怎样使用 |
| --- | --- |
| 同一个项目换了会话，还需要反复交代背景 | 保存项目事实、偏好和已确认决定，并在相关问题中按范围查找。 |
| 一个事实后来发生变化，需要知道现在和过去各是什么 | 保留来源与历史变化，区分当前事实、旧决定和指定时间的答案。 |
| 想把长期有用的内容整理成自己能管理的资料 | 通过活动、记忆、项目档案、知识和设置入口查看进度、编辑内容与管理知识笔记。 |

## 工作方式

```mermaid
flowchart LR
    A["允许采集的项目对话"] --> B["按来源与预算提炼"]
    B --> C["本地记忆与知识"]
    C --> D["相关问题按范围召回"]
    C --> E["查看来源、编辑与遗忘"]
```

## 第一次使用

1. 在“设置 → 记忆”检查捕获、回答时参考记忆和每日调用预算。
2. 在真实项目中记录一条明确偏好或决定，查看活动页的处理状态与来源。
3. 新开同一项目的会话提出相关问题，再到记忆或项目档案中核对召回依据；错误内容可编辑、归档或遗忘。

### 一个具体例子

“以后在这个项目中优先使用中文说明，代码标识保留英文。”之后可以在同一项目的新会话中核对这条偏好。一次性要求、引用和模型推测需要与长期事实分开判断。

## 常见问题

<details>
<summary>它和 Memory TDAI、独立 Obsidian Memory 是同一个插件吗？</summary>

不是。本仓库维护当前的 Memory Native，包名是 @missher/dsh-memory。旧插件的数据格式和运行方式不因此自动互通。

</details>

<details>
<summary>它和 MSE Learning 有什么区别？</summary>

Memory 侧重事实、偏好、决定、来源和知识；MSE 侧重长期纠正及具体失败经验。二者职责不同，开启其中一个不等于另一个的数据已经迁入。

</details>

<details>
<summary>记忆会立即自动生效吗？</summary>

后台提炼受到来源许可、预算、模型返回和处理状态影响。请在活动页区分待处理、完成、部分完成和未知状态；结果未知的付费任务不会自动重发。

</details>

<details>
<summary>知识笔记能和 Obsidian 配合吗？</summary>

可在支持的设置中指定 vault 和同步文件夹，按当前开发版说明启用同步。仅处理指定的 DSH 目录，冲突需要检查，不把整个个人 vault 当作无差别同步目标。

</details>

## 搭配使用

配合 [MSE Learning](https://github.com/Missher12/Missher-MSE-Learning) 积累工作经验，配合 [Context Manager](https://github.com/Missher12/Missher-DSH-Context-Manager) 整理当前长会话。项目与全局记忆的作用范围仍需分别管理。

## 升级与数据

当前原生预发行版为 1.3.8-native.20261107.0，维护源码位于 codex/memory-evidence-navigation；main 保留稳定版本源码及首页说明。JSONL 是权威记录，派生索引可重建；升级不能通过删除记忆库来替代迁移。
<!-- /readme-expansion -->

## 详细文档

[当前开发版说明](https://github.com/Missher12/Missher-DSH-Memory-Native/blob/codex/memory-evidence-navigation/README.md) · [设计说明](../docs/design.md) · [验证记录](../docs/verification.md) · [相关方案调研](../docs/memory-landscape.md)

原有功能细节、配置、截图与验证记录保留在上述文档中，历史结论按其注明的版本理解。
