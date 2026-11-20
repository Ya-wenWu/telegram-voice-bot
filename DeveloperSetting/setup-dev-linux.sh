#!/usr/bin/env bash
set -e

# 自動定位並切換至專案根目錄 (上一層資料夾)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE}")" && pwd)"
cd "$SCRIPT_DIR/.."
echo "工作目錄已鎖定為專案根目錄: $(pwd)"

echo "=== 1. 檢查並安裝 Gitleaks 與 Node.js ==="
install_gitleaks_binary() {
  echo "正在從 GitHub Releases 下載最新 Linux 版 Gitleaks..."
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  GL_ARCH="x64" ;;
    aarch64|arm64) GL_ARCH="arm64" ;;
    *) echo "不支援的 CPU 架構: $ARCH"; exit 1 ;;
  esac
  GH_API="https://api.github.com"
  GH_WEB="https://github.com"
  LATEST_TAG=$(curl -fsSL "$GH_API/repos/gitleaks/gitleaks/releases/latest" | grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/')
  URL="$GH_WEB/gitleaks/gitleaks/releases/download/v${LATEST_TAG}/gitleaks_${LATEST_TAG}_linux_${GL_ARCH}.tar.gz"
  TMP_DIR=$(mktemp -d)
  curl -fsSL "$URL" -o "$TMP_DIR/gitleaks.tar.gz"
  tar -xzf "$TMP_DIR/gitleaks.tar.gz" -C "$TMP_DIR"
  sudo mv "$TMP_DIR/gitleaks" /usr/local/bin/gitleaks
  sudo chmod +x /usr/local/bin/gitleaks
  rm -rf "$TMP_DIR"
  echo "Gitleaks v${LATEST_TAG} 安裝完成。"
}

if ! command -v gitleaks >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1 && apt-cache show gitleaks >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y gitleaks
  elif command -v dnf >/dev/null 2>&1 && dnf info gitleaks >/dev/null 2>&1; then
    sudo dnf install -y gitleaks
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm gitleaks
  else
    install_gitleaks_binary
  fi
else
  echo "Gitleaks 已安裝，略過。"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "正在安裝 Node.js..."
  if command -v apt-get >/dev/null 2>&1; then
    NODESOURCE_HOST="https://deb.nodesource.com"
    curl -fsSL "$NODESOURCE_HOST/setup_22.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y nodejs npm
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm nodejs npm
  else
    echo "請手動安裝 Node.js LTS (>= 22.12.0)"
  fi
else
  echo "Node.js 已安裝 ($(node -v))，略過。"
fi


echo "=== 2. 若有安裝 VS Code，自動配置 SonarQube for IDE ==="
if command -v code >/dev/null 2>&1; then
  code --install-extension SonarSource.sonarlint-vscode --force || true
  VSCODE_USER_DIR="$HOME/.config/Code/User"
  mkdir -p "$VSCODE_USER_DIR"
  if [ ! -f "$VSCODE_USER_DIR/settings.json" ]; then
    cat << 'EOF' > "$VSCODE_USER_DIR/settings.json"
{
  "sonarlint.rules": {
    "typescript:S2068": { "level": "On" },
    "typescript:S6437": { "level": "On" },
    "javascript:S2068": { "level": "On" },
    "javascript:S6437": { "level": "On" },
    "python:S2068": { "level": "On" },
    "python:S6437": { "level": "On" }
  }
}
EOF
  fi
  echo "VS Code SonarQube 擴充套件已就緒。"
else
  echo "未偵測到 VS Code，略過 IDE 擴充套件安裝。"
fi

echo "=== 3. 安裝 Git Pre-commit Hook (Gitleaks) ==="
if [ -d ".git" ]; then
  HOOK_PATH=".git/hooks/pre-commit"
  cat << 'EOF' > "$HOOK_PATH"
#!/bin/sh
echo "正在執行 Gitleaks 敏感資料檢查..."
gitleaks protect --staged --verbose --redact
if [ $? -ne 0 ]; then
  echo "❌ 偵測到敏感資料！已自動阻擋本次 Commit，請移除金鑰或改用環境變數。"
  exit 1
fi
EOF
  chmod +x "$HOOK_PATH"
  echo "Pre-commit Hook 已寫入並設定執行權限：$HOOK_PATH"
else
  echo "⚠️ 找不到 .git 資料夾，請確認在專案根目錄執行此腳本。"
fi

echo "=== 4. 安全還原 npm 套件 ==="
if [ -f "package-lock.json" ]; then
  npm ci --ignore-scripts
  npm rebuild esbuild
fi

echo ""
echo "🎉 Linux 開發環境與 Gitleaks 敏感資料防護網已全部自動化部署完成！"
