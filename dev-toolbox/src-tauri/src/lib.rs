use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri::Emitter;

// ---- notes 后端（与 Electron 同构）----

#[derive(Serialize)]
struct NoteNode {
    name: String,
    path: String,
    #[serde(rename = "type")]
    ntype: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    updatedAt: Option<f64>,
    children: Vec<NoteNode>,
}

#[derive(Serialize)]
struct NoteItem {
    id: String,
    path: String,
    file: String,
    title: String,
    body: Option<String>,
    ts: f64,
    updatedAt: f64,
}

fn sanitize_name(name: &str) -> String {
    let s = name.trim().replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "");
    if s.is_empty() { "Untitled".to_string() } else { s }
}

fn is_note_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".txt") || lower.ends_with(".markdown")
}

fn is_skipped_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".obsidian" | ".trash" | ".Trash" | "node_modules" | ".vscode" | ".idea" | "__pycache__"
    )
}

fn file_mtime_ms(path: &Path) -> Option<f64> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(dur.as_millis() as f64)
}

fn build_tree(dir: &Path) -> Vec<NoteNode> {
    let mut out = vec![];
    let Ok(entries) = fs::read_dir(dir) else { return out };
    let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    items.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
    for e in items {
        let name = e.file_name().to_string_lossy().to_string();
        let path = e.path();
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if is_skipped_dir(&name) { continue; }
            out.push(NoteNode {
                name: name.clone(),
                path: path.to_string_lossy().to_string(),
                ntype: "dir".into(),
                updatedAt: None,
                children: build_tree(&path),
            });
        } else if is_note_file(&name) {
            out.push(NoteNode {
                name: name.clone(),
                path: path.to_string_lossy().to_string(),
                ntype: "file".into(),
                updatedAt: file_mtime_ms(&path),
                children: vec![],
            });
        }
    }
    out
}

fn http_client() -> &'static reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .pool_max_idle_per_host(4)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

// 笔记目录持久化：存在 app_config_dir/notes-config.json 里
// key: "notesDir" —— 用户选过的笔记目录
fn saved_notes_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let cfg = app.path().app_config_dir().ok()?.join("notes-config.json");
    let text = fs::read_to_string(&cfg).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    // 兼容 Electron 旧键 defaultDir / dir，与 Tauri notesDir
    let dir = v.get("notesDir").or_else(|| v.get("defaultDir")).or_else(|| v.get("dir"))?.as_str()?;
    let p = PathBuf::from(dir);
    if p.exists() { Some(p) } else { None }
}

fn save_notes_dir(app: &tauri::AppHandle, dir: &str) {
    if let Ok(cfg_dir) = app.path().app_config_dir() {
        let _ = fs::create_dir_all(&cfg_dir);
        let cfg = cfg_dir.join("notes-config.json");
        // 同时写 notesDir + defaultDir，方便双端配置互通
        let v = serde_json::json!({ "notesDir": dir, "defaultDir": dir });
        let _ = fs::write(cfg, v.to_string());
    }
}

fn default_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Some(d) = saved_notes_dir(app) { return d; }
    let dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
    let notes = dir.join("notes");
    let _ = fs::create_dir_all(&notes);
    notes
}

#[tauri::command]
async fn notes_list(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = default_dir(&app);
        let tree = build_tree(&dir);
        Ok(serde_json::json!({ "ok": true, "dir": dir.to_string_lossy(), "tree": tree, "defaultDir": dir.to_string_lossy() }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn notes_pick_dir(app: tauri::AppHandle, window: tauri::Window) -> Result<serde_json::Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let res = window.dialog().file().blocking_pick_folder();
    let Some(path) = res else { return Ok(serde_json::json!({ "ok": false, "canceled": true })) };
    let p = path.into_path().unwrap_or_default();
    save_notes_dir(&app, &p.to_string_lossy());
    let p2 = p.clone();
    let tree = tauri::async_runtime::spawn_blocking(move || build_tree(&p2))
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ok": true, "dir": p.to_string_lossy(), "tree": tree, "defaultDir": p.to_string_lossy() }))
}

#[tauri::command]
async fn notes_read_file(file_path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match fs::read_to_string(&file_path) {
            Ok(body) => Ok(serde_json::json!({ "ok": true, "body": body })),
            Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn notes_set_default(app: tauri::AppHandle, dir: String) -> Result<serde_json::Value, String> {
    if !Path::new(&dir).exists() { return Ok(serde_json::json!({ "ok": false, "error": "路径不存在" })); }
    save_notes_dir(&app, &dir);
    Ok(serde_json::json!({ "ok": true, "defaultDir": dir }))
}

const NOTE_SEARCH_MAX_BYTES: u64 = 2 * 1024 * 1024;

fn notes_search_walk(path: &Path, q: &str, in_body: bool, results: &mut Vec<NoteItem>) {
    if results.len() >= 300 { return; }
    let Ok(entries) = fs::read_dir(path) else { return; };
    for e in entries.flatten() {
        if results.len() >= 300 { return; }
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if is_skipped_dir(&name) { continue; }
            notes_search_walk(&p, q, in_body, results);
            continue;
        }
        if !is_note_file(&name) { continue; }
        let lower = name.to_lowercase();
        let title = lower
            .trim_end_matches(".markdown")
            .trim_end_matches(".md")
            .trim_end_matches(".txt")
            .to_string();
        if title.contains(q) {
            let mtime = file_mtime_ms(&p).unwrap_or(0.0);
            results.push(NoteItem {
                id: p.to_string_lossy().into(),
                path: p.to_string_lossy().into(),
                file: name,
                title,
                body: None,
                ts: mtime,
                updatedAt: mtime,
            });
            continue;
        }
        if !in_body { continue; }
        let Ok(meta) = e.metadata() else { continue; };
        if meta.len() > NOTE_SEARCH_MAX_BYTES { continue; }
        if let Ok(text) = fs::read_to_string(&p) {
            if text.to_lowercase().contains(q) {
                let mtime = file_mtime_ms(&p).unwrap_or(0.0);
                results.push(NoteItem {
                    id: p.to_string_lossy().into(),
                    path: p.to_string_lossy().into(),
                    file: name,
                    title,
                    body: None,
                    ts: mtime,
                    updatedAt: mtime,
                });
            }
        }
    }
}

#[tauri::command]
async fn notes_search(dir: Option<String>, query: String, in_body: Option<bool>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let q = query.to_lowercase();
        let mut results: Vec<NoteItem> = vec![];
        if q.is_empty() {
            return Ok(serde_json::json!({ "ok": true, "results": results }));
        }
        let base = dir
            .and_then(|d| if Path::new(&d).exists() { Some(PathBuf::from(d)) } else { None })
            .unwrap_or_default();
        notes_search_walk(&base, &q, in_body.unwrap_or(true), &mut results);
        Ok(serde_json::json!({ "ok": true, "results": results }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn notes_save(dir: Option<String>, title: String, body: String, old_path: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = sanitize_name(&title);
        let target = if let Some(op) = &old_path {
            if let Some(parent) = Path::new(op).parent() { parent.to_path_buf() } else { PathBuf::from(".") }
        } else if let Some(d) = dir { PathBuf::from(d) } else { PathBuf::from(".") };
        let _ = fs::create_dir_all(&target);
        let mut ext = ".md".to_string();
        if let Some(op) = &old_path {
            if is_note_file(op) {
                ext = Path::new(op).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or(".md".into());
            }
        }
        let mut file = target.join(format!("{}{}", name, ext));
        let mut i = 1;
        while file.exists() && old_path.as_ref().map(|o| file != Path::new(o)).unwrap_or(true) {
            file = target.join(format!("{} ({}){}", name, i, ext));
            i += 1;
        }
        if let Err(e) = fs::write(&file, &body) {
            return Ok(serde_json::json!({ "ok": false, "error": e.to_string() }));
        }
        if let Some(op) = &old_path {
            if Path::new(op).exists() && file != Path::new(op) { let _ = fs::remove_file(op); }
        }
        let title_out = file.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let mtime = file_mtime_ms(&file).unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0)
        });
        Ok(serde_json::json!({ "ok": true, "note": { "id": file.to_string_lossy(), "path": file.to_string_lossy(), "file": file.file_name().unwrap_or_default().to_string_lossy(), "title": title_out, "body": body, "ts": mtime, "updatedAt": mtime } }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn notes_create(dir: Option<String>, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let base = dir.map(PathBuf::from).unwrap_or_else(|| default_dir(&app));
    let _ = fs::create_dir_all(&base);
    let mut i = 1;
    let mut file = base.join("Untitled.md");
    while file.exists() { file = base.join(format!("Untitled ({}).md", i)); i += 1; }
    let _ = fs::write(&file, "");
    Ok(serde_json::json!({ "ok": true, "path": file.to_string_lossy() }))
}

#[tauri::command]
fn notes_create_dir(parent: Option<String>, name: String) -> Result<serde_json::Value, String> {
    let base = parent.map(PathBuf::from).unwrap_or_default();
    let dir = base.join(sanitize_name(&name));
    match fs::create_dir_all(&dir) {
        Ok(_) => Ok(serde_json::json!({ "ok": true, "path": dir.to_string_lossy() })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[tauri::command]
fn notes_delete(file_path: String) -> Result<serde_json::Value, String> {
    let p = Path::new(&file_path);
    let r = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
    match r { Ok(_) => Ok(serde_json::json!({ "ok": true })), Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })) }
}

#[tauri::command]
async fn notes_rename(old_path: String, title: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let old = PathBuf::from(&old_path);
        if !old.exists() {
            return Ok(serde_json::json!({ "ok": false, "error": "文件不存在" }));
        }
        let name = sanitize_name(&title);
        if name.is_empty() {
            return Ok(serde_json::json!({ "ok": false, "error": "名称无效" }));
        }
        let ext = old
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_else(|| ".md".into());
        let parent = old.parent().unwrap_or_else(|| Path::new("."));
        let mut file = parent.join(format!("{}{}", name, ext));
        let mut i = 1;
        while file.exists() && file != old {
            file = parent.join(format!("{} ({}){}", name, i, ext));
            i += 1;
        }
        if file == old {
            let title_out = file.file_stem().unwrap_or_default().to_string_lossy().to_string();
            let mtime = file_mtime_ms(&file).unwrap_or(0.0);
            return Ok(serde_json::json!({
                "ok": true,
                "note": {
                    "id": file.to_string_lossy(),
                    "path": file.to_string_lossy(),
                    "file": file.file_name().unwrap_or_default().to_string_lossy(),
                    "title": title_out,
                    "ts": mtime,
                    "updatedAt": mtime
                }
            }));
        }
        if let Err(e) = fs::rename(&old, &file) {
            return Ok(serde_json::json!({ "ok": false, "error": e.to_string() }));
        }
        let title_out = file.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let mtime = file_mtime_ms(&file).unwrap_or(0.0);
        Ok(serde_json::json!({
            "ok": true,
            "note": {
                "id": file.to_string_lossy(),
                "path": file.to_string_lossy(),
                "file": file.file_name().unwrap_or_default().to_string_lossy(),
                "title": title_out,
                "ts": mtime,
                "updatedAt": mtime
            }
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn notes_reveal(dir: String) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    { let _ = std::process::Command::new("explorer").arg(&dir).spawn(); }
    Ok(serde_json::json!({ "ok": true }))
}

/// 用系统默认浏览器打开 URL（Tauri WebView 里 window.open 常被静默拦截）
#[tauri::command]
fn open_external_url(url: String) -> Result<serde_json::Value, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅允许 http/https URL".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;
    }
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn notes_read(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    notes_list(app).await
}

// ---- HTTP / 系统信息 / 端口 / 翻译 / IP ----

#[tauri::command]
async fn http_request(url: String, method: Option<String>, headers: Option<serde_json::Value>, body: Option<String>) -> Result<serde_json::Value, String> {
    let client = http_client();
    let m = method.unwrap_or_else(|| "GET".into());
    let mut req = client.request(reqwest::Method::from_bytes(m.as_bytes()).unwrap_or(reqwest::Method::GET), &url);
    if let Some(h) = headers {
        if let Some(obj) = h.as_object() {
            for (k, v) in obj {
                if let Some(s) = v.as_str() { req = req.header(k, s); }
            }
        }
    }
    if let Some(b) = body { req = req.body(b); }
    match req.send().await {
        Ok(res) => {
            let status = res.status().as_u16();
            let headers_out: serde_json::Map<String, serde_json::Value> = res.headers().iter().map(|(k, v)| (k.to_string(), serde_json::Value::String(v.to_str().unwrap_or("").to_string()))).collect();
            let text = res.text().await.unwrap_or_default();
            Ok(serde_json::json!({ "ok": true, "status": status, "statusText": "", "headers": headers_out, "body": text }))
        }
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[tauri::command]
async fn sys_info() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        use sysinfo::System;
        let mut sys = System::new_all();
        sys.refresh_all();
        let cpus = sys.cpus();
        let cpu_model = cpus.first().map(|c| c.brand().to_string()).unwrap_or_default();
        let hostname = System::host_name().unwrap_or_default();
        let uptime = System::uptime();
        let loadavg = System::load_average();
        let totalmem = sys.total_memory();
        let freemem = sys.available_memory();
        Ok(serde_json::json!({
            "platform": format!("{}", std::env::consts::OS), "arch": std::env::consts::ARCH,
            "hostname": hostname, "cpuModel": cpu_model, "cpuCores": cpus.len(),
            "cpuSpeed": cpus.first().map(|c| c.frequency() as u64).unwrap_or(0),
            "totalmem": totalmem * 1024, "freemem": freemem * 1024,
            "uptime": uptime, "loadavg": [loadavg.one, loadavg.five, loadavg.fifteen],
            "homedir": dirs_home().unwrap_or_default(),
            "nodeVersion": "", "electronVersion": "", "chromeVersion": "",
            "network": [],
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn dirs_home() -> Option<String> {
    std::env::var("USERPROFILE").ok().or_else(|| std::env::var("HOME").ok())
}

#[tauri::command]
async fn port_scan(host: String, ports: Vec<u16>, timeout: Option<u64>) -> Result<serde_json::Value, String> {
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Semaphore;
    let timeout = Duration::from_millis(timeout.unwrap_or(800));
    let sem = Arc::new(Semaphore::new(64));
    let mut handles = Vec::with_capacity(ports.len());
    for p in ports {
        let host = host.clone();
        let sem = sem.clone();
        handles.push(tokio::spawn(async move {
            let Ok(_permit) = sem.acquire().await else { return None; };
            match tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host.as_str(), p))).await {
                Ok(Ok(_)) => Some(p),
                _ => None,
            }
        }));
    }
    let mut open = Vec::new();
    for h in handles {
        if let Ok(Some(p)) = h.await {
            open.push(p);
        }
    }
    open.sort_unstable();
    Ok(serde_json::json!({ "open": open, "total": open.len() }))
}

#[tauri::command]
async fn ip_query(ip: Option<String>) -> Result<serde_json::Value, String> {
    let url = if let Some(i) = ip { format!("http://ip-api.com/json/{}?lang=zh-CN&fields=66846719", i) } else { "http://ip-api.com/json/?lang=zh-CN&fields=66846719".into() };
    match http_client().get(&url).send().await {
        Ok(res) => match res.json::<serde_json::Value>().await {
            Ok(data) => Ok(serde_json::json!({ "ok": true, "data": data })),
            Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        },
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[tauri::command]
async fn translate(text: String, from: Option<String>, to: String) -> Result<serde_json::Value, String> {
    let url = format!("https://translate.googleapis.com/translate_a/single?client=gtx&sl={}&tl={}&dt=t&q={}", from.unwrap_or_else(|| "auto".into()), to, text);
    match http_client().get(&url).send().await {
        Ok(res) => {
            let data: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);
            let translated = data[0].as_array().unwrap_or(&vec![]).iter().filter_map(|seg| seg[0].as_str()).collect::<String>();
            Ok(serde_json::json!({ "ok": true, "text": translated }))
        }
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

// ---- Hosts 读写 ----

fn hosts_path() -> &'static str {
    if cfg!(windows) { r"C:\Windows\System32\drivers\etc\hosts" } else { "/etc/hosts" }
}

#[tauri::command]
fn hosts_read() -> Result<serde_json::Value, String> {
    match fs::read_to_string(hosts_path()) {
        Ok(content) => Ok(serde_json::json!({ "ok": true, "path": hosts_path(), "content": content })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[tauri::command]
fn hosts_write(content: String) -> Result<serde_json::Value, String> {
    match fs::write(hosts_path(), content) {
        Ok(_) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": format!("{}（写 hosts 通常需要以管理员身份运行）", e) })),
    }
}

// ---- 部署工作台 ----
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::io::{BufRead, BufReader};

struct DeployState {
    child: Option<Child>,
    cancelled: bool,
}

fn tasks_file(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from(".")).join("deploy-tasks.json")
}

// 读 JSON 文件（io 和 serde 错误都归为 None）
fn read_json_file(path: &Path) -> Option<serde_json::Value> {
    let s = fs::read_to_string(path).ok()?;
    serde_json::from_str(&s).ok()
}

// 内置部署任务种子（打包时内嵌，与 public/seed-deploy.json 同源）
const SEED_DEPLOY: &str = include_str!("../seed-deploy.json");

#[tauri::command]
fn deploy_list(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let f = tasks_file(&app);
    eprintln!("[deploy_list] file={:?} exists={}", f, f.exists());
    if !f.exists() {
        // 首次：写入内置种子任务
        if let Ok(seed) = serde_json::from_str::<serde_json::Value>(SEED_DEPLOY) {
            let _ = fs::create_dir_all(f.parent().unwrap_or(Path::new(".")));
            let _ = fs::write(&f, seed.to_string());
            eprintln!("[deploy_list] seeded {} bytes", seed.to_string().len());
        }
    }
    let tasks = read_json_file(&f).unwrap_or(serde_json::json!([]));
    eprintln!("[deploy_list] tasks count = {}", tasks.as_array().map(|a| a.len()).unwrap_or(0));
    Ok(serde_json::json!({ "ok": true, "tasks": tasks }))
}

#[tauri::command]
fn deploy_save(app: tauri::AppHandle, task: serde_json::Value) -> Result<serde_json::Value, String> {
    let f = tasks_file(&app);
    let mut tasks: Vec<serde_json::Value> = read_json_file(&f).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let id = task.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if id.is_empty() {
        let new_id = format!("t-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
        let mut t = task.clone();
        t["id"] = serde_json::json!(new_id);
        if t.get("createdAt").is_none() { t["createdAt"] = serde_json::json!(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()); }
        tasks.push(t);
    } else {
        if let Some(existing) = tasks.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(id.as_str())) {
            *existing = task.clone();
        }
    }
    if let Err(e) = fs::write(&f, serde_json::to_string(&tasks).unwrap_or_default()) {
        return Ok(serde_json::json!({ "ok": false, "error": e.to_string() }));
    }
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
fn deploy_delete(app: tauri::AppHandle, id: String) -> Result<serde_json::Value, String> {
    let f = tasks_file(&app);
    let mut tasks: Vec<serde_json::Value> = read_json_file(&f).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    tasks.retain(|t| t.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
    if let Err(e) = fs::write(&f, serde_json::to_string(&tasks).unwrap_or_default()) {
        return Ok(serde_json::json!({ "ok": false, "error": e.to_string() }));
    }
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn deploy_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<DeployState>>,
    id: String,
    overrides: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let f = tasks_file(&app);
    let tasks: Vec<serde_json::Value> = read_json_file(&f).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let task = tasks.iter().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(id.as_str())).cloned();
    let Some(task) = task else { return Ok(serde_json::json!({ "ok": false, "msg": "任务不存在" })) };
    let cmds_val = overrides.as_ref().and_then(|o| o.get("commands")).cloned().unwrap_or(task.get("commands").cloned().unwrap_or(serde_json::json!([])));
    let cmds: Vec<String> = cmds_val.as_array().map(|a| a.iter().filter_map(|c| c.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
    if cmds.is_empty() { return Ok(serde_json::json!({ "ok": false, "msg": "没有可执行的命令" })); }
    let cwd = task.get("cwd").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let task_name = task.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();

    {
        let mut st = state.lock().unwrap();
        if st.child.is_some() { return Ok(serde_json::json!({ "ok": false, "msg": "已有任务在运行" })); }
        st.cancelled = false;
    }
    let _ = app.emit("deploy-output", serde_json::json!({ "id": id, "type": "start", "task": task_name }));

    let mut failed = false;
    let mut stopped = false;
    for cmd in &cmds {
        {
            let st = state.lock().unwrap();
            if st.cancelled { stopped = true; break; }
        }
        let _ = app.emit("deploy-output", serde_json::json!({ "id": id, "type": "cmd", "text": format!("> {}", cmd) }));
        // Windows 用 cmd /C 执行
        let mut child = if cfg!(windows) {
            Command::new("cmd").args(["/C", cmd]).current_dir(if cwd.is_empty() { "." } else { &cwd }).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        } else {
            Command::new("sh").args(["-c", cmd]).current_dir(if cwd.is_empty() { "." } else { &cwd }).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        };
        let Ok(mut child) = child else { let _ = app.emit("deploy-output", serde_json::json!({ "id": id, "type": "err", "text": "无法启动进程" })); failed = true; break; };
        {
            let mut st = state.lock().unwrap();
            st.child = Some(child);
            child = st.child.take().unwrap();
        }
        // 读 stdout/stderr
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        if let Some(out) = stdout {
            let app2 = app.clone();
            let id2 = id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let reader = BufReader::new(out);
                for line in reader.lines().map_while(Result::ok) {
                    let _ = app2.emit("deploy-output", serde_json::json!({ "id": id2, "type": "out", "text": format!("{}\n", line) }));
                }
            });
        }
        if let Some(err) = stderr {
            let app2 = app.clone();
            let id2 = id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let reader = BufReader::new(err);
                for line in reader.lines().map_while(Result::ok) {
                    let _ = app2.emit("deploy-output", serde_json::json!({ "id": id2, "type": "err", "text": format!("{}\n", line) }));
                }
            });
        }
        let code = child.wait().map(|s| s.code().unwrap_or(1)).unwrap_or(1);
        {
            let mut st = state.lock().unwrap();
            st.child = None;
            if st.cancelled { stopped = true; }
        }
        let _ = app.emit("deploy-output", serde_json::json!({ "id": id, "type": "close", "code": code }));
        if stopped { break; }
        if code != 0 {
            let _ = app.emit("deploy-output", serde_json::json!({ "id": id, "type": "failed", "code": code }));
            failed = true;
            break;
        }
    }
    if !stopped && !failed {
        let _ = app.emit("deploy-output", serde_json::json!({ "id": id, "type": "done" }));
    }
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn deploy_pick_dir(window: tauri::Window) -> Result<serde_json::Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let res = window.dialog().file().blocking_pick_folder();
    let Some(path) = res else { return Ok(serde_json::json!({ "ok": false, "canceled": true })) };
    Ok(serde_json::json!({ "ok": true, "path": path.into_path().unwrap_or_default().to_string_lossy() }))
}

const DIFF_SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", ".svn", ".hg", "dist", "build", "target",
    "__pycache__", ".idea", ".vscode", ".next", "coverage", ".cache",
    ".turbo", ".nuxt", "vendor",
];

fn diff_should_skip(name: &str) -> bool {
    DIFF_SKIP_DIRS.iter().any(|s| *s == name)
}

fn diff_scan_walk(root: &Path, dir: &Path, out: &mut Vec<serde_json::Value>, depth: u32) {
    if depth > 40 || out.len() >= 20000 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for e in items {
        if out.len() >= 20000 {
            return;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if diff_should_skip(&name) {
            continue;
        }
        let p = e.path();
        let Ok(meta) = e.metadata() else {
            continue;
        };
        if meta.is_dir() {
            diff_scan_walk(root, &p, out, depth + 1);
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let rel = p
            .strip_prefix(root)
            .unwrap_or(&p)
            .to_string_lossy()
            .replace('\\', "/");
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(serde_json::json!({
            "path": rel,
            "size": meta.len(),
            "mtime": mtime,
        }));
    }
}

/// 选择文件夹（Diff 文件夹对比）
#[tauri::command]
async fn diff_pick_dir(window: tauri::Window) -> Result<serde_json::Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let res = window.dialog().file().blocking_pick_folder();
    let Some(path) = res else {
        return Ok(serde_json::json!({ "ok": false, "canceled": true }));
    };
    Ok(serde_json::json!({
        "ok": true,
        "path": path.into_path().unwrap_or_default().to_string_lossy()
    }))
}

/// 递归扫描目录文件列表（跳过常见构建/依赖目录）
#[tauri::command]
async fn diff_scan_dir(dir: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(dir.trim());
        if !root.is_dir() {
            return Ok(serde_json::json!({ "ok": false, "error": "不是有效目录" }));
        }
        let mut files = Vec::new();
        diff_scan_walk(&root, &root, &mut files, 0);
        let truncated = files.len() >= 20000;
        Ok(serde_json::json!({
            "ok": true,
            "dir": root.to_string_lossy(),
            "files": files,
            "count": files.len(),
            "truncated": truncated,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取文本文件供 Diff 内容对比（有大小上限）
#[tauri::command]
async fn diff_read_text(path: String, max_bytes: Option<u64>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(path);
        let lim = max_bytes.unwrap_or(2 * 1024 * 1024);
        let meta = match fs::metadata(&p) {
            Ok(m) => m,
            Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        };
        if meta.len() > lim {
            return Ok(serde_json::json!({
                "ok": false,
                "tooLarge": true,
                "error": format!("文件过大（{} bytes），无法文本对比", meta.len())
            }));
        }
        match fs::read(&p) {
            Ok(bytes) => {
                let sample_len = bytes.len().min(8000);
                if bytes[..sample_len].iter().any(|b| *b == 0) {
                    return Ok(serde_json::json!({
                        "ok": false,
                        "binary": true,
                        "error": "二进制文件，无法文本对比"
                    }));
                }
                let body = String::from_utf8_lossy(&bytes).into_owned();
                Ok(serde_json::json!({ "ok": true, "body": body }))
            }
            Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn deploy_stop(state: tauri::State<'_, Mutex<DeployState>>, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let mut st = state.lock().unwrap();
    st.cancelled = true;
    if let Some(mut child) = st.child.take() {
        if cfg!(windows) {
            let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &child.id().to_string()]).spawn();
        } else {
            let _ = child.kill();
        }
    }
    let _ = app.emit("deploy-output", serde_json::json!({ "type": "cancelled" }));
    Ok(serde_json::json!({ "ok": true }))
}

// ---- SSH / SFTP ----
use std::collections::HashMap;
use std::net::TcpStream;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

type SharedSsh = Arc<Mutex<SshState>>;
type SftpHandle = Arc<Mutex<(ssh2::Session, ssh2::Sftp)>>;

struct SshState {
    sessions: HashMap<String, ssh2::Session>,
    streams: HashMap<String, Arc<Mutex<ssh2::Channel>>>,
    // 凭据：供 SFTP 用独立阻塞 session（避免与终端读线程抢同一 Session）
    creds: HashMap<String, (String, u16, String, String)>,
    // 长连接 SFTP：避免每次 list/read/write 都重新握手
    sftp: HashMap<String, SftpHandle>,
}

fn ssh_is_again(err: &ssh2::Error) -> bool {
    // libssh2: EAGAIN=-37, TIMEOUT=-9
    matches!(err.code(), ssh2::ErrorCode::Session(-37) | ssh2::ErrorCode::Session(-9))
}

fn ssh_retry<T, F>(mut op: F) -> Result<T, ssh2::Error>
where
    F: FnMut() -> Result<T, ssh2::Error>,
{
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) if ssh_is_again(&e) => {
                if Instant::now() >= deadline {
                    return Err(e);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(e),
        }
    }
}

fn ssh_spawn_reader(app: tauri::AppHandle, id: String, ch_arc: Arc<Mutex<ssh2::Channel>>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            let read_result = {
                let mut ch = match ch_arc.lock() {
                    Ok(c) => c,
                    Err(_) => break,
                };
                ch.read(&mut buf)
            };
            match read_result {
                Ok(0) => {
                    let _ = app.emit("ssh-output", serde_json::json!({ "id": id, "type": "closed" }));
                    break;
                }
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit("ssh-output", serde_json::json!({ "id": id, "type": "data", "data": text }));
                }
                Err(e) => {
                    let kind = e.kind();
                    if kind == std::io::ErrorKind::WouldBlock
                        || kind == std::io::ErrorKind::TimedOut
                        || kind == std::io::ErrorKind::Interrupted
                    {
                        std::thread::sleep(Duration::from_millis(20));
                        continue;
                    }
                    let _ = app.emit("ssh-output", serde_json::json!({ "id": id, "type": "closed" }));
                    break;
                }
            }
        }
    });
}

fn ssh_open_shell(sess: &mut ssh2::Session) -> Result<ssh2::Channel, String> {
    // 握手后全程阻塞开 shell；禁止 set_blocking(false)，否则 channel_session/shell 会直接 -37
    sess.set_blocking(true);
    let _ = sess.set_timeout(0); // 0 = 无超时，等网络完成
    let mut ch = ssh_retry(|| sess.channel_session()).map_err(|e| format!("channel_session: {e}"))?;
    let _ = ssh_retry(|| ch.request_pty("xterm-256color", None, Some((100, 30, 0, 0))));
    ssh_retry(|| ch.shell()).map_err(|e| format!("shell: {e}"))?;
    // 读线程用短超时让出锁，便于 ssh_write；不要用 set_blocking(false)
    let _ = sess.set_timeout(100);
    Ok(ch)
}

fn ssh_connect_inner(
    app: tauri::AppHandle,
    state: SharedSsh,
    host: String,
    port: u16,
    username: String,
    password: String,
) -> Result<serde_json::Value, String> {
    let tcp = TcpStream::connect((host.as_str(), port)).map_err(|e| e.to_string())?;
    let _ = tcp.set_read_timeout(None);
    let _ = tcp.set_write_timeout(None);
    let mut sess = ssh2::Session::new().map_err(|e| e.to_string())?;
    sess.set_blocking(true);
    let _ = sess.set_timeout(0);
    sess.set_tcp_stream(tcp);
    ssh_retry(|| sess.handshake()).map_err(|e| format!("handshake: {e}"))?;
    ssh_retry(|| sess.userauth_password(&username, &password)).map_err(|e| format!("auth: {e}"))?;
    if !sess.authenticated() {
        return Ok(serde_json::json!({ "ok": false, "error": "认证失败" }));
    }
    let ch = ssh_open_shell(&mut sess)?;
    let id = format!(
        "ssh-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    let ch_arc = Arc::new(Mutex::new(ch));
    {
        let mut st = state.lock().unwrap();
        st.sessions.insert(id.clone(), sess);
        st.streams.insert(id.clone(), ch_arc.clone());
        st.creds.insert(id.clone(), (host, port, username, password));
    }
    ssh_spawn_reader(app, id.clone(), ch_arc);
    Ok(serde_json::json!({ "ok": true, "id": id }))
}

#[tauri::command]
async fn ssh_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedSsh>,
    host: String,
    port: Option<u16>,
    username: String,
    password: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port.unwrap_or(22);
    let password = password.unwrap_or_default();
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || ssh_connect_inner(app, state, host, port, username, password))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn ssh_write(
    _app: tauri::AppHandle,
    state: tauri::State<'_, SharedSsh>,
    local: tauri::State<'_, SharedLocalShell>,
    id: String,
    data: String,
) -> Result<serde_json::Value, String> {
    if id.starts_with("local-") {
        return local_shell_write(local.inner().clone(), &id, &data);
    }
    let st = state.lock().unwrap();
    let Some(stream) = st.streams.get(&id) else {
        return Ok(serde_json::json!({ "ok": false, "error": "未连接" }));
    };
    let mut ch = stream.lock().map_err(|e| e.to_string())?;
    let bytes = data.as_bytes();
    let mut off = 0usize;
    let deadline = Instant::now() + Duration::from_secs(10);
    while off < bytes.len() {
        match ch.write(&bytes[off..]) {
            Ok(0) => break,
            Ok(n) => off += n,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::Interrupted => {
                if Instant::now() >= deadline {
                    return Ok(serde_json::json!({ "ok": false, "error": e.to_string() }));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        }
    }
    let _ = ch.flush();
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
fn ssh_resize(
    state: tauri::State<'_, SharedSsh>,
    local: tauri::State<'_, SharedLocalShell>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<serde_json::Value, String> {
    if id.starts_with("local-") {
        return local_shell_resize(local.inner().clone(), &id, cols, rows);
    }
    let st = state.lock().unwrap();
    let Some(stream) = st.streams.get(&id) else {
        return Ok(serde_json::json!({ "ok": false, "error": "未连接" }));
    };
    let mut ch = stream.lock().map_err(|e| e.to_string())?;
    let cols = cols.max(1);
    let rows = rows.max(1);
    match ch.request_pty_size(cols, rows, None, None) {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[tauri::command]
fn ssh_disconnect(
    state: tauri::State<'_, SharedSsh>,
    local: tauri::State<'_, SharedLocalShell>,
    id: String,
) -> Result<serde_json::Value, String> {
    if id.starts_with("local-") {
        return local_shell_disconnect(local.inner().clone(), &id);
    }
    let mut st = state.lock().unwrap();
    st.streams.remove(&id);
    st.sessions.remove(&id);
    st.creds.remove(&id);
    st.sftp.remove(&id);
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
fn ssh_list(
    state: tauri::State<'_, SharedSsh>,
    local: tauri::State<'_, SharedLocalShell>,
) -> Result<serde_json::Value, String> {
    let mut sessions: Vec<serde_json::Value> = {
        let st = state.lock().unwrap();
        st.sessions
            .keys()
            .map(|id| serde_json::json!({ "id": id, "kind": "ssh" }))
            .collect()
    };
    {
        let st = local.lock().unwrap();
        for (id, entry) in st.sessions.iter() {
            sessions.push(serde_json::json!({
                "id": id,
                "kind": "local",
                "name": entry.name,
                "shell": entry.shell,
                "user": "",
                "host": "localhost",
            }));
        }
    }
    Ok(serde_json::json!({ "ok": true, "sessions": sessions }))
}

// ---- 本机终端（CMD / PowerShell，ConPTY）----
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};

struct LocalShellEntry {
    name: String,
    shell: String,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Box<dyn MasterPty + Send>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}

struct LocalShellState {
    sessions: HashMap<String, LocalShellEntry>,
}

type SharedLocalShell = Arc<Mutex<LocalShellState>>;

fn local_shell_targets(shell: &str) -> Result<(&'static str, Vec<&'static str>, String, String), String> {
    let key = shell.trim().to_lowercase();
    #[cfg(windows)]
    {
        match key.as_str() {
            "cmd" => Ok(("cmd.exe", vec![], "cmd".into(), "CMD".into())),
            "powershell" | "ps" => Ok(("powershell.exe", vec!["-NoLogo"], "powershell".into(), "PowerShell".into())),
            "pwsh" => Ok(("pwsh.exe", vec!["-NoLogo"], "pwsh".into(), "PowerShell".into())),
            _ => Err(format!("不支持的本机 shell：{shell}（可用 cmd / powershell）")),
        }
    }
    #[cfg(not(windows))]
    {
        match key.as_str() {
            "cmd" | "sh" | "bash" => Ok(("bash", vec![], "bash".into(), "Bash".into())),
            "powershell" | "ps" | "pwsh" => Ok(("pwsh", vec!["-NoLogo"], "pwsh".into(), "PowerShell".into())),
            _ => Err(format!("不支持的本机 shell：{shell}")),
        }
    }
}

fn local_shell_builder(shell: &str) -> Result<(CommandBuilder, String, String), String> {
    let (exe, args, shell_key, base_name) = local_shell_targets(shell)?;
    let mut cmd = CommandBuilder::new(exe);
    for a in args {
        cmd.arg(a);
    }
    Ok((cmd, shell_key, base_name))
}

fn local_shell_spawn_reader(
    app: tauri::AppHandle,
    id: String,
    mut reader: Box<dyn Read + Send>,
    state: SharedLocalShell,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = app.emit("ssh-output", serde_json::json!({ "id": id, "type": "closed" }));
                    let mut st = state.lock().unwrap();
                    st.sessions.remove(&id);
                    break;
                }
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit("ssh-output", serde_json::json!({ "id": id, "type": "data", "data": text }));
                }
                Err(e) => {
                    let kind = e.kind();
                    if kind == std::io::ErrorKind::WouldBlock
                        || kind == std::io::ErrorKind::TimedOut
                        || kind == std::io::ErrorKind::Interrupted
                    {
                        std::thread::sleep(Duration::from_millis(20));
                        continue;
                    }
                    let _ = app.emit("ssh-output", serde_json::json!({ "id": id, "type": "closed" }));
                    let mut st = state.lock().unwrap();
                    st.sessions.remove(&id);
                    break;
                }
            }
        }
    });
}

fn local_shell_open_inner(
    app: tauri::AppHandle,
    state: SharedLocalShell,
    shell: String,
) -> Result<serde_json::Value, String> {
    let (mut cmd, shell_key, display_name) = local_shell_builder(&shell)?;
    if let Ok(home) = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        if !home.is_empty() {
            cmd.cwd(home);
        }
    }

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {shell_key}: {e}"))?;
    // slave 端交给子进程后即可丢弃
    drop(pair.slave);

    // Windows ConPTY 启动时可能发 ESC[6n 等待光标位置，不回复会卡住
    #[cfg(windows)]
    {
        let _ = writer.write_all(b"\x1b[1;1R");
        let _ = writer.flush();
    }

    let id = format!(
        "local-{}-{}",
        shell_key,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    let killer = child.clone_killer();
    {
        let mut st = state.lock().unwrap();
        st.sessions.insert(
            id.clone(),
            LocalShellEntry {
                name: display_name.clone(),
                shell: shell_key.clone(),
                writer: Mutex::new(writer),
                master: pair.master,
                killer: Mutex::new(killer),
            },
        );
    }

    // 后台等子进程退出（读线程 EOF 也会清理）
    {
        let app2 = app.clone();
        let id2 = id.clone();
        let state2 = state.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            let removed = {
                let mut st = state2.lock().unwrap();
                st.sessions.remove(&id2).is_some()
            };
            if removed {
                let _ = app2.emit("ssh-output", serde_json::json!({ "id": id2, "type": "closed" }));
            }
        });
    }

    local_shell_spawn_reader(app, id.clone(), reader, state);
    Ok(serde_json::json!({
        "ok": true,
        "id": id,
        "name": display_name,
        "shell": shell_key,
    }))
}

#[tauri::command]
async fn local_shell_open(
    app: tauri::AppHandle,
    local: tauri::State<'_, SharedLocalShell>,
    shell: String,
) -> Result<serde_json::Value, String> {
    let state = local.inner().clone();
    tauri::async_runtime::spawn_blocking(move || local_shell_open_inner(app, state, shell))
        .await
        .map_err(|e| e.to_string())?
}

fn local_shell_write(state: SharedLocalShell, id: &str, data: &str) -> Result<serde_json::Value, String> {
    let st = state.lock().unwrap();
    let Some(entry) = st.sessions.get(id) else {
        return Ok(serde_json::json!({ "ok": false, "error": "未连接" }));
    };
    let mut writer = entry.writer.lock().map_err(|e| e.to_string())?;
    let bytes = data.as_bytes();
    let mut off = 0usize;
    let deadline = Instant::now() + Duration::from_secs(10);
    while off < bytes.len() {
        match writer.write(&bytes[off..]) {
            Ok(0) => break,
            Ok(n) => off += n,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::Interrupted =>
            {
                if Instant::now() >= deadline {
                    return Ok(serde_json::json!({ "ok": false, "error": e.to_string() }));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        }
    }
    let _ = writer.flush();
    Ok(serde_json::json!({ "ok": true }))
}

fn local_shell_resize(state: SharedLocalShell, id: &str, cols: u32, rows: u32) -> Result<serde_json::Value, String> {
    let st = state.lock().unwrap();
    let Some(entry) = st.sessions.get(id) else {
        return Ok(serde_json::json!({ "ok": false, "error": "未连接" }));
    };
    match entry.master.resize(PtySize {
        rows: rows.max(1) as u16,
        cols: cols.max(1) as u16,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

fn local_shell_disconnect(state: SharedLocalShell, id: &str) -> Result<serde_json::Value, String> {
    let mut st = state.lock().unwrap();
    if let Some(entry) = st.sessions.remove(id) {
        if let Ok(mut killer) = entry.killer.lock() {
            let _ = killer.kill();
        }
    }
    Ok(serde_json::json!({ "ok": true }))
}

fn ssh_saved_file(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("ssh-sessions.json")
}

#[tauri::command]
async fn ssh_sessions_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let f = ssh_saved_file(&app);
        if !f.exists() {
            return Ok(serde_json::json!({ "ok": true, "sessions": [] }));
        }
        match fs::read_to_string(&f) {
            Ok(text) => {
                let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::json!([]));
                let sessions = if v.is_array() {
                    v
                } else {
                    v.get("sessions").cloned().unwrap_or(serde_json::json!([]))
                };
                Ok(serde_json::json!({ "ok": true, "sessions": sessions }))
            }
            Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string(), "sessions": [] })),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ssh_sessions_save(app: tauri::AppHandle, sessions: serde_json::Value) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let f = ssh_saved_file(&app);
        if let Some(parent) = f.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let list = if sessions.is_array() {
            sessions
        } else {
            sessions.get("sessions").cloned().unwrap_or(serde_json::json!([]))
        };
        match fs::write(&f, list.to_string()) {
            Ok(()) => Ok(serde_json::json!({ "ok": true })),
            Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- SFTP ----

fn sftp_open_new(host: &str, port: u16, user: &str, pass: &str) -> Result<SftpHandle, String> {
    let tcp = TcpStream::connect((host, port)).map_err(|e| e.to_string())?;
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs(30)));
    let mut sess = ssh2::Session::new().map_err(|e| e.to_string())?;
    sess.set_blocking(true);
    let _ = sess.set_timeout(0);
    sess.set_tcp_stream(tcp);
    ssh_retry(|| sess.handshake()).map_err(|e| format!("sftp handshake: {e}"))?;
    ssh_retry(|| sess.userauth_password(user, pass)).map_err(|e| format!("sftp auth: {e}"))?;
    let sftp = sess.sftp().map_err(|e| e.to_string())?;
    Ok(Arc::new(Mutex::new((sess, sftp))))
}

fn sftp_get(st: &mut SshState, id: &str) -> Result<SftpHandle, String> {
    if let Some(h) = st.sftp.get(id) {
        return Ok(h.clone());
    }
    let Some((host, port, user, pass)) = st.creds.get(id).cloned() else {
        return Err("未连接".into());
    };
    let handle = sftp_open_new(&host, port, &user, &pass)?;
    st.sftp.insert(id.to_string(), handle.clone());
    Ok(handle)
}

fn sftp_invalidate(st: &mut SshState, id: &str) {
    st.sftp.remove(id);
}

fn sftp_list_inner(state: &SharedSsh, id: String, path: Option<String>) -> Result<serde_json::Value, String> {
    let handle = {
        let mut st = state.lock().unwrap();
        sftp_get(&mut st, &id)?
    };
    let p = path.unwrap_or_else(|| ".".into());
    let result = (|| -> Result<Vec<serde_json::Value>, String> {
        let guard = handle.lock().map_err(|e| e.to_string())?;
        let entries = guard.1.readdir(std::path::Path::new(&p)).map_err(|e| e.to_string())?;
        let mut items: Vec<serde_json::Value> = entries
            .iter()
            .map(|(path, stat)| {
                serde_json::json!({
                    "name": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    "isDir": stat.is_dir(),
                    "size": stat.size,
                    "mtime": stat.mtime.unwrap_or(0) * 1000
                })
            })
            .collect();
        items.sort_by(|a, b| {
            let ad = a["isDir"].as_bool().unwrap_or(false);
            let bd = b["isDir"].as_bool().unwrap_or(false);
            if ad != bd {
                if ad { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater }
            } else {
                std::cmp::Ordering::Equal
            }
        });
        Ok(items)
    })();
    match result {
        Ok(items) => Ok(serde_json::json!({ "ok": true, "items": items })),
        Err(e) => {
            let mut st = state.lock().unwrap();
            sftp_invalidate(&mut st, &id);
            Ok(serde_json::json!({ "ok": false, "error": e }))
        }
    }
}

#[tauri::command]
async fn sftp_list(state: tauri::State<'_, SharedSsh>, id: String, path: Option<String>) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sftp_list_inner(&state, id, path))
        .await
        .map_err(|e| e.to_string())?
}

fn sftp_read_inner(state: &SharedSsh, id: String, path: String) -> Result<serde_json::Value, String> {
    let handle = {
        let mut st = state.lock().unwrap();
        sftp_get(&mut st, &id)?
    };
    let result = (|| -> Result<String, String> {
        let guard = handle.lock().map_err(|e| e.to_string())?;
        let mut content = Vec::new();
        guard.1.open(std::path::Path::new(&path)).map_err(|e| e.to_string())?.read_to_end(&mut content).map_err(|e| e.to_string())?;
        Ok(base64_encode(&content))
    })();
    match result {
        Ok(content) => Ok(serde_json::json!({ "ok": true, "content": content })),
        Err(e) => {
            let mut st = state.lock().unwrap();
            sftp_invalidate(&mut st, &id);
            Ok(serde_json::json!({ "ok": false, "error": e }))
        }
    }
}

#[tauri::command]
async fn sftp_read(state: tauri::State<'_, SharedSsh>, id: String, path: String) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sftp_read_inner(&state, id, path))
        .await
        .map_err(|e| e.to_string())?
}

fn sftp_write_inner(state: &SharedSsh, id: String, path: String, content: String) -> Result<serde_json::Value, String> {
    let handle = {
        let mut st = state.lock().unwrap();
        sftp_get(&mut st, &id)?
    };
    let result = (|| -> Result<(), String> {
        let guard = handle.lock().map_err(|e| e.to_string())?;
        let mut f = guard.1.create(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
        let bytes = base64_decode(&content)?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
        Ok(())
    })();
    match result {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => {
            let mut st = state.lock().unwrap();
            sftp_invalidate(&mut st, &id);
            Ok(serde_json::json!({ "ok": false, "error": e }))
        }
    }
}

#[tauri::command]
async fn sftp_write(state: tauri::State<'_, SharedSsh>, id: String, path: String, content: String) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sftp_write_inner(&state, id, path, content))
        .await
        .map_err(|e| e.to_string())?
}

fn sftp_mkdir_inner(state: &SharedSsh, id: String, path: String) -> Result<serde_json::Value, String> {
    let handle = {
        let mut st = state.lock().unwrap();
        sftp_get(&mut st, &id)?
    };
    let result = (|| -> Result<(), String> {
        let guard = handle.lock().map_err(|e| e.to_string())?;
        guard.1.mkdir(std::path::Path::new(&path), 0o755).map_err(|e| e.to_string())?;
        Ok(())
    })();
    match result {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => {
            let mut st = state.lock().unwrap();
            sftp_invalidate(&mut st, &id);
            Ok(serde_json::json!({ "ok": false, "error": e }))
        }
    }
}

#[tauri::command]
async fn sftp_mkdir(state: tauri::State<'_, SharedSsh>, id: String, path: String) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sftp_mkdir_inner(&state, id, path))
        .await
        .map_err(|e| e.to_string())?
}

fn sftp_delete_inner(state: &SharedSsh, id: String, path: String, is_dir: bool) -> Result<serde_json::Value, String> {
    let handle = {
        let mut st = state.lock().unwrap();
        sftp_get(&mut st, &id)?
    };
    let result = (|| -> Result<(), String> {
        let guard = handle.lock().map_err(|e| e.to_string())?;
        let r = if is_dir {
            guard.1.rmdir(std::path::Path::new(&path))
        } else {
            guard.1.unlink(std::path::Path::new(&path))
        };
        r.map_err(|e| e.to_string())?;
        Ok(())
    })();
    match result {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => {
            let mut st = state.lock().unwrap();
            sftp_invalidate(&mut st, &id);
            Ok(serde_json::json!({ "ok": false, "error": e }))
        }
    }
}

#[tauri::command]
async fn sftp_delete(state: tauri::State<'_, SharedSsh>, id: String, path: String, is_dir: bool) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sftp_delete_inner(&state, id, path, is_dir))
        .await
        .map_err(|e| e.to_string())?
}

fn ssh_sysinfo_inner(state: &SharedSsh, id: &str) -> Result<serde_json::Value, String> {
    let (host, port, user, pass) = {
        let st = state.lock().unwrap();
        st.creds.get(id).cloned().ok_or_else(|| "未连接".to_string())?
    };
    let tcp = TcpStream::connect((host.as_str(), port)).map_err(|e| e.to_string())?;
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(20)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs(20)));
    let mut sess = ssh2::Session::new().map_err(|e| e.to_string())?;
    sess.set_blocking(true);
    let _ = sess.set_timeout(0);
    sess.set_tcp_stream(tcp);
    ssh_retry(|| sess.handshake()).map_err(|e| format!("handshake: {e}"))?;
    ssh_retry(|| sess.userauth_password(&user, &pass)).map_err(|e| format!("auth: {e}"))?;
    let mut ch = ssh_retry(|| sess.channel_session()).map_err(|e| e.to_string())?;
    // 一次 exec 采齐字段，避免多次往返
    let script = r#"
printf 'hostname=%s\n' "$(hostname 2>/dev/null)"
printf 'os=%s\n' "$(cat /etc/os-release 2>/dev/null | grep -E '^(PRETTY_NAME)=' | head -1 | cut -d= -f2 | tr -d '"')"
printf 'kernel=%s\n' "$(uname -r 2>/dev/null)"
printf 'arch=%s\n' "$(uname -m 2>/dev/null)"
printf 'uptime=%s\n' "$(cat /proc/uptime 2>/dev/null | awk '{print int($1)}')"
printf 'cpuModel=%s\n' "$(grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | sed 's/^ *//')"
printf 'cpuCores=%s\n' "$(nproc 2>/dev/null)"
printf 'cpuUsage=%s\n' "$(top -bn1 2>/dev/null | grep 'Cpu(s)' | awk '{print 100-$8}' | cut -d. -f1)"
printf 'mem=%s\n' "$(free -m 2>/dev/null | awk '/^Mem:/{printf "%d %d", $2, $7}')"
printf 'disk=%s\n' "$(df -P / 2>/dev/null | awk 'NR==2{printf "%s %s %s", $2, $3, $5}')"
printf 'load=%s\n' "$(cat /proc/loadavg 2>/dev/null | awk '{print $1" "$2" "$3}')"
printf 'ip=%s\n' "$(hostname -I 2>/dev/null | awk '{print $1}')"
"#;
    ch.exec(script).map_err(|e| e.to_string())?;
    let mut out = String::new();
    ch.read_to_string(&mut out).map_err(|e| e.to_string())?;
    let _ = ch.wait_close();

    let mut map = std::collections::HashMap::<String, String>::new();
    for line in out.lines() {
        if let Some((k, v)) = line.split_once('=') {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    let get = |k: &str| map.get(k).cloned().unwrap_or_default();

    let mem_parts: Vec<i64> = get("mem").split_whitespace().filter_map(|x| x.parse().ok()).collect();
    let mem = if mem_parts.len() >= 2 {
        let total = mem_parts[0];
        let avail = mem_parts[1];
        let used = (total - avail).max(0);
        let used_percent = if total > 0 { ((used as f64 / total as f64) * 100.0).round() as i64 } else { 0 };
        serde_json::json!({ "total": total, "used": used, "usedPercent": used_percent })
    } else {
        serde_json::Value::Null
    };

    let disk_parts: Vec<String> = get("disk").split_whitespace().map(|s| s.to_string()).collect();
    let disk = if disk_parts.len() >= 3 {
        serde_json::json!({
            "total": disk_parts[0],
            "used": disk_parts[1],
            "percent": disk_parts[2].trim_end_matches('%')
        })
    } else {
        serde_json::Value::Null
    };

    let up_sec: i64 = get("uptime").parse().unwrap_or(0);
    let d = up_sec / 86400;
    let h = (up_sec % 86400) / 3600;
    let m = (up_sec % 3600) / 60;
    let uptime = if d > 0 {
        format!("{d}天 {h}时 {m}分")
    } else {
        format!("{h}时 {m}分")
    };

    let cpu_usage = get("cpuUsage").parse::<i64>().unwrap_or(0).clamp(0, 100);

    Ok(serde_json::json!({
        "ok": true,
        "info": {
            "hostname": if get("hostname").is_empty() { "unknown".into() } else { get("hostname") },
            "os": if get("os").is_empty() { "unknown".into() } else { get("os") },
            "kernel": get("kernel"),
            "arch": get("arch"),
            "uptime": uptime,
            "cpuModel": get("cpuModel"),
            "cpuCores": if get("cpuCores").is_empty() { "0".into() } else { get("cpuCores") },
            "cpuUsage": cpu_usage,
            "mem": mem,
            "disk": disk,
            "load": get("load"),
            "ip": get("ip"),
        }
    }))
}

#[tauri::command]
async fn ssh_sysinfo(state: tauri::State<'_, SharedSsh>, id: String) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || ssh_sysinfo_inner(&state, &id))
        .await
        .map_err(|e| e.to_string())?
}

fn testhub_port_up(port: u16) -> bool {
    use std::net::{SocketAddr, TcpStream};
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

fn testhub_root(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("TESTHUB_ROOT") {
        let pb = PathBuf::from(p.trim());
        if pb.is_dir() {
            return pb;
        }
    }
    let cfg = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("testhub-root.txt");
    if let Ok(s) = fs::read_to_string(&cfg) {
        let pb = PathBuf::from(s.trim());
        if pb.is_dir() {
            return pb;
        }
    }
    // 本仓库默认路径（与 DevToolbox 同级）
    PathBuf::from(r"D:\mytools\testhub")
}

/// 确保本机 TestHub（MySQL + :8000 + :3001）已启动；已在跑则直接返回。
#[tauri::command]
async fn testhub_ensure(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let be = testhub_port_up(8000);
        let fe = testhub_port_up(3001);
        if be && fe {
            return Ok(serde_json::json!({
                "ok": true,
                "backend": true,
                "frontend": true,
                "started": false,
                "message": "already running"
            }));
        }

        let root = testhub_root(&app);
        let script = root.join("ensure-testhub.ps1");
        if !script.is_file() {
            return Ok(serde_json::json!({
                "ok": false,
                "backend": be,
                "frontend": fe,
                "started": false,
                "message": format!("找不到 ensure-testhub.ps1：{}（可设置环境变量 TESTHUB_ROOT）", script.display())
            }));
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let out = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    &script.to_string_lossy(),
                ])
                .current_dir(&root)
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .map_err(|e| e.to_string())?;
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let ready = testhub_port_up(8000) && testhub_port_up(3001);
            let msg = if !stdout.is_empty() {
                stdout
            } else if !stderr.is_empty() {
                stderr
            } else if ready {
                "ready".to_string()
            } else {
                format!("exit={}", out.status.code().unwrap_or(-1))
            };
            Ok(serde_json::json!({
                "ok": ready,
                "backend": testhub_port_up(8000),
                "frontend": testhub_port_up(3001),
                "started": true,
                "message": msg
            }))
        }
        #[cfg(not(windows))]
        {
            Ok(serde_json::json!({
                "ok": false,
                "backend": be,
                "frontend": fe,
                "started": false,
                "message": "testhub_ensure 仅支持 Windows"
            }))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn newapi_root(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("NEWAPI_ROOT") {
        let pb = PathBuf::from(p.trim());
        if pb.is_dir() {
            return pb;
        }
    }
    let cfg = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("newapi-root.txt");
    if let Ok(s) = fs::read_to_string(&cfg) {
        let pb = PathBuf::from(s.trim());
        if pb.is_dir() {
            return pb;
        }
    }
    PathBuf::from(r"D:\mytools\new-api")
}

/// 确保本机 New API（Docker :5780）已启动；已在跑则直接返回。
#[tauri::command]
async fn newapi_ensure(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if testhub_port_up(5780) {
            return Ok(serde_json::json!({
                "ok": true,
                "started": false,
                "message": "already running"
            }));
        }

        let root = newapi_root(&app);
        let script = root.join("ensure-new-api.ps1");
        if !script.is_file() {
            return Ok(serde_json::json!({
                "ok": false,
                "started": false,
                "message": format!("找不到 ensure-new-api.ps1：{}（可设置环境变量 NEWAPI_ROOT）", script.display())
            }));
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let out = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    &script.to_string_lossy(),
                ])
                .current_dir(&root)
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .map_err(|e| e.to_string())?;
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let ready = testhub_port_up(5780);
            let msg = if !stdout.is_empty() {
                stdout
            } else if !stderr.is_empty() {
                stderr
            } else if ready {
                "ready".to_string()
            } else {
                format!("exit={}", out.status.code().unwrap_or(-1))
            };
            Ok(serde_json::json!({
                "ok": ready,
                "started": true,
                "message": msg
            }))
        }
        #[cfg(not(windows))]
        {
            Ok(serde_json::json!({
                "ok": false,
                "started": false,
                "message": "newapi_ensure 仅支持 Windows"
            }))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 确保本机 OpenAcme（:3456）已启动；已在跑则直接返回。
#[tauri::command]
async fn openacme_ensure(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if testhub_port_up(3456) {
            return Ok(serde_json::json!({
                "ok": true,
                "started": false,
                "message": "already running"
            }));
        }

        let root = openacme_root(&app);
        let script = root.join("ensure-openacme.ps1");
        if !script.is_file() {
            return Ok(serde_json::json!({
                "ok": false,
                "started": false,
                "message": format!("找不到 ensure-openacme.ps1：{}（可设置环境变量 OPENACME_ROOT）", script.display())
            }));
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let out = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    &script.to_string_lossy(),
                ])
                .current_dir(&root)
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .map_err(|e| e.to_string())?;
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout) {
                let ready = testhub_port_up(3456)
                    || v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
                let mut obj = v;
                if let Some(map) = obj.as_object_mut() {
                    map.insert("ok".into(), serde_json::json!(ready));
                    map.insert("started".into(), serde_json::json!(true));
                }
                return Ok(obj);
            }
            let ready = testhub_port_up(3456);
            let msg = if !stdout.is_empty() {
                stdout
            } else if !stderr.is_empty() {
                stderr
            } else if ready {
                "ready".to_string()
            } else {
                format!("exit={}", out.status.code().unwrap_or(-1))
            };
            Ok(serde_json::json!({
                "ok": ready,
                "started": true,
                "message": msg
            }))
        }
        #[cfg(not(windows))]
        {
            Ok(serde_json::json!({
                "ok": false,
                "started": false,
                "message": "openacme_ensure 当前打包仅实现了 Windows 启动脚本；请本机直接执行 openacme"
            }))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn openacme_root(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("OPENACME_ROOT") {
        let pb = PathBuf::from(p.trim());
        if pb.is_dir() {
            return pb;
        }
    }
    let cfg = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("openacme-root.txt");
    if let Ok(s) = fs::read_to_string(&cfg) {
        let pb = PathBuf::from(s.trim());
        if pb.is_dir() {
            return pb;
        }
    }
    PathBuf::from(r"D:\mytools\dev-toolbox\openacme")
}

fn stirling_root(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("STIRLING_ROOT") {
        let pb = PathBuf::from(p.trim());
        if pb.is_dir() {
            return pb;
        }
    }
    let cfg = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("stirling-root.txt");
    if let Ok(s) = fs::read_to_string(&cfg) {
        let pb = PathBuf::from(s.trim());
        if pb.is_dir() {
            return pb;
        }
    }
    PathBuf::from(r"D:\mytools\dev-toolbox\stirling-pdf")
}

/// 确保本机 Stirling-PDF（Docker :8090）已启动；已在跑则直接返回。
#[tauri::command]
async fn stirling_ensure(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if testhub_port_up(8090) {
            return Ok(serde_json::json!({
                "ok": true,
                "started": false,
                "message": "already running"
            }));
        }

        let root = stirling_root(&app);
        let script = root.join("ensure-stirling-pdf.ps1");
        if !script.is_file() {
            return Ok(serde_json::json!({
                "ok": false,
                "started": false,
                "code": "no_script",
                "message": format!("找不到 ensure-stirling-pdf.ps1：{}（可设置环境变量 STIRLING_ROOT）", script.display())
            }));
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let out = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    &script.to_string_lossy(),
                ])
                .current_dir(&root)
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .map_err(|e| e.to_string())?;
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout) {
                let ready = testhub_port_up(8090)
                    || v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
                let mut obj = v;
                if let Some(map) = obj.as_object_mut() {
                    map.insert("ok".into(), serde_json::json!(ready));
                    map.insert("started".into(), serde_json::json!(true));
                }
                return Ok(obj);
            }
            let ready = testhub_port_up(8090);
            let msg = if !stdout.is_empty() {
                stdout
            } else if !stderr.is_empty() {
                stderr
            } else if ready {
                "ready".to_string()
            } else {
                format!("exit={}", out.status.code().unwrap_or(-1))
            };
            Ok(serde_json::json!({
                "ok": ready,
                "started": true,
                "message": msg
            }))
        }
        #[cfg(not(windows))]
        {
            Ok(serde_json::json!({
                "ok": false,
                "started": false,
                "message": "stirling_ensure 当前打包仅实现了 Windows 启动脚本；请本机执行 docker compose up -d"
            }))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn anythingllm_root(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("ANYTHINGLLM_ROOT") {
        let pb = PathBuf::from(p.trim());
        if pb.is_dir() {
            return pb;
        }
    }
    let cfg = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("anythingllm-root.txt");
    if let Ok(s) = fs::read_to_string(&cfg) {
        let pb = PathBuf::from(s.trim());
        if pb.is_dir() {
            return pb;
        }
    }
    PathBuf::from(r"D:\mytools\dev-toolbox\anythingllm")
}

/// 确保本机 AnythingLLM（Docker :3002）已启动；已在跑则直接返回。
/// 注意：TestHub 占用 :3001，故 AnythingLLM 映射到本机 3002。
#[tauri::command]
async fn anythingllm_ensure(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if testhub_port_up(3002) {
            return Ok(serde_json::json!({
                "ok": true,
                "started": false,
                "message": "already running"
            }));
        }

        let root = anythingllm_root(&app);
        let script = root.join("ensure-anythingllm.ps1");
        if !script.is_file() {
            return Ok(serde_json::json!({
                "ok": false,
                "started": false,
                "code": "no_script",
                "message": format!("找不到 ensure-anythingllm.ps1：{}（可设置环境变量 ANYTHINGLLM_ROOT）", script.display())
            }));
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let out = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    &script.to_string_lossy(),
                ])
                .current_dir(&root)
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .map_err(|e| e.to_string())?;
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout) {
                let ready = testhub_port_up(3002)
                    || v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
                let mut obj = v;
                if let Some(map) = obj.as_object_mut() {
                    map.insert("ok".into(), serde_json::json!(ready));
                    map.insert("started".into(), serde_json::json!(true));
                }
                return Ok(obj);
            }
            let ready = testhub_port_up(3002);
            let msg = if !stdout.is_empty() {
                stdout
            } else if !stderr.is_empty() {
                stderr
            } else if ready {
                "ready".to_string()
            } else {
                format!("exit={}", out.status.code().unwrap_or(-1))
            };
            Ok(serde_json::json!({
                "ok": ready,
                "started": true,
                "message": msg
            }))
        }
        #[cfg(not(windows))]
        {
            Ok(serde_json::json!({
                "ok": false,
                "started": false,
                "message": "anythingllm_ensure 当前打包仅实现了 Windows 启动脚本；请本机执行 docker compose up -d"
            }))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn dsh_root(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("DSH_ROOT") {
        let pb = PathBuf::from(p.trim());
        if pb.is_dir() {
            return pb;
        }
    }
    let cfg = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("dsh-root.txt");
    if let Ok(s) = fs::read_to_string(&cfg) {
        let pb = PathBuf::from(s.trim());
        if pb.is_dir() {
            return pb;
        }
    }
    PathBuf::from(r"D:\mytools\dev-toolbox\dsh")
}

/// 确保本机 DeepSeek Harness（dsh web :3080）已启动；已在跑则直接返回。
#[tauri::command]
async fn dsh_ensure(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if testhub_port_up(3080) {
            return Ok(serde_json::json!({
                "ok": true,
                "started": false,
                "message": "already running"
            }));
        }

        let root = dsh_root(&app);
        let script = root.join("ensure-dsh.ps1");
        if !script.is_file() {
            return Ok(serde_json::json!({
                "ok": false,
                "started": false,
                "code": "no_script",
                "message": format!("找不到 ensure-dsh.ps1：{}（可设置环境变量 DSH_ROOT）", script.display())
            }));
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let out = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    &script.to_string_lossy(),
                ])
                .current_dir(&root)
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .map_err(|e| e.to_string())?;
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout) {
                let ready = testhub_port_up(3080)
                    || v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
                let mut obj = v;
                if let Some(map) = obj.as_object_mut() {
                    map.insert("ok".into(), serde_json::json!(ready));
                    map.entry("started".to_string()).or_insert(serde_json::json!(true));
                }
                return Ok(obj);
            }
            let ready = testhub_port_up(3080);
            let msg = if !stdout.is_empty() {
                stdout
            } else if !stderr.is_empty() {
                stderr
            } else if ready {
                "ready".to_string()
            } else {
                format!("exit={}", out.status.code().unwrap_or(-1))
            };
            Ok(serde_json::json!({
                "ok": ready,
                "started": true,
                "message": msg
            }))
        }
        #[cfg(not(windows))]
        {
            Ok(serde_json::json!({
                "ok": false,
                "started": false,
                "message": "dsh_ensure 当前打包仅实现了 Windows 启动脚本；请本机执行 dsh web"
            }))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把 New API 令牌一键写入 CC Switch（Codex 供应商列表）。
#[tauri::command]
async fn newapi_push_ccswitch(app: tauri::AppHandle, activate: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = newapi_root(&app);
        let script = root.join("push-to-ccswitch.ps1");
        if !script.is_file() {
            return Ok(serde_json::json!({
                "ok": false,
                "message": format!("找不到 push-to-ccswitch.ps1：{}", script.display())
            }));
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let mut args = vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                script.to_string_lossy().to_string(),
            ];
            if let Some(a) = activate {
                let t = a.trim().to_string();
                if !t.is_empty() && t != "-" && t != "none" {
                    args.push(t);
                }
            }
            let out = Command::new("powershell")
                .args(&args)
                .current_dir(&root)
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .map_err(|e| e.to_string())?;
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout) {
                return Ok(v);
            }
            Ok(serde_json::json!({
                "ok": false,
                "message": if !stdout.is_empty() {
                    stdout
                } else if !stderr.is_empty() {
                    stderr
                } else {
                    format!("exit={}", out.status.code().unwrap_or(-1))
                }
            }))
        }
        #[cfg(not(windows))]
        {
            Ok(serde_json::json!({
                "ok": false,
                "message": "newapi_push_ccswitch 仅支持 Windows"
            }))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(DeployState { child: None, cancelled: false }))
        .manage(Arc::new(Mutex::new(SshState {
            sessions: HashMap::new(),
            streams: HashMap::new(),
            creds: HashMap::new(),
            sftp: HashMap::new(),
        })))
        .manage(Arc::new(Mutex::new(LocalShellState {
            sessions: HashMap::new(),
        })))
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                if let Some(win) = app.get_webview_window("main") {
                    let icon_bytes: &[u8] = include_bytes!("../icons/icon.png");
                    if let Ok(img) = tauri::image::Image::from_bytes(icon_bytes) {
                        let _ = win.set_icon(img);
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notes_list, notes_pick_dir, notes_read_file, notes_set_default,
            notes_search, notes_save, notes_create, notes_create_dir, notes_delete, notes_rename, notes_reveal, notes_read,
            http_request, sys_info, port_scan, ip_query, translate, hosts_read, hosts_write,
            deploy_list, deploy_save, deploy_delete, deploy_run, deploy_stop, deploy_pick_dir,
            diff_pick_dir, diff_scan_dir, diff_read_text,
            ssh_connect, ssh_write, ssh_resize, ssh_disconnect, ssh_list, ssh_sessions_load, ssh_sessions_save, ssh_sysinfo,
            local_shell_open,
            sftp_list, sftp_read, sftp_write, sftp_mkdir, sftp_delete,
            testhub_ensure,
            newapi_ensure,
            openacme_ensure,
            stirling_ensure,
            anythingllm_ensure,
            dsh_ensure,
            newapi_push_ccswitch,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
