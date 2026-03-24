// ── PROMPT LIBRARY ─────────────────────────────────────────────────

const DEFAULT_PROMPT_CONTENT = `You are an expert Quality Assurance analyst for a regulated iGaming (online casino/sports betting) customer support operation. Analyze the support conversation and return ONLY a valid JSON object — no preamble, no explanation, no markdown.

LANGUAGE HANDLING:
The conversation transcript may be in any of these languages:
Arabic (ar), German (de), Greek (el), English (en), Finnish (fi), French (fr), Italian (it), Norwegian (no), or Portuguese (pt).
Detect the language of the conversation and return it as an ISO 639-1 code in the "language" field.
ALL other output fields (summary, agent_performance_notes, recommended_action, key_quotes, alert_reason, etc.) must be written in English regardless of the conversation language.

SEVERITY (dissatisfaction_severity):
- "Low"      — Minor frustration, issue fully resolved, player tone normalized
- "Medium"   — Clear dissatisfaction, partially resolved or player still uneasy
- "High"     — Strong dissatisfaction, issue unresolved, churn risk
- "Critical" — Legal/regulatory threat, VIP complaint, fraud indicators, inappropriate agent conduct

ISSUE CATEGORY (issue_category — pick exactly one):
"Payment/Withdrawal" | "Game Bug" | "Login/Account" | "Bonus/Promotion" | "Technical Error" | "Slow Response" | "Inappropriate Communication" | "Other"

RESOLUTION STATUS (resolution_status — based on player sentiment at END of conversation, NOT Intercom status):
"Resolved" | "Partially Resolved" | "Unresolved"

AGENT PERFORMANCE SCORE (agent_performance_score):
- If Is Bot Handled is true: set agent_performance_score to null and agent_performance_notes to "N/A — conversation handled by bot"
- 5=Exceptional, 4=Good, 3=Adequate, 2=Below Standard, 1=Poor

ALERT (is_alert_worthy = true) when ANY of:
- Player mentions legal action, regulator, lawyer
- VIP or high-value player dissatisfied
- Agent used inappropriate or discriminatory language
- Fraud indicators present

Return ONLY this JSON — all fields required:
{
  "language": "ISO 639-1 code (ar|de|el|en|fi|fr|it|no|pt)",
  "summary": "1-3 sentence factual summary",
  "dissatisfaction_severity": "Low|Medium|High|Critical",
  "issue_category": "one of the 8 categories",
  "resolution_status": "Resolved|Partially Resolved|Unresolved",
  "key_quotes": "1-2 direct player quotes, comma-separated, or empty string",
  "agent_performance_score": null,
  "agent_performance_notes": "specific observation about agent performance, or N/A — conversation handled by bot",
  "recommended_action": "specific QA action or No action required",
  "is_alert_worthy": false,
  "alert_reason": null
}`;

const PROMPTS_KEY = 'qa-prompts-v1';
let _prompts = [];
let _viewingPromptId = null; // null = viewing active prompt
let _isEditMode = false;

function initPrompts() {
  try {
    const stored = localStorage.getItem(PROMPTS_KEY);
    if (stored) {
      _prompts = JSON.parse(stored);
    }
  } catch (e) {
    _prompts = [];
  }

  // Ensure there is always at least one active prompt
  const hasActive = _prompts.some(p => p.is_active);
  if (_prompts.length === 0 || !hasActive) {
    const defaultPrompt = {
      id: 'prompt-default',
      name: 'Default QA Prompt',
      content: DEFAULT_PROMPT_CONTENT,
      created_at: new Date().toISOString(),
      is_active: true
    };
    if (_prompts.length === 0) {
      _prompts.push(defaultPrompt);
    } else {
      _prompts[0].is_active = true;
    }
    _savePrompts();
  }
}

function _savePrompts() {
  localStorage.setItem(PROMPTS_KEY, JSON.stringify(_prompts));
}

function getActivePrompt() {
  return _prompts.find(p => p.is_active) || { id: 'default', name: 'Default QA Prompt', content: DEFAULT_PROMPT_CONTENT, is_active: true };
}

// Called by setup.js and conversations.js before sending to /api/analyze
function getActivePromptContent() {
  return getActivePrompt().content;
}

// ── RENDER ─────────────────────────────────────────────────────────

function renderPromptLibrary() {
  const section = document.getElementById('stage-prompts');
  if (!section) return;

  const plContent = section.querySelector('#pl-content');
  if (!plContent) return;

  const activePrompt = getActivePrompt();
  const viewingPrompt = _viewingPromptId ? _prompts.find(p => p.id === _viewingPromptId) : null;
  const displayPrompt = viewingPrompt || activePrompt;
  const isViewingHistory = viewingPrompt && viewingPrompt.id !== activePrompt.id;

  const historyPrompts = _prompts.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  let historyHTML;
  if (historyPrompts.length === 0) {
    historyHTML = '<div class="pl-hist-empty">No prompts yet.</div>';
  } else {
    historyHTML = historyPrompts.map(p => {
      const isActive = p.is_active;
      const isViewing = p.id === (_viewingPromptId || activePrompt.id);
      const date = p.created_at ? fmtTime(p.created_at) : '';
      const preview = (p.content || '').slice(0, 90).replace(/\n/g, ' ') + (p.content.length > 90 ? '…' : '');
      return `<div class="pl-hist-item${isViewing ? ' viewing' : ''}" onclick="selectHistoryPrompt('${p.id}')">
        <div class="pl-hist-top">
          <span class="pl-hist-name">${esc(p.name)}</span>
          ${isActive ? '<span class="pl-hist-active-badge">Active</span>' : ''}
        </div>
        <div class="pl-hist-preview">${esc(preview)}</div>
        <div class="pl-hist-date">${date}</div>
      </div>`;
    }).join('');
  }

  let mainHTML;
  if (_isEditMode) {
    mainHTML = `
      <div class="pl-edit-label">Editing Prompt</div>
      <textarea class="pl-textarea" id="pl-edit-ta">${esc(displayPrompt.content)}</textarea>
      <div class="pl-edit-actions">
        <button class="btn btn-g btn-sm" onclick="cancelPromptEdit()">Cancel</button>
        <button class="btn btn-p btn-sm" onclick="savePromptEdit()">Save Prompt</button>
      </div>`;
  } else {
    mainHTML = `
      <div class="pl-view-header">
        <div class="pl-view-name">${esc(displayPrompt.name)}</div>
        ${isViewingHistory
          ? '<span class="pl-hist-badge">History</span>'
          : '<span class="pl-active-badge">Active</span>'}
      </div>
      <div class="pl-prompt-view" id="pl-prompt-view">${esc(displayPrompt.content)}</div>
      <div class="pl-edit-actions">
        ${isViewingHistory
          ? `<button class="btn btn-g btn-sm" onclick="selectHistoryPrompt(null)">← Back to Active</button>
             <button class="btn btn-p btn-sm" onclick="useHistoryPrompt('${displayPrompt.id}')">✓ Use This Prompt</button>`
          : `<button class="btn btn-g btn-sm" onclick="enterEditPrompt()">✏ Edit Prompt</button>`}
      </div>`;
  }

  plContent.innerHTML = `
    <div class="pl-layout">
      <div class="pl-main">
        <div class="pl-section-title">${isViewingHistory ? '📄 Viewing Historical Prompt' : '📝 Current Prompt'}</div>
        ${mainHTML}
      </div>
      <div class="pl-sidebar">
        <div class="pl-section-title">📚 History</div>
        <div class="pl-hist-list">${historyHTML}</div>
      </div>
    </div>`;

  // Focus textarea if in edit mode
  if (_isEditMode) {
    setTimeout(() => {
      const ta = document.getElementById('pl-edit-ta');
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }, 30);
  }
}

// ── ACTIONS ────────────────────────────────────────────────────────

function selectHistoryPrompt(id) {
  _viewingPromptId = id;
  _isEditMode = false;
  renderPromptLibrary();
}

function enterEditPrompt() {
  _isEditMode = true;
  renderPromptLibrary();
}

function cancelPromptEdit() {
  _isEditMode = false;
  renderPromptLibrary();
}

function savePromptEdit() {
  const ta = document.getElementById('pl-edit-ta');
  if (!ta) return;
  const newContent = ta.value.trim();
  if (!newContent) { toast('Prompt cannot be empty', 'i'); return; }

  const now = new Date();
  const label = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    + ' ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const newPrompt = {
    id: 'prompt-' + Date.now(),
    name: 'Custom Prompt — ' + label,
    content: newContent,
    created_at: now.toISOString(),
    is_active: true
  };

  _prompts.forEach(p => { p.is_active = false; });
  _prompts.push(newPrompt);
  _savePrompts();

  _isEditMode = false;
  _viewingPromptId = null;
  renderPromptLibrary();
  toast('Prompt saved and activated', 'ok');
  _autoRerunIfConvSelected();
}

function useHistoryPrompt(id) {
  const prompt = _prompts.find(p => p.id === id);
  if (!prompt) return;

  _prompts.forEach(p => { p.is_active = false; });
  prompt.is_active = true;
  _savePrompts();

  _viewingPromptId = null;
  renderPromptLibrary();
  toast(`"${prompt.name}" is now active`, 'ok');
  _autoRerunIfConvSelected();
}

// ── RUN ANALYZE MODAL ──────────────────────────────────────────────

let _raSelectedId = null;
let _raLastSelectedId = null; // persists after modal close — used for auto-rerun on prompt save
let _raCustomPromptContent = null; // set when launching from the View Prompt modal

function openRunAnalyzeModal(preSelectId) {
  const overlay = document.getElementById('run-analyze-overlay');
  if (!overlay) return;

  _raSelectedId = preSelectId || null;
  if (_raSelectedId) _raLastSelectedId = _raSelectedId;

  // Show active prompt name (or custom if launched from View Prompt modal)
  const nameEl = document.getElementById('ra-prompt-name');
  if (nameEl) nameEl.textContent = _raCustomPromptContent ? 'Custom (from View Prompt)' : (getActivePrompt().name || 'Default QA Prompt');

  // Reset result
  const resultEl = document.getElementById('ra-result');
  if (resultEl) { resultEl.style.display = 'none'; resultEl.innerHTML = ''; }

  // Populate conversation list first, then set button state
  _renderRaConvList();

  // If pre-selected, highlight and enable button
  if (_raSelectedId) {
    setTimeout(() => {
      document.querySelectorAll('.ra-conv-item').forEach(el => el.classList.remove('selected'));
      const item = document.getElementById('ra-item-' + _raSelectedId);
      if (item) item.classList.add('selected');
      const btn = document.getElementById('ra-run-btn');
      if (btn) { btn.textContent = '▶ Analyze'; btn.disabled = false; }
    }, 30);
  } else {
    const btn = document.getElementById('ra-run-btn');
    if (btn) { btn.textContent = '▶ Analyze'; btn.disabled = true; }
  }

  overlay.classList.add('open');
}

function _renderRaConvList() {
  const listEl = document.getElementById('ra-conv-list');
  if (!listEl) return;

  if (!conversations || conversations.length === 0) {
    listEl.innerHTML = '<div class="ra-empty">No conversations saved yet. Use "Add Conversation" to add one first.</div>';
    return;
  }

  const sorted = conversations.slice().sort((a, b) => new Date(b.analyzed_at) - new Date(a.analyzed_at));

  listEl.innerHTML = sorted.map(c => {
    const hasText = !!c.original_text;
    const date = c.analyzed_at ? fmtTime(c.analyzed_at) : '';
    const sentClass = getSentClass(c.sentiment);
    return `<div class="ra-conv-item${hasText ? '' : ' ra-no-transcript'}" id="ra-item-${c.id}"
                 onclick="${hasText ? `selectRaConv('${c.id}')` : ''}">
      <div class="ra-conv-top">
        <span class="conv-badge ${sentClass}">${esc(c.sentiment || 'Unknown')}</span>
        <span class="ra-conv-date">${date}</span>
      </div>
      <div class="ra-conv-title">${esc(c.title)}</div>
      ${!hasText ? '<div class="ra-no-transcript-note">No transcript — cannot re-analyze</div>' : ''}
    </div>`;
  }).join('');
}

function selectRaConv(id) {
  _raSelectedId = id;
  _raLastSelectedId = id;

  // Highlight selected
  document.querySelectorAll('.ra-conv-item').forEach(el => el.classList.remove('selected'));
  const item = document.getElementById('ra-item-' + id);
  if (item) item.classList.add('selected');

  // Enable button
  const btn = document.getElementById('ra-run-btn');
  if (btn) { btn.disabled = false; btn.textContent = '▶ Analyze'; }

  // Hide previous result
  const resultEl = document.getElementById('ra-result');
  if (resultEl) { resultEl.style.display = 'none'; resultEl.innerHTML = ''; }
}

function closeRunAnalyzeModal() {
  const overlay = document.getElementById('run-analyze-overlay');
  if (overlay) overlay.classList.remove('open');
  _raSelectedId = null;
  _raCustomPromptContent = null;
}

async function runPromptTest() {
  if (!_raSelectedId) { toast('Select a conversation first', 'i'); return; }

  const c = conversations.find(x => x.id === _raSelectedId);
  if (!c || !c.original_text) { toast('This conversation has no transcript to analyze', 'i'); return; }

  const btn = document.getElementById('ra-run-btn');
  if (btn) { btn.textContent = 'Analyzing…'; btn.disabled = true; }

  const resultEl = document.getElementById('ra-result');
  if (resultEl) { resultEl.style.display = 'none'; resultEl.innerHTML = ''; }

  try {
    const payload = { text: c.original_text, customSystemPrompt: _raCustomPromptContent || getActivePrompt().content };

    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const contentType = response.headers.get('content-type');
    const data = contentType?.includes('application/json') ? await response.json() : null;
    if (!response.ok || !data) throw new Error(data?.error || 'Analysis failed');

    if (resultEl) {
      resultEl.style.display = 'block';
      resultEl.innerHTML = buildTestResultHTML(c.title, data);
    }
  } catch (err) {
    toast(err.message, 'i');
  } finally {
    if (btn) { btn.textContent = '▶ Analyze Again'; btn.disabled = false; }
  }
}

function buildTestResultHTML(convTitle, d) {
  const severity = d.dissatisfaction_severity || '—';
  const severityColor = { Low: 'var(--green)', Medium: 'var(--amber)', High: 'var(--red)', Critical: 'var(--red)' }[severity] || 'var(--text2)';
  const resColor = d.resolution_status === 'Resolved' ? 'var(--green)' : d.resolution_status === 'Unresolved' ? 'var(--red)' : 'var(--amber)';

  const rows = [
    ['Summary',        esc(d.summary || '—')],
    ['Severity',       `<span style="color:${severityColor};font-weight:700">${esc(severity)}</span>`],
    ['Issue Category', esc(d.issue_category || '—')],
    ['Resolution',     `<span style="color:${resColor};font-weight:700">${esc(d.resolution_status || '—')}</span>`],
    ['Language',       esc(d.language || '—')],
    ['Agent Score',    d.agent_performance_score != null ? esc(String(d.agent_performance_score)) : 'N/A'],
    ['Agent Notes',    esc(d.agent_performance_notes || '—')],
    ['Key Quotes',     esc(d.key_quotes || '—')],
    ['Recommended',    esc(d.recommended_action || '—')],
    ['Alert',          d.is_alert_worthy ? `<span style="color:var(--red);font-weight:700">⚠ Yes — ${esc(d.alert_reason || '')}</span>` : '<span style="color:var(--green)">No</span>'],
  ].map(([label, val]) =>
    `<div class="ra-row"><span class="ra-lbl">${label}</span><span class="ra-val">${val}</span></div>`
  ).join('');

  return `<div class="ra-result-inner">
    <div class="ra-result-hdr">
      Result for: <em style="color:var(--text2);font-style:normal">${esc(convTitle)}</em>
      <span class="ra-result-note">not saved</span>
    </div>
    ${rows}
  </div>`;
}

// ── AUTO-RERUN ─────────────────────────────────────────────────────
// If the user saved/activated a prompt and had previously run analyze
// on a conversation, auto-open the modal and re-run with the new prompt.

function _autoRerunIfConvSelected() {
  if (!_raLastSelectedId) return;
  if (!conversations || !conversations.find(c => c.id === _raLastSelectedId)) return;

  // Small delay so the prompt-save toast is visible first
  setTimeout(() => {
    _raSelectedId = _raLastSelectedId;
    openRunAnalyzeModal();

    // Mark the conversation as selected in the list
    setTimeout(() => {
      document.querySelectorAll('.ra-conv-item').forEach(el => el.classList.remove('selected'));
      const item = document.getElementById('ra-item-' + _raSelectedId);
      if (item) item.classList.add('selected');

      const btn = document.getElementById('ra-run-btn');
      if (btn) btn.disabled = false;

      // Auto-run
      runPromptTest();
    }, 80);
  }, 400);
}

// ── PROMPT QUICK MODAL (from Conversation Analysis) ────────────────

let _promptModalSelectedId = null;  // id of prompt selected in the modal dropdown
let _promptModalRunSelected = false; // true when opened from "Run QA on Selected"
let _promptModalConvId = null;       // single conv id when opened from a conversation card

function openPromptModal(opts) {
  const overlay = document.getElementById('prompt-modal-overlay');
  const ta = document.getElementById('prompt-modal-ta');
  if (!overlay || !ta) return;

  _promptModalRunSelected = !!(opts && opts.runSelected);
  _promptModalConvId      = (opts && opts.convId) || null;

  const active = getActivePrompt();
  _promptModalSelectedId = active.id;

  _populatePromptModalSelect();
  ta.value = active.content;

  // Update title and analyze button based on context
  const titleEl = overlay.querySelector('.add-title');
  const analyzeBtn = document.getElementById('prompt-modal-analyze-btn');

  if (_promptModalRunSelected) {
    const count = typeof _selectedConvIds !== 'undefined' ? _selectedConvIds.size : 0;
    if (titleEl) titleEl.textContent = '📝 Select Prompt & Analyze';
    if (analyzeBtn) analyzeBtn.textContent = `▶ Analyze Selected (${count})`;
  } else if (_promptModalConvId) {
    if (titleEl) titleEl.textContent = '📝 View / Edit Prompt';
    if (analyzeBtn) analyzeBtn.textContent = '▶ Analyze this Conversation';
  } else {
    if (titleEl) titleEl.textContent = '📝 View / Edit Prompt';
    if (analyzeBtn) analyzeBtn.textContent = '▶ Analyze with this Prompt';
  }

  overlay.classList.add('open');
  setTimeout(() => ta.focus(), 60);
}

function _populatePromptModalSelect() {
  const sel = document.getElementById('prompt-modal-select');
  const badge = document.getElementById('prompt-modal-active-badge');
  if (!sel) return;

  const sorted = _prompts.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  sel.innerHTML = sorted.map(p => {
    const label = p.is_active ? `✓ ${p.name} (Active)` : p.name;
    return `<option value="${p.id}"${p.id === _promptModalSelectedId ? ' selected' : ''}>${label}</option>`;
  }).join('');

  if (badge) {
    const sel_prompt = _prompts.find(p => p.id === _promptModalSelectedId);
    badge.textContent = sel_prompt?.is_active ? 'Active' : 'History';
    badge.style.color = sel_prompt?.is_active ? 'var(--green)' : 'var(--accent)';
    badge.style.background = sel_prompt?.is_active ? 'rgba(34,197,94,.1)' : 'rgba(79,142,247,.12)';
    badge.style.borderColor = sel_prompt?.is_active ? 'rgba(34,197,94,.2)' : 'rgba(79,142,247,.25)';
  }
}

function promptModalSelectChange() {
  const sel = document.getElementById('prompt-modal-select');
  const ta = document.getElementById('prompt-modal-ta');
  if (!sel || !ta) return;

  _promptModalSelectedId = sel.value;
  const chosen = _prompts.find(p => p.id === sel.value);
  if (chosen) ta.value = chosen.content;

  const badge = document.getElementById('prompt-modal-active-badge');
  if (badge) {
    badge.textContent = chosen?.is_active ? 'Active' : 'History';
    badge.style.color = chosen?.is_active ? 'var(--green)' : 'var(--accent)';
    badge.style.background = chosen?.is_active ? 'rgba(34,197,94,.1)' : 'rgba(79,142,247,.12)';
    badge.style.borderColor = chosen?.is_active ? 'rgba(34,197,94,.2)' : 'rgba(79,142,247,.25)';
  }
}

function _saveAndActivatePrompt(content) {
  if (!content || !content.trim()) return false;

  const now = new Date();
  const label = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    + ' ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const newPrompt = {
    id: 'prompt-' + Date.now(),
    name: 'Custom Prompt — ' + label,
    content: content.trim(),
    created_at: now.toISOString(),
    is_active: true
  };

  _prompts.forEach(p => { p.is_active = false; });
  _prompts.push(newPrompt);
  _savePrompts();

  return true;
}

function runQAFromPromptModal() {
  const ta = document.getElementById('prompt-modal-ta');
  if (!ta) return;
  const content = ta.value.trim();
  if (!content) { toast('Prompt cannot be empty', 'i'); return; }

  if (_promptModalRunSelected && typeof runAnalysisOnSelectedConvs === 'function') {
    // Launched from "Run QA on Selected" — close modal and bulk-analyze
    closePromptModal();
    runAnalysisOnSelectedConvs(content);
    return;
  }

  if (_promptModalConvId && typeof runAnalysisOnConv === 'function') {
    // Launched from a conversation card — close modal and analyze that one conversation
    const cid = _promptModalConvId;
    closePromptModal();
    runAnalysisOnConv(cid, content);
    return;
  }

  // Default: open run-analyze modal to pick a single conversation
  _raCustomPromptContent = content;
  closePromptModal();
  openRunAnalyzeModal();
}

function closePromptModal() {
  const overlay = document.getElementById('prompt-modal-overlay');
  if (overlay) overlay.classList.remove('open');
  _promptModalRunSelected = false;
  _promptModalConvId = null;
}

function savePromptModal() {
  const ta = document.getElementById('prompt-modal-ta');
  if (!ta) return;
  const newContent = ta.value.trim();
  if (!newContent) { toast('Prompt cannot be empty', 'i'); return; }

  const now = new Date();
  const label = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    + ' ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const newPrompt = {
    id: 'prompt-' + Date.now(),
    name: 'Custom Prompt — ' + label,
    content: newContent,
    created_at: now.toISOString(),
    is_active: true
  };

  _prompts.forEach(p => { p.is_active = false; });
  _prompts.push(newPrompt);
  _savePrompts();
  renderPromptLibrary();

  closePromptModal();
  toast('Prompt saved and activated', 'ok');
}

// ── NAVIGATION ─────────────────────────────────────────────────────

function showPromptLibrary(navEl) {
  document.querySelectorAll('.stage-blk').forEach(el => el.classList.remove('active'));
  const target = document.getElementById('stage-prompts');
  if (target) target.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const t = navEl || document.querySelector('.nav-item[data-stage="prompts"]');
  if (t) t.classList.add('active');
  renderPromptLibrary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (window.innerWidth <= 768) closeSidebar();
}
