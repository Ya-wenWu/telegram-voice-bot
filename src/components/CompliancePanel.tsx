import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { copyToClipboard } from '../utils/clipboard';

interface SbomSummary {
  totalComponents: number;
  npmRuntimeCount: number;
  npmDevCount: number;
  pythonRuntimeCount: number;
  pythonDevCount: number;
  unpinnedCount: number;
  unpinnedNames: string[];
}

interface SupplierInventoryItem {
  id: string;
  name: string;
  category: string;
  riskTier: 'high' | 'medium' | 'low';
  dataExposure: string;
  configured: boolean;
  credentialEnvNames: string[];
  endpointSummary: string;
  slaRequirement: string;
  offboardingAction: string;
  controls: string[];
}

interface AutomatedControlCheck {
  id: string;
  stage: 'pre_acquisition' | 'contracting' | 'monitoring' | 'offboarding';
  stageLabel: string;
  title: string;
  status: 'ok' | 'warning';
  detail: string;
}

interface AuditChecklistItem {
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

interface ParsedBlindSpotRow {
  traditional: string;
  failureReason: string;
  iso27036Remedy: string;
}

interface ParsedLifecycleStage {
  step: string;
  title: string;
  bullets: string[];
}

interface ParsedContractChecklistPoint {
  index: number;
  checklistId: string;
  title: string;
  description: string;
  checkedInArtifact: boolean;
}

interface ParsedCrossStandardRow {
  standard: string;
  alignment: string;
  projectImplementation: string;
}

interface ParsedContractAnnexClause {
  title: string;
  body: string;
}

interface ParsedOffboardingStep {
  code: string;
  item: string;
  owner: string;
  deadline: string;
  evidence: string;
}

interface RelatedArtifactMetadata {
  id: string;
  fileName: string;
  summary: string;
  updatedAt: string | null;
  userFacing: boolean;
  sizeBytes: number;
  isCurrent: boolean;
}

interface GovernanceArtifactPayload {
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
  crossStandardMatrix: ParsedCrossStandardRow[];
  contractAnnexClauses: ParsedContractAnnexClause[];
  offboardingTimeline: ParsedOffboardingStep[];
  relatedArtifacts: RelatedArtifactMetadata[];
  rawMarkdown: string;
}

interface ComplianceSnapshot {
  generatedAt: string;
  standard: string;
  crossStandards: string[];
  sbomSummary: SbomSummary;
  suppliers: SupplierInventoryItem[];
  automatedControls: AutomatedControlCheck[];
  checklist: AuditChecklistItem[];
  governanceArtifact: GovernanceArtifactPayload;
  summary: {
    totalSuppliers: number;
    highRiskSuppliers: number;
    totalSbomComponents: number;
    unpinnedSbomComponents: number;
    contractClausesCompleted: number;
    contractClausesTotal: number;
    offboardingCompleted: number;
    offboardingTotal: number;
  };
}

type ComplianceViewFilter =
  | 'all'
  | 'clauses'
  | 'suppliers'
  | 'governance'
  | 'offboarding'
  | 'artifacts';

function formatRiskTier(tier: 'high' | 'medium' | 'low'): { text: string; className: string } {
  if (tier === 'high') {
    return { text: '高風險 (High)', className: 'text-red-700 font-semibold' };
  }
  if (tier === 'medium') {
    return { text: '中風險 (Medium)', className: 'text-amber-700 font-semibold' };
  }
  return { text: '低風險 (Low)', className: 'text-emerald-700 font-semibold' };
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-TW', { hour12: false });
}

function formatKb(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 KB';
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function CompliancePanel() {
  const [data, setData] = useState<ComplianceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<ComplianceViewFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [copiedClauses, setCopiedClauses] = useState(false);
  const [downloadingSbom, setDownloadingSbom] = useState(false);
  const [downloadingArtifact, setDownloadingArtifact] = useState(false);
  const [showRawMarkdown, setShowRawMarkdown] = useState(false);

  const fetchComplianceSnapshot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/compliance/iso27036', { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`Unable to load ISO/IEC 27036 compliance status (HTTP ${res.status})`);
      }
      const payload = (await res.json()) as ComplianceSnapshot;
      setData(payload);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Unable to connect to the compliance API endpoint.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchComplianceSnapshot();
  }, [fetchComplianceSnapshot]);

  const persistChecklistUpdate = async (itemId: string, checked: boolean, note: string) => {
    if (updatingId) return;
    setUpdatingId(itemId);
    setError(null);
    try {
      const res = await fetch('/api/observability/supply-chain/checklist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Interaction': '1',
        },
        body: JSON.stringify({
          id: itemId,
          checked,
          note,
          _hp: '',
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        audit?: ComplianceSnapshot;
      };
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `Failed to update checklist item (HTTP ${res.status})`);
      }
      if (payload.audit) {
        setData(payload.audit);
      } else {
        await fetchComplianceSnapshot();
      }
      if (editingNoteId === itemId) {
        setEditingNoteId(null);
        setNoteDraft('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save checklist update.');
    } finally {
      setUpdatingId(null);
    }
  };

  const handleDownloadSbom = async () => {
    if (downloadingSbom) return;
    setDownloadingSbom(true);
    setError(null);
    try {
      const res = await fetch('/api/observability/sbom', { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`Failed to export CycloneDX SBOM (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'web-voice-bot-sbom-cyclonedx.json';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download CycloneDX SBOM.');
    } finally {
      setDownloadingSbom(false);
    }
  };

  const handleDownloadGovernanceMd = async () => {
    if (downloadingArtifact) return;
    setDownloadingArtifact(true);
    setError(null);
    try {
      const res = await fetch('/api/compliance/iso27036/download', { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`Failed to download governance artifact (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'iso27036_supply_chain_governance.md';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download governance Markdown.');
    } finally {
      setDownloadingArtifact(false);
    }
  };

  const handleCopyContractClauses = async () => {
    const artifact = data?.governanceArtifact;
    const clauses = artifact?.contractAnnexClauses ?? [];
    const lines =
      clauses.length > 0
        ? [
            '【ISO/IEC 27036 委外合約資安與通報 SLA 條文範本】',
            '',
            ...clauses.map((c) => `${c.title}\n${c.body}`),
          ]
        : (artifact?.contractChecklistPoints ?? []).map(
            (p) => `${p.index}. ${p.title}：${p.description}`
          );

    if (lines.length === 0) return;
    const ok = await copyToClipboard(lines.join('\n\n'));
    if (ok) {
      setCopiedClauses(true);
      window.setTimeout(() => setCopiedClauses(false), 2200);
    }
  };

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const matchesQuery = useCallback(
    (...fields: Array<string | undefined | null>) => {
      if (!normalizedQuery) return true;
      return fields.some((f) => (f ?? '').toLowerCase().includes(normalizedQuery));
    },
    [normalizedQuery]
  );

  // Merge dynamically parsed 5-point contract checklist from Artifacts with live persisted audit state
  const mergedContractChecklist = useMemo(() => {
    const persistedById = new Map<string, AuditChecklistItem>();
    for (const item of data?.checklist ?? []) {
      persistedById.set(item.id, item);
    }
    const artifactPoints = data?.governanceArtifact.contractChecklistPoints ?? [];
    if (artifactPoints.length > 0) {
      return artifactPoints.map((pt) => {
        const persisted = persistedById.get(pt.checklistId);
        return {
          id: pt.checklistId,
          code: persisted?.code ?? `CLAUSE-0${pt.index}`,
          title: pt.title,
          description: pt.description,
          isoRef: persisted?.isoRef ?? 'ISO/IEC 27036',
          checked: persisted?.checked ?? pt.checkedInArtifact,
          note: persisted?.note ?? '',
          updatedAt: persisted?.updatedAt ?? null,
          fromArtifact: true,
        };
      });
    }
    return (data?.checklist ?? [])
      .filter((c) => c.group === 'contract_5_clauses')
      .map((c) => ({ ...c, fromArtifact: false }));
  }, [data]);

  const filteredContractItems = useMemo(
    () =>
      mergedContractChecklist.filter((item) =>
        matchesQuery(item.code, item.title, item.description, item.isoRef, item.note)
      ),
    [mergedContractChecklist, matchesQuery]
  );

  const filteredAnnexClauses = useMemo(
    () =>
      (data?.governanceArtifact.contractAnnexClauses ?? []).filter((c) =>
        matchesQuery(c.title, c.body)
      ),
    [data, matchesQuery]
  );

  const filteredSuppliers = useMemo(
    () =>
      (data?.suppliers ?? []).filter((s) =>
        matchesQuery(
          s.name,
          s.category,
          s.riskTier,
          s.dataExposure,
          s.endpointSummary,
          s.slaRequirement,
          s.offboardingAction,
          s.credentialEnvNames.join(' '),
          s.controls.join(' ')
        )
      ),
    [data, matchesQuery]
  );

  const filteredControls = useMemo(
    () =>
      (data?.automatedControls ?? []).filter((c) =>
        matchesQuery(c.stageLabel, c.title, c.detail, c.status)
      ),
    [data, matchesQuery]
  );

  const filteredBlindSpots = useMemo(
    () =>
      (data?.governanceArtifact.blindSpots ?? []).filter((r) =>
        matchesQuery(r.traditional, r.failureReason, r.iso27036Remedy)
      ),
    [data, matchesQuery]
  );

  const filteredLifecycleStages = useMemo(
    () =>
      (data?.governanceArtifact.lifecycleStages ?? []).filter((s) =>
        matchesQuery(s.step, s.title, s.bullets.join(' '))
      ),
    [data, matchesQuery]
  );

  const filteredCrossStandards = useMemo(
    () =>
      (data?.governanceArtifact.crossStandardMatrix ?? []).filter((r) =>
        matchesQuery(r.standard, r.alignment, r.projectImplementation)
      ),
    [data, matchesQuery]
  );

  const offboardingItems = useMemo(
    () =>
      (data?.checklist ?? [])
        .filter((c) => c.group === 'offboarding_14d')
        .filter((c) => matchesQuery(c.code, c.title, c.description, c.isoRef, c.note)),
    [data, matchesQuery]
  );

  const filteredOffboardingTimeline = useMemo(
    () =>
      (data?.governanceArtifact.offboardingTimeline ?? []).filter((s) =>
        matchesQuery(s.code, s.item, s.owner, s.deadline, s.evidence)
      ),
    [data, matchesQuery]
  );

  const showSection = (key: Exclude<ComplianceViewFilter, 'all'>) =>
    activeFilter === 'all' || activeFilter === key;

  const passedControlsCount = (data?.automatedControls ?? []).filter(
    (c) => c.status === 'ok'
  ).length;
  const totalControlsCount = data?.automatedControls.length ?? 0;

  const totalMatchesForSearch =
    filteredContractItems.length +
    filteredAnnexClauses.length +
    filteredSuppliers.length +
    filteredControls.length +
    filteredBlindSpots.length +
    filteredLifecycleStages.length +
    filteredCrossStandards.length +
    offboardingItems.length +
    filteredOffboardingTimeline.length;

  const artifact = data?.governanceArtifact;

  return (
    <div className="space-y-6">
      {/* Focal Anchor: Live Compliance Overview + Dynamic Artifact Metadata Header */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <span>{data?.standard ?? 'ISO/IEC 27036 (Parts 1–4)'}</span>
              <span aria-hidden="true">·</span>
              <span>
                {artifact?.sourceAvailable
                  ? `Artifacts 動態同步：${artifact.fileName}`
                  : '供應鏈資安治理宣告'}
              </span>
              {artifact?.updatedAt && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    Artifact 更新於 {formatDateTime(artifact.updatedAt)}
                  </span>
                </>
              )}
            </div>

            <h1 className="mt-2 font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
              {artifact?.title ?? 'ISO/IEC 27036 供應商關係資訊安全治理與供應鏈合規狀態'}
            </h1>

            <p className="mt-2.5 text-sm sm:text-base text-slate-600 leading-relaxed">
              {artifact?.summary ??
                '動態載入 Artifacts 中繼資料內的 ISO/IEC 27036 治理規範與委外合約 5 大保命條款檢核表，並即時盤點專案外部供應商風險、自動化控制狀態與 CycloneDX 1.5 SBOM。'}
            </p>

            {artifact && artifact.introNotes.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs sm:text-sm text-slate-600">
                {artifact.introNotes.map((note, idx) => (
                  <li key={idx} className="leading-relaxed">
                    {note}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Primary Action Group */}
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => void handleDownloadSbom()}
              disabled={downloadingSbom}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              {downloadingSbom ? (
                <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
              ) : (
                <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
              )}
              <span>下載 CycloneDX SBOM</span>
            </button>

            <button
              type="button"
              onClick={() => void handleCopyContractClauses()}
              disabled={!artifact}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              {copiedClauses ? (
                <Check className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
              ) : (
                <Copy className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
              )}
              <span>{copiedClauses ? '已複製 5 條款範本' : '複製合約 5 條款'}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleDownloadGovernanceMd()}
              disabled={downloadingArtifact || !artifact?.sourceAvailable}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              <FileText className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
              <span>匯出規範 (.md)</span>
            </button>

            <button
              type="button"
              onClick={() => void fetchComplianceSnapshot()}
              disabled={loading}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              <RefreshCw
                className={`w-4 h-4 text-slate-500 shrink-0 ${loading ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>重新同步</span>
            </button>
          </div>
        </div>

        {/* Accessible Error Banner */}
        {error && (
          <div
            role="alert"
            className="mt-5 px-4 py-3 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between gap-3 text-sm text-red-800"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={() => void fetchComplianceSnapshot()}
              className="px-3 py-1 text-xs font-medium text-red-800 bg-white border border-red-200 hover:bg-red-100 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              重試
            </button>
          </div>
        )}

        {/* Full-Width 4-Column Live KPI Strip (Tabular Numerals, No Nested Cards) */}
        <div className="mt-6 pt-6 border-t border-slate-200 grid grid-cols-2 lg:grid-cols-4 gap-6">
          <div>
            <p className="text-xs text-slate-500">外部供應商風險盤點</p>
            {loading && !data ? (
              <div className="mt-1.5 h-7 w-28 bg-slate-100 rounded animate-pulse" />
            ) : (
              <p className="mt-1 font-mono tabular-nums text-2xl font-bold text-slate-900">
                {data?.summary.totalSuppliers ?? 0}
                <span className="ml-2 font-sans text-xs font-semibold text-red-700">
                  高風險 {data?.summary.highRiskSuppliers ?? 0} 項
                </span>
              </p>
            )}
          </div>

          <div>
            <p className="text-xs text-slate-500">CycloneDX 1.5 SBOM 元件</p>
            {loading && !data ? (
              <div className="mt-1.5 h-7 w-28 bg-slate-100 rounded animate-pulse" />
            ) : (
              <p className="mt-1 font-mono tabular-nums text-2xl font-bold text-slate-900">
                {data?.summary.totalSbomComponents ?? 0}
                <span
                  className={`ml-2 font-sans text-xs font-semibold ${
                    (data?.summary.unpinnedSbomComponents ?? 0) > 0
                      ? 'text-amber-700'
                      : 'text-emerald-700'
                  }`}
                >
                  未鎖定 {data?.summary.unpinnedSbomComponents ?? 0} 項
                </span>
              </p>
            )}
          </div>

          <div>
            <p className="text-xs text-slate-500">委外合約 5 大保命條款</p>
            {loading && !data ? (
              <div className="mt-1.5 h-7 w-24 bg-slate-100 rounded animate-pulse" />
            ) : (
              <p className="mt-1 font-mono tabular-nums text-2xl font-bold text-slate-900">
                {data?.summary.contractClausesCompleted ?? 0} /{' '}
                {data?.summary.contractClausesTotal ?? 5}
                <span className="ml-2 font-sans text-xs font-normal text-slate-500">
                  已完成簽署檢核
                </span>
              </p>
            )}
          </div>

          <div>
            <p className="text-xs text-slate-500">自動化控制 / 14 日退場</p>
            {loading && !data ? (
              <div className="mt-1.5 h-7 w-28 bg-slate-100 rounded animate-pulse" />
            ) : (
              <p className="mt-1 font-mono tabular-nums text-2xl font-bold text-slate-900">
                {passedControlsCount}/{totalControlsCount}
                <span className="ml-2 font-sans text-xs font-normal text-slate-500">
                  退場 {data?.summary.offboardingCompleted ?? 0}/{data?.summary.offboardingTotal ?? 4}
                </span>
              </p>
            )}
          </div>
        </div>

        {/* Interactive Section Filter Bar + Live Client-Side Search */}
        <div className="mt-6 pt-5 border-t border-slate-100 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div
            role="tablist"
            aria-label="Compliance sections"
            className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg"
          >
            {(
              [
                { id: 'all', label: '總覽' },
                { id: 'clauses', label: '合約 5 大條款' },
                { id: 'suppliers', label: '供應商與 SBOM 狀態' },
                { id: 'governance', label: 'ISO/IEC 27036 治理需求' },
                { id: 'offboarding', label: '14 日退場銷毀' },
                { id: 'artifacts', label: 'Artifacts 中繼資料' },
              ] as Array<{ id: ComplianceViewFilter; label: string }>
            ).map((tab) => {
              const active = activeFilter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveFilter(tab.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:w-64">
              <Search
                className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜尋條款、供應商、標準或控制項..."
                aria-label="搜尋合規項目"
                className="w-full h-9 pl-8 pr-8 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15 transition-colors"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="清除搜尋"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {data?.generatedAt && (
              <span className="text-xs font-mono tabular-nums text-slate-500 whitespace-nowrap">
                快照：{formatDateTime(data.generatedAt)}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Empty Search Result State */}
      {!loading && normalizedQuery && totalMatchesForSearch === 0 && (
        <section className="bg-white border border-slate-200 rounded-xl px-6 py-12 text-center">
          <h2 className="font-display text-base font-semibold text-slate-900">
            找不到符合「{searchQuery}」的合規條款或供應商項目
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            請嘗試其他關鍵字（例如 Gemini、Telegram、SBOM、24 小時、CRA 或 OFF-01）。
          </p>
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="mt-4 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            清除篩選條件
          </button>
        </section>
      )}

      {/* SECTION 1: 5-Point Contract Checklist (Dynamically Parsed from Artifact + Persistent Attestation) */}
      {showSection('clauses') && (!normalizedQuery || filteredContractItems.length > 0 || filteredAnnexClauses.length > 0) && (
        <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-xl font-bold text-slate-900">
                委外合約 5 個保命條款檢核表（動態載自 Artifacts 規範）
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                由 <span className="font-mono text-xs text-slate-700">{artifact?.fileName ?? 'iso27036_supply_chain_governance.md'}</span> 即時解析並綁定伺服器稽核狀態；可逐項勾選確認或登錄合約佐證備註。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleCopyContractClauses()}
              disabled={!artifact}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copiedClauses ? (
                <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
              ) : (
                <Copy className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
              )}
              <span>{copiedClauses ? '已複製條文' : '複製合約附件條文'}</span>
            </button>
          </div>

          <div className="mt-6 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left: Interactive Persistent 5-Point Checklist */}
            <div className="lg:col-span-6">
              <div className="flex items-center justify-between pb-3 border-b border-slate-200">
                <h3 className="text-sm font-semibold text-slate-900">
                  決標前必查 5 項保命條款
                </h3>
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  完成 {data?.summary.contractClausesCompleted ?? 0} /{' '}
                  {data?.summary.contractClausesTotal ?? 5}
                </span>
              </div>

              {loading && !data ? (
                <div className="mt-4 space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="h-16 bg-slate-100 rounded-lg animate-pulse" />
                  ))}
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {filteredContractItems.map((item) => {
                    const busy = updatingId === item.id;
                    const isEditingNote = editingNoteId === item.id;
                    return (
                      <li key={item.id} className="py-3.5">
                        <div className="flex items-start gap-3">
                          <input
                            id={`check-${item.id}`}
                            type="checkbox"
                            checked={item.checked}
                            disabled={busy}
                            onChange={() =>
                              void persistChecklistUpdate(item.id, !item.checked, item.note)
                            }
                            className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <label
                              htmlFor={`check-${item.id}`}
                              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 cursor-pointer select-none"
                            >
                              <span className="font-mono text-xs text-slate-500">{item.code}</span>
                              <span
                                className={`text-sm font-semibold ${
                                  item.checked ? 'text-emerald-800' : 'text-slate-900'
                                }`}
                              >
                                {item.title}
                              </span>
                            </label>
                            <p className="mt-1 text-xs text-slate-600 leading-relaxed">
                              {item.description}
                            </p>

                            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-500">
                              <span className="font-mono">{item.isoRef}</span>
                              <span aria-hidden="true">·</span>
                              <span className={item.checked ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'}>
                                {item.checked ? '已確認納入合約' : '待確認'}
                              </span>
                              {item.updatedAt && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono tabular-nums">
                                    {formatDateTime(item.updatedAt)}
                                  </span>
                                </>
                              )}
                              <span aria-hidden="true">·</span>
                              <button
                                type="button"
                                onClick={() => {
                                  if (isEditingNote) {
                                    setEditingNoteId(null);
                                    setNoteDraft('');
                                  } else {
                                    setEditingNoteId(item.id);
                                    setNoteDraft(item.note);
                                  }
                                }}
                                className="text-blue-700 hover:underline font-medium cursor-pointer"
                              >
                                {item.note ? '編輯佐證備註' : '新增佐證備註'}
                              </button>
                            </div>

                            {item.note && !isEditingNote && (
                              <p className="mt-1.5 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-md px-2.5 py-1.5">
                                佐證備註：{item.note}
                              </p>
                            )}

                            {isEditingNote && (
                              <div className="mt-2 flex items-center gap-2">
                                <input
                                  type="text"
                                  value={noteDraft}
                                  onChange={(e) => setNoteDraft(e.target.value)}
                                  maxLength={200}
                                  placeholder="輸入合約編號、法務審查日期或佐證連結..."
                                  className="flex-1 h-8 px-2.5 text-xs bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:border-blue-600"
                                />
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    void persistChecklistUpdate(item.id, item.checked, noteDraft)
                                  }
                                  className="px-3 h-8 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md whitespace-nowrap cursor-pointer"
                                >
                                  儲存
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingNoteId(null);
                                    setNoteDraft('');
                                  }}
                                  className="px-2.5 h-8 text-xs text-slate-600 hover:text-slate-900 cursor-pointer"
                                >
                                  取消
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Right: Dynamically Parsed Contract Annex Clauses */}
            <div className="lg:col-span-6">
              <div className="flex items-center justify-between pb-3 border-b border-slate-200">
                <h3 className="text-sm font-semibold text-slate-900">
                  合約附件：資安與通報 SLA 條文範本
                </h3>
                <span className="text-xs text-slate-500">
                  24h 預警 · 72h 通報 · 180 日日誌 · 14 日銷毀
                </span>
              </div>

              {loading && !data ? (
                <div className="mt-4 space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="h-16 bg-slate-100 rounded-lg animate-pulse" />
                  ))}
                </div>
              ) : (
                <ol className="divide-y divide-slate-100">
                  {filteredAnnexClauses.map((clause) => (
                    <li key={clause.title} className="py-3.5">
                      <h4 className="text-sm font-semibold text-slate-900">{clause.title}</h4>
                      <p className="mt-1 text-xs sm:text-sm text-slate-600 leading-relaxed">
                        {clause.body}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </section>
      )}

      {/* SECTION 2: Live Project Supply Chain Security Status & SBOM */}
      {showSection('suppliers') && (!normalizedQuery || filteredSuppliers.length > 0 || filteredControls.length > 0) && (
        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-xl font-bold text-slate-900">
                  專案即時供應商風險分級與環境狀態
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  即時偵測本專案運作環境整合之外部 AI、語音與快取供應商；僅顯示啟用狀態、主機端點與環境變數名稱，絕不揭露真實金鑰。
                </p>
              </div>
              <div className="text-xs font-mono tabular-nums text-slate-500 shrink-0">
                SBOM：{data?.sbomSummary.totalComponents ?? 0} 元件（npm{' '}
                {(data?.sbomSummary.npmRuntimeCount ?? 0) + (data?.sbomSummary.npmDevCount ?? 0)} /
                PyPI{' '}
                {(data?.sbomSummary.pythonRuntimeCount ?? 0) +
                  (data?.sbomSummary.pythonDevCount ?? 0)}
                ）
              </div>
            </div>

            {loading && !data ? (
              <div className="mt-5 space-y-3">
                {Array.from({ length: 5 }).map((_, idx) => (
                  <div key={idx} className="h-12 bg-slate-100 rounded animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="mt-5 overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs font-semibold text-slate-500">
                      <th className="py-3 pr-4">供應商與類別</th>
                      <th className="py-3 px-3 whitespace-nowrap">風險分級</th>
                      <th className="py-3 px-3 whitespace-nowrap">環境狀態</th>
                      <th className="py-3 px-4">接觸資料與主機端點</th>
                      <th className="py-3 px-4">通報 SLA 與憑證變數</th>
                      <th className="py-3 pl-4">退場／輪換動作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredSuppliers.map((supplier) => {
                      const risk = formatRiskTier(supplier.riskTier);
                      return (
                        <tr
                          key={supplier.id}
                          className="align-top hover:bg-slate-50/70 transition-colors"
                        >
                          <td className="py-3.5 pr-4">
                            <p className="font-semibold text-slate-900">{supplier.name}</p>
                            <p className="text-xs text-slate-500 mt-0.5">{supplier.category}</p>
                            <p className="text-[11px] text-slate-500 mt-1">
                              {supplier.controls.join(' · ')}
                            </p>
                          </td>
                          <td className={`py-3.5 px-3 whitespace-nowrap text-xs ${risk.className}`}>
                            {risk.text}
                          </td>
                          <td className="py-3.5 px-3 whitespace-nowrap text-xs">
                            <span
                              className={
                                supplier.configured
                                  ? 'text-emerald-700 font-semibold'
                                  : 'text-slate-500'
                              }
                            >
                              {supplier.configured ? '已設定 (Active)' : '未啟用'}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-xs text-slate-600 leading-relaxed">
                            <p>{supplier.dataExposure}</p>
                            <p className="mt-1 font-mono text-[11px] text-slate-500 break-all">
                              {supplier.endpointSummary}
                            </p>
                          </td>
                          <td className="py-3.5 px-4 text-xs text-slate-600 leading-relaxed">
                            <p>{supplier.slaRequirement}</p>
                            <p className="mt-1 font-mono text-[11px] text-slate-500">
                              {supplier.credentialEnvNames.join(' · ')}
                            </p>
                          </td>
                          <td className="py-3.5 pl-4 text-xs text-slate-700 leading-relaxed">
                            {supplier.offboardingAction}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Live Automated Lifecycle Controls */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-bold text-slate-900">
                  自動化資安控制檢查與 SBOM 版本鎖定狀態
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  即時稽核供應商分級、防惡意機器人保護、Git 防外洩與 npm／PyPI 依賴版本鎖定。
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleDownloadSbom()}
                disabled={downloadingSbom}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-blue-700 bg-white border border-slate-300 hover:bg-blue-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>匯出 CycloneDX 1.5 JSON</span>
              </button>
            </div>

            <div className="mt-5 divide-y divide-slate-100 border-t border-slate-200">
              {filteredControls.map((ctrl) => (
                <div
                  key={ctrl.id}
                  className="py-3.5 flex flex-col sm:flex-row sm:items-start justify-between gap-2 sm:gap-6"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                      <span>{ctrl.stageLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-slate-900 text-sm">{ctrl.title}</span>
                    </div>
                    <p className="mt-1 text-xs sm:text-sm text-slate-600 leading-relaxed">
                      {ctrl.detail}
                    </p>
                  </div>
                  <div className="shrink-0 flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap">
                    {ctrl.status === 'ok' ? (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                        <span className="text-emerald-700">符合控制</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="w-4 h-4 text-amber-600" aria-hidden="true" />
                        <span className="text-amber-700">待補齊項目</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* SECTION 3: Dynamically Parsed ISO/IEC 27036 Governance Requirements from Artifacts */}
      {showSection('governance') &&
        (!normalizedQuery ||
          filteredBlindSpots.length > 0 ||
          filteredLifecycleStages.length > 0 ||
          filteredCrossStandards.length > 0) && (
          <div className="space-y-6">
            {filteredBlindSpots.length > 0 && (
              <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
                <h2 className="font-display text-xl font-bold text-slate-900">
                  一、破除傳統「簽 NDA ＋ 年度問卷」三大委外盲區
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  動態解析自 Artifacts 治理文件，明列實務失效原因與 ISO/IEC 27036 落地解法。
                </p>

                <div className="mt-5 overflow-x-auto">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-xs font-semibold text-slate-500">
                        <th className="py-3 pr-4 w-[22%]">傳統做法</th>
                        <th className="py-3 px-4 w-[38%]">實務失效原因</th>
                        <th className="py-3 pl-4 w-[40%]">ISO/IEC 27036 落地解法</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredBlindSpots.map((row) => (
                        <tr key={row.traditional} className="align-top">
                          <td className="py-3.5 pr-4 font-semibold text-slate-900">
                            {row.traditional}
                          </td>
                          <td className="py-3.5 px-4 text-slate-600 leading-relaxed">
                            {row.failureReason}
                          </td>
                          <td className="py-3.5 pl-4 text-slate-800 leading-relaxed">
                            {row.iso27036Remedy}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {filteredLifecycleStages.length > 0 && (
              <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
                <h2 className="font-display text-xl font-bold text-slate-900">
                  二、ISO/IEC 27036 四階段委外生命週期作業表
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  將資安控制項嵌入採購前分級、合約 SLA 綁定、履約持續監控與委外退場完整週期。
                </p>

                <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6 border-t border-slate-200 pt-6">
                  {filteredLifecycleStages.map((stage) => (
                    <div
                      key={stage.step}
                      className="pb-4 border-b border-slate-100"
                    >
                      <h3 className="font-display text-base font-bold text-slate-900">
                        {stage.step}. {stage.title}
                      </h3>
                      <ul className="mt-2 space-y-1.5 text-sm text-slate-600 leading-relaxed">
                        {stage.bullets.map((bullet, idx) => (
                          <li key={idx}>{bullet}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {filteredCrossStandards.length > 0 && (
              <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
                <h2 className="font-display text-xl font-bold text-slate-900">
                  三、跨標準與國際法規整合對照表
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  銜接 ISO/IEC 27035、ISO/IEC 30111、歐盟 CRA 第 14 條／NIS2／DORA 與 ISO 27001／ERM。
                </p>

                <div className="mt-5 overflow-x-auto">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-xs font-semibold text-slate-500">
                        <th className="py-3 pr-4 w-[24%]">標準 / 法規</th>
                        <th className="py-3 px-4 w-[38%]">與 ISO/IEC 27036 的整合點</th>
                        <th className="py-3 pl-4 w-[38%]">本專案對應實作機制</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredCrossStandards.map((row) => (
                        <tr key={row.standard} className="align-top">
                          <td className="py-3.5 pr-4 font-semibold text-slate-900">
                            {row.standard}
                          </td>
                          <td className="py-3.5 px-4 text-slate-600 leading-relaxed">
                            {row.alignment}
                          </td>
                          <td className="py-3.5 pl-4 text-slate-800 leading-relaxed">
                            {row.projectImplementation}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        )}

      {/* SECTION 4: 14-Day Offboarding & Certificate of Destruction */}
      {showSection('offboarding') && (!normalizedQuery || offboardingItems.length > 0 || filteredOffboardingTimeline.length > 0) && (
        <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-xl font-bold text-slate-900">
                委外終止 14 天退場與憑證銷毀檢核（T+0 至 T+14）
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                結合 Artifacts 定義的退場里程碑與佐證文件要求，提供即時可保存之退場就緒檢核表。
              </p>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-500 shrink-0">
              已完成 {data?.summary.offboardingCompleted ?? 0} /{' '}
              {data?.summary.offboardingTotal ?? 4} 項退場確認
            </span>
          </div>

          <div className="mt-6 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left: Interactive Persistent Offboarding Checklist */}
            <div className="lg:col-span-5">
              <div className="pb-3 border-b border-slate-200">
                <h3 className="text-sm font-semibold text-slate-900">退場就緒狀態勾選</h3>
              </div>
              <ul className="divide-y divide-slate-100">
                {offboardingItems.map((item) => {
                  const busy = updatingId === item.id;
                  return (
                    <li key={item.id} className="py-3.5">
                      <label className="flex items-start gap-3 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={item.checked}
                          disabled={busy}
                          onChange={() =>
                            void persistChecklistUpdate(item.id, !item.checked, item.note)
                          }
                          className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="font-mono text-xs text-slate-500">{item.code}</span>
                            <span
                              className={`text-sm font-semibold ${
                                item.checked ? 'text-emerald-800' : 'text-slate-900'
                              }`}
                            >
                              {item.title}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-slate-600 leading-relaxed">
                            {item.description}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500 font-mono">
                            <span>{item.isoRef}</span>
                            {item.updatedAt && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="tabular-nums">
                                  更新於 {formatDateTime(item.updatedAt)}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* Right: Dynamically Parsed T+0 to T+14 Table with Evidence */}
            <div className="lg:col-span-7">
              <div className="pb-3 border-b border-slate-200">
                <h3 className="text-sm font-semibold text-slate-900">
                  Artifacts 定義之退場期限與留存佐證
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-xs font-semibold text-slate-500">
                      <th className="py-2.5 pr-3 whitespace-nowrap">編號 / 期限</th>
                      <th className="py-2.5 px-3 whitespace-nowrap">負責角色</th>
                      <th className="py-2.5 px-3">檢核項目</th>
                      <th className="py-2.5 pl-3">佐證文件</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredOffboardingTimeline.map((step) => (
                      <tr key={step.code} className="align-top">
                        <td className="py-3 pr-3 whitespace-nowrap">
                          <p className="font-mono text-xs font-semibold text-slate-900">
                            {step.code}
                          </p>
                          <p className="font-mono tabular-nums text-[11px] text-slate-500 mt-0.5">
                            {step.deadline}
                          </p>
                        </td>
                        <td className="py-3 px-3 text-xs text-slate-600 whitespace-nowrap">
                          {step.owner}
                        </td>
                        <td className="py-3 px-3 text-xs text-slate-700 leading-relaxed">
                          {step.item}
                        </td>
                        <td className="py-3 pl-3 text-xs font-mono text-slate-600 leading-relaxed">
                          {step.evidence}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* SECTION 5: Artifacts Metadata Provenance & Raw Governance Document */}
      {showSection('artifacts') && artifact && (
        <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-xl font-bold text-slate-900">
                Artifacts 中繼資料來源與治理文件檢視
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                本頁所有 ISO/IEC 27036 治理需求、合約 5 大條款與 14 日退場矩陣皆由專案 Artifacts 即時解析，無需手動重複維護靜態副本。
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setShowRawMarkdown((prev) => !prev)}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                {showRawMarkdown ? '隱藏原始 Markdown' : '檢視原始 Markdown'}
              </button>
              <button
                type="button"
                onClick={() => void handleDownloadGovernanceMd()}
                disabled={downloadingArtifact || !artifact.sourceAvailable}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-blue-700 bg-white border border-slate-300 hover:bg-blue-50 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>下載 .md</span>
              </button>
            </div>
          </div>

          {artifact.relatedArtifacts.length > 0 && (
            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-semibold text-slate-500">
                    <th className="py-2.5 pr-4 whitespace-nowrap">Artifact 檔案</th>
                    <th className="py-2.5 px-4">Metadata 摘要</th>
                    <th className="py-2.5 px-4 whitespace-nowrap">更新時間</th>
                    <th className="py-2.5 pl-4 text-right whitespace-nowrap">大小</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {artifact.relatedArtifacts.map((item) => (
                    <tr key={item.id} className="align-top">
                      <td className="py-3 pr-4 whitespace-nowrap">
                        <span className="font-mono text-xs font-semibold text-slate-900">
                          {item.fileName}
                        </span>
                        {item.isCurrent && (
                          <span className="ml-2 text-[11px] font-medium text-blue-700">
                            目前載入來源
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 leading-relaxed">
                        {item.summary}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-500 whitespace-nowrap">
                        {formatDateTime(item.updatedAt)}
                      </td>
                      <td className="py-3 pl-4 font-mono tabular-nums text-xs text-slate-500 text-right whitespace-nowrap">
                        {formatKb(item.sizeBytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {showRawMarkdown && artifact.rawMarkdown && (
            <div className="mt-5 pt-5 border-t border-slate-200">
              <pre className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono text-slate-800 overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-[520px] overflow-y-auto">
                {artifact.rawMarkdown}
              </pre>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
