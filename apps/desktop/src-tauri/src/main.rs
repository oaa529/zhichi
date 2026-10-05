// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};

/// 自动备份在桌面端的额外出口：把备份 JSON 写进「文档/咫尺备份/」。
///
/// 与 IndexedDB 快照的分工：本地快照跟着 WebView 数据走（清缓存会连它一起没），
/// 落到磁盘的文件才是真备份。由 Rust 侧直接写盘，前端因此不需要 fs 插件权限。
///
/// 前端调用：`invoke('save_backup_file', { text, filename })`
/// @returns 写入的文件完整路径（界面回执里给用户看）
#[tauri::command]
fn save_backup_file(text: String, filename: String) -> Result<String, String> {
    let docs = dirs::document_dir().ok_or_else(|| "找不到系统的「文档」目录。".to_string())?;
    let dir = docs.join("咫尺备份");
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败：{e}"))?;

    // 文件名只做最基本的防呆：不允许跨目录（Windows 端不允许做系统盘遍历）
    let trimmed = filename.trim();
    if trimmed.is_empty() || trimmed.contains(['\\', '/', '\0']) {
        return Err("备份文件名不合法。".to_string());
    }
    let target = dir.join(trimmed);
    fs::write(&target, text).map_err(|e| format!("写入备份文件失败：{e}"))?;

    Ok(target.to_string_lossy().into_owned())
}

/// 右下角托盘：点图标弹菜单，「显示主窗口」把窗口从托盘叫回来，「退出」才真退。
///
/// 与「关窗口 = 收到托盘」（见下方 on_window_event）是一套：应用常驻，
/// 任务栏可以空着，但备份与消息都不会因为误点 × 而中断。
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".to_string()))?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("咫尺")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        // 单实例：重复启动时把已有窗口叫到前台（新进程自己退掉），
        // 避免两个窗口共用一份 IndexedDB 互相覆盖
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            build_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 点 × = 收到托盘（进程继续跑）；托盘菜单里的「退出」与 app.exit() 才真退。
            // 没有这一条，用户随手关窗口就会把正在进行的自动备份一起带走。
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![save_backup_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
