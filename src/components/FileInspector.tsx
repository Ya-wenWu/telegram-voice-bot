import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  FileWarning,
  FolderTree,
  Image as ImageIcon,
  Loader2,
} from 'lucide-react';
import { formatBytes } from '../services/github';
import type { FileInspection, RepositoryBundle } from '../types/github';

interface FileInspectorProps {
  bundle: RepositoryBundle;
  inspection: FileInspection | null;
  loadingFile: boolean;
  fileError: string | null;
  readmeContent: string | null;
  readmeLoading: boolean;
  onDownloadSingleFile: (path: string) => void;
  downloadingFile: boolean;
  onClearSelectedFile: () => void;
  onOpenReadme: () => void;
}

export function FileInspector({
  bundle,
  inspection,
  loadingFile,
  fileError,
  readmeContent,
  readmeLoading,
  onDownloadSingleFile,
  downloadingFile,
  onClearSelectedFile,
  onOpenReadme,
}: FileInspectorProps) {
  const [copied, setCopied] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setCopied(false);
    setImageFailed(false);
  }, [inspection?.path]);

  const handleCopy = async () => {
    if (!inspection?.content) return;
    try {
      await navigator.clipboard.writeText(inspection.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API unavailable in restricted context
    }
  };

  if (loadingFile) {
    return (
      <section className="flex-1 min-w-0 bg-white flex flex-col lg:min-h-[600px] lg:max-h-[calc(100vh-230px)]">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center gap-3">
          <Loader2 className="w-4 h-4 text-blue-600 animate-spin" aria-hidden="true" />
          <span className="text-sm text-slate-600">Loading file contents...</span>
        </div>
        <div className="p-6 space-y-2.5">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="h-4 rounded bg-slate-100 animate-pulse"
              style={{ width: `${55 + ((i * 17) % 40)}%` }}
            />
          ))}
        </div>
      </section>
    );
  }

  if (fileError) {
    return (
      <section className="flex-1 min-w-0 bg-white flex flex-col items-center justify-center p-10 text-center lg:min-h-[600px]">
        <AlertCircle className="w-8 h-8 text-red-600 mb-3" aria-hidden="true" />
        <h3 className="text-base font-semibold text-slate-900">Unable to load file</h3>
        <p className="mt-1.5 text-sm text-slate-600 max-w-md">{fileError}</p>
        <button
          type="button"
          onClick={onClearSelectedFile}
          className="mt-4 px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
        >
          Return to repository overview
        </button>
      </section>
    );
  }

  // Active File Inspection View
  if (inspection) {
    const pathSegments = inspection.path.split('/');

    return (
      <section className="flex-1 min-w-0 bg-white flex flex-col lg:min-h-[600px] lg:max-h-[calc(100vh-230px)]">
        {/* File Header Bar */}
        <div className="px-4 sm:px-5 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-xs font-mono text-slate-500 overflow-x-auto">
              <button
                type="button"
                onClick={onClearSelectedFile}
                className="text-slate-500 hover:text-blue-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {bundle.meta.name}
              </button>
              {pathSegments.map((seg, idx) => (
                <span key={`${seg}-${idx}`} className="flex items-center gap-1.5 shrink-0">
                  <span aria-hidden="true" className="text-slate-300">
                    /
                  </span>
                  <span
                    className={
                      idx === pathSegments.length - 1
                        ? 'text-slate-900 font-semibold'
                        : 'text-slate-500'
                    }
                  >
                    {seg}
                  </span>
                </span>
              ))}
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
              <span>{formatBytes(inspection.size)}</span>
              {inspection.lineCount !== undefined && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{inspection.lineCount.toLocaleString()} lines</span>
                </>
              )}
              {inspection.truncatedPreview && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-amber-700 font-sans">Preview truncated at 500 KB</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {inspection.kind === 'text' && (
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={() => onDownloadSingleFile(inspection.path)}
              disabled={downloadingFile}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1"
            >
              {downloadingFile ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>Download File</span>
            </button>
          </div>
        </div>

        {/* File Body */}
        {inspection.kind === 'text' && (
          <div className="flex-1 overflow-auto bg-white">
            <table className="w-full border-collapse font-mono text-[13px] leading-6">
              <tbody>
                {(inspection.content ?? '').split('\n').map((line, index) => (
                  <tr key={index} className="hover:bg-slate-50/80">
                    <td className="w-12 px-3 text-right select-none text-slate-400 tabular-nums align-top border-r border-slate-100 bg-slate-50/40">
                      {index + 1}
                    </td>
                    <td className="px-4 whitespace-pre text-slate-800">{line || ' '}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {inspection.kind === 'image' && (
          <div className="flex-1 overflow-auto p-8 flex flex-col items-center justify-center bg-slate-50/60">
            {!imageFailed && inspection.imageUrl ? (
              <img
                src={inspection.imageUrl}
                alt={inspection.name}
                referrerPolicy="no-referrer"
                onError={() => setImageFailed(true)}
                className="max-w-full max-h-[460px] object-contain border border-slate-200 bg-white p-2 rounded-md"
              />
            ) : (
              <div className="flex flex-col items-center justify-center p-10 bg-white border border-slate-200 rounded-lg text-center">
                <ImageIcon className="w-8 h-8 text-slate-400 mb-2" aria-hidden="true" />
                <p className="text-sm font-medium text-slate-800">{inspection.name}</p>
                <p className="mt-1 text-xs text-slate-500">
                  Image preview unavailable. Use Download File to save locally.
                </p>
              </div>
            )}
          </div>
        )}

        {inspection.kind === 'binary' && (
          <div className="flex-1 flex flex-col items-center justify-center p-10 text-center">
            <FileWarning className="w-9 h-9 text-slate-400 mb-3" aria-hidden="true" />
            <h3 className="text-base font-semibold text-slate-900">Binary file</h3>
            <p className="mt-1 text-sm text-slate-600 max-w-sm">
              <span className="font-mono text-slate-800">{inspection.name}</span> (
              {formatBytes(inspection.size)}) cannot be previewed as plain text.
            </p>
            <button
              type="button"
              onClick={() => onDownloadSingleFile(inspection.path)}
              disabled={downloadingFile}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Download {inspection.name}</span>
            </button>
          </div>
        )}
      </section>
    );
  }

  // Default Overview when repository is loaded and no individual file is selected
  return (
    <section className="flex-1 min-w-0 bg-white overflow-y-auto lg:min-h-[600px] lg:max-h-[calc(100vh-230px)]">
      <div className="p-6 sm:p-8 space-y-8">
        {/* Structure Distribution Table */}
        <div>
          <div className="flex items-baseline justify-between gap-4 pb-3 border-b border-slate-200">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Repository Structure Overview
              </h2>
              <p className="mt-0.5 text-sm text-slate-500">
                Select any file in the directory tree to inspect its contents, or check files to
                bundle a custom ZIP archive.
              </p>
            </div>
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-500 font-mono tabular-nums shrink-0">
              <FolderTree className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
              <span>
                {bundle.totalFolders.toLocaleString()} folders · {bundle.totalFiles.toLocaleString()}{' '}
                files
              </span>
            </div>
          </div>

          {bundle.extensionStats.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                    <th className="py-2.5 pr-4">File Type</th>
                    <th className="py-2.5 px-4 text-right">Files</th>
                    <th className="py-2.5 px-4 text-right">Total Size</th>
                    <th className="py-2.5 pl-4 w-44">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {bundle.extensionStats.map((stat) => (
                    <tr key={stat.extension} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-2.5 pr-4 font-mono text-xs font-medium text-slate-800">
                        .{stat.extension}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-xs text-slate-700">
                        {stat.count.toLocaleString()}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-xs text-slate-500">
                        {formatBytes(stat.bytes)}
                      </td>
                      <td className="py-2.5 pl-4">
                        <div className="flex items-center gap-2.5">
                          <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-600 rounded-full"
                              style={{ width: `${Math.max(2, Math.min(100, stat.percentage))}%` }}
                            />
                          </div>
                          <span className="w-10 text-right font-mono tabular-nums text-[11px] text-slate-500">
                            {stat.percentage.toFixed(0)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Inline README preview if present */}
        {bundle.readmePath && (
          <div>
            <div className="flex items-center justify-between gap-4 pb-3 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900 font-mono">
                {bundle.readmePath}
              </h3>
              <button
                type="button"
                onClick={onOpenReadme}
                className="text-xs font-medium text-blue-700 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
              >
                Inspect full file
              </button>
            </div>
            {readmeLoading ? (
              <div className="mt-4 space-y-2">
                <div className="h-4 w-2/3 bg-slate-100 rounded animate-pulse" />
                <div className="h-4 w-5/6 bg-slate-100 rounded animate-pulse" />
                <div className="h-4 w-1/2 bg-slate-100 rounded animate-pulse" />
              </div>
            ) : readmeContent ? (
              <pre className="mt-4 p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono leading-relaxed text-slate-700 overflow-x-auto max-h-80 whitespace-pre-wrap break-words">
                {readmeContent.slice(0, 6000)}
                {readmeContent.length > 6000 ? '\n\n… (open file to read complete README)' : ''}
              </pre>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
