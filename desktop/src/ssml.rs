// SSML 装配：与 index.js 的 escapeXmlText / ssmlEnvelope / withStyle / getSsml 保持一致，
// 连缩进与换行都一样，方便两边对拍。
use crate::data;

pub const SYNTHESIS_NS: &str = "http://www.w3.org/2001/10/synthesis";
/// 普通语音用 http；多人对话必须用 https（官方示例如此）
pub const MSTTS_HTTP: &str = "http://www.w3.org/2001/mstts";
pub const MSTTS_HTTPS: &str = "https://www.w3.org/2001/mstts";

const DEFAULT_RATE: &str = "+0%";
const DEFAULT_PITCH: &str = "+0Hz";
const DEFAULT_VOLUME: &str = "+0%";
const DEFAULT_OUTPUT_FORMAT: &str = "audio-24khz-96kbitrate-mono-mp3";

/// 语音参数：字段为空表示「调用方没给」，取用时才套默认值（与 JS 的 || 兜底同义）
#[derive(Clone, Debug, Default)]
pub struct VoiceOpts {
    pub rate: String,
    pub pitch: String,
    pub volume: String,
    pub style: String,
    pub styledegree: f64,
    pub output_format: String,
}

impl VoiceOpts {
    pub fn rate(&self) -> &str {
        pick(&self.rate, DEFAULT_RATE)
    }
    pub fn pitch(&self) -> &str {
        pick(&self.pitch, DEFAULT_PITCH)
    }
    pub fn volume(&self) -> &str {
        pick(&self.volume, DEFAULT_VOLUME)
    }
    pub fn style(&self) -> &str {
        &self.style
    }
    /// 官方默认 1；0 与非法值同样按 1 处理（与 JS 的 Number(x) || 1 一致）
    pub fn styledegree(&self) -> f64 {
        if self.styledegree.is_finite() && self.styledegree > 0.0 {
            self.styledegree
        } else {
            1.0
        }
    }
    pub fn output_format(&self) -> &str {
        pick(&self.output_format, DEFAULT_OUTPUT_FORMAT)
    }

    /// 把接口的 speed / volume / pitch 换算成 Edge 需要的 rate / pitch / volume
    pub fn from_params(speed: &str, volume: &str, pitch: &str, style: &str, styledegree: Option<f64>) -> Self {
        let rate = ((parse_f64(speed).unwrap_or(1.0) - 1.0) * 100.0) as i64;
        let volume_num = (parse_f64(volume).unwrap_or(0.0) * 100.0) as i64;
        let pitch_num = pitch.trim().parse::<i64>().unwrap_or(0);

        Self {
            rate: signed(rate, "%"),
            pitch: format!("{}{}Hz", plus_if_positive(pitch_num), pitch_num),
            volume: signed(volume_num, "%"),
            // 'general' 不是微软的合法风格值，历史上一直被服务端忽略，这里当作「不指定」
            style: if style.is_empty() || style == "general" {
                String::new()
            } else {
                style.to_string()
            },
            styledegree: styledegree.unwrap_or(0.0),
            output_format: String::new(),
        }
    }
}

fn pick<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.is_empty() { fallback } else { value }
}

fn parse_f64(value: &str) -> Option<f64> {
    let parsed = value.trim().parse::<f64>().ok()?;
    if parsed.is_finite() { Some(parsed) } else { None }
}

fn signed(value: i64, unit: &str) -> String {
    format!("{}{}{}", plus_if_positive(value), value, unit)
}

fn plus_if_positive(value: i64) -> &'static str {
    if value >= 0 { "+" } else { "" }
}

/// 片段类型：文本 / 停顿 / 副语言
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SegmentKind {
    Text,
    Pause,
    Para,
}

#[derive(Clone, Debug)]
pub struct Segment {
    pub kind: SegmentKind,
    /// Text 的正文；Para 的标记名（如 laughter）
    pub text: String,
    /// 停顿毫秒数（仅 Pause 有意义）
    pub ms: u32,
}

impl Segment {
    pub fn text(value: impl Into<String>) -> Self {
        Self { kind: SegmentKind::Text, text: value.into(), ms: 0 }
    }

    /// 计入分组长度：停顿不算字符
    pub fn length(&self) -> usize {
        match self.kind {
            SegmentKind::Text => self.text.chars().count(),
            SegmentKind::Para => self.text.chars().count() + 2,
            SegmentKind::Pause => 0,
        }
    }

    pub fn append(&mut self, extra: &str) {
        self.text.push_str(extra);
    }
}

// ===========================================================================
// 纯文本里的标记：[停顿 2s] / [2s] / [500ms] / [laughter]（手打或上传的 txt）
// ---------------------------------------------------------------------------
// 规则与页面（src/index.html）和网页端（index.js）逐字一致：带单位一律认，
// 不带单位必须带「停顿」字样（否则 [1] / [2024] 这类方括号会被当成停顿吞掉）；
// 副语言只在非对话场景解析 —— MultiTalker 不支持，页面里同样是这个门控。
// ===========================================================================

/// 方括号标记的字节区间 [内容起, 内容止)，与页面的 `\[([^\]]+)\]` 同一口径：
/// 内容里允许再出现 `[`（取其后第一个 `]`），但内容不能为空
fn mark_spans(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'[' {
            if let Some(offset) = text[index + 1..].find(']') {
                let end = index + 1 + offset;
                if end > index + 1 {
                    spans.push((index, end));
                    index = end + 1;
                    continue;
                }
            }
        }
        index += 1;
    }
    spans
}

/// 与页面正则 `^([0-9]+(?:[.][0-9]+)?)$` 同一口径的数字
fn number_of(text: &str) -> Option<f64> {
    let mut parts = text.split('.');
    let int = parts.next().unwrap_or("");
    let frac = parts.next();
    if parts.next().is_some() || int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if let Some(frac) = frac {
        if frac.is_empty() || !frac.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    text.parse::<f64>().ok()
}

/// 「2s / 2.5s / 500ms / 停顿 2s / 停顿 500」→ 毫秒；不是时长返回 0
fn parse_pause_ms(text: &str) -> u32 {
    let raw = text.trim();
    let body = raw.replace("停顿", "");
    let body = body.trim();
    let (digits, scale) = if let Some(head) = body.strip_suffix("ms") {
        (head, 1.0)
    } else if let Some(head) = body.strip_suffix('s') {
        (head, 1000.0)
    } else if raw.contains("停顿") {
        // 无单位只有带「停顿」字样才算毫秒
        (body, 1.0)
    } else {
        return 0;
    };
    match number_of(digits) {
        Some(value) if value > 0.0 => (value * scale).round() as u32,
        _ => 0,
    }
}

/// 纯文本 → 片段数组；一处标记都没有时返回 None（调用方照旧走纯文本链路）
pub fn parse_text_marks(text: &str, allow_para: bool) -> Option<Vec<Segment>> {
    let mut out: Vec<Segment> = Vec::new();
    let mut last = 0;
    for (start, end) in mark_spans(text) {
        let tag = text[start + 1..end].trim().to_lowercase();
        let segment = if allow_para && data::AppData::get().is_paralinguistic(&tag) {
            Segment { kind: SegmentKind::Para, text: tag, ms: 0 }
        } else {
            let ms = parse_pause_ms(&tag);
            if ms == 0 {
                continue;
            }
            Segment { kind: SegmentKind::Pause, text: String::new(), ms }
        };
        if start > last {
            out.push(Segment::text(&text[last..start]));
        }
        out.push(segment);
        last = end + 1;
    }
    if out.is_empty() {
        return None;
    }
    if last < text.len() {
        out.push(Segment::text(&text[last..]));
    }
    Some(out)
}

/// 标记规则的自检：三端（页面 / index.js / 这里）必须逐字一致，改规则时先跑这个
#[cfg(test)]
mod marker_tests {
    use super::*;

    /// 片段压成 (类型, 文本, 毫秒)，方便直接比对
    fn brief(marks: Option<Vec<Segment>>) -> Vec<(SegmentKind, String, u32)> {
        marks.unwrap_or_default().into_iter().map(|s| (s.kind, s.text, s.ms)).collect()
    }

    #[test]
    fn marker_rules() {
        // 停顿时长：带单位一律认，无单位必须带「停顿」字样
        for (text, want) in [("停顿 2s", 2000), ("停顿 500", 500), ("2s", 2000), ("500ms", 500), ("500", 0), ("1", 0), ("2024", 0)] {
            assert_eq!(parse_pause_ms(text), want, "{}", text);
        }
        // 没有标记 → None（调用方走纯文本）；未识别的方括号原样留在文本里
        assert!(parse_text_marks("你好，世界", true).is_none());
        assert!(parse_text_marks("引用[1]与[2024]年", true).is_none());
        // 副语言只在允许时拆；对话模式不认副语言，但停顿照拆
        assert_eq!(brief(parse_text_marks("[ Laughter ]", true)), vec![(SegmentKind::Para, "laughter".to_string(), 0)]);
        assert_eq!(
            brief(parse_text_marks("甲[laughter]乙[2s]丙", false)),
            vec![
                (SegmentKind::Text, "甲[laughter]乙".to_string(), 0),
                (SegmentKind::Pause, String::new(), 2000),
                (SegmentKind::Text, "丙".to_string(), 0),
            ]
        );
        // 与页面正则同一口径：内容里允许再出现 [（取其后第一个 ]）
        assert_eq!(mark_spans("[a[b]"), vec![(0, 4)]);
    }
}

pub fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

pub fn envelope(voice_name: &str, inner: &str, mstts_ns: &str) -> String {
    let locale = data::AppData::get().locale_of_voice(voice_name);
    format!(
        "<speak xmlns=\"{synthesis}\" xmlns:mstts=\"{mstts}\" version=\"1.0\" xml:lang=\"{locale}\"> \n                <voice name=\"{voice}\"> \n                    {inner}\n                </voice> \n            </speak>",
        synthesis = SYNTHESIS_NS,
        mstts = mstts_ns,
        locale = locale,
        voice = voice_name,
        inner = inner
    )
}

/// 指定风格时才包 express-as，否则让服务端直接用中性语音
pub fn with_style(inner: &str, opts: &VoiceOpts) -> String {
    let style = opts.style();
    if style.is_empty() {
        return inner.to_string();
    }
    format!(
        "<mstts:express-as style=\"{style}\" styledegree=\"{degree}\">{inner}</mstts:express-as>",
        style = style,
        degree = opts.styledegree(),
        inner = inner
    )
}

pub fn get_ssml(text: &str, voice_name: &str, opts: &VoiceOpts, silence_ms: u32) -> String {
    let tail = if silence_ms > 0 {
        format!("<break time=\"{}ms\" />", silence_ms)
    } else {
        String::new()
    };
    let prosody = format!(
        "<prosody rate=\"{rate}\" pitch=\"{pitch}\" volume=\"{volume}\">{text}</prosody> {tail}",
        rate = opts.rate(),
        pitch = opts.pitch(),
        volume = opts.volume(),
        text = escape_xml(text),
        tail = tail
    );
    envelope(voice_name, &with_style(&prosody, opts), MSTTS_HTTP)
}

/// 片段 → SSML 内容（不含 express-as 包装）
pub fn segments_to_inner(segments: &[Segment], opts: &VoiceOpts) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut buffer = String::new();

    for segment in segments {
        match segment.kind {
            SegmentKind::Text => buffer.push_str(&segment.text),
            SegmentKind::Para => {
                // 副语言是写进文本的字面量，只保留字母与下划线
                buffer.push('[');
                buffer.extend(segment.text.chars().filter(|c| c.is_ascii_alphabetic() || *c == '_'));
                buffer.push(']');
            }
            SegmentKind::Pause => {
                flush_text(&mut parts, &mut buffer, opts);
                // 官方 SSML 的 break 上限是 20s（实测单条 20000ms 确实产出 20 秒静音）
                let ms = segment.ms.min(20000);
                if ms > 0 {
                    parts.push(format!("<break time=\"{}ms\"/>", ms));
                }
            }
        }
    }
    flush_text(&mut parts, &mut buffer, opts);
    parts.concat()
}

fn flush_text(parts: &mut Vec<String>, buffer: &mut String, opts: &VoiceOpts) {
    if buffer.is_empty() {
        return;
    }
    parts.push(format!(
        "<prosody rate=\"{rate}\" pitch=\"{pitch}\" volume=\"{volume}\">{text}</prosody>",
        rate = opts.rate(),
        pitch = opts.pitch(),
        volume = opts.volume(),
        text = escape_xml(buffer)
    ));
    buffer.clear();
}

pub fn get_segments_ssml(segments: &[Segment], voice_name: &str, opts: &VoiceOpts) -> String {
    envelope(
        voice_name,
        &with_style(&segments_to_inner(segments, opts), opts),
        MSTTS_HTTP,
    )
}

/// 一组轮次生成一个完整的 <mstts:dialog>
pub fn get_dialogue_ssml(turns: &[crate::tts::Turn], voice_name: &str, opts_a: &VoiceOpts, opts_b: &VoiceOpts) -> String {
    let body = turns
        .iter()
        .map(|turn| {
            let opts = if turn.key == "b" { opts_b } else { opts_a };
            format!(
                "<mstts:turn speaker=\"{speaker}\">{inner}</mstts:turn>",
                speaker = turn.speaker,
                inner = with_style(&segments_to_inner(&turn.segments, opts), opts)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let dialog = format!("<mstts:dialog>\n                        {body}\n                    </mstts:dialog>", body = body);
    envelope(voice_name, &dialog, MSTTS_HTTPS)
}

/// 普通模式：一条 speak 内多个 <voice>，男女各一个音色
/// 实测两个坑：break 写在两个 voice 之间会被判 400；写在文本「之后」会被端点吞掉。
/// 所以上一句末尾的停顿芯片和延迟补偿，都要挪到下一句的开头。
pub fn get_multi_voice_ssml(
    turns: &[crate::tts::Turn],
    male: &str,
    female: &str,
    opts_a: &VoiceOpts,
    opts_b: &VoiceOpts,
    turn_gap_ms: u32,
) -> String {
    let gap = turn_gap_ms.min(1000);
    let mut carry: u32 = 0;
    let body = turns
        .iter()
        .enumerate()
        .map(|(index, turn)| {
            let (voice, opts) = if turn.key == "b" { (female, opts_b) } else { (male, opts_a) };
            // 取出本句末尾的停顿芯片，交给下一句开头。
            // 整句只剩停顿时不再取，否则这一个 voice 会被掏空（与 JS 端同一条保护）
            let mut segments = turn.segments.clone();
            let mut tail = 0u32;
            while segments.iter().any(|s| s.length() > 0)
                && matches!(segments.last().map(|s| s.kind), Some(SegmentKind::Pause))
            {
                if let Some(seg) = segments.pop() {
                    tail += seg.ms;
                }
            }
            let lead = carry + if index > 0 { gap } else { 0 };
            carry = tail;
            // 官方 SSML 的 break 上限是 20 秒，超了会被判非法
            let brk = if lead > 0 {
                format!("<break time=\"{}ms\"/>", lead.min(20000))
            } else {
                String::new()
            };
            format!(
                "<voice name=\"{voice}\">{brk}{inner}</voice>",
                inner = with_style(&segments_to_inner(&segments, opts), opts)
            )
        })
        .collect::<Vec<_>>()
        .join("");
    format!(
        "<speak xmlns=\"{synthesis}\" xmlns:mstts=\"{mstts}\" version=\"1.0\" xml:lang=\"{locale}\">{body}</speak>",
        synthesis = SYNTHESIS_NS,
        mstts = MSTTS_HTTP,
        locale = data::AppData::get().locale_of_voice(male),
        body = body
    )
}
