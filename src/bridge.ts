import { invoke } from "@tauri-apps/api/core";

export type PlatformCapabilities = {
  platform: string;
  localServerManagement: boolean;
  remoteControl: boolean;
};

export type AgentConnection = {
  status: "connecting" | "online" | "offline" | "unauthorized" | "local";
  message: string;
  capabilities: PlatformCapabilities;
};

export type EulaState = {
  accepted: boolean;
  path: string;
};

export type InstanceConfig = {
  name: string;
  instancePath: string;
  javaPath: string;
  serverJar: string;
  minMemoryMb: number;
  maxMemoryMb: number;
  javaArgs: string[];
  serverArgs: string[];
};

export type ServerStatus = {
  running: boolean;
  pid: number | null;
  instanceName: string | null;
};

export type FileEntry = {
  name: string;
  relativePath: string;
  isDir: boolean;
  size: number;
  modified: number;
  enabled: boolean;
};

export type PlayerEntry = { name?: string; uuid?: string; level?: number; reason?: string; ip?: string };
export type PlayerLists = {
  ops: PlayerEntry[];
  whitelist: PlayerEntry[];
  bannedPlayers: PlayerEntry[];
  bannedIps: PlayerEntry[];
};
export type CoreInfo = { name: string; tag: string; recommend: boolean; mcVersions: string[] };
export type BuildInfo = { coreVersion: string; updateTime: string };
export type DownloadProgress = { fileName: string; downloaded: number; total: number; percent: number; status: string; speedMbps?: number; startedAt?: number };

export type McpTool = { name: string; description: string; inputSchema?: Record<string, unknown> };
export type McpExtensionInfo = {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  runtime: "wasi" | "external-mcp";
  homepage: string;
  permissions: string[];
  highRisk: boolean;
  enabled: boolean;
  running: boolean;
  tools: McpTool[];
  error?: string;
};
export type RegistryExtension = {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  runtime: "wasi" | "external-mcp";
  downloadUrl: string;
  sha256: string;
  size: number;
  homepage: string;
  permissions: string[];
  verified: boolean;
};

export type ServerMetrics = {
  cpuPercent: number;
  memoryMb: number;
  memoryMaxMb: number;
  tps: number;
  mspt: number;
  onlinePlayers: number;
  maxPlayers: number;
  playerList: string[];
  uptimeSecs: number;
  chunkCount: number;
  entityCount: number;
  diskFreeGb: number;
};

export type AutoRestartConfig = {
  enabled: boolean;
  maxRestarts: number;
  restartDelaySecs: number;
};

export type PluginInfo = {
  name: string;
  title: string;
  description: string;
  iconUrl: string;
  downloads: number;
  categories: string[];
  projectId: string;
};

export type PluginVersion = {
  name: string;
  versionNumber: string;
  downloadUrl: string;
  fileName: string;
  gameVersions: string[];
  loaders: string[];
};
export type BackupInfo = { name: string; size: number; modified: number };
export type AgentEvent =
  | { type: "console"; payload: string }
  | { type: "console-history"; payload: string[] }
  | { type: "status"; payload: ServerStatus }
  | { type: "metrics"; payload: ServerMetrics };
export type AiMessage = { role: "system" | "user" | "assistant"; content: string };
export type AiRequest = { endpoint: string; apiKey: string; model: string; temperature?: number; maxTokens?: number; messages: AiMessage[] };


export type JavaRelease = {
  version: string;
  major: number;
  downloadUrl: string;
  fileName: string;
  sizeMb: number;
};

export type SpigetResource = {
  id: number;
  name: string;
  tag: string;
  description: string;
  iconUrl: string;
  downloads: number;
  rating: number;
  author: string;
  version: string;
};

export type CoreTypeInfo = {
  name: string;
  label: string;
  category: string;
  recommend: boolean;
};

export const isTauriRuntime = () =>
  typeof (window as typeof window & { __TAURI_INTERNALS__?: { invoke?: unknown } })
    .__TAURI_INTERNALS__?.invoke === "function";

const webApiBase = () => {
  const configured = localStorage.getItem("astrore.agentUrl")?.replace(/\/+$/, "");
  if (configured) return configured.endsWith("/api") ? configured : `${configured}/api`;
  return location.port === "1420" ? "http://127.0.0.1:1421/api" : `${location.origin}/api`;
};

export function connectAgentEvents(onEvent: (event: AgentEvent) => void, onState: (connected: boolean) => void): () => void {
  if (isTauriRuntime()) return () => undefined;
  const url = new URL(`${webApiBase()}/events`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const token = localStorage.getItem("astrore.agentToken") ?? "";
  const protocols = token ? ["astrore", `astrore-token.${token}`] : ["astrore"];
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let disposed = false;

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== null) return;
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (disposed) return;
    try {
      socket = new WebSocket(url, protocols);
      socket.onopen = () => {
        reconnectAttempt = 0;
        onState(true);
      };
      socket.onmessage = message => {
        try { onEvent(JSON.parse(message.data) as AgentEvent); } catch { /* Ignore malformed Agent events. */ }
      };
      socket.onerror = () => onState(false);
      socket.onclose = () => {
        socket = null;
        onState(false);
        scheduleReconnect();
      };
    } catch {
      socket = null;
      onState(false);
      scheduleReconnect();
    }
  };

  connect();
  return () => {
    disposed = true;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    socket?.close();
  };
}

async function webInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const token = localStorage.getItem("astrore.agentToken") ?? "";
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2000);
  let response: Response;
  try {
    response = await fetch(`${webApiBase()}/invoke/${command}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { "X-Astrore-Token": token } : {}) },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Agent 连接超时，请检查地址或启动 Agent");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Agent 请求失败 (${response.status})`);
  return result as T;
}

export async function checkAgentConnection(): Promise<AgentConnection> {
  if (isTauriRuntime()) {
    const capabilities = await getCapabilities();
    return { status: "local", message: "桌面端本地控制可用", capabilities };
  }
  try {
    const capabilities = await webInvoke<PlatformCapabilities>("platform_capabilities");
    return { status: "online", message: "Agent 已连接", capabilities };
  } catch (error) {
    const message = String(error);
    const unauthorized = message.includes("401") || message.includes("令牌");
    return {
      status: unauthorized ? "unauthorized" : "offline",
      message: unauthorized ? "Agent 令牌无效" : "Agent 未连接",
      capabilities: { platform: "web", localServerManagement: false, remoteControl: false },
    };
  }
}

export async function getCapabilities(): Promise<PlatformCapabilities> {
  if (isTauriRuntime()) return invoke("platform_capabilities");
  try { return await webInvoke("platform_capabilities"); } catch {
    return { platform: /Android|iPhone|iPad/i.test(navigator.userAgent) ? "mobile-web" : "web", localServerManagement: false, remoteControl: false };
  }
}

export async function checkEula(instancePath: string): Promise<EulaState> {
  if (isTauriRuntime()) return invoke("check_eula", { instancePath });
  return webInvoke("check_eula", { instancePath });
}

export async function acceptEula(instancePath: string): Promise<EulaState> {
  if (isTauriRuntime()) return invoke("accept_eula", { instancePath });
  return webInvoke("accept_eula", { instancePath });
}

export async function getServerStatus(): Promise<ServerStatus> {
  if (isTauriRuntime()) return invoke("server_status");
  try { return await webInvoke("server_status"); } catch { return { running: false, pid: null, instanceName: null }; }
}

export async function startServer(config: InstanceConfig): Promise<ServerStatus> {
  if (isTauriRuntime()) return invoke("start_server", { config });
  return webInvoke("start_server", { config });
}

export async function stopServer(): Promise<void> {
  if (isTauriRuntime()) return invoke("stop_server");
  return webInvoke("stop_server");
}

export async function forceStopServer(): Promise<void> {
  if (isTauriRuntime()) return invoke("force_stop_server");
  return webInvoke("force_stop_server");
}

export async function sendServerCommand(command: string): Promise<void> {
  if (isTauriRuntime()) return invoke("send_server_command", { command });
  return webInvoke("send_server_command", { command });
}

export async function listDirectory(instancePath: string, relativePath = ""): Promise<FileEntry[]> {
  if (isTauriRuntime()) return invoke("list_directory", { instancePath, relativePath });
  return webInvoke("list_directory", { instancePath, relativePath });
}

export async function readTextFile(instancePath: string, relativePath: string): Promise<string> {
  if (isTauriRuntime()) return invoke("read_text_file", { instancePath, relativePath });
  return webInvoke("read_text_file", { instancePath, relativePath });
}

export async function writeTextFile(instancePath: string, relativePath: string, content: string): Promise<void> {
  if (isTauriRuntime()) return invoke("write_text_file", { instancePath, relativePath, content });
  return webInvoke("write_text_file", { instancePath, relativePath, content });
}

export async function renameEntry(instancePath: string, relativePath: string, newName: string): Promise<void> {
  if (isTauriRuntime()) return invoke("rename_entry", { instancePath, relativePath, newName });
  return webInvoke("rename_entry", { instancePath, relativePath, newName });
}

export async function deleteEntry(instancePath: string, relativePath: string): Promise<void> {
  if (isTauriRuntime()) return invoke("delete_entry", { instancePath, relativePath });
  return webInvoke("delete_entry", { instancePath, relativePath });
}

export async function toggleEntry(instancePath: string, relativePath: string): Promise<void> {
  if (isTauriRuntime()) return invoke("toggle_entry", { instancePath, relativePath });
  return webInvoke("toggle_entry", { instancePath, relativePath });
}

export async function readProperties(instancePath: string): Promise<Record<string, string>> {
  if (isTauriRuntime()) return invoke("read_properties", { instancePath });
  return webInvoke("read_properties", { instancePath });
}

export async function writeProperties(instancePath: string, properties: Record<string, string>): Promise<void> {
  if (isTauriRuntime()) return invoke("write_properties", { instancePath, properties });
  return webInvoke("write_properties", { instancePath, properties });
}

export async function readPlayerLists(instancePath: string): Promise<PlayerLists> {
  if (isTauriRuntime()) return invoke("read_player_lists", { instancePath });
  return webInvoke("read_player_lists", { instancePath });
}

export async function updatePlayer(instancePath: string, action: string, name: string, level?: number, reason?: string): Promise<void> {
  if (isTauriRuntime()) return invoke("update_player", { instancePath, action, name, level, reason });
  return webInvoke("update_player", { instancePath, action, name, level, reason });
}

export async function listServerCores(): Promise<CoreInfo[]> {
  if (isTauriRuntime()) return invoke("list_server_cores");
  return webInvoke("list_server_cores");
}

export async function listCoreBuilds(coreName: string, mcVersion: string): Promise<BuildInfo[]> {
  if (isTauriRuntime()) return invoke("list_core_builds", { coreName, mcVersion });
  return webInvoke("list_core_builds", { coreName, mcVersion });
}

export async function downloadServerCore(instancePath: string, coreName: string, mcVersion: string, build: string): Promise<string> {
  if (isTauriRuntime()) return invoke("download_server_core", { instancePath, coreName, mcVersion, build });
  return webInvoke("download_server_core", { instancePath, coreName, mcVersion, build });
}

export async function getMetrics(): Promise<ServerMetrics> {
  if (isTauriRuntime()) return invoke("get_metrics");
  return webInvoke("get_metrics");
}

export async function getAutoRestartConfig(): Promise<AutoRestartConfig> {
  if (isTauriRuntime()) return invoke("get_auto_restart_config");
  return webInvoke("get_auto_restart_config");
}

export async function setAutoRestartConfig(config: AutoRestartConfig): Promise<void> {
  if (isTauriRuntime()) return invoke("set_auto_restart_config", { config });
  return webInvoke("set_auto_restart_config", { config });
}

export async function getConsole(): Promise<string[]> {
  if (isTauriRuntime()) return [];
  return webInvoke("get_console");
}

export async function aiChat(request: AiRequest): Promise<string> {
  if (isTauriRuntime()) return invoke("ai_chat", { request });
  return webInvoke("ai_chat", { request });
}

export async function searchModrinth(query: string, kind: string): Promise<PluginInfo[]> {
  if (isTauriRuntime()) return invoke("search_modrinth", { query, kind });
  return webInvoke("search_modrinth", { query, kind });
}

export async function getModrinthVersions(projectId: string): Promise<PluginVersion[]> {
  if (isTauriRuntime()) return invoke("get_modrinth_versions", { projectId });
  return webInvoke("get_modrinth_versions", { projectId });
}


export async function getCoreTypes(): Promise<CoreTypeInfo[]> {
  if (isTauriRuntime()) return invoke("get_core_types");
  return [];
}

export async function listJavaReleases(): Promise<JavaRelease[]> {
  if (isTauriRuntime()) return invoke("list_java_releases");
  return [];
}

export async function downloadJava(downloadUrl: string, fileName: string): Promise<string> {
  if (isTauriRuntime()) return invoke("download_java", { downloadUrl, fileName });
  return "";
}


export async function searchSpiget(query: string): Promise<SpigetResource[]> {
  if (isTauriRuntime()) return invoke("search_spiget", { query });
  return webInvoke("search_spiget", { query });
}

export async function cancelDownload(): Promise<void> {
  if (isTauriRuntime()) return invoke("cancel_download");
  return webInvoke("cancel_download");
}

export async function downloadSpigetPlugin(instancePath: string, resourceId: number, fileName: string): Promise<string> {
  if (isTauriRuntime()) return invoke("download_spiget_plugin", { instancePath, resourceId, fileName });
  return webInvoke("download_spiget_plugin", { instancePath, resourceId, fileName });
}

export async function downloadPlugin(instancePath: string, downloadUrl: string, fileName: string, kind: string): Promise<string> {
  if (isTauriRuntime()) return invoke("download_plugin", { instancePath, downloadUrl, fileName, kind });
  return webInvoke("download_plugin", { instancePath, downloadUrl, fileName, kind });
}

export async function listBackups(instancePath: string): Promise<BackupInfo[]> {
  if (isTauriRuntime()) return invoke("list_backups", { instancePath });
  return webInvoke("list_backups", { instancePath });
}

export async function createBackup(instancePath: string, label = ""): Promise<BackupInfo> {
  if (isTauriRuntime()) return invoke("create_backup", { instancePath, label });
  return webInvoke("create_backup", { instancePath, label });
}

export async function restoreBackup(instancePath: string, name: string): Promise<void> {
  if (isTauriRuntime()) return invoke("restore_backup", { instancePath, name });
  return webInvoke("restore_backup", { instancePath, name });
}

export async function deleteBackup(instancePath: string, name: string): Promise<void> {
  if (isTauriRuntime()) return invoke("delete_backup", { instancePath, name });
  return webInvoke("delete_backup", { instancePath, name });
}

export async function initExtensionManager(): Promise<void> {
  if (isTauriRuntime()) return invoke("init_extension_manager");
}

export async function scanExtensions(): Promise<McpExtensionInfo[]> {
  if (isTauriRuntime()) return invoke("scan_extensions");
  return [];
}

export async function startExtension(extensionId: string, approvedPermissions: string[]): Promise<McpTool[]> {
  if (isTauriRuntime()) return invoke("start_extension", { extensionId, approvedPermissions });
  return [];
}

export async function stopExtension(extensionId: string): Promise<void> {
  if (isTauriRuntime()) return invoke("stop_extension", { extensionId });
}

export async function callExtensionTool(extensionId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  if (isTauriRuntime()) return invoke("call_extension_tool", { extensionId, toolName, arguments: args });
  return null;
}

export async function uninstallExtension(extensionId: string): Promise<void> {
  if (isTauriRuntime()) return invoke("uninstall_extension", { extensionId });
  throw new Error("网页端暂不支持卸载本地扩展，请在桌面端操作");
}

export async function fetchExtensionRegistry(registryUrl: string): Promise<RegistryExtension[]> {
  if (isTauriRuntime()) return invoke("fetch_extension_registry", { registryUrl });
  const response = await fetch(registryUrl);
  if (!response.ok) throw new Error(`扩展注册表请求失败：${response.status}`);
  return (await response.json()).extensions ?? [];
}

export async function installRegistryExtension(extension: RegistryExtension): Promise<void> {
  if (isTauriRuntime()) return invoke("install_registry_extension", { extension });
  throw new Error("网页端不能安装本地扩展");
}
