// 自动生成（pnpm -F @bianfa/tokens build），勿手改；来源 packages/tokens/src/tokens.json
// 供 src-tauri 用 include!() 引入：托盘角标、窗口 background_color（alpha 恒 255）。
// 用法：#[allow(dead_code)] mod tokens { include!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/tokens/dist/tokens.rs")); }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const fn to_array(self) -> [u8; 3] {
        [self.r, self.g, self.b]
    }
    pub const fn to_rgba(self) -> [u8; 4] {
        [self.r, self.g, self.b, 255]
    }
}

/// 便笺色枚举名，顺序 = 先 10 个淡档、再 10 个浓档（同档内的序号 = noteColorInfo.slot）
pub const NOTE_COLORS: [&str; 20] = ["graphite", "rose", "coral", "amber", "citron", "fern", "teal", "azure", "violet", "fuchsia", "slate", "carmine", "vermilion", "ochre", "olive", "pine", "peacock", "indigo", "wisteria", "eggplant"];
pub const DEFAULT_NOTE_COLOR: &str = "graphite";

pub const NOTE_PAPER_LIGHT: [Rgb; 20] = [
    Rgb { r: 246, g: 245, b: 241 }, // graphite
    Rgb { r: 255, g: 239, b: 244 }, // rose
    Rgb { r: 255, g: 236, b: 233 }, // coral
    Rgb { r: 255, g: 238, b: 220 }, // amber
    Rgb { r: 253, g: 251, b: 206 }, // citron
    Rgb { r: 222, g: 255, b: 222 }, // fern
    Rgb { r: 201, g: 255, b: 249 }, // teal
    Rgb { r: 224, g: 244, b: 255 }, // azure
    Rgb { r: 240, g: 239, b: 255 }, // violet
    Rgb { r: 255, g: 234, b: 253 }, // fuchsia
    Rgb { r: 212, g: 218, b: 224 }, // slate
    Rgb { r: 255, g: 199, b: 216 }, // carmine
    Rgb { r: 255, g: 202, b: 194 }, // vermilion
    Rgb { r: 255, g: 207, b: 156 }, // ochre
    Rgb { r: 225, g: 220, b: 146 }, // olive
    Rgb { r: 174, g: 234, b: 175 }, // pine
    Rgb { r: 155, g: 233, b: 225 }, // peacock
    Rgb { r: 168, g: 225, b: 255 }, // indigo
    Rgb { r: 214, g: 212, b: 255 }, // wisteria
    Rgb { r: 254, g: 194, b: 251 }, // eggplant
];
pub const NOTE_PAPER_DARK: [Rgb; 20] = [
    Rgb { r: 37, g: 36, b: 33 }, // graphite
    Rgb { r: 52, g: 32, b: 39 }, // rose
    Rgb { r: 51, g: 30, b: 27 }, // coral
    Rgb { r: 47, g: 33, b: 18 }, // amber
    Rgb { r: 39, g: 37, b: 17 }, // citron
    Rgb { r: 26, g: 41, b: 26 }, // fern
    Rgb { r: 13, g: 42, b: 40 }, // teal
    Rgb { r: 18, g: 39, b: 50 }, // azure
    Rgb { r: 35, g: 34, b: 52 }, // violet
    Rgb { r: 45, g: 30, b: 44 }, // fuchsia
    Rgb { r: 37, g: 43, b: 49 }, // slate
    Rgb { r: 72, g: 19, b: 41 }, // carmine
    Rgb { r: 75, g: 20, b: 16 }, // vermilion
    Rgb { r: 63, g: 36, b: 0 }, // ochre
    Rgb { r: 46, g: 43, b: 0 }, // olive
    Rgb { r: 3, g: 52, b: 10 }, // pine
    Rgb { r: 0, g: 49, b: 46 }, // peacock
    Rgb { r: 0, g: 46, b: 65 }, // indigo
    Rgb { r: 41, g: 32, b: 80 }, // wisteria
    Rgb { r: 63, g: 23, b: 62 }, // eggplant
];
pub const NOTE_DOT_LIGHT: [Rgb; 20] = [
    Rgb { r: 106, g: 105, b: 100 }, // graphite
    Rgb { r: 220, g: 81, b: 138 }, // rose
    Rgb { r: 217, g: 74, b: 63 }, // coral
    Rgb { r: 195, g: 121, b: 0 }, // amber
    Rgb { r: 153, g: 144, b: 1 }, // citron
    Rgb { r: 26, g: 156, b: 49 }, // fern
    Rgb { r: 0, g: 157, b: 148 }, // teal
    Rgb { r: 0, g: 148, b: 199 }, // azure
    Rgb { r: 135, g: 113, b: 238 }, // violet
    Rgb { r: 185, g: 82, b: 183 }, // fuchsia
    Rgb { r: 94, g: 100, b: 106 }, // slate
    Rgb { r: 207, g: 19, b: 116 }, // carmine
    Rgb { r: 216, g: 21, b: 24 }, // vermilion
    Rgb { r: 163, g: 100, b: 0 }, // ochre
    Rgb { r: 127, g: 119, b: 0 }, // olive
    Rgb { r: 0, g: 141, b: 36 }, // pine
    Rgb { r: 0, g: 134, b: 127 }, // peacock
    Rgb { r: 0, g: 127, b: 172 }, // indigo
    Rgb { r: 110, g: 71, b: 226 }, // wisteria
    Rgb { r: 180, g: 47, b: 180 }, // eggplant
];
pub const NOTE_DOT_DARK: [Rgb; 20] = [
    Rgb { r: 157, g: 155, b: 150 }, // graphite
    Rgb { r: 219, g: 106, b: 149 }, // rose
    Rgb { r: 238, g: 120, b: 107 }, // coral
    Rgb { r: 223, g: 143, b: 34 }, // amber
    Rgb { r: 179, g: 169, b: 26 }, // citron
    Rgb { r: 87, g: 177, b: 93 }, // fern
    Rgb { r: 1, g: 189, b: 179 }, // teal
    Rgb { r: 0, g: 179, b: 240 }, // azure
    Rgb { r: 157, g: 144, b: 247 }, // violet
    Rgb { r: 211, g: 126, b: 208 }, // fuchsia
    Rgb { r: 127, g: 135, b: 144 }, // slate
    Rgb { r: 229, g: 72, b: 140 }, // carmine
    Rgb { r: 252, g: 89, b: 76 }, // vermilion
    Rgb { r: 211, g: 132, b: 1 }, // ochre
    Rgb { r: 166, g: 156, b: 0 }, // olive
    Rgb { r: 9, g: 171, b: 48 }, // pine
    Rgb { r: 0, g: 175, b: 166 }, // peacock
    Rgb { r: 0, g: 166, b: 223 }, // indigo
    Rgb { r: 133, g: 106, b: 246 }, // wisteria
    Rgb { r: 207, g: 90, b: 205 }, // eggplant
];

pub const CANVAS_LIGHT: Rgb = Rgb { r: 252, g: 252, b: 251 };
pub const CANVAS_DARK: Rgb = Rgb { r: 19, g: 19, b: 18 };
pub const SURFACE_1_LIGHT: Rgb = Rgb { r: 252, g: 252, b: 251 };
pub const SURFACE_1_DARK: Rgb = Rgb { r: 26, g: 26, b: 24 };
pub const ACCENT_LIGHT: Rgb = Rgb { r: 76, g: 95, b: 213 };
pub const ACCENT_DARK: Rgb = Rgb { r: 142, g: 155, b: 245 };
pub const WARNING_LIGHT: Rgb = Rgb { r: 138, g: 90, b: 0 };
pub const WARNING_DARK: Rgb = Rgb { r: 217, g: 162, b: 46 };
pub const DANGER_LIGHT: Rgb = Rgb { r: 192, g: 54, b: 44 };
pub const DANGER_DARK: Rgb = Rgb { r: 240, g: 115, b: 106 };

/// 色名 → 序号；未知 → None
pub fn note_color_index(name: &str) -> Option<usize> {
    NOTE_COLORS.iter().position(|c| *c == name)
}

/// 便笺纸面色（= 窗口底色）。未知色名按 graphite。
pub fn note_paper(name: &str, dark: bool) -> Rgb {
    let i = note_color_index(name).unwrap_or(0);
    if dark { NOTE_PAPER_DARK[i] } else { NOTE_PAPER_LIGHT[i] }
}

/// 便笺色点（托盘「最近」项的色标）。未知色名按 graphite。
pub fn note_dot(name: &str, dark: bool) -> Rgb {
    let i = note_color_index(name).unwrap_or(0);
    if dark { NOTE_DOT_DARK[i] } else { NOTE_DOT_LIGHT[i] }
}

pub fn canvas(dark: bool) -> Rgb {
    if dark { CANVAS_DARK } else { CANVAS_LIGHT }
}
