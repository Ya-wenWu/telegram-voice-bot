/**
 * ISO/IEC 27036 Supply Chain Security, CycloneDX 1.5 SBOM Generator,
 * Supplier Risk Inventory, 5-Clause Contract Attestation, and 14-Day Offboarding Tracker.
 *
 * Security invariants:
 * - Reads ONLY fixed project manifest files (package.json, telegram-voice-bot/requirements*.txt).
 * - NEVER outputs real API keys, tokens, or Redis passwords (strictly boolean/masked metadata).
 * - Persists audit checklist state atomically into a bounded local state file.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = path.resolve(__dirname, 'package.json');
const PY_REQ_PATH = path.resolve(__dirname, 'telegram-voice-bot', 'requirements.txt');
const PY_REQ_DEV_PATH = path.resolve(__dirname, 'telegram-voice-bot', 'requirements-dev.txt');

export type SupplierRiskTier = 'high' | 'medium' | 'low';

export interface SbomComponent {
  type: 'library';
  name: string;
  version: string;
  ecosystem: 'npm' | 'pypi';
  scope: 'required' | 'dev';
  pinned: boolean;
  purl: string;
}

export interface CycloneDxSbom {
  bomFormat: 'CycloneDX';
  specVersion: '1.5';
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    component: {
      type: 'application';
      name: string;
      version: string;
    };
    tools: Array<{ vendor: string; name: string; version: string }>;
  };
  components: Array<{
    type: 'library';
    name: string;
    version: string;
    scope: 'required' | 'optional';
    purl: string;
    properties: Array<{ name: string; value: string }>;
  }>;
  summary: {
    totalComponents: number;
    npmRuntimeCount: number;
    npmDevCount: number;
    pythonRuntimeCount: number;
    pythonDevCount: number;
    unpinnedCount: number;
    unpinnedNames: string[];
  };
}

export interface SupplierInventoryItem {
  id: string;
  name: string;
  category: string;
  riskTier: SupplierRiskTier;
  dataExposure: string;
  configured: boolean;
  credentialEnvNames: string[];
  endpointSummary: string;
  slaRequirement: string;
  offboardingAction: string;
  controls: string[];
}

export interface AuditChecklistItem {
  id: string;
  group: 'contract_5_clauses' | 'offboarding_14d';
  code: string;
  title: string;
  isoRef: string;
  description: string;
  checked: boolean;
  note: string;
  updatedAt: string | null;
}

export interface AutomatedControlCheck {
  id: string;
  stage: 'pre_acquisition' | 'contracting' | 'monitoring' | 'offboarding';
  stageLabel: string;
  title: string;
  status: 'ok' | 'warning';
  detail: string;
}

interface PersistedChecklistState {
  items: Record<string, { checked: boolean; note: string; updatedAt: string }>;
}

const DEFAULT_CHECKLIST_TEMPLATES: Array<
  Omit<AuditChecklistItem, 'checked' | 'note' | 'updatedAt'>
> = [
  {
    id: 'clause_subcontracting',
    group: 'contract_5_clauses',
    code: 'CLAUSE-01',
    title: '分包管制條款（Sub-contracting）',
    isoRef: 'ISO/IEC 27036-2 / 27036-3',
    description: '未經甲方書面同意不得再轉包；經核准之分包商須承擔同等資安與保密義務。',
  },
  {
    id: 'clause_incident_sla',
    group: 'contract_5_clauses',
    code: 'CLAUSE-02',
    title: '24h 早期預警 / 72h 正式通報 SLA',
    isoRef: 'ISO/IEC 27035 / 30111 / CRA Art.14',
    description: '供應商發現影響系統或資料之事件或主動利用漏洞時，須於 24 小時內通知並配合根因調查。',
  },
  {
    id: 'clause_least_privilege_logs',
    group: 'contract_5_clauses',
    code: 'CLAUSE-03',
    title: '最小權限、MFA 與 180 天日誌留存',
    isoRef: 'ISO/IEC 27036-2 / ISO 27001',
    description: '禁止共用帳號、強制 MFA，操作與存取日誌至少留存 6 個月以上供稽核調閱。',
  },
  {
    id: 'clause_deliverable_sbom',
    group: 'contract_5_clauses',
    code: 'CLAUSE-04',
    title: '交付物無高危漏洞報告與 SBOM 清單',
    isoRef: 'ISO/IEC 27036-3 / CRA',
    description: '交付軟體／韌體前須附無高風險漏洞之 SAST／弱掃報告及 CycloneDX/SPDX SBOM。',
  },
  {
    id: 'clause_audit_offboarding',
    group: 'contract_5_clauses',
    code: 'CLAUSE-05',
    title: '實地／書面稽核權與 14 天退場銷毀',
    isoRef: 'ISO/IEC 27036-2 / 27036-4',
    description: '保留定期及事件觸發稽核權；終止後 14 天內清除全部資料並提供書面銷毀證明。',
  },
  {
    id: 'offboard_accounts',
    group: 'offboarding_14d',
    code: 'OFF-01',
    title: 'T+0 撤銷所有外包帳號、VPN 與 MFA 綁定',
    isoRef: 'ISO/IEC 27036-2 §7.5',
    description: '合約終止當日立即停用外包人員專屬存取權限並留存停用紀錄。',
  },
  {
    id: 'offboard_rotate_keys',
    group: 'offboarding_14d',
    code: 'OFF-02',
    title: 'T+1 輪換並作廢所有 API Key、Bot Token 與 Redis 密碼',
    isoRef: 'ISO/IEC 27036-4',
    description: '依序輪換 GEMINI_API_KEY、TELEGRAM_BOT_TOKEN、WHISPER/TTS 金鑰、WEB/ADMIN Token 與 Redis ACL。',
  },
  {
    id: 'offboard_purge_backups',
    group: 'offboarding_14d',
    code: 'OFF-03',
    title: 'T+3 清理測試環境備份、音訊暫存與殘留 .env',
    isoRef: 'ISO/IEC 27036-2 §7.5',
    description: '確認 TMP_DIR、STATE_DIR 及測試主機無殘留語音檔、對話備份或環境變數檔。',
  },
  {
    id: 'offboard_cod_archive',
    group: 'offboarding_14d',
    code: 'OFF-04',
    title: 'T+14 取得《資料安全銷毀證明》並封存最終 SBOM',
    isoRef: 'ISO/IEC 27036-2 / ERM',
    description: '歸檔雙方簽署之 Certificate of Destruction 與最終版 CycloneDX 1.5 SBOM 快照。',
  },
];

const VALID_CHECKLIST_IDS = new Set(DEFAULT_CHECKLIST_TEMPLATES.map((t) => t.id));

function resolveAuditStorePath(): string {
  const baseDir =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || os.tmpdir()
      : process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const dir = path.join(baseDir, 'web-voice-bot');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'iso27036-checklist.json');
  } catch {
    return path.join(os.tmpdir(), 'web-voice-bot-iso27036-checklist.json');
  }
}

const AUDIT_STORE_PATH = resolveAuditStorePath();

function loadPersistedChecklist(): PersistedChecklistState {
  try {
    if (!fs.existsSync(AUDIT_STORE_PATH)) return { items: {} };
    const raw = fs.readFileSync(AUDIT_STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedChecklistState>;
    if (parsed && typeof parsed.items === 'object' && parsed.items !== null) {
      return { items: parsed.items as PersistedChecklistState['items'] };
    }
    return { items: {} };
  } catch {
    return { items: {} };
  }
}

function savePersistedChecklist(state: PersistedChecklistState): void {
  try {
    const tmpPath = `${AUDIT_STORE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, AUDIT_STORE_PATH);
  } catch {
    // Best-effort persistence
  }
}

function sanitizeUrlHostOnly(rawUrl: string | undefined, fallback: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return fallback;
  try {
    const u = new URL(trimmed);
    const portPart = u.port ? `:${u.port}` : '';
    return `${u.protocol}//${u.hostname}${portPart}`;
  } catch {
    return fallback;
  }
}

function isRealEnvValue(key: string): boolean {
  const val = (process.env[key] || '').trim();
  if (!val) return false;
  if (/^(?:your_|placeholder|changeme|example|xxx|test_key)/i.test(val)) return false;
  return true;
}

function encodeNpmPurl(name: string, version: string): string {
  const cleanedVersion = version.replace(/^[\^~>=<\s]+/, '') || 'unpinned';
  if (name.startsWith('@')) {
    const [scope, pkg] = name.split('/');
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(pkg || '')}@${encodeURIComponent(cleanedVersion)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(cleanedVersion)}`;
}

function parsePythonRequirements(filePath: string, scope: 'required' | 'dev'): SbomComponent[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  const result: SbomComponent[] = [];
  for (const rawLine of lines) {
    const line = rawLine.split('#')[0].trim();
    if (!line || line.startsWith('-r ') || line.startsWith('--')) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*(?:([=<>!~]+)\s*([^\s;]+))?/);
    if (!match) continue;
    const name = match[1];
    const op = match[2] || '';
    const ver = match[3] || '';
    const hasVersion = Boolean(ver);
    const versionDisplay = hasVersion ? `${op}${ver}` : 'unpinned';
    const purlVer = hasVersion ? ver : 'unpinned';
    result.push({
      type: 'library',
      name,
      version: versionDisplay,
      ecosystem: 'pypi',
      scope,
      pinned: hasVersion,
      purl: `pkg:pypi/${encodeURIComponent(name.toLowerCase())}@${encodeURIComponent(purlVer)}`,
    });
  }
  return result;
}

export function generateProjectSbom(): CycloneDxSbom {
  const components: SbomComponent[] = [];
  let appName = 'web-voice-bot';
  let appVersion = '1.0.0';

  if (fs.existsSync(PACKAGE_JSON_PATH)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as {
        name?: string;
        version?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (pkg.name) appName = pkg.name;
      if (pkg.version) appVersion = pkg.version;
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        const pinned = Boolean(version && !/^(?:\*|latest)$/i.test(version.trim()));
        components.push({
          type: 'library',
          name,
          version: String(version),
          ecosystem: 'npm',
          scope: 'required',
          pinned,
          purl: encodeNpmPurl(name, String(version)),
        });
      }
      for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
        const pinned = Boolean(version && !/^(?:\*|latest)$/i.test(version.trim()));
        components.push({
          type: 'library',
          name,
          version: String(version),
          ecosystem: 'npm',
          scope: 'dev',
          pinned,
          purl: encodeNpmPurl(name, String(version)),
        });
      }
    } catch {
      // ignore malformed package.json
    }
  }

  components.push(...parsePythonRequirements(PY_REQ_PATH, 'required'));
  components.push(...parsePythonRequirements(PY_REQ_DEV_PATH, 'dev'));

  const npmRuntimeCount = components.filter((c) => c.ecosystem === 'npm' && c.scope === 'required').length;
  const npmDevCount = components.filter((c) => c.ecosystem === 'npm' && c.scope === 'dev').length;
  const pythonRuntimeCount = components.filter((c) => c.ecosystem === 'pypi' && c.scope === 'required').length;
  const pythonDevCount = components.filter((c) => c.ecosystem === 'pypi' && c.scope === 'dev').length;
  const unpinned = components.filter((c) => !c.pinned);

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: 'application',
        name: appName,
        version: appVersion,
      },
      tools: [
        {
          vendor: 'Web Voice Bot',
          name: 'ISO27036-SBOM-Generator',
          version: '1.0.0',
        },
      ],
    },
    components: components.map((c) => ({
      type: 'library',
      name: c.name,
      version: c.version,
      scope: c.scope === 'required' ? 'required' : 'optional',
      purl: c.purl,
      properties: [
        { name: 'ecosystem', value: c.ecosystem },
        { name: 'dependency_scope', value: c.scope },
        { name: 'version_pinned', value: String(c.pinned) },
      ],
    })),
    summary: {
      totalComponents: components.length,
      npmRuntimeCount,
      npmDevCount,
      pythonRuntimeCount,
      pythonDevCount,
      unpinnedCount: unpinned.length,
      unpinnedNames: unpinned.map((u) => `${u.ecosystem}:${u.name}`),
    },
  };
}

export function buildSupplierRiskInventory(): SupplierInventoryItem[] {
  const ttsProvider = (process.env.TTS_PROVIDER || 'edge').trim().toLowerCase() || 'edge';
  const whisperCustomUrl = (process.env.WHISPER_URL || '').trim();

  return [
    {
      id: 'google-gemini',
      name: 'Google Gemini API',
      category: 'AI 對話與語音辨識（LLM / STT）',
      riskTier: 'high',
      dataExposure: '使用者文字提問、正規化語音內容、當日多輪上下文',
      configured: isRealEnvValue('GEMINI_API_KEY'),
      credentialEnvNames: ['GEMINI_API_KEY'],
      endpointSummary: 'https://generativelanguage.googleapis.com',
      slaRequirement: '24h 重大異常早期預警 / 72h 正式影響報告',
      offboardingAction: '撤銷 API Key、停用專案金鑰權限並驗證呼叫失效',
      controls: ['Prompt Injection 防護', '輸出金鑰遮罩', '僅後端代理呼叫'],
    },
    {
      id: 'telegram-bot-api',
      name: 'Telegram Bot API',
      category: '即時通訊入口（Messaging Ingress）',
      riskTier: 'high',
      dataExposure: 'Telegram User ID、文字與 OGG 語音訊息',
      configured:
        isRealEnvValue('TELEGRAM_BOT_TOKEN') ||
        isRealEnvValue('TELEGRAM_BOT_TOKENS') ||
        isRealEnvValue('BOTS_REGISTRY_JSON'),
      credentialEnvNames: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKENS'],
      endpointSummary: 'https://api.telegram.org',
      slaRequirement: '24h 憑證外洩緊急撤銷與通知',
      offboardingAction: '透過 @BotFather 執行 /revoke 並移除 Webhook 設定',
      controls: ['預設拒絕白名單 (ALLOWED_USER_IDS)', 'BotGuard 攔截 is_bot 帳號', '日誌 Token 遮罩'],
    },
    {
      id: 'whisper-stt',
      name: whisperCustomUrl ? '自建 Whisper STT 服務' : 'Groq / OpenAI 相容 Whisper STT',
      category: '語音轉文字引擎（STT）',
      riskTier: 'high',
      dataExposure: '16kHz 壓縮音訊串流與轉錄文字',
      configured: Boolean(whisperCustomUrl) || isRealEnvValue('WHISPER_API_KEY'),
      credentialEnvNames: whisperCustomUrl ? ['WHISPER_URL'] : ['WHISPER_API_KEY'],
      endpointSummary: whisperCustomUrl
        ? sanitizeUrlHostOnly(whisperCustomUrl, 'self-hosted')
        : sanitizeUrlHostOnly(process.env.WHISPER_API_BASE, 'https://api.groq.com'),
      slaRequirement: '24h 服務異常與漏洞通報',
      offboardingAction: '撤銷 STT API Key 並清除本機 TMP_DIR 暫存音訊',
      controls: ['音訊體積上限控管', 'FFmpeg 單執行緒隔離轉碼', '處理完畢自動清除暫存'],
    },
    {
      id: 'tts-provider',
      name:
        ttsProvider === 'openai'
          ? 'OpenAI 相容 TTS 服務'
          : ttsProvider === 'piper'
            ? '本機離線 Piper TTS'
            : 'Microsoft Edge-TTS 服務',
      category: '語音合成引擎（TTS）',
      riskTier: ttsProvider === 'piper' ? 'low' : 'medium',
      dataExposure: 'AI 回覆純文字內容（經敏感資訊遮罩後）',
      configured: ttsProvider === 'openai' ? isRealEnvValue('TTS_API_KEY') : true,
      credentialEnvNames: ttsProvider === 'openai' ? ['TTS_API_KEY'] : ['TTS_PROVIDER'],
      endpointSummary:
        ttsProvider === 'openai'
          ? sanitizeUrlHostOnly(process.env.TTS_API_BASE, 'https://api.openai.com')
          : ttsProvider === 'piper'
            ? 'local://piper'
            : 'wss://speech.platform.bing.com',
      slaRequirement: '24h 異常通知；逾時自動降級純文字回覆',
      offboardingAction: '撤銷 TTS API Key 並確認降級策略可用',
      controls: ['逾時安全降級純文字', '併發信號量限流', '敏感輸出預先過濾'],
    },
    {
      id: 'redis-store',
      name: 'Redis 配額與分散式租約服務',
      category: '快取與併發限流（Quota / Semaphore）',
      riskTier: 'medium',
      dataExposure: '使用者配額計數鍵值與短效資源租約（不含對話內容）',
      configured: Boolean((process.env.REDIS_URL || 'redis://127.0.0.1:6379/0').trim()),
      credentialEnvNames: ['REDIS_URL'],
      endpointSummary: sanitizeUrlHostOnly(process.env.REDIS_URL, 'redis://127.0.0.1:6379'),
      slaRequirement: 'Fail-Open 容錯降級；憑證外洩 24h 內輪換',
      offboardingAction: '輪換 Redis ACL 密碼並清除專案 keyspace',
      controls: ['連線失敗自動 Fail-Open', 'URL 內嵌密碼日誌遮罩', '租約 TTL 自動釋放'],
    },
  ];
}

export function updateChecklistItem(
  id: string,
  checked: boolean,
  note?: string
): { ok: boolean; error?: string; item?: AuditChecklistItem } {
  if (!VALID_CHECKLIST_IDS.has(id)) {
    return { ok: false, error: '無效的 ISO/IEC 27036 檢核項目編號。' };
  }
  const safeNote = String(note ?? '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .slice(0, 200);
  const state = loadPersistedChecklist();
  const updatedAt = new Date().toISOString();
  state.items[id] = {
    checked: Boolean(checked),
    note: safeNote,
    updatedAt,
  };
  savePersistedChecklist(state);

  const tpl = DEFAULT_CHECKLIST_TEMPLATES.find((t) => t.id === id)!;
  return {
    ok: true,
    item: {
      ...tpl,
      checked: Boolean(checked),
      note: safeNote,
      updatedAt,
    },
  };
}

export function buildIso27036AuditSnapshot() {
  const sbom = generateProjectSbom();
  const suppliers = buildSupplierRiskInventory();
  const persisted = loadPersistedChecklist();

  const checklist: AuditChecklistItem[] = DEFAULT_CHECKLIST_TEMPLATES.map((tpl) => {
    const saved = persisted.items[tpl.id];
    return {
      ...tpl,
      checked: saved ? Boolean(saved.checked) : false,
      note: saved?.note ?? '',
      updatedAt: saved?.updatedAt ?? null,
    };
  });

  const gitHookPresent = fs.existsSync(path.resolve(__dirname, '.githooks', 'pre-commit'));
  const gitignorePresent = fs.existsSync(path.resolve(__dirname, '.gitignore'));
  const botGuardOn = (process.env.BOT_GUARD_ENABLED || 'true').trim().toLowerCase() !== 'false';
  const webTokenSet = isRealEnvValue('WEB_API_TOKEN');
  const adminTokenSet = isRealEnvValue('ADMIN_API_TOKEN');

  const automatedControls: AutomatedControlCheck[] = [
    {
      id: 'ctrl_supplier_tiering',
      stage: 'pre_acquisition',
      stageLabel: '1. 採購前評估與分級',
      title: '外部供應商風險分級盤點',
      status: 'ok',
      detail: `已納管 ${suppliers.length} 項外部服務供應商（高風險 ${
        suppliers.filter((s) => s.riskTier === 'high').length
      }、中風險 ${suppliers.filter((s) => s.riskTier === 'medium').length}），並記錄各服務憑證變數與退場動作。`,
    },
    {
      id: 'ctrl_sbom_pinning',
      stage: 'monitoring',
      stageLabel: '3. 履約監控與 SBOM',
      title: 'CycloneDX 1.5 SBOM 與套件版本鎖定',
      status: sbom.summary.unpinnedCount === 0 ? 'ok' : 'warning',
      detail:
        sbom.summary.unpinnedCount === 0
          ? `已盤點 ${sbom.summary.totalComponents} 項 npm/PyPI 元件，全部具備版本範圍宣告並支援一鍵匯出 CycloneDX 1.5 SBOM。`
          : `已盤點 ${sbom.summary.totalComponents} 項元件（npm ${
              sbom.summary.npmRuntimeCount + sbom.summary.npmDevCount
            } / PyPI ${
              sbom.summary.pythonRuntimeCount + sbom.summary.pythonDevCount
            }），其中 ${sbom.summary.unpinnedCount} 項開發相依套件尚未鎖定版本（${sbom.summary.unpinnedNames.join(
              '、'
            )}）。`,
    },
    {
      id: 'ctrl_access_botguard',
      stage: 'monitoring',
      stageLabel: '3. 履約監控與最小權限',
      title: '存取保護、反惡意機器人與機敏防外洩',
      status: gitHookPresent && gitignorePresent && botGuardOn ? 'ok' : 'warning',
      detail: `防惡意機器人：${botGuardOn ? '啟用' : '停用'} · Git 防外洩 Hook：${
        gitHookPresent && gitignorePresent ? '就緒' : '未完整啟用'
      } · 遠端 API Token：${webTokenSet ? '已設定' : '僅限本機/雲端沙盒'} · 管理端點 Token：${
        adminTokenSet ? '已啟用' : '選填未啟用'
      }。`,
    },
    {
      id: 'ctrl_contract_sla_attestation',
      stage: 'contracting',
      stageLabel: '2. 合約與通報 SLA 綁定',
      title: '委外合約 5 大保命條款檢核完成度',
      status:
        checklist.filter((c) => c.group === 'contract_5_clauses' && c.checked).length === 5
          ? 'ok'
          : 'warning',
      detail: `已完成 ${
        checklist.filter((c) => c.group === 'contract_5_clauses' && c.checked).length
      }/5 項合約條款確認（含 24h 早期預警／72h 正式通報 SLA 與分包限制）。`,
    },
    {
      id: 'ctrl_offboarding_readiness',
      stage: 'offboarding',
      stageLabel: '4. 委外終止與 14 天退場',
      title: '退場憑證輪換與資料銷毀程序就緒度',
      status:
        checklist.filter((c) => c.group === 'offboarding_14d' && c.checked).length === 4
          ? 'ok'
          : 'warning',
      detail: `已完成 ${
        checklist.filter((c) => c.group === 'offboarding_14d' && c.checked).length
      }/4 項退場銷毀檢核（含 T+0 帳號撤銷、T+1 金鑰輪換與 T+14 銷毀證明歸檔）。`,
    },
  ];

  const contractChecked = checklist.filter(
    (c) => c.group === 'contract_5_clauses' && c.checked
  ).length;
  const offboardChecked = checklist.filter(
    (c) => c.group === 'offboarding_14d' && c.checked
  ).length;
  const governanceArtifact = loadIso27036GovernanceArtifact();

  return {
    generatedAt: new Date().toISOString(),
    standard: 'ISO/IEC 27036 (Parts 1-4)',
    crossStandards: ['ISO/IEC 27035', 'ISO/IEC 30111', 'EU CRA / NIS2 / DORA', 'ISO/IEC 27001 / ERM'],
    sbomSummary: sbom.summary,
    suppliers,
    automatedControls,
    checklist,
    governanceArtifact,
    summary: {
      totalSuppliers: suppliers.length,
      highRiskSuppliers: suppliers.filter((s) => s.riskTier === 'high').length,
      totalSbomComponents: sbom.summary.totalComponents,
      unpinnedSbomComponents: sbom.summary.unpinnedCount,
      contractClausesCompleted: contractChecked,
      contractClausesTotal: 5,
      offboardingCompleted: offboardChecked,
      offboardingTotal: 4,
    },
  };
}

export interface ParsedBlindSpotRow {
  traditional: string;
  failureReason: string;
  iso27036Remedy: string;
}

export interface ParsedLifecycleStage {
  step: string;
  title: string;
  bullets: string[];
}

export interface ParsedContractChecklistPoint {
  index: number;
  checklistId: string;
  title: string;
  description: string;
  checkedInArtifact: boolean;
}

export interface ParsedCrossStandardRow {
  standard: string;
  alignment: string;
  projectImplementation: string;
}

export interface ParsedContractAnnexClause {
  title: string;
  body: string;
}

export interface ParsedOffboardingStep {
  code: string;
  item: string;
  owner: string;
  deadline: string;
  evidence: string;
}

export interface ParsedArtifactSupplierRow {
  supplier: string;
  roleAndFlow: string;
  riskTierLabel: string;
  credentials: string;
  controlsAndSla: string;
  offboardingAction: string;
}

export interface RelatedArtifactMetadata {
  id: string;
  fileName: string;
  summary: string;
  updatedAt: string | null;
  userFacing: boolean;
  sizeBytes: number;
  isCurrent: boolean;
}

export interface GovernanceArtifactPayload {
  id: string;
  fileName: string;
  title: string;
  summary: string;
  updatedAt: string | null;
  userFacing: boolean;
  sourceAvailable: boolean;
  sizeBytes: number;
  introNotes: string[];
  blindSpots: ParsedBlindSpotRow[];
  lifecycleStages: ParsedLifecycleStage[];
  contractChecklistPoints: ParsedContractChecklistPoint[];
  artifactSupplierMatrix: ParsedArtifactSupplierRow[];
  crossStandardMatrix: ParsedCrossStandardRow[];
  contractAnnexClauses: ParsedContractAnnexClause[];
  offboardingTimeline: ParsedOffboardingStep[];
  relatedArtifacts: RelatedArtifactMetadata[];
  rawMarkdown: string;
}

const GOVERNANCE_ARTIFACT_FILENAME = 'iso27036_supply_chain_governance.md';
const CONTRACT_CLAUSE_IDS_BY_INDEX = [
  'clause_subcontracting',
  'clause_incident_sla',
  'clause_least_privilege_logs',
  'clause_deliverable_sbom',
  'clause_audit_offboarding',
] as const;

function stripMarkdownInline(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function locateArtifactsBrainDir(): string | null {
  const brainRoot = path.resolve(__dirname, '.aistudio', 'artifacts', 'brain');
  try {
    if (!fs.existsSync(brainRoot) || !fs.statSync(brainRoot).isDirectory()) return null;
    const entries = fs.readdirSync(brainRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Strict containment check
      const candidateDir = path.resolve(brainRoot, entry.name);
      if (!candidateDir.startsWith(`${brainRoot}${path.sep}`)) continue;
      const targetFile = path.resolve(candidateDir, GOVERNANCE_ARTIFACT_FILENAME);
      if (targetFile.startsWith(`${candidateDir}${path.sep}`) && fs.existsSync(targetFile)) {
        return candidateDir;
      }
    }
    // Fallback to first valid brain directory if governance md wasn't found in a specific one
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidateDir = path.resolve(brainRoot, entry.name);
      if (candidateDir.startsWith(`${brainRoot}${path.sep}`)) {
        return candidateDir;
      }
    }
  } catch {
    // Fall through to docs/ fallback
  }
  const docsFallbackDir = path.resolve(__dirname, 'docs');
  try {
    const fallbackFile = path.resolve(docsFallbackDir, GOVERNANCE_ARTIFACT_FILENAME);
    if (fallbackFile.startsWith(`${docsFallbackDir}${path.sep}`) && fs.existsSync(fallbackFile)) {
      return docsFallbackDir;
    }
  } catch {
    return null;
  }
  return null;
}

function extractH3Section(markdown: string, headingKeyword: string): string {
  const lines = markdown.split(/\r?\n/);
  let capturing = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      if (capturing) break;
      if (line.includes(headingKeyword)) {
        capturing = true;
      }
      continue;
    }
    if (capturing && /^##\s+/.test(line)) {
      break;
    }
    if (capturing) {
      collected.push(line);
    }
  }
  return collected.join('\n').trim();
}

function parseMarkdownTableRows(sectionText: string): string[][] {
  const lines = sectionText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && l.endsWith('|'));

  if (lines.length < 3) return [];
  const rows: string[][] = [];
  // Skip header row (0) and separator row (1)
  for (let i = 2; i < lines.length; i += 1) {
    const cells = lines[i]
      .slice(1, -1)
      .split('|')
      .map((cell) => stripMarkdownInline(cell));
    if (cells.some((c) => c.length > 0)) {
      rows.push(cells);
    }
  }
  return rows;
}

function parseLifecycleStages(sectionText: string): ParsedLifecycleStage[] {
  const stages: ParsedLifecycleStage[] = [];
  let current: ParsedLifecycleStage | null = null;
  for (const rawLine of sectionText.split(/\r?\n/)) {
    const stageMatch = rawLine.match(/^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*$/);
    if (stageMatch) {
      current = {
        step: stageMatch[1].padStart(2, '0'),
        title: stripMarkdownInline(stageMatch[2]),
        bullets: [],
      };
      stages.push(current);
      continue;
    }
    const bulletMatch = rawLine.match(/^\s*-\s+(.+)$/);
    if (bulletMatch && current) {
      current.bullets.push(stripMarkdownInline(bulletMatch[1]));
    }
  }
  return stages;
}

function parseContractChecklistPoints(sectionText: string): ParsedContractChecklistPoint[] {
  const points: ParsedContractChecklistPoint[] = [];
  for (const rawLine of sectionText.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*-\s+\[([ xX])\]\s+\*\*(.+?)\*\*[：:]\s*(.+)$/);
    if (!match) continue;
    const checkedInArtifact = match[1].toLowerCase() === 'x';
    const rawHeading = stripMarkdownInline(match[2]).replace(/^\d+\.\s*/, '');
    const description = stripMarkdownInline(match[3]);
    const idx = points.length;
    const checklistId =
      CONTRACT_CLAUSE_IDS_BY_INDEX[idx] ?? `clause_artifact_${idx + 1}`;
    points.push({
      index: idx + 1,
      checklistId,
      title: rawHeading,
      description,
      checkedInArtifact,
    });
  }
  return points;
}

function parseContractAnnexClauses(sectionText: string): ParsedContractAnnexClause[] {
  const clauses: ParsedContractAnnexClause[] = [];
  let currentTitle = '';
  let currentBody: string[] = [];

  const flush = () => {
    if (currentTitle && currentBody.length > 0) {
      clauses.push({
        title: stripMarkdownInline(currentTitle),
        body: stripMarkdownInline(currentBody.join(' ')),
      });
    }
    currentTitle = '';
    currentBody = [];
  };

  for (const rawLine of sectionText.split(/\r?\n/)) {
    const cleaned = rawLine.replace(/^\s*>\s?/, '').trim();
    if (!cleaned) {
      flush();
      continue;
    }
    const titleMatch = cleaned.match(/^\*\*(第\s*\d+\s*條[^*]*)\*\*$/);
    if (titleMatch) {
      flush();
      currentTitle = titleMatch[1];
      continue;
    }
    if (currentTitle) {
      currentBody.push(cleaned);
    }
  }
  flush();
  return clauses;
}

function listRelatedArtifacts(brainDir: string): RelatedArtifactMetadata[] {
  const related: RelatedArtifactMetadata[] = [];
  try {
    const entries = fs.readdirSync(brainDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const mdPath = path.resolve(brainDir, entry.name);
      if (!mdPath.startsWith(`${brainDir}${path.sep}`)) continue;
      const metaPath = `${mdPath}.metadata.json`;
      let summary = '';
      let updatedAt: string | null = null;
      let userFacing = true;

      if (fs.existsSync(metaPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
            summary?: string;
            updatedAt?: string;
            userFacing?: boolean;
          };
          summary = String(parsed.summary ?? '').trim();
          updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
          userFacing = parsed.userFacing !== false;
        } catch {
          // ignore malformed metadata json
        }
      }

      if (!userFacing) continue;
      const stat = fs.statSync(mdPath);
      related.push({
        id: entry.name.replace(/\.md$/i, ''),
        fileName: entry.name,
        summary: summary || entry.name,
        updatedAt: updatedAt || stat.mtime.toISOString(),
        userFacing,
        sizeBytes: stat.size,
        isCurrent: entry.name === GOVERNANCE_ARTIFACT_FILENAME,
      });
    }
  } catch {
    return [];
  }
  return related.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  });
}

export function loadIso27036GovernanceArtifact(): GovernanceArtifactPayload {
  const brainDir = locateArtifactsBrainDir();
  const mdPath = brainDir ? path.resolve(brainDir, GOVERNANCE_ARTIFACT_FILENAME) : null;
  const metaPath = mdPath ? `${mdPath}.metadata.json` : null;

  let rawMarkdown = '';
  let sizeBytes = 0;
  let sourceAvailable = false;
  let fileMtime: string | null = null;

  if (mdPath && fs.existsSync(mdPath)) {
    try {
      rawMarkdown = fs.readFileSync(mdPath, 'utf-8');
      const stat = fs.statSync(mdPath);
      sizeBytes = stat.size;
      fileMtime = stat.mtime.toISOString();
      sourceAvailable = true;
    } catch {
      sourceAvailable = false;
    }
  }

  let summary =
    'ISO/IEC 27036 供應商關係資訊安全治理規範、委外合約 5 大保命條款檢核表、24h/72h 通報 SLA 與 14 天退場憑證銷毀程序。';
  let updatedAt: string | null = fileMtime;
  let userFacing = true;

  if (metaPath && fs.existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
        summary?: string;
        updatedAt?: string;
        userFacing?: boolean;
      };
      if (parsed.summary) summary = String(parsed.summary).trim();
      if (parsed.updatedAt) updatedAt = String(parsed.updatedAt).trim();
      if (typeof parsed.userFacing === 'boolean') userFacing = parsed.userFacing;
    } catch {
      // Keep defaults
    }
  }

  const titleMatch = rawMarkdown.match(/^#\s+(.+)$/m);
  const title = titleMatch
    ? stripMarkdownInline(titleMatch[1])
    : 'ISO/IEC 27036 供應商關係資訊安全治理規範與採購稽核實務手冊';

  const introNotes: string[] = [];
  for (const line of rawMarkdown.split(/\r?\n/).slice(0, 12)) {
    const m = line.match(/^>\s*-\s+(.+)$/);
    if (m) introNotes.push(stripMarkdownInline(m[1]));
  }

  const blindSpots: ParsedBlindSpotRow[] = parseMarkdownTableRows(
    extractH3Section(rawMarkdown, '破除傳統委外三大盲區')
  )
    .filter((cells) => cells.length >= 3)
    .map((cells) => ({
      traditional: cells[0],
      failureReason: cells[1],
      iso27036Remedy: cells[2],
    }));

  const lifecycleStages = parseLifecycleStages(
    extractH3Section(rawMarkdown, '四階段委外生命週期作業表')
  );

  const contractChecklistPoints = parseContractChecklistPoints(
    extractH3Section(rawMarkdown, '委外合約 5 個保命條款檢核表')
  );

  const artifactSupplierMatrix: ParsedArtifactSupplierRow[] = parseMarkdownTableRows(
    extractH3Section(rawMarkdown, '本專案供應商與外部相依元件風險分級矩陣')
  )
    .filter((cells) => cells.length >= 6)
    .map((cells) => ({
      supplier: cells[0],
      roleAndFlow: cells[1],
      riskTierLabel: cells[2],
      credentials: cells[3],
      controlsAndSla: cells[4],
      offboardingAction: cells[5],
    }));

  const crossStandardMatrix: ParsedCrossStandardRow[] = parseMarkdownTableRows(
    extractH3Section(rawMarkdown, '跨標準與法規整合對照表')
  )
    .filter((cells) => cells.length >= 3)
    .map((cells) => ({
      standard: cells[0],
      alignment: cells[1],
      projectImplementation: cells[2],
    }));

  const contractAnnexClauses = parseContractAnnexClauses(
    extractH3Section(rawMarkdown, '資安與通報 SLA 條文範本')
  );

  const offboardingTimeline: ParsedOffboardingStep[] = parseMarkdownTableRows(
    extractH3Section(rawMarkdown, '委外終止 14 天退場與憑證銷毀檢核表')
  )
    .filter((cells) => cells.length >= 5)
    .map((cells) => ({
      code: cells[0],
      item: cells[1],
      owner: cells[2],
      deadline: cells[3],
      evidence: cells[4],
    }));

  const relatedArtifacts = brainDir ? listRelatedArtifacts(brainDir) : [];

  return {
    id: 'iso27036_supply_chain_governance',
    fileName: GOVERNANCE_ARTIFACT_FILENAME,
    title,
    summary,
    updatedAt,
    userFacing,
    sourceAvailable,
    sizeBytes,
    introNotes,
    blindSpots,
    lifecycleStages,
    contractChecklistPoints,
    artifactSupplierMatrix,
    crossStandardMatrix,
    contractAnnexClauses,
    offboardingTimeline,
    relatedArtifacts,
    rawMarkdown,
  };
}

