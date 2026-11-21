import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Minus,
  Search,
  X,
} from 'lucide-react';
import { formatBytes, getFileExtension, isImageFile } from '../services/github';
import type { TreeNode } from '../types/github';

interface FileTreeProps {
  nodes: TreeNode[];
  selectedFilePath: string | null;
  checkedFiles: Set<string>;
  totalFiles: number;
  truncated: boolean;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onSelectFile: (node: TreeNode) => void;
  onToggleFileCheck: (path: string) => void;
  onToggleFolderCheck: (node: TreeNode) => void;
  onSelectAllFiles: () => void;
  onClearCheckedFiles: () => void;
}

function collectDescendantFilePaths(node: TreeNode, acc: string[] = []): string[] {
  if (node.type === 'blob') {
    acc.push(node.path);
    return acc;
  }
  if (node.children) {
    for (const child of node.children) {
      collectDescendantFilePaths(child, acc);
    }
  }
  return acc;
}

function filterTreeNodes(nodes: TreeNode[], query: string): TreeNode[] {
  const lower = query.toLowerCase();
  const result: TreeNode[] = [];

  for (const node of nodes) {
    if (node.type === 'blob') {
      if (node.path.toLowerCase().includes(lower)) {
        result.push(node);
      }
    } else if (node.children) {
      const filteredChildren = filterTreeNodes(node.children, query);
      if (filteredChildren.length > 0 || node.path.toLowerCase().includes(lower)) {
        result.push({
          ...node,
          children: filteredChildren.length > 0 ? filteredChildren : node.children,
        });
      }
    }
  }

  return result;
}

function FileIcon({ path }: { path: string }) {
  if (isImageFile(path)) {
    return <FileImage className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />;
  }
  const ext = getFileExtension(path);
  if (ext === 'json' || ext === 'yaml' || ext === 'yml' || ext === 'toml') {
    return <FileJson className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />;
  }
  if (ext === 'md' || ext === 'mdx' || ext === 'txt' || ext === 'license') {
    return <FileText className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />;
  }
  return <FileCode2 className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />;
}

export function FileTree({
  nodes,
  selectedFilePath,
  checkedFiles,
  totalFiles,
  truncated,
  expandedFolders,
  onToggleFolder,
  onExpandAll,
  onCollapseAll,
  onSelectFile,
  onToggleFileCheck,
  onToggleFolderCheck,
  onSelectAllFiles,
  onClearCheckedFiles,
}: FileTreeProps) {
  const [filterQuery, setFilterQuery] = useState('');

  const trimmedQuery = filterQuery.trim();

  const displayedNodes = useMemo(() => {
    if (!trimmedQuery) return nodes;
    return filterTreeNodes(nodes, trimmedQuery);
  }, [nodes, trimmedQuery]);

  const folderCheckState = (node: TreeNode): 'checked' | 'indeterminate' | 'unchecked' => {
    const descendants = collectDescendantFilePaths(node);
    if (descendants.length === 0) return 'unchecked';
    let checkedCount = 0;
    for (const filePath of descendants) {
      if (checkedFiles.has(filePath)) checkedCount += 1;
    }
    if (checkedCount === 0) return 'unchecked';
    if (checkedCount === descendants.length) return 'checked';
    return 'indeterminate';
  };

  const renderNode = (node: TreeNode, depth: number) => {
    const paddingLeft = 12 + depth * 16;

    if (node.type === 'tree') {
      const isExpanded = trimmedQuery.length > 0 || expandedFolders.has(node.path);
      const checkState = folderCheckState(node);

      return (
        <div key={node.path} role="treeitem" aria-expanded={isExpanded}>
          <div
            className="group flex items-center h-9 pr-3 text-sm text-slate-700 hover:bg-slate-50 transition-colors select-none"
            style={{ paddingLeft }}
          >
            <button
              type="button"
              onClick={() => onToggleFolderCheck(node)}
              aria-label={`Select all files in ${node.name}`}
              className={`mr-2 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                checkState === 'checked' || checkState === 'indeterminate'
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'border-slate-300 bg-white hover:border-slate-400'
              }`}
            >
              {checkState === 'checked' && <Check className="w-3 h-3 stroke-[2.5]" />}
              {checkState === 'indeterminate' && <Minus className="w-3 h-3 stroke-[2.5]" />}
            </button>

            <button
              type="button"
              onClick={() => onToggleFolder(node.path)}
              className="flex items-center gap-1.5 min-w-0 flex-1 h-full text-left cursor-pointer focus-visible:outline-none focus-visible:text-blue-700"
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
              )}
              {isExpanded ? (
                <FolderOpen className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
              ) : (
                <Folder className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate font-medium text-slate-800">{node.name}</span>
              <span className="ml-auto pl-2 font-mono tabular-nums text-[11px] text-slate-400 shrink-0">
                {node.fileCount}
              </span>
            </button>
          </div>

          {isExpanded && node.children && node.children.length > 0 && (
            <div role="group">{node.children.map((child) => renderNode(child, depth + 1))}</div>
          )}
        </div>
      );
    }

    const isSelected = selectedFilePath === node.path;
    const isChecked = checkedFiles.has(node.path);

    return (
      <div
        key={node.path}
        role="treeitem"
        aria-selected={isSelected}
        className={`group flex items-center h-9 pr-3 text-sm transition-colors ${
          isSelected
            ? 'bg-blue-50/80 text-blue-900 font-medium'
            : 'text-slate-700 hover:bg-slate-50'
        }`}
        style={{ paddingLeft: paddingLeft + 18 }}
      >
        <button
          type="button"
          onClick={() => onToggleFileCheck(node.path)}
          aria-label={`Select ${node.name} for archive`}
          className={`mr-2 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
            isChecked
              ? 'bg-blue-600 border-blue-600 text-white'
              : 'border-slate-300 bg-white hover:border-slate-400'
          }`}
        >
          {isChecked && <Check className="w-3 h-3 stroke-[2.5]" />}
        </button>

        <button
          type="button"
          onClick={() => onSelectFile(node)}
          className="flex items-center gap-2 min-w-0 flex-1 h-full text-left cursor-pointer focus-visible:outline-none focus-visible:text-blue-700"
        >
          <FileIcon path={node.path} />
          <span className="truncate font-mono text-[13px]">{node.name}</span>
          <span className="ml-auto pl-2 font-mono tabular-nums text-[11px] text-slate-400 shrink-0">
            {formatBytes(node.size)}
          </span>
        </button>
      </div>
    );
  };

  const allChecked = totalFiles > 0 && checkedFiles.size === totalFiles;

  return (
    <aside className="flex flex-col bg-white border-b lg:border-b-0 lg:border-r border-slate-200 lg:w-[360px] xl:w-[390px] shrink-0 lg:min-h-[600px] lg:max-h-[calc(100vh-230px)]">
      {/* Search & Tree Controls */}
      <div className="p-3 border-b border-slate-200 space-y-2.5">
        <div className="relative">
          <Search
            className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Filter files by path..."
            aria-label="Filter repository files"
            className="w-full h-9 pl-9 pr-8 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15 transition-colors"
          />
          {filterQuery && (
            <button
              type="button"
              onClick={() => setFilterQuery('')}
              aria-label="Clear filter"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-3 text-slate-500">
            <button
              type="button"
              onClick={allChecked ? onClearCheckedFiles : onSelectAllFiles}
              className="font-medium text-slate-600 hover:text-blue-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {allChecked ? 'Clear selection' : 'Select all'}
            </button>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span className="font-mono tabular-nums text-slate-500 whitespace-nowrap">
              {checkedFiles.size} / {totalFiles} selected
            </span>
          </div>

          <div className="flex items-center gap-2 text-slate-500">
            <button
              type="button"
              onClick={onExpandAll}
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Expand
            </button>
            <span aria-hidden="true" className="text-slate-300">
              /
            </span>
            <button
              type="button"
              onClick={onCollapseAll}
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Collapse
            </button>
          </div>
        </div>
      </div>

      {truncated && (
        <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 flex items-start gap-2 text-xs text-amber-800">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Large repository: GitHub truncated the recursive listing. Use Full Archive (.zip) to
            download every file.
          </span>
        </div>
      )}

      {/* Tree viewport */}
      <div
        role="tree"
        aria-label="Repository file structure"
        className="flex-1 overflow-y-auto py-1.5 max-h-[420px] lg:max-h-none"
      >
        {displayedNodes.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium text-slate-700">No matching files</p>
            <p className="mt-1 text-xs text-slate-500">
              No paths match &ldquo;{trimmedQuery}&rdquo;.
            </p>
            <button
              type="button"
              onClick={() => setFilterQuery('')}
              className="mt-3 text-xs font-medium text-blue-700 hover:underline cursor-pointer"
            >
              Reset filter
            </button>
          </div>
        ) : (
          displayedNodes.map((node) => renderNode(node, 0))
        )}
      </div>
    </aside>
  );
}
