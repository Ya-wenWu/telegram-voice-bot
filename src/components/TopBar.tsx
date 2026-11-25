import { ChristmasPineMark } from './ChristmasAccents';

export type WorkspaceTab =
  | 'live'
  | 'resources'
  | 'compliance'
  | 'loadtest'
  | 'delivery'
  | 'explorer'
  | 'recent'
  | 'formats';

interface TopBarProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  recentCount: number;
}

export function TopBar({
  activeTab,
  onSelectTab,
  recentCount,
}: TopBarProps) {
  const navItems: Array<{ id: WorkspaceTab; label: string }> = [
    { id: 'live', label: 'Web Bot' },
    { id: 'resources', label: '系統資源' },
    { id: 'compliance', label: 'Compliance' },
    { id: 'loadtest', label: '壓測報告' },
    { id: 'delivery', label: 'Email / ZIP' },
    { id: 'explorer', label: recentCount > 0 ? `GitHub Explorer (${recentCount})` : 'GitHub Explorer' },
  ];

  return (
    <header className="sticky top-0 z-30 bg-[#FFFDFA]/95 backdrop-blur-sm border-b border-[#E6DFD3]">
      {/* Subtle 2px Nordic holiday accent hairline */}
      <div
        aria-hidden="true"
        className="h-0.5 w-full bg-gradient-to-r from-[#14532D] via-[#991B1B] to-[#B45309]"
      />
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center gap-8">
        {/* Brand wordmark with pine tree emblem */}
        <button
          type="button"
          onClick={() => onSelectTab('live')}
          className="inline-flex items-center gap-2 font-display text-lg font-bold tracking-tight text-[#14532D] hover:text-[#991B1B] transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#991B1B] focus-visible:ring-offset-2 rounded"
        >
          <ChristmasPineMark className="w-5 h-5 shrink-0" />
          <span>Web Voice Bot</span>
        </button>

        {/* Single-line text navigation tabs */}
        <nav
          aria-label="Primary navigation"
          className="flex items-center gap-5 text-sm font-medium overflow-x-auto"
        >
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`relative py-4 text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:text-[#991B1B] ${
                  isActive
                    ? 'text-[#14532D] font-semibold'
                    : 'text-slate-600 hover:text-[#991B1B]'
                }`}
              >
                {item.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-[#991B1B]"
                  />
                )}
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
