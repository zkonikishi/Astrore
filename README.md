# Astrore

Astrore 是基于 React、Tauri 2 与 Rust 的跨平台 Minecraft Java 服务端管理器。

## 支持方式

- Windows / macOS / Linux 桌面端：通过 Tauri 直接管理本机服务端。
- Linux 网页端：运行独立的 `astrore-agent`，通过浏览器管理服务器。
- Android / iOS：后续作为远程管理客户端，不在移动设备上运行 Java 服务端。

## 前端开发

```powershell
npm.cmd install
npm.cmd run dev
npm.cmd run build
```

## Linux 网页端

GitHub Actions 的 Linux 构建产物中包含 `astrore-agent`。将 Agent 与前端 `dist` 放在服务器上，然后运行：

```bash
ASTRORE_BIND=127.0.0.1:1421 \
ASTRORE_WEB_ROOT=./dist \
./astrore-agent
```

访问 `http://127.0.0.1:1421` 即可进入网页控制台。

未设置令牌时，Agent 只允许同源网页调用 API；因此开发模式下从 `http://localhost:1420` 连接 Agent 也需要设置令牌。

需要监听局域网或公网地址时，必须设置访问令牌：

```bash
ASTRORE_BIND=0.0.0.0:1421 \
ASTRORE_TOKEN='replace-with-a-long-random-token' \
ASTRORE_WEB_ROOT=./dist \
./astrore-agent
```

随后在网页的“软件设置”中填写 Agent API 地址与相同令牌。公网部署应通过 Caddy、Nginx 等反向代理启用 HTTPS，不建议直接暴露 Agent 端口。

当前网页 Agent 支持：

- EULA 检查与接受
- 启动、停止、强制停止及命令发送
- 控制台输出轮询
- 文件浏览、编辑、重命名、启用、禁用与删除
- `server.properties` 读取和保存
- 实例备份、恢复与删除
- Modrinth 插件和模组搜索、版本查看与下载
- FastMirror 服务端核心发现与下载
- 玩家权限列表读取，以及服务器运行时的权限命令
- 服务端意外退出后的自动重启、最大重试次数和延迟设置
- 自动重启配置持久化到 `.astrore-agent.json`
- Java 进程 CPU、内存、运行时长及实例所在磁盘剩余空间监控
- 自动识别 Paper、Purpur、Folia 与 Spigot，并周期采集 TPS、MSPT 和在线玩家
- 网页端资源阈值告警
- WebSocket 实时推送控制台、服务状态和性能指标
- WebSocket 断线后自动回退到低频 HTTP 轮询，并以指数退避自动重连
- 网页端启动时 Agent 离线会自动探测，Agent 后启动或重启后无需手动刷新

可通过 `ASTRORE_CONFIG=/path/agent.json` 自定义 Agent 配置文件位置。

离线玩家权限修改和 TPS/MSPT 主动探测仍优先由桌面端提供，后续继续迁移到 Agent。

## 自动构建

`.github/workflows/build.yml` 会构建并上传：

- Windows：NSIS、MSI、`astrore-agent.exe`
- Linux：DEB、AppImage、`astrore-agent`
- macOS：App、DMG、`astrore-agent`

产物当前未进行代码签名。
