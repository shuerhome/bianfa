// PM schema 版本号单独成文件：doc.ts 需要它做 meta.schemaVersion 的默认值，
// 但不应因此把整套 Tiptap 扩展拖进只处理 Y.Doc 的进程（sync-ws）。
/** 当前 ProseMirror schema 版本（规格 02 §1.3 notes.schema_version / §4） */
export const SCHEMA_VERSION = 1;
