# 自動定位並切換至專案根目錄 (上一層資料夾)
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot
Write-Host "工作目錄已鎖定為專案根目錄: $RepoRoot" -ForegroundColor DarkGray

Write-Host "=== 1. 設定 PowerShell 執行原則 (RemoteSigned) ===" -ForegroundColor Cyan
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force

Write-Host "=== 2. 自動安裝 Gitleaks 與 Node.js LTS (透過 winget) ===" -ForegroundColor Cyan
if (-not (Get-Command gitleaks -ErrorAction SilentlyContinue)) {
    Write-Host "正在安裝 Gitleaks..." -ForegroundColor Yellow
    winget install -e --id Gitleaks.Gitleaks --accept-package-agreements --accept-source-agreements
} else {
    Write-Host "Gitleaks 已安裝。" -ForegroundColor Green
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "正在安裝 Node.js LTS..." -ForegroundColor Yellow
    winget install -e --id OpenJS.NodeJS.LTS --version 22.14.0 --accept-package-agreements --accept-source-agreements
} else {
    Write-Host "Node.js 已安裝。" -ForegroundColor Green
}

Write-Host "=== 3. 自動下載並安裝 Visual Studio 擴充套件：SonarQube for IDE ===" -ForegroundColor Cyan
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $vsInstallDir = & $vswhere -latest -products * -property installationPath
    $vsixInstaller = Join-Path $vsInstallDir "Common7\IDE\VSIXInstaller.exe"
    if (Test-Path $vsixInstaller) {
        Write-Host "正在從 Visual Studio Marketplace 下載 SonarQube for IDE..." -ForegroundColor Yellow
        $galleryHost = "https://marketplace.visualstudio.com"
        $vsixUrl = "$galleryHost/_apis/public/gallery/publishers/SonarSource/vsextensions/SonarLintforVisualStudio2022/latest/vspackage"
        $vsixPath = Join-Path $env:TEMP "SonarQubeForIDE.vsix"
        Invoke-WebRequest -Uri $vsixUrl -OutFile $vsixPath -UseBasicParsing
        Write-Host "正在執行靜默安裝（請確保 Visual Studio 已關閉）..." -ForegroundColor Yellow
        Start-Process -FilePath $vsixInstaller -ArgumentList "/q", "`"$vsixPath`"" -Wait
        Remove-Item $vsixPath -Force -ErrorAction SilentlyContinue
        Write-Host "SonarQube for IDE 安裝程序執行完畢。" -ForegroundColor Green
    }
} else {
    Write-Warning "未偵測到 Visual Studio，請先安裝 Visual Studio 後再安裝 SonarQube for IDE。"
}

Write-Host "=== 4. 寫入 SonarQube for IDE 敏感資料規則 (S2068 / S6437) ===" -ForegroundColor Cyan
$sonarDir = Join-Path $env:APPDATA "SonarLint for Visual Studio"
if (-not (Test-Path $sonarDir)) { New-Item -ItemType Directory -Path $sonarDir -Force | Out-Null }
$sonarJson = @"
{
  "sonarlint.rules": {
    "csharpsquid:S2068": { "level": "On" },
    "csharpsquid:S6437": { "level": "On" },
    "typescript:S2068": { "level": "On" },
    "typescript:S6437": { "level": "On" },
    "javascript:S2068": { "level": "On" },
    "javascript:S6437": { "level": "On" }
  }
}
"@
[System.IO.File]::WriteAllText((Join-Path $sonarDir "settings.json"), $sonarJson, (New-Object System.Text.UTF8Encoding $false))

Write-Host "=== 5. 安裝無 BOM 的 Git Pre-commit Hook (Gitleaks) ===" -ForegroundColor Cyan
if (Test-Path ".git") {
    $hookPath = Join-Path (Resolve-Path ".git\hooks") "pre-commit"
    $hookContent = "#!/bin/sh`necho '正在執行 Gitleaks 敏感資料檢查...'`ngitleaks protect --staged --verbose --redact`nif [ `$? -ne 0 ]; then`n  echo '❌ 偵測到敏感資料！已自動阻擋本次 Commit'`n  exit 1`nfi`n"
    [System.IO.File]::WriteAllText($hookPath, $hookContent, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "Pre-commit Hook 已寫入：$hookPath" -ForegroundColor Green
}

Write-Host "=== 6. 安全還原 npm 套件 ===" -ForegroundColor Cyan
if (Test-Path "package-lock.json") {
    npm.cmd ci --ignore-scripts
    npm.cmd rebuild esbuild
}

Write-Host "`n🎉 Windows 開發環境與資安工具（Gitleaks + SonarQube for IDE）已自動化部署完成！" -ForegroundColor Yellow
