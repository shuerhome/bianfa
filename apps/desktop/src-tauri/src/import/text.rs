//! Text-level helpers for the Windows Sticky Notes import (port of
//! `tools/export_sticky_notes.py`): .NET ticks, `WindowPosition`, the private `Text` format and
//! the `LastServerVersion` JSON walk.

use regex::Regex;
use std::sync::OnceLock;

/// .NET ticks (100 ns since 0001-01-01) → unix ms; outside 1990–2100 means "not ticks".
pub const TICKS_EPOCH_OFFSET_MS: i64 = 62_135_596_800_000;

pub fn ticks_to_ms(ticks: Option<i64>) -> Option<i64> {
    let t = ticks?;
    if t == 0 {
        return None;
    }
    let ms = t / 10_000 - TICKS_EPOCH_OFFSET_MS;
    if -631_152_000_000 < ms && ms < 4_102_444_800_000 {
        Some(ms)
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WindowPos {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub w: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub h: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_id: Option<String>,
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static regex"))
}

static POS_RE: OnceLock<Regex> = OnceLock::new();
static SIZE_RE: OnceLock<Regex> = OnceLock::new();
static DEV_RE: OnceLock<Regex> = OnceLock::new();
static ID_PREFIX_RE: OnceLock<Regex> = OnceLock::new();
static CTRL_RE: OnceLock<Regex> = OnceLock::new();
static MULTI_NL_RE: OnceLock<Regex> = OnceLock::new();
static MD_MARK_RE: OnceLock<Regex> = OnceLock::new();

/// `ManagedPosition=DeviceId:...;Position=x,y;Size=w,h` — coordinates may be negative.
pub fn parse_window_position(s: Option<&str>) -> Option<WindowPos> {
    let s = s?;
    if s.trim().is_empty() {
        return None;
    }
    let mut out = WindowPos {
        x: None,
        y: None,
        w: None,
        h: None,
        display_id: None,
    };
    if let Some(c) = re(&POS_RE, r"(?i)Position=(-?\d+),(-?\d+)").captures(s) {
        out.x = c[1].parse().ok();
        out.y = c[2].parse().ok();
    }
    if let Some(c) = re(&SIZE_RE, r"(?i)Size=(\d+),(\d+)").captures(s) {
        out.w = c[1].parse().ok();
        out.h = c[2].parse().ok();
    }
    if let Some(c) = re(&DEV_RE, r"(?i)DeviceId:([^;]+)").captures(s) {
        out.display_id = Some(c[1].trim().to_string());
    }
    if out.x.is_none() && out.w.is_none() && out.display_id.is_none() {
        None
    } else {
        Some(out)
    }
}

/// Parsed private `Text` field: (markdown, plain, degraded).
pub struct ParsedText {
    pub markdown: String,
    pub plain: String,
    pub degraded: bool,
}

fn md_pair(word: &str) -> Option<(&'static str, &'static str)> {
    match word {
        "b" => Some(("**", "**")),
        "i" => Some(("*", "*")),
        "ul" => Some(("<u>", "</u>")),
        "strike" => Some(("~~", "~~")),
        _ => None,
    }
}

/// The private `Text` format: `\id=<GUID> ` paragraph prefixes, `\par`, RTF-style `\b`/`\i`/`\ul`/
/// `\strike` (+`0` to close). Unknown control words are dropped and flagged as `degraded`.
/// Control-word terminators eat a single space/tab only — never a newline.
pub fn parse_text_field(raw: Option<&str>) -> ParsedText {
    let Some(raw) = raw else {
        return ParsedText {
            markdown: String::new(),
            plain: String::new(),
            degraded: false,
        };
    };
    let mut degraded = false;
    let s = raw.replace("\r\n", "\n");
    let s = re(&ID_PREFIX_RE, r"\\id=[0-9A-Fa-f\-]+\s?").replace_all(&s, "");
    let ctrl = re(&CTRL_RE, r"\\([a-zA-Z]+)(-?\d+)?[ \t]?");

    let mut open_tags: Vec<&'static str> = Vec::new();
    let mut out = String::with_capacity(s.len());
    let mut pos = 0usize;
    for m in ctrl.captures_iter(&s) {
        let whole = m.get(0).expect("match");
        out.push_str(&s[pos..whole.start()]);
        pos = whole.end();
        let word = &m[1];
        let arg = m.get(2).map(|a| a.as_str());
        if word == "par" {
            out.push('\n');
            continue;
        }
        match md_pair(word) {
            None => {
                if word != "id" && word != "ulnone" {
                    degraded = true;
                }
                while let Some(t) = open_tags.pop() {
                    out.push_str(t);
                }
            }
            Some((open, close)) => {
                if arg == Some("0") {
                    if let Some(i) = open_tags.iter().position(|t| *t == close) {
                        open_tags.remove(i);
                    }
                    out.push_str(close);
                } else {
                    open_tags.push(close);
                    out.push_str(open);
                }
            }
        }
    }
    out.push_str(&s[pos..]);
    while let Some(t) = open_tags.pop() {
        out.push_str(t);
    }
    let md = re(&MULTI_NL_RE, r"\n{3,}").replace_all(&out, "\n\n");
    let markdown = md.trim().to_string();
    let plain = re(&MD_MARK_RE, r"\*\*|~~|\*|</?u>")
        .replace_all(&markdown, "")
        .into_owned();
    ParsedText {
        markdown,
        plain,
        degraded,
    }
}

/// `LastServerVersion` is normalised cloud JSON; collect every `text` string, depth-first.
pub fn parse_server_version(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let doc: serde_json::Value = serde_json::from_str(raw).ok()?;
    let mut lines: Vec<String> = Vec::new();
    fn walk(node: &serde_json::Value, lines: &mut Vec<String>) {
        match node {
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::String(t)) = map.get("text") {
                    lines.push(t.clone());
                    return;
                }
                for v in map.values() {
                    walk(v, lines);
                }
            }
            serde_json::Value::Array(items) => {
                for v in items {
                    walk(v, lines);
                }
            }
            _ => {}
        }
    }
    walk(&doc, &mut lines);
    let text = lines.join("\n").trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Minimal RTF → plain text (legacy `StickyNotes.snt` stream `0`).
pub fn rtf_to_text(rtf: &str) -> String {
    let mut out = String::new();
    let mut chars = rtf.chars().peekable();
    let mut depth = 0i32;
    let mut skip_depth: Option<i32> = None;
    while let Some(c) = chars.next() {
        match c {
            '{' => {
                depth += 1;
                if chars.peek() == Some(&'\\') {
                    // peek for destination groups we want to drop
                    let mut look = chars.clone();
                    look.next();
                    let mut word = String::new();
                    if look.peek() == Some(&'*') {
                        skip_depth.get_or_insert(depth);
                        continue;
                    }
                    while let Some(&n) = look.peek() {
                        if n.is_ascii_alphabetic() {
                            word.push(n);
                            look.next();
                        } else {
                            break;
                        }
                    }
                    if matches!(
                        word.as_str(),
                        "fonttbl"
                            | "colortbl"
                            | "stylesheet"
                            | "info"
                            | "pict"
                            | "object"
                            | "header"
                            | "footer"
                    ) {
                        skip_depth.get_or_insert(depth);
                    }
                }
            }
            '}' => {
                if skip_depth == Some(depth) {
                    skip_depth = None;
                }
                depth -= 1;
            }
            '\\' => {
                let next = chars.next();
                match next {
                    Some('\'') => {
                        let h: String = chars.by_ref().take(2).collect();
                        if skip_depth.is_none() {
                            if let Ok(b) = u8::from_str_radix(&h, 16) {
                                out.push(b as char);
                            }
                        }
                    }
                    Some('\\') | Some('{') | Some('}') => {
                        if skip_depth.is_none() {
                            out.push(next.unwrap_or(' '));
                        }
                    }
                    Some('~') => out.push(' '),
                    Some(n) if n.is_ascii_alphabetic() => {
                        let mut word = String::from(n);
                        while let Some(&p) = chars.peek() {
                            if p.is_ascii_alphabetic() {
                                word.push(p);
                                chars.next();
                            } else {
                                break;
                            }
                        }
                        let mut param = String::new();
                        while let Some(&p) = chars.peek() {
                            if p.is_ascii_digit() || (p == '-' && param.is_empty()) {
                                param.push(p);
                                chars.next();
                            } else {
                                break;
                            }
                        }
                        if chars.peek() == Some(&' ') {
                            chars.next();
                        }
                        if skip_depth.is_none() {
                            match word.as_str() {
                                "par" | "line" => out.push('\n'),
                                "tab" => out.push('\t'),
                                "u" => {
                                    if let Ok(code) = param.parse::<i32>() {
                                        let code = if code < 0 { code + 65536 } else { code };
                                        if let Some(ch) = char::from_u32(code as u32) {
                                            out.push(ch);
                                        }
                                        // skip the fallback character
                                        chars.next();
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }
            '\r' | '\n' => {}
            _ => {
                if skip_depth.is_none() {
                    out.push(c);
                }
            }
        }
    }
    out.trim().to_string()
}

/// Client-side bigram shingling used for FTS (mirror of the JS helper; tests only on Rust side).
pub fn bigram_shingles(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for token in text.split(|c: char| c.is_whitespace() || c.is_ascii_punctuation()) {
        let chars: Vec<char> = token
            .chars()
            .map(|c| c.to_lowercase().next().unwrap_or(c))
            .collect();
        if chars.len() < 2 {
            if chars.len() == 1 {
                out.push(chars[0].to_string());
            }
            continue;
        }
        for w in chars.windows(2) {
            out.push(w.iter().collect());
        }
    }
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks() {
        let ms = 1_756_000_000_000i64;
        assert_eq!(
            ticks_to_ms(Some((ms + TICKS_EPOCH_OFFSET_MS) * 10_000)),
            Some(ms)
        );
        assert_eq!(ticks_to_ms(Some(12345)), None);
        assert_eq!(ticks_to_ms(None), None);
        assert_eq!(ticks_to_ms(Some(0)), None);
    }

    #[test]
    fn window_position_negative() {
        let w = parse_window_position(Some(
            "ManagedPosition=DeviceId:{DISPLAY2};Position=-1600,-240;Size=180,140",
        ))
        .unwrap();
        assert_eq!(
            (w.x, w.y, w.w, w.h),
            (Some(-1600), Some(-240), Some(180), Some(140))
        );
        assert_eq!(w.display_id.as_deref(), Some("{DISPLAY2}"));
        assert!(parse_window_position(Some("garbage")).is_none());
        assert!(parse_window_position(None).is_none());
    }

    #[test]
    fn text_field_cases_from_reference_suite() {
        let p = parse_text_field(Some(
            r"\id=8f14e45f-ceea-467a-9b0a-1c2d3e4f5a6b 周三 14:00 \b产品评审\b0\par确认 OKLCH 色板 v2.3\par\i下周补 macOS 验证\i0",
        ));
        assert_eq!(
            p.markdown,
            "周三 14:00 **产品评审**\n确认 OKLCH 色板 v2.3\n*下周补 macOS 验证*"
        );
        assert_eq!(
            p.plain,
            "周三 14:00 产品评审\n确认 OKLCH 色板 v2.3\n下周补 macOS 验证"
        );
        assert!(!p.degraded);

        let p = parse_text_field(Some(
            r"\id=dddd 买菜\par\zzz西红柿 2 斤\par\strike已买\strike0 牛奶",
        ));
        assert_eq!(p.markdown, "买菜\n西红柿 2 斤\n~~已买~~牛奶");
        assert!(p.degraded);

        let p = parse_text_field(Some("a\\pard b"));
        assert!(p.degraded); // \pard is unknown, not "\par" + "d"
        assert_eq!(p.markdown, "ab");
    }

    #[test]
    fn server_version_walk() {
        let j = r#"{"document":{"blocks":[{"content":[{"text":"服务器续费"},{"text":"到期 11/20"}]}]}}"#;
        assert_eq!(
            parse_server_version(Some(j)).as_deref(),
            Some("服务器续费\n到期 11/20")
        );
        assert!(parse_server_version(Some("not json")).is_none());
        assert!(parse_server_version(Some(r#"{"a":[]}"#)).is_none());
    }

    #[test]
    fn rtf_basic() {
        let rtf = r"{\rtf1\ansi{\fonttbl{\f0 Segoe UI;}}\f0\fs20 Hello\par W\'f6rld \u20320?!}";
        assert_eq!(rtf_to_text(rtf), "Hello\nWörld 你!");
    }

    #[test]
    fn shingles() {
        assert_eq!(bigram_shingles("你好世界 ab"), "你好 好世 世界 ab");
        assert_eq!(bigram_shingles("x"), "x");
    }
}
