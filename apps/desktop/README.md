# @bianfa/desktop — 桌面端前端（WebView 侧）

Tauri 2 壳在 `src-tauri/`（由 Rust 侧维护，本目录只管 WebView）。React 19 + Vite 8 + Tailwind 4 + Tiptap 3 + Yjs。

## 入口（四个 HTML）

| 文件 | 窗口 label | 说明 |
|---|---|---|
| `note.html?id=<uuid>&fresh=1&color=citron` | `note-*` | 一张便笺 = 一个窗口；`fresh=1` 时由 JS `note_create` |
| `index.html?section=notes\|trash\|team` | `main` | 便笺列表 / 搜索 / 回收站 / 团队墙 / 命令面板 |
| `settings.html?section=general\|appearance\|account\|sync\|data\|about` | `settings` | 设置（即时生效） |
| `sync.html` | `sync` | 隐藏同步宿主：唯一持有 WebSocket（Hocuspocus）的 WebView |

## 目录

```
src/
  ipc/        commands.ts（每个 Rust command 一个函数）、events.ts（事件订阅）、errors.ts、types.ts（specs/07 契约）
  lib/        doc-store（Y.Doc 生命周期 / 落库 / 快照 / UndoManager）、note-actions、shortcuts、theme、i18n、query、export、search-query
  editor/     extensions（schema v1 + Collaboration + 键位 + 粘贴上限 + 远端高亮）、NoteEditor、static-render（bodyHtml 静态视图）、
              projection（IPC 投影 = shared projector + bigram + static-renderer）、attachments（粘贴/拖入 → attachment_import）
  sync/       host.ts（sync host：provider 管理 / token 刷新 / 收缩守卫 / 编辑胜 / inbox）、status-store（四态）、token
  windows/    note/（NoteApp、TitleBar、Toolbar、ColorPopover、SyncDot、NoteBody）、main/（MainApp、NoteCard、CommandPalette、TeamWall）、
              settings/（SettingsApp、五个分区、ImportWizard）、sync/main.ts
  styles/     base（token + ui + prose + 平台尾巴）、note、main、settings
  platform/   static-tail.css + MANIFEST.md（平台分叉唯一所在）
  i18n/       zh-Hans.json / en.json（键集合必须一致，测试强制）
  test/       vitest（jsdom；@tauri-apps/api 已 mock）
```

## 运行

```bash
pnpm install                       # 仓库根
pnpm -r --filter @bianfa/tokens --filter @bianfa/ui --filter @bianfa/shared build   # 依赖包先出 dist
pnpm --filter @bianfa/desktop dev  # 纯 Vite（http://127.0.0.1:1420，无 Tauri 时 invoke 抛 no_tauri）
pnpm --filter @bianfa/desktop tauri dev   # 需要 src-tauri 就绪
pnpm --filter @bianfa/desktop typecheck && pnpm --filter @bianfa/desktop lint && pnpm --filter @bianfa/desktop test
pnpm --filter @bianfa/desktop build       # tsc -b + vite build → dist/{index,note,settings,sync}.html
```

## 约定

- Yjs 语义只在 JS：Y.Doc 由 `note_load_doc` 重建，每次本地事务合并后 `note_append_update(origin:'local', projection)`（400 ms 防抖 / 1 s 上限，`Ctrl+S`/失焦立即）；快照 50 条 / 5 min / 失焦。
- 跨窗口只走 Tauri 事件（`db:changed`、`sync:status`…），禁 BroadcastChannel / localStorage。
- 便笺色只传枚举名；`data-color` 写在容器上，组件只读 `--note-*`。
- 投影里的 image src 永远是 `bianfa://att/<id>`，显示前经 `attachment_local_url` 兑换。

## 本期未做 / 占位

- LLM/AI：无 `ai.html`、无 AI 菜单；命令面板留 `// TODO(llm)`。
- 团队墙：只读列表占位（`GET /v1/orgs/:id/notes`）；看板拖拽、在线头像未做。
- 冲突「并排比较」视图、版本时间线：设置页只列出错误与收缩守卫恢复。
- 便笺发现的 `since_version` 水位只在 sync host 内存里（无对应持久化 command）。
- 撤销/重做经 `Y.UndoManager`（每 doc 一份，trackedOrigins = ySyncPluginKey / local / ai）。
