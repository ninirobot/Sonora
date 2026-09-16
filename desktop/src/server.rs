// 本地服务：只监听 127.0.0.1，提供页面与三个接口，路径与错误结构都和网页版一致。
use axum::body::{to_bytes, Body};
use axum::extract::{FromRequest, Multipart, Path};
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, Method, Request, Response, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::OnceLock;
use tauri::WebviewWindow;
use tokio::net::TcpListener;

// 待开发：语音转文字（恢复时取消下面这行注释）
// use crate::auth;
use crate::data;
use crate::ssml::{SegmentKind, VoiceOpts};
// 待开发：语音转文字（stt 模块已封存，恢复时改回 use crate::{stt, tts};）
use crate::tts;

/// 单块请求体上限：txt 500KB、音频 10MB，这里留足余量
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// 窗口句柄：窗口是在服务起来之后才创建的，所以这里先占位、建好后由 main.rs 写入
static WINDOW: OnceLock<WebviewWindow> = OnceLock::new();

pub fn set_window(window: WebviewWindow) {
    let _ = WINDOW.set(window);
}

/// ready 用来通知主线程「端口已经在监听了」，避免窗口抢在绑定之前加载页面
pub async fn serve(port: u16, ready: std::sync::mpsc::Sender<()>) {
    let app = Router::new()
        .route("/", get(index))
        .route("/index.html", get(index))
        .route("/v1/audio/speech", post(speech))
        // 语音转文字：待开发，路由保留为入口，暂不向第三方转发任何请求
        .route("/v1/audio/transcriptions", post(transcribe))
        // 页面自绘的窗口按钮与标题栏拖拽：页面是本机外部源，用不了 Tauri 的 IPC，所以走这里
        .route("/__window/{action}", post(window_action))
        .route("/__window/state", get(window_state))
        .fallback(fallback);

    let listener = match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("本地服务启动失败：{}", error);
            let _ = ready.send(());
            return;
        }
    };
    let _ = ready.send(());
    if let Err(error) = axum::serve(listener, app).await {
        eprintln!("本地服务异常：{}", error);
    }
}

// ---------------------------------------------------------------- 路由

async fn index() -> Response<Body> {
    match data::page() {
        Ok(html) => html_response(html),
        Err(message) => error_response(&message, "page_error", StatusCode::INTERNAL_SERVER_ERROR, "api_error"),
    }
}

async fn speech(request: Request<Body>) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let content_type = header_text(&parts.headers, CONTENT_TYPE);

    if content_type.contains("multipart/form-data") {
        let request = Request::from_parts(parts, body);
        return match Multipart::from_request(request, &()).await {
            Ok(multipart) => handle_file_upload(multipart).await,
            Err(_) => invalid_request("请求解析失败，请检查 multipart 格式", "invalid_multipart", "content-type"),
        };
    }

    let bytes = match to_bytes(body, MAX_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return invalid_request("请求体读取失败", "invalid_body", "body"),
    };
    let payload: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return invalid_request("请求体不是合法 JSON", "invalid_json", "body"),
    };
    handle_speech_json(payload).await
}

/// 语音转文字：待开发。原实现见下方注释块
async fn transcribe() -> Response<Body> {
    error_response(
        "语音转文字功能开发中，敬请期待",
        "not_implemented",
        StatusCode::NOT_IMPLEMENTED,
        "api_error",
    )
}

/* ===== 待开发：语音转文字处理（恢复时删掉这对注释标记，并改回上面的函数签名与模块引用） =====
async fn transcribe(headers: HeaderMap, multipart: Multipart) -> Response<Body> {
    let content_type = header_text(&headers, CONTENT_TYPE);
    if !content_type.contains("multipart/form-data") {
        return invalid_request("请求必须使用multipart/form-data格式", "invalid_content_type", "content-type");
    }

    let upload = match read_multipart(multipart, "未找到音频文件").await {
        Ok(upload) => upload,
        Err(message) => return invalid_request(&message, "missing_file", "file"),
    };
    if let Err(message) = stt::validate(&upload.file_name, &upload.file_type, upload.bytes.len()) {
        return invalid_request(&message, "invalid_file_type", "file");
    }

    let token = upload.fields.get("token").cloned();
    let client = auth::client();
    match stt::transcribe(&client, &upload.file_name, &upload.file_type, upload.bytes, token).await {
        Ok(value) => json_response(value, StatusCode::OK),
        Err((status, message)) => error_response(
            &message,
            "transcription_api_error",
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            "api_error",
        ),
    }
}
===== 待开发结束 ===== */

async fn fallback(method: Method, headers: HeaderMap) -> Response<Body> {
    if method == Method::OPTIONS {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        apply_cors(response.headers_mut());
        let allowed = headers
            .get("access-control-request-headers")
            .cloned()
            .unwrap_or_else(|| axum::http::HeaderValue::from_static("Authorization"));
        response.headers_mut().insert("access-control-allow-headers", allowed);
        return response;
    }

    let mut response = Response::new(Body::from("Not Found"));
    *response.status_mut() = StatusCode::NOT_FOUND;
    response
}

// ---------------------------------------------------------------- 语音合成

async fn handle_speech_json(payload: Value) -> Response<Body> {
    let input = text_field(&payload, "input", "");
    let voice_name = text_field(&payload, "voice", "zh-CN-XiaoxiaoNeural");
    let speed = text_field(&payload, "speed", "1.0");
    let volume = text_field(&payload, "volume", "0");
    let pitch = text_field(&payload, "pitch", "0");
    let style = text_field(&payload, "style", "");
    let styledegree = payload.get("styledegree").and_then(Value::as_f64);
    // 前端「设置」里选的输出格式；空值走 VoiceOpts 的默认（audio-24khz-96kbitrate-mono-mp3）
    let output_format = text_field(&payload, "outputFormat", "");

    let result = if is_truthy(payload.get("dialogue")) {
        let speaker_a = text_field(&payload, "speakerA", "emma").to_lowercase();
        let speaker_b = text_field(&payload, "speakerB", "andrew").to_lowercase();
        // 逐行编辑器直接给结构化 turns；上传 txt 才走文本解析
        let turns = payload
            .get("turns")
            .and_then(Value::as_array)
            .filter(|items| !items.is_empty())
            .map(|items| items.iter().map(tts::turn_from_json).collect())
            .unwrap_or_else(|| tts::parse_dialogue_turns(&input, &speaker_a, &speaker_b));
        let mut opts_a = opts_from_value(payload.get("optsA"));
        opts_a.output_format = output_format.clone();
        let mut opts_b = opts_from_value(payload.get("optsB"));
        opts_b.output_format = output_format.clone();
        tts::dialogue_voice(turns, &voice_name, &opts_a, &opts_b, &speaker_a, &speaker_b).await
    } else {
        let mut opts = VoiceOpts::from_params(&speed, &volume, &pitch, &style, styledegree);
        opts.output_format = output_format.clone();
        let segments = payload
            .get("segments")
            .and_then(Value::as_array)
            .map(|items| tts::segments_from_json(items));
        match segments {
            Some(items) if items.iter().any(|segment| segment.kind != SegmentKind::Text) => {
                tts::segmented_voice(&items, &voice_name, &opts).await
            }
            _ => tts::voice(&input, &voice_name, &opts).await,
        }
    };

    match result {
        Ok(bytes) => audio_response(bytes, &output_format),
        Err(message) => error_response(&message, "edge_tts_error", StatusCode::INTERNAL_SERVER_ERROR, "api_error"),
    }
}

enum UploadError {
    /// 参数校验没过：400
    Invalid { message: String, code: &'static str },
    /// 处理过程出错：与网页版一样统一成「文件处理失败」
    Failed(String),
}

async fn handle_file_upload(multipart: Multipart) -> Response<Body> {
    match upload_voice(multipart).await {
        Ok((bytes, output_format)) => audio_response(bytes, &output_format),
        Err(UploadError::Invalid { message, code }) => invalid_request(&message, code, "file"),
        Err(UploadError::Failed(detail)) => {
            // 对外统一成「文件处理失败」，细节只打到控制台（发布版没有控制台，等于静默）
            if cfg!(debug_assertions) {
                eprintln!("文件处理失败：{}", detail);
            }
            error_response("文件处理失败", "file_processing_error", StatusCode::INTERNAL_SERVER_ERROR, "api_error")
        }
    }
}

async fn upload_voice(multipart: Multipart) -> Result<(Vec<u8>, String), UploadError> {
    let upload = read_multipart(multipart, "未找到上传的文件")
        .await
        .map_err(|message| UploadError::Invalid { message, code: "missing_file" })?;

    let is_text = upload.file_type.contains("text/") || upload.file_name.to_lowercase().ends_with(".txt");
    if !is_text {
        return Err(UploadError::Invalid {
            message: "不支持的文件类型，请上传txt文件".to_string(),
            code: "invalid_file_type",
        });
    }
    if upload.bytes.len() > 500 * 1024 {
        return Err(UploadError::Invalid {
            message: "文件大小超过限制（最大500KB）".to_string(),
            code: "file_too_large",
        });
    }

    let content = String::from_utf8_lossy(&upload.bytes).to_string();
    if content.trim().is_empty() {
        return Err(UploadError::Invalid {
            message: "文件内容为空".to_string(),
            code: "empty_file",
        });
    }
    if content.chars().count() > 10000 {
        return Err(UploadError::Invalid {
            message: "文本内容过长（最大10000字符）".to_string(),
            code: "text_too_long",
        });
    }

    let voice_name = upload
        .fields
        .get("voice")
        .map(String::as_str)
        .unwrap_or("zh-CN-XiaoxiaoNeural");
    // 前端「设置」里选的输出格式；空值走 VoiceOpts 的默认
    let output_format = upload.fields.get("outputFormat").cloned().unwrap_or_default();

    // 上传的 txt 也可以按 a: / b: 行格式走多人对话
    if upload.fields.contains_key("dialogue") {
        let speaker_a = upload
            .fields
            .get("speakerA")
            .map(String::as_str)
            .unwrap_or("emma")
            .to_lowercase();
        let speaker_b = upload
            .fields
            .get("speakerB")
            .map(String::as_str)
            .unwrap_or("andrew")
            .to_lowercase();
        let turns = tts::parse_dialogue_turns(&content, &speaker_a, &speaker_b);
        let mut opts_a = opts_from_text(upload.fields.get("optsA"));
        opts_a.output_format = output_format.clone();
        let mut opts_b = opts_from_text(upload.fields.get("optsB"));
        opts_b.output_format = output_format.clone();
        let bytes = tts::dialogue_voice(turns, voice_name, &opts_a, &opts_b, &speaker_a, &speaker_b)
            .await
            .map_err(UploadError::Failed)?;
        return Ok((bytes, output_format));
    }

    let mut opts = VoiceOpts::from_params(
        upload.fields.get("speed").map(String::as_str).unwrap_or("1.0"),
        upload.fields.get("volume").map(String::as_str).unwrap_or("0"),
        upload.fields.get("pitch").map(String::as_str).unwrap_or("0"),
        upload.fields.get("style").map(String::as_str).unwrap_or(""),
        upload
            .fields
            .get("styledegree")
            .and_then(|value| value.parse::<f64>().ok()),
    );
    opts.output_format = output_format.clone();
    let bytes = tts::voice(&content, voice_name, &opts).await.map_err(UploadError::Failed)?;
    Ok((bytes, output_format))
}

struct Upload {
    file_name: String,
    file_type: String,
    bytes: Vec<u8>,
    fields: HashMap<String, String>,
}

async fn read_multipart(mut multipart: Multipart, missing_message: &str) -> Result<Upload, String> {
    let mut file_name = String::new();
    let mut file_type = String::new();
    let mut bytes: Option<Vec<u8>> = None;
    let mut fields: HashMap<String, String> = HashMap::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| "表单解析失败".to_string())?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            file_name = field.file_name().unwrap_or("").to_string();
            file_type = field.content_type().unwrap_or("").to_string();
            let data = field.bytes().await.map_err(|_| "文件读取失败".to_string())?;
            bytes = Some(data.to_vec());
        } else if let Ok(text) = field.text().await {
            fields.insert(name, text);
        }
    }

    Ok(Upload {
        file_name,
        file_type,
        bytes: bytes.ok_or_else(|| missing_message.to_string())?,
        fields,
    })
}

// ---------------------------------------------------------------- 参数解析

fn text_field(value: &Value, key: &str, fallback: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => fallback.to_string(),
    }
}

/// 与 JS 的 `if (dialogue)` 同义
fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().map(|v| v != 0.0).unwrap_or(false),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => true,
    }
}

/// optsA / optsB：前端只带了 speed，其余走默认值
fn opts_from_value(value: Option<&Value>) -> VoiceOpts {
    let value = value.cloned().unwrap_or_default();
    VoiceOpts::from_params(
        &first_non_empty(&text_field(&value, "speed", ""), "1.0"),
        &first_non_empty(&text_field(&value, "volume", ""), "0"),
        &first_non_empty(&text_field(&value, "pitch", ""), "0"),
        &text_field(&value, "style", ""),
        value.get("styledegree").and_then(Value::as_f64),
    )
}

/// 上传 txt 时 optsA / optsB 是 JSON 字符串
fn opts_from_text(raw: Option<&String>) -> VoiceOpts {
    let value: Value = raw
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_default();
    opts_from_value(Some(&value))
}

fn first_non_empty(value: &str, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

fn header_text(headers: &HeaderMap, key: axum::http::HeaderName) -> String {
    headers
        .get(key)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string()
}

// ---------------------------------------------------------------- 窗口控制

/// 页面标题栏上的按钮：拖拽 / 最小化 / 最大化 / 关闭
async fn window_action(Path(action): Path<String>) -> Response<Body> {
    let Some(window) = WINDOW.get() else {
        return invalid_request("窗口尚未就绪", "window_not_ready", "window");
    };

    let result = match action.as_str() {
        // 交给系统接管拖拽，跟手程度与原生窗口一致
        "drag" => window.start_dragging(),
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        _ => return invalid_request("未知的窗口操作", "unknown_window_action", "action"),
    };

    match result {
        Ok(()) => {
            let mut response = Response::new(Body::empty());
            *response.status_mut() = StatusCode::NO_CONTENT;
            apply_cors(response.headers_mut());
            response
        }
        Err(error) => error_response(
            &format!("窗口操作失败：{}", error),
            "window_error",
            StatusCode::INTERNAL_SERVER_ERROR,
            "api_error",
        ),
    }
}

async fn window_state() -> Response<Body> {
    let maximized = WINDOW
        .get()
        .and_then(|window| window.is_maximized().ok())
        .unwrap_or(false);
    json_response(json!({ "maximized": maximized }), StatusCode::OK)
}

// ---------------------------------------------------------------- 响应

fn apply_cors(headers: &mut HeaderMap) {
    headers.insert("access-control-allow-origin", axum::http::HeaderValue::from_static("*"));
    headers.insert(
        "access-control-allow-methods",
        axum::http::HeaderValue::from_static("GET,HEAD,POST,OPTIONS"),
    );
    headers.insert(
        "access-control-allow-headers",
        axum::http::HeaderValue::from_static("Content-Type, x-api-key"),
    );
    headers.insert("access-control-max-age", axum::http::HeaderValue::from_static("86400"));
}

fn json_response(data: Value, status: StatusCode) -> Response<Body> {
    let body = serde_json::to_vec(&data).unwrap_or_else(|_| b"{}".to_vec());
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("content-type", axum::http::HeaderValue::from_static("application/json"));
    apply_cors(response.headers_mut());
    response
}

fn error_response(message: &str, code: &str, status: StatusCode, kind: &str) -> Response<Body> {
    json_response(
        json!({ "error": { "message": message, "type": kind, "param": Value::Null, "code": code } }),
        status,
    )
}

fn invalid_request(message: &str, code: &str, param: &str) -> Response<Body> {
    json_response(
        json!({
            "error": {
                "message": message,
                "type": "invalid_request_error",
                "param": param,
                "code": code
            }
        }),
        StatusCode::BAD_REQUEST,
    )
}

/// 输出格式 → 响应 Content-Type（与网页版 index.js 的映射保持一致）
fn audio_content_type(output_format: &str) -> &'static str {
    if output_format.starts_with("ogg-") {
        "audio/ogg"
    } else if output_format.starts_with("webm-") {
        "audio/webm"
    } else if output_format.starts_with("raw-") {
        "audio/wav"
    } else {
        "audio/mpeg"
    }
}

fn audio_response(bytes: Vec<u8>, output_format: &str) -> Response<Body> {
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert("content-type", axum::http::HeaderValue::from_static(audio_content_type(output_format)));
    apply_cors(response.headers_mut());
    response
}

fn html_response(html: &'static str) -> Response<Body> {
    let mut response = Response::new(Body::from(html));
    response.headers_mut().insert(
        "content-type",
        axum::http::HeaderValue::from_static("text/html; charset=utf-8"),
    );
    apply_cors(response.headers_mut());
    response
}
