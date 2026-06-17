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

## Agent 网页端

GitHub Actions 会为 Windows、Linux 和 macOS 生成 `Astrore-Agent-*` 一体包。压缩包已经包含 Agent、网页界面和启动脚本，不需要单独部署前端。

- Windows：解压后双击 `start-agent.bat`
- Linux / macOS：解压后运行 `./start-agent.sh`

Agent 启动后访问 `http://127.0.0.1:1421` 即可进入网页控制台。Agent 同时提供网页、API、WebSocket 实时推送和 Minecraft 服务端管理能力。

### Linux 一键安装

在 Linux 服务器上通过单条命令完成部署：

```bash
curl -fsSL https://raw.githubusercontent.com/zkonikishi/Astrore/main/deploy/install.sh | sudo bash
```

可选参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--version v0.2.0` | 指定版本号 | `latest` |
| `--dir /opt/astrore` | 安装目录 | `/opt/astrore-agent` |
| `--port 1421` | 监听端口 | `1421` |
| `--host 0.0.0.0` | 监听地址 | `127.0.0.1` |
| `--token YOUR_TOKEN` | 访问令牌 | 自动生成随机令牌 |
| `--repo yourname/astrore` | GitHub 仓库 | `zkonikishi/Astrore` |

示例：指定版本并允许局域网访问：

```bash
curl -fsSL https://raw.githubusercontent.com/zkonikishi/Astrore/main/deploy/install.sh | sudo bash -s -- --version v0.2.0 --host 0.0.0.0 --token my-secret-token
```

脚本会自动完成：
- 系统依赖检查（curl、tar、systemd）
- 磁盘空间和端口占用检测
- 从 GitHub Releases 下载最新 Agent 包
- 解压安装到指定目录
- 生成配置文件（端口、令牌等）
- 注册 systemd 服务并设置开机自启
- 启动服务并验证 HTTP 响应
- 安装失败时自动回滚清理

安装后常用命令：

```bash
systemctl status astrore-agent    # 查看服务状态
systemctl restart astrore-agent   # 重启服务
journalctl -u astrore-agent -f    # 查看实时日志
```

卸载：

```bash
sudo systemctl stop astrore-agent
sudo systemctl disable astrore-agent
sudo rm -f /etc/systemd/system/astrore-agent.service
sudo rm -rf /opt/astrore-agent
```

### 手动启动

```bash
./astrore-agent
```

默认会自动读取 Agent 可执行文件旁边的 `dist` 网页目录，并将配置保存到同目录的 `.astrore-agent.json`。

未设置令牌时，Agent 只允许同源网页调用 API；因此开发模式下从 `http://localhost:1420` 连接 Agent 也需要设置令牌。

需要监听局域网或公网地址时，必须设置访问令牌：

```bash
ASTRORE_BIND=0.0.0.0:1421 \
ASTRORE_TOKEN='replace-with-a-long-random-token' \
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

- Windows：`Astrore_x.x.x_x64.exe`、`Astrore-Agent-Windows.zip`
- Linux：DEB、AppImage、`Astrore-Agent-Linux.tar.gz`
- macOS：App、DMG、`Astrore-Agent-macOS.tar.gz`

产物当前未进行代码签名。

## 常见问题

**Q: 安装脚本报 "下载失败"？**
A: 检查服务器是否能访问 GitHub。如在国内，可先手动下载 Agent 包后使用 `--dir` 指定本地路径，或配置 HTTP 代理。

**Q: 端口被占用？**
A: 使用 `--port` 参数指定其他端口，如 `--port 8080`。

**Q: 如何允许外网访问？**
A: 使用 `--host 0.0.0.0 --token YOUR_SECRET_TOKEN`。公网部署建议通过 Nginx/Caddy 反向代理启用 HTTPS。

**Q: 服务启动后无法访问？**
A: 检查防火墙：`sudo ufw allow 1421/tcp`（Ubuntu）或 `sudo firewall-cmd --add-port=1421/tcp --permanent`（CentOS）。

**Q: 安装失败如何排查？**
A: 查看安装日志 `/tmp/astrore-install-*.log`，或查看服务日志 `journalctl -u astrore-agent -n 50`。
