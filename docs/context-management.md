# OpenClaw Context 管理机制

## 一、概述

OpenClaw (FirstClaw) 框架中，每次 LLM 请求的 context 由四个层次构成：

| 层次                | 内容                                                    | 特征                        |
| ------------------- | ------------------------------------------------------- | --------------------------- |
| **System Prompt**   | 框架指令、工具列表、安全规则等                          | 固定开销，按角色裁剪        |
| **Bootstrap Files** | SOUL.md, TOOLS.md, AGENTS.md 等用户编辑的项目上下文文件 | 半固定，按 session 类型过滤 |
| **消息注入**        | Chatroom context、消息正文                              | 每条消息附带，可增量化      |
| **历史累积**        | 工具调用/结果、assistant 回复、user 消息                | 持续增长，需要主动管理      |

框架通过 **6 道防线** 管理 context 预算：

```
① PromptMode 裁剪 → ② Bootstrap 过滤 → ③ 增量注入 → ④ 工具结果截断 → ⑤ Context Pruning → ⑥ Compaction + Overflow Recovery
```

---

## 二、防线详解

### 防线 ①：PromptMode — 按角色裁剪 System Prompt

`PromptMode` 控制 system prompt 中包含哪些 section：

| Mode         | 适用场景                              | 包含的 Section                                                             |
| ------------ | ------------------------------------- | -------------------------------------------------------------------------- |
| `"full"`     | 主 agent（人类直接交互）              | 全部 section                                                               |
| `"chatroom"` | Chatroom agent（orchestrator/worker） | Tooling, Safety, Workspace, Runtime, Skills, Context Files, **Heartbeats** |
| `"minimal"`  | Subagent（被主 agent 派生）           | Tooling, Workspace, Runtime                                                |
| `"none"`     | 极简模式                              | 仅一行身份声明                                                             |

**Chatroom 模式裁掉的 section**（节省约 1,000–1,200 tokens/请求）：

- Reply Tags、Messaging、Silent Replies、Self-Update、Model Aliases、CLI Quick Reference、Docs、Voice (TTS)

**Heartbeats 保留的原因**：框架层心跳机制要求 agent 识别心跳 poll 并回复 `HEARTBEAT_OK`。如果裁掉，agent 会把心跳当普通消息处理，触发不必要的 LLM 推理，反而浪费 token。

**检测机制**：通过 `isChatroomSessionKey()` 检测 sessionKey 是否以 `chatroom:` 开头（格式如 `agent:main:chatroom:direct:dm_xxx`），在 `attempt.ts` 和 `compact.ts` 中自动选择 promptMode。

### 防线 ②：Bootstrap 文件过滤

`filterBootstrapFilesForSession` 按 session 类型决定加载哪些项目上下文文件：

| Session 类型         | 允许的文件                                                                | 节省        |
| -------------------- | ------------------------------------------------------------------------- | ----------- |
| **Full**（主 agent） | 全部（SOUL, TOOLS, AGENTS, USER, BOOTSTRAP, MEMORY, HEARTBEAT, IDENTITY） | —           |
| **Chatroom**         | SOUL.md, TOOLS.md, AGENTS.md                                              | ~200–2,000t |
| **Subagent**         | AGENTS.md, TOOLS.md                                                       | 最大        |

Chatroom agent 不需要 USER.md（worker 的服务对象是 orchestrator，不是人类）、BOOTSTRAP.md、MEMORY.md（chatroom 有自己的 RAG 记忆方式）。

### 防线 ③：Chatroom Context 增量注入

**问题**：`buildOrchestratorContext()` (~1,500t) 和 `buildWorkerContext()` (~800t) 原本在每条消息中重复注入完整 context。10 轮对话 = 10 份重复 context。

**解决方案**：首次全量 + 后续增量。

- **首次消息**：注入完整 chatroom context（角色说明、协议规则、active tasks 等）
- **后续消息**：仅注入 delta（当前 channel、human approval 状态、active tasks 变化）
- **失效重置**：在 session reset、context overflow 重试、任务终态等场景下自动清除标记，下次消息重新注入全量

**节省**：后续每条消息 ~600–1,200 tokens。

### 防线 ④：工具结果截断 — 双层防护

**第一层：持久化时截断（session-tool-result-guard）**

在 tool result 写入 session 文件时，`capToolResultSize` 对超过 `HARD_MAX_TOOL_RESULT_CHARS`（默认 400,000 字符）的结果进行按比例截断，保留头尾并附加截断提示。

**第二层：LLM 调用前截断（tool-result-truncation）**

基于 context window 大小动态计算单个 tool result 的最大字符数：

```
maxChars = min(contextWindowTokens × maxShare × 4, hardMaxChars)
```

| 参数           | 默认值    | 可配置项                             |
| -------------- | --------- | ------------------------------------ |
| `maxShare`     | 0.3 (30%) | `agents.defaults.maxToolResultShare` |
| `hardMaxChars` | 400,000   | `agents.defaults.maxToolResultChars` |

**Chatroom 推荐配置**：`maxShare=0.15`, `maxToolResultChars=100000`。

### 防线 ⑤：Context Pruning — 基于 Cache TTL 的主动剪枝

当 Anthropic prompt caching 的 TTL 过期后，框架主动修剪老旧的 tool result。

**两级剪枝**：

| 级别          | 触发条件                                   | 行为                                                                |
| ------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| **softTrim**  | `totalChars / charWindow ≥ softTrimRatio`  | 保留 tool result 的头尾（headChars + tailChars），中间用 `...` 替代 |
| **hardClear** | `totalChars / charWindow ≥ hardClearRatio` | 整个 tool result 替换为 `[Old tool result content cleared]`         |

**保护规则**：

- 不修剪最后 `keepLastAssistants` 条 assistant 消息之后的 tool result
- 不修剪第一条 user 消息之前的内容
- 支持 tool allow/deny 配置

**默认值 vs Chatroom 推荐值**：

| 参数                 | 默认   | Chatroom |
| -------------------- | ------ | -------- |
| TTL                  | 5 分钟 | 2 分钟   |
| softTrimRatio        | 0.3    | 0.15     |
| hardClearRatio       | 0.5    | 0.3      |
| keepLastAssistants   | 3      | 2        |
| softTrim.maxChars    | 4,000  | 2,000    |
| softTrim.headChars   | 1,500  | 800      |
| softTrim.tailChars   | 1,500  | 800      |
| minPrunableToolChars | 50,000 | 30,000   |

### 防线 ⑥：Compaction + Overflow Recovery

**Compaction**（Pi 内置）：当历史过长时，Pi 自动将旧消息压缩为摘要。

**Compaction Safeguard**（可选增强模式）：

- 在 compaction 前检查历史是否超过 `maxHistoryShare`（默认 0.5）的 context window
- 超过时先 prune 最老的 chunk，用 `summarizeInStages` 生成摘要合并

**Overflow Recovery 流程**：

```
Context Overflow 检测
  → 自动 Compaction（最多 3 次）
    → 失败？Tool Result 截断
      → 失败？提示用户 /reset 或换更大 context 的模型
```

对于 Chatroom agent，overflow 会触发额外逻辑：

- 标记任务 `error_type: "CONTEXT_OVERFLOW"`
- 自动 reset session 并重试
- 清除 chatroom context 注入标记（下次重新全量注入）
- 超过最大重试次数后 ABANDON 任务并通知 orchestrator

---

## 三、整体数据流

```
用户/Chatroom 消息到达
  │
  ├─ ① PromptMode 选择 → 构建裁剪后的 System Prompt
  ├─ ② Bootstrap 过滤 → 只加载必要的 context files
  ├─ ③ 增量注入 → 首次全量 / 后续 delta
  │
  ▼
  组装 LLM 请求 (system prompt + context files + 历史 + 当前消息)
  │
  ├─ ④ 工具结果截断 → 持久化时 cap + LLM 调用前动态截断
  ├─ ⑤ Context Pruning → Cache TTL 过期后 softTrim / hardClear
  │
  ▼
  发送给 LLM
  │
  ├─ 成功 → 正常处理
  └─ Context Overflow → ⑥ Auto-compact → Tool truncation → Retry / Fail
```

---

## 四、配置参考

Chatroom agent 的推荐 `firstclaw.json` 配置：

```json
{
  "agents": {
    "defaults": {
      "maxToolResultShare": 0.15,
      "maxToolResultChars": 100000,
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "2m",
        "softTrimRatio": 0.15,
        "hardClearRatio": 0.3,
        "keepLastAssistants": 2,
        "softTrim": {
          "maxChars": 2000,
          "headChars": 800,
          "tailChars": 800
        }
      }
    }
  }
}
```

---

## 五、预期效果

| 优化项                | 节省 (per request) | 节省类型       |
| --------------------- | ------------------ | -------------- |
| PromptMode chatroom   | ~1,000–1,200t      | 固定           |
| Bootstrap 文件过滤    | ~200–2,000t        | 固定           |
| Chatroom context 增量 | ~600–1,200t        | 每轮节省       |
| Tool result 预防截断  | 视情况             | 防止爆炸性增长 |
| 更积极的 pruning      | 视情况             | 持续释放空间   |

**10 轮对话后的保守估计**：节省 ~15,000–25,000 tokens，为实际工作任务释放大量 context 预算。

所有优化均可通过 config 覆盖回退到原始行为，不影响非 chatroom 场景。
