import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  Bot,
  ChevronDown,
  CircleStop,
  Command,
  Cpu,
  Download,
  Folder,
  Gauge,
  HardDrive,
  Info,
  LayoutDashboard,
  Menu,
  MemoryStick,
  Puzzle,
  MoreHorizontal,
  Play,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  TerminalSquare,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { BackupView, CoreTypeView, ExtensionStoreView, JavaDownloadView, PermissionsView, PluginConfigView, PluginMarketView, PluginsManagerView, PropertiesView } from "./ManagementViews";
import { AiAssistant } from "./AiAssistant";
import { PROVIDERS, findProviderById } from "./aiProviders";
import {
  acceptEula,
  checkAgentConnection,
  checkEula,
  connectAgentEvents,
  forceStopServer,
  getAutoRestartConfig,
  getConsole,
  getMetrics,
  getServerStatus,
  isTauriRuntime,
  readProperties,
  sendServerCommand,
  setAutoRestartConfig,
  startServer,
  stopServer,
  writeProperties,
  type AutoRestartConfig,
  type AgentConnection,
  type InstanceConfig,
  type PlatformCapabilities,
  type ServerMetrics,
  type ServerStatus,
} from "./bridge";
import { highlightLine } from "./consoleHighlighter";

type Tab = "overview" | "control" | "instance" | "files" | "software" | "download" | "extensions" | "about";
type InstanceTab = "runtime" | "properties" | "rules" | "optimization";
type FilesTab = "plugins" | "mods" | "backups";
type SoftwareTab = "basic" | "ai";
type DownloadTabKey = "java" | "core" | "plugins" | "mods";

const DEFAULT_INSTANCE: InstanceConfig = {
  name: "我的世界服务器",
  instancePath: "",
  javaPath: "java",
  serverJar: "server.jar",
  minMemoryMb: 2048,
  maxMemoryMb: 8192,
  javaArgs: ["-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled"],
  serverArgs: ["nogui"],
};

function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [instanceTab, setInstanceTab] = useState<InstanceTab>("runtime");
  const [filesTab, setFilesTab] = useState<FilesTab>("plugins");
  const [softwareTab, setSoftwareTab] = useState<SoftwareTab>("basic");
  const [downloadTab, setDownloadTab] = useState<DownloadTabKey>("java");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [instanceMenuOpen, setInstanceMenuOpen] = useState(false);
  const [instances, setInstances] = useState<InstanceConfig[]>([DEFAULT_INSTANCE]);
  const [activeInstanceIndex, setActiveInstanceIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [eulaOpen, setEulaOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<PlatformCapabilities | null>(null);
  const [agentConnection, setAgentConnection] = useState<AgentConnection>({
    status: "connecting",
    message: "正在检查 Agent",
    capabilities: { platform: "web", localServerManagement: false, remoteControl: false },
  });
  const [eventStreamConnected, setEventStreamConnected] = useState(false);
  const [command, setCommand] = useState("");
  const [consoleLines, setConsoleLines] = useState(["[Astrore] 控制台已就绪"]);
  const [metrics, setMetrics] = useState({ tps: 0, mspt: 0, online: 0, maxPlayers: 20, players: [] as string[], uptime: 0 });
  const [sysMetrics, setSysMetrics] = useState<ServerMetrics>({
    cpuPercent: 0, memoryMb: 0, memoryMaxMb: 0, tps: 0, mspt: 0,
    onlinePlayers: 0, maxPlayers: 20, playerList: [], uptimeSecs: 0,
    chunkCount: 0, entityCount: 0, diskFreeGb: 0,
  });
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [autoRestart, setAutoRestart] = useState<AutoRestartConfig>({ enabled: false, maxRestarts: 3, restartDelaySecs: 5 });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [instanceConfig, setInstanceConfig] = useState<InstanceConfig>(DEFAULT_INSTANCE);

  const reconnectAgent = async () => {
    setAgentConnection(current => ({ ...current, status: "connecting", message: "正在检查 Agent" }));
    const connection = await checkAgentConnection();
    setAgentConnection(connection);
    setCapabilities(connection.capabilities);
  };

  useEffect(() => {
    reconnectAgent();
    if (isTauriRuntime()) {
      getServerStatus().then((status) => { setRunning(status.running); if (status.running) setStartedAt(Date.now()); });
    }
    const savedRestart = localStorage.getItem("astrore.autoRestart");
    if (isTauriRuntime() && savedRestart) {
      try {
        const config = JSON.parse(savedRestart) as AutoRestartConfig;
        setAutoRestart(config);
        setAutoRestartConfig(config).catch(() => undefined);
      } catch {
        localStorage.removeItem("astrore.autoRestart");
      }
    } else {
      getAutoRestartConfig().then(setAutoRestart).catch(() => undefined);
    }
    if (!isTauriRuntime()) return;
    const unlistenConsole = listen<string>("server-console", (event) => {
      const line = event.payload;
      setConsoleLines((current) => [...current.slice(-499), line]);
      const performance = line.match(/TPS[\s=]+(\d+(?:\.\d+)?).*?MSPT[\s=]+(\d+(?:\.\d+)?)/i);
      const players = line.match(/There are (\d+) of a max of (\d+) players? online(?::\s*(.+))?/i);
      if (performance) setMetrics(current => ({ ...current, tps: Number(performance[1]), mspt: Number(performance[2]) }));
      if (players) setMetrics(current => ({ ...current, online: Number(players[1]), maxPlayers: Number(players[2]), players: players[3]?.split(",").map(name => name.trim()).filter(Boolean) ?? [] }));
    });
    const unlistenStatus = listen<ServerStatus>("server-status", (event) => {
      setRunning(event.payload.running);
      setStartedAt(event.payload.running ? Date.now() : null);
      if (!event.payload.running) setMetrics(current => ({ ...current, tps: 0, mspt: 0, online: 0, players: [], uptime: 0 }));
    });
    const unlistenMetrics = listen<ServerMetrics>("server-metrics", (event) => {
      setSysMetrics(event.payload);
      setCpuHistory(current => [...current.slice(-17), event.payload.cpuPercent]);
      setMetrics(current => ({
        ...current,
        tps: event.payload.tps || current.tps,
        mspt: event.payload.mspt || current.mspt,
        online: event.payload.onlinePlayers,
        maxPlayers: event.payload.maxPlayers,
        players: event.payload.playerList,
        uptime: event.payload.uptimeSecs,
      }));
    });
    return () => {
      unlistenConsole.then((unlisten) => unlisten());
      unlistenStatus.then((unlisten) => unlisten());
      unlistenMetrics.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() && agentConnection.status === "online") {
      getAutoRestartConfig().then(setAutoRestart).catch(reason => setError(String(reason)));
    }
  }, [agentConnection.status]);

  useEffect(() => {
    if (isTauriRuntime() || agentConnection.status !== "offline") return;
    const timer = window.setTimeout(reconnectAgent, 5000);
    return () => window.clearTimeout(timer);
  }, [agentConnection.status]);

  useEffect(() => {
    if (isTauriRuntime() || agentConnection.status !== "online") return;
    return connectAgentEvents(event => {
      if (event.type === "console") setConsoleLines(current => [...current.slice(-499), event.payload]);
      if (event.type === "console-history") setConsoleLines(event.payload.length ? event.payload : ["[Astrore] 已连接网页 Agent"]);
      if (event.type === "status") {
        setRunning(event.payload.running);
        if (!event.payload.running) setMetrics(current => ({ ...current, tps: 0, mspt: 0, online: 0, players: [], uptime: 0 }));
      }
      if (event.type === "metrics") {
        setSysMetrics(event.payload);
        setCpuHistory(current => [...current.slice(-17), event.payload.cpuPercent]);
        setMetrics(current => ({
          ...current,
          tps: event.payload.tps || current.tps,
          mspt: event.payload.mspt || current.mspt,
          online: event.payload.onlinePlayers,
          maxPlayers: event.payload.maxPlayers,
          players: event.payload.playerList,
          uptime: event.payload.uptimeSecs,
        }));
      }
    }, setEventStreamConnected);
  }, [agentConnection.status]);

  useEffect(() => {
    if (isTauriRuntime() || agentConnection.status !== "online" || eventStreamConnected) return;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const [status, lines, currentMetrics] = await Promise.all([getServerStatus(), getConsole(), getMetrics()]);
        setRunning(status.running);
        setConsoleLines(lines.length ? lines : ["[Astrore] 已连接网页 Agent"]);
        setSysMetrics(currentMetrics);
        setCpuHistory(current => [...current.slice(-17), currentMetrics.cpuPercent]);
        setMetrics(current => ({
          ...current,
          tps: currentMetrics.tps,
          mspt: currentMetrics.mspt,
          online: currentMetrics.onlinePlayers,
          maxPlayers: currentMetrics.maxPlayers,
          players: currentMetrics.playerList,
          uptime: currentMetrics.uptimeSecs,
        }));
      } catch {
        // Capability state already communicates that the Agent is unavailable.
      } finally {
        polling = false;
      }
    };
    poll();
    const timer = window.setInterval(poll, 10000);
    return () => window.clearInterval(timer);
  }, [agentConnection.status, eventStreamConnected]);

  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setMetrics(current => ({ ...current, uptime: Math.floor((Date.now() - startedAt) / 1000) })), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  useEffect(() => {
    const savedInstances = localStorage.getItem("astrore.instances");
    const savedIndex = Number(localStorage.getItem("astrore.activeInstance") ?? 0);
    if (savedInstances) {
      try {
        const parsed = JSON.parse(savedInstances) as InstanceConfig[];
        if (parsed.length) {
          const index = Math.min(Math.max(savedIndex, 0), parsed.length - 1);
          setInstances(parsed);
          setActiveInstanceIndex(index);
          setInstanceConfig(parsed[index]);
          return;
        }
      } catch {
        localStorage.removeItem("astrore.instances");
      }
    }
    const saved = localStorage.getItem("astrore.instance");
    if (!saved) return;
    try {
      const migrated = JSON.parse(saved) as InstanceConfig;
      setInstances([migrated]);
      setInstanceConfig(migrated);
    } catch {
      localStorage.removeItem("astrore.instance");
    }
  }, []);

  const activeInstance = useMemo(() => ({ name: instanceConfig.name, type: instanceConfig.serverJar }), [instanceConfig.name, instanceConfig.serverJar]);
  const agentAvailable = isTauriRuntime() || agentConnection.status === "online";
  const resourceAlerts = useMemo(() => {
    if (!running) return [];
    const alerts: string[] = [];
    if (sysMetrics.cpuPercent >= 90) alerts.push(`CPU 使用率过高：${sysMetrics.cpuPercent.toFixed(1)}%`);
    if (sysMetrics.memoryMaxMb > 0 && sysMetrics.memoryMb / sysMetrics.memoryMaxMb >= 0.9) alerts.push(`内存接近上限：${sysMetrics.memoryMb.toFixed(0)} / ${sysMetrics.memoryMaxMb.toFixed(0)} MB`);
    if (sysMetrics.diskFreeGb > 0 && sysMetrics.diskFreeGb < 5) alerts.push(`磁盘空间不足：仅剩 ${sysMetrics.diskFreeGb.toFixed(1)} GB`);
    if (metrics.tps > 0 && metrics.tps < 15) alerts.push(`TPS 偏低：${metrics.tps.toFixed(2)}`);
    return alerts;
  }, [running, sysMetrics.cpuPercent, sysMetrics.memoryMb, sysMetrics.memoryMaxMb, sysMetrics.diskFreeGb, metrics.tps]);
  const mode = capabilities?.localServerManagement ? "本地控制" : capabilities?.remoteControl ? "远程控制" : "预览模式";
  const title = useMemo(
    () =>
      ({
        overview: "运行概览",
        control: "控制面板",
        instance: "实例配置",
        files: "文件管理",
        software: "软件设置",
        download: "下载中心",
        extensions: "扩展商店",
        about: "关于 Astrore",
      })[tab],
    [tab],
  );

  const start = async () => {
    if (running) return;
    if (!agentAvailable) return setError("Agent 未连接，请先在软件设置中配置并启动 Agent");
    setError("");
    try {
      const eula = await checkEula(instanceConfig.instancePath);
      if (eula.accepted) {
        const status = await startServer(instanceConfig);
        setRunning(status.running);
        setStartedAt(Date.now());
      } else {
        setEulaOpen(true);
      }
    } catch (reason) {
      setError(String(reason));
    }
  };

  const confirmEula = async () => {
    setError("");
    try {
      await acceptEula(instanceConfig.instancePath);
      setEulaOpen(false);
      const status = await startServer(instanceConfig);
      setRunning(status.running);
      setStartedAt(Date.now());
    } catch (reason) {
      setEulaOpen(false);
      setError(String(reason));
    }
  };

  const sendCommand = async (override?: string) => {
    const value = (override ?? command).trim();
    if (!value) return;
    if (!agentAvailable) return setError("Agent 未连接，无法发送命令");
    try {
      await sendServerCommand(value);
      setConsoleLines((current) => [...current, `> ${value}`]);
      setCommand("");
    } catch (reason) {
      setError(String(reason));
    }
  };

  const stop = async () => {
    setError("");
    try {
      await stopServer();
      setConsoleLines((current) => [...current, "[Astrore] 正在等待服务端安全停止"]);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const forceStop = async () => {
    setError("");
    try {
      await forceStopServer();
      setRunning(false);
      setStartedAt(null);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const persistInstances = (next: InstanceConfig[], index: number) => {
    localStorage.setItem("astrore.instances", JSON.stringify(next));
    localStorage.setItem("astrore.activeInstance", String(index));
    localStorage.setItem("astrore.instance", JSON.stringify(next[index]));
  };

  const saveInstance = () => {
    const next = instances.map((item, index) => index === activeInstanceIndex ? instanceConfig : item);
    setInstances(next);
    persistInstances(next, activeInstanceIndex);
  };

  const switchInstance = (index: number) => {
    if (running) return setError("请先停止当前服务器再切换实例");
    const next = instances.map((item, itemIndex) => itemIndex === activeInstanceIndex ? instanceConfig : item);
    setInstances(next);
    setActiveInstanceIndex(index);
    setInstanceConfig(next[index]);
    persistInstances(next, index);
    setInstanceMenuOpen(false);
  };

  const addInstance = () => {
    if (running) return setError("请先停止当前服务器再新建实例");
    const name = prompt("新实例名称", `Minecraft 服务器 ${instances.length + 1}`)?.trim();
    if (!name) return;
    const next = [...instances.map((item, index) => index === activeInstanceIndex ? instanceConfig : item), { ...DEFAULT_INSTANCE, name }];
    const index = next.length - 1;
    setInstances(next);
    setActiveInstanceIndex(index);
    setInstanceConfig(next[index]);
    persistInstances(next, index);
    setInstanceMenuOpen(false);
    setTab("instance");
    setInstanceTab("runtime");
  };

  const deleteActiveInstance = () => {
    if (running) return setError("请先停止当前服务器再删除实例");
    if (instances.length === 1) return setError("至少需要保留一个实例");
    if (!confirm(`确定从启动器中移除实例“${instanceConfig.name}”？服务器文件不会被删除。`)) return;
    const next = instances.filter((_, index) => index !== activeInstanceIndex);
    const index = Math.min(activeInstanceIndex, next.length - 1);
    setInstances(next);
    setActiveInstanceIndex(index);
    setInstanceConfig(next[index]);
    persistInstances(next, index);
    setInstanceMenuOpen(false);
  };

  const searchNavigate = () => {
    const query = searchQuery.trim().toLowerCase();
    const routes: Array<[string[], Tab]> = [
      [["控制台", "命令", "console", "面板"], "control"], [["下载", "核心", "market", "java"], "download"],
      [["文件", "备份", "backup", "插件", "模组", "mod", "plugin"], "files"],
      [["AI", "助手", "诊断", "报错分析", "厂商"], "software"],
      [["配置", "properties", "玩家", "权限", "白名单", "op", "实例"], "instance"],
      [["商店", "扩展"], "extensions"], [["关于", "readme"], "about"],
    ];
    const result = routes.find(([keywords]) => keywords.some(keyword => query.includes(keyword)));
    if (result) {
      setTab(result[1]);
      setSearchQuery("");
    } else if (query) {
      setError(`未找到与“${searchQuery.trim()}”匹配的功能`);
    }
  };

  return (
    <div className="app-shell">
      <aside className={sidebarOpen ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <img src="/astrore-icon.png" alt="" />
          <div>
            <strong>Astrore</strong>
            <span>Control Center</span>
          </div>
          <button className="icon-btn mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭菜单">
            <X size={18} />
          </button>
        </div>

        <div className="instance-switcher-wrap">
          <button className="instance-switcher" onClick={() => setInstanceMenuOpen(current => !current)}>
            <span className={running ? "status-dot online" : "status-dot"} />
            <span className="instance-switcher-copy">
              <strong>{activeInstance.name}</strong>
              <span>{activeInstance.type}</span>
            </span>
            <ChevronDown size={16} />
          </button>
          {instanceMenuOpen && <div className="instance-menu">
            {instances.map((instance, index) => <button className={index === activeInstanceIndex ? "active" : ""} key={`${instance.name}-${index}`} onClick={() => switchInstance(index)}>
              <Server /><span><strong>{instance.name}</strong><small>{instance.instancePath || "未配置目录"}</small></span>
            </button>)}
            <div className="instance-menu-actions">
              <button onClick={addInstance}>新建实例</button>
              <button onClick={deleteActiveInstance}>移除当前实例</button>
            </div>
          </div>}
        </div>

        <nav>
          <NavButton icon={<LayoutDashboard />} label="运行概况" active={tab === "overview"} onClick={() => setTab("overview")} />
          <NavButton icon={<TerminalSquare />} label="控制面板" active={tab === "control"} onClick={() => setTab("control")} />
          <NavButton icon={<Server />} label="实例配置" active={tab === "instance"} onClick={() => setTab("instance")} />
          <NavButton icon={<Folder />} label="文件管理" active={tab === "files"} onClick={() => setTab("files")} />
          <NavButton icon={<Settings />} label="软件设置" active={tab === "software"} onClick={() => setTab("software")} />
          <NavButton icon={<Download />} label="下载中心" active={tab === "download"} onClick={() => setTab("download")} />
          <NavButton icon={<Puzzle />} label="扩展商店" active={tab === "extensions"} onClick={() => setTab("extensions")} />
          <NavButton icon={<Info />} label="关于我们" active={tab === "about"} onClick={() => setTab("about")} />
        </nav>

        <div className="sidebar-bottom">
          <div className={`agent-state ${agentConnection.status}`}>
            {agentConnection.status === "online" || agentConnection.status === "local" ? <Wifi size={18} /> : agentConnection.status === "connecting" ? <RefreshCw size={18} /> : <WifiOff size={18} />}
            <div>
              <strong>{agentConnection.message}</strong>
              <span>{mode} · {capabilities?.platform ?? "检测平台中"}{agentConnection.status === "online" ? ` · ${eventStreamConnected ? "实时推送" : "轮询回退 / 重连中"}` : ""}</span>
            </div>
            {!isTauriRuntime() && <button className="agent-reconnect" onClick={reconnectAgent} disabled={agentConnection.status === "connecting"} title="重新连接"><RefreshCw size={14} /></button>}
          </div>
          <div className="profile">
            <span>OW</span>
            <div><strong>管理员</strong><small>本地账户</small></div>
            <MoreHorizontal size={16} />
          </div>
        </div>
      </aside>

      <main>
        <header>
          <button className="icon-btn mobile-only" onClick={() => setSidebarOpen(true)} aria-label="打开菜单">
            <Menu size={20} />
          </button>
          <div className="page-title">
            <span>实例 / {activeInstance.name}</span>
            <h1>{title}</h1>
          </div>
          <div className="header-actions">
            <label className="search">
              <Search size={16} />
              <input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} onKeyDown={event => event.key === "Enter" && searchNavigate()} placeholder="搜索功能并按 Enter" />
            </label>
          </div>
        </header>

        <div className="content">
          {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}><X size={16} /></button></div>}
          {!isTauriRuntime() && agentConnection.status !== "online" && <div className={`connection-banner ${agentConnection.status}`}>
            <div>{agentConnection.status === "connecting" ? <RefreshCw /> : <WifiOff />}<span><strong>{agentConnection.message}</strong><small>网页界面仍可浏览，服务器管理操作将在 Agent 连接后启用。</small></span></div>
            <button className="secondary" onClick={reconnectAgent} disabled={agentConnection.status === "connecting"}><RefreshCw />重新连接</button>
          </div>}
          {resourceAlerts.length > 0 && <div className="resource-alert"><Activity /><div><strong>资源状态需要关注</strong><span>{resourceAlerts.join(" · ")}</span></div></div>}
          {tab === "overview" && (
            <>
              <section className="control-strip">
                <div className="server-identity">
                  <div className={running ? "server-mark running" : "server-mark"}><Server /></div>
                  <div>
                    <div className="eyebrow">{running ? "服务器运行中" : "服务器已停止"}</div>
                    <h2>{activeInstance.name}</h2>
                    <p>{instanceConfig.serverJar} · {instanceConfig.javaPath || "java"} · 运行 {Math.floor(metrics.uptime / 60)} 分钟</p>
                  </div>
                </div>
                <div className="control-actions">
                  {running ? (
                    <>
                      <button className="secondary" onClick={forceStop}><CircleStop size={17} />强制终止</button>
                      <button className="danger" onClick={stop}><CircleStop size={17} />安全停止</button>
                    </>
                  ) : (
                    <button className="primary" disabled={!agentAvailable} onClick={start}><Play size={17} />启动服务端</button>
                  )}
                </div>
              </section>

              <section className="metrics-grid">
                <Metric icon={<Cpu />} label="进程状态" value={running ? "运行中" : "已停止"} detail={running ? `CPU ${sysMetrics.cpuPercent.toFixed(1)}% · ${Math.floor(metrics.uptime / 60)} 分钟` : "等待启动"} progress={running ? Math.min(100, sysMetrics.cpuPercent) : 0} tone="green" />
                <Metric icon={<MemoryStick />} label="内存使用" value={running ? `${sysMetrics.memoryMb.toFixed(0)} MB` : `${instanceConfig.maxMemoryMb} MB`} detail={running ? `上限 ${sysMetrics.memoryMaxMb.toFixed(0)} MB · 最小 ${instanceConfig.minMemoryMb} MB` : `分配 ${instanceConfig.minMemoryMb} - ${instanceConfig.maxMemoryMb} MB`} progress={running && sysMetrics.memoryMaxMb > 0 ? sysMetrics.memoryMb / sysMetrics.memoryMaxMb * 100 : instanceConfig.minMemoryMb / instanceConfig.maxMemoryMb * 100} tone="blue" />
                <Metric icon={<Gauge />} label="TPS" value={metrics.tps ? metrics.tps.toFixed(2) : "--"} detail={metrics.mspt ? `MSPT ${metrics.mspt.toFixed(1)} ms` : "等待性能输出"} progress={metrics.tps / 20 * 100} tone="amber" />
                <Metric icon={<Users />} label="在线玩家" value={String(metrics.online)} detail={`上限 ${metrics.maxPlayers} 人`} progress={metrics.online / metrics.maxPlayers * 100} tone="red" />
              </section>

              <section className="dashboard-grid">
                <div className="panel console-panel">
                  <PanelHeader icon={<TerminalSquare />} title="控制台" action="打开控制面板" onAction={() => setTab("control")} />
                  <Console lines={consoleLines} command={command} setCommand={setCommand} sendCommand={sendCommand} />
                </div>
                <div className="panel">
                  <PanelHeader icon={<Users />} title="在线玩家" action={`${metrics.online} 人在线`} />
                  <div className="player-list">
                    {(metrics.players.length ? metrics.players : ["暂无在线玩家"]).map((player, index) => (
                      <div className="player" key={player}>
                        <span className={`avatar a${index}`}>{player.slice(0, 2).toUpperCase()}</span>
                        <div><strong>{player}</strong><span>{metrics.players.length ? "在线" : "服务端返回 list 后显示玩家"}</span></div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="panel health-panel">
                  <PanelHeader icon={<Activity />} title="运行状态" action="最近 15 分钟" />
                  <div className="chart-bars">
                    {(cpuHistory.length ? cpuHistory : [0]).map((cpu, index) => (
                      <i key={index} style={{ height: `${Math.min(100, Math.max(3, cpu))}%` }} />
                    ))}
                  </div>
                  <div className="health-footer">
                    <span><i className="legend green" />CPU 使用率</span>
                    <strong>{running ? "接收实时输出" : "等待启动"}</strong>
                  </div>
                </div>
                <div className="panel">
                  <PanelHeader icon={<HardDrive />} title="存储空间" action="管理文件" onAction={() => { setTab("files"); setFilesTab("backups"); }} />
                  <div className="storage-ring"><strong>{sysMetrics.diskFreeGb ? sysMetrics.diskFreeGb.toFixed(1) : "--"}</strong><span>GB 可用</span></div>
                  <div className="storage-info">
                    <div><span>实例目录</span><strong>{instanceConfig.instancePath || "未配置"}</strong></div>
                    <div><span>服务端核心</span><strong>{instanceConfig.serverJar}</strong></div>
                    <div><span>Java</span><strong>{instanceConfig.javaPath || "java"}</strong></div>
                  </div>
                </div>
              </section>
            </>
          )}

          {tab === "control" && <ControlPanel lines={consoleLines} command={command} setCommand={setCommand} sendCommand={sendCommand} running={running} start={start} stop={stop} forceStop={forceStop} metrics={sysMetrics} instance={instanceConfig} onError={setError} />}
          {tab === "download" && <DownloadTab subTab={downloadTab} setSubTab={setDownloadTab} instancePath={instanceConfig.instancePath} onError={setError} />}
          {tab === "files" && <FilesHub subTab={filesTab} setSubTab={setFilesTab} instancePath={instanceConfig.instancePath} onError={setError} />}
          {tab === "extensions" && <ExtensionStoreView onError={setError} />}
          {tab === "instance" && <InstanceConfigView subTab={instanceTab} setSubTab={setInstanceTab} mode={mode} config={instanceConfig} onChange={setInstanceConfig} onSave={saveInstance} instancePath={instanceConfig.instancePath} onError={setError} autoRestart={autoRestart} onAutoRestartChange={(c) => { setAutoRestart(c); localStorage.setItem("astrore.autoRestart", JSON.stringify(c)); setAutoRestartConfig(c).catch(reason => setError(String(reason))); }} />}
          {tab === "about" && <AboutView />}
          {tab === "software" && <SoftwareSettingsView subTab={softwareTab} setSubTab={setSoftwareTab} autoRestart={autoRestart} onAutoRestartChange={(c) => { setAutoRestart(c); localStorage.setItem("astrore.autoRestart", JSON.stringify(c)); setAutoRestartConfig(c).catch(reason => setError(String(reason))); }} />}
        </div>
      </main>

      {eulaOpen && <EulaModal onCancel={() => setEulaOpen(false)} onConfirm={confirmEula} />}
      {sidebarOpen && <button className="scrim" onClick={() => setSidebarOpen(false)} aria-label="关闭菜单" />}
    </div>
  );
}

function NavButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return <button className={active ? "nav-item active" : "nav-item"} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function TopTabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ key: T; label: string }>; value: T; onChange: (key: T) => void }) {
  return <div className="top-tabs">{tabs.map(item => <button key={item.key} className={value === item.key ? "active" : ""} onClick={() => onChange(item.key)}>{item.label}</button>)}</div>;
}

function Metric({ icon, label, value, detail, progress, tone }: { icon: React.ReactNode; label: string; value: string; detail: string; progress: number; tone: string }) {
  return <div className="metric"><div className={`metric-icon ${tone}`}>{icon}</div><div className="metric-copy"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div><div className="meter"><i className={tone} style={{ width: `${progress}%` }} /></div></div>;
}

function PanelHeader({ icon, title, action, onAction }: { icon: React.ReactNode; title: string; action: string; onAction?: () => void }) {
  return <div className="panel-header"><div>{icon}<strong>{title}</strong></div>{onAction ? <button onClick={onAction}>{action}</button> : <span>{action}</span>}</div>;
}

function Console({ lines, command, setCommand, sendCommand, maxLines = 6 }: { lines: string[]; command: string; setCommand: (value: string) => void; sendCommand: (override?: string) => void; maxLines?: number }) {
  return <><div className="console">{lines.slice(-maxLines).map((line, index) => <code key={index} dangerouslySetInnerHTML={{ __html: highlightLine(line) }} />)}</div><div className="command-bar"><Command size={16} /><input value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendCommand()} placeholder="输入服务端命令" /><button onClick={() => sendCommand()}>发送</button></div></>;
}

function ControlPanel({ lines, command, setCommand, sendCommand, running, start, stop, forceStop, metrics, instance, onError }: Parameters<typeof Console>[0] & { running: boolean; start: () => void; stop: () => void; forceStop: () => void; metrics: ServerMetrics; instance: InstanceConfig; onError: (message: string) => void }) {
  const [prefix, setPrefix] = useState("/");
  const [colorText, setColorText] = useState(true);
  const [followScroll, setFollowScroll] = useState(true);
  const [showPlayers, setShowPlayers] = useState(true);
  const [crashRestart, setCrashRestart] = useState(() => localStorage.getItem("astrore.control.crashRestart") === "true");
  const sendWithPrefix = () => {
    const value = command.trim();
    if (!value) return;
    sendCommand(prefix === "/" && value.startsWith("/") ? value.slice(1) : `${prefix === "/" ? "" : prefix}${value}`);
  };
  const players = metrics.playerList.length ? metrics.playerList : [];
  return <section className="control-panel-grid">
    <div className="panel control-console-panel">
      <div className="control-console-title">
        <div><TerminalSquare /><strong>服务端控制台</strong></div>
        <span>控制台配色 · {running ? "运行中" : "未启动"}</span>
      </div>
      <div className={colorText ? "console console-light colored" : "console console-light"}>
        {lines.slice(-500).map((line, index) => colorText ? <code key={index} dangerouslySetInnerHTML={{ __html: highlightLine(line) }} /> : <code key={index}>{line}</code>)}
      </div>
      <div className="control-command-row">
        <select value={prefix} onChange={event => setPrefix(event.target.value)}>
          <option value="/">/</option>
          <option value="">无前缀</option>
          <option value="say ">say</option>
          <option value="op ">op</option>
        </select>
        <input value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendWithPrefix()} placeholder="将命令发送至服务端，方向键可以选择已发送的命令，回车快速发送" />
        <button className="primary" onClick={sendWithPrefix}>发送 (Enter)</button>
      </div>
      <div className="control-actions-row">
        <button className="secondary" disabled={running} onClick={start}>启动服务端</button>
        <button className="secondary" disabled={!running} onClick={stop}>关闭服务端</button>
        <button className="secondary" disabled={!running} onClick={async () => { await stop(); window.setTimeout(start, 1800); }}>重启服务端</button>
        <button className="danger" disabled={!running} onClick={forceStop}>强制关闭服务端</button>
        <label><input type="checkbox" checked={colorText} onChange={e => setColorText(e.target.checked)} />文本上色</label>
        <label><input type="checkbox" checked={followScroll} onChange={e => setFollowScroll(e.target.checked)} />跟随滚动</label>
        <label><input type="checkbox" checked={showPlayers} onChange={e => setShowPlayers(e.target.checked)} />玩家列表</label>
        <label><input type="checkbox" checked={crashRestart} onChange={e => { setCrashRestart(e.target.checked); localStorage.setItem("astrore.control.crashRestart", String(e.target.checked)); }} />崩溃重启</label>
      </div>
      <div className="control-status-bar"><span>Tips: {running ? "服务端正在运行，输入 list 可刷新玩家列表。" : "点击启动服务端，首次启动会弹出 EULA 确认。"}</span><span>CPU.{metrics.cpuPercent.toFixed(1)}%</span><span>RAM.{metrics.memoryMaxMb > 0 ? Math.min(100, metrics.memoryMb / metrics.memoryMaxMb * 100).toFixed(0) : "0"}%</span></div>
    </div>
    <aside className="control-side">
      {showPlayers && <div className="panel player-table-panel">
        <div className="player-table-head"><strong>玩家名称</strong><strong>IP地址</strong></div>
        <div className="player-table-body">{players.length ? players.map(player => <div key={player}><span>{player}</span><span>--</span></div>) : <div><span>暂无在线玩家</span><span>--</span></div>}</div>
      </div>}
      <AiAssistant instance={instance} running={running} metrics={metrics} consoleLines={lines} onError={onError} />
    </aside>
  </section>;
}

function InstanceConfigView({ subTab, setSubTab, mode, config, onChange, onSave, instancePath, onError, autoRestart, onAutoRestartChange }: { subTab: InstanceTab; setSubTab: (tab: InstanceTab) => void; mode: string; config: InstanceConfig; onChange: (config: InstanceConfig) => void; onSave: () => void; instancePath: string; onError: (message: string) => void; autoRestart: AutoRestartConfig; onAutoRestartChange: (config: AutoRestartConfig) => void }) {
  const update = (value: Partial<InstanceConfig>) => onChange({ ...config, ...value });
  return <section className="hub-page">
    <TopTabs<InstanceTab> value={subTab} onChange={setSubTab} tabs={[
      { key: "runtime", label: "本体设置" },
      { key: "properties", label: "server.properties 配置" },
      { key: "rules", label: "服务器规则设置" },
      { key: "optimization", label: "Paper 等端优化设置" },
    ]} />
    {subTab === "runtime" && <div className="instance-runtime-grid">
      <div className="panel settings-form"><PanelHeader icon={<Settings />} title="本体设置" action={mode} />
        <div className="fieldset-title">调用 Java</div>
        <div className="inline-field-row"><select value={config.javaPath === "java" ? "default" : "custom"} onChange={event => update({ javaPath: event.target.value === "default" ? "java" : config.javaPath })}><option value="default">默认使用 [JAVA] 环境</option><option value="custom">自定义路径</option></select><button className="secondary" onClick={() => update({ javaPath: "java" })}>刷新</button><button className="secondary" onClick={() => update({ javaPath: prompt("Java 路径", config.javaPath) || config.javaPath })}>自定义路径</button></div>
        <label>Java 路径<input value={config.javaPath} onChange={(event) => update({ javaPath: event.target.value })} /></label>
        <div className="fieldset-title">软件窗口设置</div>
        <div className="check-grid"><label><input type="checkbox" />窗口置顶</label><label><input type="checkbox" defaultChecked />启动时开服</label><label><input type="checkbox" />最小化到托盘</label><label><input type="checkbox" />同目录禁止多开</label></div>
        <div className="fieldset-title">服务端编码设置</div>
        <div className="check-grid"><label><input type="radio" name="display-encoding" defaultChecked />显示编码：系统默认</label><label><input type="radio" name="display-encoding" />UTF-8</label><label><input type="radio" name="send-encoding" defaultChecked />发送编码：系统默认</label><label><input type="radio" name="send-encoding" />UTF-8</label></div>
        <div className="fieldset-title">服务端额外启动参数</div>
        <label>JVM 参数<textarea value={config.javaArgs.join(" ")} onChange={(event) => update({ javaArgs: event.target.value.split(/\s+/).filter(Boolean) })} /></label>
        <label>服务端参数<input value={config.serverArgs.join(" ")} onChange={(event) => update({ serverArgs: event.target.value.split(/\s+/).filter(Boolean) })} /></label>
      </div>
      <div className="panel settings-form"><PanelHeader icon={<Server />} title="服务端核心" action={config.serverJar || "未配置"} />
        <label>实例名称<input value={config.name} onChange={(event) => update({ name: event.target.value })} /></label>
        <label>服务端目录<input value={config.instancePath} onChange={(event) => update({ instancePath: event.target.value })} placeholder="例如 D:\Minecraft\server" /></label>
        <label>服务端核心<input value={config.serverJar} onChange={(event) => update({ serverJar: event.target.value })} /></label>
        <div className="fieldset-title">内存设置（0 为自动分配）</div>
        <div className="form-grid"><label>最大内存<input type="number" min="0" value={config.maxMemoryMb} onChange={(event) => update({ maxMemoryMb: Number(event.target.value) })} /></label><label>最小内存<input type="number" min="0" value={config.minMemoryMb} onChange={(event) => update({ minMemoryMb: Number(event.target.value) })} /></label></div>
        <div className="fieldset-title">关服超时强制结束</div>
        <div className="setting-row"><div><span>崩溃自动重启</span><small>服务端意外退出时自动重新启动</small></div><input type="checkbox" checked={autoRestart.enabled} onChange={(e) => onAutoRestartChange({ ...autoRestart, enabled: e.target.checked })} /></div>
        <div className="form-grid"><label>最大重启次数<input type="number" min={1} max={10} value={autoRestart.maxRestarts} onChange={(e) => onAutoRestartChange({ ...autoRestart, maxRestarts: Number(e.target.value) })} /></label><label>重启延迟（秒）<input type="number" min={1} max={60} value={autoRestart.restartDelaySecs} onChange={(e) => onAutoRestartChange({ ...autoRestart, restartDelaySecs: Number(e.target.value) })} /></label></div>
        <label>自定义副标题<input placeholder="[灵工艺] 我的世界开服器 - 自定义副标题" /></label>
        <div className="form-actions"><button className="secondary" onClick={() => update({ javaPath: "java", serverJar: "server.jar", minMemoryMb: 2048, maxMemoryMb: 8192, javaArgs: ["-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled"], serverArgs: ["nogui"] })}>恢复默认</button><button className="primary" onClick={onSave}>保存设置</button></div>
      </div>
    </div>}
    {subTab === "properties" && <PropertiesView instancePath={instancePath} onError={onError} />}
    {subTab === "rules" && <RulesSettingsView instancePath={instancePath} onError={onError} />}
    {subTab === "optimization" && <div className="panel settings-form"><PanelHeader icon={<Gauge />} title="Paper / Purpur 优化建议" action="配置模板" />
      <div className="setting-row"><div><span>推荐使用 Aikar G1GC 参数</span><small>适合大多数 Paper/Folia/Purpur 服务端，保存后写入 JVM 参数。</small></div><button className="secondary" onClick={() => update({ javaArgs: ["-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled", "-XX:MaxGCPauseMillis=200", "-XX:+UnlockExperimentalVMOptions", "-XX:+DisableExplicitGC"] })}>应用</button></div>
      <div className="setting-row"><div><span>降低 entity-activation-range</span><small>后续会写入 paper-world-defaults.yml / spigot.yml。</small></div><input type="checkbox" /></div>
      <div className="setting-row"><div><span>限制 hopper 检测频率</span><small>适合生电较多但不追求完全原版行为的服务器。</small></div><input type="checkbox" /></div>
      <div className="setting-row"><div><span>启用 Paper 配置备份</span><small>改写优化项前保存原配置，避免误操作。</small></div><input type="checkbox" defaultChecked /></div>
      <div className="form-actions"><button className="primary" onClick={onSave}>保存当前 JVM 参数</button></div>
    </div>}
  </section>;
}

function RulesSettingsView({ instancePath, onError }: { instancePath: string; onError: (message: string) => void }) {
  const [properties, setProperties] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    if (!instancePath) {
      setProperties({});
      setLoaded(false);
      return;
    }
    try {
      setProperties(await readProperties(instancePath));
      setLoaded(true);
    } catch (error) {
      onError(String(error));
    }
  };

  useEffect(() => { load(); }, [instancePath]);

  const update = (key: string, value: string) => setProperties(current => ({ ...current, [key]: value }));
  const save = async () => {
    if (!instancePath) return onError("请先配置实例目录");
    setSaving(true);
    try {
      await writeProperties(instancePath, properties);
      setLoaded(true);
    } catch (error) {
      onError(String(error));
    } finally {
      setSaving(false);
    }
  };

  const bool = (key: string, fallback = "false") => properties[key] ?? fallback;
  return <section className="rules-layout">
    <div className="panel settings-form">
      <PanelHeader icon={<ShieldCheck />} title="服务器规则设置" action={loaded ? "server.properties" : "等待读取"} />
      <div className="form-grid">
        <label>玩家游戏模式<select value={properties.gamemode ?? "survival" } onChange={event => update("gamemode", event.target.value)}><option value="survival">生存</option><option value="creative">创造</option><option value="adventure">冒险</option><option value="spectator">旁观</option></select></label>
        <label>游戏世界难度<select value={properties.difficulty ?? "easy"} onChange={event => update("difficulty", event.target.value)}><option value="peaceful">和平</option><option value="easy">简单</option><option value="normal">普通</option><option value="hard">困难</option></select></label>
        <label>最大玩家数量<input type="number" min="1" value={properties["max-players"] ?? "20"} onChange={event => update("max-players", event.target.value)} /></label>
        <label>服务端端口<input type="number" min="1" max="65535" value={properties["server-port"] ?? "25565"} onChange={event => update("server-port", event.target.value)} /></label>
      </div>
      <div className="check-grid">
        <label><input type="checkbox" checked={bool("online-mode", "true") === "true"} onChange={event => update("online-mode", String(event.target.checked))} />启用正版验证</label>
        <label><input type="checkbox" checked={bool("white-list") === "true"} onChange={event => update("white-list", String(event.target.checked))} />启用白名单</label>
        <label><input type="checkbox" checked={bool("pvp", "true") === "true"} onChange={event => update("pvp", String(event.target.checked))} />允许 PVP</label>
        <label><input type="checkbox" checked={bool("enable-command-block") === "true"} onChange={event => update("enable-command-block", String(event.target.checked))} />启用命令方块</label>
        <label><input type="checkbox" checked={bool("allow-flight") === "true"} onChange={event => update("allow-flight", String(event.target.checked))} />允许飞行</label>
        <label><input type="checkbox" checked={bool("spawn-animals", "true") === "true"} onChange={event => update("spawn-animals", String(event.target.checked))} />生成动物</label>
        <label><input type="checkbox" checked={bool("spawn-monsters", "true") === "true"} onChange={event => update("spawn-monsters", String(event.target.checked))} />生成怪物</label>
        <label><input type="checkbox" checked={bool("enable-rcon") === "true"} onChange={event => update("enable-rcon", String(event.target.checked))} />启用 RCON</label>
      </div>
      <label>服务器 MOTD<input value={properties.motd ?? ""} onChange={event => update("motd", event.target.value)} placeholder="A Minecraft Server" /></label>
      <div className="form-actions"><button className="secondary" disabled={!instancePath || saving} onClick={load}>重新读取</button><button className="primary" disabled={!instancePath || saving} onClick={save}>{saving ? "保存中..." : "保存规则"}</button></div>
    </div>
    <PermissionsView instancePath={instancePath} onError={onError} />
  </section>;
}

function FilesHub({ subTab, setSubTab, instancePath, onError }: { subTab: FilesTab; setSubTab: (tab: FilesTab) => void; instancePath: string; onError: (msg: string) => void }) {
  const [pluginMode, setPluginMode] = useState<"toggle" | "config">("toggle");
  const [modMode, setModMode] = useState<"toggle" | "config">("toggle");
  return <section className="hub-page">
    <TopTabs<FilesTab> value={subTab} onChange={setSubTab} tabs={[
      { key: "plugins", label: "插件管理" },
      { key: "mods", label: "模组管理" },
      { key: "backups", label: "文件备份管理" },
    ]} />
    {subTab === "plugins" && <div className="nested-tab-page"><div className="segmented"><button className={pluginMode === "toggle" ? "active" : ""} onClick={() => setPluginMode("toggle")}>插件启动</button><button className={pluginMode === "config" ? "active" : ""} onClick={() => setPluginMode("config")}>插件配置</button></div>{pluginMode === "toggle" ? <PluginsManagerView kind="plugins" instancePath={instancePath} onError={onError} /> : <PluginConfigView kind="plugins" instancePath={instancePath} onError={onError} />}</div>}
    {subTab === "mods" && <div className="nested-tab-page"><div className="segmented"><button className={modMode === "toggle" ? "active" : ""} onClick={() => setModMode("toggle")}>模组启动</button><button className={modMode === "config" ? "active" : ""} onClick={() => setModMode("config")}>模组配置</button></div>{modMode === "toggle" ? <PluginsManagerView kind="mods" instancePath={instancePath} onError={onError} /> : <PluginConfigView kind="mods" instancePath={instancePath} onError={onError} />}</div>}
    {subTab === "backups" && <BackupView instancePath={instancePath} onError={onError} />}
  </section>;
}

function DownloadTab({ subTab, setSubTab, instancePath, onError }: { subTab: DownloadTabKey; setSubTab: (tab: DownloadTabKey) => void; instancePath: string; onError: (msg: string) => void }) {
  return <section className="hub-page">
    <TopTabs<DownloadTabKey> value={subTab} onChange={setSubTab} tabs={[
      { key: "java", label: "Java 下载" },
      { key: "core", label: "核心下载" },
      { key: "plugins", label: "插件下载" },
      { key: "mods", label: "模组下载" },
    ]} />
    {subTab === "java" && <JavaDownloadView onError={onError} />}
    {subTab === "core" && <CoreTypeView instancePath={instancePath} onError={onError} />}
    {subTab === "plugins" && <PluginMarketView kind="plugins" instancePath={instancePath} onError={onError} />}
    {subTab === "mods" && <PluginMarketView kind="mods" instancePath={instancePath} onError={onError} />}
  </section>;
}

function EulaModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return <div className="modal-layer"><div className="modal"><div className="modal-icon"><ShieldCheck /></div><div><span className="eyebrow">首次启动确认</span><h2>Minecraft EULA</h2><p>该实例尚未接受 Minecraft 最终用户许可协议。只有在你已阅读并接受协议后，Astrore 才会写入 <code>eula=true</code> 并启动服务器。</p><a href="https://aka.ms/MinecraftEULA" target="_blank">查看 Minecraft EULA</a></div><div className="modal-actions"><button className="secondary" onClick={onCancel}>取消</button><button className="primary" onClick={onConfirm}>我已阅读并接受</button></div></div></div>;
}

function AboutView() {
  return <section className="about-page"><div className="panel">
    <h2>关于 Astrore</h2>
    <p>Astrore 是一款跨平台的 Minecraft 服务端管理控制面板，使用 Tauri 2 框架构建。它将开服、管理、配置、监控与下载功能集于一体，旨在降低开服门槛、提升管理效率。</p>
    <h3>技术栈</h3>
    <ul>
      <li>前端：React 19 + TypeScript + Vite</li>
      <li>后端：Rust + Tauri 2 + Tokio</li>
      <li>下载源：FastMirror API v3</li>
    </ul>
    <h3>版本</h3>
    <p>Astrore Control v0.2.1</p>
    <p>开发者：<a href="https://afdian.com/a/zkonikishi" target="_blank">zkonikishi</a></p>
    <h3>开源许可</h3>
    <p>本项目基于 MIT 许可证开源。感谢所有贡献者和开源社区的支持。</p>
  </div></section>;
}

function SoftwareSettingsView({ subTab, setSubTab, autoRestart, onAutoRestartChange }: { subTab: SoftwareTab; setSubTab: (tab: SoftwareTab) => void; autoRestart: AutoRestartConfig; onAutoRestartChange: (config: AutoRestartConfig) => void }) {
  const [agentUrl, setAgentUrl] = useState(() => localStorage.getItem("astrore.agentUrl") ?? "");
  const [agentToken, setAgentToken] = useState(() => localStorage.getItem("astrore.agentToken") ?? "");
  const [language, setLanguage] = useState(() => localStorage.getItem("astrore.language") ?? "zh-CN");
  const [theme, setTheme] = useState(() => localStorage.getItem("astrore.theme") ?? "system");
  const [aiProvider, setAiProvider] = useState(() => localStorage.getItem("astrore.ai.provider") ?? "openai");
  const [aiEndpoint, setAiEndpoint] = useState(() => localStorage.getItem("astrore.ai.endpoint") ?? "https://api.openai.com/v1/chat/completions");
  const [aiModel, setAiModel] = useState(() => localStorage.getItem("astrore.ai.model") ?? "");
  const [aiKey, setAiKey] = useState(() => localStorage.getItem("astrore.ai.apiKey") ?? "");
  const selectedAiProvider = findProviderById(aiProvider);
  const saveAgent = () => {
    if (agentUrl.trim()) localStorage.setItem("astrore.agentUrl", agentUrl.trim().replace(/\/+$/, ""));
    else localStorage.removeItem("astrore.agentUrl");
    if (agentToken) localStorage.setItem("astrore.agentToken", agentToken);
    else localStorage.removeItem("astrore.agentToken");
    window.location.reload();
  };
  const saveBasic = () => {
    localStorage.setItem("astrore.language", language);
    localStorage.setItem("astrore.theme", theme);
  };
  const saveAi = () => {
    localStorage.setItem("astrore.ai.provider", aiProvider);
    localStorage.setItem("astrore.ai.endpoint", aiEndpoint.trim());
    localStorage.setItem("astrore.ai.model", aiModel.trim());
    localStorage.setItem("astrore.ai.apiKey", aiKey);
  };
  const changeAiProvider = (providerId: string) => {
    const provider = findProviderById(providerId);
    setAiProvider(providerId);
    if (!provider) return;
    setAiEndpoint(provider.endpoint);
    setAiModel(provider.defaultModel || provider.models[0] || aiModel);
  };
  return <section className="hub-page software-settings">
    <TopTabs<SoftwareTab> value={subTab} onChange={setSubTab} tabs={[{ key: "basic", label: "基本设置" }, { key: "ai", label: "AI 助手设置" }]} />
    {subTab === "basic" && <div className="panel">
      <PanelHeader icon={<Settings />} title="基本设置" action="全局配置" />
      <label>软件语言<select value={language} onChange={event => setLanguage(event.target.value)}><option value="zh-CN">简体中文</option><option value="en-US">English</option><option value="ja-JP">日本語</option></select></label>
      <label>主题<select value={theme} onChange={event => setTheme(event.target.value)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
      <div className="setting-row">
        <div><span>崩溃自动重启</span><small>服务端意外退出时自动重新启动</small></div>
        <input type="checkbox" checked={autoRestart.enabled} onChange={(e) => onAutoRestartChange({ ...autoRestart, enabled: e.target.checked })} />
      </div>
      <label>最大重启次数<input type="number" min={1} max={10} value={autoRestart.maxRestarts} onChange={(e) => onAutoRestartChange({ ...autoRestart, maxRestarts: Number(e.target.value) })} /></label>
      <label>重启延迟（秒）<input type="number" min={1} max={60} value={autoRestart.restartDelaySecs} onChange={(e) => onAutoRestartChange({ ...autoRestart, restartDelaySecs: Number(e.target.value) })} /></label>
      <div className="form-actions"><button className="primary" onClick={() => { saveBasic(); setAutoRestartConfig(autoRestart).catch(() => undefined); }}>保存设置</button></div>
    </div>}
    {subTab === "ai" && <div className="panel agent-settings">
      <PanelHeader icon={<Bot />} title="AI 助手设置" action="Provider" />
      <label>AI 厂商<select value={aiProvider} onChange={event => changeAiProvider(event.target.value)}>{PROVIDERS.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.tag}</option>)}</select></label>
      <label>兼容接口地址<input value={aiEndpoint} onChange={event => setAiEndpoint(event.target.value)} placeholder="例如 https://api.openai.com/v1/chat/completions" /></label>
      <label>模型名称{selectedAiProvider && selectedAiProvider.models.length > 0 && <select value={aiModel} onChange={event => setAiModel(event.target.value)}>{selectedAiProvider.models.map(model => <option key={model} value={model}>{model}</option>)}</select>}<input value={aiModel} onChange={event => setAiModel(event.target.value)} placeholder="例如 gpt-4.1-mini / deepseek-chat" /></label>
      <label>API Key<input type="password" value={aiKey} onChange={event => setAiKey(event.target.value)} placeholder={selectedAiProvider?.apiKeyHint ?? "保存在本机 localStorage"} /></label>
      <div className="form-actions"><button className="primary" onClick={saveAi}>保存 AI 设置</button></div>
    </div>}
    {subTab === "basic" && !isTauriRuntime() && <div className="panel agent-settings">
      <PanelHeader icon={<Server />} title="网页 Agent 连接" action="HTTP API" />
      <label>Agent 地址<input value={agentUrl} onChange={event => setAgentUrl(event.target.value)} placeholder="例如 http://server:1421，留空使用当前站点" /></label>
      <label>访问令牌<input type="password" value={agentToken} onChange={event => setAgentToken(event.target.value)} placeholder="ASTRORE_TOKEN" /></label>
      <div className="form-actions"><button className="primary" onClick={saveAgent}>保存并重新连接</button></div>
    </div>}
  </section>;
}

export default App;
