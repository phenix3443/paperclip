# Server import 循环与编译切分方案（研究草稿）

状态：CI 图证据待取得，尚未提交独立审核。本稿不构成实施授权。关联需求：[fork #184](https://github.com/phenix3443/paperclip/issues/184)。

## 版本与范围

- 源码基线：`4c4a4be3a6639c6f5b7f268823b368180b985f9f`，取证开始时最新 fork `develop`。
- 前置 #181 已合并，merge `63ec4fa0f31f911d55159e0fa32a58b82804c6f5` 是源码基线祖先。
- 一次性诊断 head：`332f426979ca4a2e3e96d9731153b013444ac33e`，分支 `chore/server-import-graph-evidence`。
- [依赖图 CI](https://github.com/phenix3443/paperclip/actions/runs/41388046707) 最后一次读取为 queued，尚无图结果。最终需补全 edges、分类、未解析项、SCC、关键边和每种分组比较。
- 仅提交 `doc/plans/` 文档；诊断脚本和 workflow 不合入 develop，不改源码、包脚本或 tsconfig，不做拆分原型、新内存测量或 #183 缓存实现。

## 图采集方法与覆盖限制

采集器固定 TypeScript 5.9.3 Compiler API，用源码的 `server/tsconfig.src.json`、继承配置和 NodeNext resolution 解析。项目现用 TypeScript 7.0.2；分析 API 版本与构建版本分别记录，解析差异需在未解析清单中核实。仅调用解析、模块解析、符号查询，不调用 emit、diagnostics 或 typecheck。

覆盖 import、export-from、import-equals、import type query、字面量 dynamic import 与 require；非字面量引用单列。逐边记录来源文件、行号、目标、specifier、绑定和分类。常量仅表示 const binding，不能推断为纯值或不可变值；类、enum、namespace、未知符号不猜成常量/函数。

完整 type graph 保留 type-only、mixed 和 re-export 依赖。保守 runtime graph 只排除显式 type-only 与声明文件边，是 emitted JS 图的上界，不能当作真实运行时可达性。外部依赖完整记录但不参与 server 内部 SCC；无法静态覆盖的 aliased/computed loaders 明确列为覆盖外。分组一为 src 首级目录；分组二将 services 的子目录独立，直属 services 文件仍属 services。文件级 SCC 与各分组 SCC 都需比较，分组可能制造文件级不存在的环。

## 现有内存基线（不是本方案收益）

实读 [#181 memory run](https://github.com/phenix3443/paperclip/actions/runs/40847996009)，源码 `ba865fa6fdf928a8bb91c30a10f7113b7f348e02`，TypeScript 7.0.2，所有十个 RESULT exit=0。与本方案源码不同，不能当成当前提交性能实测。

| 变体 | peak RSS MiB | wall s |
|---|---:|---:|
| 原始混合 source/tests | 9593 | 30.70 |
| mixed checkers 2 | 8213 | 30.26 |
| mixed checkers 1 | 6343 | 39.49 |
| source-only noEmit checkers 2 | 5036 | 19.80 |
| source declarations checkers 2 | 6197 | 23.53 |
| tests warm checkers 2 | 2722 | 8.37 |
| source declarations checkers 1 | 5212 | 31.66 |
| tests warm checkers 1 | 2260 | 10.43 |
| source unchanged | 50 | 0.11 |
| typecheck-script | 6048 | 44.12 |

未测量任何候选。不能把源行数按比例换算确定内存收益。后续估算须分别列每 project 的固定 compiler/lib 成本、输入闭包、声明消费开销、串行峰值与并行总内存；当前仅保留基线，待图数据后给明确假设及误差范围。

## 候选切法（待 CI 图复核）

## 当前事实

- `server/tsconfig.src.json:4` 开启 composite，`:5` 为 emitDeclarationOnly；源项目 `:16–18` 纳入 src 和 JSON。`server/tsconfig.tests.json:4` 为 noEmit，`:14–17` 引用源项目。源码在现有路径，输出只进入缓存。
- `tsconfig.base.json:4–5` 采用 NodeNext module/moduleResolution。源码图的 type-only import 仍是编译依赖：只删 runtime graph 中的边不能让 project references 的 type graph 成为 DAG。
- `server/src/services/heartbeat/queue.ts:203` type-only 导入 `HeartbeatServiceOptions`，它定义于 `heartbeat.ts:752–787`，构成 facade → queue → facade 的类型回引。queue 真正只用其 `beforeChatControlRecoveryCheck` 属性（`:230`）。同文件 `:216–236` 用多项 `ReturnType<typeof factory>`，并不因为 import type 就消除对 implementation 声明的依赖。
- `server/src/services/connection-tool-refresh.ts:5–9,20` 依赖 heartbeatService 的推导返回值但仅消费 wakeup；`case-handoff-delivery.ts:8–14` 同样只有 wakeup 与可选 yield；`routes/connection-intents.ts:18,44,143` 又依赖该 facade。实际 wakeup 入参 `WakeupOptions` 定义在 `heartbeat/run-preparation.ts:830`，所以合同必须连该类型的闭包一起审，不能把 ReturnType 搬进新文件就宣称脱耦。
- `modules/external-agents/dot.ts:38–39` 与 `muse.ts:47` 存在动态 import heartbeat 的 fallback。其 type-only `Pick<ReturnType<...>>` 换合同后，runtime edge 仍然存在；不能按 type-only 优化假设删除或替换 fallback。
- `chat-channels/runtime-types.ts:2,5` 虽然全是 import type，仍依赖 `chat-sdk-runtime.ts` 与 `voice/voice-runtime.ts`；后者 `:7` 又以 `Omit<ChatSdkEndpointRuntime,...>` 取 implementation 类型。把 runtime-types 独立设 project 并非自动可行。

## 候选比较

| 方案 | 精确起点/文件与估算 | 触及范围 | 价值、风险与停止条件 |
| --- | --- | --- | --- |
| A. 按完整 type graph SCC 归组，保留大 SCC | 修改 `server/tsconfig.src.json`、`server/tsconfig.tests.json`、新增 1–N 个 `server/tsconfig.*.json`；必要时仅同步现有 server typecheck 脚本/CI。配置约 60–140 行，源码 0 行，最终取决于 SCC 分组数。 | 仅编译配置，不改运行时 import 或文件路径。 | 最低维护成本；只有 SCC 外的叶子和有向层能独立。若主 SCC 仍占绝大多数代码，不能承诺峰值显著下降。停止：无法形成互斥、穷尽的源文件分配或出现 TS6307/TS6059/循环 project refs。 |
| B. 显式窄合同消除 facade 类型回引 | 最小第一片：`heartbeat.ts:748–787`、`heartbeat/queue.ts:203,230`、新增 `heartbeat/contracts.ts`；约 60–100 行 diff（迁移约 40 行声明，补 type imports/re-export）。第二片视图再扩展 `connection-tool-refresh.ts`、`case-handoff-delivery.ts`、`routes/connection-intents.ts` 等 wakeup consumers 与合同；约 100–250 行。 | 第一片应只有 type-level 声明，保留原 facade 的 type re-export；JS emit 理想不变，但尚未实证。不得移动状态、调用时序或授权检查。 | 为现有真实消费者提供较小 Interface，减少 implementation 类型泄漏；单一 Options 回引消除不代表整个 SCC 解开。`HeartbeatEnvironmentRuntime = ReturnType<typeof environmentRuntimeService>`、PluginWorkerManager、NativeExecutionInput/Backend 的依赖闭包必须留在图中。停止：合同继续 import facade、被迫复制运行时代码、类型不兼容、运行时 emit 改变，或完整图依旧无可观切分。 |
| C. 现有叶子组成小型 foundation project | 先核验 `errors.ts` (46 行)、`db-errors.ts` (62)、`database-retry.ts` (49)、`services/native-runtime/canonical.ts` (18)，合计 175 源行。上述文件无 server 本地 import（canonical 仅 node:crypto）；新增配置及调整源项目/测试 refs，约 40–90 配置行，源码 0 行。 | 运行时 import 保持原样，文件不移动。仅 declaration 项目划分。 | 是不需 import 改造的最小演示，但 175 行相对大源项目几乎不影响峰值；公共库/types 固定开销可能让总耗时变差。`database-retry` 含 setTimeout（不是纯计算），仅归组、绝不改变实现。停止：下游仍把源代码纳入自身而非引用 d.ts、项目常驻开销超过可接受收益，或 CI 峰值未降低。 |

## 推荐供主方案整合

先用 CI 证据比较 A 与 B，默认不实施大范围 import 改造；若完整 type SCC 表明有可分离且足够大的模块，才考虑单独授权 B 的第一片。C 可以作为“为何目录数量或 DAG 数量不能直接换算内存收益”的反例，不值得只为收益单独实施。上述均不构成本任务实施授权。

不推荐现在把 chat/heartbeat/native-runtime 全部依赖倒置：它们有真实动态 fallback、共享注册与生命周期状态。更换为 injected callbacks 即使表面行为相同，仍触及 runtime wiring、初始化/回收顺序及禁用路径，须另立经过 CI 验证的实现任务。不存在“只改 import type 就保证大 SCC 解开”的证据。

估算内存应把代码比例法标成弱估计；175 行 foundation 的比例收益甚至可能被 compiler/lib 固定开销淹没。没有原型测量时每个 project 的峰值只能给区间/假设，不能从 #181 基线外推确定值。候选最终文件清单必须和 CI 关键成环边逐项对应，并用固定 upstream/master 的 90 天窗口按这些精确文件计算改动次数。

## 上游成本（固定窗口）

固定 `upstream/master` SHA：`1a6017d6460267ad89d7e1784e2b521c28d8e9ac`。窗口：`(2026-08-03T10:08:51-06:00, 2026-11-01T10:08:51-06:00]`；结束为该提交 committer 时间，起始减去 90 天。

方法：沿固定 SHA 的可达历史，`--no-merges` 排除合并提交（保留可达的普通被合并提交）；按 committer 时间筛选，解析后再严格执行半开窗口。改动日数使用 UTC 日期；`--no-renames` 不追踪历史旧路径。增删行是 numstat 累计，不能当作当前净 diff。

命令：
```sh
git log 1a6017d6460267ad89d7e1784e2b521c28d8e9ac --no-merges --no-renames --since=2026-08-03T10:08:51-06:00 --until=2026-11-01T10:08:51-06:00 --format=@@%H|%cI --numstat -- server/tsconfig.json server/tsconfig.src.json server/tsconfig.tests.json server/tsconfig.build.json server/package.json .github/workflows/server-typecheck-memory.yml .github/scripts/server-typecheck-measure.sh server/src/services/heartbeat.ts server/src/services/heartbeat/queue.ts server/src/services/heartbeat/contracts.ts server/src/services/heartbeat/run-preparation.ts server/src/services/connection-tool-refresh.ts server/src/services/case-handoff-delivery.ts server/src/routes/connection-intents.ts server/src/modules/external-agents/dot.ts server/src/modules/external-agents/muse.ts server/src/services/chat-channels/runtime-types.ts server/src/services/chat-sdk-runtime.ts server/src/services/voice/voice-runtime.ts server/src/errors.ts server/src/db-errors.ts server/src/database-retry.ts server/src/services/native-runtime/canonical.ts
```

| 文件 | 触及提交数 | UTC 改动日数 | 增行 | 删行 | 上游 tip 存在 |
| --- | ---: | ---: | ---: | ---: | --- |
| `server/tsconfig.json` | 0 | 0 | 0 | 0 | 是 |
| `server/tsconfig.src.json` | 0 | 0 | 0 | 0 | 否 |
| `server/tsconfig.tests.json` | 0 | 0 | 0 | 0 | 否 |
| `server/tsconfig.build.json` | 0 | 0 | 0 | 0 | 否 |
| `server/package.json` | 66 | 29 | 157 | 57 | 是 |
| `.github/workflows/server-typecheck-memory.yml` | 0 | 0 | 0 | 0 | 否 |
| `.github/scripts/server-typecheck-measure.sh` | 0 | 0 | 0 | 0 | 否 |
| `server/src/services/heartbeat.ts` | 302 | 77 | 32592 | 47038 | 是 |
| `server/src/services/heartbeat/queue.ts` | 47 | 17 | 5424 | 306 | 是 |
| `server/src/services/heartbeat/contracts.ts` | 0 | 0 | 0 | 0 | 否 |
| `server/src/services/heartbeat/run-preparation.ts` | 19 | 11 | 3416 | 127 | 是 |
| `server/src/services/connection-tool-refresh.ts` | 0 | 0 | 0 | 0 | 否 |
| `server/src/services/case-handoff-delivery.ts` | 1 | 1 | 171 | 0 | 是 |
| `server/src/routes/connection-intents.ts` | 7 | 7 | 333 | 88 | 是 |
| `server/src/modules/external-agents/dot.ts` | 2 | 2 | 641 | 0 | 是 |
| `server/src/modules/external-agents/muse.ts` | 5 | 4 | 629 | 14 | 是 |
| `server/src/services/chat-channels/runtime-types.ts` | 4 | 2 | 94 | 1 | 是 |
| `server/src/services/chat-sdk-runtime.ts` | 5 | 5 | 3318 | 10 | 是 |
| `server/src/services/voice/voice-runtime.ts` | 1 | 1 | 49 | 0 | 是 |
| `server/src/errors.ts` | 2 | 2 | 10 | 2 | 是 |
| `server/src/db-errors.ts` | 2 | 2 | 52 | 0 | 是 |
| `server/src/database-retry.ts` | 2 | 2 | 51 | 2 | 是 |
| `server/src/services/native-runtime/canonical.ts` | 1 | 1 | 18 | 0 | 是 |

注意：新增 `heartbeat/contracts.ts` 没有历史，不是零维护成本。上游 tip 不存在的 fork 配置/workflow 即使统计为 0，也不能解释为将来不会冲突。这里只统计固定路径，不跟随重命名；文件创建前的旧路径变化不计。

这些是改动频率和累计行数的代理指标，不是冲突概率实测。未模拟 develop 每日 merge，也没测 conflict hunks。合同抽取若改动高频 facade/queue，会使后续相同行周围的变更更容易需要人工协调；纯新增编译配置可能免于内容冲突，但仍可能因上游新增源文件或 compiler 配置语义变化而失效。

原始完整记录：`upstream-cost.json`（每文件逐提交 SHA、committerDate、增删行）与 `upstream-cost-git-log.txt`。本研究未联网、未改仓库。

## 暂定推荐与未完成项

暂定 no-go 大规模 import 改造；最终推荐待完整图与估算补齐。无 runtime 变化是硬约束，类型合同也不能掩盖真实运行时 fallback 或改变初始化顺序。

本轮最小下一步为读取上述固定 CI run 的终态与 artifact，核验未解析项、关键环边、SCC 外可独立文件和分组差异，然后补每 project 估算并自审。若不能形成足够大的有向切分，或必须改运行时 wiring、移动源文件、扩大诊断范围，则停止，不自行实施。

最终文档通过独立审核并合并后，#184 仍保持 OPEN，等待是否实施的决定；推荐本身不构成授权，也不预建实现任务。
