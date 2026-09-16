/* ===== 待开发：语音转文字（恢复时删掉这对注释标记，并在 server.rs 里改回调用本模块） =====
// 语音转文字：转发到硅基流动，模型固定 FunAudioLLM/SenseVoiceSmall。
use reqwest::multipart::{Form, Part};
use serde_json::Value;

const API_URL: &str = "https://api.siliconflow.cn/v1/audio/transcriptions";
const MODEL: &str = "FunAudioLLM/SenseVoiceSmall";
/// TODO: 待开发 —— 在此填入自己的硅基流动 Token（原内置 Token 已移除）
const BUILT_IN_TOKEN: &str = "";
const MAX_BYTES: usize = 10 * 1024 * 1024;

const ALLOWED_MIME: [&str; 10] = [
    "audio/mpeg", "audio/mp3", "audio/wav", "audio/m4a", "audio/flac",
    "audio/aac", "audio/ogg", "audio/webm", "audio/amr", "audio/3gpp",
];
const ALLOWED_EXT: [&str; 9] = ["mp3", "wav", "m4a", "flac", "aac", "ogg", "webm", "amr", "3gp"];

/// 返回 Err 时是给用户的中文提示
pub fn validate(file_name: &str, content_type: &str, size: usize) -> Result<(), String> {
    if size > MAX_BYTES {
        return Err("音频文件大小不能超过10MB".to_string());
    }
    let lower = file_name.to_lowercase();
    let by_ext = ALLOWED_EXT.iter().any(|ext| lower.ends_with(&format!(".{}", ext)));
    let by_mime = ALLOWED_MIME.iter().any(|mime| content_type.contains(mime));
    if !by_ext && !by_mime {
        return Err("不支持的音频文件格式，请上传mp3、wav、m4a、flac、aac、ogg、webm、amr或3gp格式的文件".to_string());
    }
    Ok(())
}

pub async fn transcribe(
    client: &reqwest::Client,
    file_name: &str,
    content_type: &str,
    bytes: Vec<u8>,
    custom_token: Option<String>,
) -> Result<Value, (u16, String)> {
    let token = custom_token.unwrap_or_else(|| BUILT_IN_TOKEN.to_string());
    let part = build_part(bytes, file_name, content_type);
    let form = Form::new().part("file", part).text("model", MODEL);

    let response = client
        .post(API_URL)
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|_| (502, "语音转录处理失败".to_string()))?;

    let status = response.status();
    if !status.is_success() {
        let _ = response.text().await;
        let message = match status.as_u16() {
            401 => "API Token无效，请检查您的配置",
            429 => "请求过于频繁，请稍后再试",
            413 => "音频文件太大，请选择较小的文件",
            _ => "语音转录服务暂时不可用",
        };
        return Err((status.as_u16(), message.to_string()));
    }

    response
        .json::<Value>()
        .await
        .map_err(|_| (502, "语音转录处理失败".to_string()))
}

fn build_part(bytes: Vec<u8>, file_name: &str, content_type: &str) -> Part {
    let name = file_name.to_string();
    let mime = if content_type.is_empty() {
        "application/octet-stream"
    } else {
        content_type
    };
    // MIME 多半来自浏览器，格式合法；万一不合法就退回不带 MIME 的写法
    match Part::bytes(bytes.clone()).file_name(name.clone()).mime_str(mime) {
        Ok(part) => part,
        Err(_) => Part::bytes(bytes).file_name(name),
    }
}
===== 待开发结束 ===== */
