import JSZip from 'jszip';
import type {
  ExtensionStat,
  FileInspection,
  GitHubBranch,
  GitHubRepoMeta,
  GitHubTreeItem,
  ParsedGitHubUrl,
  RepositoryBundle,
  TreeNode,
} from '../types/github';

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'ico',
  'bmp',
  'avif',
]);

const BINARY_EXTENSIONS = new Set([
  'pdf',
  'zip',
  'tar',
  'gz',
  '7z',
  'rar',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp3',
  'mp4',
  'wav',
  'ogg',
  'webm',
  'mov',
  'avi',
  'wasm',
  'exe',
  'dll',
  'so',
  'dylib',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'class',
  'jar',
  'pyc',
  'sqlite',
  'db',
  'psd',
  'ai',
  'sketch',
  'fig',
]);

export function getFileExtension(path: string): string {
  const fileName = path.split('/').pop() ?? path;
  if (!fileName.includes('.') || fileName.startsWith('.') && fileName.indexOf('.', 1) === -1) {
    return fileName.toLowerCase();
  }
  const parts = fileName.split('.');
  return parts[parts.length - 1].toLowerCase();
}

export function isImageFile(path: string): boolean {
  return IMAGE_EXTENSIONS.has(getFileExtension(path));
}

export function isBinaryFile(path: string): boolean {
  return BINARY_EXTENSIONS.has(getFileExtension(path));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

export function formatCompactNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return num.toLocaleString();
}

export function formatRelativeDate(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Parses common GitHub repository URL formats and shorthand owner/repo strings.
 */
export function parseGitHubUrl(rawInput: string): ParsedGitHubUrl {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error('Paste a GitHub repository URL to begin.');
  }

  // Support git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    const owner = sshMatch[1];
    const repo = sshMatch[2];
    return {
      owner,
      repo,
      canonicalUrl: `https://github.com/${owner}/${repo}`,
    };
  }

  // Support owner/repo shorthand (no protocol, no domain)
  const shorthandMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (shorthandMatch && !trimmed.includes('github.com')) {
    const owner = shorthandMatch[1];
    const repo = shorthandMatch[2];
    return {
      owner,
      repo,
      canonicalUrl: `https://github.com/${owner}/${repo}`,
    };
  }

  // Normalize missing protocol (e.g. github.com/owner/repo)
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(withProtocol);
  } catch {
    throw new Error(
      'Invalid URL format. Use a GitHub URL such as https://github.com/owner/repository.'
    );
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw new Error('Only github.com repository URLs are supported.');
  }

  const segments = parsedUrl.pathname
    .split('/')
    .map((s) => decodeURIComponent(s))
    .filter(Boolean);

  if (segments.length < 2) {
    throw new Error(
      'Incomplete GitHub URL. Include both the owner and repository name (e.g. https://github.com/vitejs/vite).'
    );
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');

  if (!owner || !repo) {
    throw new Error('Could not determine repository owner and name from that URL.');
  }

  let branch: string | undefined;
  let subPath: string | undefined;
  let isBlob = false;

  if (segments.length >= 4 && (segments[2] === 'tree' || segments[2] === 'blob')) {
    isBlob = segments[2] === 'blob';
    branch = segments[3];
    if (segments.length > 4) {
      subPath = segments.slice(4).join('/');
    }
  }

  return {
    owner,
    repo,
    branch,
    subPath,
    isBlob,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
  };
}

function buildApiErrorMessage(response: Response, context: string): string {
  if (response.status === 404) {
    return `${context} not found. Verify the URL and make sure the repository is public.`;
  }
  if (response.status === 403) {
    const remaining = response.headers.get('X-RateLimit-Remaining');
    const resetHeader = response.headers.get('X-RateLimit-Reset');
    if (remaining === '0' && resetHeader) {
      const resetDate = new Date(Number(resetHeader) * 1000);
      const timeStr = resetDate.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      return `GitHub API public rate limit reached. Rate limit resets at ${timeStr}.`;
    }
    return 'Access denied by GitHub API. Private repositories require authentication.';
  }
  if (response.status === 409) {
    return 'This repository is empty and has no committed files yet.';
  }
  return `GitHub API returned status ${response.status} while loading ${context.toLowerCase()}.`;
}

export function buildFileTree(items: GitHubTreeItem[]): {
  tree: TreeNode[];
  totalFiles: number;
  totalFolders: number;
  totalBytes: number;
  extensionStats: ExtensionStat[];
  readmePath: string | null;
} {
  const rootMap = new Map<string, TreeNode>();
  const topLevel: TreeNode[] = [];
  let totalFiles = 0;
  let totalFolders = 0;
  let totalBytes = 0;
  let readmePath: string | null = null;
  const extAgg = new Map<string, { count: number; bytes: number }>();

  const ensureFolder = (folderPath: string): TreeNode => {
    const existing = rootMap.get(folderPath);
    if (existing) return existing;

    const parts = folderPath.split('/');
    const name = parts[parts.length - 1];
    const node: TreeNode = {
      name,
      path: folderPath,
      type: 'tree',
      size: 0,
      sha: folderPath,
      children: [],
      fileCount: 0,
    };
    rootMap.set(folderPath, node);
    totalFolders += 1;

    if (parts.length === 1) {
      topLevel.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = ensureFolder(parentPath);
      parent.children!.push(node);
    }

    return node;
  };

  for (const item of items) {
    if (item.type === 'tree') {
      const folder = ensureFolder(item.path);
      folder.sha = item.sha;
      continue;
    }

    if (item.type !== 'blob') continue;

    const parts = item.path.split('/');
    const name = parts[parts.length - 1];
    const size = item.size ?? 0;

    if (!readmePath && parts.length === 1 && /^readme(\.(md|mdx|txt))?$/i.test(name)) {
      readmePath = item.path;
    }

    const fileNode: TreeNode = {
      name,
      path: item.path,
      type: 'blob',
      size,
      sha: item.sha,
      fileCount: 1,
    };

    totalFiles += 1;
    totalBytes += size;

    const ext = getFileExtension(item.path);
    const prev = extAgg.get(ext) ?? { count: 0, bytes: 0 };
    extAgg.set(ext, { count: prev.count + 1, bytes: prev.bytes + size });

    if (parts.length === 1) {
      topLevel.push(fileNode);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = ensureFolder(parentPath);
      parent.children!.push(fileNode);
    }
  }

  // Recursively sort folders first (alphabetical) then files (alphabetical), and roll up folder sizes & file counts
  const finalize = (nodes: TreeNode[]): { size: number; fileCount: number } => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    let sumSize = 0;
    let sumFiles = 0;

    for (const node of nodes) {
      if (node.type === 'tree' && node.children) {
        const sub = finalize(node.children);
        node.size = sub.size;
        node.fileCount = sub.fileCount;
        sumSize += sub.size;
        sumFiles += sub.fileCount;
      } else {
        sumSize += node.size;
        sumFiles += 1;
      }
    }

    return { size: sumSize, fileCount: sumFiles };
  };

  finalize(topLevel);

  const extensionStats: ExtensionStat[] = Array.from(extAgg.entries())
    .map(([extension, stat]) => ({
      extension: extension.length > 16 ? `${extension.slice(0, 14)}…` : extension,
      count: stat.count,
      bytes: stat.bytes,
      percentage: totalFiles > 0 ? (stat.count / totalFiles) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count || b.bytes - a.bytes)
    .slice(0, 12);

  return {
    tree: topLevel,
    totalFiles,
    totalFolders,
    totalBytes,
    extensionStats,
    readmePath,
  };
}

export async function fetchRepositoryBundle(
  parsed: ParsedGitHubUrl,
  overrideBranch?: string,
  onStage?: (stage: string) => void,
  signal?: AbortSignal
): Promise<RepositoryBundle> {
  const headers: HeadersInit = {
    Accept: 'application/vnd.github+json',
  };

  onStage?.(`Fetching repository metadata for ${parsed.owner}/${parsed.repo}`);
  const repoRes = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
    { headers, signal }
  );

  if (!repoRes.ok) {
    throw new Error(buildApiErrorMessage(repoRes, `Repository "${parsed.owner}/${parsed.repo}"`));
  }

  const meta = (await repoRes.json()) as GitHubRepoMeta;
  const targetBranch = overrideBranch || parsed.branch || meta.default_branch;

  onStage?.(`Loading branches and directory tree (${targetBranch})`);

  const [branchesRes, treeRes] = await Promise.all([
    fetch(
      `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/branches?per_page=100`,
      { headers, signal }
    ).catch(() => null),
    fetch(
      `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/git/trees/${encodeURIComponent(targetBranch)}?recursive=1`,
      { headers, signal }
    ),
  ]);

  if (!treeRes.ok) {
    throw new Error(buildApiErrorMessage(treeRes, `Branch "${targetBranch}"`));
  }

  let branches: GitHubBranch[] = [{ name: targetBranch, protected: false }];
  if (branchesRes && branchesRes.ok) {
    const rawBranches = (await branchesRes.json()) as GitHubBranch[];
    if (Array.isArray(rawBranches) && rawBranches.length > 0) {
      branches = rawBranches;
      if (!branches.some((b) => b.name === targetBranch)) {
        branches = [{ name: targetBranch, protected: false }, ...branches];
      }
    }
  }

  const treeJson = (await treeRes.json()) as {
    sha: string;
    tree: GitHubTreeItem[];
    truncated: boolean;
  };

  const flatItems = Array.isArray(treeJson.tree) ? treeJson.tree : [];
  const { tree, totalFiles, totalFolders, totalBytes, extensionStats, readmePath } =
    buildFileTree(flatItems);

  const initialSelectedFile =
    parsed.isBlob && parsed.subPath && flatItems.some((i) => i.path === parsed.subPath && i.type === 'blob')
      ? parsed.subPath
      : undefined;

  return {
    meta,
    branch: targetBranch,
    branches,
    flatItems,
    tree,
    truncated: Boolean(treeJson.truncated),
    totalFiles,
    totalFolders,
    totalBytes,
    extensionStats,
    readmePath,
    initialSubPath: !parsed.isBlob ? parsed.subPath : undefined,
    initialSelectedFile,
  };
}

export function buildRawFileUrl(
  owner: string,
  repo: string,
  branch: string,
  filePath: string
): string {
  const encodedPath = filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${encodedPath}`;
}

export function getFullArchiveUrl(owner: string, repo: string, branch: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/archive/refs/heads/${encodeURIComponent(branch)}.zip`;
}

export async function fetchFileInspection(
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  fileSize: number,
  signal?: AbortSignal
): Promise<FileInspection> {
  const name = filePath.split('/').pop() ?? filePath;
  const rawUrl = buildRawFileUrl(owner, repo, branch, filePath);

  if (isImageFile(filePath)) {
    return {
      path: filePath,
      name,
      size: fileSize,
      kind: 'image',
      imageUrl: rawUrl,
    };
  }

  if (isBinaryFile(filePath)) {
    return {
      path: filePath,
      name,
      size: fileSize,
      kind: 'binary',
    };
  }

  const res = await fetch(rawUrl, { signal });
  if (!res.ok) {
    throw new Error(`Could not fetch file content (HTTP ${res.status}).`);
  }

  const MAX_PREVIEW_CHARS = 500_000;
  const text = await res.text();

  // Heuristic check for binary null bytes in unknown extensions
  if (text.slice(0, 4096).includes('\u0000')) {
    return {
      path: filePath,
      name,
      size: fileSize,
      kind: 'binary',
    };
  }

  const truncatedPreview = text.length > MAX_PREVIEW_CHARS;
  const displayContent = truncatedPreview ? text.slice(0, MAX_PREVIEW_CHARS) : text;
  const lineCount = displayContent.split('\n').length;

  return {
    path: filePath,
    name,
    size: fileSize,
    kind: 'text',
    content: displayContent,
    truncatedPreview,
    lineCount,
  };
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export async function downloadSingleFile(
  owner: string,
  repo: string,
  branch: string,
  filePath: string
): Promise<void> {
  const rawUrl = buildRawFileUrl(owner, repo, branch, filePath);
  const res = await fetch(rawUrl);
  if (!res.ok) {
    throw new Error(`Failed to download ${filePath} (HTTP ${res.status}).`);
  }
  const blob = await res.blob();
  const filename = filePath.split('/').pop() ?? 'file';
  triggerBlobDownload(blob, filename);
}

export async function downloadFilesAsZip(
  owner: string,
  repo: string,
  branch: string,
  filePaths: string[],
  onProgress?: (progress: {
    completed: number;
    total: number;
    failed: number;
    currentFile: string;
  }) => void
): Promise<{ failedCount: number }> {
  const zip = new JSZip();
  const rootFolder = zip.folder(`${repo}-${branch}`);
  const total = filePaths.length;
  let completed = 0;
  let failed = 0;

  const CONCURRENCY = 6;
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < total) {
      const idx = nextIndex;
      nextIndex += 1;
      const path = filePaths[idx];

      onProgress?.({ completed, total, failed, currentFile: path });

      try {
        const rawUrl = buildRawFileUrl(owner, repo, branch, path);
        const res = await fetch(rawUrl);
        if (!res.ok) {
          failed += 1;
        } else {
          const buffer = await res.arrayBuffer();
          if (rootFolder) {
            rootFolder.file(path, buffer);
          } else {
            zip.file(path, buffer);
          }
        }
      } catch {
        failed += 1;
      } finally {
        completed += 1;
        onProgress?.({ completed, total, failed, currentFile: path });
      }
    }
  };

  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const safeBranch = branch.replace(/[^a-zA-Z0-9._-]/g, '-');
  triggerBlobDownload(zipBlob, `${repo}-${safeBranch}.zip`);

  return { failedCount: failed };
}
