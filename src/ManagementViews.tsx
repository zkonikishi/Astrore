import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Archive, ArrowLeft, Ban, Check, Download, FileText, Folder, Pencil, Plus, RefreshCw, RotateCcw, Save, Search, Shield, Trash2, UserPlus, X } from "lucide-react";
import {
  createBackup,
  deleteBackup,
  deleteEntry,
  downloadPlugin,
  downloadServerCore,
  getModrinthVersions,
  isTauriRuntime,
  listDirectory,
  listCoreBuilds,
  listBackups,
  listServerCores,
  readPlayerLists,
  readProperties,
  readTextFile,
  renameEntry,
  restoreBackup,
  searchModrinth,
  toggleEntry,
  updatePlayer,
  writeProperties,
  writeTextFile,
  type FileEntry,
  type BuildInfo,
  type BackupInfo,
  type CoreInfo,
  type DownloadProgress,
  type PlayerLists,
  type PluginInfo,
  type PluginVersion,
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

export function PluginsManagerView({ instancePath, onError }: CommonProps) {
  const [kind, setKind] = useState<"plugins" | "mods">("plugins");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const load = useCallback(() => {
    listDirectory(instancePath, kind)
      .then(items => setEntries(items.filter(item => !item.isDir && (item.name.endsWith(".jar") || item.name.endsWith(".disabled")))))
      .catch(e => onError(String(e)));
  }, [instancePath, kind, onError]);
  useEffect(() => { if (instancePath) load(); }, [instancePath, load]);
  return <section className="panel manager-panel"><div className="manager-toolbar"><div className="segmented"><button className={kind === "plugins" ? "active" : ""} onClick={() => setKind("plugins")}>插件</button><button className={kind === "mods" ? "active" : ""} onClick={() => setKind("mods")}>模组</button></div><span>{entries.length} 个文件</span><button className="icon-btn" onClick={load}><RefreshCw /></button></div>
    {!instancePath ? <Empty text="请先配置实例目录" /> : <div className="plugin-list-real">{entries.map(entry => <div key={entry.relativePath}><div className={entry.enabled ? "plugin-state enabled" : "plugin-state"}>{entry.enabled ? <Check /> : <X />}</div><div><strong>{entry.name.replace(".disabled", "")}</strong><span>{entry.enabled ? "已启用" : "已禁用"} · {sizeLabel(entry.size)}</span></div><button className="secondary" onClick={() => toggleEntry(instancePath, entry.relativePath).then(load).catch(e => onError(String(e)))}>{entry.enabled ? "禁用" : "启用"}</button><button className="icon-btn" onClick={() => { if (confirm(`删除 ${entry.name}？`)) deleteEntry(instancePath, entry.relativePath).then(load).catch(e => onError(String(e))); }}><Trash2 /></button></div>)}</div>}
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

function Empty({ text }: { text: string }) { return <div className="empty-state"><Folder /><span>{text}</span></div>; }

export function DownloadCenterView({ instancePath, onError }: CommonProps) {
  const [cores, setCores] = useState<CoreInfo[]>([]);
  const [coreName, setCoreName] = useState("");
  const [version, setVersion] = useState("");
  const [builds, setBuilds] = useState<BuildInfo[]>([]);
  const [build, setBuild] = useState("");
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const selected = cores.find(core => core.name === coreName);
  const loadCores = () => listServerCores().then(items => { setCores(items); if (items[0]) setCoreName(items[0].name); }).catch(e => onError(String(e)));
  useEffect(() => { loadCores(); }, []);
  useEffect(() => { if (selected?.mcVersions[0]) setVersion(selected.mcVersions[0]); }, [coreName]);
  useEffect(() => { if (coreName && version) listCoreBuilds(coreName, version).then(items => { setBuilds(items); setBuild(items[0]?.coreVersion ?? ""); }).catch(e => onError(String(e))); }, [coreName, version]);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const pending = listen<DownloadProgress>("download-progress", event => setProgress(event.payload));
    return () => { pending.then(unlisten => unlisten()); };
  }, []);
  const download = () => {
    if (!instancePath) return onError("请先配置实例目录");
    if (!build) return onError("请选择构建版本");
    setProgress({ fileName: "", downloaded: 0, total: 0, percent: 0, status: "starting" });
    downloadServerCore(instancePath, coreName, version, build)
      .then(fileName => setProgress(current => ({ fileName: fileName || current?.fileName || "", downloaded: current?.downloaded ?? 0, total: current?.total ?? 0, percent: 100, status: "completed" })))
      .catch(e => { onError(String(e)); setProgress(null); });
  };
  return <section className="download-layout"><div className="panel download-form"><div className="manager-toolbar"><Download /><strong>服务端核心下载</strong><button className="icon-btn" onClick={loadCores}><RefreshCw /></button></div>
    <label>核心类型<select value={coreName} onChange={e => setCoreName(e.target.value)}>{cores.map(core => <option key={core.name} value={core.name}>{core.recommend ? "推荐 · " : ""}{core.name}</option>)}</select></label>
    <label>Minecraft 版本<select value={version} onChange={e => setVersion(e.target.value)}>{selected?.mcVersions.map(item => <option key={item}>{item}</option>)}</select></label>
    <label>构建版本<select value={build} onChange={e => setBuild(e.target.value)}>{builds.map(item => <option key={item.coreVersion} value={item.coreVersion}>{item.coreVersion} · {item.updateTime.slice(0, 10)}</option>)}</select></label>
    <button className="primary download-button" disabled={!build || progress?.status === "downloading"} onClick={download}><Download />下载到实例目录</button>
  </div><div className="panel download-status"><div className="manager-toolbar"><strong>下载状态</strong></div>{progress ? <div className="progress-view"><strong>{progress.fileName || `${coreName} ${version}`}</strong><div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div><span>{progress.status === "completed" ? "下载完成" : `${progress.percent.toFixed(1)}% · ${sizeLabel(progress.downloaded)} / ${progress.total ? sizeLabel(progress.total) : "未知大小"}`}</span></div> : <Empty text="选择核心版本后下载，文件会保存到实例目录" />}</div></section>;
}

export function PluginMarketView({ instancePath, onError }: CommonProps) {
  const [kind, setKind] = useState<"plugins" | "mods">("plugins");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PluginInfo[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<PluginInfo | null>(null);
  const [versions, setVersions] = useState<PluginVersion[]>([]);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const items = await searchModrinth(query.trim(), kind);
      setResults(items);
      setSelected(null);
      setVersions([]);
    } catch (e) { onError(String(e)); }
    setSearching(false);
  };

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
      <div className="segmented">
        <button className={kind === "plugins" ? "active" : ""} onClick={() => { setKind("plugins"); setResults([]); setSelected(null); }}>插件</button>
        <button className={kind === "mods" ? "active" : ""} onClick={() => { setKind("mods"); setResults([]); setSelected(null); }}>模组</button>
      </div>
      <div className="search" style={{ width: 220, marginLeft: 8 }}>
        <Search size={14} />
        <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && search()} placeholder={`搜索 ${kind === "plugins" ? "插件" : "模组"}...`} />
      </div>
      <button className="primary" onClick={search} disabled={searching}>{searching ? "搜索中..." : "搜索"}</button>
      <span style={{ marginLeft: "auto" }}>{results.length} 个结果</span>
    </div>
    {!instancePath ? <Empty text="请先配置实例目录" /> : selected ? (
      <div>
        <div className="manager-toolbar">
          <button className="icon-btn" onClick={() => setSelected(null)}><ArrowLeft /></button>
          <strong>{selected.title}</strong>
          <span>{versions.length} 个版本</span>
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
