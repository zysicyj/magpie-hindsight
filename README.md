# magpie-hindsight

[English](#english) · [中文](#中文) · Apache-2.0

> **衍生项目 / Derivative work**
>
> 本仓库来自 [Sam-dancing-nu1/magpie-hindsight](https://github.com/Sam-dancing-nu1/magpie-hindsight)（Apache-2.0），fork 于 `0c5327f`，原作者 **Sam-Dancing**。基础架构、设计思路与主体实现归原作者所有；本仓库只做缺陷修复与加固，差异见[与原版的差异](#与原版的差异--changes-from-the-original)。原始许可证见 [LICENSE](LICENSE)，归属声明见 [NOTICE](NOTICE)。
>
> This is a **fork** of [Sam-dancing-nu1/magpie-hindsight](https://github.com/Sam-dancing-nu1/magpie-hindsight) by **Sam-Dancing**, taken at commit `0c5327f` and hardened as described in [Changes from the original](#changes-from-the-original). Original work Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

<a id="english"></a>
## English

Automatic [Hindsight](https://github.com/vectorize-io/hindsight) memory for clients behind [Magpie](https://github.com/yetone/magpie), implemented as an **asynchronous gateway hook**.

Before each new user turn, the plugin recalls related memories once and attaches the block to that user message. The block is replayed unchanged through the turn's tool loop, so the provider prompt cache keeps working. After a completed answer, it can retain the current user/assistant turn. **Capture is disabled by default.**

```text
Agent client ──► Magpie + magpie-hindsight ──► model provider
                         │
                         └──────────────► Hindsight HTTP API
                                          recall / optional retain
```

### Why a gateway plugin?

Hindsight's official **Agent Plugins and tool integrations** run inside a specific agent and expose operations such as `recall_memory` and `retain_memory` as **explicit tools** for that agent to call. This Magpie plugin works at a different layer: Magpie automatically recalls before inference, without adding tools or changing each client. Optional capture also happens at the gateway.

Use one memory-injection path at a time. Hermes Agent and DeepSeek Harness already have native automatic Hindsight injection, so this plugin **skips them by default** even with an empty `agents` list — memory is never injected twice. Name them in `agents` to force-enable, or set an allow-list of agents that have no native integration.

### Requirements

- Magpie with asynchronous gateway hooks (`magpie.hooks`), v0.1.1273 or newer.
- Bun 1.3.8 or newer; Magpie can manage its plugin runtime.
- A Hindsight server exposing the `/v1/default/banks/{bank_id}/memories` API.
- Node.js 22 or newer only if you want to run this repository's tests.

### Install

```sh
magpie plugin add /path/to/magpie-hindsight   # from a source checkout
magpie plugin list
```

### Options

```sh
magpie plugin options magpie-hindsight '{
  "hindsight_api": "http://127.0.0.1:8888",
  "bank": "hermes",
  "recall_max_tokens": 1024,
  "capture": false,
  "agents": [],
  "gatewayTimeoutMs": 5000,
  "api_key": "",
  "api_key_header": "Authorization",
  "api_key_prefix": "Bearer ",
  "max_replay_blocks": 8
}'
```

| Option | Default | Meaning |
| --- | --- | --- |
| `hindsight_api` | `http://127.0.0.1:8888` | Hindsight HTTP API base URL. Do not append `/v1`; the plugin builds the full path. |
| `bank` | `hermes` | Existing Hindsight bank ID used for both recall and capture. |
| `recall_max_tokens` | `1024` | Token budget sent to Hindsight recall (`max_tokens`). Integer from 1 to 16384. |
| `capture` | `false` | Opt in to retaining the completed current turn. |
| `agents` | `[]` | Case-insensitive exact `ctx.agent` names to process. Empty = all agents **except** `hermes` / `dsh`. |
| `gatewayTimeoutMs` | `5000` | Magpie's timeout for this hook (100–10000 ms). The plugin reserves a slice of it so recall fails open cleanly. |
| `api_key` | `""` | Credential sent to Hindsight. Empty sends no auth header. Never logged. |
| `api_key_header` | `Authorization` | Header carrying the credential. Request-structure headers (`Host`, `Content-Type`, `Cookie`, …) are rejected. |
| `api_key_prefix` | `Bearer ` | Prepended to the key, so `Bearer ` + key by default. Clear it for APIs that want the bare key. **This option is not trimmed** — the trailing space is significant. |
| `max_replay_blocks` | `8` | How many historical memory blocks may stay attached to the resent conversation. `0` = unlimited. |
| `allowRemote` | `false` | Required when `hindsight_api` is not loopback: recall sends the latest user message (up to 8 KB) to that host. |
| `allowInsecureHttp` | `false` | Additionally required for plain `http://` to a non-loopback host. |

Three notes on the added options:

- `max_replay_blocks` bounds context growth. Every finished turn leaves its recalled block in the resent conversation (that is what keeps the prompt cache warm), so an unbounded conversation keeps paying for every past recall. Crossing the cap drops the **whole older tail at once** rather than one block per request: one cache miss every `max_replay_blocks` turns, byte-stable in between.
- `recall_max_tokens` is a real token budget. The wrapper estimates CJK code points at ~1 token and Latin text at ~4 characters per token, and a single memory may take at most 75% of the fact budget, so one oversized entry cannot starve the others.
- `api_key` covers a single static credential header. It does not do OAuth, mTLS or header rotation; for anything stronger put a local reverse proxy in front and point `hindsight_api` at it.

Restore runtime defaults:

```sh
magpie plugin options magpie-hindsight off
```

### Behavior

- Supported wire protocols: OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, and Gemini.
- Only host-classified local requests (`ctx.origin === "local"`) are processed.
- One recall per user turn: the query is `ctx.query` (client notices stripped by the host) or, when empty, the turn's text capped at 8192 characters, with Hindsight's `budget: "low"`. Tool-loop requests of the same turn reuse the cached block instead of recalling again.
- Memories are wrapped as untrusted historical evidence and appended to that turn's **user message**, never the system prompt, so the conversation prefix stays stable across tool-loop requests. They are not added as tools.
- An empty or failed recall leaves the model request unchanged. An Hindsight outage does not block inference.
- With `capture: true`, a successful final answer is retained with the latest user text as one item. The retain call uses `async: true`.
- Tool-call steps, failed requests, empty answers, and answers truncated by the output-token limit are not captured.
- The deterministic `document_id` includes the Magpie session and turn content. Metadata contains only source, agent name, and protocol.

### Cost, latency, and privacy

**Each new user turn adds one Hindsight recall request and its latency.** Recalled memories consume model input tokens; a turn's block is sticky across its tool loop, and earlier blocks are replayed only until `max_replay_blocks` is crossed.

Recall sends the latest user text (up to 8 KB) to the configured Hindsight server on every new turn. With capture enabled, the final assistant answer is also sent, and Hindsight performs memory extraction after completed turns, which can incur its own model usage. A non-loopback server requires `allowRemote: true`, and plain HTTP to it also requires `allowInsecureHttp: true`. The plugin adds only the one credential header you configure; it does not manage TLS. Keep capture off unless you want this data stored.

### Known limitations

- The plugin processes local Magpie callers only; there is no remote-caller opt-in.
- Capture stores the current user/assistant turn, not a whole conversation or tool transcript.
- Anthropic, Responses and Gemini paths are covered by mock unit tests only; Chat Completions is the only protocol verified end to end (by the original author — see below).
- Hindsight does not guarantee idempotency for this plugin's generated `document_id`; unusual retries can still create duplicates.
- Recalled text is marked untrusted, but no wrapper can make hostile memory content completely safe. Review bank contents and access controls.

### Development and verification

```sh
npm test     # 44 unit tests, no network
npm run check
```

What has actually been verified in **this fork**: the unit suite above, plus a live run of the loopback settings service against a stub Hindsight that requires `Bearer` auth (healthy → `{"ok":true,...}`, missing key → `unauthorized`, bad page token → `403`). The upstream author's end-to-end acceptance against a real Magpie gateway and a real `hermes` bank was **not** re-run here; treat that claim as inherited from the upstream repository, not as a re-verification.

### AI participation

This project was developed with AI assistance, including implementation, tests, and documentation. Runtime behavior must still be reviewed and verified in your own environment before handling sensitive conversations.

<a id="changes-from-the-original"></a>
### Changes from the original

Base: `Sam-dancing-nu1/magpie-hindsight@0c5327f`. Plugin name, option keys and the Magpie hook contract are unchanged, so an existing installation can switch between the two.

1. **Fixed: the settings page "test connection" always reported failure.** `page/service.mjs` passed a result object into a helper that expected a code string, so `ok` was always `false` and `code` was an object; `bank`/`ms` were dropped. Now a flat, typed envelope with proper status codes, plus a unit test for it.
2. **Fixed: conversation eviction was insertion-ordered.** `at` was maintained but never read, so a long-running session could be evicted while idle ones survived. Now genuinely least-recently-used with a monotonic clock.
3. **Fixed: recall timeout degenerated at small gateway budgets.** A fixed 200 ms reserve against `gatewayTimeoutMs = 100` left nothing to fail open with; the reserve now scales, and the 8 s ceiling that silently discarded a 10 s budget is gone.
4. **New: `max_replay_blocks`.** Bounds how much recalled memory stays in context, dropping in batches to keep the prompt cache stable in between.
5. **Changed: the recall budget is a token budget.** The old `maxTokens * 8` character cap was 2–4× looser than the `max_tokens` actually sent, and one huge entry could consume all of it. Now language-aware estimation, token-boundary truncation, and a 75% per-entry ceiling.
6. **New: `api_key` / `api_key_header` / `api_key_prefix`.** Recall, retain and the health probe share the same credential header; the settings page masks the value and never displays it in status output.

Everything else is the original work.

---

<a id="中文"></a>
## 中文

这是一个基于 **Magpie 异步网关 hooks** 的 [Hindsight](https://github.com/vectorize-io/hindsight) 记忆插件。

每个新的用户轮次，插件只召回一次相关记忆，并把记忆块附加到该轮用户消息上；同一轮的工具循环中注入保持逐字不变（sticky），模型提供方的 prompt cache 不会失效。收到完整回答后，可选地 retain 当前用户/助手轮次。**采集默认关闭。**

```text
Agent 客户端 ──► Magpie + magpie-hindsight ──► 模型提供方
                        │
                        └──────────────► Hindsight HTTP API
                                         召回 / 可选采集
```

### 与 Hindsight 官方 Agent Plugins 的区别

Hindsight 官方 **Agent Plugins 和工具集成**位于具体 Agent 内，通常把 `recall_memory`、`retain_memory` 等操作暴露为**显式工具调用**。本插件位于网关层：Magpie 在推理前自动召回，不需要给客户端增加工具，也不要求每个 Agent 单独接入；可选采集同样发生在网关层。

同一时间只走一条记忆注入链路。Hermes Agent 和 DeepSeek Harness 自带 Hindsight 自动注入，所以本插件**默认跳过它们**——即使 `agents` 为空也不会重复注入。

### 环境要求

- 支持异步网关 hooks（`magpie.hooks`）的 Magpie，v0.1.1273 或更新版本。
- Bun 1.3.8 或更新版本；插件运行时可由 Magpie 管理。
- 提供 `/v1/default/banks/{bank_id}/memories` API 的 Hindsight 服务。
- 仅在运行本仓库测试时需要 Node.js 22 或更新版本。

### 安装

```sh
magpie plugin add /path/to/magpie-hindsight   # 从源码目录安装
magpie plugin list
```

### 配置

```sh
magpie plugin options magpie-hindsight '{
  "hindsight_api": "http://127.0.0.1:8888",
  "bank": "hermes",
  "recall_max_tokens": 1024,
  "capture": false,
  "agents": [],
  "gatewayTimeoutMs": 5000,
  "api_key": "",
  "api_key_header": "Authorization",
  "api_key_prefix": "Bearer ",
  "max_replay_blocks": 8
}'
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `hindsight_api` | `http://127.0.0.1:8888` | Hindsight HTTP API 根地址。不要附加 `/v1`，插件会构造完整路径。 |
| `bank` | `hermes` | recall 和 capture 共用的现有 Hindsight bank ID。 |
| `recall_max_tokens` | `1024` | 发送给 Hindsight recall 的 token 预算，范围 1–16384。 |
| `capture` | `false` | 显式开启后才 retain 完整结束的当前轮次。 |
| `agents` | `[]` | 要处理的 `ctx.agent` 名称，大小写不敏感；空数组 = 全部 Agent，**但默认跳过** `hermes` / `dsh`。 |
| `gatewayTimeoutMs` | `5000` | Magpie 给本 hook 的超时（100–10000ms）。插件会预留一段余量，让召回干净地失败放行。 |
| `api_key` | `""` | 发给 Hindsight 的认证密钥；留空则不发送认证头，且永不写日志。 |
| `api_key_header` | `Authorization` | 承载密钥的请求头。`Host`、`Content-Type`、`Cookie` 等请求结构头不允许占用。 |
| `api_key_prefix` | `Bearer ` | 密钥前缀，默认拼成 `Bearer ` + 密钥。服务端只认裸密钥时清空。**该值不做 trim**，尾随空格有意义。 |
| `max_replay_blocks` | `8` | 多轮对话中最多保留几块历史召回记忆，`0` 表示不限。 |
| `allowRemote` | `false` | `hindsight_api` 非 loopback 时必须显式开启：recall 会把最新用户消息（最多 8KB）发往该主机。 |
| `allowInsecureHttp` | `false` | 非 loopback 且为纯 `http://` 时还需额外开启。 |

关于新增项的补充说明：

- `max_replay_blocks` 用来兜住上下文膨胀。每一轮的召回块都会随重发的对话一直留在上下文里（这正是 prompt cache 保持命中的原因），轮数多了就是线性付费。超过上限时**整段丢弃**而不是每轮滑一个，因此是「每 N 轮失效一次缓存」，中间的请求逐字稳定。
- `recall_max_tokens` 是真正的 token 预算：包装层把 CJK 码点按约 1 token、拉丁文本按约 4 字符/token 估算，单条记忆最多占事实预算的 75%，避免一条超长记忆把其余召回挤掉。
- `api_key` 只覆盖「一个静态认证头」。不做 OAuth、mTLS、密钥轮换；需要更强的鉴权就在本机放一层反向代理，把 `hindsight_api` 指向它。

清除已保存配置并恢复运行时默认值：

```sh
magpie plugin options magpie-hindsight off
```

### 工作方式

- 支持 OpenAI Chat Completions、Anthropic Messages、OpenAI Responses 和 Gemini 协议。
- 只处理宿主判定为本地的请求（`ctx.origin === "local"`）。
- 每个用户轮次只召回一次：查询优先用 `ctx.query`（宿主已剥离客户端环境通知），为空时取该轮文本，最多 8192 字符，并设置 Hindsight `budget: "low"`；同一轮的工具循环直接复用缓存块。
- 记忆作为不可信历史资料包裹后附加到该轮**用户消息**，不进入 system prompt。
- 召回为空或失败时保留原模型请求，Hindsight 故障不会阻断推理。
- `capture: true` 时，把最新用户文本和成功的最终助手回答作为一个 item retain；请求使用 `async: true`。
- 工具调用中间步、失败请求、空回答以及因输出 token 上限截断的回答不会采集。
- 确定性 `document_id` 包含 Magpie 会话和轮次内容的哈希；metadata 只包含来源、Agent 名称和协议。

### 成本、延迟与隐私

**每个新的用户轮次只增加一次 Hindsight recall 及其延迟。** 注入的记忆消耗模型输入 token；同一轮工具循环复用同一注入块，历史块只在 `max_replay_blocks` 以内继续重放。

recall 会把最新用户文本（最多 8KB）发送到所配置的 Hindsight 服务；开启 capture 后还会发送最终助手回答。非 loopback 服务必须显式 `allowRemote: true`，纯 HTTP 还需 `allowInsecureHttp: true`。插件只附加你自己配置的那一个认证头，不负责 TLS。不希望保存这些内容时保持 capture 关闭。

### 已知限制

- 仅处理 Magpie 本地调用方，没有开放远程调用方的开关。
- capture 只保存当前用户/助手轮次，不保存整段历史或工具调用记录。
- Anthropic、Responses、Gemini 目前仅有 mock 单元测试；只有 Chat Completions 做过真实端到端验收（由原作者完成）。
- Hindsight 不保证以本插件生成的 `document_id` 去重；异常重试仍可能产生重复记忆。
- 召回文本虽被标记为不可信，但包裹格式不能彻底消除恶意记忆的提示注入风险。请审查 bank 内容和访问权限。

### 开发与验证

```sh
npm test     # 44 个单元测试，不联网
npm run check
```

**本仓库实际验证过的**：上面的单元测试，以及对 loopback 设置页服务的一次实机运行（对着一个要求 `Bearer` 的 stub Hindsight：健康 → `{"ok":true,...}`，缺密钥 → `unauthorized`，页面令牌错误 → `403`）。原作者在真实 Magpie 网关 + 真实 `hermes` bank 上的端到端验收**没有**在本仓库重跑，那属于上游的结论，不是本次的复验。

<a id="与原版的差异--changes-from-the-original"></a>
### 与原版的差异

基线：`Sam-dancing-nu1/magpie-hindsight@0c5327f`。插件名、配置项名称和 Magpie hook 契约完全保持兼容，已装原版的可以直接换过来。

1. **修复：设置页「连接测试」恒报失败。** `page/service.mjs` 把一个结果对象传给了期望状态字符串的函数，于是 `ok` 永远为 `false`、`code` 是个对象，`bank`/`ms` 也丢了。现在返回扁平且类型正确的信封 + 状态码，并补了对应单测。
2. **修复：会话淘汰按插入顺序。** `at` 一直在维护却从未被读取，长会话可能被淘汰、闲置会话反而留着。现在改成真正的 LRU，并用单调计数器避免同毫秒并列。
3. **修复：小超时预算下召回超时退化。** 固定留 200ms 余量时，`gatewayTimeoutMs = 100` 等于没有余量；现在余量按比例缩放，同时去掉了那个把 10s 预算悄悄压到 8s 的天花板。
4. **新增 `max_replay_blocks`。** 给上下文里的历史记忆块加上限；超额时整段丢弃，保证中间的请求缓存稳定。
5. **改动：召回预算是 token 预算。** 原来的 `maxTokens * 8` 字符上限比实际发出的 `max_tokens` 松 2–4 倍，一条超长记忆能吃掉全部额度。现在按语言估算 token、按 token 边界截断，并给单条加 75% 上限。
6. **新增 `api_key` / `api_key_header` / `api_key_prefix`。** recall、retain 和健康探活共用同一个认证头；设置页对密钥做掩码，状态区只显示「已配置/未配置」。

其余均为原作者实现。

### 许可证

Apache-2.0 · 原始作品 © 2024-2026 Sam-Dancing · 本仓库改动 © 2026 zysicyj
