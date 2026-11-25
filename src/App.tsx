import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Download,
  GitBranch,
  Link2,
  Loader2,
  Trash2,
  X,
} from 'lucide-react';
import { BotLiveConsole } from './components/BotLiveConsole';
import { CompliancePanel } from './components/CompliancePanel';
import { EmailDeliveryPanel } from './components/EmailDeliveryPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FileInspector } from './components/FileInspector';
import { FileTree } from './components/FileTree';
import { LoadTestReportPanel } from './components/LoadTestReportPanel';
import { SystemResourcesPanel } from './components/SystemResourcesPanel';
import { TopBar, type WorkspaceTab } from './components/TopBar';
import {
  downloadFilesAsZip,
  downloadSingleFile,
  fetchFileInspection,
  fetchRepositoryBundle,
  formatBytes,
  formatCompactNumber,
  formatRelativeDate,
  getFullArchiveUrl,
  parseGitHubUrl,
} from './services/github';
import type {
  FetchHistoryEntry,
  FileInspection,
  RepositoryBundle,
  TreeNode,
  ZipProgress,
} from './types/github';

const HISTORY_STORAGE_KEY = 'repofetch_recent_v1';

const SAMPLE_REPOS = [
  {
    label: 'pmndrs/zustand',
    url: 'https://github.com/pmndrs/zustand',
    summary: 'Lightweight React state management library',
  },
  {
    label: 'colinhacks/zod',
    url: 'https://github.com/colinhacks/zod',
    summary: 'TypeScript-first schema validation',
  },
  {
    label: 'vitejs/vite',
    url: 'https://github.com/vitejs/vite',
    summary: 'Next-generation frontend build tooling',
  },
  {
    label: 'lucide-icons/lucide',
    url: 'https://github.com/lucide-icons/lucide',
    summary: 'Open-source vector icon library',
  },
];

const URL_FORMAT_EXAMPLES = [
  {
    pattern: 'Repository root URL',
    example: 'https://github.com/pmndrs/zustand',
    behavior: 'Fetches the repository metadata and full directory tree for the default branch.',
  },
  {
    pattern: 'Git clone URL (.git)',
    example: 'https://github.com/colinhacks/zod.git',
    behavior: 'Strips the .git suffix automatically and loads the default branch.',
  },
  {
    pattern: 'Branch or subfolder URL',
    example: 'https://github.com/vitejs/vite/tree/main/packages',
    behavior: 'Switches to the specified branch and expands the target directory path.',
  },
  {
    pattern: 'Direct file URL (blob)',
    example: 'https://github.com/pmndrs/zustand/blob/main/package.json',
    behavior: 'Loads the repository structure and immediately opens the target file.',
  },
  {
    pattern: 'Owner/repo shorthand',
    example: 'lucide-icons/lucide',
    behavior: 'Resolves shorthand pairs directly against github.com.',
  },
];

function collectAllFolderPaths(nodes: TreeNode[], acc = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.type === 'tree') {
      acc.add(node.path);
      if (node.children) {
        collectAllFolderPaths(node.children, acc);
      }
    }
  }
  return acc;
}

function collectDescendantFiles(node: TreeNode, acc: string[] = []): string[] {
  if (node.type === 'blob') {
    acc.push(node.path);
    return acc;
  }
  if (node.children) {
    for (const child of node.children) {
      collectDescendantFiles(child, acc);
    }
  }
  return acc;
}

function collectAncestorFolders(filePath: string): string[] {
  const parts = filePath.split('/');
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    ancestors.push(parts.slice(0, i).join('/'));
  }
  return ancestors;
}

function loadHistory(): FetchHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 15) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: FetchHistoryEntry[]): void {
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries.slice(0, 15)));
  } catch {
    // Ignore storage quota errors
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('live');
  const [urlInput, setUrlInput] = useState('');
  const [loadingRepo, setLoadingRepo] = useState(false);
  const [loadingStage, setLoadingStage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [bundle, setBundle] = useState<RepositoryBundle | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());

  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [inspection, setInspection] = useState<FileInspection | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [downloadingSingle, setDownloadingSingle] = useState(false);

  const [readmeContent, setReadmeContent] = useState<string | null>(null);
  const [readmeLoading, setReadmeLoading] = useState(false);

  const [zipProgress, setZipProgress] = useState<ZipProgress>({
    active: false,
    completed: 0,
    total: 0,
    failed: 0,
    currentFile: '',
  });
  const [zipBanner, setZipBanner] = useState<string | null>(null);

  const [history, setHistory] = useState<FetchHistoryEntry[]>(() => loadHistory());

  const repoAbortRef = useRef<AbortController | null>(null);
  const fileAbortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const allBlobPaths = useMemo(() => {
    if (!bundle) return [];
    return bundle.flatItems.filter((item) => item.type === 'blob').map((item) => item.path);
  }, [bundle]);

  const inspectFile = useCallback(
    async (targetBundle: RepositoryBundle, path: string, size: number) => {
      fileAbortRef.current?.abort();
      const controller = new AbortController();
      fileAbortRef.current = controller;

      setSelectedFilePath(path);
      setLoadingFile(true);
      setFileError(null);

      try {
        const result = await fetchFileInspection(
          targetBundle.meta.owner.login,
          targetBundle.meta.name,
          targetBundle.branch,
          path,
          size,
          controller.signal
        );
        if (!controller.signal.aborted) {
          setInspection(result);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setInspection(null);
          setFileError(err instanceof Error ? err.message : 'Unable to load file content.');
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoadingFile(false);
        }
      }
    },
    []
  );

  const triggerFetchRepository = useCallback(
    async (rawUrl: string, overrideBranch?: string) => {
      let parsed;
      try {
        parsed = parseGitHubUrl(rawUrl);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Invalid GitHub repository URL.');
        return;
      }

      repoAbortRef.current?.abort();
      fileAbortRef.current?.abort();
      const controller = new AbortController();
      repoAbortRef.current = controller;

      setActiveTab('explorer');
      setErrorMessage(null);
      setZipBanner(null);
      setLoadingRepo(true);
      setLoadingStage(`Connecting to ${parsed.owner}/${parsed.repo}`);
      setSelectedFilePath(null);
      setInspection(null);
      setFileError(null);
      setReadmeContent(null);

      try {
        const nextBundle = await fetchRepositoryBundle(
          parsed,
          overrideBranch,
          (stage) => setLoadingStage(stage),
          controller.signal
        );

        if (controller.signal.aborted) return;

        setBundle(nextBundle);

        // Expand top-level directories plus any subfolder referenced by the pasted URL
        const initialExpanded = new Set<string>();
        for (const node of nextBundle.tree) {
          if (node.type === 'tree' && nextBundle.tree.length <= 18) {
            initialExpanded.add(node.path);
          }
        }
        if (nextBundle.initialSubPath) {
          const parts = nextBundle.initialSubPath.split('/');
          for (let i = 1; i <= parts.length; i += 1) {
            initialExpanded.add(parts.slice(0, i).join('/'));
          }
        }
        if (nextBundle.initialSelectedFile) {
          for (const ancestor of collectAncestorFolders(nextBundle.initialSelectedFile)) {
            initialExpanded.add(ancestor);
          }
        }

        setExpandedFolders(initialExpanded);
        setCheckedFiles(new Set());

        // Persist in recent history
        const entry: FetchHistoryEntry = {
          fullName: nextBundle.meta.full_name,
          url: nextBundle.meta.html_url,
          branch: nextBundle.branch,
          description: nextBundle.meta.description,
          totalFiles: nextBundle.totalFiles,
          totalBytes: nextBundle.totalBytes,
          fetchedAt: new Date().toISOString(),
        };
        setHistory((prev) => {
          const filtered = prev.filter(
            (item) => !(item.fullName === entry.fullName && item.branch === entry.branch)
          );
          const updated = [entry, ...filtered].slice(0, 15);
          saveHistory(updated);
          return updated;
        });

        // Automatically inspect target blob if user pasted a direct /blob/ URL
        if (nextBundle.initialSelectedFile) {
          const match = nextBundle.flatItems.find(
            (item) => item.path === nextBundle.initialSelectedFile
          );
          void inspectFile(nextBundle, nextBundle.initialSelectedFile, match?.size ?? 0);
        } else if (nextBundle.readmePath) {
          setReadmeLoading(true);
          const readmeItem = nextBundle.flatItems.find(
            (item) => item.path === nextBundle.readmePath
          );
          fetchFileInspection(
            nextBundle.meta.owner.login,
            nextBundle.meta.name,
            nextBundle.branch,
            nextBundle.readmePath,
            readmeItem?.size ?? 0,
            controller.signal
          )
            .then((res) => {
              if (!controller.signal.aborted && res.kind === 'text') {
                setReadmeContent(res.content ?? null);
              }
            })
            .catch(() => {
              // README preview is optional
            })
            .finally(() => {
              if (!controller.signal.aborted) {
                setReadmeLoading(false);
              }
            });
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setErrorMessage(
            err instanceof Error ? err.message : 'Unable to fetch repository structure.'
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoadingRepo(false);
          setLoadingStage('');
        }
      }
    },
    [inspectFile]
  );

  useEffect(() => {
    return () => {
      repoAbortRef.current?.abort();
      fileAbortRef.current?.abort();
    };
  }, []);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void triggerFetchRepository(urlInput);
  };

  const handleQuickLoad = (url: string) => {
    setUrlInput(url);
    void triggerFetchRepository(url);
  };

  const handleBranchChange = (nextBranch: string) => {
    if (!bundle || nextBranch === bundle.branch) return;
    void triggerFetchRepository(bundle.meta.html_url, nextBranch);
  };

  const handleToggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleExpandAll = () => {
    if (!bundle) return;
    setExpandedFolders(collectAllFolderPaths(bundle.tree));
  };

  const handleCollapseAll = () => {
    setExpandedFolders(new Set());
  };

  const handleSelectFile = (node: TreeNode) => {
    if (!bundle || node.type !== 'blob') return;
    void inspectFile(bundle, node.path, node.size);
  };

  const handleToggleFileCheck = (path: string) => {
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleToggleFolderCheck = (node: TreeNode) => {
    const descendants = collectDescendantFiles(node);
    if (descendants.length === 0) return;
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      const allSelected = descendants.every((p) => next.has(p));
      if (allSelected) {
        for (const p of descendants) next.delete(p);
      } else {
        for (const p of descendants) next.add(p);
      }
      return next;
    });
  };

  const handleSelectAllFiles = () => {
    setCheckedFiles(new Set(allBlobPaths));
  };

  const handleClearCheckedFiles = () => {
    setCheckedFiles(new Set());
  };

  const handleDownloadSingleFile = async (path: string) => {
    if (!bundle) return;
    setDownloadingSingle(true);
    try {
      await downloadSingleFile(
        bundle.meta.owner.login,
        bundle.meta.name,
        bundle.branch,
        path
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'File download failed.');
    } finally {
      setDownloadingSingle(false);
    }
  };

  const handleDownloadSelectedZip = async () => {
    if (!bundle || zipProgress.active) return;

    const targetPaths = checkedFiles.size > 0 ? Array.from(checkedFiles) : allBlobPaths;
    if (targetPaths.length === 0) return;

    // Safeguard for massive repos when nothing specific is checked: direct them to full GitHub ZIP archive
    if (targetPaths.length > 250) {
      const archiveUrl = getFullArchiveUrl(
        bundle.meta.owner.login,
        bundle.meta.name,
        bundle.branch
      );
      const anchor = document.createElement('a');
      anchor.href = archiveUrl;
      anchor.download = `${bundle.meta.name}-${bundle.branch}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setZipBanner(
        `Started direct GitHub archive download for ${bundle.meta.full_name} (${targetPaths.length.toLocaleString()} files).`
      );
      return;
    }

    setZipBanner(null);
    setZipProgress({
      active: true,
      completed: 0,
      total: targetPaths.length,
      failed: 0,
      currentFile: targetPaths[0],
    });

    try {
      const { failedCount } = await downloadFilesAsZip(
        bundle.meta.owner.login,
        bundle.meta.name,
        bundle.branch,
        targetPaths,
        (progress) => {
          setZipProgress({
            active: true,
            ...progress,
          });
        }
      );

      if (failedCount > 0) {
        setZipBanner(
          `Downloaded ZIP archive with ${(targetPaths.length - failedCount).toLocaleString()} of ${targetPaths.length.toLocaleString()} files (${failedCount} skipped).`
        );
      } else {
        setZipBanner(
          `Downloaded ZIP archive containing ${targetPaths.length.toLocaleString()} ${
            targetPaths.length === 1 ? 'file' : 'files'
          }.`
        );
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to build ZIP archive.');
    } finally {
      setZipProgress({
        active: false,
        completed: 0,
        total: 0,
        failed: 0,
        currentFile: '',
      });
    }
  };

  const handleRemoveHistory = (fullName: string, branch: string) => {
    setHistory((prev) => {
      const updated = prev.filter(
        (item) => !(item.fullName === fullName && item.branch === branch)
      );
      saveHistory(updated);
      return updated;
    });
  };

  const handleOpenReadme = () => {
    if (!bundle?.readmePath) return;
    const item = bundle.flatItems.find((entry) => entry.path === bundle.readmePath);
    void inspectFile(bundle, bundle.readmePath, item?.size ?? 0);
  };

  const fullArchiveUrl = bundle
    ? getFullArchiveUrl(bundle.meta.owner.login, bundle.meta.name, bundle.branch)
    : '#';

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        recentCount={history.length}
      />

      <main className="flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {/* LIVE BOT SANDBOX & ADMIN TAB */}
        {activeTab === 'live' && (
          <ErrorBoundary sectionLabel="Web Voice Bot 介面">
            <BotLiveConsole />
          </ErrorBoundary>
        )}

        {/* LIVE SYSTEM RESOURCES & PROMETHEUS TELEMETRY TAB */}
        {activeTab === 'resources' && (
          <ErrorBoundary sectionLabel="系統資源監控面板">
            <SystemResourcesPanel onOpenWebBot={() => setActiveTab('live')} />
          </ErrorBoundary>
        )}

        {/* COMPLIANCE (ISO/IEC 27036 ARTIFACT GOVERNANCE & SUPPLY CHAIN SECURITY) TAB */}
        {activeTab === 'compliance' && (
          <ErrorBoundary sectionLabel="Compliance (ISO/IEC 27036)">
            <CompliancePanel />
          </ErrorBoundary>
        )}

        {/* LOAD TEST REPORT TAB */}
        {activeTab === 'loadtest' && <LoadTestReportPanel />}

        {/* EMAIL DELIVERY TAB */}
        {activeTab === 'delivery' && <EmailDeliveryPanel />}

        {/* EXPLORER TAB */}
        {activeTab === 'explorer' && (
          <div className="space-y-6">
            {/* Focal Anchor: Repository URL Input & Download Trigger */}
            <section
              aria-label="Fetch GitHub repository"
              className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6"
            >
              <div className="max-w-3xl">
                <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
                  Download and inspect GitHub repository structures
                </h1>
                <p className="mt-1.5 text-sm sm:text-base text-slate-600">
                  Paste any public GitHub repository URL to fetch its directory tree, preview source
                  files, and export a ZIP archive.
                </p>
              </div>

              <form onSubmit={handleSubmit} className="mt-5 flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1 min-w-0">
                  <Link2
                    className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                    aria-hidden="true"
                  />
                  <input
                    ref={inputRef}
                    type="text"
                    value={urlInput}
                    onChange={(e) => {
                      setUrlInput(e.target.value);
                      if (errorMessage) setErrorMessage(null);
                    }}
                    placeholder="https://github.com/owner/repository"
                    aria-label="GitHub repository URL"
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full h-11 pl-10 pr-9 text-sm font-mono bg-slate-50 border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-blue-600 focus:ring-2 focus:ring-blue-600/20 transition-colors"
                  />
                  {urlInput && (
                    <button
                      type="button"
                      onClick={() => {
                        setUrlInput('');
                        setErrorMessage(null);
                        inputRef.current?.focus();
                      }}
                      aria-label="Clear URL input"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={loadingRepo}
                  className="inline-flex items-center justify-center gap-2 h-11 px-6 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                >
                  {loadingRepo ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
                      <span>Fetching...</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>Download</span>
                    </>
                  )}
                </button>
              </form>

              {/* Quiet unboxed sample repository triggers (zero pills) */}
              <div className="mt-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-500">
                <span>Try a public repository:</span>
                {SAMPLE_REPOS.map((sample, index) => (
                  <span key={sample.label} className="inline-flex items-center gap-2.5">
                    {index > 0 && (
                      <span aria-hidden="true" className="text-slate-300">
                        ·
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => handleQuickLoad(sample.url)}
                      disabled={loadingRepo}
                      className="font-mono text-slate-700 hover:text-blue-700 hover:underline transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {sample.label}
                    </button>
                  </span>
                ))}
              </div>

              {/* Explicit accessible error state */}
              {errorMessage && (
                <div
                  role="alert"
                  className="mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2.5 text-sm text-red-800"
                >
                  <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="min-w-0">
                    <span className="font-semibold">Fetch failed: </span>
                    <span>{errorMessage}</span>
                  </div>
                </div>
              )}
            </section>

            {/* LOADING SKELETON STATE */}
            {loadingRepo && (
              <section
                aria-live="polite"
                className="bg-white border border-slate-200 rounded-xl overflow-hidden"
              >
                <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-3">
                  <Loader2 className="w-4 h-4 text-blue-600 animate-spin shrink-0" aria-hidden="true" />
                  <span className="text-sm font-medium text-slate-800">
                    {loadingStage || 'Fetching repository structure...'}
                  </span>
                </div>
                <div className="flex flex-col lg:flex-row">
                  <div className="lg:w-[360px] xl:w-[390px] p-4 border-b lg:border-b-0 lg:border-r border-slate-200 space-y-3">
                    <div className="h-9 bg-slate-100 rounded-md animate-pulse" />
                    {Array.from({ length: 10 }).map((_, idx) => (
                      <div key={idx} className="flex items-center gap-2.5 h-7">
                        <div className="w-4 h-4 rounded bg-slate-100 animate-pulse shrink-0" />
                        <div
                          className="h-3.5 rounded bg-slate-100 animate-pulse"
                          style={{ width: `${45 + ((idx * 19) % 45)}%` }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex-1 p-6 space-y-4">
                    <div className="h-5 w-56 bg-slate-100 rounded animate-pulse" />
                    <div className="h-4 w-96 max-w-full bg-slate-100 rounded animate-pulse" />
                    <div className="pt-4 space-y-2.5">
                      {Array.from({ length: 7 }).map((_, idx) => (
                        <div key={idx} className="h-8 bg-slate-50 rounded animate-pulse" />
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* POPULATED REPOSITORY WORKSPACE */}
            {!loadingRepo && bundle && (
              <section
                aria-label="Repository explorer"
                className="bg-white border border-slate-200 rounded-xl overflow-hidden"
              >
                {/* Repository Metadata & Export Strip */}
                <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <a
                        href={bundle.meta.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 font-display text-lg font-bold text-slate-900 hover:text-blue-700 transition-colors"
                      >
                        <span className="truncate">{bundle.meta.full_name}</span>
                        <ArrowUpRight className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
                      </a>

                      <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                        <GitBranch className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                        <span className="sr-only">Select branch</span>
                        <select
                          value={bundle.branch}
                          onChange={(e) => handleBranchChange(e.target.value)}
                          className="h-7 pl-2 pr-6 text-xs font-mono font-medium text-slate-800 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15 cursor-pointer"
                        >
                          {bundle.branches.map((branch) => (
                            <option key={branch.name} value={branch.name}>
                              {branch.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {bundle.meta.description && (
                      <p className="text-sm text-slate-600 max-w-3xl">{bundle.meta.description}</p>
                    )}

                    {/* Clean unboxed typographic metadata with tabular numerals */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 font-mono tabular-nums">
                      <span>{formatCompactNumber(bundle.meta.stargazers_count)} stars</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatCompactNumber(bundle.meta.forks_count)} forks</span>
                      <span aria-hidden="true">·</span>
                      <span>{bundle.totalFiles.toLocaleString()} files</span>
                      <span aria-hidden="true">·</span>
                      <span>{bundle.totalFolders.toLocaleString()} folders</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatBytes(bundle.totalBytes)}</span>
                      {bundle.meta.license?.spdx_id && bundle.meta.license.spdx_id !== 'NOASSERTION' && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{bundle.meta.license.spdx_id}</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span className="font-sans">
                        Updated {formatRelativeDate(bundle.meta.pushed_at)}
                      </span>
                    </div>
                  </div>

                  {/* Export Actions */}
                  <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleDownloadSelectedZip()}
                      disabled={zipProgress.active}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                    >
                      {zipProgress.active ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                      <span>
                        {zipProgress.active
                          ? `Bundling ${zipProgress.completed}/${zipProgress.total}`
                          : checkedFiles.size > 0
                          ? `Download Selected ZIP (${checkedFiles.size})`
                          : 'Bundle Repository ZIP'}
                      </span>
                    </button>

                    <a
                      href={fullArchiveUrl}
                      download={`${bundle.meta.name}-${bundle.branch}.zip`}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                    >
                      <Download className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                      <span>Full Archive (.zip)</span>
                    </a>
                  </div>
                </div>

                {/* Live ZIP Bundling Progress Bar */}
                {zipProgress.active && (
                  <div className="px-5 sm:px-6 py-3 bg-blue-50/70 border-b border-blue-200 space-y-1.5">
                    <div className="flex items-center justify-between gap-4 text-xs">
                      <span className="font-mono text-blue-900 truncate">
                        Fetching {zipProgress.currentFile}
                      </span>
                      <span className="font-mono tabular-nums font-semibold text-blue-800 shrink-0">
                        {zipProgress.completed} / {zipProgress.total}
                      </span>
                    </div>
                    <div className="h-1.5 bg-blue-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-600 transition-all duration-150"
                        style={{
                          width: `${
                            zipProgress.total > 0
                              ? Math.round((zipProgress.completed / zipProgress.total) * 100)
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Completion notice */}
                {zipBanner && !zipProgress.active && (
                  <div className="px-5 sm:px-6 py-2.5 bg-emerald-50 border-b border-emerald-200 flex items-center justify-between gap-3 text-xs text-emerald-900">
                    <div className="flex items-center gap-2">
                      <CheckCircle2
                        className="w-4 h-4 text-emerald-600 shrink-0"
                        aria-hidden="true"
                      />
                      <span>{zipBanner}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setZipBanner(null)}
                      aria-label="Dismiss notification"
                      className="text-emerald-700 hover:text-emerald-900 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                {/* Two-Pane Structure Explorer */}
                <div className="flex flex-col lg:flex-row">
                  <FileTree
                    nodes={bundle.tree}
                    selectedFilePath={selectedFilePath}
                    checkedFiles={checkedFiles}
                    totalFiles={bundle.totalFiles}
                    truncated={bundle.truncated}
                    expandedFolders={expandedFolders}
                    onToggleFolder={handleToggleFolder}
                    onExpandAll={handleExpandAll}
                    onCollapseAll={handleCollapseAll}
                    onSelectFile={handleSelectFile}
                    onToggleFileCheck={handleToggleFileCheck}
                    onToggleFolderCheck={handleToggleFolderCheck}
                    onSelectAllFiles={handleSelectAllFiles}
                    onClearCheckedFiles={handleClearCheckedFiles}
                  />

                  <FileInspector
                    bundle={bundle}
                    inspection={inspection}
                    loadingFile={loadingFile}
                    fileError={fileError}
                    readmeContent={readmeContent}
                    readmeLoading={readmeLoading}
                    onDownloadSingleFile={(path) => void handleDownloadSingleFile(path)}
                    downloadingFile={downloadingSingle}
                    onClearSelectedFile={() => {
                      setSelectedFilePath(null);
                      setInspection(null);
                      setFileError(null);
                    }}
                    onOpenReadme={handleOpenReadme}
                  />
                </div>
              </section>
            )}

            {/* EMPTY STATE BEFORE FIRST FETCH */}
            {!loadingRepo && !bundle && (
              <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
                {/* 3-Step Workflow Guide */}
                <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 sm:p-8 flex flex-col justify-between">
                  <div>
                    <h2 className="font-display text-lg font-semibold text-slate-900">
                      How repository fetching works
                    </h2>
                    <p className="mt-1 text-sm text-slate-600">
                      RepoFetch queries the GitHub Git Trees API directly from your browser without
                      cloning git history.
                    </p>

                    <ol className="mt-6 divide-y divide-slate-100">
                      <li className="py-4 first:pt-0">
                        <h3 className="text-sm font-semibold text-slate-900">
                          01. Paste a public repository URL
                        </h3>
                        <p className="mt-1 text-sm text-slate-600">
                          Accepts full HTTPS URLs, branch subpaths, direct file links, or{' '}
                          <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-800">
                            owner/repo
                          </code>{' '}
                          shorthand.
                        </p>
                      </li>
                      <li className="py-4">
                        <h3 className="text-sm font-semibold text-slate-900">
                          02. Inspect the directory tree and source files
                        </h3>
                        <p className="mt-1 text-sm text-slate-600">
                          Filter paths instantly, switch branches, inspect code with line numbers,
                          and review file-type size distribution.
                        </p>
                      </li>
                      <li className="py-4 last:pb-0">
                        <h3 className="text-sm font-semibold text-slate-900">
                          03. Export selected files or the full archive
                        </h3>
                        <p className="mt-1 text-sm text-slate-600">
                          Check individual files or entire folders to package a custom ZIP archive
                          in-browser, or download GitHub&apos;s full branch archive.
                        </p>
                      </li>
                    </ol>
                  </div>
                </div>

                {/* Quick-Start Public Repositories */}
                <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 sm:p-8 flex flex-col justify-between">
                  <div>
                    <h2 className="font-display text-lg font-semibold text-slate-900">
                      Sample public repositories
                    </h2>
                    <p className="mt-1 text-sm text-slate-600">
                      Select any repository below to populate the URL input and fetch its structure.
                    </p>

                    <div className="mt-5 divide-y divide-slate-100 border-t border-slate-100">
                      {SAMPLE_REPOS.map((repo) => (
                        <div
                          key={repo.label}
                          className="py-3.5 flex items-center justify-between gap-4"
                        >
                          <div className="min-w-0">
                            <p className="font-mono text-sm font-medium text-slate-900 truncate">
                              {repo.label}
                            </p>
                            <p className="text-xs text-slate-500 truncate mt-0.5">{repo.summary}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleQuickLoad(repo.url)}
                            className="px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 border border-slate-200 hover:border-blue-200 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Fetch
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            )}
          </div>
        )}

        {/* RECENT HISTORY TAB */}
        {activeTab === 'recent' && (
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-200 flex items-center justify-between gap-4">
              <div>
                <h1 className="font-display text-xl font-bold text-slate-900">
                  Recent repositories
                </h1>
                <p className="mt-0.5 text-sm text-slate-600">
                  Repositories fetched from this browser session are stored locally for quick
                  re-fetching.
                </p>
              </div>
              {history.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setHistory([]);
                    saveHistory([]);
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-red-700 border border-slate-200 rounded-md hover:bg-red-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Clear history
                </button>
              )}
            </div>

            {history.length === 0 ? (
              <div className="px-6 py-16 text-center">
                <Clock className="w-8 h-8 text-slate-300 mx-auto mb-3" aria-hidden="true" />
                <h2 className="text-base font-semibold text-slate-900">No recent fetches yet</h2>
                <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">
                  Once you fetch a GitHub repository in the Explorer, it will appear here so you can
                  re-open its structure with a single click.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab('explorer')}
                  className="mt-5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer"
                >
                  Go to Explorer
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                      <th className="py-3 px-6">Repository</th>
                      <th className="py-3 px-4">Branch</th>
                      <th className="py-3 px-4 text-right">Files</th>
                      <th className="py-3 px-4 text-right">Size</th>
                      <th className="py-3 px-4 text-right">Fetched</th>
                      <th className="py-3 px-6 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {history.map((item) => (
                      <tr
                        key={`${item.fullName}-${item.branch}`}
                        className="hover:bg-slate-50/70 transition-colors"
                      >
                        <td className="py-3.5 px-6">
                          <div className="font-mono text-sm font-medium text-slate-900">
                            {item.fullName}
                          </div>
                          {item.description && (
                            <div className="text-xs text-slate-500 truncate max-w-md mt-0.5">
                              {item.description}
                            </div>
                          )}
                        </td>
                        <td className="py-3.5 px-4 font-mono text-xs text-slate-600">
                          {item.branch}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs text-slate-700">
                          {item.totalFiles.toLocaleString()}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs text-slate-500">
                          {formatBytes(item.totalBytes)}
                        </td>
                        <td className="py-3.5 px-4 text-right text-xs text-slate-500 whitespace-nowrap">
                          {formatRelativeDate(item.fetchedAt)}
                        </td>
                        <td className="py-3.5 px-6 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setUrlInput(item.url);
                                void triggerFetchRepository(item.url, item.branch);
                              }}
                              className="px-3 py-1.5 text-xs font-medium text-blue-700 border border-slate-200 hover:border-blue-300 hover:bg-blue-50 rounded-md transition-colors cursor-pointer"
                            >
                              Open
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveHistory(item.fullName, item.branch)}
                              aria-label={`Remove ${item.fullName} from history`}
                              className="p-1.5 text-slate-400 hover:text-red-600 rounded-md transition-colors cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* URL FORMATS REFERENCE TAB */}
        {activeTab === 'formats' && (
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-200">
              <h1 className="font-display text-xl font-bold text-slate-900">
                Supported GitHub URL formats
              </h1>
              <p className="mt-0.5 text-sm text-slate-600">
                Paste any of the formats below into the Explorer input field. Public GitHub
                repositories are supported without sign-in (subject to GitHub&apos;s unauthenticated
                API rate limit of 60 requests per hour per IP).
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                    <th className="py-3 px-6">Format</th>
                    <th className="py-3 px-4">Example Input</th>
                    <th className="py-3 px-4">Behavior</th>
                    <th className="py-3 px-6 text-right">Test</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {URL_FORMAT_EXAMPLES.map((row) => (
                    <tr key={row.pattern} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-3.5 px-6 font-medium text-slate-900 whitespace-nowrap">
                        {row.pattern}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-xs text-slate-700">
                        {row.example}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-600 max-w-md">
                        {row.behavior}
                      </td>
                      <td className="py-3.5 px-6 text-right">
                        <button
                          type="button"
                          onClick={() => handleQuickLoad(row.example)}
                          className="px-3 py-1.5 text-xs font-medium text-blue-700 border border-slate-200 hover:border-blue-300 hover:bg-blue-50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                        >
                          Fetch
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
