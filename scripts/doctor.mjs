#!/usr/bin/env node
/**
 * Cross-platform (Windows 11 / Linux / macOS) self-hosting preflight doctor.
 * Run with: npm run doctor
 * Never prints secret values — only pass/warn/fail diagnostics and exact fix commands.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

const PLACEHOLDER_RE =
  /^(my_gemini_api_key|your_api_key|your_gemini_api_key|replace_me|changeme|example|test|xxx+|todo|<.*>)$/i;

let failures = 0;
let warnings = 0;

function pass(label, detail) {
  console.log(`  [OK]   ${label}${detail ? ` — ${detail}` : ''}`);
}

function warn(label, detail, fix) {
  warnings += 1;
  console.log(`  [WARN] ${label}${detail ? ` — ${detail}` : ''}`);
  if (fix) console.log(`         建議處理：${fix}`);
}

function fail(label, detail, fix) {
  failures += 1;
  console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
  if (fix) console.log(`         修正方式：${fix}`);
}

function runCmd(cmd, args, cwd = ROOT) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: 'utf-8',
    shell: false,
    timeout: 10000,
  });
}

function parseEnvFile(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function resolvePythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const candidates = [
    path.join(ROOT, 'telegram-voice-bot', '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, 'telegram-voice-bot', '.venv', 'bin', 'python'),
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, '.venv', 'bin', 'python'),
    '/opt/bot-venv/bin/python',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return IS_WIN ? 'python' : 'python3';
}

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '127.0.0.1');
  });
}

async function main() {
  console.log('');
  console.log('=== Web Voice Bot 環境與安全防呆檢查 (npm run doctor) ===');
  console.log(`作業系統：${IS_WIN ? 'Windows' : process.platform} (${process.arch})`);
  console.log('');

  // 1. Node.js >= 20
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor >= 20) {
    pass('Node.js 版本', `v${process.versions.node}`);
  } else {
    fail(
      'Node.js 版本過舊',
      `目前 v${process.versions.node}，需 Node.js 20+`,
      '請至 https://nodejs.org/ 安裝 LTS 版本 (20 或 22)'
    );
  }

  // 2. node_modules
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
    pass('Node.js 套件 (node_modules)', '已安裝');
  } else {
    fail('找不到 node_modules', '尚未安裝前端與伺服器套件', '請執行：npm install');
  }

  // 3. Python >= 3.11 & venv packages
  const pyBin = resolvePythonBin();
  const pyVer = runCmd(pyBin, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")']);
  if (pyVer.status === 0 && pyVer.stdout.trim()) {
    const verStr = pyVer.stdout.trim();
    const [maj, min] = verStr.split('.').map((n) => Number.parseInt(n, 10));
    if (maj > 3 || (maj === 3 && min >= 11)) {
      pass('Python 執行環境', `${verStr} (${pyBin})`);
    } else {
      fail('Python 版本過舊', `目前 ${verStr}，需 Python 3.11+`, '請安裝 Python 3.11 以上版本');
    }

    const depCheck = runCmd(pyBin, ['-c', 'import redis, edge_tts, dotenv, httpx; print("OK")']);
    if (depCheck.status === 0 && depCheck.stdout.includes('OK')) {
      pass('Python 核心相依套件', 'redis / edge-tts / python-dotenv / httpx 皆可用');
    } else {
      fail(
        'Python 核心相依套件缺失',
        '缺少 redis / edge-tts / dotenv / httpx 等套件',
        IS_WIN
          ? '執行 powershell -ExecutionPolicy Bypass -File .\\start-win11.ps1 自動建立虛擬環境'
          : '執行 ./start-linux.sh 自動建立虛擬環境'
      );
    }
  } else {
    fail(
      '找不到 Python 3.11+',
      pyVer.error?.message || pyVer.stderr?.trim() || '無法執行 python',
      IS_WIN
        ? '請安裝 Python 3.11+ 並勾選 Add python.exe to PATH'
        : 'sudo apt update && sudo apt install -y python3 python3-venv'
    );
  }

  // 4. ffmpeg
  const ff = runCmd('ffmpeg', ['-version']);
  if (ff.status === 0) {
    const firstLine = (ff.stdout || '').split(/\r?\n/)[0] || 'available';
    pass('ffmpeg 音訊引擎', firstLine.slice(0, 64));
  } else {
    warn(
      '找不到 ffmpeg',
      '純文字對話仍可用，但麥克風語音辨識與 MP3 語音回覆會失敗',
      IS_WIN
        ? 'winget install Gyan.FFmpeg（裝完後請重開終端機）'
        : 'sudo apt update && sudo apt install -y ffmpeg'
    );
  }

  // 5. .env & GEMINI_API_KEY check (never prints secret!)
  const envPath = path.join(ROOT, '.env');
  const envMap = parseEnvFile(envPath);
  const apiKey = (process.env.GEMINI_API_KEY || envMap.GEMINI_API_KEY || '').trim();

  if (!apiKey) {
    fail(
      'GEMINI_API_KEY 未設定',
      fs.existsSync(envPath) ? '.env 存在但 GEMINI_API_KEY 為空' : '找不到 .env 檔案',
      IS_WIN
        ? '執行 .\\start-win11.ps1 依畫面提示隱藏輸入金鑰（至 https://aistudio.google.com/apikey 免費申請）'
        : '執行 ./start-linux.sh 依畫面提示隱藏輸入金鑰（至 https://aistudio.google.com/apikey 免費申請）'
    );
  } else if (PLACEHOLDER_RE.test(apiKey)) {
    fail(
      'GEMINI_API_KEY 仍是範例佔位字',
      '尚未替換成真實的 Gemini API Key',
      '請編輯 .env 或重新執行啟動腳本，填入在 https://aistudio.google.com/apikey 取得的金鑰'
    );
  } else if (/\s/.test(apiKey) || apiKey.length < 20) {
    fail(
      'GEMINI_API_KEY 格式異常',
      '金鑰包含空白或長度過短（Gemini API Key 通常為 39 字元且不含空白）',
      '請重新複製完整金鑰並確認沒有多餘空格或換行'
    );
  } else {
    pass('GEMINI_API_KEY 格式檢查', '已設定且非範例佔位字（已遮罩不顯示）');
  }

  // 6. Git safety guardrails (.gitignore + tracked .env + pre-commit hook)
  const gitDir = path.join(ROOT, '.git');
  if (fs.existsSync(gitDir)) {
    const trackedEnv = runCmd('git', ['ls-files', '--error-unmatch', '.env']);
    if (trackedEnv.status === 0) {
      fail(
        '危險：.env 正被 Git 追蹤中！',
        '若執行 git push 會把你的 API Key 公開到 GitHub',
        '立刻執行：git rm --cached .env'
      );
    } else {
      pass('Git 安全檢查 (.env)', '.env 未被 Git 追蹤');
    }

    const hooksPath = runCmd('git', ['config', '--get', 'core.hooksPath']);
    const defaultHookExists = fs.existsSync(path.join(gitDir, 'hooks', 'pre-commit'));
    if (hooksPath.status === 0 && hooksPath.stdout.trim() === '.githooks') {
      pass('Git 防外洩 pre-commit Hook', '已啟用 (.githooks/pre-commit，支援自動串接 Gitleaks)');
    } else if (defaultHookExists) {
      pass('Git 防外洩 pre-commit Hook', '已啟用 (.git/hooks/pre-commit)');
    } else {
      warn(
        'Git 防外洩 Hook 尚未啟用',
        '建議啟用內建 pre-commit 檢查，避免誤把 .env 或 API Key commit 上去',
        '執行：git config core.hooksPath .githooks（或執行 DeveloperSetting/ 內建腳本）'
      );
    }
  } else {
    pass('Git 追蹤檢查', '目前為 ZIP 解壓目錄（非 Git repo）');
  }

  // 7. Port check
  const port = Number.parseInt(process.env.PORT || envMap.PORT || '3000', 10) || 3000;
  const portFree = await checkPortAvailable(port);
  if (portFree) {
    pass(`Port ${port} 檢查`, '目前未被佔用，可直接啟動');
  } else {
    warn(
      `Port ${port} 已被佔用`,
      '可能是本服務已在執行中，或其他程式佔用了該埠號',
      `若要改用其他埠號，請在 .env 設定 PORT=${port + 1}`
    );
  }

  console.log('');
  if (failures > 0) {
    console.log(`檢查完成：${failures} 項待修正，${warnings} 項提醒。修正後即可執行 npm run dev。`);
    process.exit(1);
  } else if (warnings > 0) {
    console.log(`檢查完成：核心項目皆通過，另有 ${warnings} 項提醒。`);
  } else {
    console.log('檢查完成：全部環境與防呆安全項目皆通過！可執行 npm run dev 啟動。');
  }
  console.log('');
}

main().catch((err) => {
  console.error('Doctor execution error:', err);
  process.exit(1);
});
