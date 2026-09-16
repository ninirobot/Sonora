// 启动时的版本检查：拉仓库里的 desktop/version.json 与当前版本比对，
// 有新版本就弹原生提示框，确认后用系统浏览器打开下载页。网络异常一律静默跳过。
use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

const VERSION_URL: &str = "https://raw.githubusercontent.com/ninirobot/Sonora/master/desktop/version.json";
const FALLBACK_DOWNLOAD_URL: &str = "https://github.com/ninirobot/Sonora/releases/latest";

#[derive(Deserialize)]
struct Release {
    version: String,
    #[serde(rename = "downloadUrl")]
    download_url: Option<String>,
}

pub fn check(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Some(release) = fetch_latest().await else { return };

        let current = env!("CARGO_PKG_VERSION");
        if !is_newer(&release.version, current) {
            return;
        }

        let url = release.download_url.unwrap_or_else(|| FALLBACK_DOWNLOAD_URL.to_string());
        let message = format!("当前 {}，最新 {}。要打开下载页吗？", current, release.version);
        let opener = handle.clone();

        handle
            .dialog()
            .message(message)
            .title("Sonora 有新版本")
            .buttons(MessageDialogButtons::OkCancel)
            .show(move |confirmed| {
                if confirmed {
                    let _ = opener.opener().open_url(url, None::<&str>);
                }
            });
    });
}

async fn fetch_latest() -> Option<Release> {
    let client = crate::auth::client();
    let response = client.get(VERSION_URL).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Release>().await.ok()
}

/// 按点分段逐位比较，够用且不用引第三方 semver 库
fn is_newer(candidate: &str, current: &str) -> bool {
    parse_version(candidate) > parse_version(current)
}

fn parse_version(text: &str) -> Vec<u64> {
    text.split('.')
        .map(|part| part.trim().parse::<u64>().unwrap_or(0))
        .collect()
}
