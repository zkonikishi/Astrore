const patterns: [RegExp, string][] = [
  [/(?:\b(?:ERROR|FATAL|Exception|Caused by|FAILED|SEVERE)\b|^\[.*?ERROR.*?\]|^\[.*?FATAL.*?\])/i, "err"],
  [/(?:\b(?:WARN|WARNING)\b|^\[.*?WARN.*?\])/i, "warn"],
  [/(?:\b(?:INFO|NOTICE)\b|^\[.*?INFO.*?\])/i, "info"],
  [/(?:\b(?:DEBUG|TRACE|FINE|FINER|FINEST)\b|^\[.*?DEBUG.*?\])/i, "debug"],
  [/\d{2}:\d{2}:\d{2}/, "time"],
  [/\b[A-Za-z0-9_]{2,16}\b(?=\s*(?:joined|left|logged in|disconnected|was killed|died|fell|drowned|burned|blew up|hit the ground|experienced|went up|tried|swim|walked|suffocated|withered|starved|slain|shot|blown|fireballed|pummeled|pricked|doomed|squashed|squished|obliterated|removed|escaped|finished))/i, "player"],
  [/(?<=:\s)\d+(?=\s|$|\.)/, "number"],
  [/"[^"]*"/, "string"],
  [/\b(?:true|false|null|undefined)\b/, "keyword"],
  [/<[A-Za-z0-9_]+(?:\s[^>]*)?>/, "chat"],
  [/(?:\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\[[\d.:]+\])/, "ip"],
  [/\b(?:Starting|Stopping|Loading|Saving|Done|Enabled|Disabled|Registered|Listening|Running|Stopped|Started|Reloading|Reloaded|Generating|Preparing|Spawning)\b/, "keyword"],
  [/\[[A-Za-z0-9_ #-]+\]/, "thread"],
  [/\b(?:Essentials|WorldEdit|WorldGuard|LuckPerms|Vault|ProtocolLib|ViaVersion|PlaceholderAPI|CoreProtect|Dynmap|GriefPrevention|Towny|Factions|mcMMO|Jobs|ChestShop|Multiverse|AuthMe|Citizens|MythicMobs|Skript|DiscordSRV|Geyser|Floodgate|LiteBans|AdvancedBan|Spark|Plan|BlueMap|SquareMap|Pl3xMap)\b/i, "plugin"],
];

const css = `
.console-line.err { color: #f44747; }
.console-line.warn { color: #cca700; }
.console-line.info { color: #75beff; }
.console-line.debug { color: #808080; }
.console-line.time { color: #6a9955; }
.console-line.player { color: #4fc1ff; }
.console-line.number { color: #b5cea8; }
.console-line.string { color: #ce9178; }
.console-line.keyword { color: #569cd6; }
.console-line.chat { color: #dcdcaa; }
.console-line.ip { color: #9cdcfe; }
.console-line.thread { color: #c586c0; }
.console-line.plugin { color: #4ec9b0; }
`;

let styleInjected = false;

function injectStyle() {
  if (styleInjected) return;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  styleInjected = true;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function highlightLine(raw: string): string {
  injectStyle();

  const matches: { start: number; end: number; cls: string }[] = [];
  for (const [regex, cls] of patterns) {
    let match: RegExpExecArray | null;
    const clone = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
    while ((match = clone.exec(raw)) !== null) {
      const overlap = matches.some(
        (m) => match!.index < m.end && match!.index + match![0].length > m.start
      );
      if (!overlap) {
        matches.push({ start: match.index, end: match.index + match[0].length, cls });
      }
      if (match[0].length === 0) clone.lastIndex += 1;
    }
  }
  matches.sort((a, b) => a.start - b.start);

  let result = "";
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue;
    result += escapeHtml(raw.slice(cursor, m.start));
    result += `<span class="console-line ${m.cls}">${escapeHtml(raw.slice(m.start, m.end))}</span>`;
    cursor = m.end;
  }
  result += escapeHtml(raw.slice(cursor));
  return result;
}
