// ── SIDEBAR TOGGLE (mobile) ───────────────────────────────────────

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sb-overlay').classList.toggle('open');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sb-overlay').classList.remove('open');
}

// ── EVENT LISTENERS ───────────────────────────────────────────────

document.getElementById('add-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('add-overlay')) closeAddModal();
});

document.getElementById('stage-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('stage-overlay')) closeStageModal();
});

document.getElementById('run-analyze-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('run-analyze-overlay')) closeRunAnalyzeModal();
});

document.getElementById('prompt-modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('prompt-modal-overlay')) closePromptModal();
});

// ── BOOT (async to support Supabase) ─────────────────────────────

(async function boot() {
  await loadState();
  renderAll();
  initPrompts();
  renderPromptLibrary();
  showConversations(null);
})();
