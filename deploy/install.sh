#!/usr/bin/env bash
# =============================================================================
# Astrore Agent - Linux 一键安装脚本
# 用法: curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash
# 或:   bash install.sh [--version v0.2.0] [--dir /opt/astrore] [--port 1421] [--token TOKEN]
# =============================================================================
set -euo pipefail

# ==================== 配置 ====================
GITHUB_REPO="zkonikishi/Astrore"                # GitHub 仓库
INSTALL_DIR="${INSTALL_DIR:-/opt/astrore-agent}"  # 安装目录
BIND_PORT="${BIND_PORT:-1421}"                    # 监听端口
BIND_HOST="${BIND_HOST:-127.0.0.1}"               # 监听地址
AGENT_TOKEN="${AGENT_TOKEN:-}"                    # 访问令牌 (留空则仅允许本地访问)
VERSION="${VERSION:-latest}"                      # 版本号
LOG_FILE="/tmp/astrore-install-$(date +%Y%m%d-%H%M%S).log"
BACKUP_DIR=""
ROLLBACK_FLAG=0

# 颜色输出
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

# ==================== 日志 ====================
log()  { echo -e "${GREEN}[INFO]${NC}  $(date '+%H:%M:%S') $*" | tee -a "$LOG_FILE"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $(date '+%H:%M:%S') $*" | tee -a "$LOG_FILE"; }
err()  { echo -e "${RED}[ERROR]${NC} $(date '+%H:%M:%S') $*" | tee -a "$LOG_FILE"; }
step() { echo -e "\n${BLUE}==>${NC} $(date '+%H:%M:%S') $*" | tee -a "$LOG_FILE"; }

# ==================== 回滚 ====================
rollback() {
    ROLLBACK_FLAG=1
    err "安装失败，正在回滚..."
    # 停止服务
    systemctl stop astrore-agent 2>/dev/null || true
    systemctl disable astrore-agent 2>/dev/null || true
    rm -f /etc/systemd/system/astrore-agent.service
    systemctl daemon-reload 2>/dev/null || true
    # 恢复备份
    if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
        rm -rf "$INSTALL_DIR" 2>/dev/null || true
        mv "$BACKUP_DIR" "$INSTALL_DIR" 2>/dev/null || true
        log "已恢复原有安装目录"
    else
        rm -rf "$INSTALL_DIR" 2>/dev/null || true
    fi
    # 清理临时文件
    rm -rf /tmp/astrore-agent-download 2>/dev/null || true
    err "回滚完成。请检查日志: $LOG_FILE"
    exit 1
}
trap 'if [ $ROLLBACK_FLAG -eq 0 ]; then rollback; fi' ERR

# ==================== 参数解析 ====================
while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --dir)     INSTALL_DIR="$2"; shift 2 ;;
        --port)    BIND_PORT="$2"; shift 2 ;;
        --token)   AGENT_TOKEN="$2"; shift 2 ;;
        --host)    BIND_HOST="$2"; shift 2 ;;
        --repo)    GITHUB_REPO="$2"; shift 2 ;;
        *) err "未知参数: $1"; exit 1 ;;
    esac
done

# ==================== 系统检测 ====================
detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_ID="${ID}"
        OS_VERSION="${VERSION_ID:-unknown}"
    elif [ -f /etc/redhat-release ]; then
        OS_ID="centos"
        OS_VERSION=$(rpm -E %rhel 2>/dev/null || echo "unknown")
    else
        OS_ID="unknown"
        OS_VERSION="unknown"
    fi
    log "检测到系统: $OS_ID $OS_VERSION ($(uname -m))"
}

check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        err "请使用 root 权限运行此脚本: sudo bash install.sh"
        exit 1
    fi
}

check_deps() {
    step "检查系统依赖..."
    local missing=""

    for cmd in curl tar systemctl; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            missing="$missing $cmd"
        fi
    done

    if [ -n "$missing" ]; then
        warn "缺少依赖:$missing，正在安装..."
        case "$OS_ID" in
            ubuntu|debian)
                apt-get update -qq
                apt-get install -y -qq curl tar systemd >/dev/null 2>&1 ;;
            centos|rhel|fedora|rocky|almalinux)
                yum install -y -q curl tar systemd 2>/dev/null || dnf install -y -q curl tar systemd 2>/dev/null ;;
            arch)
                pacman -S --noconfirm curl tar systemd >/dev/null 2>&1 ;;
            *)
                err "不支持的系统: $OS_ID。请手动安装 curl, tar, systemd。"
                exit 1 ;;
        esac
    fi
    log "系统依赖检查通过"
}

check_port() {
    if ss -tlnp 2>/dev/null | grep -q ":${BIND_PORT} "; then
        warn "端口 $BIND_PORT 已被占用，将尝试使用该端口"
    fi
}

check_disk() {
    local available
    available=$(df -m "$(dirname "$INSTALL_DIR")" 2>/dev/null | awk 'NR==2 {print $4}')
    if [ -n "$available" ] && [ "$available" -lt 100 ]; then
        warn "磁盘空间不足 100MB (可用: ${available}MB)，安装可能失败"
    fi
}

# ==================== 下载 ====================
download_release() {
    step "下载 Astrore Agent..."
    local download_url
    local tmp_dir="/tmp/astrore-agent-download"
    rm -rf "$tmp_dir"
    mkdir -p "$tmp_dir"

    if [ "$VERSION" = "latest" ]; then
        download_url="https://github.com/${GITHUB_REPO}/releases/latest/download/Astrore-Agent-Linux.tar.gz"
    else
        download_url="https://github.com/${GITHUB_REPO}/releases/download/${VERSION}/Astrore-Agent-Linux.tar.gz"
    fi

    log "下载地址: $download_url"
    if ! curl -fSL --progress-bar -o "$tmp_dir/astrore-agent.tar.gz" "$download_url"; then
        err "下载失败。请检查: 1) 网络连接 2) 仓库名是否正确 3) Release 是否存在"
        err "可手动指定仓库: --repo yourname/astrore"
        exit 1
    fi

    log "解压中..."
    tar -xzf "$tmp_dir/astrore-agent.tar.gz" -C "$tmp_dir"
    log "下载完成"
}

# ==================== 安装 ====================
install_files() {
    step "安装文件到 $INSTALL_DIR..."

    # 备份旧安装
    if [ -d "$INSTALL_DIR" ]; then
        BACKUP_DIR="${INSTALL_DIR}.bak.$(date +%Y%m%d%H%M%S)"
        mv "$INSTALL_DIR" "$BACKUP_DIR"
        log "已备份旧安装到 $BACKUP_DIR"
    fi

    mkdir -p "$INSTALL_DIR"
    local tmp_dir="/tmp/astrore-agent-download"

    # 查找并复制文件
    if [ -f "$tmp_dir/astrore-agent" ]; then
        cp "$tmp_dir/astrore-agent" "$INSTALL_DIR/"
        chmod +x "$INSTALL_DIR/astrore-agent"
    elif [ -f "$tmp_dir/agent-package/astrore-agent" ]; then
        cp -R "$tmp_dir/agent-package/"* "$INSTALL_DIR/"
        chmod +x "$INSTALL_DIR/astrore-agent"
    else
        err "未找到 astrore-agent 可执行文件，包结构可能已变更"
        exit 1
    fi

    # 确保 dist 目录存在
    if [ ! -d "$INSTALL_DIR/dist" ]; then
        warn "未找到 dist 目录，Agent 将无法提供网页界面"
        mkdir -p "$INSTALL_DIR/dist"
    fi

    log "文件安装完成"
}

# ==================== 配置 ====================
generate_config() {
    step "生成配置文件..."

    # 环境变量配置
    cat > "$INSTALL_DIR/astrore-agent.env" <<EOF
# Astrore Agent 环境配置
# 监听地址 (0.0.0.0 表示监听所有网卡)
ASTRORE_BIND=${BIND_HOST}:${BIND_PORT}
# 访问令牌 (留空则仅允许本地访问)
ASTRORE_TOKEN=${AGENT_TOKEN}
# 网页资源目录
ASTRORE_WEB_DIR=${INSTALL_DIR}/dist
EOF

    # 如果未设置令牌，生成一个随机令牌用于本地访问
    if [ -z "$AGENT_TOKEN" ]; then
        local random_token
        random_token=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 48)
        warn "未设置访问令牌，已自动生成随机令牌。"
        warn "如需远程访问，请编辑 $INSTALL_DIR/astrore-agent.env 设置 ASTRORE_TOKEN"
        sed -i "s/ASTRORE_TOKEN=$/ASTRORE_TOKEN=${random_token}/" "$INSTALL_DIR/astrore-agent.env"
    fi

    log "配置文件已生成: $INSTALL_DIR/astrore-agent.env"
}

# ==================== systemd 服务 ====================
setup_systemd() {
    step "配置 systemd 服务..."

    cat > /etc/systemd/system/astrore-agent.service <<EOF
[Unit]
Description=Astrore Agent - Minecraft Server Manager
Documentation=https://github.com/${GITHUB_REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/astrore-agent.env
ExecStart=${INSTALL_DIR}/astrore-agent
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=astrore-agent

# 安全加固
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${INSTALL_DIR}
ReadOnlyPaths=/etc/passwd /etc/group

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable astrore-agent
    log "systemd 服务已配置"
}

# ==================== 启动 ====================
start_service() {
    step "启动 Astrore Agent..."

    if systemctl is-active --quiet astrore-agent 2>/dev/null; then
        systemctl restart astrore-agent
        log "服务已重启"
    else
        systemctl start astrore-agent
        log "服务已启动"
    fi

    # 等待服务就绪
    local max_wait=15
    local waited=0
    while [ $waited -lt $max_wait ]; do
        if curl -sf -o /dev/null "http://${BIND_HOST}:${BIND_PORT}" 2>/dev/null; then
            log "服务就绪 (等待 ${waited}s)"
            break
        fi
        sleep 1
        waited=$((waited + 1))
    done

    if [ $waited -ge $max_wait ]; then
        warn "服务可能未完全就绪，请稍后检查"
    fi
}

# ==================== 验证 ====================
verify_installation() {
    step "验证安装..."

    local errors=0

    # 检查文件
    if [ -x "$INSTALL_DIR/astrore-agent" ]; then
        log "✓ 可执行文件: $INSTALL_DIR/astrore-agent"
    else
        err "✗ 可执行文件缺失"
        errors=$((errors + 1))
    fi

    # 检查服务
    if systemctl is-enabled --quiet astrore-agent 2>/dev/null; then
        log "✓ systemd 服务: 已启用"
    else
        err "✗ systemd 服务未启用"
        errors=$((errors + 1))
    fi

    # 检查端口
    if ss -tlnp 2>/dev/null | grep -q ":${BIND_PORT} "; then
        log "✓ 端口监听: ${BIND_PORT}"
    else
        warn "✗ 端口 ${BIND_PORT} 未监听，请检查服务状态"
        errors=$((errors + 1))
    fi

    # 检查 HTTP 响应
    if curl -sf -o /dev/null "http://${BIND_HOST}:${BIND_PORT}" 2>/dev/null; then
        log "✓ HTTP 服务: 正常响应"
    else
        warn "✗ HTTP 服务无响应，请稍后重试"
    fi

    return $errors
}

# ==================== 清理 ====================
cleanup() {
    rm -rf /tmp/astrore-agent-download 2>/dev/null || true
    if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
        rm -rf "$BACKUP_DIR" 2>/dev/null || true
    fi
    log "临时文件已清理"
}

# ==================== 输出信息 ====================
print_summary() {
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1}') || ip="127.0.0.1"

    echo ""
    echo -e "${GREEN}============================================${NC}"
    echo -e "${GREEN}  Astrore Agent 安装完成！${NC}"
    echo -e "${GREEN}============================================${NC}"
    echo ""
    echo -e "  本地访问:  ${BLUE}http://${BIND_HOST}:${BIND_PORT}${NC}"
    if [ "$BIND_HOST" = "0.0.0.0" ]; then
        echo -e "  局域网访问: ${BLUE}http://${ip}:${BIND_PORT}${NC}"
    fi
    echo ""
    echo -e "  安装目录:   ${INSTALL_DIR}"
    echo -e "  配置文件:   ${INSTALL_DIR}/astrore-agent.env"
    echo -e "  安装日志:   ${LOG_FILE}"
    echo ""
    echo -e "  ${YELLOW}常用命令:${NC}"
    echo "    systemctl status astrore-agent   # 查看服务状态"
    echo "    systemctl restart astrore-agent  # 重启服务"
    echo "    systemctl stop astrore-agent     # 停止服务"
    echo "    journalctl -u astrore-agent -f   # 查看实时日志"
    echo ""
    echo -e "  ${YELLOW}修改配置:${NC}"
    echo "    编辑 $INSTALL_DIR/astrore-agent.env"
    echo "    然后执行 systemctl restart astrore-agent"
    echo ""
    echo -e "  ${YELLOW}卸载:${NC}"
    echo "    sudo systemctl stop astrore-agent"
    echo "    sudo systemctl disable astrore-agent"
    echo "    sudo rm -f /etc/systemd/system/astrore-agent.service"
    echo "    sudo rm -rf $INSTALL_DIR"
    echo ""
}

# ==================== 主流程 ====================
main() {
    echo -e "${BLUE}============================================${NC}"
    echo -e "${BLUE}  Astrore Agent Linux 一键安装${NC}"
    echo -e "${BLUE}============================================${NC}"
    echo ""

    check_root
    detect_os
    check_deps
    check_port
    check_disk
    download_release
    install_files
    generate_config
    setup_systemd
    start_service
    verify_installation || warn "部分验证未通过，请检查日志: $LOG_FILE"
    cleanup
    print_summary

    log "安装完成！日志已保存到: $LOG_FILE"
}

main "$@"
