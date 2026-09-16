// 共享数据与页面：与网页版（index.js）用的是同一份 data/*.json 与 src/index.html，
// 编译期内嵌进 exe，绿色版不需要额外带任何文件。
//
// 页面里的占位标记形如 /*__DATA:键名__*/，替换表与 index.js 的 renderPage() 一一对应。
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

const PAGE_TEMPLATE: &str = include_str!("../../src/index.html");
const VOICES_JSON: &str = include_str!("../../data/voices.json");
const LABELS_JSON: &str = include_str!("../../data/labels.json");

static DATA: OnceLock<AppData> = OnceLock::new();

pub struct AppData {
    voices: Value,
    labels: Value,
    /// 语音 id → locale（xml:lang），规则与 index.js 的 VOICE_INDEX 一致
    locales: HashMap<String, String>,
}

impl AppData {
    fn load() -> Self {
        let voices: Value = serde_json::from_str(VOICES_JSON).expect("data/voices.json 解析失败");
        let labels: Value = serde_json::from_str(LABELS_JSON).expect("data/labels.json 解析失败");
        let locales = build_locales(&voices);
        Self { voices, labels, locales }
    }

    pub fn get() -> &'static AppData {
        DATA.get_or_init(AppData::load)
    }

    /// 把页面里的占位标记换成注入数据；少任何一个标记都直接报错，避免返回半截页面
    pub fn render_page(&self) -> Result<String, String> {
        let promotion = &self.labels["promotion"];
        let values: Vec<(&str, String)> = vec![
            ("VOICE_CATALOG", json(&self.voices["voiceCatalog"])),
            ("MULTITALKER_SPEAKERS", json(&self.voices["multitalkerSpeakers"])),
            ("STYLE_LABELS", json(&self.labels["styleLabels"])),
            ("PARALINGUISTIC_LABELS", json(&self.labels["paralinguisticLabels"])),
            ("PARALINGUISTICS", json(&self.labels["paralinguistics"])),
            ("HD_STYLES", json(&self.labels["hdStyles"])),
            ("HD_OMNI_STYLES", json(&self.labels["hdOmniStyles"])),
            ("STYLES_UNKNOWN", json(&self.labels["stylesUnknown"])),
            ("TEXT_PLACEHOLDERS", json(&self.labels["textPlaceholders"])),
            // 运行环境：页面据此显示自绘窗口按钮（注意要产出带引号的 JS 字符串）
            ("RUNTIME", "\"desktop\"".to_string()),
            ("PROMOTION", json(promotion)),
            ("PROMOTION.title", text(promotion, "title")),
            ("PROMOTION.subtitle", text(promotion, "subtitle")),
            ("PROMOTION.qrCodeUrl", text(promotion, "qrCodeUrl")),
            ("PROMOTION.qrCodeAlt", text(promotion, "qrCodeAlt")),
            ("PROMOTION.name", text(promotion, "name")),
            ("PROMOTION.description", text(promotion, "description")),
            ("PROMOTION.benefits", benefits(promotion)),
        ];

        let mut html = PAGE_TEMPLATE.to_string();
        for (key, value) in values {
            let marker = format!("/*__DATA:{}__*/", key);
            if !html.contains(&marker) {
                return Err(format!("页面缺少占位标记：{}", key));
            }
            html = html.replace(&marker, &value);
        }
        if html.contains("__DATA:") {
            return Err("页面里仍有未替换的占位标记".to_string());
        }
        Ok(html)
    }

    /// 语音名 → locale；目录外的语音（接口直传）按前缀兜底推断
    pub fn locale_of_voice(&self, voice_id: &str) -> String {
        if let Some(locale) = self.locales.get(voice_id) {
            return locale.clone();
        }
        let head = voice_id.split(':').next().unwrap_or(voice_id);
        let mut parts = head.split('-');
        match (parts.next(), parts.next()) {
            (Some(a), Some(b)) => format!("{}-{}", a, b),
            (Some(a), None) => a.to_string(),
            _ => String::new(),
        }
    }
}

/// 渲染结果只算一次：页面 250KB、18 次替换，开窗口 / 刷新 / 重载都直接命中
static PAGE: OnceLock<Result<String, String>> = OnceLock::new();

pub fn page() -> Result<&'static str, String> {
    match PAGE.get_or_init(|| AppData::get().render_page()) {
        Ok(html) => Ok(html.as_str()),
        Err(message) => Err(message.clone()),
    }
}

fn json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn text(promotion: &Value, field: &str) -> String {
    promotion.get(field).and_then(Value::as_str).unwrap_or("").to_string()
}

fn benefits(promotion: &Value) -> String {
    let empty = Vec::new();
    promotion
        .get("benefits")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .filter_map(Value::as_str)
        .map(|item| format!("<li>{}</li>", item))
        .collect()
}

/// 复刻 index.js 的 VOICE_INDEX：locale 取 v.locale → group.locale → 对话音色前缀 → 语言页签
fn build_locales(voices: &Value) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let multitalker = &voices["multitalkerLocale"];
    let empty = Vec::new();
    let catalog = voices["voiceCatalog"].as_array().unwrap_or(&empty);

    for lang in catalog {
        let lang_locale = lang.get("locale").and_then(Value::as_str).unwrap_or("").to_string();
        let groups = lang.get("groups").and_then(Value::as_array);

        for group in groups.into_iter().flatten() {
            let family = group.get("family").and_then(Value::as_str).unwrap_or("");
            let group_locale = group.get("locale").and_then(Value::as_str).map(str::to_string);

            for voice in group.get("voices").and_then(Value::as_array).into_iter().flatten() {
                let id = match voice.get("id").and_then(Value::as_str) {
                    Some(id) => id,
                    None => continue,
                };
                let by_prefix = if family == "multitalker" {
                    id.split('-')
                        .next()
                        .and_then(|prefix| multitalker.get(prefix))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                } else {
                    None
                };
                let locale = voice
                    .get("locale")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(group_locale.clone())
                    .or(by_prefix)
                    .unwrap_or_else(|| lang_locale.clone());
                map.insert(id.to_string(), locale);
            }
        }
    }
    map
}
