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

export type PickedServerCore = {
  instancePath: string;
  serverJar: string;
  instanceName: string;
};

export type ManagedServerState = {
  instancePath: string;
  cores: string[];
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
  | { type: "metrics"; payload: ServerMetrics }
  | { type: "download-progress"; payload: DownloadProgress };
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

const FALLBACK_SERVER_CORES: CoreInfo[] = [
  { name: "Paper", tag: "pure", recommend: true, mcVersions: ["26.2", "1.21.8", "1.21.7", "1.21.6", "1.21.5", "1.21.4", "1.20.6", "1.20.4", "1.20.1", "1.19.4"] },
  { name: "Folia", tag: "pure", recommend: false, mcVersions: ["26.1.2", "1.21.8", "1.21.6", "1.21.5", "1.21.4", "1.20.6", "1.20.4", "1.20.2", "1.20.1", "1.19.4"] },
  { name: "Purpur", tag: "pure", recommend: false, mcVersions: ["26.1.2", "1.21.8", "1.21.7", "1.21.6", "1.21.5", "1.21.4", "1.20.6", "1.20.4", "1.20.1", "1.19.4"] },
  { name: "Vanilla", tag: "vanilla", recommend: false, mcVersions: ["26.2", "1.21.8", "1.21.7", "1.21.6", "1.21.5", "1.21.4", "1.20.6", "1.20.4", "1.20.1", "1.19.4"] },
  { name: "Fabric", tag: "mod", recommend: false, mcVersions: ["26.2", "1.21.8", "1.21.7", "1.21.6", "1.21.5", "1.21.4", "1.20.6", "1.20.4", "1.20.1", "1.19.4"] },
  { name: "Forge", tag: "mod", recommend: false, mcVersions: ["26.1.2", "1.21.8", "1.21.7", "1.21.6", "1.21.5", "1.21.4", "1.20.6", "1.20.4", "1.20.1", "1.19.4"] },
  { name: "Velocity", tag: "proxy", recommend: false, mcVersions: ["3.5.0", "3.4.0", "3.3.0", "3.2.0", "3.1.2"] },
  { name: "BungeeCord", tag: "proxy", recommend: false, mcVersions: ["general"] },
];

const coreCategory = (name: string, tag = "") => {
  const lower = name.toLowerCase();
  if (["paper", "folia", "purpur", "leaves"].includes(lower)) return "plugin";
  if (["fabric", "forge", "neoforge", "spongeforge", "spongeneo"].includes(lower)) return "mod";
  if (["arclight", "catserver"].includes(lower)) return "hybrid";
  if (lower === "vanilla") return "vanilla";
  if (["velocity", "bungeecord", "waterfall"].includes(lower)) return "proxy";
  if (["nukkit", "pocketmine", "bedrock_vanilla"].includes(lower)) return "bedrock";
  if (tag === "pure") return "plugin";
  if (tag === "mod") return "mod";
  if (tag === "proxy") return "proxy";
  if (tag === "vanilla") return "vanilla";
  if (tag === "bedrock") return "bedrock";
  return "plugin";
};

const coreSortRank = (category: string) => ({ plugin: 1, mod: 2, hybrid: 3, vanilla: 4, proxy: 5, bedrock: 6 }[category] ?? 9);

export const isTauriRuntime = () =>
  typeof (window as typeof window & { __TAURI_INTERNALS__?: { invoke?: unknown } })
    .__TAURI_INTERNALS__?.invoke === "function";

const webApiBase = () => {
  const configured = localStorage.getItem("astrore.agentUrl")?.replace(/\/+$/, "");
  if (location.port === "1421") return `${location.origin}/api`;
  if (configured) return configured.endsWith("/api") ? configured : `${configured}/api`;
  return location.port === "1420" ? "http://127.0.0.1:1421/api" : `${location.origin}/api`;
};

const webApiBases = () => {
  const primary = webApiBase();
  const sameOrigin = `${location.origin}/api`;
  return primary === sameOrigin ? [primary] : [primary, sameOrigin];
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
  const timeoutMs = command.includes("download") || command === "import_server_core_file" ? 600000 : 15000;
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | null = null;
  let lastError: unknown = null;
  try {
    for (const base of webApiBases()) {
      try {
        response = await fetch(`${base}/invoke/${command}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(token ? { "X-Astrore-Token": token } : {}) },
          body: JSON.stringify(args),
          signal: controller.signal,
        });
        break;
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted) throw error;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Agent 连接超时，请检查地址或启动 Agent");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  if (!response) throw lastError instanceof Error ? lastError : new Error("Agent 连接失败");
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

export async function getManagedServerState(): Promise<ManagedServerState> {
  if (isTauriRuntime()) return invoke("get_managed_server_state");
  return webInvoke("get_managed_server_state");
}

const readFileAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",").pop() ?? "" : result);
    };
    reader.readAsDataURL(file);
  });

export async function pickServerCore(): Promise<PickedServerCore | null> {
  if (isTauriRuntime()) return invoke("pick_server_core");
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".jar,application/java-archive";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
  if (!file) return null;
  if (!file.name.toLowerCase().endsWith(".jar")) throw new Error("请选择 .jar 服务端核心文件");
  const contentBase64 = await readFileAsBase64(file);
  return webInvoke("import_server_core_file", { fileName: file.name, contentBase64 });
}

export async function readPlayerLists(instancePath: string): Promise<PlayerLists> {
  if (isTauriRuntime()) return invoke("read_player_lists", { instancePath });
  return webInvoke("read_player_lists", { instancePath });
}

export async function updatePlayer(instancePath: string, action: string, name: string, level?: number, reason?: string): Promise<void> {
  if (isTauriRuntime()) return invoke("update_player", { instancePath, action, name, level, reason });
  return webInvoke("update_player", { instancePath, action, name, level, reason });
}

async function listServerCores(): Promise<CoreInfo[]> {
  if (isTauriRuntime()) return invoke("list_server_cores");
  try {
    return await webInvoke("list_server_cores");
  } catch {
    return FALLBACK_SERVER_CORES;
  }
}

async function listCoreBuilds(coreName: string, mcVersion: string): Promise<BuildInfo[]> {
  if (isTauriRuntime()) return invoke("list_core_builds", { coreName, mcVersion });
  try {
    return await webInvoke("list_core_builds", { coreName, mcVersion });
  } catch {
    return [];
  }
}

async function downloadServerCore(instancePath: string, coreName: string, mcVersion: string, build: string): Promise<string> {
  const targetPath = (await getManagedServerState()).instancePath;
  if (isTauriRuntime()) return invoke("download_server_core", { instancePath: targetPath, coreName, mcVersion, build });
  return webInvoke("download_server_core", { instancePath: targetPath, coreName, mcVersion, build });
}

async function listOfficialCoreVersions(coreName: string): Promise<string[]> {
  if (isTauriRuntime()) return invoke("list_official_core_versions", { coreName });
  try {
    return await webInvoke("list_official_core_versions", { coreName });
  } catch {
    return [];
  }
}

async function listOfficialCoreBuilds(coreName: string, mcVersion: string): Promise<BuildInfo[]> {
  if (isTauriRuntime()) return invoke("list_official_core_builds", { coreName, mcVersion });
  try {
    return await webInvoke("list_official_core_builds", { coreName, mcVersion });
  } catch {
    return [];
  }
}

async function downloadOfficialServerCore(instancePath: string, coreName: string, mcVersion: string, build: string): Promise<string> {
  const targetPath = (await getManagedServerState()).instancePath;
  if (isTauriRuntime()) return invoke("download_official_server_core", { instancePath: targetPath, coreName, mcVersion, build });
  return webInvoke("download_official_server_core", { instancePath: targetPath, coreName, mcVersion, build });
}

export async function listUnifiedCoreVersions(coreName: string): Promise<string[]> {
  if (isTauriRuntime()) return invoke("list_unified_core_versions", { coreName });
  const cores = await listServerCores();
  const core = cores.find(c => c.name.toLowerCase() === coreName.toLowerCase());
  if (core) return core.mcVersions;
  return listOfficialCoreVersions(coreName);
}

export async function listUnifiedCoreBuilds(coreName: string, mcVersion: string): Promise<BuildInfo[]> {
  if (isTauriRuntime()) return invoke("list_unified_core_builds", { coreName, mcVersion });
  const builds = await listCoreBuilds(coreName, mcVersion);
  if (builds.length > 0) return builds;
  return listOfficialCoreBuilds(coreName, mcVersion);
}

export async function downloadUnifiedServerCore(instancePath: string, coreName: string, mcVersion: string, build: string): Promise<string> {
  if (isTauriRuntime()) return invoke("download_unified_server_core", { instancePath, coreName, mcVersion, build });
  try { return await downloadServerCore(instancePath, coreName, mcVersion, build); } catch { /* fall through */ }
  return downloadOfficialServerCore(instancePath, coreName, mcVersion, build);
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

export async function searchHangar(query: string): Promise<PluginInfo[]> {
  if (isTauriRuntime()) return invoke("search_hangar", { query });
  return webInvoke("search_hangar", { query });
}

export async function getHangarVersions(projectId: string): Promise<PluginVersion[]> {
  if (isTauriRuntime()) return invoke("get_hangar_versions", { projectId });
  return webInvoke("get_hangar_versions", { projectId });
}

export async function searchCurseForge(query: string, kind: string, apiKey: string): Promise<PluginInfo[]> {
  if (isTauriRuntime()) return invoke("search_curseforge", { query, kind, apiKey });
  return webInvoke("search_curseforge", { query, kind, apiKey });
}

export async function getCurseForgeFiles(modId: string, apiKey: string): Promise<PluginVersion[]> {
  if (isTauriRuntime()) return invoke("get_curseforge_files", { modId, apiKey });
  return webInvoke("get_curseforge_files", { modId, apiKey });
}

export async function getCurseForgeApiKey(): Promise<string> {
  if (isTauriRuntime()) return invoke("get_curseforge_api_key");
  return localStorage.getItem("astrore.curseforge.apiKey") ?? "";
}

export async function saveCurseForgeApiKey(apiKey: string): Promise<void> {
  if (isTauriRuntime()) return invoke("save_curseforge_api_key", { apiKey });
  if (apiKey.trim()) localStorage.setItem("astrore.curseforge.apiKey", apiKey.trim());
  else localStorage.removeItem("astrore.curseforge.apiKey");
}


export async function getCoreTypes(): Promise<CoreTypeInfo[]> {
  if (isTauriRuntime()) return invoke("get_core_types");
  const cores = await listServerCores();
  return cores.map(core => {
    const label = core.name === "Paper" && core.recommend ? "Paper ⭐ (推荐)"
      : core.name === "Arclight" && core.recommend ? "Arclight ⭐ (混合)"
      : core.name === "Folia" ? "Folia ⚡ (多线程)"
      : core.name === "Fabric" ? "Fabric (模组)"
      : core.name === "Forge" ? "Forge (模组)"
      : core.name === "Arclight" ? "Arclight (混合)"
      : core.name === "CatServer" ? "CatServer (混合)"
      : core.name === "SpongeForge" ? "SpongeForge (模组)"
      : core.name === "SpongeNeo" ? "SpongeNeo (模组)"
      : core.name === "Vanilla" ? "Vanilla (原版)"
      : core.name === "BungeeCord" ? "BungeeCord (代理)"
      : core.name === "Nukkit" ? "Nukkit (基岩版)"
      : core.name === "PocketMine" ? "PocketMine (基岩版)"
      : core.name;
    const category = coreCategory(core.name, core.tag);
    return { name: core.name.toLowerCase(), label, category, recommend: core.recommend };
  }).sort((a, b) => coreSortRank(a.category) - coreSortRank(b.category) || Number(b.recommend) - Number(a.recommend) || a.label.localeCompare(b.label));
}

export async function listJavaReleases(vendor?: string, javaVersion?: number): Promise<JavaRelease[]> {
  if (isTauriRuntime()) return invoke("list_java_releases", { vendor: vendor || null, javaVersion: javaVersion ?? null });
  return webInvoke("list_java_releases", { vendor: vendor || null, javaVersion: javaVersion ?? null });
}

export async function downloadJava(downloadUrl: string, fileName: string): Promise<string> {
  if (isTauriRuntime()) return invoke("download_java", { downloadUrl, fileName });
  return webInvoke("download_java", { downloadUrl, fileName });
}


export async function searchSpiget(query: string): Promise<SpigetResource[]> {
  if (isTauriRuntime()) return invoke("search_spiget", { query });
  return webInvoke("search_spiget", { query });
}

export async function searchSpigetAsPlugin(query: string): Promise<PluginInfo[]> {
  const resources = await searchSpiget(query);
  return resources.map(r => ({
    name: r.name,
    title: r.name,
    description: r.description || "",
    iconUrl: r.iconUrl || "",
    downloads: r.downloads,
    categories: [r.tag],
    projectId: String(r.id),
  }));
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
  return webInvoke("init_extension_manager");
}

export async function scanExtensions(): Promise<McpExtensionInfo[]> {
  if (isTauriRuntime()) return invoke("scan_extensions");
  try { return await webInvoke("scan_extensions"); } catch { return []; }
}

export async function startExtension(extensionId: string, approvedPermissions: string[]): Promise<McpTool[]> {
  if (isTauriRuntime()) return invoke("start_extension", { extensionId, approvedPermissions });
  try { return await webInvoke("start_extension", { extensionId, approvedPermissions }); } catch { return []; }
}

export async function stopExtension(extensionId: string): Promise<void> {
  if (isTauriRuntime()) return invoke("stop_extension", { extensionId });
  return webInvoke("stop_extension", { extensionId });
}

export async function callExtensionTool(extensionId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  if (isTauriRuntime()) return invoke("call_extension_tool", { extensionId, toolName, arguments: args });
  try { return await webInvoke("call_extension_tool", { extensionId, toolName, arguments: args }); } catch { return null; }
}

export async function uninstallExtension(extensionId: string): Promise<void> {
  if (isTauriRuntime()) return invoke("uninstall_extension", { extensionId });
  return webInvoke("uninstall_extension", { extensionId });
}

export async function fetchExtensionRegistry(registryUrl: string): Promise<RegistryExtension[]> {
  if (isTauriRuntime()) return invoke("fetch_extension_registry", { registryUrl });
  const response = await fetch(registryUrl);
  if (!response.ok) throw new Error(`扩展注册表请求失败：${response.status}`);
  return (await response.json()).extensions ?? [];
}

export async function installRegistryExtension(extension: RegistryExtension): Promise<void> {
  if (isTauriRuntime()) return invoke("install_registry_extension", { extension });
  return webInvoke("install_registry_extension", { extension });
}
