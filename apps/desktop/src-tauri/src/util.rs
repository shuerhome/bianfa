//! Small shared helpers (time, base64, ids, random bytes).

use base64::Engine;

pub fn now_ms() -> i64 {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    d.as_millis() as i64
}

pub fn b64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    base64::engine::general_purpose::STANDARD.decode(s.trim())
}

pub fn b64url_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn b64url_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s.trim().trim_end_matches('='))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(s.trim()))
}

pub fn uuid_v7() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub fn uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    // getrandom failing means the OS RNG is broken; fall back to uuid entropy rather than panic.
    if getrandom::fill(&mut buf).is_err() {
        for chunk in buf.chunks_mut(16) {
            let u = uuid::Uuid::new_v4();
            let b = u.as_bytes();
            chunk.copy_from_slice(&b[..chunk.len()]);
        }
    }
    buf
}

/// UTC calendar day (YYYY-MM-DD) for a unix-ms timestamp.
pub fn utc_day(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    match time::OffsetDateTime::from_unix_timestamp(secs) {
        Ok(t) => format!("{:04}-{:02}-{:02}", t.year(), u8::from(t.month()), t.day()),
        Err(_) => "1970-01-01".to_string(),
    }
}

/// ISO-8601 (seconds precision, UTC) for a unix-ms timestamp.
pub fn ms_to_iso(ms: i64) -> Option<String> {
    let secs = ms.div_euclid(1000);
    let t = time::OffsetDateTime::from_unix_timestamp(secs).ok()?;
    let fmt =
        time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]+00:00");
    t.format(&fmt).ok()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(bytes))
}

pub fn blake3_hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// First 120 chars of the plain text, single line.
pub fn excerpt(text: &str, max_chars: usize) -> String {
    text.trim()
        .chars()
        .filter(|c| *c != '\r')
        .map(|c| if c == '\n' { ' ' } else { c })
        .take(max_chars)
        .collect()
}

/// First non-empty line, trimmed, truncated to `max_chars` characters.
pub fn first_line(text: &str, max_chars: usize) -> String {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .chars()
        .take(max_chars)
        .collect()
}

/// Title = first non-empty line (≤ 60 chars).
pub fn title_of(text: &str) -> String {
    first_line(text, 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_and_iso() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(
            ms_to_iso(1_700_000_000_000).as_deref(),
            Some("2023-11-14T22:13:20+00:00")
        );
    }

    #[test]
    fn excerpt_and_title() {
        assert_eq!(excerpt("  a\nb\n", 10), "a b");
        assert_eq!(title_of("\n\n  hello\nworld"), "hello");
        assert_eq!(first_line("\n 你好世界 \nx", 2), "你好");
        assert_eq!(first_line("   \n\n", 5), "");
    }
}
