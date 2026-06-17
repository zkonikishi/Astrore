import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Archive, ArrowLeft, Ban, Check, Download, FileCog, FileText, Folder, Pencil, Plus, RefreshCw, RotateCcw, Save, Search, Shield, Star, Trash2, User, UserPlus, X, XCircle } from "lucide-react";
import {
  callExtensionTool,
  cancelDownload,
  createBackup,
  deleteBackup,
  deleteEntry,
  downloadJava,
  downloadPlugin,
  downloadServerCore,
  downloadSpigetPlugin,
  fetchExtensionRegistry,
  getCoreTypes,
  getModrinthVersions,
  initExtensionManager,
  installRegistryExtension,
  isTauriRuntime,
  listJavaReleases,
  listDirectory,
  listServerCores,
  listCoreBuilds,
  listBackups,
  readPlayerLists,
  readProperties,
  readTextFile,
  renameEntry,
  restoreBackup,
  scanExtensions,
  searchSpiget,
  searchModrinth,
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
  type SpigetResource,
} from "./bridge";

type CommonProps = { instancePath: string; onError: (message: string) => void };

const sizeLabel = (size: number) =>
  size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`;

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
  const [registryUrl, setRegistryUrl] = useState(() => localStorage.getItem("astrore.extensions.registry") ?? "https://raw.githubusercontent.com/zkonikishi/Astrore/main/registry/index.json");
  const [busy, setBusy] = useState("");
  const [selectedTool, setSelectedTool] = useState<{ extensionId: string; tool: McpTool; author: string } | null>(null);
  const [toolArgs, setToolArgs] = useState("{}");
  const [toolResult, setToolResult] = useState("");

  const load = useCallback(() => {
    initExtensionManager().then(() => scanExtensions()).then(setExtensions).catch(e => onError(String(e)));
  }, [onError]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetchExtensionRegistry(registryUrl.trim()).then(setCatalog).catch(() => undefined);
  }, []);

  const loadCatalog = async () => {
    setBusy("registry");
    try {
      const entries = await fetchExtensionRegistry(registryUrl.trim());
      setCatalog(entries);
      localStorage.setItem("astrore.extensions.registry", registryUrl.trim());
    } catch (error) { onError(String(error)); }
    setBusy("");
  };

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
      <span>{view === "installed" ? `${extensions.length} 个扩展` : `${catalog.length} 个条目`}</span>
      <button className="icon-btn" onClick={load}><RefreshCw /></button>
    </div>
    <div className="market-hero" style={{ minHeight: 80 }}>
      <strong>安全扩展平台</strong>
      <span>WASI 扩展将运行在沙箱中；外部 MCP 扩展拥有更高风险，启动前必须确认权限。</span>
    </div>
    {view === "catalog" ? <div className="extension-catalog">
      <div className="registry-bar"><Shield /><input value={registryUrl} onChange={event => setRegistryUrl(event.target.value)} placeholder="HTTPS 扩展注册表地址" /><button className="primary" disabled={busy === "registry"} onClick={loadCatalog}><RefreshCw />获取商店</button></div>
      <div className="plugin-list-real">{catalog.map(entry => {
        const installed = extensions.find(extension => extension.id === entry.id);
        const update = installed && isNewer(entry.version, installed.version);
        return <div key={entry.id}>
          <div className={`plugin-state ${entry.verified ? "enabled" : ""}`}>{entry.verified ? <Check /> : <Shield />}</div>
          <div><strong>{entry.name}</strong><span>{entry.description}</span><span className="ext-meta">{entry.verified ? "已验证" : "第三方"} · {entry.runtime === "wasi" ? "WASI 沙箱" : "外部 MCP"} · v{entry.version} · {sizeLabel(entry.size)}</span></div>
          <button className="primary" disabled={busy === entry.id || Boolean(installed && !update)} onClick={() => install(entry)}><Download />{update ? "更新" : installed ? "已安装" : "安装"}</button>
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
      <div className="plugin-list-real">
        {extensions.map(ext => (
          <div key={ext.id}>
            <div className={`plugin-state ${ext.running ? "enabled" : ""}`}>{ext.running ? <Check /> : <X />}</div>
            <div><strong>{ext.name}</strong><span>{ext.description}</span><span className="ext-meta"><User size={12} /> {ext.author} · v{ext.version} · {ext.runtime === "wasi" ? "WASI 沙箱" : "外部 MCP 高风险"} · {ext.permissions.join("、") || "无权限"}</span></div>
            {catalog.find(entry => entry.id === ext.id && isNewer(entry.version, ext.version)) && <button className="primary" onClick={() => install(catalog.find(entry => entry.id === ext.id && isNewer(entry.version, ext.version))!)}><Download />更新</button>}
            <button className="secondary" onClick={() => toggle(ext)} disabled={busy === ext.id}>{busy === ext.id ? "..." : ext.running ? "停止" : "启动"}</button>
            <button className="icon-btn" onClick={() => { if (confirm(`确定卸载 ${ext.name}？`)) { uninstallExtension(ext.id).then(load).catch(e => onError(String(e))); } }} title="卸载"><Trash2 size={14} /></button>
            {ext.tools.length > 0 && <div className="segmented" style={{ marginLeft: 8 }}>
              {ext.tools.map(t => (
                <button key={t.name} className="secondary" onClick={() => { setSelectedTool({ extensionId: ext.id, tool: t, author: ext.author }); setToolArgs("{}"); setToolResult(""); }} style={{ fontSize: 10 }}>{t.name}</button>
              ))}
            </div>}
          </div>
        ))}
        {extensions.length === 0 && <Empty text="暂无扩展，将扩展放入 extensions 目录后刷新" />}
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
  const load = useCallback(() => {
    listJavaReleases().then(setReleases).catch(e => onError(String(e)));
  }, [onError]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const pending = listen<DownloadProgress>("download-progress", event => setProgress(event.payload));
    return () => { pending.then(unlisten => unlisten()); };
  }, []);

  const download = async (release: JavaRelease) => {
    setProgress({ fileName: release.fileName, downloaded: 0, total: 0, percent: 0, status: "starting" });
    try {
      await downloadJava(release.downloadUrl, release.fileName);
    } catch (e) { onError(String(e)); setProgress(null); }
  };

  return <section className="panel manager-panel">
    <div className="manager-toolbar"><Download /><strong>Java 运行时下载</strong><span>{releases.length} 个版本</span><button className="icon-btn" onClick={load}><RefreshCw /></button></div>
    <div className="download-filter-row">
      <label>Java 厂商<select value={vendor} onChange={event => setVendor(event.target.value)}><option value="temurin">Eclipse Temurin</option><option value="microsoft">Microsoft Build of OpenJDK</option><option value="zulu">Azul Zulu</option><option value="graalvm">GraalVM Community</option></select></label>
      <label>推荐版本<select defaultValue="21"><option value="8">Java 8</option><option value="17">Java 17</option><option value="21">Java 21</option><option value="25">Java 25</option></select></label>
    </div>
    <div className="market-hero" style={{ minHeight: 120 }}>
      <strong>{vendor === "temurin" ? "Eclipse Adoptium Temurin JDK 21" : "更多 Java 厂商即将接入"}</strong>
      <span>Java 21 是 Minecraft 1.20.5+ 的推荐版本。下载后可安装到系统，或在实例配置里填写 Java 可执行文件路径。</span>
    </div>
    <div className="plugin-list-real">
      {releases.map(r => (
        <div key={r.version}>
          <div className="plugin-state enabled"><Download /></div>
          <div><strong>JDK {r.major} · {r.version}</strong><span>{r.fileName} · {r.sizeMb.toFixed(1)} MB</span></div>
          <button className="primary" onClick={() => download(r)} disabled={progress?.status === "downloading"}>下载</button>
        </div>
      ))}
    </div>
    {progress && <div className="progress-view" style={{ minHeight: 60, padding: 14 }}><strong>{progress.fileName}</strong><div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div><span>{progress.status === "completed" ? "下载完成" : `${progress.percent.toFixed(1)}%`}</span></div>}
  </section>;
}

export function SpigetPluginView({ instancePath, onError }: CommonProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SpigetResource[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SpigetResource | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  const search = async () => {
    setSearching(true);
    try {
      setResults(await searchSpiget(query.trim() || "popular"));
      setSelected(null);
    } catch (e) { onError(String(e)); }
    setSearching(false);
  };

  useEffect(() => { search(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const pending = listen<DownloadProgress>("download-progress", event => setProgress(event.payload));
    return () => { pending.then(unlisten => unlisten()); };
  }, []);

  const download = async (resource: SpigetResource) => {
    if (!instancePath) return onError("请先配置实例目录");
    const fileName = `${resource.name}-${resource.version}.jar`;
    setProgress({ fileName, downloaded: 0, total: 0, percent: 0, status: "starting" });
    try {
      await downloadSpigetPlugin(instancePath, resource.id, fileName);
    } catch (e) { onError(String(e)); setProgress(null); }
  };

  return <section className="panel manager-panel">
    <div className="manager-toolbar">
      <strong>Spiget 插件</strong>
      <div className="search" style={{ width: 220, marginLeft: 8 }}>
        <Search size={14} />
        <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && search()} placeholder="搜索 Spigot 插件..." />
      </div>
      <button className="primary" onClick={search} disabled={searching}>{searching ? "搜索中..." : "搜索"}</button>
      <span style={{ marginLeft: "auto" }}>{results.length} 个结果</span>
    </div>
    {!instancePath ? <Empty text="请先配置实例目录" /> : selected ? (
      <div>
        <div className="manager-toolbar">
          <button className="icon-btn" onClick={() => setSelected(null)}><ArrowLeft /></button>
          <strong>{selected.name}</strong>
          <span>v{selected.version}</span>
        </div>
        <div className="detail-panel">
          {selected.iconUrl && <img src={selected.iconUrl} alt="" style={{ width: 64, height: 64, borderRadius: 8 }} />}
          <div>
            <h3>{selected.name}</h3>
            <p>{selected.description}</p>
            <div className="detail-meta">
              <span><Star size={14} /> {selected.rating.toFixed(1)}</span>
              <span><Download size={14} /> {sizeLabel(selected.downloads)}</span>
              <span>作者: {selected.author}</span>
              <span>标签: {selected.tag}</span>
            </div>
            <button className="primary" onClick={() => download(selected)} disabled={progress?.status === "downloading"}>下载到实例目录</button>
          </div>
        </div>
        {progress && <div className="progress-view" style={{ minHeight: 60, padding: 14 }}><strong>{progress.fileName}</strong><div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div><span>{progress.status === "completed" ? "下载完成" : `${progress.percent.toFixed(1)}%`}</span></div>}
      </div>
    ) : (
      <div className="plugin-list-real">
        {results.map(item => (
          <div key={item.id} onClick={() => setSelected(item)} style={{ cursor: "pointer" }}>
            <div className="plugin-state enabled" style={{ background: item.iconUrl ? "transparent" : undefined }}>
              {item.iconUrl ? <img src={item.iconUrl} alt="" style={{ width: 34, height: 34, borderRadius: 6 }} /> : <Download />}
            </div>
            <div><strong>{item.name}</strong><span>{item.description.slice(0, 80)}{item.description.length > 80 ? "..." : ""} · {sizeLabel(item.downloads)} 下载 · v{item.version}</span></div>
            <span style={{ color: "#859188", fontSize: 9 }}>{item.author}</span>
          </div>
        ))}
        {results.length === 0 && <Empty text={query ? "未找到结果" : "输入关键词搜索 Spigot 插件"} />}
      </div>
    )}
  </section>;
}

export function CoreTypeView({ instancePath, onError }: CommonProps) {
  const [coreTypes, setCoreTypes] = useState<CoreTypeInfo[]>([]);
  const [coreName, setCoreName] = useState("");
  const [version, setVersion] = useState("");
  const [versions, setVersions] = useState<string[]>([]);
  const [builds, setBuilds] = useState<BuildInfo[]>([]);
  const [build, setBuild] = useState("");
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [category, setCategory] = useState("all");

  const loadTypes = useCallback(() => {
    getCoreTypes().then(items => { setCoreTypes(items); if (items[0]) setCoreName(items[0].name); }).catch(e => onError(String(e)));
  }, [onError]);
  useEffect(() => { loadTypes(); }, [loadTypes]);

  useEffect(() => {
    if (!coreName) return;
    listServerCores().then(cores => {
      const core = cores.find(c => c.name === coreName);
      if (core) {
        setVersions(core.mcVersions);
        if (core.mcVersions[0]) setVersion(core.mcVersions[0]);
      }
    }).catch(e => onError(String(e)));
  }, [coreName, onError]);

  useEffect(() => { if (coreName && version) listCoreBuilds(coreName, version).then(items => { setBuilds(items); setBuild(items[0]?.coreVersion ?? ""); }).catch(e => onError(String(e))); }, [coreName, version, onError]);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const pending = listen<DownloadProgress>("download-progress", event => setProgress(event.payload));
    return () => { pending.then(unlisten => unlisten()); };
  }, []);

  const filtered = category === "all" ? coreTypes : coreTypes.filter(c => c.category === category);

  const download = (useLatest = false) => {
    if (!instancePath) return onError("请先配置实例目录");
    const targetBuild = useLatest ? builds[0]?.coreVersion : build;
    if (!targetBuild) return onError("请选择构建版本");
    setProgress({ fileName: "", downloaded: 0, total: 0, percent: 0, status: "starting" });
    downloadServerCore(instancePath, coreName, version, targetBuild)
      .then(fileName => setProgress(current => ({ fileName: fileName || current?.fileName || "", downloaded: current?.downloaded ?? 0, total: current?.total ?? 0, percent: 100, status: "completed" })))
      .catch(e => { onError(String(e)); setProgress(null); });
  };

  return <section className="download-layout">
    <div className="panel download-form">
      <div className="manager-toolbar"><Download /><strong>服务端核心下载</strong><button className="icon-btn" onClick={loadTypes}><RefreshCw /></button></div>
      <div className="segmented" style={{ margin: "10px 15px 0" }}>
        {["all", "pure", "mod", "vanilla", "proxy"].map(cat => (
          <button key={cat} className={category === cat ? "active" : ""} onClick={() => setCategory(cat)}>
            {{all: "全部", pure: "纯净", mod: "模组", vanilla: "原版", proxy: "代理"}[cat]}
          </button>
        ))}
      </div>
      <label>核心类型<select value={coreName} onChange={e => setCoreName(e.target.value)}>{filtered.map(c => <option key={c.name} value={c.name}>{c.label}</option>)}</select></label>
      <label>Minecraft 版本<select value={version} onChange={e => setVersion(e.target.value)}>{versions.map((v: string) => <option key={v}>{v}</option>)}</select></label>
      <label>构建版本<select value={build} onChange={e => setBuild(e.target.value)}>{builds.map(item => <option key={item.coreVersion} value={item.coreVersion}>{item.coreVersion} · {item.updateTime.slice(0, 10)}</option>)}</select></label>
      <div className="download-buttons">
        <button className="primary" disabled={!build || progress?.status === "downloading"} onClick={() => download(false)}><Download />下载选中构建</button>
        <button className="secondary" disabled={!builds[0] || progress?.status === "downloading"} onClick={() => download(true)}>下载最新构建</button>

      </div>
    </div>
    <div className="panel download-status">
      <div className="manager-toolbar"><strong>下载状态</strong></div>
      {progress ? <div className="progress-view"><strong>{progress.fileName || `${coreName} ${version}`}</strong><div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div><span>{progress.status === "completed" ? "下载完成" : progress.status === "cancelled" ? "已取消" : `${progress.percent.toFixed(1)}% · ${sizeLabel(progress.downloaded)} / ${progress.total ? sizeLabel(progress.total) : "未知大小"} · ${progress.speedMbps?.toFixed(1) ?? "0.0"} MB/s`}</span>{progress.status === "downloading" && <button className="danger" onClick={() => cancelDownload()} style={{ marginTop: 8 }}><XCircle size={14} />取消下载</button>}</div> : <Empty text="选择核心版本后下载" />}
    </div>
  </section>;
}

function Empty({ text }: { text: string }) { return <div className="empty-state"><Folder /><span>{text}</span></div>; }

export function PluginMarketView({ instancePath, onError, kind: fixedKind }: CommonProps & { kind?: "plugins" | "mods" }) {
  const [kind, setKind] = useState<"plugins" | "mods">(fixedKind ?? "plugins");
  const [query, setQuery] = useState("");
  const [gameVersion, setGameVersion] = useState("");
  const [loader, setLoader] = useState("");
  const [sort, setSort] = useState("relevance");
  const [results, setResults] = useState<PluginInfo[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<PluginInfo | null>(null);
  const [versions, setVersions] = useState<PluginVersion[]>([]);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  const search = async () => {
    setSearching(true);
    try {
      const terms = [query.trim() || "popular", gameVersion, loader, sort !== "relevance" ? sort : ""].filter(Boolean).join(" ");
      const items = await searchModrinth(terms, kind);
      setResults(items);
      setSelected(null);
      setVersions([]);
    } catch (e) { onError(String(e)); }
    setSearching(false);
  };

  useEffect(() => { if (fixedKind) setKind(fixedKind); }, [fixedKind]);
  useEffect(() => { search(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectProject = async (project: PluginInfo) => {
    setSelected(project);
    try {
      setVersions(await getModrinthVersions(project.projectId));
    } catch (e) { onError(String(e)); }
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

  return <section className="panel manager-panel">
    <div className="manager-toolbar">
      {!fixedKind && <div className="segmented">
        <button className={kind === "plugins" ? "active" : ""} onClick={() => { setKind("plugins"); setResults([]); setSelected(null); }}>插件</button>
        <button className={kind === "mods" ? "active" : ""} onClick={() => { setKind("mods"); setResults([]); setSelected(null); }}>模组</button>
      </div>}
      {fixedKind && <strong>{fixedKind === "plugins" ? "插件下载" : "模组下载"}</strong>}
      <div className="search" style={{ width: 220, marginLeft: 8 }}>
        <Search size={14} />
        <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && search()} placeholder={`搜索 ${kind === "plugins" ? "插件" : "模组"}...`} />
      </div>
      <button className="primary" onClick={search} disabled={searching}>{searching ? "搜索中..." : "搜索"}</button>
      <span style={{ marginLeft: "auto" }}>{results.length} 个结果</span>
    </div>
    <div className="download-filter-row">
      <label>Minecraft 版本<input value={gameVersion} onChange={event => setGameVersion(event.target.value)} onKeyDown={event => event.key === "Enter" && search()} placeholder="例如 1.21.8" /></label>
      <label>加载器<select value={loader} onChange={event => setLoader(event.target.value)}><option value="">全部</option><option value="paper">Paper</option><option value="spigot">Spigot</option><option value="fabric">Fabric</option><option value="forge">Forge</option><option value="neoforge">NeoForge</option></select></label>
      <label>排序<select value={sort} onChange={event => setSort(event.target.value)}><option value="relevance">相关度</option><option value="downloads">下载量</option><option value="updated">最近更新</option><option value="follows">收藏数</option></select></label>
    </div>
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
        <div className="plugin-list-real">
          {versions.map(v => (
            <div key={v.versionNumber}>
              <div className="plugin-state enabled"><Download /></div>
              <div><strong>{v.versionNumber}</strong><span>{v.fileName} · {v.gameVersions.slice(0, 3).join(", ")} · {v.loaders.join(", ")}</span></div>
              <button className="primary" onClick={() => download(v)} disabled={progress?.status === "downloading"}>下载</button>
            </div>
          ))}
        </div>
        {progress && <div className="progress-view" style={{ minHeight: 60, padding: 14 }}><strong>{progress.fileName}</strong><div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div><span>{progress.status === "completed" ? "下载完成" : `${progress.percent.toFixed(1)}%`}</span></div>}
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
