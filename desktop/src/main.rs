// 桌面版入口：起一个只监听 127.0.0.1 的本地服务，再开一个窗口指向它。
// 页面里的请求全是相对路径（fetch('/v1/audio/speech')），所以前端一行都不用改。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod data;
mod server;
mod ssml;
mod stt; // 待开发：语音转文字（模块内容已整体注释封存）
mod tts;
mod update;

use std::net::TcpListener;
use std::path::PathBuf;
use std::time::Duration;

use tauri::{webview::WebviewWindowBuilder, Manager, WebviewUrl};

/// 固定端口：端口稳住，localStorage（界面语言）才不会丢
const DEFAULT_PORT: u16 = 17600;
const PORT_TRIES: u16 = 10;

/// 首次打开的窗口大小（逻辑像素）；用户调过就按 exe 旁的 sonora-window.json 恢复
const DEFAULT_WINDOW_SIZE: (f64, f64) = (1024.0, 680.0);
const MIN_WINDOW_SIZE: (f64, f64) = (960.0, 640.0);

#[derive(serde::Serialize, serde::Deserialize)]
struct WindowState {
    width: f64,
    height: f64,
}

/// 尺寸记在 exe 同目录（绿色版放哪就跟到哪）；读写失败一律静默，不影响启动
fn window_state_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("sonora-window.json"))
}

fn load_window_size() -> Option<(f64, f64)> {
    let raw = std::fs::read_to_string(window_state_path()?).ok()?;
    let state: WindowState = serde_json::from_str(&raw).ok()?;
    if state.width >= MIN_WINDOW_SIZE.0 && state.height >= MIN_WINDOW_SIZE.1 {
        Some((state.width, state.height))
    } else {
        None
    }
}

fn save_window_size(window: &tauri::WebviewWindow) {
    // 最大化状态下不覆盖用户手动拖过的大小
    if window.is_maximized().unwrap_or(false) {
        return;
    }
    let Ok(size) = window.inner_size() else { return; };
    let scale = window.scale_factor().unwrap_or(1.0);
    let logical = size.to_logical::<f64>(scale);
    let state = WindowState { width: logical.width, height: logical.height };
    if let (Some(path), Ok(text)) = (window_state_path(), serde_json::to_string(&state)) {
        let _ = std::fs::write(path, text);
    }
}

fn pick_port() -> u16 {
    for offset in 0..PORT_TRIES {
        let port = DEFAULT_PORT + offset;
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    // 都被占了就让系统分配
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
        .unwrap_or(DEFAULT_PORT)
}

fn main() {
    let port = pick_port();

    // 窗口图标留空：Tauri 编译期只取 icon.ico 的第一帧（16×16）当窗口图标，
    // 任务栏放大后发糊；不设的话 Windows 直接用 exe 里嵌的多尺寸图标，
    // 按当前缩放挑最合适的那一帧。
    let mut context = tauri::generate_context!();
    context.set_default_window_icon(None);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            // 页面与接口都在这一个服务里；等它开始监听再开窗口，否则窗口会先撞上“拒绝连接”
            let (ready_sender, ready_receiver) = std::sync::mpsc::channel::<()>();
            tauri::async_runtime::spawn(server::serve(port, ready_sender));
            let _ = ready_receiver.recv_timeout(Duration::from_secs(5));

            let url = format!("http://127.0.0.1:{}/", port);
            let (width, height) = load_window_size().unwrap_or(DEFAULT_WINDOW_SIZE);
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().expect("本地地址格式错误")))
                .title("Sonora 声界 · 桌面语音工作台")
                .inner_size(width, height)
                .min_inner_size(MIN_WINDOW_SIZE.0, MIN_WINDOW_SIZE.1)
                // 无边框：标题栏与最小化 / 最大化 / 关闭都由页面自绘（走 server 里的窗口接口）
                .decorations(false)
                // 不放开的话，页面里的拖拽上传会被外壳抢走
                .disable_drag_drop_handler()
                .build()?;

            // 关窗前记住用户调过的窗口大小，下次启动按它开
            let handle = window.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                    save_window_size(&handle);
                }
            });

            // 窗口要等页面里的按钮来操作，建好后把句柄交给服务
            server::set_window(window);

            // 预热鉴权：第一次点生成就不必再等拿 endpoint（失败静默，合成时会再取一次）
            tauri::async_runtime::spawn(async {
                let _ = auth::get_endpoint(&auth::client()).await;
            });

            update::check(app.handle().clone());
            Ok(())
        })
        .run(context)
        .expect("启动 Sonora 失败");
}
