// 合成链路：切句分块 → 并发合成 → 音频拼回一整段。
// 与 index.js 的 optimizedTextSplit / runPool / postTtsSsml / getVoice 等一一对应。
use reqwest::Client;
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;
use tokio::task::JoinSet;
use tokio::time::sleep;
use base64::Engine;

use crate::auth;
use crate::ssml::{self, Segment, SegmentKind, VoiceOpts};

/// 并发度：与网页版一致
pub const TTS_CONCURRENCY: usize = 5;

const MAX_CHARS: usize = 1500;
/// 分块上限：网页版受 Cloudflare 子请求数（免费版 50）限制只能 40 组，
/// 桌面版走本机没有这层限制，放宽到 100 组（约 15 万字）
const MAX_GROUPS: usize = 100;
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

/// 听力测试的四个音色槽
#[derive(Clone, Debug, Default)]
pub struct ExamVoices {
    pub cn: String,
    pub male: String,
    pub female: String,
    pub mono: String,
}

/// 时间线上的一块：中文播报 / 一段男女对话 / 一段独白
#[derive(Clone, Debug)]
pub struct ExamBlock {
    pub kind: String,
    pub segments: Vec<Segment>,
    pub turns: Vec<ExamTurn>,
    pub repeat: usize,
    pub gap_ms: u32,
    /// 块末尾的停顿：落在音频最末尾的 break 会被 HD / MultiTalker 等音色吞掉，
    /// 所以摘出来由静音池在块后拼字节（见 exam_voice 里的「停顿路径」）
    pub pause_after_ms: u32,
    pub chime: bool,
    /// 普通模式：改用一条 speak 内多个 voice（原生模式走 mstts:dialog）
    pub plain: bool,
    /// 男女两句之间补的间隔，普通模式专用，0~1000ms
    pub turn_gap_ms: u32,
}

#[derive(Clone, Debug)]
pub struct ExamTurn {
    pub key: String,
    pub segments: Vec<Segment>,
}

/// 静音池也要带一段文本：voice 里只放静音标签、不带文本会产出 0 字节（实测）
const SILENCE_TEXT: &str = "。";
/// 静音池固定用这个音色：实测「。」在 MAI / DragonHD 系列下会被读出一个怪声，Xiaoxiao 才是纯静音
const SILENCE_VOICE: &str = "zh-CN-XiaoxiaoNeural";
/// 结尾留白按 20s 一片反复拼
const TAIL_SLICE_MS: u32 = 20000;

/// 听力测试：逐块合成后按时间线顺序拼成一整条
/// 微软的 MultiTalker 只有 2 个音色槽位，撑不起中文播报 + 男声 + 女声 + 独白，
/// 所以中文与独白走单音色、对话走 en-Multitalker，各发一次请求再拼起来。
pub async fn exam_voice(
    mut blocks: Vec<ExamBlock>,
    voices: ExamVoices,
    multitalker: &str,
    opts: &VoiceOpts,
    opts_cn: &VoiceOpts,
    opts_a: &VoiceOpts,
    opts_b: &VoiceOpts,
    opts_mono: &VoiceOpts,
    with_chime: bool,
    tail_ms: u32,
) -> Result<Vec<u8>, String> {
    if blocks.is_empty() {
        return Err("听力内容为空，请先粘贴文稿".to_string());
    }

    // =======================================================================
    // 停顿路径（2026-10-07 用 scripts/probe-silence.mjs 在真实服务上实测）
    // -----------------------------------------------------------------------
    // 一句话规律：break 只要不在整条音频的**最末尾**，就一律生效；
    // 落在最末尾时是否生效只看音色，与容器（voice / mstts:dialog）无关。
    //
    //   break 位置               中文普通音色  英文普通音色   DragonHD*   MultiTalker   MAI   DragonHDFlash
    //   块开头 / 句中 / 句间          ✅            ✅           ✅           ✅        —        ✅
    //   多 voice / 多 turn 之间       ✅            ✅           ✅           ✅        —        —
    //   整条音频的最末尾              ✅            ✅           ❌           ❌        ❌       ❌
    //
    // mstts:silence 是官方元素、本身能用，但**按音色家族分**：普通 Neural 音色
    //（晓晓、AvaNeural）认，Δ 精确；HD 家族（DragonHD 系列含 Flash / Omni、MAI、MultiTalker）
    // 全不认。已排除「写法不对」：http / https 两种命名空间、叠加型与 -exact 绝对型、
    // 标签摆在文本前（官方示例的摆法）与摆在文本后，四种写法在 HD 上 Δ 都是 0。
    // 官方 HD 支持表（.../speech-service/high-definition-voices）也把 <mstts:silence>
    // 标成 DragonHD / Dragon HD Omni 均「不支持」，与实测一致。
    // 尴尬的是：认它的普通音色本来就不吞末尾 break，会吞的那批恰好全不认它 ——
    // 所以它救不了任何场景，末尾停顿只能靠静音池在块外拼字节。
    //
    // ⚠️ 那张 HD 表只能当参考：它把 Omni 的 <break>、HD 的 <prosody> 也标成「不支持」，
    // 但实测两者在我们的端点上都生效（Omni 句尾 break Δ4000；语速 ±50% 差 1~1.8 秒）。
    // 官方表讲的是 Azure 语音服务，我们走的是 Edge 端点，别照抄，以实测为准。
    //
    // 池子也不是权宜之计，它是精确的：Xiaoxiao 读「。」实测产出 0ms，池子片段 = 请求的毫秒数
    //（raw PCM 误差 0ms；MP3 容器固定多出约 48ms）。
    // 换音色或怀疑端点行为变了，跑一次 node scripts/probe-silence.mjs 复验。
    // =======================================================================
    for block in blocks.iter_mut() {
        let extra = {
            let segs = if block.kind == "dialogue" {
                match block.turns.last_mut() {
                    Some(turn) => &mut turn.segments,
                    None => continue,
                }
            } else {
                &mut block.segments
            };
            let mut ms = 0u32;
            loop {
                let is_tail_pause = matches!(segs.last().map(|s| s.kind), Some(SegmentKind::Pause));
                let still_has_text = segs.iter().any(|s| s.length() > 0);
                if !is_tail_pause || !still_has_text {
                    break;
                }
                if let Some(seg) = segs.pop() {
                    ms += seg.ms;
                }
            }
            ms
        };
        block.pause_after_ms += extra;
    }

    // 两遍之间的间隔、对话尾巴上的停顿，各合成一次纯静音反复复用
    let mut durations: Vec<u32> = Vec::new();
    for block in &blocks {
        push_duration(&mut durations, block.gap_ms);
        push_duration(&mut durations, block.pause_after_ms);
    }
    if tail_ms > 0 {
        push_duration(&mut durations, TAIL_SLICE_MS);
    }

    let client = auth::client();
    let mut silence: std::collections::HashMap<u32, Vec<u8>> = std::collections::HashMap::new();
    if !durations.is_empty() {
        let jobs: Vec<(usize, AudioFuture)> = durations
            .iter()
            .enumerate()
            .map(|(index, ms)| {
                let client = client.clone();
                let voice = SILENCE_VOICE.to_string();
                let opts = opts.clone();
                let ms = *ms;
                (
                    index,
                    Box::pin(async move {
                        let ssml = ssml::get_ssml(SILENCE_TEXT, &voice, &opts, ms);
                        post_ssml(&client, &ssml, opts.output_format()).await
                    }) as AudioFuture,
                )
            })
            .collect();
        let chunks = run_limited(jobs, TTS_CONCURRENCY).await?;
        for (index, ms) in durations.iter().enumerate() {
            silence.insert(*ms, chunks[index].clone());
        }
    }

    // 一段录音整段进一个 mstts:dialog，中文播报与独白各一条普通 SSML
    let jobs: Vec<(usize, AudioFuture)> = blocks
        .iter()
        .enumerate()
        .map(|(index, block)| {
            let client = client.clone();
            let opts = opts.clone();
            let opts_cn = opts_cn.clone();
            let opts_a = opts_a.clone();
            let opts_b = opts_b.clone();
            let opts_mono = opts_mono.clone();
            let voices = voices.clone();
            let multitalker = multitalker.to_string();
            let block = block.clone();
            (
                index,
                Box::pin(async move {
                    if block.kind == "dialogue" {
                        let turns: Vec<Turn> = block
                            .turns
                            .iter()
                            .map(|turn| Turn {
                                key: if turn.key == "b" { "b".to_string() } else { "a".to_string() },
                                speaker: if turn.key == "b" {
                                    voices.female.to_lowercase()
                                } else {
                                    voices.male.to_lowercase()
                                },
                                segments: turn.segments.clone(),
                            })
                            .collect();
                        if !turns.iter().any(|turn| turn.segments.iter().any(|s| s.length() > 0)) {
                            return Err("有一段录音是空的，请检查 M: / W: 行".to_string());
                        }
                        // 普通模式：一条 speak 内多个 voice；原生模式照旧走 mstts:dialog
                        let item_ssml = if block.plain {
                            ssml::get_multi_voice_ssml(&turns, &voices.male, &voices.female, &opts_a, &opts_b, block.turn_gap_ms)
                        } else {
                            ssml::get_dialogue_ssml(&turns, &multitalker, &opts_a, &opts_b)
                        };
                        return post_ssml(&client, &item_ssml, opts.output_format()).await;
                    }
                    if !block.segments.iter().any(|s| s.length() > 0) {
                        return Err("有一段文稿是空的，请检查换行".to_string());
                    }
                    let is_mono = block.kind == "mono";
                    let voice = if is_mono { &voices.mono } else { &voices.cn };
                    let item_opts = if is_mono { &opts_mono } else { &opts_cn };
                    let ssml = ssml::get_segments_ssml(&block.segments, voice, item_opts);
                    post_ssml(&client, &ssml, opts.output_format()).await
                }) as AudioFuture,
            )
        })
        .collect();
    let audios = run_limited(jobs, TTS_CONCURRENCY).await?;

    // 提示音只在 MP3 输出下插：WAV 拿回来的是裸 PCM，混进 MP3 字节会解不动
    let chime = if with_chime && opts.output_format().starts_with("audio-") {
        base64::engine::general_purpose::STANDARD
            .decode(crate::chime::CHIME_B64)
            .ok()
    } else {
        None
    };

    let mut out: Vec<u8> = Vec::new();
    for (index, block) in blocks.iter().enumerate() {
        // 连播两遍时提示音只响在第一遍之前
        if block.chime {
            if let Some(bytes) = &chime {
                out.extend_from_slice(bytes);
            }
        }
        let repeat = if block.repeat > 0 { block.repeat } else { 1 };
        for round in 1..=repeat {
            out.extend_from_slice(&audios[index]);
            if round < repeat {
                if let Some(bytes) = silence.get(&block.gap_ms) {
                    out.extend_from_slice(bytes);
                }
            }
        }
        if let Some(bytes) = silence.get(&block.pause_after_ms) {
            out.extend_from_slice(bytes);
        }
    }
    if tail_ms > 0 {
        let slices = ((tail_ms + TAIL_SLICE_MS - 1) / TAIL_SLICE_MS).max(1);
        if let Some(bytes) = silence.get(&TAIL_SLICE_MS) {
            for _ in 0..slices {
                out.extend_from_slice(bytes);
            }
        }
    }

    Ok(out)
}

fn push_duration(list: &mut Vec<u32>, ms: u32) {
    if ms > 0 && !list.contains(&ms) {
        list.push(ms);
    }
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
/// 文本里的停顿标记顺手解析成片段（上传的 txt 只有纯文本，对话里不认副语言）
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
                segments: text_marks_or_text(&content),
            });
        } else if let Some(turn) = turns.last_mut() {
            // 上一段是停顿 / 副语言芯片时另起一段文本，别把文字接进芯片里
            match turn.segments.last_mut() {
                Some(segment) if segment.kind == SegmentKind::Text => {
                    segment.append("\n");
                    segment.append(line);
                }
                _ => turn.segments.push(Segment::text(line)),
            }
        } else {
            turns.push(Turn {
                key: last.to_string(),
                speaker: if last == 'a' { speaker_a.to_string() } else { speaker_b.to_string() },
                segments: text_marks_or_text(line),
            });
        }
    }
    turns
}

/// 纯文本 → 片段：有标记就用片段，没有就当一整段文本
fn text_marks_or_text(text: &str) -> Vec<Segment> {
    ssml::parse_text_marks(text, false).unwrap_or_else(|| vec![Segment::text(text)])
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

/// 听力测试的时间线：文稿解析在前端做完了，这里只负责还原
pub fn exam_blocks_from_json(value: Option<&Value>) -> Vec<ExamBlock> {
    let items = match value.and_then(Value::as_array) {
        Some(items) => items,
        None => return Vec::new(),
    };
    items.iter().filter_map(exam_block_from_json).collect()
}

fn exam_block_from_json(value: &Value) -> Option<ExamBlock> {
    let kind = json_string(value, "kind");
    if kind.is_empty() {
        return None;
    }
    let turns = value
        .get("turns")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| ExamTurn {
                    key: json_string(item, "key"),
                    segments: item
                        .get("segments")
                        .and_then(Value::as_array)
                        .map(|segments| segments_from_json(segments))
                        .unwrap_or_default(),
                })
                .filter(|turn| turn.segments.iter().any(|s| s.length() > 0))
                .collect()
        })
        .unwrap_or_default();
    Some(ExamBlock {
        kind,
        segments: value
            .get("segments")
            .and_then(Value::as_array)
            .map(|items| segments_from_json(items))
            .unwrap_or_default(),
        turns,
        repeat: json_number(value, "repeat") as usize,
        gap_ms: json_number(value, "gapMs") as u32,
        pause_after_ms: json_number(value, "pauseAfterMs") as u32,
        chime: value.get("chime").and_then(Value::as_bool).unwrap_or(false),
        plain: value.get("plain").and_then(Value::as_bool).unwrap_or(false),
        turn_gap_ms: json_number(value, "turnGapMs") as u32,
    })
}

fn json_string(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn json_number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0).max(0.0)
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
