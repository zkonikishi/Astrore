import { useCallback, useEffect, useMemo, useState, type SyntheticEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { Archive, ArrowLeft, Ban, Check, Download, FileCog, FileText, Folder, Pencil, Plus, RefreshCw, RotateCcw, Save, Search, Server, Shield, Star, Trash2, User, UserPlus, X, XCircle } from "lucide-react";
import {
  callExtensionTool,
  cancelDownload,
  createBackup,
  deleteBackup,
  deleteEntry,
  downloadJava,
  downloadPlugin,
  downloadUnifiedServerCore,
  fetchExtensionRegistry,
  getCoreTypes,
  getModrinthVersions,
  initExtensionManager,
  installRegistryExtension,
  isTauriRuntime,
  listJavaReleases,
  listDirectory,
  listUnifiedCoreVersions,
  listUnifiedCoreBuilds,
  listBackups,
  readPlayerLists,
  readProperties,
  readTextFile,
  renameEntry,
  restoreBackup,
  scanExtensions,
  searchHangar,
  searchModrinth,
  searchCurseForge,
  getHangarVersions,
  getCurseForgeFiles,
  searchSpigetAsPlugin,
  startExtension,
  stopExtension,
  toggleEntry,
  uninstallExtension,
  updatePlayer,
  writeProperties,
  writeTextFile,
  type FileEntry,
  type BuildInfo,
  type BackupInfo,
  type CoreTypeInfo,
  type DownloadProgress,
  type JavaRelease,
  type McpExtensionInfo,
  type McpTool,
  type PlayerLists,
  type PluginInfo,
  type PluginVersion,
  type RegistryExtension,
} from "./bridge";

type CommonProps = { instancePath: string; onError: (message: string) => void };

const OFFICIAL_EXTENSION_REGISTRY = "https://zkonikishi.github.io/Astrore-docs/registry/index.json";
const LEGACY_EXTENSION_REGISTRY = "https://raw.githubusercontent.com/zkonikishi/Astrore/main/registry/index.json";
const WEB_PREVIEW_EXTENSION_REGISTRY = "/registry/index.json";

const sizeLabel = (size: number) =>
  size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`;

const JAVA_VENDORS = [
  { id: "temurin", name: "Eclipse Temurin", note: "Adoptium LTS", icon: "https://adoptium.net/favicon.ico" },
  { id: "microsoft", name: "Microsoft OpenJDK", note: "Windows 友好", icon: "https://www.microsoft.com/favicon.ico" },
  { id: "zulu", name: "Azul Zulu", note: "OpenJDK builds", icon: "https://www.azul.com/favicon.ico" },
  { id: "graalvm", name: "GraalVM Community", note: "实验运行时", icon: "https://www.graalvm.org/favicon.ico" },
  { id: "oracle", name: "Oracle Java", note: "Oracle JDK", icon: "https://www.oracle.com/favicon.ico" },
] as const;

const CORE_ICONS: Record<string, string> = {
  paper: "https://papermc.io/favicon.ico",
  folia: "https://papermc.io/favicon.ico",
  velocity: "https://papermc.io/favicon.ico",
  purpur: "https://purpurmc.org/favicon.ico",
  fabric: "https://fabricmc.net/favicon.ico",
  forge: "https://files.minecraftforge.net/favicon.ico",
  vanilla: "https://www.minecraft.net/favicon.ico",
  nukkit: "https://cloudburstmc.org/favicon.ico",
  pocketmine: "https://pmmp.io/favicon.ico",
};

const coreIconUrl = (name: string) => {
  const key = name.toLowerCase();
  if (key.includes("paper") || key.includes("leaves")) return CORE_ICONS.paper;
  if (key.includes("folia")) return CORE_ICONS.folia;
  if (key.includes("velocity")) return CORE_ICONS.velocity;
  if (key.includes("purpur")) return CORE_ICONS.purpur;
  if (key.includes("fabric")) return CORE_ICONS.fabric;
  if (key.includes("forge") || key.includes("arclight") || key.includes("catserver")) return CORE_ICONS.forge;
  if (key.includes("vanilla")) return CORE_ICONS.vanilla;
  if (key.includes("pocketmine")) return CORE_ICONS.pocketmine;
  if (key.includes("nukkit")) return CORE_ICONS.nukkit;
  return "";
};

const coreBadge = (name: string) => {
  const key = name.toLowerCase();
  if (key === "folia") return "F";
  if (key === "velocity") return "V";
  return "";
};

const hideBrokenImage = (event: SyntheticEvent<HTMLImageElement>) => {
  event.currentTarget.style.display = "none";
};

const CORE_CATEGORY_ORDER = ["all", "plugin", "mod", "hybrid", "vanilla", "proxy", "bedrock"] as const;
const CORE_CATEGORY_LABELS: Record<string, string> = {
  all: "全部",
  plugin: "插件端",
  mod: "模组端",
  hybrid: "混合端",
  vanilla: "原版",
  proxy: "代理端",
  bedrock: "基岩版",
};

export function BackupView({ instancePath, onError }: CommonProps) {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState("");
  const load = useCallback(() => {
    if (!instancePath) return setBackups([]);
    listBackups(instancePath).then(setBackups).catch(error => onError(String(error)));
  }, [instancePath, onError]);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!instancePath) return onError("请先配置实例目录");
    const response = prompt("备份备注（可留空）", "");
    if (response === null) return;
    const label = response;
    setBusy("create");
    try {
      await createBackup(instancePath, label);
      load();
    } catch (error) { onError(String(error)); }
    setBusy("");
  };

  const restore = async (backup: BackupInfo) => {
    if (!confirm(`确定恢复 ${backup.name}？当前同名文件会被覆盖，恢复前请停止服务器。`)) return;
    setBusy(backup.name);
    try {
      await restoreBackup(instancePath, backup.name);
    } catch (error) { onError(String(error)); }
    setBusy("");
  };

  const remove = async (backup: BackupInfo) => {
    if (!confirm(`确定删除备份 ${backup.name}？`)) return;
    setBusy(backup.name);
    try {
      await deleteBackup(instancePath, backup.name);
      load();
    } catch (error) { onError(String(error)); }
    setBusy("");
  };

  return <section className="panel manager-panel">
    <div className="manager-toolbar">
      <Archive /><strong>实例备份</strong><span>{backups.length} 个备份</span>
      <button className="icon-btn" onClick={load} title="刷新"><RefreshCw /></button>
      <button className="primary" disabled={!instancePath || Boolean(busy)} onClick={create}><Plus />创建备份</button>
    </div>
    {!instancePath ? <Empty text="请先配置实例目录" /> : backups.length === 0 ? <Empty text="暂无备份，创建后将保存在实例目录的 .astrore-backups 中" /> :
      <div className="backup-list">{backups.map(backup => <div key={backup.name}>
        <div className="backup-mark"><Archive /></div>
        <div><strong>{backup.name}</strong><span>{sizeLabel(backup.size)} · {new Date(backup.modified * 1000).toLocaleString()}</span></div>
        <button className="secondary" disabled={Boolean(busy)} onClick={() => restore(backup)}><RotateCcw />恢复</button>
        <button className="icon-btn" disabled={Boolean(busy)} onClick={() => remove(backup)} title="删除备份"><Trash2 /></button>
      </div>)}</div>}
  </section>;
}

export function ExtensionStoreView({ onError }: { onError: (msg: string) => void }) {
  const [extensions, setExtensions] = useState<McpExtensionInfo[]>([]);
  const [catalog, setCatalog] = useState<RegistryExtension[]>([]);
  const [view, setView] = useState<"installed" | "catalog">("installed");
  const [registryUrl, setRegistryUrl] = useState(() => {
    const saved = localStorage.getItem("astrore.extensions.registry");
    return !saved || saved === LEGACY_EXTENSION_REGISTRY ? OFFICIAL_EXTENSION_REGISTRY : saved;
  });
  const [busy, setBusy] = useState("");
  const [catalogStatus, setCatalogStatus] = useState("等待检查更新");
  const [lastCatalogCheck, setLastCatalogCheck] = useState("");
  const [selectedTool, setSelectedTool] = useState<{ extensionId: string; tool: McpTool; author: string } | null>(null);
  const [toolArgs, setToolArgs] = useState("{}");
  const [toolResult, setToolResult] = useState("");

  const load = useCallback(() => {
    initExtensionManager().then(() => scanExtensions()).then(setExtensions).catch(e => onError(String(e)));
  }, [onError]);
  useEffect(() => { load(); }, [load]);

  const loadCatalog = useCallback(async () => {
    setBusy("registry");
    setCatalogStatus("正在检查更新...");
    const requestedUrl = registryUrl.trim() || OFFICIAL_EXTENSION_REGISTRY;
    const useOfficialFallbacks = requestedUrl === OFFICIAL_EXTENSION_REGISTRY || requestedUrl === LEGACY_EXTENSION_REGISTRY;
    const candidates = [
      { url: requestedUrl, label: "当前源" },
      ...(useOfficialFallbacks && !isTauriRuntime() ? [{ url: WEB_PREVIEW_EXTENSION_REGISTRY, label: "本地预览源" }] : []),
      ...(useOfficialFallbacks ? [{ url: LEGACY_EXTENSION_REGISTRY, label: "备用源" }] : []),
    ].filter((candidate, index, list) => list.findIndex(item => item.url === candidate.url) === index);
    let lastError: unknown = null;
    try {
      for (const candidate of candidates) {
        try {
          const entries = await fetchExtensionRegistry(candidate.url);
          setCatalog(entries);
          localStorage.setItem("astrore.extensions.registry", requestedUrl === LEGACY_EXTENSION_REGISTRY ? OFFICIAL_EXTENSION_REGISTRY : requestedUrl);
          setLastCatalogCheck(new Date().toLocaleString());
          setCatalogStatus(candidate.url === requestedUrl ? `已获取 ${entries.length} 个扩展` : `主站暂不可用，已从${candidate.label}获取 ${entries.length} 个扩展`);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    } catch (error) {
      setCatalogStatus("检查失败");
      onError(String(error));
    } finally {
      setBusy("");
    }
  }, [registryUrl, onError]);
  useEffect(() => { loadCatalog(); }, []);

  const toggle = async (ext: McpExtensionInfo) => {
    setBusy(ext.id);
    try {
      if (ext.running) {
        await stopExtension(ext.id);
      } else {
        const warning = ext.highRisk
          ? `“${ext.name}”是外部进程扩展，拥有当前用户权限，可能访问文件和网络。\n\n声明权限：${ext.permissions.join("、") || "无"}\n\n确认仍要启动？`
          : `启动“${ext.name}”？\n\n声明权限：${ext.permissions.join("、") || "无"}`;
        if (!confirm(warning)) {
          setBusy("");
          return;
        }
        await startExtension(ext.id, ext.permissions);
      }
      load();
    } catch (e) { onError(String(e)); }
    setBusy("");
  };

  const install = async (entry: RegistryExtension) => {
    const installed = extensions.find(extension => extension.id === entry.id);
    const action = installed ? `更新 ${installed.version} → ${entry.version}` : `安装 ${entry.version}`;
    const risk = entry.runtime === "external-mcp" ? "\n\n注意：外部进程扩展不受沙箱保护。" : "";
    if (!confirm(`${action}：${entry.name}\n\n权限：${entry.permissions.join("、") || "无"}${risk}`)) return;
    setBusy(entry.id);
    try {
      await installRegistryExtension(entry);
      load();
      setView("installed");
    } catch (error) { onError(String(error)); }
    setBusy("");
  };

  const isNewer = (candidate: string, current: string) => {
    const parts = (version: string) => version.replace(/^v/, "").split(".").map(part => Number.parseInt(part, 10) || 0);
    const a = parts(candidate);
    const b = parts(current);
    return [0, 1, 2].some(index => a[index] !== b[index] && a[index] > b[index] && a.slice(0, index).every((part, i) => part === b[i]));
  };
  const updateEntries = extensions
    .map(extension => catalog.find(entry => entry.id === extension.id && isNewer(entry.version, extension.version)))
    .filter((entry): entry is RegistryExtension => Boolean(entry));

  const callTool = async () => {
    if (!selectedTool) return;
    setBusy("tool");
    try {
      const args = JSON.parse(toolArgs);
      const result = await callExtensionTool(selectedTool.extensionId, selectedTool.tool.name, args);
      setToolResult(JSON.stringify(result, null, 2));
    } catch (e) { onError(String(e)); }
    setBusy("");
  };

  return <section className="panel manager-panel">
    <div className="manager-toolbar">
      <strong>扩展商店</strong>
      <div className="segmented"><button className={view === "installed" ? "active" : ""} onClick={() => setView("installed")}>已安装</button><button className={view === "catalog" ? "active" : ""} onClick={() => setView("catalog")}>在线商店</button></div>
      <span>{view === "installed" ? `${extensions.length} 个扩展${updateEntries.length ? ` · ${updateEntries.length} 个可更新` : ""}` : `${catalog.length} 个条目`}</span>
      <button className="icon-btn" onClick={() => { load(); loadCatalog(); }} title="刷新并检查更新"><RefreshCw /></button>
    </div>
    <div className="market-hero" style={{ minHeight: 80 }}>
      <strong>安全扩展平台</strong>
      <span>WASI 扩展将运行在沙箱中；外部 MCP 扩展拥有更高风险，启动前必须确认权限。</span>
    </div>
    {view === "catalog" ? <div className="extension-catalog">
      <div className="registry-bar"><Shield /><input value={registryUrl} onChange={event => setRegistryUrl(event.target.value)} placeholder="HTTPS 扩展注册表地址" /><button className="primary" disabled={busy === "registry"} onClick={loadCatalog}><RefreshCw />检查更新</button></div>
      <div className="registry-status"><span>{catalogStatus}</span>{lastCatalogCheck && <span>上次检查：{lastCatalogCheck}</span>}</div>
      <div className="extension-card-grid">{catalog.map(entry => {
        const installed = extensions.find(extension => extension.id === entry.id);
        const update = installed && isNewer(entry.version, installed.version);
        return <div key={entry.id}>
          <div className={`plugin-state ${entry.verified ? "enabled" : ""}`}>{entry.verified ? <Check /> : <Shield />}</div>
          <div><strong>{entry.name}</strong><span>{entry.description}</span><span className="ext-meta">{entry.verified ? "已验证" : "第三方"} · {entry.runtime === "wasi" ? "WASI 沙箱" : "外部 MCP"} · v{entry.version} · {sizeLabel(entry.size)}</span></div>
          <div className="extension-card-actions">
            <button className="primary" disabled={busy === entry.id || Boolean(installed && !update)} onClick={() => install(entry)}><Download />{update ? "更新" : installed ? "已安装" : "安装"}</button>
          </div>
        </div>;
      })}{catalog.length === 0 && <Empty text="填写 HTTPS 注册表地址后获取在线扩展" />}</div>
    </div> : selectedTool ? (
      <div>
        <div className="manager-toolbar">
          <button className="icon-btn" onClick={() => { setSelectedTool(null); setToolResult(""); }}><ArrowLeft /></button>
          <strong>{selectedTool.tool.name}</strong>
          <span className="ext-meta"><User size={12} /> {selectedTool.author}</span>
        </div>
        <div className="detail-panel">
          <div style={{ flex: 1 }}>
            <p>{selectedTool.tool.description}</p>
            <label>参数 (JSON)<textarea value={toolArgs} onChange={e => setToolArgs(e.target.value)} rows={4} style={{ width: "100%", fontFamily: "monospace", fontSize: 11 }} /></label>
            <button className="primary" onClick={callTool} disabled={busy === "tool"}>{busy === "tool" ? "调用中..." : "调用工具"}</button>
            {toolResult && <pre style={{ marginTop: 12, padding: 12, background: "#f0f4f1", borderRadius: 8, fontSize: 11, overflow: "auto", maxHeight: 200 }}>{toolResult}</pre>}
          </div>
        </div>
      </div>
    ) : (
      <div className="extension-installed">
        <div className="registry-status"><span>{catalogStatus}</span>{lastCatalogCheck && <span>上次检查：{lastCatalogCheck}</span>}{updateEntries.length > 0 && <button className="primary" onClick={() => setView("catalog")}>查看可更新</button>}</div>
        <div className="extension-card-grid">
        {extensions.map(ext => {
          const updateEntry = catalog.find(entry => entry.id === ext.id && isNewer(entry.version, ext.version));
          return <div key={ext.id}>
            <div className={`plugin-state ${ext.running ? "enabled" : ""}`}>{ext.running ? <Check /> : <X />}</div>
            <div><strong>{ext.name}</strong><span>{ext.description}</span><span className="ext-meta"><User size={12} /> {ext.author} · v{ext.version} · {ext.runtime === "wasi" ? "WASI 沙箱" : "外部 MCP 高风险"} · {ext.permissions.join("、") || "无权限"}</span></div>
            <div className="extension-card-actions">
              {updateEntry && <button className="primary" onClick={() => install(updateEntry)}><Download />更新</button>}
              <button className="secondary" onClick={() => toggle(ext)} disabled={busy === ext.id}>{busy === ext.id ? "..." : ext.running ? "停止" : "启动"}</button>
              <button className="icon-btn" onClick={() => { if (confirm(`确定卸载 ${ext.name}？`)) { uninstallExtension(ext.id).then(load).catch(e => onError(String(e))); } }} title="卸载"><Trash2 size={14} /></button>
            </div>
            {ext.tools.length > 0 && <div className="segmented" style={{ marginLeft: 8 }}>
              {ext.tools.map(t => (
                <button key={t.name} className="secondary" onClick={() => { setSelectedTool({ extensionId: ext.id, tool: t, author: ext.author }); setToolArgs("{}"); setToolResult(""); }} style={{ fontSize: 10 }}>{t.name}</button>
              ))}
            </div>}
          </div>;
        })}
        {extensions.length === 0 && <Empty text="暂无扩展，将扩展放入 extensions 目录后刷新" />}
        </div>
      </div>
    )}
  </section>;
}

export function FileManagerView({ instancePath, onError }: CommonProps) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [editing, setEditing] = useState<FileEntry | null>(null);
  const [content, setContent] = useState("");
  const load = useCallback(async (next = "") => {
    try {
      setEntries(await listDirectory(instancePath, next));
      setPath(next);
    } catch (error) { onError(String(error)); }
  }, [instancePath, onError]);
  useEffect(() => { if (instancePath) load(""); }, [instancePath, load]);
  const open = async (entry: FileEntry) => {
    if (entry.isDir) return load(entry.relativePath);
    try {
      setContent(await readTextFile(instancePath, entry.relativePath));
      setEditing(entry);
    } catch (error) { onError(String(error)); }
  };
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return <section className="panel manager-panel">
    <div className="manager-toolbar">
      <button className="icon-btn" disabled={!path} onClick={() => load(parent)} title="返回上级"><ArrowLeft /></button>
      <strong>/{path}</strong><span>{entries.length} 项</span>
      <button className="icon-btn" onClick={() => load()} title="刷新"><RefreshCw /></button>
    </div>
    {!instancePath ? <Empty text="请先在实例设置中填写服务端目录" /> :
      <div className="real-file-table">{entries.map(entry => <div key={entry.relativePath} onDoubleClick={() => open(entry)}>
        <span className="file-icon">{entry.isDir ? <Folder /> : <FileText />}</span>
        <button className="entry-name" onClick={() => open(entry)}>{entry.name}</button>
        <span>{entry.isDir ? "文件夹" : sizeLabel(entry.size)}</span>
        <span>{entry.modified ? new Date(entry.modified * 1000).toLocaleString() : ""}</span>
        <div className="row-actions">
          {!entry.isDir && <button onClick={() => toggleEntry(instancePath, entry.relativePath).then(() => load()).catch(e => onError(String(e)))} title={entry.enabled ? "禁用" : "启用"}>{entry.enabled ? <X /> : <Check />}</button>}
          <button onClick={() => { const name = prompt("新名称", entry.name); if (name) renameEntry(instancePath, entry.relativePath, name).then(() => load()).catch(e => onError(String(e))); }} title="重命名"><Pencil /></button>
          <button onClick={() => { if (confirm(`确定删除 ${entry.name}？此操作不可恢复。`)) deleteEntry(instancePath, entry.relativePath).then(() => load()).catch(e => onError(String(e))); }} title="删除"><Trash2 /></button>
        </div>
      </div>)}</div>}
    {editing && <div className="editor-layer"><div className="text-editor"><div><strong>{editing.relativePath}</strong><button className="icon-btn" onClick={() => setEditing(null)}><X /></button></div><textarea value={content} onChange={event => setContent(event.target.value)} /><footer><button className="secondary" onClick={() => setEditing(null)}>取消</button><button className="primary" onClick={() => writeTextFile(instancePath, editing.relativePath, content).then(() => setEditing(null)).catch(e => onError(String(e)))}><Save />保存</button></footer></div></div>}
  </section>;
}

export function PluginsManagerView({ instancePath, onError, kind: fixedKind }: CommonProps & { kind?: "plugins" | "mods" }) {
  const [kind, setKind] = useState<"plugins" | "mods">(fixedKind ?? "plugins");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  useEffect(() => { if (fixedKind) setKind(fixedKind); }, [fixedKind]);
  const load = useCallback(() => {
    listDirectory(instancePath, kind)
      .then(items => setEntries(items.filter(item => !item.isDir && (item.name.endsWith(".jar") || item.name.endsWith(".disabled")))))
      .catch(e => onError(String(e)));
  }, [instancePath, kind, onError]);
  useEffect(() => { if (instancePath) load(); }, [instancePath, load]);
  return <section className="panel manager-panel"><div className="manager-toolbar">{!fixedKind && <div className="segmented"><button className={kind === "plugins" ? "active" : ""} onClick={() => setKind("plugins")}>插件</button><button className={kind === "mods" ? "active" : ""} onClick={() => setKind("mods")}>模组</button></div>}<strong>{kind === "plugins" ? "插件启动" : "模组启动"}</strong><span>{entries.length} 个文件</span><button className="icon-btn" onClick={load}><RefreshCw /></button></div>
    {!instancePath ? <Empty text="请先配置实例目录" /> : <div className="plugin-list-real">{entries.map(entry => <div key={entry.relativePath}><div className={entry.enabled ? "plugin-state enabled" : "plugin-state"}>{entry.enabled ? <Check /> : <X />}</div><div><strong>{entry.name.replace(".disabled", "")}</strong><span>{entry.enabled ? "已启用" : "已禁用"} · {sizeLabel(entry.size)}</span></div><button className="secondary" onClick={() => toggleEntry(instancePath, entry.relativePath).then(load).catch(e => onError(String(e)))}>{entry.enabled ? "禁用" : "启用"}</button><button className="icon-btn" onClick={() => { if (confirm(`删除 ${entry.name}？`)) deleteEntry(instancePath, entry.relativePath).then(load).catch(e => onError(String(e))); }}><Trash2 /></button></div>)}</div>}
  </section>;
}

const pluginConfigExtensions = [".yml", ".yaml", ".json", ".toml", ".conf", ".cfg", ".properties", ".txt"];

export function PluginConfigView({ instancePath, onError, kind = "plugins" }: CommonProps & { kind?: "plugins" | "mods" }) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = content !== savedContent;

  const scan = useCallback(async () => {
    if (!instancePath) return setFiles([]);
    setLoading(true);
    try {
      const found: FileEntry[] = [];
      const pending = kind === "plugins" ? [{ path: "plugins", depth: 0 }] : [{ path: "config", depth: 0 }, { path: "mods", depth: 0 }];
      while (pending.length && found.length < 300) {
        const directory = pending.shift()!;
        let entries: FileEntry[] = [];
        try {
          entries = await listDirectory(instancePath, directory.path);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.isDir && directory.depth < 4 && !entry.name.startsWith(".")) {
            pending.push({ path: entry.relativePath, depth: directory.depth + 1 });
          } else if (!entry.isDir && pluginConfigExtensions.some(extension => entry.name.toLowerCase().endsWith(extension))) {
            found.push(entry);
          }
        }
      }
      setFiles(found.sort((a, b) => a.relativePath.localeCompare(b.relativePath)));
    } catch (error) {
      onError(String(error));
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [instancePath, kind, onError]);

  useEffect(() => { scan(); }, [scan]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const open = async (file: FileEntry) => {
    if (dirty && !confirm("当前配置尚未保存，确定切换文件？")) return;
    try {
      const next = await readTextFile(instancePath, file.relativePath);
      setSelected(file);
      setContent(next);
      setSavedContent(next);
    } catch (error) { onError(String(error)); }
  };

  const save = async () => {
    if (!selected || !dirty) return;
    setSaving(true);
    try {
      await writeTextFile(instancePath, selected.relativePath, content);
      setSavedContent(content);
    } catch (error) { onError(String(error)); }
    setSaving(false);
  };

  const visible = files.filter(file => file.relativePath.toLowerCase().includes(query.trim().toLowerCase()));
  const pluginName = (file: FileEntry) => file.relativePath.split(/[\\/]/)[1] || "plugins";

  return <section className="plugin-config-layout">
    <div className="panel plugin-config-browser">
      <div className="manager-toolbar"><FileCog /><strong>插件配置</strong><span>{files.length} 个文件</span><button className="icon-btn" onClick={scan} disabled={loading} title="重新扫描"><RefreshCw /></button></div>
      <label className="config-search"><Search /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索插件或配置文件" /></label>
      {!instancePath ? <Empty text="请先配置实例目录" /> : loading ? <Empty text="正在扫描 plugins 目录..." /> : visible.length === 0 ? <Empty text="未找到插件配置文件" /> :
        <div className="config-file-list">{visible.map(file => <button className={selected?.relativePath === file.relativePath ? "active" : ""} key={file.relativePath} onClick={() => open(file)}>
          <FileText /><span><strong>{file.name}</strong><small>{pluginName(file)} · {file.relativePath}</small></span>
        </button>)}</div>}
    </div>
    <div className="panel plugin-config-editor">
      <div className="manager-toolbar"><strong>{selected?.relativePath ?? "选择一个配置文件"}</strong>{dirty && <span className="unsaved-mark">未保存</span>}<button className="primary" disabled={!selected || !dirty || saving} onClick={save}><Save />{saving ? "保存中" : "保存"}</button></div>
      {selected ? <textarea value={content} onChange={event => setContent(event.target.value)} spellCheck={false} /> : <Empty text="从左侧选择配置文件进行编辑" />}
    </div>
  </section>;
}

const propertyFields = [
  ["motd", "服务器标语", "text"], ["server-port", "服务器端口", "number"], ["max-players", "最大玩家数", "number"],
  ["difficulty", "难度", "select"], ["gamemode", "游戏模式", "select"], ["online-mode", "正版验证", "boolean"],
  ["white-list", "启用白名单", "boolean"], ["pvp", "允许 PVP", "boolean"], ["hardcore", "极限模式", "boolean"],
  ["view-distance", "视距", "number"], ["simulation-distance", "模拟距离", "number"], ["level-name", "世界名称", "text"],
] as const;

export function PropertiesView({ instancePath, onError }: CommonProps) {
  const [props, setProps] = useState<Record<string, string>>({});
  const [rawMode, setRawMode] = useState(false);
  const load = useCallback(() => {
    readProperties(instancePath).then(setProps).catch(e => onError(String(e)));
  }, [instancePath, onError]);
  useEffect(() => { if (instancePath) load(); }, [instancePath, load]);
  const update = (key: string, value: string) => setProps(current => ({ ...current, [key]: value }));
  return <section className="panel properties-panel"><div className="manager-toolbar"><strong>server.properties</strong><div className="segmented"><button className={!rawMode ? "active" : ""} onClick={() => setRawMode(false)}>常用设置</button><button className={rawMode ? "active" : ""} onClick={() => setRawMode(true)}>全部配置</button></div><button className="primary" disabled={!instancePath} onClick={() => writeProperties(instancePath, props).catch(e => onError(String(e)))}><Save />保存配置</button></div>
    {!instancePath ? <Empty text="请先配置实例目录" /> : rawMode ? <div className="raw-properties">{Object.keys(props).sort().map(key => <label key={key}><span>{key}</span><input value={props[key]} onChange={e => update(key, e.target.value)} /></label>)}</div> :
      <div className="property-grid">{propertyFields.map(([key, label, type]) => <label key={key}><span>{label}<small>{key}</small></span>{type === "boolean" ? <input type="checkbox" checked={props[key] === "true"} onChange={e => update(key, String(e.target.checked))} /> : type === "select" ? <select value={props[key] ?? ""} onChange={e => update(key, e.target.value)}>{(key === "difficulty" ? ["peaceful", "easy", "normal", "hard"] : ["survival", "creative", "adventure", "spectator"]).map(v => <option key={v}>{v}</option>)}</select> : <input type={type} value={props[key] ?? ""} onChange={e => update(key, e.target.value)} />}</label>)}</div>}
  </section>;
}

export function PermissionsView({ instancePath, onError }: CommonProps) {
  const [lists, setLists] = useState<PlayerLists>({ ops: [], whitelist: [], bannedPlayers: [], bannedIps: [] });
  const [name, setName] = useState("");
  const [level, setLevel] = useState(4);
  const load = useCallback(() => {
    readPlayerLists(instancePath).then(setLists).catch(e => onError(String(e)));
  }, [instancePath, onError]);
  useEffect(() => { if (instancePath) load(); }, [instancePath, load]);
  const act = (action: string, player = name, reason?: string) => updatePlayer(instancePath, action, player, level, reason).then(() => { setName(""); load(); }).catch(e => onError(String(e)));
  const groups = useMemo(() => [{ title: "OP 列表", data: lists.ops, remove: "remove_op", icon: <Shield /> }, { title: "白名单", data: lists.whitelist, remove: "remove_whitelist", icon: <Check /> }, { title: "封禁玩家", data: lists.bannedPlayers, remove: "unban", icon: <Ban /> }], [lists]);
  return <section className="permissions-layout"><div className="panel player-actions"><div className="manager-toolbar"><strong>玩家权限操作</strong></div><label>玩家名<input value={name} onChange={e => setName(e.target.value)} placeholder="输入正版玩家名或离线服名称" /></label><label>OP 等级<select value={level} onChange={e => setLevel(Number(e.target.value))}><option value={4}>4 · 服主</option><option value={3}>3 · 管理员</option><option value={2}>2 · 建筑师</option><option value={1}>1 · 基础 OP</option></select></label><div className="permission-actions"><button className="primary" disabled={!name} onClick={() => act("add_op")}><UserPlus />设为 OP</button><button className="secondary" disabled={!name} onClick={() => act("add_whitelist")}>加入白名单</button><button className="danger" disabled={!name} onClick={() => act("ban", name, prompt("封禁原因") ?? "")}>封禁玩家</button></div></div>
    <div className="permission-lists">{groups.map(group => <div className="panel" key={group.title}><div className="manager-toolbar">{group.icon}<strong>{group.title}</strong><span>{group.data.length}</span></div>{group.data.length ? group.data.map((entry, i) => <div className="permission-row" key={`${entry.name}-${i}`}><div><strong>{entry.name}</strong><span>{entry.level !== undefined ? `OP ${entry.level}` : entry.reason || entry.uuid}</span></div><button className="icon-btn" onClick={() => act(group.remove, entry.name)}><Trash2 /></button></div>) : <Empty text="暂无记录" />}</div>)}</div>
  </section>;
}


export function JavaDownloadView({ onError }: { onError: (msg: string) => void }) {
  const [releases, setReleases] = useState<JavaRelease[]>([]);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [vendor, setVendor] = useState("temurin");
  const [javaVersion, setJavaVersion] = useState(21);
  const load = useCallback(() => {
    listJavaReleases(vendor, javaVersion).then(setReleases).catch(e => onError(String(e)));
  }, [onError, vendor, javaVersion]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const pending = listen<DownloadProgress>("download-progress", event => setProgress(event.payload));
    return () => { pending.then(unlisten => unlisten()); };
  }, []);

  const download = async (release: JavaRelease) => {
    setProgress({ fileName: release.fileName, downloaded: 0, total: 0, percent: 0, status: "starting" });
    try {
      const fileName = await downloadJava(release.downloadUrl, release.fileName);
      setProgress(current => ({ fileName: fileName || release.fileName, downloaded: current?.downloaded ?? 0, total: current?.total ?? 0, percent: 100, status: "completed" }));
    } catch (e) { onError(String(e)); setProgress(null); }
  };

  const vendorInfo = JAVA_VENDORS.find(item => item.id === vendor) ?? JAVA_VENDORS[0];

  return <section className="panel manager-panel">
    <div className="manager-toolbar"><Download /><strong>Java 运行时下载</strong><span>{releases.length} 个版本</span><button className="icon-btn" onClick={load}><RefreshCw /></button></div>
    <div className="java-download-layout">
      <aside className="java-vendor-list">
        <strong>Java 厂商</strong>
        {JAVA_VENDORS.map(item => (
          <button key={item.id} className={`choice-card brand-card${vendor === item.id ? " selected" : ""}`} onClick={() => setVendor(item.id)}>
            <img className="choice-card-logo" src={item.icon} alt="" referrerPolicy="no-referrer" onError={hideBrokenImage} />
            <span>{item.name}</span>
            <small>{item.note}</small>
          </button>
        ))}
      </aside>
      <div className="java-release-list">
        <div className="java-download-head">
          <div>
            <img src={vendorInfo.icon} alt="" referrerPolicy="no-referrer" onError={hideBrokenImage} />
            <div><strong>{vendorInfo.name}</strong><span>选择平台匹配的 JDK 包下载</span></div>
          </div>
          <label>Java 版本<select value={javaVersion} onChange={event => setJavaVersion(Number(event.target.value))}><option value={8}>Java 8</option><option value={17}>Java 17</option><option value={21}>Java 21</option><option value={25}>Java 25</option></select></label>
        </div>
        <div className="java-release-table">
          <div className="java-release-row table-head"><span>版本</span><span>文件</span><span>大小</span><span>操作</span></div>
          {releases.map(r => (
            <div className="java-release-row" key={`${r.fileName}-${r.version}`}>
              <span><strong>JDK {r.major}</strong><small>{r.version}</small></span>
              <span title={r.fileName}>{r.fileName}</span>
              <span>{r.sizeMb > 0 ? `${r.sizeMb.toFixed(1)} MB` : "未知"}</span>
              <button className="primary" onClick={() => download(r)} disabled={progress?.status === "downloading"}>下载</button>
            </div>
          ))}
          {releases.length === 0 && <Empty text="正在读取 Java 下载列表，或当前平台暂无该厂商构建" />}
        </div>
      </div>
    </div>
    {progress && <div className="progress-view" style={{ minHeight: 60, padding: 14 }}><strong>{progress.fileName}</strong><div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div><span>{progress.status === "completed" ? "下载完成" : `${progress.percent.toFixed(1)}%`}</span></div>}
  </section>;
}

export function CoreTypeView({ instancePath, onError, onCoreDownloaded }: CommonProps & { onCoreDownloaded?: (serverJar: string) => void }) {
  const [coreTypes, setCoreTypes] = useState<CoreTypeInfo[]>([]);
  const [coreName, setCoreName] = useState("");
  const [version, setVersion] = useState("");
  const [versions, setVersions] = useState<string[]>([]);
  const [builds, setBuilds] = useState<BuildInfo[]>([]);
  const [build, setBuild] = useState("");
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [category, setCategory] = useState("all");

  const loadTypes = useCallback(() => {
    getCoreTypes().then(items => { setCoreTypes(items); if (!coreName && items[0]) setCoreName(items[0].name); }).catch(e => onError(String(e)));
  }, [onError]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadTypes(); }, [loadTypes]);

  useEffect(() => {
    if (!coreName) return;
    listUnifiedCoreVersions(coreName).then(vers => { setVersions(vers); if (vers[0]) setVersion(vers[0]); }).catch(e => onError(String(e)));
  }, [coreName, onError]);

  useEffect(() => {
    if (!coreName || !version) return;
    setBuilds([]); setBuild("");
    listUnifiedCoreBuilds(coreName, version).then(items => { setBuilds(items); setBuild(items[0]?.coreVersion ?? ""); }).catch(e => onError(String(e)));
  }, [coreName, version, onError]);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const pending = listen<DownloadProgress>("download-progress", event => setProgress(event.payload));
    return () => { pending.then(unlisten => unlisten()); };
  }, []);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: coreTypes.length };
    for (const item of coreTypes) counts[item.category] = (counts[item.category] ?? 0) + 1;
    return counts;
  }, [coreTypes]);
  const filtered = category === "all" ? coreTypes : coreTypes.filter(c => c.category === category);
  const switchCategory = (nextCategory: string) => {
    setCategory(nextCategory);
    const nextItems = nextCategory === "all" ? coreTypes : coreTypes.filter(c => c.category === nextCategory);
    if (nextItems.length > 0 && !nextItems.some(item => item.name === coreName)) {
      setCoreName(nextItems[0].name);
    }
  };

  const download = (useLatest = false) => {
    const targetBuild = useLatest ? builds[0]?.coreVersion : build;
    if (!targetBuild) return onError("请选择构建版本");
    setProgress({ fileName: "", downloaded: 0, total: 0, percent: 0, status: "starting" });
    downloadUnifiedServerCore(instancePath, coreName, version, targetBuild)
      .then(fileName => {
        if (fileName) onCoreDownloaded?.(fileName);
        setProgress(current => ({ fileName: fileName || current?.fileName || "", downloaded: current?.downloaded ?? 0, total: current?.total ?? 0, percent: 100, status: "completed" }));
      })
      .catch(e => { onError(String(e)); setProgress(null); });
  };

  const selectedCore = coreTypes.find(item => item.name === coreName);

  return <section className="core-download-layout">
    <div className="panel core-picker-panel">
      <div className="manager-toolbar"><Download /><strong>服务端核心下载</strong><button className="icon-btn" onClick={loadTypes}><RefreshCw /></button></div>
      <div className="segmented core-category-tabs">
        {CORE_CATEGORY_ORDER.map(cat => (
          <button key={cat} className={category === cat ? "active" : ""} onClick={() => switchCategory(cat)}>
            {CORE_CATEGORY_LABELS[cat]} <small>{categoryCounts[cat] ?? 0}</small>
          </button>
        ))}
      </div>
      <div className="core-card-grid">
        {filtered.map(c => (
          <div key={c.name} className={`core-card${coreName === c.name ? " selected" : ""}`} onClick={() => setCoreName(c.name)}>
            <div className="core-card-icon">{coreBadge(c.name) ? <span className={`core-product-badge ${c.name.toLowerCase()}`}>{coreBadge(c.name)}</span> : coreIconUrl(c.name) ? <img src={coreIconUrl(c.name)} alt="" referrerPolicy="no-referrer" onError={hideBrokenImage} /> : c.recommend ? <Star size={20} /> : <Server size={20} />}</div>
            <strong>{c.label}</strong>
            <span className="core-card-meta">{CORE_CATEGORY_LABELS[c.category] ?? c.category}</span>
          </div>
        ))}
        {filtered.length === 0 && <Empty text="当前分类暂无可用核心" />}
      </div>
    </div>
    <div className="panel core-version-panel">
      <div className="manager-toolbar"><strong>{selectedCore?.label ?? "选择核心"}</strong><span>{selectedCore ? CORE_CATEGORY_LABELS[selectedCore.category] ?? selectedCore.category : "未选择"}</span></div>
      <div className="picker-block">
        <strong>Minecraft Version</strong>
        <div className="version-card-grid">
          {versions.map((v: string) => <button type="button" key={v} className={version === v ? "version-card selected" : "version-card"} onClick={() => setVersion(v)}>{v}</button>)}
        </div>
      </div>
      <div className="picker-block">
        <strong>Build Version</strong>
        <div className="version-card-grid builds">
          {builds.map(item => <button type="button" key={item.coreVersion} className={build === item.coreVersion ? "version-card selected" : "version-card"} onClick={() => setBuild(item.coreVersion)}><span>{item.coreVersion}</span>{item.updateTime && <small>{item.updateTime.slice(0, 10)}</small>}</button>)}
        </div>
      </div>
      {coreName && version && builds.length === 0 && (
        <div className="download-source-hint">
          <strong>获取构建中</strong>
          <span>正在从 FastMirror / 官方源获取构建列表...</span>
        </div>
      )}
      <div className="download-buttons">
        <button className="primary" disabled={!build || progress?.status === "downloading"} onClick={() => download(false)}><Download />下载选中构建</button>
        <button className="secondary" disabled={!builds[0] || progress?.status === "downloading"} onClick={() => download(true)}>下载最新构建</button>
      </div>
      <div className="download-status-inline">
      <div className="manager-toolbar"><strong>下载状态</strong></div>
      {progress ? <div className="progress-view"><strong>{progress.fileName || `${coreName} ${version}`}</strong><div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div><span>{progress.status === "completed" ? "下载完成" : progress.status === "cancelled" ? "已取消" : `${progress.percent.toFixed(1)}% · ${sizeLabel(progress.downloaded)} / ${progress.total ? sizeLabel(progress.total) : "未知大小"} · ${progress.speedMbps?.toFixed(1) ?? "0.0"} MB/s`}</span>{progress.status === "downloading" && <button className="danger" onClick={() => cancelDownload()} style={{ marginTop: 8 }}><XCircle size={14} />取消下载</button>}</div> : <Empty text="选择核心版本后下载" />}
    </div>
    </div>
  </section>;
}

function Empty({ text }: { text: string }) { return <div className="empty-state"><Folder /><span>{text}</span></div>; }

export function PluginMarketView({ instancePath, onError, kind: fixedKind }: CommonProps & { kind?: "plugins" | "mods" }) {
  const [kind, setKind] = useState<"plugins" | "mods">(fixedKind ?? "plugins");
  const [source, setSource] = useState<"modrinth" | "hangar" | "spiget" | "curseforge">("modrinth");
  const [query, setQuery] = useState("");
  const [gameVersion, setGameVersion] = useState("");
  const [loader, setLoader] = useState("");
  const [sort, setSort] = useState("relevance");
  const [results, setResults] = useState<PluginInfo[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<PluginInfo | null>(null);
  const [versions, setVersions] = useState<PluginVersion[]>([]);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [popular, setPopular] = useState<PluginInfo[]>([]);
  const [cfApiKey, setCfApiKey] = useState(() => localStorage.getItem("astrore.curseforge.apiKey") ?? "");

  const search = async () => {
    setSearching(true);
    try {
      if (source === "modrinth") {
        const terms = [query.trim() || "popular", gameVersion, loader, sort !== "relevance" ? sort : ""].filter(Boolean).join(" ");
        setResults(await searchModrinth(terms, kind));
      } else if (source === "curseforge") {
        if (!cfApiKey.trim()) { onError("CurseForge 需要 API Key，请在下方设置"); setSearching(false); return; }
        setResults(await searchCurseForge(query.trim() || "popular", kind, cfApiKey.trim()));
      } else if (source === "hangar") {
        setResults(await searchHangar(query.trim() || "popular"));
      } else {
        setResults(await searchSpigetAsPlugin(query.trim() || "popular"));
      }
      setSelected(null);
      setVersions([]);
    } catch (e) { onError(String(e)); }
    setSearching(false);
  };

  useEffect(() => { if (fixedKind) setKind(fixedKind); }, [fixedKind]);
  useEffect(() => {
    if (kind === "mods" && (source === "hangar" || source === "spiget")) {
      setSource("modrinth");
      setResults([]);
      setSelected(null);
      setPopular([]);
    }
  }, [kind, source]);
  useEffect(() => {
    search();
    if (popular.length === 0) {
      const loadPopular = source === "modrinth"
        ? searchModrinth("popular", kind)
        : source === "hangar"
          ? searchHangar("popular")
          : source === "curseforge"
          ? (cfApiKey.trim() ? searchCurseForge("popular", kind, cfApiKey.trim()) : Promise.resolve([]))
          : searchSpigetAsPlugin("popular");
      loadPopular.then(items => setPopular(items.slice(0, 8))).catch(() => {});
    }
  }, [kind, source]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectProject = async (project: PluginInfo) => {
    setSelected(project);
    if (source === "modrinth") {
      try { setVersions(await getModrinthVersions(project.projectId)); } catch (e) { onError(String(e)); }
    } else if (source === "hangar") {
      try { setVersions(await getHangarVersions(project.projectId)); } catch (e) { onError(String(e)); }
    } else if (source === "curseforge") {
      try { setVersions(await getCurseForgeFiles(project.projectId, cfApiKey.trim())); } catch (e) { onError(String(e)); }
    }
  };

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const pending = listen<DownloadProgress>("download-progress", event => setProgress(event.payload));
    return () => { pending.then(unlisten => unlisten()); };
  }, []);

  const download = async (version: PluginVersion) => {
    if (!instancePath) return onError("请先配置实例目录");
    setProgress({ fileName: version.fileName, downloaded: 0, total: 0, percent: 0, status: "starting" });
    try {
      await downloadPlugin(instancePath, version.downloadUrl, version.fileName, kind);
      setProgress(current => ({ fileName: version.fileName, downloaded: current?.downloaded ?? 0, total: current?.total ?? 0, percent: 100, status: "completed" }));
    } catch (e) { onError(String(e)); setProgress(null); }
  };

  const showPopular = !query.trim() && !selected;

  return <section className="panel manager-panel">
    <div className="manager-toolbar">
      {!fixedKind && <div className="segmented">
        <button className={kind === "plugins" ? "active" : ""} onClick={() => { setKind("plugins"); setResults([]); setSelected(null); setPopular([]); }}>插件</button>
        <button className={kind === "mods" ? "active" : ""} onClick={() => { setKind("mods"); setSource("modrinth"); setResults([]); setSelected(null); setPopular([]); }}>模组</button>
      </div>}
      {fixedKind && <strong>{fixedKind === "plugins" ? "插件下载" : "模组下载"}</strong>}
      <div className="segmented" style={{ marginLeft: 8 }}>
        <button className={source === "modrinth" ? "active" : ""} onClick={() => { setSource("modrinth"); setResults([]); setSelected(null); setPopular([]); }}>Modrinth</button>
        {kind === "plugins" && <button className={source === "hangar" ? "active" : ""} onClick={() => { setSource("hangar"); setResults([]); setSelected(null); setPopular([]); }}>Hangar</button>}
        {kind === "plugins" && <button className={source === "spiget" ? "active" : ""} onClick={() => { setSource("spiget"); setResults([]); setSelected(null); setPopular([]); }}>Spiget</button>}
        <button className={source === "curseforge" ? "active" : ""} onClick={() => { setSource("curseforge"); setResults([]); setSelected(null); setPopular([]); }}>CurseForge</button>
      </div>
      <div className="search" style={{ width: 200, marginLeft: 8 }}>
        <Search size={14} />
        <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && search()} placeholder={`搜索 ${kind === "plugins" ? "插件" : "模组"}...`} />
      </div>
      <button className="primary" onClick={search} disabled={searching}>{searching ? "搜索中..." : "搜索"}</button>
      <span style={{ marginLeft: "auto" }}>{results.length} 个结果</span>
    </div>
    {source === "modrinth" && <div className="download-filter-row">
      <label>Minecraft 版本<input value={gameVersion} onChange={event => setGameVersion(event.target.value)} onKeyDown={event => event.key === "Enter" && search()} placeholder="例如 1.21.8" /></label>
      <label>加载器<select value={loader} onChange={event => setLoader(event.target.value)}><option value="">全部</option><option value="paper">Paper</option><option value="spigot">Spigot</option><option value="fabric">Fabric</option><option value="forge">Forge</option><option value="neoforge">NeoForge</option></select></label>
      <label>排序<select value={sort} onChange={event => setSort(event.target.value)}><option value="relevance">相关度</option><option value="downloads">下载量</option><option value="updated">最近更新</option><option value="follows">收藏数</option></select></label>
    </div>}
    {source === "curseforge" && <div className="download-filter-row">
      <label>CurseForge API Key<input type="password" value={cfApiKey} onChange={event => { setCfApiKey(event.target.value); localStorage.setItem("astrore.curseforge.apiKey", event.target.value); }} placeholder="申请地址: https://console.curseforge.com" /></label>
    </div>}
    {!instancePath ? <Empty text="请先配置实例目录" /> : selected ? (
      <div>
        <div className="manager-toolbar">
          <button className="icon-btn" onClick={() => setSelected(null)}><ArrowLeft /></button>
          <strong>{selected.title}</strong>
          <span>{versions.length} 个版本</span>
        </div>
        <div className="detail-panel">
          {selected.iconUrl && <img src={selected.iconUrl} alt="" style={{ width: 64, height: 64, borderRadius: 8 }} />}
          <div>
            <h3>{selected.title}</h3>
            <p>{selected.description}</p>
            <div className="detail-meta">
              <span><Download size={14} /> {sizeLabel(selected.downloads)}</span>
              <span>分类: {selected.categories.slice(0, 3).join(", ")}</span>
            </div>
          </div>
        </div>
        {source !== "spiget" ? (
          <div className="plugin-list-real">
            {versions.map(v => (
              <div key={v.versionNumber}>
                <div className="plugin-state enabled"><Download /></div>
                <div><strong>{v.versionNumber}</strong><span>{v.fileName} · {v.gameVersions.slice(0, 3).join(", ")} · {v.loaders.join(", ")}</span></div>
                <button className="primary" onClick={() => download(v)} disabled={progress?.status === "downloading"}>下载</button>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ padding: 14 }}><Empty text="Spiget 源暂不支持版本选择，请使用 Modrinth 或 CurseForge 源下载" /></div>
        )}
        {progress && <div className="progress-view" style={{ minHeight: 60, padding: 14 }}><strong>{progress.fileName}</strong><div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div><span>{progress.status === "completed" ? "下载完成" : `${progress.percent.toFixed(1)}%`}</span></div>}
      </div>
    ) : showPopular ? (
      <div>
        <div className="market-hero" style={{ marginBottom: 12 }}>
          <strong>{kind === "plugins" ? "🔥 最热插件" : "🔥 最热模组"}</strong>
          <span>来自 {source === "modrinth" ? "Modrinth" : source === "hangar" ? "Hangar" : source === "curseforge" ? "CurseForge" : "Spiget"} · 按下载量排序</span>
        </div>
        <div className="popular-grid">
          {popular.map(item => (
            <div key={item.projectId} className="popular-card" onClick={() => selectProject(item)}>
              <div className="popular-icon">
                {item.iconUrl ? <img src={item.iconUrl} alt="" /> : <Download size={28} />}
              </div>
              <strong>{item.title}</strong>
              <span>{item.description.slice(0, 50)}{item.description.length > 50 ? "..." : ""}</span>
              <small><Download size={10} /> {sizeLabel(item.downloads)}</small>
            </div>
          ))}
          {popular.length === 0 && <Empty text="加载中..." />}
        </div>
      </div>
    ) : (
      <div className="plugin-list-real">
        {results.map(item => (
          <div key={item.projectId} onClick={() => selectProject(item)} style={{ cursor: "pointer" }}>
            <div className="plugin-state enabled" style={{ background: item.iconUrl ? "transparent" : undefined }}>
              {item.iconUrl ? <img src={item.iconUrl} alt="" style={{ width: 34, height: 34, borderRadius: 6 }} /> : <Download />}
            </div>
            <div><strong>{item.title}</strong><span>{item.description.slice(0, 80)}{item.description.length > 80 ? "..." : ""} · {sizeLabel(item.downloads)} 下载</span></div>
            <span style={{ color: "#859188", fontSize: 9 }}>{item.categories.slice(0, 2).join(", ")}</span>
          </div>
        ))}
        {results.length === 0 && <Empty text={query ? "未找到结果，尝试其他关键词" : `输入关键词搜索 ${kind === "plugins" ? "插件" : "模组"}`} />}
      </div>
    )}
  </section>;
}
