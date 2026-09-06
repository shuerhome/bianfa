// @bianfa/shared —— 服务端与桌面端共用的纯逻辑：Y.Doc 约定、schema v1、projector、Markdown、检索分词、灰度分桶、导入、DTO。
export const BIANFA_SHARED_VERSION = "0.0.0";

export {
  DEFAULT_NOTE_COLOR,
  isNoteColor,
  LEGACY_DEFAULT_COLOR,
  LEGACY_THEME_TO_COLOR,
  legacyThemeToColor,
  NOTE_COLOR_INFO,
  NOTE_COLORS,
  type NoteColor,
  type NoteColorInfo,
  noteColorByName,
  noteColorSchema,
} from "./colors.js";

export {
  applyUpdateV2,
  BODY_FIELD,
  createNoteDoc,
  diffUpdateV2,
  encodeStateV2,
  encodeStateVector,
  EXT_IMPORT_KEY,
  EXT_MAP,
  getBody,
  getExtMap,
  getMetaMap,
  type ImportExt,
  importExtSchema,
  META_MAP,
  mergeUpdatesV2,
  type NoteDocInit,
  type NoteMeta,
  type NoteMetaPatch,
  noteMetaPatchSchema,
  noteMetaSchema,
  openNoteDoc,
  type Origin,
  Origins,
  readImportExt,
  readMeta,
  writeImportExt,
  writeMeta,
  ZMode,
  zModeSchema,
} from "./doc.js";

export {
  ATTACHMENT_SRC_PREFIX,
  attachmentIdFromSrc,
  attachmentSrc,
  createEditorExtensions,
  type EditorExtensionsOptions,
  generateTaskItemId,
  getSchemaV1,
  Image,
  type ImageAttrs,
  isAllowedLinkHref,
  isRemoteTransaction,
  LINK_PROTOCOLS,
  SCHEMA_VERSION,
  TASK_ITEM_ID_ATTR,
  TASK_ITEM_ID_LENGTH,
} from "./editor/schema.js";

export {
  bodyToPmNode,
  type ChecklistItem,
  EMPTY_PM_DOC,
  ensureTaskItemIds,
  excerptFromText,
  type NoteDocFromJsonInit,
  type NoteProjection,
  type PMJson,
  projectBodyNode,
  projectNoteDoc,
  projectPmJson,
  prosemirrorJsonToNoteDoc,
  setBodyFromPmJson,
  titleFromText,
} from "./projector.js";

export {
  escapeBlockSyntax,
  inlineLinesToPmJson,
  type MarkdownExportOptions,
  type MarkdownImportOptions,
  markdownToPmJson,
  normalizePmJson,
  pmJsonToMarkdown,
} from "./markdown.js";

export { escapeLikePattern, toBigramQuery, toBigramShingles } from "./search/bigram.js";

export { isInRollout, murmur3_32, ROLLOUT_KEY_INFIX, rolloutBucket } from "./rollout.js";

export {
  parsePlumExportFile,
  type PlumDocInit,
  type PlumExportAttachment,
  type PlumExportFile,
  type PlumExportNote,
  type PlumExportWindow,
  type PlumImportOptions,
  plumExportAttachmentSchema,
  plumExportFileSchema,
  plumExportNoteSchema,
  plumExportWindowSchema,
  plumNoteToDocInit,
  plumNoteToNoteDoc,
  plumTimeToMs,
} from "./import/plum.js";

export {
  EXCERPT_MAX_CHARS,
  NOTE_PERMS,
  type NoteListItem,
  type NotePerm,
  noteListItemSchema,
  notePermSchema,
  type Platform,
  permAtLeast,
  permRank,
  platformSchema,
  TITLE_MAX_CHARS,
  type WorkspaceKind,
  workspaceKindSchema,
} from "./dto.js";
