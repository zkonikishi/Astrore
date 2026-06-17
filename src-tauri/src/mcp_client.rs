use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Write,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
fn hide_subprocess_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_subprocess_window(_: &mut Command) {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub icon: String,
    #[serde(default = "default_runtime")]
    pub runtime: String,
    #[serde(default)]
    pub homepage: String,
    #[serde(default)]
    pub entry: Option<ExtensionEntry>,
    #[serde(default)]
    pub permissions: Vec<String>,
}

fn default_runtime() -> String {
    "external-mcp".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionEntry {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub icon: String,
    pub runtime: String,
    pub homepage: String,
    pub permissions: Vec<String>,
    pub high_risk: bool,
    pub enabled: bool,
    pub running: bool,
    pub tools: Vec<McpTool>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: String,
    #[allow(dead_code)]
    id: u64,
    #[serde(default)]
    result: serde_json::Value,
    #[serde(default)]
    error: Option<JsonRpcError>,
}

#[derive(Deserialize)]
struct JsonRpcError {
    #[allow(dead_code)]
    code: i64,
    message: String,
}

pub struct McpClient {
    manifest: ExtensionManifest,
    working_dir: PathBuf,
    process: Option<Child>,
    request_id: u64,
}

impl McpClient {
    pub fn new(manifest: ExtensionManifest, working_dir: PathBuf) -> Self {
        Self { manifest, working_dir, process: None, request_id: 0 }
    }

    pub fn manifest(&self) -> &ExtensionManifest {
        &self.manifest
    }

    pub fn is_running(&self) -> bool {
        self.process.is_some()
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.process.is_some() {
            return Ok(());
        }
        let entry = self.manifest.entry.as_ref().ok_or("外部 MCP 扩展缺少启动入口")?;
        let mut cmd = Command::new(&entry.command);
        hide_subprocess_window(&mut cmd);
        cmd.args(&entry.args);
        cmd.current_dir(&self.working_dir);
        cmd.env_clear();
        for key in ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "PATHEXT", "HOME", "USERPROFILE", "TMP", "TEMP", "LANG"] {
            if let Some(value) = std::env::var_os(key) {
                cmd.env(key, value);
            }
        }
        for (k, v) in &entry.env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::inherit());

        let child = cmd.spawn().map_err(|e| format!("启动扩展 {} 失败: {e}", self.manifest.name))?;
        self.process = Some(child);
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(mut child) = self.process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn send_request_sync(&mut self, method: &str, params: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        let child = self.process.as_mut().ok_or("扩展未运行")?;
        self.request_id += 1;
        let request = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: self.request_id,
            method: method.into(),
            params,
        };
        let mut stdin = child.stdin.as_mut().ok_or("无法写入扩展 stdin")?;
        let line = serde_json::to_string(&request).map_err(|e| format!("序列化请求失败: {e}"))?;
        writeln!(stdin, "{line}").map_err(|e| format!("写入请求失败: {e}"))?;
        stdin.flush().map_err(|e| format!("刷新 stdin 失败: {e}"))?;

        let stdout = child.stdout.as_mut().ok_or("无法读取扩展 stdout")?;
        let mut reader = std::io::BufReader::new(stdout);
        let mut response_line = String::new();
        use std::io::BufRead;
        reader.read_line(&mut response_line).map_err(|e| format!("读取响应失败: {e}"))?;

        let response: JsonRpcResponse = serde_json::from_str(&response_line).map_err(|e| format!("解析响应失败: {e}"))?;
        if let Some(err) = response.error {
            return Err(format!("扩展返回错误: {}", err.message));
        }
        Ok(response.result)
    }

    pub fn list_tools_sync(&mut self) -> Result<Vec<McpTool>, String> {
        let result = self.send_request_sync("tools/list", None)?;
        let tools: Vec<McpTool> = serde_json::from_value(result["tools"].clone()).unwrap_or_default();
        Ok(tools)
    }

    pub fn call_tool_sync(&mut self, tool_name: &str, arguments: serde_json::Value) -> Result<serde_json::Value, String> {
        let params = serde_json::json!({ "name": tool_name, "arguments": arguments });
        self.send_request_sync("tools/call", Some(params))
    }
}

pub struct ExtensionManager {
    extensions: HashMap<String, Arc<Mutex<McpClient>>>,
    extensions_dir: PathBuf,
}

impl ExtensionManager {
    pub fn new(extensions_dir: PathBuf) -> Self {
        Self { extensions: HashMap::new(), extensions_dir }
    }

    pub fn extensions_dir(&self) -> &PathBuf {
        &self.extensions_dir
    }

    pub fn load_manifest(&self, extension_id: &str) -> Result<ExtensionManifest, String> {
        if !is_safe_extension_id(extension_id) {
            return Err("Invalid extension ID".into());
        }
        let manifest_path = self.extensions_dir.join(extension_id).join("manifest.json");
        let content = std::fs::read_to_string(&manifest_path)
            .map_err(|e| format!("读取扩展清单失败: {e}"))?;
        let manifest: ExtensionManifest =
            serde_json::from_str(&content).map_err(|e| format!("解析扩展清单失败: {e}"))?;
        if manifest.id != extension_id {
            return Err("Extension manifest ID must match its directory name".into());
        }
        validate_manifest(&manifest)?;
        Ok(manifest)
    }

    pub fn scan_extensions(&self) -> Vec<ExtensionManifest> {
        let mut manifests = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&self.extensions_dir) {
            for entry in entries.flatten() {
                let manifest_path = entry.path().join("manifest.json");
                if let Ok(content) = std::fs::read_to_string(&manifest_path) {
                    if let Ok(manifest) = serde_json::from_str::<ExtensionManifest>(&content) {
                        let directory_id = entry.file_name().to_string_lossy().into_owned();
                        if is_safe_extension_id(&manifest.id)
                            && manifest.id == directory_id
                            && validate_manifest(&manifest).is_ok()
                        {
                            manifests.push(manifest);
                        }
                    }
                }
            }
        }
        manifests
    }

    pub fn get_extension(&self, id: &str) -> Option<Arc<Mutex<McpClient>>> {
        self.extensions.get(id).cloned()
    }

    pub fn remove_extension(&mut self, id: &str) {
        self.stop_extension(id);
        self.extensions.remove(id);
    }

    pub fn register(&mut self, manifest: ExtensionManifest) -> Arc<Mutex<McpClient>> {
        let working_dir = self.extensions_dir.join(&manifest.id);
        let client = Arc::new(Mutex::new(McpClient::new(manifest, working_dir)));
        self.extensions.insert(client.lock().unwrap().manifest().id.clone(), client.clone());
        client
    }

    pub fn start_extension(&mut self, id: &str, approved_permissions: &[String]) -> Result<Vec<McpTool>, String> {
        let client = self.extensions.get(id).ok_or("扩展未注册")?;
        let mut client = client.lock().map_err(|_| "扩展锁已损坏")?;
        let manifest = client.manifest();
        if manifest.runtime != "external-mcp" {
            return Err("此版本尚未启用 WASM 扩展运行器".into());
        }
        if manifest.permissions.iter().any(|permission| !approved_permissions.contains(permission)) {
            return Err("扩展权限尚未全部获得用户确认".into());
        }
        client.start()?;
        let initialized = client.send_request_sync("initialize", Some(serde_json::json!({
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": { "name": "Astrore", "version": "0.2.0" }
        })));
        if let Err(error) = initialized {
            client.stop();
            return Err(error);
        }
        match client.list_tools_sync() {
            Ok(tools) => Ok(tools),
            Err(error) => {
                client.stop();
                Err(error)
            }
        }
    }

    pub fn stop_extension(&mut self, id: &str) {
        if let Some(client) = self.extensions.get(id) {
            if let Ok(mut client) = client.lock() {
                client.stop();
            }
        }
    }

    pub fn call_tool(&mut self, extension_id: &str, tool_name: &str, arguments: serde_json::Value) -> Result<serde_json::Value, String> {
        let client = self.extensions.get(extension_id).ok_or("扩展未注册")?;
        let mut client = client.lock().map_err(|_| "扩展锁已损坏")?;
        client.call_tool_sync(tool_name, arguments)
    }

    pub fn extension_info(&self, id: &str, enabled_ids: &[String]) -> Option<ExtensionInfo> {
        let client = self.extensions.get(id)?;
        let mut client = client.lock().ok()?;
        let manifest = client.manifest().clone();
        let running = client.is_running();
        let tools = if running { client.list_tools_sync().unwrap_or_default() } else { Vec::new() };
        Some(ExtensionInfo {
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            description: manifest.description.clone(),
            author: manifest.author.clone(),
            icon: manifest.icon.clone(),
            runtime: manifest.runtime.clone(),
            homepage: manifest.homepage.clone(),
            permissions: manifest.permissions.clone(),
            high_risk: manifest.runtime == "external-mcp",
            enabled: enabled_ids.contains(&manifest.id),
            running,
            tools,
            error: None,
        })
    }
}

pub fn is_safe_extension_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_manifest(manifest: &ExtensionManifest) -> Result<(), String> {
    if !is_safe_extension_id(&manifest.id) {
        return Err("Invalid extension ID".into());
    }
    if !matches!(manifest.runtime.as_str(), "external-mcp" | "wasi") {
        return Err("Unsupported extension runtime".into());
    }
    if manifest.permissions.len() > 32
        || manifest
            .permissions
            .iter()
            .any(|permission| permission.len() > 80 || !is_safe_permission(permission))
    {
        return Err("Invalid extension permissions".into());
    }
    if manifest.runtime == "external-mcp"
        && manifest.entry.as_ref().map_or(true, |entry| entry.command.trim().is_empty())
    {
        return Err("External MCP extension is missing its command".into());
    }
    Ok(())
}

fn is_safe_permission(permission: &str) -> bool {
    !permission.is_empty()
        && permission
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b':' | b'-' | b'_' | b'*'))
}
