// 合成链路：切句分块 → 并发合成 → 音频拼回一整段。
// 与 index.js 的 optimizedTextSplit / runPool / postTtsSsml / getVoice 等一一对应。
use reqwest::Client;
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;
use tokio::task::JoinSet;
use tokio::time::sleep;

use crate::auth;
use crate::ssml::{self, Segment, SegmentKind, VoiceOpts};

/// 并发度：与网页版一致
pub const TTS_CONCURRENCY: usize = 5;

const MAX_CHARS: usize = 1500;
const MAX_GROUPS: usize = 40;
const MAX_CHUNK_CHARS: usize = 2000;
const MAX_RETRIES: usize = 3;
const RETRY_BASE_MS: u64 = 500;

type AudioFuture = Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send>>;

/// 一轮对话
#[derive(Clone, Debug)]
pub struct Turn {
    /// 'a' 或 'b'
    pub key: String,
    pub speaker: String,
    pub segments: Vec<Segment>,
}

// ---------------------------------------------------------------- 对外入口

/// 纯文本合成
pub async fn voice(input: &str, voice_name: &str, opts: &VoiceOpts) -> Result<Vec<u8>, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("文本内容为空".to_string());
    }

    if char_len(text) <= MAX_CHARS {
        let client = auth::client();
        return audio_chunk(&client, text, voice_name, opts).await;
    }

    let chunks = split_text(text, MAX_CHARS);
    if chunks.len() > MAX_GROUPS {
        return Err(format!(
            "文本过长，分块数量({})超过限制。请缩短文本或分批处理。",
            chunks.len()
        ));
    }

    let client = auth::client();
    let jobs: Vec<(usize, AudioFuture)> = chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| {
            let client = client.clone();
            let voice = voice_name.to_string();
            let opts = opts.clone();
            (index, Box::pin(async move { audio_chunk(&client, &chunk, &voice, &opts).await }) as AudioFuture)
        })
        .collect();

    Ok(concat(run_limited(jobs, TTS_CONCURRENCY).await?))
}

/// 含停顿 / 副语言芯片的普通语音
pub async fn segmented_voice(segments: &[Segment], voice_name: &str, opts: &VoiceOpts) -> Result<Vec<u8>, String> {
    let groups = group_by_length(segments, Segment::length, MAX_CHARS, MAX_GROUPS, "内容")?;
    if groups.is_empty() {
        return Err("文本内容为空".to_string());
    }

    let client = auth::client();
    let jobs: Vec<(usize, AudioFuture)> = groups
        .into_iter()
        .enumerate()
        .map(|(index, group)| {
            let client = client.clone();
            let voice = voice_name.to_string();
            let opts = opts.clone();
            (
                index,
                Box::pin(async move {
                    let ssml = ssml::get_segments_ssml(&group, &voice, &opts);
                    post_ssml(&client, &ssml, opts.output_format()).await
                }) as AudioFuture,
            )
        })
        .collect();

    Ok(concat(run_limited(jobs, TTS_CONCURRENCY).await?))
}

/// 多人对话：turn 是最小单位，绝不切开
pub async fn dialogue_voice(
    turns: Vec<Turn>,
    voice_name: &str,
    opts_a: &VoiceOpts,
    opts_b: &VoiceOpts,
    speaker_a: &str,
    speaker_b: &str,
) -> Result<Vec<u8>, String> {
    let list: Vec<Turn> = turns
        .into_iter()
        .map(|turn| normalize_turn(turn, speaker_a, speaker_b))
        .filter(|turn| turn.segments.iter().any(|s| s.length() > 0))
        .collect();
    if list.is_empty() {
        return Err("对话内容为空，请至少写一句话".to_string());
    }

    let groups = group_by_length(&list, turn_length, MAX_CHARS, MAX_GROUPS, "对话")?;
    let client = auth::client();
    let jobs: Vec<(usize, AudioFuture)> = groups
        .into_iter()
        .enumerate()
        .map(|(index, group)| {
            let client = client.clone();
            let voice = voice_name.to_string();
            let opts_a = opts_a.clone();
            let opts_b = opts_b.clone();
            (
                index,
                Box::pin(async move {
                    let ssml = ssml::get_dialogue_ssml(&group, &voice, &opts_a, &opts_b);
                    post_ssml(&client, &ssml, opts_a.output_format()).await
                }) as AudioFuture,
            )
        })
        .collect();

    Ok(concat(run_limited(jobs, TTS_CONCURRENCY).await?))
}

// ---------------------------------------------------------------- 单块合成

pub async fn audio_chunk(client: &Client, text: &str, voice_name: &str, opts: &VoiceOpts) -> Result<Vec<u8>, String> {
    // 文本末尾的 [500] 是延迟标记，取出来变成收尾停顿
    let (body, silence_ms) = take_tail_silence(text);
    if body.trim().is_empty() {
        return Err("文本块为空".to_string());
    }
    let length = char_len(&body);
    if length > MAX_CHUNK_CHARS {
        return Err(format!("文本块过长: {} 字符，最大支持2000字符", length));
    }
    let ssml = ssml::get_ssml(&body, voice_name, opts, silence_ms);
    post_ssml(client, &ssml, opts.output_format()).await
}

struct PostError {
    message: String,
    /// 429 / 5xx / 网络错误才重试
    retryable: bool,
}

/// 把 SSML 发到 Edge TTS 端点，429 与 5xx 按 500/1000/1500ms 退避重试
pub async fn post_ssml(client: &Client, ssml: &str, output_format: &str) -> Result<Vec<u8>, String> {
    for attempt in 0..=MAX_RETRIES {
        match post_once(client, ssml, output_format).await {
            Ok(bytes) => return Ok(bytes),
            Err(error) => {
                if attempt == MAX_RETRIES || !error.retryable {
                    if attempt == MAX_RETRIES {
                        return Err(format!("音频生成失败（已重试{}次）: {}", MAX_RETRIES, error.message));
                    }
                    return Err(error.message);
                }
                sleep(Duration::from_millis(RETRY_BASE_MS * (attempt as u64 + 1))).await;
            }
        }
    }
    Err("音频生成失败".to_string())
}

async fn post_once(client: &Client, ssml: &str, output_format: &str) -> Result<Vec<u8>, PostError> {
    let endpoint = auth::get_endpoint(client)
        .await
        .map_err(|message| PostError { message, retryable: true })?;
    let url = format!("https://{}.tts.speech.microsoft.com/cognitiveservices/v1", endpoint.r);

    let response = client
        .post(&url)
        .header("Authorization", endpoint.t)
        .header("Content-Type", "application/ssml+xml")
        .header("User-Agent", auth::USER_AGENT)
        .header("X-Microsoft-OutputFormat", output_format)
        .body(ssml.to_string())
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return Err(PostError {
                message: format!("网络错误: {}", error),
                retryable: true,
            })
        }
    };

    let status = response.status();
    if status.is_success() {
        return response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|error| PostError {
                message: format!("读取音频失败: {}", error),
                retryable: true,
            });
    }

    let detail = response.text().await.unwrap_or_default();
    let code = status.as_u16();
    if code == 429 {
        return Err(PostError { message: "请求频率过高".to_string(), retryable: true });
    }
    if status.is_server_error() {
        return Err(PostError {
            message: format!("Edge TTS服务器错误: {} {}", code, detail),
            retryable: true,
        });
    }
    Err(PostError {
        message: format!("Edge TTS API错误: {} {}", code, detail),
        retryable: false,
    })
}

// ---------------------------------------------------------------- 并发与拼接

/// 并发跑任务，结果按原下标回填 —— 音频拼接顺序必须和分组顺序一致
pub async fn run_limited(jobs: Vec<(usize, AudioFuture)>, concurrency: usize) -> Result<Vec<Vec<u8>>, String> {
    if jobs.is_empty() {
        return Ok(Vec::new());
    }

    let mut running: JoinSet<(usize, Result<Vec<u8>, String>)> = JoinSet::new();
    let mut pending = jobs.into_iter();

    for _ in 0..concurrency {
        match pending.next() {
            Some((index, future)) => {
                running.spawn(async move { (index, future.await) });
            }
            None => break,
        }
    }

    let mut done: Vec<(usize, Result<Vec<u8>, String>)> = Vec::new();
    while let Some(joined) = running.join_next().await {
        match joined {
            Ok(item) => done.push(item),
            Err(error) => return Err(format!("合成任务异常: {}", error)),
        }
        if let Some((index, future)) = pending.next() {
            running.spawn(async move { (index, future.await) });
        }
    }

    done.sort_by_key(|(index, _)| *index);
    done.into_iter().map(|(_, result)| result).collect()
}

fn concat(parts: Vec<Vec<u8>>) -> Vec<u8> {
    parts.concat()
}

// ---------------------------------------------------------------- 切分与分组

/// 按句切分：中英文标点 + 换行都算句末，标点跟着句子走（补齐句点会污染英文文本）
pub fn split_text(text: &str, max_chars: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut pieces: Vec<String> = Vec::new();
    let mut index = 0;

    while index < chars.len() {
        let current = chars[index];
        if current == '\n' {
            let start = index;
            while index < chars.len() && chars[index] == '\n' {
                index += 1;
            }
            pieces.push(chars[start..index].iter().collect());
        } else if !is_sentence_end(current) {
            let start = index;
            while index < chars.len() && !is_sentence_end(chars[index]) && chars[index] != '\n' {
                index += 1;
            }
            while index < chars.len() && is_sentence_end(chars[index]) {
                index += 1;
            }
            pieces.push(chars[start..index].iter().collect());
        } else {
            // 孤立的句末标点：网页版的正则在这里匹配不到，直接跳过
            index += 1;
        }
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for piece in pieces {
        if piece.trim().is_empty() {
            continue;
        }
        if char_len(&current) + char_len(&piece) > max_chars {
            flush(&mut chunks, std::mem::take(&mut current), max_chars);
        }
        current.push_str(&piece);
    }
    flush(&mut chunks, current, max_chars);
    chunks
}

fn flush(chunks: &mut Vec<String>, piece: String, max_chars: usize) {
    let part = piece.trim();
    if part.is_empty() {
        return;
    }
    if char_len(part) <= max_chars {
        chunks.push(part.to_string());
        return;
    }

    // 超长句：优先在空格处断开，避免把单词切成两半
    let mut rest: Vec<char> = part.chars().collect();
    while rest.len() > max_chars {
        let space = rest[..=max_chars].iter().rposition(|c| *c == ' ');
        let cut = match space {
            Some(0) | None => max_chars,
            Some(position) => position,
        };
        chunks.push(rest[..cut].iter().collect::<String>().trim().to_string());
        rest = rest[cut..].iter().collect::<String>().trim().chars().collect();
    }
    if !rest.is_empty() {
        chunks.push(rest.iter().collect());
    }
}

fn is_sentence_end(ch: char) -> bool {
    matches!(ch, '。' | '！' | '？' | '!' | '?' | '.' | '；' | ';' | '…')
}

/// 按长度阈值分组：元素整体进出，绝不切开
pub fn group_by_length<T, F>(
    items: &[T],
    length_of: F,
    max_chars: usize,
    max_groups: usize,
    label: &str,
) -> Result<Vec<Vec<T>>, String>
where
    T: Clone,
    F: Fn(&T) -> usize,
{
    let mut groups: Vec<Vec<T>> = Vec::new();
    let mut current: Vec<T> = Vec::new();
    let mut size = 0;

    for item in items {
        let length = length_of(item);
        if !current.is_empty() && size + length > max_chars {
            groups.push(std::mem::take(&mut current));
            size = 0;
        }
        size += length;
        current.push(item.clone());
    }
    if !current.is_empty() {
        groups.push(current);
    }

    if groups.len() > max_groups {
        return Err(format!(
            "{}过长，分块数量({})超过限制。请缩短内容或分批处理。",
            label,
            groups.len()
        ));
    }
    Ok(groups)
}

/// 文本末尾的 [500] 是延迟标记
fn take_tail_silence(text: &str) -> (String, u32) {
    let end = text.trim_end().len();
    let head = &text[..end];
    if !head.ends_with(']') {
        return (text.to_string(), 0);
    }
    if let Some(start) = head.rfind('[') {
        let digits = &head[start + 1..head.len() - 1];
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            let ms = digits.parse::<u32>().unwrap_or(0);
            return (format!("{}{}", &head[..start], &text[end..]), ms);
        }
    }
    (text.to_string(), 0)
}

// ---------------------------------------------------------------- 入参解析

/// 把「a: 文本 / b: 文本」的行格式解析成轮次；无前缀的行并入上一句
pub fn parse_dialogue_turns(text: &str, speaker_a: &str, speaker_b: &str) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    let mut last = 'a';

    for raw in text.split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((key, content)) = split_speaker(line) {
            last = key;
            if content.is_empty() {
                continue;
            }
            turns.push(Turn {
                key: key.to_string(),
                speaker: if key == 'a' { speaker_a.to_string() } else { speaker_b.to_string() },
                segments: vec![Segment::text(content)],
            });
        } else if let Some(turn) = turns.last_mut() {
            match turn.segments.last_mut() {
                Some(segment) => {
                    segment.append("\n");
                    segment.append(line);
                }
                None => turn.segments.push(Segment::text(line)),
            }
        } else {
            turns.push(Turn {
                key: last.to_string(),
                speaker: if last == 'a' { speaker_a.to_string() } else { speaker_b.to_string() },
                segments: vec![Segment::text(line)],
            });
        }
    }
    turns
}

/// 行首的 a: / b:（全半角冒号、大小写都认）
fn split_speaker(line: &str) -> Option<(char, String)> {
    let chars: Vec<char> = line.chars().collect();
    let first = chars.first()?.to_ascii_lowercase();
    if first != 'a' && first != 'b' {
        return None;
    }
    let mut index = 1;
    while index < chars.len() && chars[index].is_whitespace() {
        index += 1;
    }
    if chars.get(index)? != &':' && chars.get(index)? != &'：' {
        return None;
    }
    index += 1;
    while index < chars.len() && chars[index].is_whitespace() {
        index += 1;
    }
    Some((first, chars[index..].iter().collect::<String>().trim().to_string()))
}

/// 兼容三种来源：前端逐行编辑（key + segments）、上传 txt（text）、旧调用
pub fn turn_from_json(value: &Value) -> Turn {
    let key = match value.get("key").and_then(Value::as_str) {
        Some("b") => "b",
        _ => "a",
    };
    let segments = match value.get("segments").and_then(Value::as_array) {
        Some(items) => segments_from_json(items),
        None => vec![Segment::text(as_text(value.get("text")))],
    };
    Turn {
        key: key.to_string(),
        speaker: value.get("speaker").and_then(Value::as_str).unwrap_or("").to_string(),
        segments,
    }
}

fn normalize_turn(turn: Turn, speaker_a: &str, speaker_b: &str) -> Turn {
    if !turn.speaker.is_empty() {
        return turn;
    }
    let speaker = if turn.key == "b" { speaker_b } else { speaker_a };
    Turn { speaker: speaker.to_string(), ..turn }
}

pub fn segments_from_json(items: &[Value]) -> Vec<Segment> {
    items.iter().filter_map(segment_from_json).collect()
}

fn segment_from_json(value: &Value) -> Option<Segment> {
    let kind = match value.get("type").and_then(Value::as_str).unwrap_or("text") {
        "pause" => SegmentKind::Pause,
        "para" => SegmentKind::Para,
        _ => SegmentKind::Text,
    };
    let raw = match kind {
        SegmentKind::Para => value.get("tag"),
        _ => value.get("value"),
    };
    let text = as_text(raw);
    let ms = value
        .get("ms")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0) as u32;
    Some(Segment { kind, text, ms })
}

pub fn turn_length(turn: &Turn) -> usize {
    turn.segments.iter().map(Segment::length).sum()
}

fn as_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    }
}

fn char_len(text: &str) -> usize {
    text.chars().count()
}
