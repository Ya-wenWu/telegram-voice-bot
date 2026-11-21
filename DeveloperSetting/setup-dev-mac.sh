#!/usr/bin/env bash
set -e

# 自動定位並切換至專案根目錄 (上一層資料夾)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE}")" && pwd)"
cd "$SCRIPT_DIR/.."
echo "工作目錄已鎖定為專案根目錄: $(pwd)"

echo "=== 1. 檢查並安裝 Homebrew (macOS 套件管理器) ==="
if ! command -v brew >/dev/null 2>&1; then
  echo "未偵測到 Homebrew，正在為您自動安裝..."
  BREW_RAW="https://raw.githubusercontent.com"
  /bin/bash -c "$(curl -fsSL "$BREW_RAW/Homebrew/install/HEAD/install.sh")"
  # 載入 Apple Silicon 或 Intel Mac 的 Homebrew 環境變數
  if [ -x "/opt/homebrew/bin/brew" ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x "/usr/local/bin/brew" ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
else
  echo "Homebrew 已安裝。"
fi


echo "=== 2. 自動安裝 Gitleaks 與 Node.js ==="
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "正在透過 Homebrew 安裝 Gitleaks..."
  brew install gitleaks
else
  echo "Gitleaks 已安裝 ($(gitleaks version))，略過。"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "正在透過 Homebrew 安裝 Node.js..."
  brew install node@22 && brew link --overwrite --force node@22
else
  echo "Node.js 已安裝 ($(node -v))，略過。"
fi

echo "=== 3. 若有安裝 VS Code，自動配置 SonarQube for IDE ==="
VSCODE_CLI=""
if command -v code >/dev/null 2>&1; then
  VSCODE_CLI="code"
elif [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  VSCODE_CLI="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
fi

if [ -n "$VSCODE_CLI" ]; then
  "$VSCODE_CLI" --install-extension SonarSource.sonarlint-vscode --force || true
  VSCODE_USER_DIR="$HOME/Library/Application Support/Code/User"
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
  echo "VS Code SonarQube 擴充套件與規則已配置完成。"
else
  echo "未偵測到 VS Code，略過 IDE 擴充套件安裝。"
fi

echo "=== 4. 安裝 Git Pre-commit Hook (Gitleaks) ==="
if [ -d ".git" ]; then
  HOOK_PATH=".git/hooks/pre-commit"
  cat << 'EOF' > "$HOOK_PATH"
#!/bin/sh
# 確保 macOS GUI Git 工具 (如 VS Code / Sourcetree / GitHub Desktop) 找得到 Homebrew 的 gitleaks
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
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

echo "=== 5. 安全還原 npm 套件 ==="
if [ -f "package-lock.json" ]; then
  npm ci --ignore-scripts
  npm rebuild esbuild
fi

echo ""
echo "🎉 macOS 開發環境與 Gitleaks 敏感資料防護網已全部自動化部署完成！"
