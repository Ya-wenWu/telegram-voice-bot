$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host ""
Write-Host "=== Web Voice Bot (Windows 11) 啟動與防呆檢查 ===" -ForegroundColor Cyan

# 1. Node.js 20+ check
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "找不到 node，請先安裝 Node.js 20+ (https://nodejs.org/) 並重開終端機。"
}
$nodeVer = (& node -v).Trim().TrimStart("v")
$nodeMajor = [int]($nodeVer.Split(".")[0])
if ($nodeMajor -lt 20) {
    Write-Error "Node.js 版本過舊 (目前 v$nodeVer)，請升級至 Node.js 20+ (https://nodejs.org/)。"
}
Write-Host "[OK] Node.js v$nodeVer" -ForegroundColor Green

# 2. Python 3.11+ check
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "找不到 python，請先安裝 Python 3.11+ 並勾選 'Add python.exe to PATH'。"
}
$pyVer = (& python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')").Trim()
$pyParts = $pyVer.Split(".")
if (([int]$pyParts[0] -lt 3) -or (([int]$pyParts[0] -eq 3) -and ([int]$pyParts[1] -lt 11))) {
    Write-Error "Python 版本過舊 (目前 $pyVer)，請安裝 Python 3.11+。"
}
Write-Host "[OK] Python $pyVer" -ForegroundColor Green

# 3. ffmpeg check
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Warning "找不到 ffmpeg！純文字對話仍可用，但麥克風語音辨識與 MP3 語音回覆會失敗。"
    Write-Host "    安裝指令：winget install Gyan.FFmpeg  （裝完後請重開終端機）" -ForegroundColor Yellow
} else {
    Write-Host "[OK] ffmpeg 已安裝" -ForegroundColor Green
}

# 4. Auto-enable Git secret leak protection hook if inside a git repo
if ((Test-Path ".git") -and (Get-Command git -ErrorAction SilentlyContinue)) {
    $currentHooks = (& git config --get core.hooksPath 2>$null)
    if ([string]::IsNullOrWhiteSpace($currentHooks) -and (Test-Path ".githooks\pre-commit")) {
        & git config core.hooksPath .githooks
        Write-Host "[OK] 已自動啟用 Git 防金鑰外洩 Hook (.githooks/pre-commit)" -ForegroundColor Green
    }
    $trackedEnv = (& git ls-files .env 2>$null)
    if (-not [string]::IsNullOrWhiteSpace($trackedEnv)) {
        Write-Warning "警告：.env 目前被 Git 追蹤中！請執行 'git rm --cached .env' 以免把 API Key 推上 GitHub。"
    }
}

# 5. Install Node.js dependencies
if (-not (Test-Path "node_modules")) {
    Write-Host "正在安裝 Node.js 依賴 (npm install)..." -ForegroundColor Yellow
    npm install
}

# 6. Create Python venv & install dependencies
$venvPy = ".\telegram-voice-bot\.venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
    Write-Host "正在建立 Python 虛擬環境並安裝依賴..." -ForegroundColor Yellow
    python -m venv telegram-voice-bot\.venv
    & $venvPy -m pip install --upgrade pip
    & $venvPy -m pip install -r telegram-voice-bot\requirements-dev.txt
}

# 7. Foolproof .env & GEMINI_API_KEY setup (masked input, never echoes key)
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "[INFO] 已從 .env.example 建立本機 .env（已在 .gitignore 排除，不會上傳 Git）" -ForegroundColor Cyan
}

function Get-EnvValue([string]$filePath, [string]$keyName) {
    if (-not (Test-Path $filePath)) { return "" }
    foreach ($line in Get-Content $filePath -Encoding UTF8) {
        $trimmed = $line.Trim()
        if ($trimmed.StartsWith("#") -or (-not $trimmed.Contains("="))) { continue }
        $parts = $trimmed.Split("=", 2)
        if ($parts[0].Trim() -eq $keyName) {
            return $parts[1].Trim().Trim('"').Trim("'")
        }
    }
    return ""
}

function Set-EnvValue([string]$filePath, [string]$keyName, [string]$newValue) {
    $lines = Get-Content $filePath -Encoding UTF8
    $updated = $false
    $out = @()
    foreach ($line in $lines) {
        if ($line -match "^\s*$([regex]::Escape($keyName))\s*=") {
            $out += "$keyName=`"$newValue`""
            $updated = $true
        } else {
            $out += $line
        }
    }
    if (-not $updated) {
        $out += "$keyName=`"$newValue`""
    }
    [System.IO.File]::WriteAllLines((Resolve-Path $filePath), $out, (New-Object System.Text.UTF8Encoding($false)))
}

$placeholderPattern = "^(MY_GEMINI_API_KEY|YOUR_API_KEY|YOUR_GEMINI_API_KEY|REPLACE_ME|CHANGEME|EXAMPLE|TEST|XXX+|TODO|<.*>)$"
$validKeyChars = "^[A-Za-z0-9_-]{20,}$"
$existingKey = Get-EnvValue ".env" "GEMINI_API_KEY"
if ([string]::IsNullOrWhiteSpace($existingKey)) {
    $existingKey = $env:GEMINI_API_KEY
}

if ([string]::IsNullOrWhiteSpace($existingKey) -or ($existingKey -imatch $placeholderPattern) -or ($existingKey -notmatch $validKeyChars)) {
    Write-Host ""
    Write-Host "尚未設定有效的 GEMINI_API_KEY（免費申請：https://aistudio.google.com/apikey）" -ForegroundColor Yellow
    Write-Host "請直接貼上你的 Gemini API Key（輸入過程會自動隱藏，只寫入本機 .env）：" -ForegroundColor Yellow
    $secKey = Read-Host "GEMINI_API_KEY" -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secKey)
    try {
        $plainKey = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr).Trim()
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }

    if ([string]::IsNullOrWhiteSpace($plainKey) -or ($plainKey -imatch $placeholderPattern) -or ($plainKey -notmatch $validKeyChars)) {
        Write-Error "金鑰為空或格式無效（Gemini API Key 僅允許英數字與 _ -，且長度至少 20 字元）。請重新執行本腳本。"
    }
    Set-EnvValue ".env" "GEMINI_API_KEY" $plainKey
    Write-Host "[OK] 已安全寫入本機 .env（已受 .gitignore 保護）" -ForegroundColor Green
} else {
    Write-Host "[OK] GEMINI_API_KEY 已就緒" -ForegroundColor Green
}

# 8. Port check
$portStr = Get-EnvValue ".env" "PORT"
if ([string]::IsNullOrWhiteSpace($portStr)) { $portStr = "3000" }
$portNum = [int]$portStr
$inUse = Get-NetTCPConnection -LocalPort $portNum -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
    Write-Warning "Port $portNum 已被其他程式佔用！若無法啟動，請先關閉佔用程式，或在 .env 設定 PORT=$($portNum + 1)。"
}

Write-Host ""
Write-Host "啟動 Web Voice Bot 伺服器 -> http://localhost:$portNum" -ForegroundColor Green
npm run dev
