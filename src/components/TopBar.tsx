import { Download, FolderGit2 } from 'lucide-react';

export type WorkspaceTab = 'live' | 'delivery' | 'explorer' | 'recent' | 'formats';

interface TopBarProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  recentCount: number;
  hasRepository: boolean;
  onPrimaryAction: () => void;
  primaryActionLabel: string;
  primaryActionDisabled?: boolean;
}

export function TopBar({
  activeTab,
  onSelectTab,
  recentCount,
  hasRepository,
  onPrimaryAction,
  primaryActionLabel,
  primaryActionDisabled,
}: TopBarProps) {
  const navItems: Array<{ id: WorkspaceTab; label: string }> = [
    { id: 'live', label: 'Web Bot' },
    { id: 'delivery', label: 'Email Patch' },
    { id: 'explorer', label: 'Explorer' },
    { id: 'recent', label: recentCount > 0 ? `Recent (${recentCount})` : 'Recent' },
    { id: 'formats', label: 'URL Formats' },
  ];

  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-sm border-b border-slate-200">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between gap-8">
        {/* Zone 1: Single text element wordmark */}
        <button
          type="button"
          onClick={() => onSelectTab('live')}
          className="font-display text-lg font-bold tracking-tight text-slate-900 hover:text-blue-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 rounded"
        >
          RepoFetch
        </button>

        {/* Zone 2: Concise single-line text navigation links */}
        <nav
          aria-label="Primary navigation"
          className="flex items-center gap-6 text-sm font-medium"
        >
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`relative py-4 text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:text-blue-700 ${
                  isActive
                    ? 'text-slate-900'
                    : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                {item.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-blue-600"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single primary action button */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onPrimaryAction}
            disabled={primaryActionDisabled}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            {hasRepository ? (
              <Download className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <FolderGit2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            )}
            <span>{primaryActionLabel}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
