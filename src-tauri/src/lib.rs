use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{atomic::{AtomicBool, Ordering}, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex as AsyncMutex,
    time::{sleep, interval},
};

mod mcp_client;
use mcp_client::{is_safe_extension_id, ExtensionInfo, ExtensionManager, ExtensionManifest, McpTool};

fn app_user_agent() -> String {
    format!("Astrore/{}", env!("CARGO_PKG_VERSION"))
}

fn app_user_agent_with_contact() -> String {
    format!("Astrore/{} (zkonikishi)", env!("CARGO_PKG_VERSION"))
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
fn hide_subprocess_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_subprocess_window(_: &mut Command) {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EulaState {
    accepted: bool,
    path: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstanceConfig {
    name: String,
    instance_path: String,
    java_path: String,
    server_jar: String,
    min_memory_mb: u32,
    max_memory_mb: u32,
    java_args: Vec<String>,
    server_args: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatus {
    running: bool,
    pid: Option<u32>,
    instance_name: Option<String>,
}

struct ManagedProcess {
    name: String,
    pid: Option<u32>,
    child: std::sync::Arc<AsyncMutex<Child>>,
    stdin: std::sync::Arc<AsyncMutex<ChildStdin>>,
    started_at: Instant,
    restart_count: u32,
}

#[derive(Default)]
struct AppState {
    process: Mutex<Option<ManagedProcess>>,
    metrics: Mutex<ServerMetrics>,
    auto_restart: Mutex<AutoRestartConfig>,
    stopping: AtomicBool,
    sys: Mutex<Option<sysinfo::System>>,
    disk_tick: Mutex<u32>,
    cancel_download: AtomicBool,
    plugin_manager: Mutex<Option<ExtensionManager>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    relative_path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
    enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerLists {
    ops: Vec<serde_json::Value>,
    whitelist: Vec<serde_json::Value>,
    banned_players: Vec<serde_json::Value>,
    banned_ips: Vec<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreInfo {
    name: String,
    tag: String,
    recommend: bool,
    mc_versions: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildInfo {
    core_version: String,
    update_time: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    file_name: String,
    downloaded: u64,
    total: u64,
    percent: f64,
    status: String,
    speed_mbps: f64,
    started_at: Option<u64>,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct ServerMetrics {
    cpu_percent: f64,
    memory_mb: f64,
    memory_max_mb: f64,
    tps: f64,
    mspt: f64,
    online_players: u32,
    max_players: u32,
    player_list: Vec<String>,
    uptime_secs: u64,
    chunk_count: u32,
    entity_count: u32,
    disk_free_gb: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoRestartConfig {
    enabled: bool,
    max_restarts: u32,
    restart_delay_secs: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct AiMessage {
    role: String,
    content: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiRequest {
    endpoint: String,
    api_key: String,
    model: String,
    #[serde(default = "default_temperature")]
    temperature: f64,
    #[serde(default = "default_max_tokens")]
    max_tokens: u32,
    messages: Vec<AiMessage>,
}

fn default_temperature() -> f64 { 0.7 }
fn default_max_tokens() -> u32 { 4096 }

#[tauri::command]
async fn ai_chat(request: AiRequest) -> Result<String, String> {
    let url = reqwest::Url::parse(&request.endpoint).map_err(|error| format!("AI 接口地址无效: {error}"))?;
    let host = url.host_str().ok_or("AI 接口地址缺少主机名")?;
    if url.scheme() != "https" && !(url.scheme() == "http" && matches!(host, "127.0.0.1" | "localhost" | "::1")) {
        return Err("AI 接口必须使用 HTTPS；本地模型可使用 localhost HTTP".into());
    }
    let mut call = reqwest::Client::new()
        .post(url)
        .timeout(std::time::Duration::from_secs(120))
        .header("User-Agent", app_user_agent())
        .json(&serde_json::json!({
        "model": request.model,
        "messages": request.messages,
        "temperature": request.temperature,
        "max_tokens": request.max_tokens,
    }));
    if !request.api_key.is_empty() {
        call = call.bearer_auth(request.api_key);
    }
    let response: serde_json::Value = call.send().await.map_err(|error| format!("AI 请求失败: {error}"))?
        .error_for_status().map_err(|error| format!("AI 接口返回错误: {error}"))?
        .json().await.map_err(|error| format!("无法解析 AI 响应: {error}"))?;
    response["choices"][0]["message"]["content"].as_str().map(str::to_owned).ok_or_else(|| "AI 响应缺少内容".into())
}

impl Default for AutoRestartConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_restarts: 3,
            restart_delay_secs: 5,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginInfo {
    name: String,
    title: String,
    description: String,
    icon_url: String,
    downloads: u64,
    categories: Vec<String>,
    project_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginVersion {
    name: String,
    version_number: String,
    download_url: String,
    file_name: String,
    game_versions: Vec<String>,
    loaders: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupInfo {
    name: String,
    size: u64,
    modified: u64,
}

fn safe_root(instance_path: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(instance_path);
    if !root.is_dir() {
        return Err("实例目录不存在".into());
    }
    root.canonicalize()
        .map_err(|error| format!("无法读取实例目录: {error}"))
}

fn safe_path(instance_path: &str, relative_path: &str) -> Result<PathBuf, String> {
    let root = safe_root(instance_path)?;
    let candidate = root.join(relative_path);
    let resolved = if candidate.exists() {
        candidate
            .canonicalize()
            .map_err(|error| format!("无法读取路径: {error}"))?
    } else {
        let parent = candidate.parent().ok_or("无效路径")?;
        let parent = parent
            .canonicalize()
            .map_err(|error| format!("父目录不存在: {error}"))?;
        parent.join(candidate.file_name().ok_or("无效文件名")?)
    };
    if !resolved.starts_with(&root) {
        return Err("拒绝访问实例目录之外的路径".into());
    }
    Ok(resolved)
}

fn read_json_list(path: &Path) -> Vec<serde_json::Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn write_json_list(path: &Path, value: &[serde_json::Value]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, text).map_err(|error| format!("写入失败: {error}"))
}

fn backups_dir(root: &Path) -> PathBuf {
    root.join(".astrore-backups")
}

fn append_backup_entries(
    builder: &mut tar::Builder<flate2::write::GzEncoder<fs::File>>,
    root: &Path,
    directory: &Path,
) -> Result<(), String> {
    for item in fs::read_dir(directory).map_err(|error| format!("读取备份文件失败: {error}"))? {
        let item = item.map_err(|error| error.to_string())?;
        let path = item.path();
        if path == backups_dir(root) {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "无法生成备份路径")?;
        if path.is_dir() {
            builder
                .append_dir(relative, &path)
                .map_err(|error| format!("写入备份目录失败: {error}"))?;
            append_backup_entries(builder, root, &path)?;
        } else if path.is_file() {
            builder
                .append_path_with_name(&path, relative)
                .map_err(|error| format!("写入备份文件失败: {error}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn list_backups(instance_path: String) -> Result<Vec<BackupInfo>, String> {
    ensure_local_management()?;
    let root = safe_root(&instance_path)?;
    let directory = backups_dir(&root);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut backups = Vec::new();
    for item in fs::read_dir(directory).map_err(|error| format!("读取备份目录失败: {error}"))? {
        let item = item.map_err(|error| error.to_string())?;
        let metadata = item.metadata().map_err(|error| error.to_string())?;
        let name = item.file_name().to_string_lossy().into_owned();
        if metadata.is_file() && name.ends_with(".tar.gz") {
            backups.push(BackupInfo {
                name,
                size: metadata.len(),
                modified: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs())
                    .unwrap_or(0),
            });
        }
    }
    backups.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(backups)
}

#[tauri::command]
fn create_backup(instance_path: String, label: String) -> Result<BackupInfo, String> {
    ensure_local_management()?;
    let root = safe_root(&instance_path)?;
    let directory = backups_dir(&root);
    fs::create_dir_all(&directory).map_err(|error| format!("创建备份目录失败: {error}"))?;
    let safe_label: String = label
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(40)
        .collect();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let name = if safe_label.is_empty() {
        format!("backup-{timestamp}.tar.gz")
    } else {
        format!("backup-{timestamp}-{safe_label}.tar.gz")
    };
    let path = directory.join(&name);
    let file = fs::File::create(&path).map_err(|error| format!("创建备份失败: {error}"))?;
    let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);
    append_backup_entries(&mut builder, &root, &root)?;
    let encoder = builder
        .into_inner()
        .map_err(|error| format!("完成备份失败: {error}"))?;
    encoder
        .finish()
        .map_err(|error| format!("压缩备份失败: {error}"))?;
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    Ok(BackupInfo {
        name,
        size: metadata.len(),
        modified: timestamp,
    })
}

#[tauri::command]
fn restore_backup(
    instance_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    ensure_local_management()?;
    if state
        .process
        .lock()
        .map_err(|_| "进程状态锁已损坏")?
        .is_some()
    {
        return Err("恢复备份前必须先停止服务器".into());
    }
    if !name.ends_with(".tar.gz") || name.contains(['/', '\\']) {
        return Err("无效的备份名称".into());
    }
    let root = safe_root(&instance_path)?;
    let path = backups_dir(&root).join(name);
    if !path.is_file() {
        return Err("备份不存在".into());
    }
    let file = fs::File::open(path).map_err(|error| format!("打开备份失败: {error}"))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(&root)
        .map_err(|error| format!("恢复备份失败: {error}"))
}

#[tauri::command]
fn delete_backup(instance_path: String, name: String) -> Result<(), String> {
    ensure_local_management()?;
    if !name.ends_with(".tar.gz") || name.contains(['/', '\\']) {
        return Err("无效的备份名称".into());
    }
    let root = safe_root(&instance_path)?;
    let path = backups_dir(&root).join(name);
    fs::remove_file(path).map_err(|error| format!("删除备份失败: {error}"))
}

#[tauri::command]
fn list_directory(instance_path: String, relative_path: String) -> Result<Vec<FileEntry>, String> {
    ensure_local_management()?;
    let root = safe_root(&instance_path)?;
    let directory = safe_path(&instance_path, &relative_path)?;
    if !directory.exists() && matches!(relative_path.as_str(), "plugins" | "mods") {
        fs::create_dir_all(&directory).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    if !directory.is_dir() {
        return Err("目标不是目录".into());
    }
    let mut entries = Vec::new();
    for item in fs::read_dir(&directory).map_err(|error| format!("读取目录失败: {error}"))? {
        let item = item.map_err(|error| error.to_string())?;
        let path = item.path();
        let metadata = item.metadata().map_err(|error| error.to_string())?;
        let name = item.file_name().to_string_lossy().into_owned();
        let relative = path
            .strip_prefix(&root)
            .map_err(|_| "无法生成相对路径")?
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(FileEntry {
            enabled: !name.ends_with(".disabled"),
            name,
            relative_path: relative,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs())
                .unwrap_or(0),
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

#[tauri::command]
fn read_text_file(instance_path: String, relative_path: String) -> Result<String, String> {
    ensure_local_management()?;
    let path = safe_path(&instance_path, &relative_path)?;
    if !path.is_file()
        || fs::metadata(&path)
            .map_err(|error| error.to_string())?
            .len()
            > 2_000_000
    {
        return Err("只能编辑小于 2 MB 的文本文件".into());
    }
    fs::read_to_string(path).map_err(|error| format!("读取文本失败: {error}"))
}

#[tauri::command]
fn write_text_file(
    instance_path: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    ensure_local_management()?;
    let path = safe_path(&instance_path, &relative_path)?;
    fs::write(path, content).map_err(|error| format!("保存文本失败: {error}"))
}

#[tauri::command]
fn rename_entry(
    instance_path: String,
    relative_path: String,
    new_name: String,
) -> Result<(), String> {
    ensure_local_management()?;
    if new_name.trim().is_empty() || new_name.contains(['/', '\\']) {
        return Err("文件名无效".into());
    }
    let source = safe_path(&instance_path, &relative_path)?;
    let target = source.parent().ok_or("无效路径")?.join(new_name.trim());
    if target.exists() {
        return Err("目标名称已存在".into());
    }
    fs::rename(source, target).map_err(|error| format!("重命名失败: {error}"))
}

#[tauri::command]
fn delete_entry(instance_path: String, relative_path: String) -> Result<(), String> {
    ensure_local_management()?;
    let root = safe_root(&instance_path)?;
    let path = safe_path(&instance_path, &relative_path)?;
    if path == root {
        return Err("不能删除实例根目录".into());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|error| format!("删除目录失败: {error}"))
    } else {
        fs::remove_file(path).map_err(|error| format!("删除文件失败: {error}"))
    }
}

#[tauri::command]
fn toggle_entry(instance_path: String, relative_path: String) -> Result<(), String> {
    ensure_local_management()?;
    let source = safe_path(&instance_path, &relative_path)?;
    if !source.is_file() {
        return Err("只能启用或禁用文件".into());
    }
    let name = source.file_name().ok_or("无效文件名")?.to_string_lossy();
    let target_name = if name.ends_with(".disabled") {
        name.trim_end_matches(".disabled").to_string()
    } else {
        format!("{name}.disabled")
    };
    let target = source.parent().ok_or("无效路径")?.join(target_name);
    if target.exists() {
        return Err("目标文件已存在".into());
    }
    fs::rename(source, target).map_err(|error| format!("切换状态失败: {error}"))
}

#[tauri::command]
fn read_properties(instance_path: String) -> Result<BTreeMap<String, String>, String> {
    ensure_local_management()?;
    let path = safe_path(&instance_path, "server.properties")?;
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let content = fs::read_to_string(path).map_err(|error| format!("读取配置失败: {error}"))?;
    Ok(content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                None
            } else {
                line.split_once('=')
                    .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
            }
        })
        .collect())
}

#[tauri::command]
fn write_properties(
    instance_path: String,
    properties: BTreeMap<String, String>,
) -> Result<(), String> {
    ensure_local_management()?;
    let path = safe_path(&instance_path, "server.properties")?;
    let mut content = String::from("#Minecraft server properties\n");
    for (key, value) in properties {
        if key.contains(['\n', '\r', '=']) || value.contains(['\n', '\r']) {
            return Err("配置项包含非法字符".into());
        }
        content.push_str(&format!("{key}={value}\n"));
    }
    fs::write(path, content).map_err(|error| format!("保存配置失败: {error}"))
}

#[tauri::command]
fn read_player_lists(instance_path: String) -> Result<PlayerLists, String> {
    ensure_local_management()?;
    let root = safe_root(&instance_path)?;
    Ok(PlayerLists {
        ops: read_json_list(&root.join("ops.json")),
        whitelist: read_json_list(&root.join("whitelist.json")),
        banned_players: read_json_list(&root.join("banned-players.json")),
        banned_ips: read_json_list(&root.join("banned-ips.json")),
    })
}

#[tauri::command]
async fn update_player(
    instance_path: String,
    action: String,
    name: String,
    level: Option<u8>,
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    ensure_local_management()?;
    let root = safe_root(&instance_path)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("玩家名不能为空".into());
    }
    let stdin = {
        let process = state.process.lock().map_err(|_| "进程状态锁已损坏")?;
        process.as_ref().map(|process| process.stdin.clone())
    };
    if let Some(stdin) = stdin {
        let command = match action.as_str() {
            "add_op" => format!("op {name}"),
            "remove_op" => format!("deop {name}"),
            "add_whitelist" => format!("whitelist add {name}"),
            "remove_whitelist" => format!("whitelist remove {name}"),
            "ban" => format!("ban {name} {}", reason.unwrap_or_else(|| "被封禁".into())),
            "unban" => format!("pardon {name}"),
            _ => return Err("未知玩家操作".into()),
        };
        let mut stdin = stdin.lock().await;
        stdin
            .write_all(format!("{command}\n").as_bytes())
            .await
            .map_err(|error| format!("发送玩家管理命令失败: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("发送玩家管理命令失败: {error}"))?;
        return Ok(());
    }
    if matches!(action.as_str(), "add_op" | "add_whitelist" | "ban") {
        return Err("服务器未运行时无法安全添加玩家：Minecraft 列表需要该玩家的真实 UUID".into());
    }
    let (file, add, mut value) = match action.as_str() {
        "add_op" => (
            "ops.json",
            true,
            serde_json::json!({"uuid":"00000000-0000-0000-0000-000000000000","name":name,"level":level.unwrap_or(4).min(4),"bypassesPlayerLimit":false}),
        ),
        "remove_op" => ("ops.json", false, serde_json::Value::Null),
        "add_whitelist" => (
            "whitelist.json",
            true,
            serde_json::json!({"uuid":"00000000-0000-0000-0000-000000000000","name":name}),
        ),
        "remove_whitelist" => ("whitelist.json", false, serde_json::Value::Null),
        "ban" => (
            "banned-players.json",
            true,
            serde_json::json!({"uuid":"00000000-0000-0000-0000-000000000000","name":name,"created":"","source":"Astrore","expires":"forever","reason":reason.unwrap_or_else(|| "被封禁".into())}),
        ),
        "unban" => ("banned-players.json", false, serde_json::Value::Null),
        _ => return Err("未知玩家操作".into()),
    };
    let path = root.join(file);
    let mut list = read_json_list(&path);
    let index = list.iter().position(|entry| {
        entry
            .get("name")
            .and_then(|value| value.as_str())
            .is_some_and(|current| current.eq_ignore_ascii_case(name))
    });
    if add {
        if let Some(index) = index {
            if action == "add_op" {
                value["uuid"] = list[index]["uuid"].clone();
            }
            list[index] = value;
        } else {
            list.push(value);
        }
    } else if let Some(index) = index {
        list.remove(index);
    }
    write_json_list(&path, &list)
}

#[tauri::command]
async fn list_server_cores() -> Result<Vec<CoreInfo>, String> {
    let data: serde_json::Value = reqwest::Client::new()
        .get("https://download.fastmirror.net/api/v3")
        .header("User-Agent", app_user_agent())
        .send()
        .await
        .map_err(|error| format!("获取核心列表失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("核心列表请求失败: {error}"))?
        .json()
        .await
        .map_err(|error| format!("解析核心列表失败: {error}"))?;
    Ok(data["data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| CoreInfo {
            name: item["name"].as_str().unwrap_or_default().to_string(),
            tag: item["tag"].as_str().unwrap_or_default().to_string(),
            recommend: item["recommend"].as_bool().unwrap_or(false),
            mc_versions: item["mc_versions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect(),
        })
        .collect())
}

#[tauri::command]
async fn list_core_builds(core_name: String, mc_version: String) -> Result<Vec<BuildInfo>, String> {
    let url = format!("https://download.fastmirror.net/api/v3/{core_name}/{mc_version}");
    let data: serde_json::Value = reqwest::Client::new()
        .get(url)
        .query(&[("offset", 0), ("limit", 30)])
        .header("User-Agent", app_user_agent())
        .send()
        .await
        .map_err(|error| format!("获取构建列表失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("构建列表请求失败: {error}"))?
        .json()
        .await
        .map_err(|error| format!("解析构建列表失败: {error}"))?;
    Ok(data["data"]["builds"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| BuildInfo {
            core_version: item["core_version"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            update_time: item["update_time"].as_str().unwrap_or_default().to_string(),
        })
        .collect())
}

#[tauri::command]
async fn download_server_core(
    instance_path: String,
    core_name: String,
    mc_version: String,
    build: String,
    app: AppHandle,
) -> Result<String, String> {
    ensure_local_management()?;
    app.state::<AppState>().cancel_download.store(false, Ordering::SeqCst);
    let root = safe_root(&instance_path)?;
    let info_url =
        format!("https://download.fastmirror.net/api/v3/{core_name}/{mc_version}/{build}");
    let client = reqwest::Client::new();
    let info: serde_json::Value = client
        .get(info_url)
        .header("User-Agent", app_user_agent())
        .send()
        .await
        .map_err(|error| format!("获取下载信息失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("下载信息请求失败: {error}"))?
        .json()
        .await
        .map_err(|error| format!("解析下载信息失败: {error}"))?;
    let url = info["data"]["download_url"]
        .as_str()
        .ok_or("下载地址不存在")?;
    let file_name = info["data"]["filename"]
        .as_str()
        .filter(|name| !name.contains(['/', '\\']))
        .map(str::to_string)
        .unwrap_or_else(|| format!("{core_name}-{mc_version}-{build}.jar"));
    let target = root.join(&file_name);
    let part = root.join(format!("{file_name}.part"));
    let _ = tokio::fs::remove_file(&part).await;
    let mut response = client
        .get(url)
        .header("User-Agent", app_user_agent())
        .send()
        .await
        .map_err(|error| format!("下载失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("下载请求失败: {error}"))?;
    let total = response.content_length().unwrap_or(0);
    let mut downloaded = 0u64;
    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|error| format!("创建下载文件失败: {error}"))?;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取下载数据失败: {error}"))?
    {
        if check_cancel(app.state()) {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            emit_progress(&app, &file_name, downloaded, total, "cancelled", started_at);
            return Err("下载已取消".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("写入下载文件失败: {error}"))?;
        downloaded += chunk.len() as u64;
        emit_progress(&app, &file_name, downloaded, total, "downloading", started_at);
    }
    file.flush()
        .await
        .map_err(|error| format!("完成下载失败: {error}"))?;
    tokio::fs::rename(&part, &target)
        .await
        .map_err(|error| format!("保存核心失败: {error}"))?;
    emit_progress(&app, &file_name, downloaded, total, "completed", started_at);
    Ok(file_name)
}

fn ensure_local_management() -> Result<(), String> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        Err("移动端仅支持连接远程 Astrore Agent".into())
    } else {
        Ok(())
    }
}

fn eula_state(instance_path: &str) -> EulaState {
    let eula_path = Path::new(instance_path).join("eula.txt");
    let accepted = fs::read_to_string(&eula_path)
        .map(|value| {
            value
                .lines()
                .any(|line| line.trim().eq_ignore_ascii_case("eula=true"))
        })
        .unwrap_or(false);
    EulaState {
        accepted,
        path: eula_path.to_string_lossy().into_owned(),
    }
}

fn emit_status(app: &AppHandle, status: &ServerStatus) {
    let _ = app.emit("server-status", status);
}

fn emit_console(app: &AppHandle, line: impl Into<String>) {
    let _ = app.emit("server-console", line.into());
}

#[tauri::command]
fn check_eula(instance_path: String) -> Result<EulaState, String> {
    ensure_local_management()?;
    Ok(eula_state(&instance_path))
}

#[tauri::command]
fn accept_eula(instance_path: String) -> Result<EulaState, String> {
    ensure_local_management()?;
    let root = Path::new(&instance_path);
    if !root.is_dir() {
        return Err("实例目录不存在".into());
    }
    let eula_path = root.join("eula.txt");
    fs::write(
        &eula_path,
        "# Accepted through Astrore after explicit user confirmation.\neula=true\n",
    )
    .map_err(|error| format!("写入 EULA 失败: {error}"))?;
    Ok(eula_state(&instance_path))
}

#[tauri::command]
fn server_status(state: State<'_, AppState>) -> Result<ServerStatus, String> {
    let process = state.process.lock().map_err(|_| "进程状态锁已损坏")?;
    Ok(match process.as_ref() {
        Some(process) => ServerStatus {
            running: true,
            pid: process.pid,
            instance_name: Some(process.name.clone()),
        },
        None => ServerStatus {
            running: false,
            pid: None,
            instance_name: None,
        },
    })
}

fn validate_config(config: &InstanceConfig) -> Result<(PathBuf, PathBuf), String> {
    if config.name.trim().is_empty() {
        return Err("实例名称不能为空".into());
    }
    if config.min_memory_mb == 0 || config.max_memory_mb < config.min_memory_mb {
        return Err("内存设置无效：最大内存必须大于或等于最小内存".into());
    }
    let root = PathBuf::from(&config.instance_path);
    if !root.is_dir() {
        return Err("实例目录不存在，请先在实例设置中填写正确目录".into());
    }
    let jar = {
        let configured = PathBuf::from(&config.server_jar);
        if configured.is_absolute() {
            configured
        } else {
            root.join(configured)
        }
    };
    if !jar.is_file() {
        return Err(format!("服务端核心不存在: {}", jar.display()));
    }
    Ok((root, jar))
}

#[tauri::command]
async fn start_server(
    config: InstanceConfig,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ServerStatus, String> {
    {
        let process = state.process.lock().map_err(|_| "进程状态锁已损坏")?;
        if process.is_some() {
            return Err("已有服务端正在运行".into());
        }
    }
    start_server_inner(config, app, 0).await
}

static COMBINED_PERFORMANCE_REGEX: LazyLock<regex_lite::Regex> =
    LazyLock::new(|| regex_lite::Regex::new(r"(?i)TPS[\s:=]+[*]?(\d+(?:\.\d+)?).*?MSPT[\s:=]+[*]?(\d+(?:\.\d+)?)").unwrap());
static TPS_REGEX: LazyLock<regex_lite::Regex> =
    LazyLock::new(|| regex_lite::Regex::new(r"(?i)TPS(?: from last [^:]+)?[\s:=]+[*]?(\d+(?:\.\d+)?)").unwrap());
static MSPT_REGEX: LazyLock<regex_lite::Regex> =
    LazyLock::new(|| regex_lite::Regex::new(r"(?i)MSPT(?: from last [^:]+)?[\s:=]+[*]?(\d+(?:\.\d+)?)").unwrap());
static PLAYERS_REGEX: LazyLock<regex_lite::Regex> =
    LazyLock::new(|| regex_lite::Regex::new(r"(?i)There are (\d+) of a max of (\d+) players? online(?::\s*(.*))?").unwrap());
static CHUNKS_REGEX: LazyLock<regex_lite::Regex> =
    LazyLock::new(|| regex_lite::Regex::new(r"(?i)Chunks?[\s:=]+(\d+)").unwrap());
static ENTITIES_REGEX: LazyLock<regex_lite::Regex> =
    LazyLock::new(|| regex_lite::Regex::new(r"(?i)Entities?[\s:=]+(\d+)").unwrap());

fn parse_metrics(line: &str, app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut metrics = state.metrics.lock().unwrap();

    if let Some(m) = COMBINED_PERFORMANCE_REGEX.captures(line) {
        metrics.tps = m.get(1).and_then(|v| v.as_str().parse().ok()).unwrap_or(metrics.tps);
        metrics.mspt = m.get(2).and_then(|v| v.as_str().parse().ok()).unwrap_or(metrics.mspt);
    } else {
        if let Some(m) = TPS_REGEX.captures(line) {
            metrics.tps = m.get(1).and_then(|v| v.as_str().parse().ok()).unwrap_or(metrics.tps);
        }
        if let Some(m) = MSPT_REGEX.captures(line) {
            metrics.mspt = m.get(1).and_then(|v| v.as_str().parse().ok()).unwrap_or(metrics.mspt);
        }
    }
    if let Some(m) = PLAYERS_REGEX.captures(line) {
        metrics.online_players = m.get(1).and_then(|v| v.as_str().parse().ok()).unwrap_or(0);
        metrics.max_players = m.get(2).and_then(|v| v.as_str().parse().ok()).unwrap_or(20);
        metrics.player_list = m.get(3)
            .map(|v| v.as_str().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();
    }
    if let Some(m) = CHUNKS_REGEX.captures(line) {
        metrics.chunk_count = m.get(1).and_then(|v| v.as_str().parse().ok()).unwrap_or(0);
    }
    if let Some(m) = ENTITIES_REGEX.captures(line) {
        metrics.entity_count = m.get(1).and_then(|v| v.as_str().parse().ok()).unwrap_or(0);
    }
}

fn emit_system_metrics(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut metrics = state.metrics.lock().unwrap();

    let process = state.process.lock().unwrap();
    if let Some(ref managed) = *process {
        metrics.uptime_secs = managed.started_at.elapsed().as_secs();
        if let Some(pid) = managed.pid.map(|p| p as usize) {
            let mut sys_guard = state.sys.lock().unwrap();
            let sys = sys_guard.get_or_insert_with(|| {
                let mut s = sysinfo::System::new();
                s.refresh_memory();
                s
            });
            sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from(pid)]), true);
            if let Some(proc) = sys.process(sysinfo::Pid::from(pid)) {
                metrics.cpu_percent = proc.cpu_usage() as f64;
                metrics.memory_mb = proc.memory() as f64 / 1_048_576.0;
                metrics.memory_max_mb = sys.total_memory() as f64 / 1_048_576.0;
            }
        }
        let mut tick = state.disk_tick.lock().unwrap();
        *tick += 1;
        if *tick >= 30 {
            *tick = 0;
            let disks = sysinfo::Disks::new_with_refreshed_list();
            if let Some(disk) = disks.first() {
                metrics.disk_free_gb = disk.available_space() as f64 / 1_073_741_824.0;
            }
        }
    }
    let _ = app.emit("server-metrics", metrics.clone());
}

fn start_server_inner(
    config: InstanceConfig,
    app: AppHandle,
    restart_count: u32,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ServerStatus, String>> + Send>> {
    Box::pin(async move {
        let state = app.state::<AppState>();
        ensure_local_management()?;
        state.stopping.store(false, Ordering::SeqCst);
        let (root, jar) = validate_config(&config)?;
        if !eula_state(&config.instance_path).accepted {
            return Err("EULA_REQUIRED".into());
        }

    let java = if config.java_path.trim().is_empty() {
        "java"
    } else {
        config.java_path.trim()
    };
    let mut command = Command::new(java);
    hide_subprocess_window(&mut command);
    command
        .current_dir(&root)
        .arg(format!("-Xms{}M", config.min_memory_mb))
        .arg(format!("-Xmx{}M", config.max_memory_mb))
        .args(&config.java_args)
        .arg("-jar")
        .arg(&jar)
        .args(&config.server_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 Java 失败: {error}"))?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or("无法连接服务端标准输入")?;
    let stdout = child.stdout.take().ok_or("无法读取服务端标准输出")?;
    let stderr = child.stderr.take().ok_or("无法读取服务端错误输出")?;
    let child = std::sync::Arc::new(AsyncMutex::new(child));

    {
        let mut process = state.process.lock().map_err(|_| "进程状态锁已损坏")?;
        *process = Some(ManagedProcess {
            name: config.name.clone(),
            pid,
            child: child.clone(),
            stdin: std::sync::Arc::new(AsyncMutex::new(stdin)),
            started_at: Instant::now(),
            restart_count,
        });
    }

    let status = ServerStatus {
        running: true,
        pid,
        instance_name: Some(config.name.clone()),
    };
    emit_status(&app, &status);

    let stdout_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit_console(&stdout_app, &line);
            let metrics_app = stdout_app.clone();
            parse_metrics(&line, &metrics_app);
        }
    });
    let stderr_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit_console(&stderr_app, format!("[stderr] {line}"));
        }
    });

    let monitor_app = app.clone();
    let monitor_child = child.clone();
    let config_clone = config.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
            let exited = {
                let mut process = monitor_child.lock().await;
                matches!(process.try_wait(), Ok(Some(_)))
            };
            if exited {
                let intentional_stop = monitor_app
                    .state::<AppState>()
                    .stopping
                    .swap(false, Ordering::SeqCst);
                let restart_config = {
                    let state = monitor_app.state::<AppState>();
                    state.auto_restart.lock().map(|config| config.clone()).unwrap_or_default()
                };
                let restart_count = {
                    let state = monitor_app.state::<AppState>();
                    let mut process = state.process.lock().unwrap();
                    let count = process.as_ref().map(|p| p.restart_count).unwrap_or(0);
                    *process = None;
                    count
                };

                emit_status(
                    &monitor_app,
                    &ServerStatus {
                        running: false,
                        pid: None,
                        instance_name: None,
                    },
                );
                emit_console(&monitor_app, format!("[Astrore] 服务端进程已退出 (第 {} 次)", restart_count + 1));

                if restart_config.enabled && !intentional_stop {
                    let max_restarts = restart_config.max_restarts;
                    if restart_count < max_restarts {
                        emit_console(&monitor_app, format!(
                            "[Astrore] 将在 {} 秒后自动重启 (第 {}/{})",
                            restart_config.restart_delay_secs, restart_count + 1, max_restarts
                        ));
                        sleep(Duration::from_secs(restart_config.restart_delay_secs)).await;
                        emit_console(&monitor_app, "[Astrore] 正在自动重启服务端...");
                        let app_handle = monitor_app.clone();
                        let restart_config = config_clone.clone();
                        if let Err(e) = start_server_inner(
                            restart_config,
                            app_handle,
                            restart_count + 1,
                        )
                        .await
                        {
                            emit_console(&monitor_app, format!("[Astrore] 自动重启失败: {e}"));
                        }
                    } else {
                        emit_console(&monitor_app, format!(
                            "[Astrore] 已达到最大重启次数 ({})，停止自动重启",
                            max_restarts
                        ));
                    }
                }
                break;
            }
            emit_system_metrics(&monitor_app);
        }
    });
        Ok(status)
    })
}

#[tauri::command]
async fn send_server_command(command: String, state: State<'_, AppState>) -> Result<(), String> {
    let stdin = {
        let process = state.process.lock().map_err(|_| "进程状态锁已损坏")?;
        process
            .as_ref()
            .map(|process| process.stdin.clone())
            .ok_or("服务端未运行")?
    };
    let command = command.trim();
    if command.is_empty() {
        return Ok(());
    }
    let mut stdin = stdin.lock().await;
    stdin
        .write_all(format!("{command}\n").as_bytes())
        .await
        .map_err(|error| format!("发送命令失败: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("发送命令失败: {error}"))
}

#[tauri::command]
async fn stop_server(state: State<'_, AppState>) -> Result<(), String> {
    state.stopping.store(true, Ordering::SeqCst);
    send_server_command("stop".into(), state).await
}

#[tauri::command]
async fn force_stop_server(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.stopping.store(true, Ordering::SeqCst);
    let child = {
        let process = state.process.lock().map_err(|_| "进程状态锁已损坏")?;
        process
            .as_ref()
            .map(|process| process.child.clone())
            .ok_or("服务端未运行")?
    };
    child
        .lock()
        .await
        .kill()
        .await
        .map_err(|error| format!("强制终止失败: {error}"))?;
    {
        let mut process = state.process.lock().map_err(|_| "进程状态锁已损坏")?;
        *process = None;
    }
    emit_console(&app, "[Astrore] 已请求强制终止服务端");
    Ok(())
}

#[tauri::command]
fn get_metrics(state: State<'_, AppState>) -> Result<ServerMetrics, String> {
    let metrics = state.metrics.lock().map_err(|_| "指标锁已损坏")?;
    Ok(metrics.clone())
}

#[tauri::command]
fn get_auto_restart_config(state: State<'_, AppState>) -> Result<AutoRestartConfig, String> {
    let config = state.auto_restart.lock().map_err(|_| "配置锁已损坏")?;
    Ok(config.clone())
}

#[tauri::command]
fn set_auto_restart_config(
    config: AutoRestartConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut current = state.auto_restart.lock().map_err(|_| "配置锁已损坏")?;
    *current = config;
    Ok(())
}

#[tauri::command]
async fn search_modrinth(query: String, kind: String) -> Result<Vec<PluginInfo>, String> {
    let facets = if kind == "mod" {
        "[[\"categories:forge\",\"categories:fabric\",\"categories:quilt\",\"categories:neoforge\"]]"
    } else {
        "[[\"categories:paper\",\"categories:spigot\",\"categories:bukkit\",\"categories:velocity\",\"categories:bungeecord\",\"categories:folia\"]]"
    };
    let data: serde_json::Value = reqwest::Client::new()
        .get("https://api.modrinth.com/v2/search")
        .query(&[("query", query.as_str()), ("limit", "20"), ("facets", facets)])
        .header("User-Agent", app_user_agent_with_contact())
        .send()
        .await
        .map_err(|e| format!("搜索失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("搜索请求失败: {e}"))?
        .json()
        .await
        .map_err(|e| format!("解析失败: {e}"))?;
    Ok(data["hits"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| PluginInfo {
            project_id: item["project_id"].as_str().unwrap_or_default().to_string(),
            name: item["slug"].as_str().unwrap_or_default().to_string(),
            title: item["title"].as_str().unwrap_or_default().to_string(),
            description: item["description"].as_str().unwrap_or_default().to_string(),
            icon_url: item["icon_url"].as_str().unwrap_or_default().to_string(),
            downloads: item["downloads"].as_u64().unwrap_or(0),
            categories: item["categories"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect(),
        })
        .collect())
}

#[tauri::command]
async fn get_modrinth_versions(project_id: String) -> Result<Vec<PluginVersion>, String> {
    let url = format!("https://api.modrinth.com/v2/project/{project_id}/version");
    let data: serde_json::Value = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", app_user_agent_with_contact())
        .send()
        .await
        .map_err(|e| format!("获取版本失败: {e}"))?
        .json()
        .await
        .map_err(|e| format!("解析失败: {e}"))?;
    Ok(data
        .as_array()
        .into_iter()
        .flatten()
        .take(15)
        .filter_map(|item| {
            let file = item["files"].as_array()?.first()?;
            Some(PluginVersion {
                name: item["name"].as_str().unwrap_or_default().to_string(),
                version_number: item["version_number"].as_str().unwrap_or_default().to_string(),
                download_url: file["url"].as_str().unwrap_or_default().to_string(),
                file_name: file["filename"].as_str().unwrap_or_default().to_string(),
                game_versions: item["game_versions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect(),
                loaders: item["loaders"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect(),
            })
        })
        .collect())
}

#[tauri::command]
async fn download_plugin(
    instance_path: String,
    download_url: String,
    file_name: String,
    kind: String,
    app: AppHandle,
) -> Result<String, String> {
    ensure_local_management()?;
    app.state::<AppState>().cancel_download.store(false, Ordering::SeqCst);
    let root = safe_root(&instance_path)?;
    if !matches!(kind.as_str(), "plugins" | "mods") {
        return Err("无效的下载目标目录".into());
    }
    if file_name.trim().is_empty() || file_name.contains(['/', '\\']) {
        return Err("无效的下载文件名".into());
    }
    let url = reqwest::Url::parse(&download_url).map_err(|_| "无效的下载地址")?;
    let host = url.host_str().ok_or("下载地址缺少主机名")?;
    if url.scheme() != "https"
        || !(host == "modrinth.com" || host.ends_with(".modrinth.com"))
    {
        return Err("只允许从 Modrinth 官方 HTTPS 地址下载".into());
    }
    let target_dir = root.join(kind);
    if !target_dir.exists() {
        fs::create_dir_all(&target_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let target = target_dir.join(&file_name);
    let part = target_dir.join(format!("{file_name}.part"));
    let _ = tokio::fs::remove_file(&part).await;
    let response = reqwest::Client::new()
        .get(url)
        .header("User-Agent", app_user_agent_with_contact())
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;
    let mut response = response
        .error_for_status()
        .map_err(|e| format!("下载请求失败: {e}"))?;
    let total = response.content_length().unwrap_or(0);
    let mut downloaded = 0u64;
    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("创建文件失败: {e}"))?;
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("读取失败: {e}"))? {
        if check_cancel(app.state()) {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            emit_progress(&app, &file_name, downloaded, total, "cancelled", started_at);
            return Err("下载已取消".into());
        }
        file.write_all(&chunk).await.map_err(|e| format!("写入失败: {e}"))?;
        downloaded += chunk.len() as u64;
        emit_progress(&app, &file_name, downloaded, total, "downloading", started_at);
    }
    file.flush().await.map_err(|e| format!("刷新失败: {e}"))?;
    tokio::fs::rename(&part, &target).await.map_err(|e| format!("保存失败: {e}"))?;
    emit_progress(&app, &file_name, downloaded, total, "completed", started_at);
    Ok(file_name)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JavaRelease {
    version: String,
    major: u32,
    download_url: String,
    file_name: String,
    size_mb: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpigetResource {
    id: u32,
    name: String,
    tag: String,
    description: String,
    icon_url: String,
    downloads: u64,
    rating: f64,
    author: String,
    version: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreTypeInfo {
    name: String,
    label: String,
    category: String,
    recommend: bool,
}

static CORE_TYPES: LazyLock<Vec<CoreTypeInfo>> = LazyLock::new(|| {
    vec![
        CoreTypeInfo { name: "paper".into(), label: "Paper \u{2b50} (\u{63a8}\u{8350})".into(), category: "pure".into(), recommend: true },
        CoreTypeInfo { name: "purpur".into(), label: "Purpur".into(), category: "pure".into(), recommend: false },
        CoreTypeInfo { name: "folia".into(), label: "Folia \u{26a1} (\u{591a}\u{7ebf}\u{7a0b})".into(), category: "pure".into(), recommend: false },
        CoreTypeInfo { name: "leaves".into(), label: "Leaves".into(), category: "pure".into(), recommend: false },
        CoreTypeInfo { name: "vanilla".into(), label: "Vanilla (\u{539f}\u{7248})".into(), category: "vanilla".into(), recommend: false },
        CoreTypeInfo { name: "fabric".into(), label: "Fabric (\u{6a21}\u{7ec4})".into(), category: "mod".into(), recommend: false },
        CoreTypeInfo { name: "forge".into(), label: "Forge (\u{6a21}\u{7ec4})".into(), category: "mod".into(), recommend: false },
        CoreTypeInfo { name: "arclight".into(), label: "Arclight \u{2b50} (\u{6a21}\u{7ec4}+\u{63d2}\u{4ef6})".into(), category: "mod".into(), recommend: true },
        CoreTypeInfo { name: "velocity".into(), label: "Velocity (\u{4ee3}\u{7406})".into(), category: "proxy".into(), recommend: false },
        CoreTypeInfo { name: "bungeecord".into(), label: "BungeeCord (\u{4ee3}\u{7406})".into(), category: "proxy".into(), recommend: false },
    ]
});

#[tauri::command]
fn get_core_types() -> Result<Vec<CoreTypeInfo>, String> {
    Ok(CORE_TYPES.clone())
}

#[tauri::command]
async fn list_official_core_versions(core_name: String) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let versions: Vec<String> = match core_name.as_str() {
        "paper" | "folia" | "velocity" => {
            let url = format!("https://api.papermc.io/v2/projects/{core_name}");
            let data: serde_json::Value = client.get(&url).header("User-Agent", app_user_agent()).send().await.map_err(|e| format!("获取版本列表失败: {e}"))?.json().await.map_err(|e| format!("解析失败: {e}"))?;
            data["versions"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).rev().collect()
        }
        "purpur" => {
            let data: serde_json::Value = client.get("https://api.purpurmc.org/v2/purpur").header("User-Agent", app_user_agent()).send().await.map_err(|e| format!("获取版本列表失败: {e}"))?.json().await.map_err(|e| format!("解析失败: {e}"))?;
            data["versions"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).rev().collect()
        }
        "vanilla" => {
            let data: serde_json::Value = client.get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json").header("User-Agent", app_user_agent()).send().await.map_err(|e| format!("获取版本列表失败: {e}"))?.json().await.map_err(|e| format!("解析失败: {e}"))?;
            data["versions"].as_array().into_iter().flatten().filter_map(|v| v["id"].as_str().map(str::to_string)).collect()
        }
        "fabric" => {
            let data: serde_json::Value = client.get("https://meta.fabricmc.net/v2/versions/loader").header("User-Agent", app_user_agent()).send().await.map_err(|e| format!("获取版本列表失败: {e}"))?.json().await.map_err(|e| format!("解析失败: {e}"))?;
            let mut versions: Vec<String> = Vec::new();
            for v in data.as_array().into_iter().flatten() {
                if let Some(intermediary) = v["intermediary"].as_object() {
                    if let Some(ver) = intermediary["version"].as_str() { versions.push(ver.to_string()); }
                }
            }
            versions.sort_by(|a, b| b.cmp(a));
            versions
        }
        _ => return Err(format!("{core_name} 暂不支持官方源")),
    };
    Ok(versions)
}

#[tauri::command]
async fn list_official_core_builds(core_name: String, mc_version: String) -> Result<Vec<BuildInfo>, String> {
    let client = reqwest::Client::new();
    let builds: Vec<BuildInfo> = match core_name.as_str() {
        "paper" | "folia" | "velocity" => {
            let url = format!("https://api.papermc.io/v2/projects/{core_name}/versions/{mc_version}/builds");
            let data: serde_json::Value = client.get(&url).header("User-Agent", app_user_agent()).send().await.map_err(|e| format!("获取构建列表失败: {e}"))?.json().await.map_err(|e| format!("解析失败: {e}"))?;
            data["builds"].as_array().into_iter().flatten().filter_map(|b| Some(BuildInfo { core_version: b["build"].as_u64()?.to_string(), update_time: b["time"].as_str().unwrap_or("").to_string() })).collect()
        }
        "purpur" => {
            let url = format!("https://api.purpurmc.org/v2/purpur/{mc_version}");
            let data: serde_json::Value = client.get(&url).header("User-Agent", app_user_agent()).send().await.map_err(|e| format!("获取构建列表失败: {e}"))?.json().await.map_err(|e| format!("解析失败: {e}"))?;
            data["builds"].as_object().into_iter().flatten().map(|(k, v)| BuildInfo { core_version: k.clone(), update_time: v["timestamp"].as_str().unwrap_or("").to_string() }).collect()
        }
        "vanilla" => {
            let manifest_url = format!("https://piston-meta.mojang.com/v1/packages/21df1d9d0b5c28f56b7b3a1c4c0b7b5a8c9d0e1f/{mc_version}.json");
            let data: serde_json::Value = client.get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json").header("User-Agent", app_user_agent()).send().await.map_err(|e| format!("获取版本清单失败: {e}"))?.json().await.map_err(|e| format!("解析失败: {e}"))?;
            let mut found = None;
            for v in data["versions"].as_array().into_iter().flatten() {
                if v["id"].as_str() == Some(&mc_version) {
                    found = Some(v["url"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            if let Some(url) = found {
                let detail: serde_json::Value = client.get(&url).header("User-Agent", app_user_agent()).send().await.map_err(|e| format!("获取版本详情失败: {e}"))?.json().await.map_err(|e| format!("解析失败: {e}"))?;
                let server_url = detail["downloads"]["server"]["url"].as_str().unwrap_or("").to_string();
                let sha1 = detail["downloads"]["server"]["sha1"].as_str().unwrap_or("").to_string();
                let time = detail["releaseTime"].as_str().unwrap_or("").to_string();
                vec![BuildInfo { core_version: sha1, update_time: time }]
            } else {
                Vec::new()
            }
        }
        "fabric" => {
            let url = format!("https://meta.fabricmc.net/v2/versions/loader/{mc_version}");
            let data: serde_json::Value = client.get(&url).header("User-Agent", app_user_agent()).send().await.map_err(|e| format!("获取构建列表失败: {e}"))?.json().await.map_err(|e| format!("解析失败: {e}"))?;
            let mut builds = Vec::new();
            for item in data.as_array().into_iter().flatten() {
                if let Some(loader) = item["loader"].as_object() {
                    builds.push(BuildInfo { core_version: loader["version"].as_str().unwrap_or("").to_string(), update_time: String::new() });
                }
            }
            builds
        }
        _ => return Err(format!("{core_name} 暂不支持官方源")),
    };
    Ok(builds)
}

#[tauri::command]
async fn download_official_server_core(
    instance_path: String,
    core_name: String,
    mc_version: String,
    build: String,
    app: AppHandle,
) -> Result<String, String> {
    ensure_local_management()?;
    app.state::<AppState>().cancel_download.store(false, Ordering::SeqCst);
    let root = safe_root(&instance_path)?;
    let client = reqwest::Client::new();

    let (download_url, file_name) = match core_name.as_str() {
        "paper" | "folia" | "velocity" => {
            let url = format!("https://api.papermc.io/v2/projects/{core_name}/versions/{mc_version}/builds/{build}");
            let data: serde_json::Value = client.get(&url).header("User-Agent", app_user_agent()).send().await.map_err(|e| format!("获取下载信息失败: {e}"))?.json().await.map_err(|e| format!("解析失败: {e}"))?;
            let dl = data["downloads"]["application"]["name"].as_str().unwrap_or("server.jar");
            let download_url = format!("https://api.papermc.io/v2/projects/{core_name}/versions/{mc_version}/builds/{build}/downloads/{dl}");
            (download_url, dl.to_string())
        }
        "purpur" => {
            let download_url = format!("https://api.purpurmc.org/v2/purpur/{mc_version}/{build}/download");
            (download_url, format!("purpur-{mc_version}-{build}.jar"))
        }
        "vanilla" => {
            let manifest_data: serde_json::Value = client.get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json").header("User-Agent", app_user_agent()).send().await.map_err(|e| format!("获取版本清单失败: {e}"))?.json().await.map_err(|e| format!("解析失败: {e}"))?;
            let mut detail_url = String::new();
            for v in manifest_data["versions"].as_array().into_iter().flatten() {
                if v["id"].as_str() == Some(&mc_version) {
                    detail_url = v["url"].as_str().unwrap_or("").to_string();
                    break;
                }
            }
            let detail: serde_json::Value = client.get(&detail_url).header("User-Agent", app_user_agent()).send().await.map_err(|e| format!("获取版本详情失败: {e}"))?.json().await.map_err(|e| format!("解析失败: {e}"))?;
            let download_url = detail["downloads"]["server"]["url"].as_str().unwrap_or("").to_string();
            (download_url, format!("minecraft_server.{mc_version}.jar"))
        }
        "fabric" => {
            let loader_url = format!("https://meta.fabricmc.net/v2/versions/loader/{mc_version}/{build}/server/jar");
            (loader_url, format!("fabric-server-{mc_version}-{build}.jar"))
        }
        _ => return Err(format!("{core_name} 暂不支持官方源下载")),
    };

    download_to_instance(&app, &root, &download_url, &file_name).await
}

async fn download_to_instance(
    app: &AppHandle,
    root: &Path,
    download_url: &str,
    file_name: &str,
) -> Result<String, String> {
    let safe_name = Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .ok_or("Invalid download file name")?
        .to_string();
    let target = root.join(&safe_name);
    let part = root.join(format!("{safe_name}.part"));
    let mut response = reqwest::Client::new()
        .get(download_url)
        .header("User-Agent", app_user_agent())
        .send()
        .await
        .map_err(|error| format!("Download failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Download failed with status {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut downloaded = 0u64;
    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|error| format!("Create file failed: {error}"))?;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Read download failed: {error}"))?
    {
        if check_cancel(app.state()) {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            emit_progress(app, &safe_name, downloaded, total, "cancelled", started_at);
            return Err("Download cancelled".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Write file failed: {error}"))?;
        downloaded += chunk.len() as u64;
        emit_progress(app, &safe_name, downloaded, total, "downloading", started_at);
    }
    file.flush()
        .await
        .map_err(|error| format!("Flush file failed: {error}"))?;
    drop(file);
    if target.exists() {
        tokio::fs::remove_file(&target)
            .await
            .map_err(|error| format!("Replace existing file failed: {error}"))?;
    }
    tokio::fs::rename(&part, &target)
        .await
        .map_err(|error| format!("Save download failed: {error}"))?;
    emit_progress(app, &safe_name, downloaded, total, "completed", started_at);
    Ok(safe_name)
}

#[tauri::command]
async fn list_java_releases(vendor: Option<String>) -> Result<Vec<JavaRelease>, String> {
    let vendor_code = vendor.unwrap_or_else(|| "eclipse".into());
    let url = format!("https://api.adoptium.net/v3/assets/feature_releases/21/ga?page_size=20&image_type=jdk&jvm_impl=hotspot&vendor={vendor_code}");
    let data: serde_json::Value = reqwest::Client::new()
        .get(url)
        .header("User-Agent", app_user_agent())
        .send().await.map_err(|e| format!("获取 Java 列表失败: {e}"))?
        .json().await.map_err(|e| format!("解析 Java 列表失败: {e}"))?;
    let mut releases = Vec::new();
    for item in data.as_array().into_iter().flatten() {
        let version_data = &item["version_data"];
        let version = version_data["semver"].as_str().unwrap_or_default().to_string();
        let major = version_data["major"].as_u64().unwrap_or(0) as u32;
        for binary in item["binaries"].as_array().into_iter().flatten() {
            let os = binary["os"].as_str().unwrap_or_default();
            let arch = binary["architecture"].as_str().unwrap_or_default();
            if os != "windows" || arch != "x64" { continue; }
            if let Some(pkg) = binary["installer"].as_object() {
                releases.push(JavaRelease {
                    version: version.clone(),
                    major,
                    download_url: pkg["link"].as_str().unwrap_or_default().to_string(),
                    file_name: pkg["name"].as_str().unwrap_or_default().to_string(),
                    size_mb: pkg["size"].as_f64().unwrap_or(0.0) / 1_048_576.0,
                });
            }
        }
    }
    releases.sort_by(|a, b| b.version.cmp(&a.version));
    Ok(releases)
}

#[tauri::command]
async fn download_java(
    download_url: String,
    file_name: String,
    app: AppHandle,
) -> Result<String, String> {
    app.state::<AppState>().cancel_download.store(false, Ordering::SeqCst);
    let target_dir = dirs_next::download_dir().unwrap_or_else(|| PathBuf::from("."));
    let target = target_dir.join(&file_name);
    let part = target_dir.join(format!("{file_name}.part"));
    let mut response = reqwest::Client::new()
        .get(&download_url)
        .header("User-Agent", app_user_agent())
        .send().await.map_err(|e| format!("下载失败: {e}"))?;
    let total = response.content_length().unwrap_or(0);
    let mut downloaded = 0u64;
    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut file = tokio::fs::File::create(&part).await.map_err(|e| format!("创建文件失败: {e}"))?;
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("读取失败: {e}"))? {
        if check_cancel(app.state()) {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            emit_progress(&app, &file_name, downloaded, total, "cancelled", started_at);
            return Err("下载已取消".into());
        }
        file.write_all(&chunk).await.map_err(|e| format!("写入失败: {e}"))?;
        downloaded += chunk.len() as u64;
        emit_progress(&app, &file_name, downloaded, total, "downloading", started_at);
    }
    file.flush().await.map_err(|e| format!("刷新失败: {e}"))?;
    tokio::fs::rename(&part, &target).await.map_err(|e| format!("保存失败: {e}"))?;
    emit_progress(&app, &file_name, downloaded, total, "completed", started_at);
    Ok(file_name)
}

#[tauri::command]
async fn search_spiget(query: String) -> Result<Vec<SpigetResource>, String> {
    let url = format!("https://api.spiget.org/v2/search/resources/{query}?size=20&sort=-downloads&fields=id,name,tag,description,icon,downloads,rating,author,version");
    let data: serde_json::Value = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", app_user_agent())
        .send().await.map_err(|e| format!("搜索失败: {e}"))?
        .json().await.map_err(|e| format!("解析失败: {e}"))?;
    Ok(data.as_array().into_iter().flatten().map(|item| SpigetResource {
        id: item["id"].as_u64().unwrap_or(0) as u32,
        name: item["name"].as_str().unwrap_or_default().to_string(),
        tag: item["tag"].as_str().unwrap_or_default().to_string(),
        description: item["description"].as_str().unwrap_or_default().to_string(),
        icon_url: item["icon"].as_object().and_then(|i| i["url"].as_str()).unwrap_or_default().to_string(),
        downloads: item["downloads"].as_u64().unwrap_or(0),
        rating: item["rating"].as_f64().unwrap_or(0.0),
        author: item["author"].as_object().and_then(|a| a["name"].as_str()).unwrap_or_default().to_string(),
        version: item["version"].as_object().and_then(|v| v["name"].as_str()).unwrap_or_default().to_string(),
    }).collect())
}

#[tauri::command]
async fn download_spiget_plugin(
    instance_path: String,
    resource_id: u32,
    file_name: String,
    app: AppHandle,
) -> Result<String, String> {
    ensure_local_management()?;
    app.state::<AppState>().cancel_download.store(false, Ordering::SeqCst);
    let root = safe_root(&instance_path)?;
    let target_dir = root.join("plugins");
    if !target_dir.exists() {
        fs::create_dir_all(&target_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let url = format!("https://api.spiget.org/v2/resources/{resource_id}/download");
    let target = target_dir.join(&file_name);
    let part = target_dir.join(format!("{file_name}.part"));
    let mut response = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", app_user_agent())
        .send().await.map_err(|e| format!("下载失败: {e}"))?;
    let total = response.content_length().unwrap_or(0);
    let mut downloaded = 0u64;
    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut file = tokio::fs::File::create(&part).await.map_err(|e| format!("创建文件失败: {e}"))?;
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("读取失败: {e}"))? {
        if check_cancel(app.state()) {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            emit_progress(&app, &file_name, downloaded, total, "cancelled", started_at);
            return Err("下载已取消".into());
        }
        file.write_all(&chunk).await.map_err(|e| format!("写入失败: {e}"))?;
        downloaded += chunk.len() as u64;
        emit_progress(&app, &file_name, downloaded, total, "downloading", started_at);
    }
    file.flush().await.map_err(|e| format!("刷新失败: {e}"))?;
    tokio::fs::rename(&part, &target).await.map_err(|e| format!("保存失败: {e}"))?;
    emit_progress(&app, &file_name, downloaded, total, "completed", started_at);
    Ok(file_name)
}


#[tauri::command]
fn cancel_download(state: State<'_, AppState>) -> Result<(), String> {
    state.cancel_download.store(true, Ordering::SeqCst);
    Ok(())
}

fn check_cancel(state: tauri::State<'_, AppState>) -> bool {
    state.cancel_download.load(Ordering::SeqCst)
}

fn emit_progress(app: &AppHandle, file_name: &str, downloaded: u64, total: u64, status: &str, started_at: u64) {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .saturating_sub(started_at)
        .max(1);
    let speed_mbps = (downloaded as f64 / 1_048_576.0) / elapsed as f64;
    let _ = app.emit("download-progress", DownloadProgress {
        file_name: file_name.to_string(),
        downloaded,
        total,
        percent: if total > 0 { downloaded as f64 / total as f64 * 100.0 } else { 0.0 },
        status: status.to_string(),
        speed_mbps,
        started_at: Some(started_at),
    });
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryExtension {
    id: String,
    name: String,
    version: String,
    description: String,
    author: String,
    runtime: String,
    download_url: String,
    sha256: String,
    size: u64,
    #[serde(default)]
    homepage: String,
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default)]
    verified: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionRegistry {
    schema_version: u32,
    extensions: Vec<RegistryExtension>,
}

fn validate_https_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|error| format!("无效地址: {error}"))?;
    if url.scheme() != "https" {
        return Err("扩展注册表和安装包必须使用 HTTPS".into());
    }
    let host = url.host_str().ok_or("地址缺少主机名")?;
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(is_private_extension_host)
    {
        return Err("扩展注册表和安装包不能使用本机地址".into());
    }
    Ok(url)
}

fn is_private_extension_host(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified()
        }
        std::net::IpAddr::V6(ip) => {
            ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local() || ip.is_unspecified()
        }
    }
}

#[tauri::command]
async fn fetch_extension_registry(registry_url: String) -> Result<Vec<RegistryExtension>, String> {
    let url = validate_https_url(&registry_url)?;
    let trusted_registry = registry_url == "https://zkonikishi.github.io/Astrore-docs/registry/index.json";
    let response = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(20))
        .header("User-Agent", app_user_agent())
        .send()
        .await
        .map_err(|error| format!("获取扩展注册表失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("扩展注册表返回错误: {error}"))?;
    validate_https_url(response.url().as_str()).map_err(|_| "扩展注册表重定向到了不安全地址")?;
    if response.content_length().unwrap_or(2 * 1024 * 1024 + 1) > 2 * 1024 * 1024 {
        return Err("扩展注册表过大".into());
    }
    let registry_bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取扩展注册表失败: {error}"))?;
    let registry: ExtensionRegistry =
        serde_json::from_slice(&registry_bytes).map_err(|error| format!("解析扩展注册表失败: {error}"))?;
    if registry.schema_version != 1 {
        return Err("不支持的扩展注册表版本".into());
    }
    Ok(registry
        .extensions
        .into_iter()
        .map(|mut entry| {
            entry.verified = trusted_registry && entry.verified;
            entry
        })
        .filter(|entry| {
            is_safe_extension_id(&entry.id)
                && matches!(entry.runtime.as_str(), "wasi" | "external-mcp")
                && entry.sha256.len() == 64
                && entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                && entry.size <= 25 * 1024 * 1024
        })
        .collect())
}

#[tauri::command]
async fn install_registry_extension(
    extension: RegistryExtension,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !is_safe_extension_id(&extension.id)
        || extension.sha256.len() != 64
        || !extension.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("扩展元数据无效".into());
    }
    if extension.size == 0 || extension.size > 25 * 1024 * 1024 {
        return Err("扩展安装包大小无效".into());
    }
    let url = validate_https_url(&extension.download_url)?;
    let response = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(60))
        .header("User-Agent", app_user_agent())
        .send()
        .await
        .map_err(|error| format!("下载扩展失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("扩展下载返回错误: {error}"))?;
    validate_https_url(response.url().as_str()).map_err(|_| "扩展安装包重定向到了不安全地址")?;
    if response.content_length() != Some(extension.size) {
        return Err("扩展安装包响应大小与注册表不一致".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取扩展安装包失败: {error}"))?;
    if bytes.len() as u64 != extension.size {
        return Err("扩展安装包大小与注册表不一致".into());
    }
    let checksum = format!("{:x}", Sha256::digest(&bytes));
    if !checksum.eq_ignore_ascii_case(&extension.sha256) {
        return Err("扩展安装包 SHA-256 校验失败".into());
    }

    let extensions_dir = dirs_next::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("astrore")
        .join("extensions");
    fs::create_dir_all(&extensions_dir).map_err(|error| format!("创建扩展目录失败: {error}"))?;
    let staging = extensions_dir.join(format!(".install-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging).map_err(|error| format!("创建扩展暂存目录失败: {error}"))?;
    let unpack_result = (|| -> Result<(), String> {
        let decoder = flate2::read::GzDecoder::new(Cursor::new(bytes));
        let mut archive = tar::Archive::new(decoder);
        let mut expanded_size = 0u64;
        let mut file_count = 0u32;
        for entry in archive.entries().map_err(|error| format!("读取扩展安装包失败: {error}"))? {
            let mut entry = entry.map_err(|error| format!("读取扩展文件失败: {error}"))?;
            file_count += 1;
            expanded_size = expanded_size.saturating_add(entry.size());
            if file_count > 1_000 || expanded_size > 100 * 1024 * 1024 {
                return Err("扩展安装包解压后过大".into());
            }
            let path = entry
                .path()
                .map_err(|error| format!("扩展文件路径无效: {error}"))?
                .into_owned();
            if path.is_absolute()
                || path.components().any(|component| matches!(component, std::path::Component::ParentDir))
            {
                return Err("扩展安装包包含危险路径".into());
            }
            if !entry.header().entry_type().is_file() && !entry.header().entry_type().is_dir() {
                return Err("扩展安装包包含不允许的链接或设备文件".into());
            }
            entry.unpack_in(&staging).map_err(|error| format!("解压扩展失败: {error}"))?;
        }
        let manifest: ExtensionManifest = serde_json::from_str(
            &fs::read_to_string(staging.join("manifest.json"))
                .map_err(|error| format!("扩展安装包缺少 manifest.json: {error}"))?,
        )
        .map_err(|error| format!("扩展清单无效: {error}"))?;
        if manifest.id != extension.id
            || manifest.version != extension.version
            || manifest.runtime != extension.runtime
            || manifest.permissions != extension.permissions
        {
            return Err("扩展清单与注册表元数据不一致".into());
        }
        Ok(())
    })();
    if let Err(error) = unpack_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let target = extensions_dir.join(&extension.id);
    let backup = extensions_dir.join(format!(".backup-{}", uuid::Uuid::new_v4()));
    {
        let mut manager = state.plugin_manager.lock().map_err(|_| "扩展管理器锁已损坏")?;
        if let Some(manager) = manager.as_mut() {
            manager.remove_extension(&extension.id);
        }
    }
    if target.exists() {
        fs::rename(&target, &backup).map_err(|error| format!("备份旧扩展失败: {error}"))?;
    }
    if let Err(error) = fs::rename(&staging, &target) {
        if backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        return Err(format!("安装扩展失败: {error}"));
    }
    if backup.exists() {
        let _ = fs::remove_dir_all(backup);
    }
    write_extension_audit("install", &extension.id, &extension.version);
    Ok(())
}

fn write_extension_audit(action: &str, extension_id: &str, detail: &str) {
    let Some(data_dir) = dirs_next::data_dir() else { return };
    let audit_dir = data_dir.join("astrore");
    if fs::create_dir_all(&audit_dir).is_err() {
        return;
    }
    let event = serde_json::json!({
        "time": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|value| value.as_secs()).unwrap_or(0),
        "action": action,
        "extensionId": extension_id,
        "detail": detail,
    });
    use std::io::Write;
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(audit_dir.join("extension-audit.jsonl")) {
        let _ = writeln!(file, "{event}");
    }
}

#[tauri::command]
fn init_extension_manager(state: State<'_, AppState>) -> Result<(), String> {
    let extensions_dir = dirs_next::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("astrore")
        .join("extensions");
    if !extensions_dir.exists() {
        fs::create_dir_all(&extensions_dir).map_err(|e| format!("创建扩展目录失败: {e}"))?;
    }
    let mut pm = state.plugin_manager.lock().map_err(|_| "扩展管理器锁已损坏")?;
    if pm.is_none() {
        let manager = ExtensionManager::new(extensions_dir);
        *pm = Some(manager);
    }
    Ok(())
}

#[tauri::command]
fn scan_extensions(state: State<'_, AppState>) -> Result<Vec<ExtensionInfo>, String> {
    let mut pm = state.plugin_manager.lock().map_err(|_| "扩展管理器锁已损坏")?;
    let pm = pm.as_mut().ok_or("扩展管理器未初始化")?;
    let manifests = pm.scan_extensions();
    let mut infos = Vec::new();
    for m in manifests {
        if pm.get_extension(&m.id).is_none() {
            pm.register(m.clone());
        }
        if let Some(info) = pm.extension_info(&m.id, &[]) {
            infos.push(info);
        }
    }
    Ok(infos)
}

#[tauri::command]
fn start_extension(extension_id: String, approved_permissions: Vec<String>, state: State<'_, AppState>) -> Result<Vec<McpTool>, String> {
    let mut pm = state.plugin_manager.lock().map_err(|_| "扩展管理器锁已损坏")?;
    let pm = pm.as_mut().ok_or("扩展管理器未初始化")?;
    let manifest = pm.load_manifest(&extension_id)?;
    pm.register(manifest);
    let result = pm.start_extension(&extension_id, &approved_permissions);
    write_extension_audit(if result.is_ok() { "start" } else { "start-failed" }, &extension_id, &approved_permissions.join(","));
    result
}

#[tauri::command]
fn stop_extension(extension_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut pm = state.plugin_manager.lock().map_err(|_| "扩展管理器锁已损坏")?;
    let pm = pm.as_mut().ok_or("扩展管理器未初始化")?;
    pm.stop_extension(&extension_id);
    write_extension_audit("stop", &extension_id, "");
    Ok(())
}

#[tauri::command]
fn call_extension_tool(
    extension_id: String,
    tool_name: String,
    arguments: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut pm = state.plugin_manager.lock().map_err(|_| "扩展管理器锁已损坏")?;
    let pm = pm.as_mut().ok_or("扩展管理器未初始化")?;
    let result = pm.call_tool(&extension_id, &tool_name, arguments);
    write_extension_audit(if result.is_ok() { "tool-call" } else { "tool-call-failed" }, &extension_id, &tool_name);
    result
}

#[tauri::command]
fn uninstall_extension(extension_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut pm = state.plugin_manager.lock().map_err(|_| "扩展管理器锁已损坏")?;
    let pm = pm.as_mut().ok_or("扩展管理器未初始化")?;
    pm.remove_extension(&extension_id);
    let dir = pm.extensions_dir().join(&extension_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除扩展目录失败: {e}"))?;
    }
    write_extension_audit("uninstall", &extension_id, "");
    Ok(())
}

#[tauri::command]
fn platform_capabilities() -> serde_json::Value {
    serde_json::json!({
        "platform": std::env::consts::OS,
        "localServerManagement": !cfg!(any(target_os = "android", target_os = "ios")),
        "remoteControl": false
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            check_eula,
            accept_eula,
            server_status,
            start_server,
            stop_server,
            force_stop_server,
            send_server_command,
            list_directory,
            read_text_file,
            write_text_file,
            rename_entry,
            delete_entry,
            toggle_entry,
            read_properties,
            write_properties,
            read_player_lists,
            update_player,
            list_server_cores,
            list_core_builds,
            download_server_core,
            list_official_core_versions,
            list_official_core_builds,
            download_official_server_core,
            get_metrics,
            get_auto_restart_config,
            set_auto_restart_config,
            search_modrinth,
            get_modrinth_versions,
            download_plugin,
            get_core_types,
            list_java_releases,
            download_java,
            search_spiget,
            download_spiget_plugin,
            cancel_download,
            init_extension_manager,
            scan_extensions,
            start_extension,
            stop_extension,
            call_extension_tool,
            uninstall_extension,
            fetch_extension_registry,
            install_registry_extension,
            ai_chat,
            list_backups,
            create_backup,
            restore_backup,
            delete_backup,
            platform_capabilities
        ])
        .run(tauri::generate_context!())
        .expect("error while running Astrore");
}
