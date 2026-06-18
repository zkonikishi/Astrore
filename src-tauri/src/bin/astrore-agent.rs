use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Path as AxumPath, State},
    http::{HeaderMap, Method, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    env, fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{atomic::{AtomicBool, AtomicU32, Ordering}, Arc, LazyLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{broadcast, Mutex},
    time::sleep,
};
use tower_http::{cors::CorsLayer, services::ServeDir};

fn agent_user_agent() -> String {
    format!("Astrore-Agent/{}", env!("CARGO_PKG_VERSION"))
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
fn hide_subprocess_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_subprocess_window(_: &mut Command) {}

#[derive(Clone)]
struct AgentState {
    token: String,
    process: Arc<Mutex<Option<ManagedProcess>>>,
    console: Arc<Mutex<VecDeque<String>>>,
    auto_restart: Arc<Mutex<AutoRestartConfig>>,
    last_config: Arc<Mutex<Option<InstanceConfig>>>,
    intentional_stop: Arc<AtomicBool>,
    restart_count: Arc<AtomicU32>,
    performance_commands: Arc<AtomicU32>,
    config_path: PathBuf,
    system: Arc<Mutex<sysinfo::System>>,
    game_metrics: Arc<Mutex<ServerMetrics>>,
    events: broadcast::Sender<String>,
}

struct ManagedProcess {
    name: String,
    child: Child,
    stdin: ChildStdin,
    started_at: Instant,
    memory_max_mb: u32,
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

impl Default for AutoRestartConfig {
    fn default() -> Self {
        Self { enabled: false, max_restarts: 3, restart_delay_secs: 5 }
    }
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

fn error(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": message.into() })))
}

fn authorized(headers: &HeaderMap, state: &AgentState) -> bool {
    state.token.is_empty()
        || headers
            .get("x-astrore-token")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value == state.token)
}

fn root(value: &Value) -> Result<PathBuf, String> {
    let path = value
        .get("instancePath")
        .and_then(Value::as_str)
        .ok_or("缺少实例目录")?;
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err("实例目录不存在".into());
    }
    root.canonicalize().map_err(|error| error.to_string())
}

fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative);
    let resolved = if candidate.exists() {
        candidate.canonicalize().map_err(|error| error.to_string())?
    } else {
        let parent = candidate.parent().ok_or("无效路径")?;
        parent
            .canonicalize()
            .map_err(|error| error.to_string())?
            .join(candidate.file_name().ok_or("无效文件名")?)
    };
    if !resolved.starts_with(root) {
        return Err("拒绝访问实例目录之外的路径".into());
    }
    Ok(resolved)
}

fn modified(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

async fn console_message(state: &AgentState, message: impl Into<String>) {
    let message = message.into();
    parse_game_metrics(state, &message).await;
    let mut history = state.console.lock().await;
    if history.len() >= 500 { history.pop_front(); }
    history.push_back(message.clone());
    let _ = state.events.send(json!({ "type": "console", "payload": message }).to_string());
}

fn broadcast_event(state: &AgentState, kind: &str, payload: Value) {
    let _ = state.events.send(json!({ "type": kind, "payload": payload }).to_string());
}

static COMBINED_PERFORMANCE_REGEX: LazyLock<regex_lite::Regex> = LazyLock::new(|| {
    regex_lite::Regex::new(r"(?i)TPS[\s:=]+[*]?(\d+(?:\.\d+)?).*?MSPT[\s:=]+[*]?(\d+(?:\.\d+)?)").unwrap()
});
static TPS_REGEX: LazyLock<regex_lite::Regex> = LazyLock::new(|| {
    regex_lite::Regex::new(r"(?i)TPS(?: from last [^:]+)?[\s:=]+[*]?(\d+(?:\.\d+)?)").unwrap()
});
static MSPT_REGEX: LazyLock<regex_lite::Regex> = LazyLock::new(|| {
    regex_lite::Regex::new(r"(?i)MSPT(?: from last [^:]+)?[\s:=]+[*]?(\d+(?:\.\d+)?)").unwrap()
});
static PLAYERS_REGEX: LazyLock<regex_lite::Regex> = LazyLock::new(|| {
    regex_lite::Regex::new(r"(?i)There are (\d+) of a max of (\d+) players? online(?::\s*(.*))?").unwrap()
});
static CHUNKS_REGEX: LazyLock<regex_lite::Regex> =
    LazyLock::new(|| regex_lite::Regex::new(r"(?i)Chunks?[\s:=]+(\d+)").unwrap());
static ENTITIES_REGEX: LazyLock<regex_lite::Regex> =
    LazyLock::new(|| regex_lite::Regex::new(r"(?i)Entities?[\s:=]+(\d+)").unwrap());

fn captured_f64(captures: &regex_lite::Captures<'_>, index: usize) -> Option<f64> {
    captures.get(index)?.as_str().parse().ok()
}

fn captured_u32(captures: &regex_lite::Captures<'_>, index: usize) -> Option<u32> {
    captures.get(index)?.as_str().parse().ok()
}

async fn parse_game_metrics(state: &AgentState, line: &str) {
    let lower = line.to_ascii_lowercase();
    if lower.contains("paper") || lower.contains("purpur") || lower.contains("folia") {
        state.performance_commands.fetch_or(3, Ordering::SeqCst);
    } else if lower.contains("spigot") {
        state.performance_commands.fetch_or(1, Ordering::SeqCst);
    }
    let mut metrics = state.game_metrics.lock().await;
    if let Some(captures) = COMBINED_PERFORMANCE_REGEX.captures(line) {
        state.performance_commands.fetch_or(3, Ordering::SeqCst);
        metrics.tps = captured_f64(&captures, 1).unwrap_or(metrics.tps);
        metrics.mspt = captured_f64(&captures, 2).unwrap_or(metrics.mspt);
    } else {
        if let Some(captures) = TPS_REGEX.captures(line) {
            state.performance_commands.fetch_or(1, Ordering::SeqCst);
            metrics.tps = captured_f64(&captures, 1).unwrap_or(metrics.tps);
        }
        if let Some(captures) = MSPT_REGEX.captures(line) {
            state.performance_commands.fetch_or(2, Ordering::SeqCst);
            metrics.mspt = captured_f64(&captures, 1).unwrap_or(metrics.mspt);
        }
    }
    if let Some(captures) = PLAYERS_REGEX.captures(line) {
        metrics.online_players = captured_u32(&captures, 1).unwrap_or(0);
        metrics.max_players = captured_u32(&captures, 2).unwrap_or(20);
        metrics.player_list = captures.get(3)
            .map(|players| players.as_str().split(',').map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned).collect())
            .unwrap_or_default();
    }
    if let Some(captures) = CHUNKS_REGEX.captures(line) {
        metrics.chunk_count = captured_u32(&captures, 1).unwrap_or(metrics.chunk_count);
    }
    if let Some(captures) = ENTITIES_REGEX.captures(line) {
        metrics.entity_count = captured_u32(&captures, 1).unwrap_or(metrics.entity_count);
    }
}

async fn reset_game_metrics(state: &AgentState) {
    *state.game_metrics.lock().await = ServerMetrics { max_players: 20, ..Default::default() };
    state.performance_commands.store(0, Ordering::SeqCst);
}

async fn collect_metrics(state: &AgentState) -> ServerMetrics {
    let (pid, uptime_secs, memory_max_mb) = {
        let process = state.process.lock().await;
        process.as_ref().map(|managed| (
            managed.child.id(),
            managed.started_at.elapsed().as_secs(),
            managed.memory_max_mb as f64,
        )).unwrap_or((None, 0, 0.0))
    };
    let mut metrics = state.game_metrics.lock().await.clone();
    metrics.uptime_secs = uptime_secs;
    metrics.memory_max_mb = memory_max_mb;
    if let Some(pid) = pid {
        let mut system = state.system.lock().await;
        let pid = sysinfo::Pid::from(pid as usize);
        system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
        if let Some(process) = system.process(pid) {
            metrics.cpu_percent = process.cpu_usage() as f64;
            metrics.memory_mb = process.memory() as f64 / 1_048_576.0;
        }
    }
    let instance_path = state.last_config.lock().await.as_ref().map(|config| PathBuf::from(&config.instance_path));
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let disk = instance_path.as_ref()
        .and_then(|path| disks.iter().filter(|disk| path.starts_with(disk.mount_point())).max_by_key(|disk| disk.mount_point().as_os_str().len()))
        .or_else(|| disks.first());
    if let Some(disk) = disk {
        metrics.disk_free_gb = disk.available_space() as f64 / 1_073_741_824.0;
    }
    metrics
}

fn load_auto_restart(path: &Path) -> AutoRestartConfig {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_auto_restart(path: &Path, config: &AutoRestartConfig) -> Result<(), String> {
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(path, text).map_err(|error| format!("保存 Agent 配置失败: {error}"))
}

fn list_directory(args: &Value) -> Result<Value, String> {
    let root = root(args)?;
    let relative = args.get("relativePath").and_then(Value::as_str).unwrap_or("");
    let directory = safe_path(&root, relative)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        entries.push(FileEntry {
            relative_path: path
                .strip_prefix(&root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .replace('\\', "/"),
            enabled: !name.ends_with(".disabled"),
            name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified: modified(&path),
        });
    }
    entries.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    serde_json::to_value(entries).map_err(|error| error.to_string())
}

fn read_properties(args: &Value) -> Result<Value, String> {
    let path = root(args)?.join("server.properties");
    let text = fs::read_to_string(path).unwrap_or_default();
    let properties: BTreeMap<String, String> = text
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect();
    serde_json::to_value(properties).map_err(|error| error.to_string())
}

fn read_json(path: &Path) -> Value {
    fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_else(|| json!([]))
}

fn backup_name(name: &str) -> Result<(), String> {
    if !name.ends_with(".tar.gz") || name.contains(['/', '\\']) {
        Err("无效的备份名称".into())
    } else {
        Ok(())
    }
}

fn list_backups(args: &Value) -> Result<Value, String> {
    let directory = root(args)?.join(".astrore-backups");
    if !directory.exists() {
        return Ok(json!([]));
    }
    let mut backups = Vec::new();
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if metadata.is_file() && name.ends_with(".tar.gz") {
            backups.push(json!({ "name": name, "size": metadata.len(), "modified": modified(&entry.path()) }));
        }
    }
    backups.sort_by_key(|item| std::cmp::Reverse(item["modified"].as_u64().unwrap_or(0)));
    Ok(Value::Array(backups))
}

fn create_backup(args: &Value) -> Result<Value, String> {
    let root = root(args)?;
    let directory = root.join(".astrore-backups");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let label: String = args
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(40)
        .collect();
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_secs();
    let name = if label.is_empty() { format!("backup-{timestamp}.tar.gz") } else { format!("backup-{timestamp}-{label}.tar.gz") };
    let file = fs::File::create(directory.join(&name)).map_err(|error| error.to_string())?;
    let encoder = GzEncoder::new(file, Compression::default());
    let mut archive = tar::Builder::new(encoder);
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.path() == directory { continue; }
        if entry.path().is_dir() {
            archive.append_dir_all(entry.file_name(), entry.path()).map_err(|error| error.to_string())?;
        } else {
            archive.append_path_with_name(entry.path(), entry.file_name()).map_err(|error| error.to_string())?;
        }
    }
    let encoder = archive.into_inner().map_err(|error| error.to_string())?;
    encoder.finish().map_err(|error| error.to_string())?;
    let path = directory.join(&name);
    Ok(json!({ "name": name, "size": fs::metadata(&path).map_err(|error| error.to_string())?.len(), "modified": timestamp }))
}

async fn spawn_server(config: InstanceConfig, state: &AgentState) -> Result<Value, String> {
    let mut process = state.process.lock().await;
    if process.is_some() { return Err("服务器已经在运行".into()); }
    let root = PathBuf::from(&config.instance_path).canonicalize().map_err(|error| error.to_string())?;
    if !root.join(&config.server_jar).is_file() { return Err("服务端核心不存在".into()); }
    let mut command = Command::new(if config.java_path.trim().is_empty() { "java" } else { &config.java_path });
    hide_subprocess_window(&mut command);
    command.current_dir(root)
        .arg(format!("-Xms{}M", config.min_memory_mb))
        .arg(format!("-Xmx{}M", config.max_memory_mb))
        .args(config.java_args)
        .arg("-jar").arg(config.server_jar)
        .args(config.server_args)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("启动失败: {error}"))?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or("无法连接服务器输入")?;
    let stdout = child.stdout.take().ok_or("无法读取服务器输出")?;
    let stderr = child.stderr.take().ok_or("无法读取服务器错误输出")?;
    let stdout_state = state.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            console_message(&stdout_state, line).await;
        }
    });
    let stderr_state = state.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            console_message(&stderr_state, line).await;
        }
    });
    *process = Some(ManagedProcess {
        name: config.name.clone(),
        child,
        stdin,
        started_at: Instant::now(),
        memory_max_mb: config.max_memory_mb,
    });
    let status = json!({ "running": true, "pid": pid, "instanceName": config.name });
    broadcast_event(state, "status", status.clone());
    Ok(status)
}

async fn start_server(args: &Value, state: &AgentState) -> Result<Value, String> {
    let config: InstanceConfig = serde_json::from_value(args.get("config").cloned().ok_or("缺少实例配置")?)
        .map_err(|error| error.to_string())?;
    state.intentional_stop.store(false, Ordering::SeqCst);
    state.restart_count.store(0, Ordering::SeqCst);
    reset_game_metrics(state).await;
    *state.last_config.lock().await = Some(config.clone());
    spawn_server(config, state).await
}

async fn monitor_process(state: AgentState) {
    loop {
        sleep(Duration::from_secs(1)).await;
        let exited = {
            let mut process = state.process.lock().await;
            let outcome = match process.as_mut() {
                Some(managed) => match managed.child.try_wait() {
                    Ok(Some(status)) => Some((managed.name.clone(), status.code())),
                    Ok(None) => None,
                    Err(_) => Some((managed.name.clone(), None)),
                },
                None => None,
            };
            if outcome.is_some() {
                *process = None;
            }
            outcome
        };
        let Some((name, code)) = exited else { continue };
        console_message(&state, format!("[Astrore] {name} 进程已退出，退出码: {}", code.map_or_else(|| "未知".into(), |value| value.to_string()))).await;
        reset_game_metrics(&state).await;
        broadcast_event(&state, "status", json!({ "running": false, "pid": null, "instanceName": null }));
        if state.intentional_stop.swap(false, Ordering::SeqCst) {
            state.restart_count.store(0, Ordering::SeqCst);
            continue;
        }
        let restart = state.auto_restart.lock().await.clone();
        let mut count = state.restart_count.load(Ordering::SeqCst);
        if !restart.enabled || count >= restart.max_restarts { continue; }
        let Some(config) = state.last_config.lock().await.clone() else { continue };
        while count < restart.max_restarts {
            count += 1;
            state.restart_count.store(count, Ordering::SeqCst);
            console_message(&state, format!("[Astrore] 将在 {} 秒后自动重启（{count}/{}）", restart.restart_delay_secs, restart.max_restarts)).await;
            sleep(Duration::from_secs(restart.restart_delay_secs)).await;
            if state.intentional_stop.load(Ordering::SeqCst) { break; }
            match spawn_server(config.clone(), &state).await {
                Ok(_) => break,
                Err(error) => console_message(&state, format!("[Astrore] 自动重启失败: {error}")).await,
            }
        }
    }
}

async fn broadcast_metrics(state: AgentState) {
    loop {
        sleep(Duration::from_secs(2)).await;
        let metrics = collect_metrics(&state).await;
        if let Ok(payload) = serde_json::to_value(metrics) {
            broadcast_event(&state, "metrics", payload);
        }
    }
}

async fn probe_game_metrics(state: AgentState) {
    loop {
        sleep(Duration::from_secs(30)).await;
        let commands = state.performance_commands.load(Ordering::SeqCst);
        let mut process = state.process.lock().await;
        let Some(managed) = process.as_mut() else { continue };
        let mut probe = String::new();
        if commands & 1 != 0 { probe.push_str("tps\n"); }
        if commands & 2 != 0 { probe.push_str("mspt\n"); }
        probe.push_str("list\n");
        if managed.stdin.write_all(probe.as_bytes()).await.is_ok() {
            let _ = managed.stdin.flush().await;
        }
    }
}

async fn invoke(command: &str, args: Value, state: &AgentState) -> Result<Value, String> {
    match command {
        "platform_capabilities" => Ok(json!({ "platform": env::consts::OS, "localServerManagement": true, "remoteControl": true })),
        "check_eula" => {
            let path = root(&args)?.join("eula.txt");
            let accepted = fs::read_to_string(&path).unwrap_or_default().lines().any(|line| line.trim().eq_ignore_ascii_case("eula=true"));
            Ok(json!({ "accepted": accepted, "path": path }))
        }
        "accept_eula" => {
            let path = root(&args)?.join("eula.txt");
            fs::write(&path, "eula=true\n").map_err(|error| error.to_string())?;
            Ok(json!({ "accepted": true, "path": path }))
        }
        "server_status" => {
            let mut process = state.process.lock().await;
            if let Some(managed) = process.as_mut() {
                if managed.child.try_wait().map_err(|error| error.to_string())?.is_none() {
                    return Ok(json!({ "running": true, "pid": managed.child.id(), "instanceName": managed.name }));
                }
            }
            Ok(json!({ "running": false, "pid": null, "instanceName": null }))
        }
        "start_server" => start_server(&args, state).await,
        "send_server_command" => {
            let command = args.get("command").and_then(Value::as_str).ok_or("缺少命令")?;
            let mut process = state.process.lock().await;
            let managed = process.as_mut().ok_or("服务器未运行")?;
            managed.stdin.write_all(format!("{command}\n").as_bytes()).await.map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "stop_server" => {
            state.intentional_stop.store(true, Ordering::SeqCst);
            let mut process = state.process.lock().await;
            let managed = process.as_mut().ok_or("服务器未运行")?;
            managed.stdin.write_all(b"stop\n").await.map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "force_stop_server" => {
            state.intentional_stop.store(true, Ordering::SeqCst);
            let mut process = state.process.lock().await;
            if let Some(managed) = process.as_mut() { managed.child.kill().await.map_err(|error| error.to_string())?; }
            *process = None;
            broadcast_event(state, "status", json!({ "running": false, "pid": null, "instanceName": null }));
            Ok(Value::Null)
        }
        "get_console" => Ok(json!(state.console.lock().await.iter().cloned().collect::<Vec<_>>())),
        "ai_chat" => {
            let request = args.get("request").ok_or("缺少 AI 请求")?;
            let endpoint = request.get("endpoint").and_then(Value::as_str).ok_or("缺少 AI 接口地址")?;
            let url = reqwest::Url::parse(endpoint).map_err(|error| format!("AI 接口地址无效: {error}"))?;
            let host = url.host_str().ok_or("AI 接口地址缺少主机名")?;
            if url.scheme() != "https" && !(url.scheme() == "http" && matches!(host, "127.0.0.1" | "localhost" | "::1")) {
                return Err("AI 接口必须使用 HTTPS；本地模型可使用 localhost HTTP".into());
            }
            let mut call = reqwest::Client::new()
                .post(url)
                .timeout(std::time::Duration::from_secs(120))
                .header("User-Agent", agent_user_agent())
                .json(&json!({
                "model": request.get("model").and_then(Value::as_str).ok_or("缺少模型名称")?,
                "messages": request.get("messages").and_then(Value::as_array).ok_or("缺少对话内容")?,
                "temperature": request.get("temperature").and_then(Value::as_f64).unwrap_or(0.7),
                "max_tokens": request.get("maxTokens").and_then(Value::as_u64).unwrap_or(4096),
            }));
            if let Some(key) = request.get("apiKey").and_then(Value::as_str).filter(|key| !key.is_empty()) {
                call = call.bearer_auth(key);
            }
            let response: Value = call.send().await.map_err(|error| format!("AI 请求失败: {error}"))?
                .error_for_status().map_err(|error| format!("AI 接口返回错误: {error}"))?
                .json().await.map_err(|error| format!("无法解析 AI 响应: {error}"))?;
            Ok(json!(response["choices"][0]["message"]["content"].as_str().ok_or("AI 响应缺少内容")?))
        }
        "list_directory" => list_directory(&args),
        "read_text_file" => {
            let root = root(&args)?;
            let path = safe_path(&root, args.get("relativePath").and_then(Value::as_str).ok_or("缺少相对路径")?)?;
            Ok(json!(fs::read_to_string(path).map_err(|error| error.to_string())?))
        }
        "write_text_file" => {
            let root = root(&args)?;
            let path = safe_path(&root, args.get("relativePath").and_then(Value::as_str).ok_or("缺少相对路径")?)?;
            fs::write(path, args.get("content").and_then(Value::as_str).ok_or("缺少内容")?).map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "delete_entry" => {
            let root = root(&args)?;
            let path = safe_path(&root, args.get("relativePath").and_then(Value::as_str).ok_or("缺少相对路径")?)?;
            if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }.map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "rename_entry" => {
            let root = root(&args)?;
            let source = safe_path(&root, args.get("relativePath").and_then(Value::as_str).ok_or("缺少相对路径")?)?;
            let name = args.get("newName").and_then(Value::as_str).ok_or("缺少新名称")?;
            if name.trim().is_empty() || name.contains(['/', '\\']) { return Err("无效的新名称".into()); }
            fs::rename(&source, source.parent().ok_or("无效路径")?.join(name)).map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "toggle_entry" => {
            let root = root(&args)?;
            let source = safe_path(&root, args.get("relativePath").and_then(Value::as_str).ok_or("缺少相对路径")?)?;
            let name = source.file_name().and_then(|name| name.to_str()).ok_or("无效文件名")?;
            let target = if let Some(enabled) = name.strip_suffix(".disabled") { enabled.to_string() } else { format!("{name}.disabled") };
            fs::rename(&source, source.parent().ok_or("无效路径")?.join(target)).map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "read_properties" => read_properties(&args),
        "read_player_lists" => {
            let root = root(&args)?;
            Ok(json!({
                "ops": read_json(&root.join("ops.json")),
                "whitelist": read_json(&root.join("whitelist.json")),
                "bannedPlayers": read_json(&root.join("banned-players.json")),
                "bannedIps": read_json(&root.join("banned-ips.json"))
            }))
        }
        "update_player" => {
            let name = args.get("name").and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty()).ok_or("玩家名不能为空")?;
            let action = args.get("action").and_then(Value::as_str).ok_or("缺少玩家操作")?;
            let command = match action {
                "add_op" => format!("op {name}"),
                "remove_op" => format!("deop {name}"),
                "add_whitelist" => format!("whitelist add {name}"),
                "remove_whitelist" => format!("whitelist remove {name}"),
                "ban" => format!("ban {name} {}", args.get("reason").and_then(Value::as_str).unwrap_or("被封禁")),
                "unban" => format!("pardon {name}"),
                _ => return Err("未知玩家操作".into()),
            };
            let mut process = state.process.lock().await;
            let managed = process.as_mut().ok_or("请先启动服务器再修改玩家权限")?;
            managed.stdin.write_all(format!("{command}\n").as_bytes()).await.map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "get_metrics" => serde_json::to_value(collect_metrics(state).await).map_err(|error| error.to_string()),
        "get_auto_restart_config" => serde_json::to_value(state.auto_restart.lock().await.clone()).map_err(|error| error.to_string()),
        "set_auto_restart_config" => {
            let config: AutoRestartConfig = serde_json::from_value(args.get("config").cloned().ok_or("缺少自动重启配置")?)
                .map_err(|error| error.to_string())?;
            if config.max_restarts == 0 || config.max_restarts > 20 || config.restart_delay_secs == 0 || config.restart_delay_secs > 600 {
                return Err("自动重启配置超出允许范围".into());
            }
            save_auto_restart(&state.config_path, &config)?;
            *state.auto_restart.lock().await = config;
            Ok(Value::Null)
        }
        "cancel_download" => Ok(Value::Null),
        "list_server_cores" => {
            let data: Value = reqwest::Client::new().get("https://download.fastmirror.net/api/v3").header("User-Agent", agent_user_agent())
                .send().await.map_err(|error| error.to_string())?.error_for_status().map_err(|error| error.to_string())?
                .json().await.map_err(|error| error.to_string())?;
            Ok(Value::Array(data["data"].as_array().into_iter().flatten().map(|item| json!({
                "name": item["name"], "tag": item["tag"], "recommend": item["recommend"], "mcVersions": item["mc_versions"]
            })).collect()))
        }
        "list_core_builds" => {
            let core = args.get("coreName").and_then(Value::as_str).ok_or("缺少核心名称")?;
            let version = args.get("mcVersion").and_then(Value::as_str).ok_or("缺少 Minecraft 版本")?;
            let data: Value = reqwest::Client::new().get(format!("https://download.fastmirror.net/api/v3/{core}/{version}"))
                .query(&[("offset", 0), ("limit", 30)]).header("User-Agent", agent_user_agent())
                .send().await.map_err(|error| error.to_string())?.error_for_status().map_err(|error| error.to_string())?
                .json().await.map_err(|error| error.to_string())?;
            Ok(Value::Array(data["data"]["builds"].as_array().into_iter().flatten().map(|item| json!({
                "coreVersion": item["core_version"], "updateTime": item["update_time"]
            })).collect()))
        }
        "download_server_core" => {
            let root = root(&args)?;
            let core = args.get("coreName").and_then(Value::as_str).ok_or("缺少核心名称")?;
            let version = args.get("mcVersion").and_then(Value::as_str).ok_or("缺少 Minecraft 版本")?;
            let build = args.get("build").and_then(Value::as_str).ok_or("缺少构建版本")?;
            let data: Value = reqwest::Client::new().get(format!("https://download.fastmirror.net/api/v3/{core}/{version}/{build}"))
                .header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                .error_for_status().map_err(|error| error.to_string())?.json().await.map_err(|error| error.to_string())?;
            let url = data["data"]["download_url"].as_str().ok_or("下载地址不存在")?;
            let name = data["data"]["filename"].as_str().filter(|name| !name.contains(['/', '\\'])).map(str::to_string)
                .unwrap_or_else(|| format!("{core}-{version}-{build}.jar"));
            let bytes = reqwest::Client::new().get(url).header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                .error_for_status().map_err(|error| error.to_string())?.bytes().await.map_err(|error| error.to_string())?;
            fs::write(root.join(&name), bytes).map_err(|error| error.to_string())?;
            Ok(json!(name))
        }
        "list_official_core_versions" => {
            let core = args.get("coreName").and_then(Value::as_str).ok_or("missing coreName")?;
            let client = reqwest::Client::new();
            let versions: Vec<Value> = match core {
                "paper" | "folia" | "velocity" => {
                    let data: Value = client.get(format!("https://api.papermc.io/v2/projects/{core}"))
                        .header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                        .error_for_status().map_err(|error| error.to_string())?.json().await.map_err(|error| error.to_string())?;
                    data["versions"].as_array().into_iter().flatten().cloned().collect()
                }
                "purpur" => {
                    let data: Value = client.get("https://api.purpurmc.org/v2/purpur")
                        .header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                        .error_for_status().map_err(|error| error.to_string())?.json().await.map_err(|error| error.to_string())?;
                    data["versions"].as_array().into_iter().flatten().cloned().collect()
                }
                "vanilla" => {
                    let data: Value = client.get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")
                        .header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                        .error_for_status().map_err(|error| error.to_string())?.json().await.map_err(|error| error.to_string())?;
                    data["versions"].as_array().into_iter().flatten().filter_map(|item| item["id"].as_str().map(|id| json!(id))).collect()
                }
                "fabric" => {
                    let data: Value = client.get("https://meta.fabricmc.net/v2/versions/game")
                        .header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                        .error_for_status().map_err(|error| error.to_string())?.json().await.map_err(|error| error.to_string())?;
                    data.as_array().into_iter().flatten().filter_map(|item| item["version"].as_str().map(|id| json!(id))).collect()
                }
                _ => Vec::new(),
            };
            Ok(Value::Array(versions))
        }
        "list_official_core_builds" => {
            let core = args.get("coreName").and_then(Value::as_str).ok_or("missing coreName")?;
            let version = args.get("mcVersion").and_then(Value::as_str).ok_or("missing mcVersion")?;
            let client = reqwest::Client::new();
            let builds: Vec<Value> = match core {
                "paper" | "folia" | "velocity" => {
                    let data: Value = client.get(format!("https://api.papermc.io/v2/projects/{core}/versions/{version}"))
                        .header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                        .error_for_status().map_err(|error| error.to_string())?.json().await.map_err(|error| error.to_string())?;
                    data["builds"].as_array().into_iter().flatten().filter_map(|build| build.as_u64().map(|n| json!({ "coreVersion": n.to_string(), "updateTime": "" }))).collect()
                }
                "purpur" => {
                    let data: Value = client.get(format!("https://api.purpurmc.org/v2/purpur/{version}"))
                        .header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                        .error_for_status().map_err(|error| error.to_string())?.json().await.map_err(|error| error.to_string())?;
                    data["builds"].as_object().into_iter().flatten().map(|(key, value)| json!({ "coreVersion": key, "updateTime": value["timestamp"] })).collect()
                }
                "vanilla" => {
                    let data: Value = client.get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")
                        .header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                        .error_for_status().map_err(|error| error.to_string())?.json().await.map_err(|error| error.to_string())?;
                    data["versions"].as_array().into_iter().flatten().find(|item| item["id"].as_str() == Some(version))
                        .map(|item| vec![json!({ "coreVersion": item["id"], "updateTime": item["releaseTime"] })]).unwrap_or_default()
                }
                "fabric" => {
                    let data: Value = client.get(format!("https://meta.fabricmc.net/v2/versions/loader/{version}"))
                        .header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                        .error_for_status().map_err(|error| error.to_string())?.json().await.map_err(|error| error.to_string())?;
                    data.as_array().into_iter().flatten().filter_map(|item| item["loader"]["version"].as_str().map(|loader| json!({ "coreVersion": loader, "updateTime": "" }))).collect()
                }
                _ => Vec::new(),
            };
            Ok(Value::Array(builds))
        }
        "download_official_server_core" => {
            let root = root(&args)?;
            let core = args.get("coreName").and_then(Value::as_str).ok_or("missing coreName")?;
            let version = args.get("mcVersion").and_then(Value::as_str).ok_or("missing mcVersion")?;
            let build = args.get("build").and_then(Value::as_str).ok_or("missing build")?;
            let client = reqwest::Client::new();
            let (url, name) = match core {
                "paper" | "folia" | "velocity" => {
                    let data: Value = client.get(format!("https://api.papermc.io/v2/projects/{core}/versions/{version}/builds/{build}"))
                        .header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                        .error_for_status().map_err(|error| error.to_string())?.json().await.map_err(|error| error.to_string())?;
                    let name = data["downloads"]["application"]["name"].as_str().unwrap_or("server.jar").to_string();
                    (format!("https://api.papermc.io/v2/projects/{core}/versions/{version}/builds/{build}/downloads/{name}"), name)
                }
                "purpur" => (format!("https://api.purpurmc.org/v2/purpur/{version}/{build}/download"), format!("purpur-{version}-{build}.jar")),
                "vanilla" => {
                    let manifest: Value = client.get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")
                        .header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                        .error_for_status().map_err(|error| error.to_string())?.json().await.map_err(|error| error.to_string())?;
                    let detail_url = manifest["versions"].as_array().into_iter().flatten().find(|item| item["id"].as_str() == Some(version))
                        .and_then(|item| item["url"].as_str()).ok_or("vanilla version not found")?;
                    let detail: Value = client.get(detail_url).header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                        .error_for_status().map_err(|error| error.to_string())?.json().await.map_err(|error| error.to_string())?;
                    (detail["downloads"]["server"]["url"].as_str().ok_or("server download not found")?.to_string(), format!("minecraft_server.{version}.jar"))
                }
                "fabric" => (format!("https://meta.fabricmc.net/v2/versions/loader/{version}/{build}/server/jar"), format!("fabric-server-{version}-{build}.jar")),
                _ => return Err("unsupported official core".into()),
            };
            if name.is_empty() || name.contains(['/', '\\']) { return Err("invalid file name".into()); }
            let bytes = client.get(url).header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                .error_for_status().map_err(|error| error.to_string())?.bytes().await.map_err(|error| error.to_string())?;
            fs::write(root.join(&name), bytes).map_err(|error| error.to_string())?;
            Ok(json!(name))
        }
        "search_modrinth" => {
            let query = args.get("query").and_then(Value::as_str).ok_or("缺少搜索关键词")?;
            let kind = args.get("kind").and_then(Value::as_str).unwrap_or("plugins");
            let project_type = if kind == "mods" { "mod" } else { "plugin" };
            let facets = format!("[[\"project_type:{project_type}\"]]");
            let data: Value = reqwest::Client::new().get("https://api.modrinth.com/v2/search")
                .query(&[("query", query), ("facets", facets.as_str()), ("limit", "30")]).header("User-Agent", agent_user_agent())
                .send().await.map_err(|error| error.to_string())?.error_for_status().map_err(|error| error.to_string())?
                .json().await.map_err(|error| error.to_string())?;
            Ok(Value::Array(data["hits"].as_array().into_iter().flatten().map(|item| json!({
                "name": item["slug"], "title": item["title"], "description": item["description"], "iconUrl": item["icon_url"],
                "downloads": item["downloads"], "categories": item["categories"], "projectId": item["project_id"]
            })).collect()))
        }
        "get_modrinth_versions" => {
            let project = args.get("projectId").and_then(Value::as_str).ok_or("缺少项目 ID")?;
            let data: Value = reqwest::Client::new().get(format!("https://api.modrinth.com/v2/project/{project}/version"))
                .header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                .error_for_status().map_err(|error| error.to_string())?.json().await.map_err(|error| error.to_string())?;
            Ok(Value::Array(data.as_array().into_iter().flatten().filter_map(|item| {
                let file = item["files"].as_array()?.iter().find(|file| file["primary"].as_bool().unwrap_or(false)).or_else(|| item["files"].as_array()?.first())?;
                Some(json!({ "name": item["name"], "versionNumber": item["version_number"], "downloadUrl": file["url"],
                    "fileName": file["filename"], "gameVersions": item["game_versions"], "loaders": item["loaders"] }))
            }).collect()))
        }
        "search_curseforge" => {
            let query = args.get("query").and_then(Value::as_str).unwrap_or("popular");
            let kind = args.get("kind").and_then(Value::as_str).unwrap_or("plugins");
            let api_key = args.get("apiKey").and_then(Value::as_str).ok_or("CurseForge 需要 API Key")?;
            let class_id = if kind == "mods" { "6" } else { "4471" };
            let data: Value = reqwest::Client::new()
                .get("https://api.curseforge.com/v1/mods/search")
                .query(&[("gameId", "432"), ("classId", class_id), ("searchFilter", query), ("pageSize", "20")])
                .header("x-api-key", api_key)
                .header("User-Agent", agent_user_agent())
                .send().await.map_err(|error| format!("CurseForge 搜索失败: {error}"))?
                .error_for_status().map_err(|error| format!("CurseForge 请求失败: {error}"))?
                .json().await.map_err(|error| format!("解析失败: {error}"))?;
            Ok(Value::Array(data["data"].as_array().into_iter().flatten().map(|item| json!({
                "name": item["slug"], "title": item["name"], "description": item["summary"],
                "iconUrl": item["logo"]["url"], "downloads": item["downloadCount"],
                "categories": item["categories"].as_array().into_iter().flatten().filter_map(|v| v["name"].as_str().map(str::to_string)).collect::<Vec<_>>(),
                "projectId": item["id"].as_u64().unwrap_or(0).to_string()
            })).collect()))
        }
        "get_curseforge_files" => {
            let mod_id = args.get("modId").and_then(Value::as_str).ok_or("缺少 Mod ID")?;
            let api_key = args.get("apiKey").and_then(Value::as_str).ok_or("CurseForge 需要 API Key")?;
            let data: Value = reqwest::Client::new()
                .get(format!("https://api.curseforge.com/v1/mods/{mod_id}/files"))
                .query(&[("pageSize", "20")])
                .header("x-api-key", api_key)
                .header("User-Agent", agent_user_agent())
                .send().await.map_err(|error| format!("CurseForge 获取文件失败: {error}"))?
                .error_for_status().map_err(|error| format!("CurseForge 请求失败: {error}"))?
                .json().await.map_err(|error| format!("解析失败: {error}"))?;
            Ok(Value::Array(data["data"].as_array().into_iter().flatten().filter_map(|item| {
                let file_name = item["fileName"].as_str().unwrap_or_default().to_string();
                if file_name.is_empty() { return None; }
                Some(json!({
                    "name": item["displayName"].as_str().unwrap_or(&file_name),
                    "versionNumber": item["displayName"].as_str().unwrap_or_default(),
                    "downloadUrl": item["downloadUrl"].as_str().unwrap_or_default(),
                    "fileName": file_name,
                    "gameVersions": item["gameVersions"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>(),
                    "loaders": []
                }))
            }).collect()))
        }
        "download_plugin" => {
            let root = root(&args)?;
            let kind = args.get("kind").and_then(Value::as_str).ok_or("缺少下载类型")?;
            if !matches!(kind, "plugins" | "mods") { return Err("无效的下载目录".into()); }
            let name = args.get("fileName").and_then(Value::as_str).ok_or("缺少文件名")?;
            if name.is_empty() || name.contains(['/', '\\']) { return Err("无效的文件名".into()); }
            let url = reqwest::Url::parse(args.get("downloadUrl").and_then(Value::as_str).ok_or("缺少下载地址")?).map_err(|error| error.to_string())?;
            let host = url.host_str().ok_or("下载地址缺少主机名")?;
            if url.scheme() != "https" || !(host == "modrinth.com" || host.ends_with(".modrinth.com") || host == "forgecdn.net" || host.ends_with(".forgecdn.net") || host == "edge.forgecdn.net" || host.ends_with(".curseforge.com")) { return Err("只允许从 Modrinth / CurseForge HTTPS 地址下载".into()); }
            let bytes = reqwest::Client::new().get(url).header("User-Agent", agent_user_agent()).send().await.map_err(|error| error.to_string())?
                .error_for_status().map_err(|error| error.to_string())?.bytes().await.map_err(|error| error.to_string())?;
            let directory = root.join(kind);
            fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            fs::write(directory.join(name), bytes).map_err(|error| error.to_string())?;
            Ok(json!(name))
        }
        "search_spiget" => {
            let query = args.get("query").and_then(Value::as_str).unwrap_or("popular");
            let url = format!("https://api.spiget.org/v2/search/resources/{query}?size=20&sort=-downloads&fields=id,name,tag,description,icon,downloads,rating,author,version");
            let data: Value = reqwest::Client::new()
                .get(&url)
                .header("User-Agent", agent_user_agent())
                .send().await.map_err(|error| format!("搜索失败: {error}"))?
                .error_for_status().map_err(|error| format!("Spiget 返回错误: {error}"))?
                .json().await.map_err(|error| format!("解析失败: {error}"))?;
            Ok(Value::Array(data.as_array().into_iter().flatten().map(|item| json!(SpigetResource {
                id: item["id"].as_u64().unwrap_or(0) as u32,
                name: item["name"].as_str().unwrap_or_default().to_string(),
                tag: item["tag"].as_str().unwrap_or_default().to_string(),
                description: item["description"].as_str().unwrap_or_default().to_string(),
                icon_url: item["icon"].as_object().and_then(|icon| icon["url"].as_str()).unwrap_or_default().to_string(),
                downloads: item["downloads"].as_u64().unwrap_or(0),
                rating: item["rating"].as_f64().unwrap_or(0.0),
                author: item["author"].as_object().and_then(|author| author["name"].as_str()).unwrap_or_default().to_string(),
                version: item["version"].as_object().and_then(|version| version["name"].as_str()).unwrap_or_default().to_string(),
            })).collect()))
        }
        "download_spiget_plugin" => {
            let root = root(&args)?;
            let resource_id = args.get("resourceId").and_then(Value::as_u64).ok_or("缺少 Spiget 资源 ID")?;
            let name = args.get("fileName").and_then(Value::as_str).ok_or("缺少文件名")?;
            if name.is_empty() || name.contains(['/', '\\']) { return Err("无效的文件名".into()); }
            let directory = root.join("plugins");
            fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            let bytes = reqwest::Client::new()
                .get(format!("https://api.spiget.org/v2/resources/{resource_id}/download"))
                .header("User-Agent", agent_user_agent())
                .send().await.map_err(|error| format!("下载失败: {error}"))?
                .error_for_status().map_err(|error| format!("Spiget 返回错误: {error}"))?
                .bytes().await.map_err(|error| format!("读取失败: {error}"))?;
            fs::write(directory.join(name), bytes).map_err(|error| error.to_string())?;
            Ok(json!(name))
        }
        "write_properties" => {
            let root = root(&args)?;
            let properties = args.get("properties").and_then(Value::as_object).ok_or("缺少配置")?;
            let text = properties.iter().map(|(key, value)| format!("{key}={}", value.as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n");
            fs::write(root.join("server.properties"), format!("{text}\n")).map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "list_backups" => list_backups(&args),
        "create_backup" => create_backup(&args),
        "restore_backup" => {
            if state.process.lock().await.is_some() { return Err("恢复备份前必须停止服务器".into()); }
            let root = root(&args)?;
            let name = args.get("name").and_then(Value::as_str).ok_or("缺少备份名称")?;
            backup_name(name)?;
            tar::Archive::new(GzDecoder::new(fs::File::open(root.join(".astrore-backups").join(name)).map_err(|error| error.to_string())?))
                .unpack(root).map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "delete_backup" => {
            let root = root(&args)?;
            let name = args.get("name").and_then(Value::as_str).ok_or("缺少备份名称")?;
            backup_name(name)?;
            fs::remove_file(root.join(".astrore-backups").join(name)).map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        _ => Err(format!("网页 Agent 暂不支持命令: {command}")),
    }
}

async fn rpc(
    State(state): State<AgentState>,
    headers: HeaderMap,
    AxumPath(command): AxumPath<String>,
    Json(args): Json<Value>,
) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return error(StatusCode::UNAUTHORIZED, "访问令牌无效");
    }
    match invoke(&command, args, &state).await {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(message) => error(StatusCode::BAD_REQUEST, message),
    }
}

async fn health() -> Json<Value> {
    Json(json!({ "name": "Astrore Agent", "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

async fn websocket(
    State(state): State<AgentState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let token = headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').map(str::trim).find_map(|protocol| protocol.strip_prefix("astrore-token.")))
        .unwrap_or("");
    if !state.token.is_empty() && token != state.token {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.protocols(["astrore"]).on_upgrade(move |socket| websocket_client(socket, state)).into_response()
}

async fn websocket_client(mut socket: WebSocket, state: AgentState) {
    let mut receiver = state.events.subscribe();
    let history = state.console.lock().await.iter().cloned().collect::<Vec<_>>();
    let status = invoke("server_status", Value::Null, &state).await.unwrap_or_else(|_| json!({ "running": false, "pid": null, "instanceName": null }));
    let metrics = serde_json::to_value(collect_metrics(&state).await).unwrap_or_default();
    for event in [
        json!({ "type": "console-history", "payload": history }),
        json!({ "type": "status", "payload": status }),
        json!({ "type": "metrics", "payload": metrics }),
    ] {
        if socket.send(Message::Text(event.to_string().into())).await.is_err() { return; }
    }
    while let Ok(event) = receiver.recv().await {
        if socket.send(Message::Text(event.into())).await.is_err() { break; }
    }
}

#[tokio::main]
async fn main() {
    let executable_dir = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .or_else(|| env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let bind = env::var("ASTRORE_BIND").unwrap_or_else(|_| "127.0.0.1:1421".into());
    let token = env::var("ASTRORE_TOKEN").unwrap_or_default();
    let web_root = env::var("ASTRORE_WEB_ROOT").map(PathBuf::from).unwrap_or_else(|_| executable_dir.join("dist"));
    let config_path = env::var("ASTRORE_CONFIG").map(PathBuf::from).unwrap_or_else(|_| executable_dir.join(".astrore-agent.json"));
    if token.is_empty() && !bind.starts_with("127.0.0.1:") && !bind.starts_with("localhost:") {
        eprintln!("拒绝启动：监听非本机地址时必须设置 ASTRORE_TOKEN");
        std::process::exit(2);
    }
    let allow_remote_web = !token.is_empty();
    let (events, _) = broadcast::channel(512);
    let state = AgentState {
        token,
        process: Arc::new(Mutex::new(None)),
        console: Arc::new(Mutex::new(VecDeque::new())),
        auto_restart: Arc::new(Mutex::new(load_auto_restart(&config_path))),
        last_config: Arc::new(Mutex::new(None)),
        intentional_stop: Arc::new(AtomicBool::new(false)),
        restart_count: Arc::new(AtomicU32::new(0)),
        performance_commands: Arc::new(AtomicU32::new(0)),
        config_path,
        system: Arc::new(Mutex::new(sysinfo::System::new_all())),
        game_metrics: Arc::new(Mutex::new(ServerMetrics { max_players: 20, ..Default::default() })),
        events,
    };
    tokio::spawn(monitor_process(state.clone()));
    tokio::spawn(broadcast_metrics(state.clone()));
    tokio::spawn(probe_game_metrics(state.clone()));
    let mut app = Router::new()
        .route("/api/health", get(health))
        .route("/api/events", get(websocket))
        .route("/api/invoke/{command}", post(rpc))
        .fallback_service(ServeDir::new(web_root).append_index_html_on_directories(true))
        .with_state(state);
    if allow_remote_web {
        app = app.layer(CorsLayer::new().allow_methods([Method::GET, Method::POST]).allow_origin(tower_http::cors::Any).allow_headers(tower_http::cors::Any));
    }
    let listener = tokio::net::TcpListener::bind(&bind).await.expect("无法监听地址");
    println!("Astrore Agent: http://{bind}");
    axum::serve(listener, app).await.expect("Agent 服务异常退出");
}
