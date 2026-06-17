import { useMemo, useState } from "react";
import { Bot, Eraser, Search, Send, Settings2, ShieldAlert, Sparkles, Thermometer, Hash, FileText } from "lucide-react";
import { aiChat, type AiMessage, type InstanceConfig, type ServerMetrics } from "./bridge";
import { PROVIDERS, findProviderById, type ProviderMeta } from "./aiProviders";

type Props = {
  instance: InstanceConfig;
  running: boolean;
  metrics: ServerMetrics;
  consoleLines: string[];
  onError: (message: string) => void;
};

const DEFAULT_SYSTEM_PROMPT = `你是 Astrore Minecraft Java 服务端运维助手。
回答必须简洁、准确，并优先解释风险与排查步骤。
不要声称已经执行命令、修改文件或重启服务。
需要执行操作时，给出明确命令或修改建议，并提醒用户人工确认。
不要要求用户发送 API 密钥、令牌或其他敏感信息。`;

export function AiAssistant({ instance, running, metrics, consoleLines, onError }: Props) {
  const [providerId, setProviderId] = useState(() => localStorage.getItem("astrore.ai.provider") ?? "openai");
  const [endpoint, setEndpoint] = useState(() => localStorage.getItem("astrore.ai.endpoint") ?? "https://api.openai.com/v1/chat/completions");
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem("astrore.ai.apiKey") ?? localStorage.getItem("astrore.ai.apiKey") ?? "");
  const [rememberKey, setRememberKey] = useState(() => Boolean(localStorage.getItem("astrore.ai.apiKey")));
  const [model, setModel] = useState(() => localStorage.getItem("astrore.ai.model") ?? "gpt-4.1-mini");
  const [temperature, setTemperature] = useState(() => Number(localStorage.getItem("astrore.ai.temperature") ?? 0.7));
  const [maxTokens, setMaxTokens] = useState(() => Number(localStorage.getItem("astrore.ai.maxTokens") ?? 4096));
  const [systemPrompt, setSystemPrompt] = useState(() => localStorage.getItem("astrore.ai.systemPrompt") ?? DEFAULT_SYSTEM_PROMPT);
  const [includeLogs, setIncludeLogs] = useState(true);
  const [showSettings, setShowSettings] = useState(() => !localStorage.getItem("astrore.ai.endpoint"));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [providerSearch, setProviderSearch] = useState("");

  const selectedProvider = findProviderById(providerId);

  const filteredProviders = useMemo(() => {
    const q = providerSearch.trim().toLowerCase();
    if (!q) return PROVIDERS;
    return PROVIDERS.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.tag.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q)
    );
  }, [providerSearch]);

  const context = useMemo(() => {
    const summary = [
      `实例: ${instance.name}`,
      `运行状态: ${running ? "运行中" : "已停止"}`,
      `核心: ${instance.serverJar}`,
      `内存: ${metrics.memoryMb.toFixed(0)} / ${metrics.memoryMaxMb.toFixed(0)} MB`,
      `CPU: ${metrics.cpuPercent.toFixed(1)}%`,
      `TPS: ${metrics.tps || "未知"}, MSPT: ${metrics.mspt || "未知"}`,
      `在线玩家: ${metrics.onlinePlayers}/${metrics.maxPlayers}`,
    ].join("\n");
    return includeLogs ? `${summary}\n\n最近控制台日志:\n${consoleLines.slice(-80).join("\n")}` : summary;
  }, [consoleLines, includeLogs, instance.name, instance.serverJar, metrics, running]);

  const selectProvider = (p: ProviderMeta) => {
    setProviderId(p.id);
    setEndpoint(p.endpoint);
    setModel(p.defaultModel || p.models[0] || "");
    localStorage.setItem("astrore.ai.provider", p.id);
    localStorage.setItem("astrore.ai.endpoint", p.endpoint);
    localStorage.setItem("astrore.ai.model", p.defaultModel || p.models[0] || "");
  };

  const saveSettings = () => {
    localStorage.setItem("astrore.ai.endpoint", endpoint.trim());
    localStorage.setItem("astrore.ai.model", model.trim());
    localStorage.setItem("astrore.ai.provider", providerId);
    localStorage.setItem("astrore.ai.temperature", String(temperature));
    localStorage.setItem("astrore.ai.maxTokens", String(maxTokens));
    localStorage.setItem("astrore.ai.systemPrompt", systemPrompt.trim());
    sessionStorage.removeItem("astrore.ai.apiKey");
    localStorage.removeItem("astrore.ai.apiKey");
    if (apiKey) (rememberKey ? localStorage : sessionStorage).setItem("astrore.ai.apiKey", apiKey);
    setShowSettings(false);
  };

  const send = async (question = input) => {
    const content = question.trim();
    if (!content || busy) return;
    if (!endpoint.trim() || !model.trim()) return onError("请先配置 AI 接口地址和模型");
    const user: AiMessage = { role: "user", content };
    const next = [...messages, user];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const answer = await aiChat({
        endpoint: endpoint.trim(),
        apiKey,
        model: model.trim(),
        temperature,
        maxTokens,
        messages: [{ role: "system", content: `${systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT}\n\n当前服务器上下文:\n${context}` }, ...next.slice(-12)],
      });
      setMessages(current => [...current, { role: "assistant", content: answer }]);
    } catch (error) {
      onError(String(error));
    } finally {
      setBusy(false);
    }
  };

  const quick = ["分析最近报错", "检查性能瓶颈", "推荐 JVM 参数", "给出安全优化建议"];

  return <section className="ai-layout">
    <div className="panel ai-chat">
      <div className="manager-toolbar"><Bot /><strong>AI 运维助手</strong><span>{model}</span><button className="icon-btn" onClick={() => setMessages([])} title="清空对话"><Eraser /></button><button className="icon-btn" onClick={() => setShowSettings(current => !current)} title="AI 设置"><Settings2 /></button></div>
      <div className="ai-safety"><ShieldAlert /><span>AI 仅提供建议，不会自动执行命令或修改服务器文件。</span></div>
      <div className="ai-messages">
        {messages.length === 0 ? <div className="ai-welcome"><Sparkles /><strong>需要我检查什么？</strong><span>我可以结合当前状态和最近日志分析问题。</span><div>{quick.map(item => <button key={item} onClick={() => send(item)}>{item}</button>)}</div></div> :
          messages.map((message, index) => <article className={message.role} key={index}><strong>{message.role === "user" ? "你" : "Astrore AI"}</strong><pre>{message.content}</pre></article>)}
        {busy && <article className="assistant pending"><strong>Astrore AI</strong><pre>正在分析服务器上下文...</pre></article>}
      </div>
      <div className="ai-input"><textarea value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="询问崩溃日志、性能、配置或插件问题..." /><button className="primary" disabled={busy || !input.trim()} onClick={() => send()} title="发送"><Send /></button></div>
    </div>
    {showSettings && <div className="panel ai-settings">
      <div className="manager-toolbar"><Settings2 /><strong>AI 接口设置</strong></div>

      {/* 提供商搜索 */}
      <div className="ai-provider-search">
        <Search size={14} />
        <input value={providerSearch} onChange={e => setProviderSearch(e.target.value)} placeholder="搜索提供商..." />
      </div>

      {/* 提供商卡片网格 */}
      <div className="ai-provider-grid">
        {filteredProviders.map(p => (
          <button
            key={p.id}
            className={`ai-provider-card${p.id === providerId ? " selected" : ""}`}
            onClick={() => selectProvider(p)}
            title={`${p.name}\n${p.endpoint}`}
          >
            <span className="ai-provider-icon">{p.icon}</span>
            <span className="ai-provider-name">{p.name}</span>
            <span className="ai-provider-tag">{p.tag}</span>
            {p.id === providerId && <span className="ai-provider-check">✓</span>}
          </button>
        ))}
      </div>

      {/* 当前选中提供商详情 */}
      {selectedProvider && (
        <div className="ai-provider-detail">
          <span className="ai-provider-detail-icon">{selectedProvider.icon}</span>
          <div>
            <strong>{selectedProvider.name}</strong>
            <small>{selectedProvider.endpoint}</small>
          </div>
        </div>
      )}

      <label>兼容接口地址
        <input value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://.../v1/chat/completions" />
      </label>

      <label>模型名称
        {selectedProvider && selectedProvider.models.length > 0 ? (
          <select value={model} onChange={event => setModel(event.target.value)}>
            {selectedProvider.models.map(m => <option key={m} value={m}>{m}</option>)}
            <option value="">--- 手动输入 ---</option>
          </select>
        ) : null}
        <input value={model} onChange={event => setModel(event.target.value)} placeholder="模型名称" />
      </label>

      <label>API 密钥
        <input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={selectedProvider?.apiKeyHint ?? "sk-..."} />
      </label>

      <div className="ai-params-row">
        <label>温度 <span className="ai-param-value">{temperature.toFixed(1)}</span>
          <input type="range" min="0" max="2" step="0.1" value={temperature} onChange={event => setTemperature(Number(event.target.value))} />
        </label>
        <label>最大 Token <span className="ai-param-value">{maxTokens}</span>
          <input type="number" min="64" max="131072" step="64" value={maxTokens} onChange={event => setMaxTokens(Number(event.target.value))} />
        </label>
      </div>

      <label>系统提示词
        <textarea value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} rows={4} placeholder={DEFAULT_SYSTEM_PROMPT} />
      </label>

      <label className="ai-toggle"><span>记住 API 密钥</span><input type="checkbox" checked={rememberKey} onChange={event => setRememberKey(event.target.checked)} /></label>
      <label className="ai-toggle"><span>附带最近 80 行日志</span><input type="checkbox" checked={includeLogs} onChange={event => setIncludeLogs(event.target.checked)} /></label>
      <p>默认仅在当前会话保存密钥。提问时，选中的日志与服务器状态会发送到你配置的 AI 接口。</p>
      <button className="primary" onClick={saveSettings}>保存设置</button>
    </div>}
  </section>;
}
