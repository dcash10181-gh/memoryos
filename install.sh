#!/usr/bin/env bash
# ============================================================
# MemoryOS — One-Line Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/dcash10181-gh/memoryos/main/install.sh | bash
# ============================================================
set -euo pipefail

MEMORYOS_VERSION="1.0.0"
INSTALL_DIR="${MEMORYOS_INSTALL_DIR:-$HOME/.memoryos}"
BIN_DIR="/usr/local/bin"
REPO="https://github.com/dcash10181-gh/memoryos"
GREEN='\033[0;32m' YELLOW='\033[1;33m' RED='\033[0;31m' NC='\033[0m' BOLD='\033[1m'

banner() {
  echo -e "${BOLD}"
  echo "  ███╗   ███╗███████╗███╗   ███╗ ██████╗ ██████╗ ██╗   ██╗ ██████╗ ███████╗"
  echo "  ████╗ ████║██╔════╝████╗ ████║██╔═══██╗██╔══██╗╚██╗ ██╔╝██╔═══██╗██╔════╝"
  echo "  ██╔████╔██║█████╗  ██╔████╔██║██║   ██║██████╔╝ ╚████╔╝ ██║   ██║███████╗"
  echo "  ██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║██║   ██║██╔══██╗  ╚██╔╝  ██║   ██║╚════██║"
  echo "  ██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║╚██████╔╝██║  ██║   ██║   ╚██████╔╝███████║"
  echo "  ╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚══════╝"
  echo -e "${NC}"
  echo -e "  ${YELLOW}Institutional Memory Engine v${MEMORYOS_VERSION}${NC}"
  echo "  Your company's brain — self-hosted, private, one-line install."
  echo ""
}

info()    { echo -e "  ${GREEN}✓${NC} $1"; }
warn()    { echo -e "  ${YELLOW}⚠${NC}  $1"; }
error()   { echo -e "  ${RED}✗${NC} $1"; exit 1; }
step()    { echo -e "\n  ${BOLD}→ $1${NC}"; }

check_dependency() {
  command -v "$1" &>/dev/null || error "Required dependency '$1' not found. Please install it and re-run."
}

detect_os() {
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  [[ "$ARCH" == "x86_64" ]] && ARCH="amd64"
  [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]] && ARCH="arm64"
  export OS ARCH
}

check_prerequisites() {
  step "Checking prerequisites"
  check_dependency "curl"
  check_dependency "node"
  check_dependency "npm"
  check_dependency "docker"

  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  [[ "$NODE_VER" -lt 18 ]] && error "Node.js 18+ required (found v${NODE_VER}). Visit https://nodejs.org"

  docker info &>/dev/null || error "Docker daemon is not running. Please start Docker and re-run."

  info "Node.js $(node --version) — OK"
  info "npm $(npm --version) — OK"
  info "Docker $(docker --version | awk '{print $3}' | tr -d ',') — OK"
}

setup_directories() {
  step "Setting up install directory"
  mkdir -p "${INSTALL_DIR}"/{data,logs,config}
  info "Install directory: ${INSTALL_DIR}"
}

pull_source() {
  step "Pulling MemoryOS source"
  if [[ -d "${INSTALL_DIR}/core/.git" ]]; then
    warn "Existing install detected — updating..."
    git -C "${INSTALL_DIR}/core" pull --quiet origin main
  else
    git clone --quiet --depth 1 "$REPO" "${INSTALL_DIR}/core"
  fi
  info "Source ready at ${INSTALL_DIR}/core"
}

install_node_modules() {
  step "Installing Node.js dependencies"
  cd "${INSTALL_DIR}/core"
  npm install --silent --prefer-offline 2>/dev/null || npm install --silent
  npm run build --silent
  info "Dependencies installed"
}

start_neo4j() {
  step "Starting Neo4j graph database"
  COMPOSE_FILE="${INSTALL_DIR}/core/docker-compose.yml"

  if docker ps --format '{{.Names}}' | grep -q "memoryos-neo4j"; then
    warn "Neo4j already running — skipping"
  else
    NEO4J_PASSWORD="${MEMORYOS_NEO4J_PASSWORD:-memoryos_secure_$(openssl rand -hex 8)}"
    export NEO4J_PASSWORD
    echo "NEO4J_PASSWORD=${NEO4J_PASSWORD}" >> "${INSTALL_DIR}/config/.env"
    docker compose -f "$COMPOSE_FILE" up -d neo4j
    echo -n "  Waiting for Neo4j to be ready"
    until docker exec memoryos-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" "RETURN 1" &>/dev/null 2>&1; do
      echo -n "."; sleep 2
    done
    echo ""
    info "Neo4j running on bolt://localhost:7687"
  fi
}

initialize_schema() {
  step "Initializing knowledge graph schema"
  cd "${INSTALL_DIR}/core"
  node dist/cli/init-schema.js 2>/dev/null && info "Schema constraints + indexes applied" || warn "Schema init will run on first daemon start"
}

create_config() {
  step "Creating configuration"
  CONFIG_FILE="${INSTALL_DIR}/config/config.yaml"

  if [[ -f "$CONFIG_FILE" ]]; then
    warn "Config already exists at ${CONFIG_FILE} — skipping"
    return
  fi

  cat > "$CONFIG_FILE" <<YAML
# MemoryOS Configuration — edit this file to connect your data sources
version: "1.0"

daemon:
  port: 7890           # MCP server port
  log_level: info      # debug | info | warn | error
  sync_interval: 300   # seconds between incremental syncs

graph:
  uri: bolt://localhost:7687
  user: neo4j
  password: \${NEO4J_PASSWORD}   # loaded from .env

embedding:
  provider: openai               # openai | voyage | local
  model: text-embedding-3-small
  api_key: \${OPENAI_API_KEY}

llm:
  provider: anthropic
  model: claude-sonnet-4-20250514
  api_key: \${ANTHROPIC_API_KEY}

connectors:
  # --- Tier 1: High-velocity conversational sources ---
  slack:
    enabled: false
    bot_token: \${SLACK_BOT_TOKEN}
    app_token: \${SLACK_APP_TOKEN}
    channels: []          # [] = all channels the bot is invited to
    lookback_days: 90

  email:
    enabled: false
    provider: imap        # imap | gmail | outlook
    host: imap.gmail.com
    port: 993
    user: \${EMAIL_USER}
    password: \${EMAIL_PASSWORD}
    folders: [INBOX, Sent]
    lookback_days: 90

  # --- Tier 2: Decision tracking sources ---
  github:
    enabled: false
    token: \${GITHUB_TOKEN}
    org: ""               # your GitHub org
    repos: []             # [] = all accessible repos

  jira:
    enabled: false
    host: https://your-org.atlassian.net
    email: \${JIRA_EMAIL}
    token: \${JIRA_TOKEN}
    projects: []          # [] = all projects

  # --- Tier 3: Documentation sources ---
  confluence:
    enabled: false
    host: https://your-org.atlassian.net/wiki
    email: \${CONFLUENCE_EMAIL}
    token: \${CONFLUENCE_TOKEN}
    spaces: []

  notion:
    enabled: false
    token: \${NOTION_TOKEN}
    databases: []         # [] = all accessible databases

reflection:
  enabled: true
  gap_detection_interval: 3600   # run gap analysis every hour
  min_confidence_threshold: 0.65  # minimum score before prompting for missing links
YAML

  info "Config created at ${CONFIG_FILE}"
  echo ""
  warn "ACTION REQUIRED: Edit ${CONFIG_FILE} to enable your data sources."
}

install_cli_binary() {
  step "Installing memoryos CLI"
  cat > "${BIN_DIR}/memoryos" <<SCRIPT
#!/usr/bin/env bash
INSTALL_DIR="${INSTALL_DIR}"
source "\${INSTALL_DIR}/config/.env" 2>/dev/null || true
node "\${INSTALL_DIR}/core/dist/cli/index.js" "\$@"
SCRIPT
  chmod +x "${BIN_DIR}/memoryos"
  info "CLI installed: memoryos --help"
}

register_daemon() {
  step "Registering daemon"
  OS=$(uname -s)
  if [[ "$OS" == "Darwin" ]]; then
    PLIST="$HOME/Library/LaunchAgents/com.memoryos.daemon.plist"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.memoryos.daemon</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/memoryos</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${INSTALL_DIR}/logs/daemon.log</string>
  <key>StandardErrorPath</key><string>${INSTALL_DIR}/logs/daemon.err</string>
</dict></plist>
PLIST
    launchctl load "$PLIST" 2>/dev/null || warn "Daemon will start on next login. Run 'memoryos start' now."
    info "Daemon registered via launchd"
  elif [[ "$OS" == "Linux" ]]; then
    SYSTEMD_FILE="/etc/systemd/system/memoryos.service"
    sudo tee "$SYSTEMD_FILE" > /dev/null <<SERVICE
[Unit]
Description=MemoryOS Institutional Memory Daemon
After=network.target docker.service

[Service]
Type=simple
User=${USER}
EnvironmentFile=${INSTALL_DIR}/config/.env
ExecStart=/usr/local/bin/memoryos start
Restart=always
RestartSec=10
StandardOutput=append:${INSTALL_DIR}/logs/daemon.log
StandardError=append:${INSTALL_DIR}/logs/daemon.err

[Install]
WantedBy=multi-user.target
SERVICE
    sudo systemctl daemon-reload
    sudo systemctl enable memoryos 2>/dev/null || true
    info "Daemon registered via systemd — run: sudo systemctl start memoryos"
  fi
}

print_success() {
  echo ""
  echo -e "  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "  ${GREEN}${BOLD}  MemoryOS installed successfully!${NC}"
  echo -e "  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo "  Next steps:"
  echo ""
  echo -e "  1. Add API keys to  ${YELLOW}${INSTALL_DIR}/config/.env${NC}"
  echo -e "  2. Enable connectors in  ${YELLOW}${INSTALL_DIR}/config/config.yaml${NC}"
  echo -e "  3. Start the daemon:  ${BOLD}memoryos start${NC}"
  echo -e "  4. Run initial sync:  ${BOLD}memoryos sync --full${NC}"
  echo -e "  5. Query the brain:   ${BOLD}memoryos ask \"why did we migrate to Postgres?\"${NC}"
  echo ""
  echo "  MCP endpoint (for Claude/Copilot): http://localhost:7890/mcp"
  echo "  Neo4j browser:                     http://localhost:7474"
  echo ""
  echo -e "  ${YELLOW}Docs:${NC} https://memoryos.dev/docs"
  echo ""
}

main() {
  banner
  detect_os
  check_prerequisites
  setup_directories
  pull_source
  install_node_modules
  start_neo4j
  initialize_schema
  create_config
  install_cli_binary
  register_daemon
  print_success
}

main "$@"
