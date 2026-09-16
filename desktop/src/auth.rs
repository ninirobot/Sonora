// 鉴权：复刻 index.js 的 getEndpoint() 与 sign()。
// 拿到的 endpoint 是 Edge TTS 的临时凭据，缓存到过期前 3 分钟，取失败时回落用旧凭据。
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde::Deserialize;
use sha2::Sha256;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// 出站请求的浏览器标识。值要与当前 Edge 稳定版一致：
/// https://learn.microsoft.com/deployedge/microsoft-edge-relnote-stable-channel
/// 网页版同一份值在 index.js 的 EDGE_UA，scripts/check-copy.mjs 会校验两处一致。
pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.4234.32";

const ENDPOINT_URL: &str = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
const SIGN_KEY: &str = "oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==";
const REFRESH_BEFORE_EXPIRY: i64 = 3 * 60;

#[derive(Clone, Deserialize)]
pub struct Endpoint {
    /// 区域，拼出 https://{r}.tts.speech.microsoft.com/...
    pub r: String,
    /// 临时令牌
    pub t: String,
}

#[derive(Default)]
struct TokenCache {
    endpoint: Option<Endpoint>,
    expired_at: Option<i64>,
}

static CLIENT: OnceLock<Client> = OnceLock::new();
static TOKEN: OnceLock<tokio::sync::Mutex<TokenCache>> = OnceLock::new();

/// 全局复用的 HTTP 客户端（内部是连接池，克隆很廉价）
pub fn client() -> Client {
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .user_agent(USER_AGENT)
                .build()
                .expect("创建 HTTP 客户端失败")
        })
        .clone()
}

pub async fn get_endpoint(client: &Client) -> Result<Endpoint, String> {
    // 整段加锁：并发请求会在这里排队，第一个请求刷新完，后面的直接命中缓存
    let lock = TOKEN.get_or_init(|| tokio::sync::Mutex::new(TokenCache::default()));
    let mut cache = lock.lock().await;

    if let (Some(endpoint), Some(expired_at)) = (&cache.endpoint, cache.expired_at) {
        if now_secs() < expired_at - REFRESH_BEFORE_EXPIRY {
            return Ok(endpoint.clone());
        }
    }

    match fetch_endpoint(client).await {
        Ok((endpoint, expired_at)) => {
            cache.endpoint = Some(endpoint.clone());
            cache.expired_at = Some(expired_at);
            Ok(endpoint)
        }
        Err(message) => match &cache.endpoint {
            // 取新凭据失败时，退回用旧的（网页版也是这个行为）
            Some(endpoint) => Ok(endpoint.clone()),
            None => Err(message),
        },
    }
}

async fn fetch_endpoint(client: &Client) -> Result<(Endpoint, i64), String> {
    let response = client
        .post(ENDPOINT_URL)
        .header("Accept-Language", "zh-Hans")
        .header("X-ClientVersion", "4.0.530a 5fe1dc6c")
        .header("X-UserId", "0f04d16a175c411e")
        .header("X-HomeGeographicRegion", "zh-Hans-CN")
        .header("X-ClientTraceId", Uuid::new_v4().simple().to_string())
        .header("X-MT-Signature", sign(ENDPOINT_URL)?)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Content-Length", "0")
        .header("Accept-Encoding", "gzip")
        .send()
        .await
        .map_err(|e| format!("获取endpoint失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("获取endpoint失败: {}", response.status()));
    }

    let endpoint: Endpoint = response
        .json()
        .await
        .map_err(|e| format!("endpoint 解析失败: {}", e))?;

    // 令牌是一段 JWT，过期时间就在中间那段里
    let payload = endpoint.t.split('.').nth(1).ok_or("endpoint 令牌格式异常")?;
    let claims = URL_SAFE_NO_PAD
        .decode(payload)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .ok_or("endpoint 令牌解析失败")?;
    let expired_at = claims.get("exp").and_then(|v| v.as_i64()).ok_or("endpoint 令牌缺少过期时间")?;

    Ok((endpoint, expired_at))
}

/// X-MT-Signature：MSTranslatorAndroidApp::<HMAC-SHA256>::<日期>::<随机串>
fn sign(url: &str) -> Result<String, String> {
    let without_scheme = url.split("://").nth(1).unwrap_or(url);
    let encoded = encode_uri_component(without_scheme);
    let trace_id = Uuid::new_v4().simple().to_string();
    let date = utc_date();
    let message = format!("MSTranslatorAndroidApp{}{}{}", encoded, date, trace_id).to_lowercase();

    let key = STANDARD.decode(SIGN_KEY).map_err(|e| format!("签名密钥异常: {}", e))?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).map_err(|e| format!("签名初始化失败: {}", e))?;
    mac.update(message.as_bytes());
    let signature = mac.finalize().into_bytes();

    Ok(format!(
        "MSTranslatorAndroidApp::{}::{}::{}",
        STANDARD.encode(signature),
        date,
        trace_id
    ))
}

/// 与 JS 的 toUTCString() 同形：sun, 13 sep 2026 12:34:56 gmt
fn utc_date() -> String {
    Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string().to_lowercase()
}

/// 与 JS 的 encodeURIComponent 同规则：只保留 A-Za-z0-9 与 -_.!~*'()
fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
