'use client';

import PromptLibrary from '@/components/prompts/PromptLibrary';

export default function PromptsPage() {
  return (
    <div className="flex-1 overflow-hidden flex flex-col p-4 sm:p-6 min-h-0">
      <PromptLibrary />
    </div>
  );
}
