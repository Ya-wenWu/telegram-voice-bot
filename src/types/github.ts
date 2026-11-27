export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  branch?: string;
  subPath?: string;
  isBlob?: boolean;
  canonicalUrl: string;
}

export interface GitHubRepoMeta {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  license: {
    name: string;
    spdx_id: string;
  } | null;
  size: number;
  updated_at: string;
  pushed_at: string;
  owner: {
    login: string;
    avatar_url: string;
    html_url: string;
  };
  private: boolean;
}

export interface GitHubBranch {
  name: string;
  protected: boolean;
}

export interface GitHubTreeItem {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
  url?: string;
}

export interface TreeNode {
  name: string;
  path: string;
  type: 'blob' | 'tree';
  size: number;
  sha: string;
  children?: TreeNode[];
  fileCount: number;
}

export interface ExtensionStat {
  extension: string;
  count: number;
  bytes: number;
  percentage: number;
}

export interface RepositoryBundle {
  meta: GitHubRepoMeta;
  branch: string;
  branches: GitHubBranch[];
  flatItems: GitHubTreeItem[];
  tree: TreeNode[];
  truncated: boolean;
  totalFiles: number;
  totalFolders: number;
  totalBytes: number;
  extensionStats: ExtensionStat[];
  readmePath: string | null;
  initialSubPath?: string;
  initialSelectedFile?: string;
}

export interface FileInspection {
  path: string;
  name: string;
  size: number;
  kind: 'text' | 'image' | 'binary';
  content?: string;
  imageUrl?: string;
  truncatedPreview?: boolean;
  lineCount?: number;
}

export interface FetchHistoryEntry {
  fullName: string;
  url: string;
  branch: string;
  description: string | null;
  totalFiles: number;
  totalBytes: number;
  fetchedAt: string;
}

export interface ZipProgress {
  active: boolean;
  completed: number;
  total: number;
  failed: number;
  currentFile: string;
}
