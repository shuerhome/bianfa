// 把一行文本里「会被 Markdown 当成块级语法」的行首字符转义成字面量。
// 用于：(1) 段落序列化（Tiptap 只转义行内字符，不管行首的 `- ` / `# ` / `1. `），
//      (2) 导入纯文本行时避免 `- 买菜` 变成列表。
// 只在语法真正成立的位置转义（列表标记后必须有空白、ATX 标题 `#` 后必须有空白或行尾），
// 所以 `*斜体*`、`#tag`、`-1` 这类不受影响。
export function escapeBlockSyntaxLine(line: string): string {
  return (
    line
      // 无序列表 / 引用：`- x`、`+ x`、`* x`、`> x`
      .replace(/^(\s*)([-+*])(\s)/, "$1\\$2$3")
      .replace(/^(\s*)>/, "$1\\>")
      // ATX 标题：`# x` 或单独一行 `#`
      .replace(/^(\s*)#(?=#{0,5}(\s|$))/, "$1\\#")
      // 有序列表：`1. x` / `1) x`
      .replace(/^(\s*\d{1,9})([.)])(\s|$)/, "$1\\$2$3")
      // 围栏代码块
      .replace(/^(\s*)(`{3,}|~{3,})/, "$1\\$2")
      // 分隔线 / setext 标题下划线：`---`、`***`、`___`、`===`
      .replace(/^(\s*)([-*_=])(?=(\s*\2){2,}\s*$)/, "$1\\$2")
  );
}

/** 对多行文本逐行转义 */
export function escapeBlockSyntax(text: string): string {
  return text.split("\n").map(escapeBlockSyntaxLine).join("\n");
}
