'use client';

import { usePathname } from 'next/navigation';
import { useStore } from '@/lib/store';

interface HeaderProps {
  onMenuToggle: () => void;
  onAddConversation?: () => void;
}

function IconMenu() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
  );
}

const PAGE_TITLES: Record<string, string> = {
  '/': 'Conversations',
  '/prompts': 'Prompt Library',
};

export default function Header({ onMenuToggle, onAddConversation }: HeaderProps) {
  const pathname = usePathname();
  const { currentUser } = useStore();

  const title = PAGE_TITLES[pathname] ?? '';

  return (
    <header className="h-14 bg-white border-b border-slate-200/80 flex items-center px-4 gap-3 flex-shrink-0">
      {/* Hamburger (mobile) */}
      <button
        onClick={onMenuToggle}
        className="lg:hidden p-2 -ml-1 rounded-lg text-slate-500 hover:bg-slate-100 transition-colors"
        aria-label="Toggle sidebar"
      >
        <IconMenu />
      </button>

      {/* Page title */}
      {title && (
        <h1 className="text-sm font-semibold text-slate-900 flex-1">{title}</h1>
      )}
      {!title && <div className="flex-1" />}

      {/* Actions */}
      <div className="flex items-center gap-2 ml-auto">
        {onAddConversation && (
          <button
            onClick={onAddConversation}
            className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
          >
            <IconPlus />
            <span className="hidden sm:inline">Add Conversation</span>
          </button>
        )}

        {/* User avatar */}
        <div className="w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold uppercase">
          {currentUser ? currentUser.charAt(0) : '?'}
        </div>
      </div>
    </header>
  );
}
