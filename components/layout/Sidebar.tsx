'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useStore } from '@/lib/store';

interface SidebarProps {
  isOpen?: boolean;
  isCollapsed?: boolean;
  onClose?: () => void;
  onToggleCollapse?: () => void;
}

function IconChat() {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
    </svg>
  );
}

function IconDocument() {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  );
}

function IconHistory() {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function IconChevronLeft() {
  return (
    <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
    </svg>
  );
}

function IconChevronRight() {
  return (
    <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}

function IconCollect() {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
  );
}

function IconBatch() {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
    </svg>
  );
}

function IconDashboard() {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
    </svg>
  );
}

const NAV_ITEMS = [
  { href: '/', label: 'Conversations', icon: <IconChat /> },
  { href: '/collect', label: 'Collect', icon: <IconCollect /> },
  { href: '/prompts', label: 'Prompt Library', icon: <IconDocument /> },
  { href: '/analysis-history', label: 'Analysis History', icon: <IconHistory /> },
  { href: '/batch-analysis', label: 'Batch Analysis', icon: <IconBatch /> },
  { href: '/dashboard', label: 'Dashboard', icon: <IconDashboard /> },
];

export default function Sidebar({ isOpen = true, isCollapsed = false, onClose, onToggleCollapse }: SidebarProps) {
  const pathname = usePathname();
  const { currentUser } = useStore();

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/' || pathname.startsWith('/conversations/');
    return pathname === href || pathname.startsWith(href + '/');
  };

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div className="fixed inset-0 bg-black/50 z-20 lg:hidden" onClick={onClose} />
      )}

      <aside
        className={[
          'fixed lg:static inset-y-0 left-0 z-30',
          'bg-[#0d1117] flex flex-col h-screen overflow-hidden',
          'transition-all duration-200 ease-in-out',
          'w-64',
          isCollapsed ? 'lg:w-16' : 'lg:w-60',
          isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        ].join(' ')}
      >
        {/* Logo */}
        <div className={[
          'flex items-center gap-3 h-16 border-b border-white/[0.06] flex-shrink-0 px-4',
          isCollapsed ? 'lg:justify-center lg:px-0' : '',
        ].join(' ')}>
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-xs shrink-0">
            QA
          </div>
          <span className={['font-semibold text-sm text-white tracking-tight', isCollapsed ? 'lg:hidden' : ''].join(' ')}>
            AI Chat QA
          </span>
        </div>

        {/* Nav links */}
        <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map(({ href, label, icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                title={isCollapsed ? label : undefined}
                className={[
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  isCollapsed ? 'lg:justify-center lg:px-0 lg:py-3' : '',
                  active
                    ? 'bg-white/10 text-white'
                    : 'text-white/50 hover:bg-white/[0.05] hover:text-white/80',
                ].join(' ')}
              >
                <span className={active ? 'text-blue-400' : ''}>{icon}</span>
                <span className={isCollapsed ? 'lg:hidden' : ''}>{label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="border-t border-white/[0.06] p-2 space-y-1 flex-shrink-0">
          {/* Collapse toggle — desktop only */}
          <button
            onClick={onToggleCollapse}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={[
              'hidden lg:flex items-center gap-2 w-full px-3 py-2 rounded-lg',
              'text-white/40 hover:text-white/70 hover:bg-white/[0.05] transition-colors text-xs font-medium',
              isCollapsed ? 'lg:justify-center lg:px-0' : '',
            ].join(' ')}
          >
            {isCollapsed ? <IconChevronRight /> : <><IconChevronLeft /><span>Collapse</span></>}
          </button>

          {/* User */}
          <div className={[
            'flex items-center gap-2.5 px-3 py-2 rounded-lg',
            isCollapsed ? 'lg:justify-center lg:px-0' : '',
          ].join(' ')}>
            <div className="w-7 h-7 bg-blue-600/20 text-blue-400 rounded-full flex items-center justify-center text-xs font-bold uppercase shrink-0">
              {currentUser ? currentUser.charAt(0) : '?'}
            </div>
            <p className={['text-xs font-medium text-white/50 truncate', isCollapsed ? 'lg:hidden' : ''].join(' ')}>
              {currentUser || 'Guest'}
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
