# CI 图数据附表

数据源：固定 CI run [41388046707](https://github.com/phenix3443/paperclip/actions/runs/41388046707)，源码 `4c4a4be3a6639c6f5b7f268823b368180b985f9f`。本表由 CI JSON 汇总，不重新解析源码；每个数字按语法 module reference 出现次数计数。完整原始边、文件 SCC、分类、未解析清单和候选文件分配另见归档证据包。

## top 完整跨组计数

type 保留显式类型边；runtime 是仅移除显式 type-only 的保守图。0 表示没有该类已解析记录。

| 来源 → 目标 | type | runtime conservative |
|---|---:|---:|
| `adapters -> middleware` | 2 | 2 |
| `adapters -> services` | 16 | 15 |
| `adapters -> src-root` | 2 | 2 |
| `adapters -> vendor` | 2 | 2 |
| `auth -> middleware` | 1 | 1 |
| `auth -> src-root` | 2 | 1 |
| `http -> realtime` | 2 | 2 |
| `lib -> services` | 3 | 3 |
| `lib -> src-root` | 5 | 5 |
| `middleware -> auth` | 1 | 0 |
| `middleware -> http` | 1 | 1 |
| `middleware -> modules` | 1 | 1 |
| `middleware -> routes` | 1 | 1 |
| `middleware -> services` | 18 | 17 |
| `middleware -> src-root` | 11 | 11 |
| `middleware -> vendor` | 1 | 1 |
| `modules -> adapters` | 3 | 3 |
| `modules -> lib` | 9 | 6 |
| `modules -> services` | 122 | 118 |
| `modules -> src-root` | 8 | 8 |
| `modules -> storage` | 1 | 1 |
| `modules -> types` | 2 | 0 |
| `modules -> vendor` | 3 | 3 |
| `realtime -> auth` | 1 | 0 |
| `realtime -> middleware` | 3 | 3 |
| `realtime -> services` | 14 | 13 |
| `realtime -> src-root` | 1 | 1 |
| `realtime -> vendor` | 2 | 0 |
| `routes -> adapters` | 10 | 9 |
| `routes -> auth` | 1 | 1 |
| `routes -> http` | 1 | 1 |
| `routes -> lib` | 8 | 8 |
| `routes -> middleware` | 68 | 68 |
| `routes -> modules` | 8 | 8 |
| `routes -> realtime` | 3 | 3 |
| `routes -> secrets` | 2 | 2 |
| `routes -> services` | 520 | 488 |
| `routes -> src-root` | 99 | 99 |
| `routes -> storage` | 8 | 2 |
| `routes -> vendor` | 2 | 2 |
| `secrets -> src-root` | 5 | 5 |
| `services -> adapters` | 65 | 56 |
| `services -> auth` | 3 | 3 |
| `services -> http` | 1 | 1 |
| `services -> lib` | 26 | 22 |
| `services -> middleware` | 154 | 154 |
| `services -> modules` | 140 | 133 |
| `services -> realtime` | 6 | 6 |
| `services -> routes` | 5 | 5 |
| `services -> secrets` | 27 | 20 |
| `services -> src-root` | 575 | 570 |
| `services -> storage` | 45 | 20 |
| `services -> types` | 3 | 0 |
| `services -> vendor` | 100 | 64 |
| `src-root -> adapters` | 1 | 1 |
| `src-root -> auth` | 2 | 1 |
| `src-root -> http` | 2 | 2 |
| `src-root -> lib` | 2 | 2 |
| `src-root -> middleware` | 17 | 17 |
| `src-root -> realtime` | 2 | 2 |
| `src-root -> routes` | 82 | 81 |
| `src-root -> services` | 164 | 156 |
| `src-root -> storage` | 3 | 2 |
| `storage -> src-root` | 5 | 4 |

type 总计 2403 条、64 对；runtime 总计 2239 条、59 对。

## serviceSubdirs 完整跨组计数

type 保留显式类型边；runtime 是仅移除显式 type-only 的保守图。0 表示没有该类已解析记录。

| 来源 → 目标 | type | runtime conservative |
|---|---:|---:|
| `adapters -> middleware` | 2 | 2 |
| `adapters -> services` | 13 | 12 |
| `adapters -> services/native-runtime` | 3 | 3 |
| `adapters -> src-root` | 2 | 2 |
| `adapters -> vendor` | 2 | 2 |
| `auth -> middleware` | 1 | 1 |
| `auth -> src-root` | 2 | 1 |
| `http -> realtime` | 2 | 2 |
| `lib -> services` | 3 | 3 |
| `lib -> src-root` | 5 | 5 |
| `middleware -> auth` | 1 | 0 |
| `middleware -> http` | 1 | 1 |
| `middleware -> modules` | 1 | 1 |
| `middleware -> routes` | 1 | 1 |
| `middleware -> services` | 18 | 17 |
| `middleware -> src-root` | 11 | 11 |
| `middleware -> vendor` | 1 | 1 |
| `modules -> adapters` | 3 | 3 |
| `modules -> lib` | 9 | 6 |
| `modules -> services` | 104 | 101 |
| `modules -> services/grok-bot` | 2 | 2 |
| `modules -> services/native-runtime` | 6 | 6 |
| `modules -> services/public-mcp` | 3 | 2 |
| `modules -> services/recovery` | 7 | 7 |
| `modules -> src-root` | 8 | 8 |
| `modules -> storage` | 1 | 1 |
| `modules -> types` | 2 | 0 |
| `modules -> vendor` | 3 | 3 |
| `realtime -> auth` | 1 | 0 |
| `realtime -> middleware` | 3 | 3 |
| `realtime -> services` | 12 | 11 |
| `realtime -> services/native-runtime` | 2 | 2 |
| `realtime -> src-root` | 1 | 1 |
| `realtime -> vendor` | 2 | 0 |
| `routes -> adapters` | 10 | 9 |
| `routes -> auth` | 1 | 1 |
| `routes -> http` | 1 | 1 |
| `routes -> lib` | 8 | 8 |
| `routes -> middleware` | 68 | 68 |
| `routes -> modules` | 8 | 8 |
| `routes -> realtime` | 3 | 3 |
| `routes -> secrets` | 2 | 2 |
| `routes -> services` | 483 | 455 |
| `routes -> services/connectors` | 2 | 2 |
| `routes -> services/grok-bot` | 1 | 1 |
| `routes -> services/heartbeat` | 1 | 1 |
| `routes -> services/native-runtime` | 16 | 16 |
| `routes -> services/public-mcp` | 11 | 9 |
| `routes -> services/recovery` | 3 | 3 |
| `routes -> services/voice` | 3 | 1 |
| `routes -> src-root` | 99 | 99 |
| `routes -> storage` | 8 | 2 |
| `routes -> vendor` | 2 | 2 |
| `secrets -> src-root` | 5 | 5 |
| `services -> adapters` | 27 | 27 |
| `services -> auth` | 3 | 3 |
| `services -> lib` | 25 | 22 |
| `services -> middleware` | 85 | 85 |
| `services -> modules` | 70 | 67 |
| `services -> realtime` | 2 | 2 |
| `services -> routes` | 2 | 2 |
| `services -> secrets` | 23 | 16 |
| `services -> services/chat-channels` | 140 | 134 |
| `services -> services/connectors` | 20 | 19 |
| `services -> services/daytona` | 1 | 1 |
| `services -> services/heartbeat` | 57 | 56 |
| `services -> services/native-runtime` | 80 | 77 |
| `services -> services/photon` | 7 | 7 |
| `services -> services/public-mcp` | 2 | 2 |
| `services -> services/recovery` | 12 | 10 |
| `services -> services/runtime-exposure` | 6 | 6 |
| `services -> services/scripts` | 1 | 1 |
| `services -> services/tool-access` | 64 | 61 |
| `services -> services/voice` | 10 | 9 |
| `services -> src-root` | 351 | 347 |
| `services -> storage` | 31 | 14 |
| `services -> types` | 3 | 0 |
| `services -> vendor` | 18 | 16 |
| `services/chat-channels -> lib` | 1 | 0 |
| `services/chat-channels -> middleware` | 26 | 26 |
| `services/chat-channels -> modules` | 11 | 11 |
| `services/chat-channels -> secrets` | 1 | 1 |
| `services/chat-channels -> services` | 437 | 328 |
| `services/chat-channels -> services/connectors` | 9 | 8 |
| `services/chat-channels -> services/native-runtime` | 18 | 18 |
| `services/chat-channels -> services/photon` | 18 | 18 |
| `services/chat-channels -> services/voice` | 36 | 13 |
| `services/chat-channels -> src-root` | 73 | 73 |
| `services/chat-channels -> storage` | 2 | 0 |
| `services/connectors -> middleware` | 3 | 3 |
| `services/connectors -> services` | 51 | 42 |
| `services/connectors -> services/chat-channels` | 1 | 1 |
| `services/connectors -> src-root` | 25 | 25 |
| `services/connectors -> storage` | 1 | 1 |
| `services/grok-bot -> services` | 18 | 17 |
| `services/grok-bot -> services/public-mcp` | 2 | 2 |
| `services/heartbeat -> adapters` | 32 | 25 |
| `services/heartbeat -> middleware` | 15 | 15 |
| `services/heartbeat -> modules` | 28 | 24 |
| `services/heartbeat -> services` | 413 | 344 |
| `services/heartbeat -> services/chat-channels` | 1 | 1 |
| `services/heartbeat -> services/connectors` | 2 | 2 |
| `services/heartbeat -> services/native-runtime` | 58 | 54 |
| `services/heartbeat -> services/recovery` | 16 | 13 |
| `services/heartbeat -> services/voice` | 2 | 2 |
| `services/heartbeat -> src-root` | 30 | 29 |
| `services/heartbeat -> vendor` | 10 | 7 |
| `services/native-runtime -> adapters` | 3 | 1 |
| `services/native-runtime -> middleware` | 12 | 12 |
| `services/native-runtime -> modules` | 20 | 20 |
| `services/native-runtime -> realtime` | 4 | 4 |
| `services/native-runtime -> routes` | 2 | 2 |
| `services/native-runtime -> secrets` | 2 | 2 |
| `services/native-runtime -> services` | 410 | 368 |
| `services/native-runtime -> services/chat-channels` | 5 | 5 |
| `services/native-runtime -> services/connectors` | 1 | 1 |
| `services/native-runtime -> services/heartbeat` | 2 | 2 |
| `services/native-runtime -> services/photon` | 1 | 1 |
| `services/native-runtime -> services/recovery` | 1 | 1 |
| `services/native-runtime -> services/voice` | 3 | 3 |
| `services/native-runtime -> src-root` | 35 | 35 |
| `services/native-runtime -> storage` | 10 | 5 |
| `services/native-runtime -> vendor` | 71 | 41 |
| `services/photon -> services` | 2 | 1 |
| `services/photon -> services/native-runtime` | 1 | 1 |
| `services/photon -> src-root` | 4 | 4 |
| `services/public-mcp -> http` | 1 | 1 |
| `services/public-mcp -> middleware` | 2 | 2 |
| `services/public-mcp -> modules` | 3 | 3 |
| `services/public-mcp -> secrets` | 1 | 1 |
| `services/public-mcp -> services` | 19 | 18 |
| `services/public-mcp -> services/native-runtime` | 1 | 1 |
| `services/public-mcp -> src-root` | 3 | 3 |
| `services/public-mcp -> storage` | 1 | 0 |
| `services/public-mcp -> vendor` | 1 | 0 |
| `services/recovery -> adapters` | 3 | 3 |
| `services/recovery -> middleware` | 1 | 1 |
| `services/recovery -> modules` | 8 | 8 |
| `services/recovery -> services` | 43 | 43 |
| `services/recovery -> services/heartbeat` | 2 | 2 |
| `services/recovery -> services/native-runtime` | 7 | 7 |
| `services/recovery -> src-root` | 3 | 3 |
| `services/tool-access -> middleware` | 2 | 2 |
| `services/tool-access -> services` | 130 | 123 |
| `services/tool-access -> services/chat-channels` | 1 | 1 |
| `services/tool-access -> services/connectors` | 8 | 8 |
| `services/tool-access -> services/voice` | 1 | 1 |
| `services/tool-access -> src-root` | 41 | 41 |
| `services/voice -> middleware` | 8 | 8 |
| `services/voice -> routes` | 1 | 1 |
| `services/voice -> services` | 44 | 36 |
| `services/voice -> services/native-runtime` | 1 | 1 |
| `services/voice -> src-root` | 10 | 10 |
| `src-root -> adapters` | 1 | 1 |
| `src-root -> auth` | 2 | 1 |
| `src-root -> http` | 2 | 2 |
| `src-root -> lib` | 2 | 2 |
| `src-root -> middleware` | 17 | 17 |
| `src-root -> realtime` | 2 | 2 |
| `src-root -> routes` | 82 | 81 |
| `src-root -> services` | 149 | 141 |
| `src-root -> services/chat-channels` | 1 | 1 |
| `src-root -> services/grok-bot` | 1 | 1 |
| `src-root -> services/native-runtime` | 9 | 9 |
| `src-root -> services/public-mcp` | 4 | 4 |
| `src-root -> storage` | 3 | 2 |
| `storage -> src-root` | 5 | 4 |

type 总计 4568 条、167 对；runtime 总计 4109 条、158 对。

## 所有非平凡文件 SCC

大 SCC 的全部成员在原始 `graphs.json` 与 `candidate-partitions.json`；以下小 SCC 全列。

### type

- 最大 SCC：540 文件，320009 行。
- `server/src/services/plugin-lifecycle-shared.ts`, `server/src/services/plugin-lifecycle.ts`, `server/src/services/plugin-loader.ts`, `server/src/services/plugin-tool-dispatcher.ts`（4368 行）。
- `server/src/services/agent-file-checkpoints.ts`, `server/src/services/agent-file-store.ts`, `server/src/services/agent-instructions.ts`（1261 行）。
- `server/src/services/agent-avatar-pool.ts`, `server/src/services/agent-avatars.ts`（160 行）。
- `server/src/services/delivery-work-coordinator.ts`, `server/src/services/task-admission.ts`（232 行）。
- `server/src/services/native-runtime/provider-lifecycle.ts`, `server/src/services/native-runtime/providers/cursor-lifecycle.ts`（70 行）。

### runtimeConservative

- 最大 SCC：333 文件，248042 行。
- `server/src/services/agent-file-checkpoints.ts`, `server/src/services/agent-file-store.ts`, `server/src/services/agent-instructions.ts`（1261 行）。
- `server/src/services/chat-channels/imessage-photon/publications.ts`, `server/src/services/chat-channels/publication-replacement.ts`（1244 行）。

## 符号分类计数

kind 是声明分类，typeOnly 是语法标记，两者正交。混合边可同时携带不同分类，不能把以下符号总数当边总数。

| kind | 全部绑定 | 内部绑定 |
|---|---:|---:|
| class | 585 | 404 |
| constant-binding | 8080 | 1434 |
| dynamic-namespace | 96 | 73 |
| enum | 6 | 0 |
| function | 15074 | 10465 |
| namespace | 8 | 3 |
| other | 337 | 2 |
| reexport-namespace | 13 | 13 |
| type | 5151 | 2134 |
| type-query | 60 | 16 |
| unknown | 338 | 128 |

副作用 bare-import 绑定为 0。常量仅表示 const-binding；class、enum、namespace、other 与 unknown 均单列。所有关键回路边见主方案，原始 `graphs.json.cycleEdges` 包含全部位于非平凡 SCC 内的边，不声称是最小反馈边集。
