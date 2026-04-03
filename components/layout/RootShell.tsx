'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import ToastProvider from './ToastProvider';
import AppInitializer from './AppInitializer';
import Sidebar from './Sidebar';
import Header from './Header';
import AddConversationModal from '@/components/conversations/AddConversationModal';

const COLLAPSE_KEY = 'qa_sidebar_collapsed';

export default function RootShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showAddConv, setShowAddConv] = useState(false);
  const pathname = usePathname();

  // Restore collapsed state from localStorage
  useEffect(() => {
    const stored = localStorage.getItem(COLLAPSE_KEY);
    if (stored === 'true') setSidebarCollapsed(true);
  }, []);

  const handleToggleCollapse = () => {
    setSidebarCollapsed((v) => {
      const next = !v;
      localStorage.setItem(COLLAPSE_KEY, String(next));
      return next;
    });
  };

  return (
    <ToastProvider>
      <AppInitializer>
        <div className="flex h-screen overflow-hidden bg-[#f4f6f9]">
          <Sidebar
            isOpen={sidebarOpen}
            isCollapsed={sidebarCollapsed}
            onClose={() => setSidebarOpen(false)}
            onToggleCollapse={handleToggleCollapse}
          />
          <div className="flex flex-col flex-1 overflow-hidden min-w-0">
            <Header
              onMenuToggle={() => setSidebarOpen((v) => !v)}
              onAddConversation={pathname === '/' ? () => setShowAddConv(true) : undefined}
            />
            <main className="flex-1 overflow-hidden flex flex-col">
              {children}
            </main>
          </div>
        </div>

        {showAddConv && (
          <AddConversationModal onClose={() => setShowAddConv(false)} />
        )}
      </AppInitializer>
    </ToastProvider>
  );
}
