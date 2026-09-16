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
                let ms = segment.ms.min(5000);
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
