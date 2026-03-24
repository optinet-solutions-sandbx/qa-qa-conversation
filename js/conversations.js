// ── CONVERSATION ANALYSIS SECTION ─────────────────────────────────

let _selectedConvIds = new Set();
let _detailConvId = null;

// ── LIST VIEW ──────────────────────────────────────────────────────

function renderConversations() {
  if (_detailConvId) {
    _renderConvDetail(_detailConvId);
    return;
  }
  _renderConvList();
}

function _renderConvList() {
  const container = document.getElementById('conv-list');
  if (!container) return;
  container.innerHTML = '';

  const pill = document.getElementById('pill-conversations');

  if (conversations.length === 0) {
    container.innerHTML = '<div class="conv-empty">No conversations analyzed yet. Use "Add Conversation" to analyze your first conversation.</div>';
    if (pill) { pill.textContent = '0'; pill.className = 'npill'; }
    return;
  }

  // Select-all bar
  const bar = document.createElement('div');
  bar.className = 'conv-select-bar';
  bar.id = 'conv-select-bar';
  bar.innerHTML = `
    <label class="conv-select-all-label">
      <input type="checkbox" id="conv-select-all" onchange="toggleSelectAll(this.checked)"/>
      <span>Select All</span>
    </label>
    <button class="btn btn-p btn-sm conv-bulk-btn" id="conv-bulk-btn" onclick="runQAOnSelected()" style="display:none">▶ Run QA on Selected</button>`;
  container.appendChild(bar);

  const sorted = conversations.slice().sort((a, b) => new Date(b.analyzed_at) - new Date(a.analyzed_at));
  sorted.forEach(c => container.appendChild(buildConvCard(c)));

  if (pill) { pill.textContent = conversations.length; pill.className = 'npill part'; }
}

function buildConvCard(c) {
  const sentClass = getSentClass(c.sentiment);
  const date = c.analyzed_at ? fmtTime(c.analyzed_at) : '';
  const isChecked = _selectedConvIds.has(c.id);

  const row = document.createElement('div');
  row.className = 'conv-card-row';
  row.id = 'conv-row-' + c.id;

  row.innerHTML = `
    <label class="conv-check-wrap" onclick="event.stopPropagation()">
      <input type="checkbox" class="conv-check" id="check-${c.id}"
             ${isChecked ? 'checked' : ''}
             onchange="toggleConvSelect('${c.id}', this.checked)"
             onclick="event.stopPropagation()"/>
    </label>
    <div class="conv-card" id="conv-${c.id}" onclick="openConvDetail('${c.id}')">
      <div class="conv-card-top">
        <div class="conv-card-meta">
          <span class="conv-badge ${sentClass}">${esc(c.sentiment || 'Unknown')}</span>
          <span class="conv-intent">${esc(c.intent || 'N/A')}</span>
          ${c.intercom_id ? `<span class="conv-id">ID: ${esc(c.intercom_id)}</span>` : ''}
        </div>
        <span class="conv-ts">${date}</span>
      </div>
      <div class="conv-title">${esc(c.title)}</div>
      <div class="conv-summary">${esc(c.summary || '')}</div>
      <div class="conv-card-footer">
        <span class="conv-view-hint">${c.original_text ? '📄 Click to view & analyze' : '📄 Click to view'}</span>
        <button class="conv-del-btn" onclick="event.stopPropagation();deleteConversation('${c.id}')">🗑 Delete</button>
      </div>
    </div>`;

  return row;
}

// ── CHECKBOX SELECTION ─────────────────────────────────────────────

function toggleSelectAll(checked) {
  _selectedConvIds.clear();
  if (checked) {
    conversations.forEach(c => _selectedConvIds.add(c.id));
  }
  document.querySelectorAll('.conv-check').forEach(cb => { cb.checked = checked; });
  _updateBulkBar();
}

function toggleConvSelect(cid, checked) {
  if (checked) { _selectedConvIds.add(cid); } else { _selectedConvIds.delete(cid); }
  // Sync select-all checkbox
  const allCb = document.getElementById('conv-select-all');
  if (allCb) allCb.checked = _selectedConvIds.size === conversations.length;
  _updateBulkBar();
}

function _updateBulkBar() {
  const btn = document.getElementById('conv-bulk-btn');
  if (!btn) return;
  if (_selectedConvIds.size > 0) {
    btn.style.display = '';
    btn.textContent = `▶ Run QA on Selected (${_selectedConvIds.size})`;
  } else {
    btn.style.display = 'none';
  }
}

async function runAnalysisOnConv(cid, promptContent) {
  const c = conversations.find(x => x.id === cid);
  if (!c || !c.original_text) { toast('No transcript available to analyze', 'i'); return; }

  toast('Analyzing…', 'i');
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: c.original_text, customSystemPrompt: promptContent })
    });
    const ct = response.headers.get('content-type');
    const data = ct?.includes('application/json') ? await response.json() : null;
    if (!response.ok || !data) throw new Error(data?.error || 'Analysis failed');

    const prev = { sentiment: c.sentiment, intent: c.intent };
    c.sentiment                = data.sentiment                || c.sentiment;
    c.intent                   = data.intent                   || c.intent;
    c.summary                  = data.summary                  || c.summary;
    c.dissatisfaction_severity = data.dissatisfaction_severity || c.dissatisfaction_severity;
    c.issue_category           = data.issue_category           || c.issue_category;
    c.resolution_status        = data.resolution_status        || c.resolution_status;
    c.language                 = data.language                 || c.language;
    c.agent_performance_score  = data.agent_performance_score  ?? c.agent_performance_score;
    c.agent_performance_notes  = data.agent_performance_notes  || c.agent_performance_notes;
    c.key_quotes               = data.key_quotes               || c.key_quotes;
    c.recommended_action       = data.recommended_action       || c.recommended_action;
    c.is_alert_worthy          = data.is_alert_worthy          ?? c.is_alert_worthy;
    c.alert_reason             = data.alert_reason             || c.alert_reason;
    c.analyzed_at              = new Date().toISOString();

    if (!c.notes) c.notes = [];
    c.notes.push({
      author: 'System',
      text: `Re-analyzed via View Prompt. Sentiment: ${prev.sentiment} → ${c.sentiment}`,
      ts: new Date().toISOString(),
      system: true
    });

    save();
    dbUpdateConversation(c);
    renderConversations();
    renderOverview();
    toast('Analysis updated ✨', 'ok');
  } catch (err) {
    toast(err.message, 'i');
  }
}

function runQAOnSelected() {
  if (_selectedConvIds.size === 0) return;
  // Open the prompt modal directly — user picks/edits the prompt, then clicks Analyze
  if (typeof openPromptModal === 'function') {
    openPromptModal({ runSelected: true });
  }
}

async function runAnalysisOnSelectedConvs(promptContent) {
  const ids = [..._selectedConvIds];
  if (ids.length === 0) return;

  const eligible = ids.filter(cid => {
    const c = conversations.find(x => x.id === cid);
    return c && c.original_text;
  });

  if (eligible.length === 0) {
    toast('None of the selected conversations have a transcript to analyze', 'i');
    return;
  }

  toast(`Analyzing ${eligible.length} conversation${eligible.length > 1 ? 's' : ''}…`, 'i');

  let completed = 0;
  for (const cid of eligible) {
    const c = conversations.find(x => x.id === cid);
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: c.original_text, customSystemPrompt: promptContent })
      });
      const ct = response.headers.get('content-type');
      const data = ct?.includes('application/json') ? await response.json() : null;
      if (!response.ok || !data) throw new Error(data?.error || 'Analysis failed');

      const prev = { sentiment: c.sentiment, intent: c.intent };
      c.sentiment                = data.sentiment                || c.sentiment;
      c.intent                   = data.intent                   || c.intent;
      c.summary                  = data.summary                  || c.summary;
      c.dissatisfaction_severity = data.dissatisfaction_severity || c.dissatisfaction_severity;
      c.issue_category           = data.issue_category           || c.issue_category;
      c.resolution_status        = data.resolution_status        || c.resolution_status;
      c.language                 = data.language                 || c.language;
      c.agent_performance_score  = data.agent_performance_score  ?? c.agent_performance_score;
      c.agent_performance_notes  = data.agent_performance_notes  || c.agent_performance_notes;
      c.key_quotes               = data.key_quotes               || c.key_quotes;
      c.recommended_action       = data.recommended_action       || c.recommended_action;
      c.is_alert_worthy          = data.is_alert_worthy          ?? c.is_alert_worthy;
      c.alert_reason             = data.alert_reason             || c.alert_reason;
      c.analyzed_at              = new Date().toISOString();

      if (!c.notes) c.notes = [];
      c.notes.push({
        author: 'System',
        text: `Bulk re-analyzed. Sentiment: ${prev.sentiment} → ${c.sentiment}`,
        ts: new Date().toISOString(),
        system: true
      });

      dbUpdateConversation(c);
      completed++;
    } catch (err) {
      console.error('[runAnalysisOnSelectedConvs] failed for', cid, err.message);
    }
  }

  save();
  _selectedConvIds.clear();
  renderConversations();
  renderOverview();
  toast(`${completed} of ${eligible.length} conversation${eligible.length > 1 ? 's' : ''} analyzed ✨`, 'ok');
}

// ── DETAIL VIEW ────────────────────────────────────────────────────

function openConvDetail(cid) {
  _detailConvId = cid;
  _renderConvDetail(cid);
  // Hide header Run QA button while in detail
  const hdrBtn = document.getElementById('conv-run-qa-btn');
  if (hdrBtn) hdrBtn.style.display = 'none';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function backToConversations() {
  _detailConvId = null;
  _renderConvList();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function _renderConvDetail(cid) {
  const c = conversations.find(x => x.id === cid);
  const container = document.getElementById('conv-list');
  if (!c || !container) return;

  const sentClass = getSentClass(c.sentiment);

  container.innerHTML = `
    <div class="conv-detail">
      <div class="conv-detail-bar">
        <button class="btn btn-g btn-sm" onclick="backToConversations()">← Back to Conversations</button>
        <div class="conv-detail-title">
          <span class="conv-badge ${sentClass}" style="font-size:11px">${esc(c.sentiment || 'Unknown')}</span>
          ${esc(c.title)}
        </div>
      </div>
      <div class="conv-detail-cols">

        <!-- Column 1: Conversation -->
        <div class="conv-detail-col">
          <div class="conv-col-hdr">
            <span>Conversation</span>
          </div>
          <div class="conv-col-body conv-transcript-body">
            ${c.original_text
              ? `<pre class="conv-detail-transcript">${esc(c.original_text)}</pre>`
              : '<div class="conv-no-transcript">No transcript available for this conversation.</div>'}
          </div>
        </div>

        <!-- Column 2: Analysis -->
        <div class="conv-detail-col">
          <div class="conv-col-hdr">
            <span>Analysis</span>
            <button class="conv-run-again-btn" id="run-again-btn-${cid}"
                    onclick="runAgainForConv('${cid}')"
                    ${!c.original_text ? 'disabled title="No transcript available"' : ''}>
              ▶ Run Again
            </button>
          </div>
          <div class="conv-col-body" id="conv-analysis-col-${cid}">
            ${_buildAnalysisHTML(c)}
          </div>
        </div>

        <!-- Column 3: Comments -->
        <div class="conv-detail-col">
          <div class="conv-col-hdr">
            <span>Comments</span>
          </div>
          <div class="conv-col-body conv-comments-col">
            <div class="conv-add-comment-row">
              <input class="conv-comment-input" id="detail-comment-input-${cid}"
                     placeholder="Add a comment…"
                     onkeydown="detailCommentKey(event,'${cid}')"/>
              <button class="conv-note-btn" onclick="addDetailComment('${cid}')">Add</button>
            </div>
            <div class="conv-comments-list" id="detail-comments-${cid}">
              ${_buildCommentsList(c)}
            </div>
          </div>
        </div>

      </div>
    </div>`;
}

function _buildAnalysisHTML(c) {
  if (!c.sentiment && !c.summary) {
    return '<div class="conv-no-analysis">No analysis data yet. Click Run Again to analyze.</div>';
  }

  const severity = c.dissatisfaction_severity || '—';
  const severityColor = { Low: 'var(--green)', Medium: 'var(--amber)', High: 'var(--red)', Critical: 'var(--red)' }[severity] || 'var(--text2)';
  const resColor = c.resolution_status === 'Resolved' ? 'var(--green)' : c.resolution_status === 'Unresolved' ? 'var(--red)' : 'var(--amber)';
  const date = c.analyzed_at ? fmtTime(c.analyzed_at) : '';

  const rows = [
    ['Analyzed',       `<span style="color:var(--text3)">${date}</span>`],
    ['Summary',        esc(c.summary || '—')],
    ['Severity',       severity !== '—' ? `<span style="color:${severityColor};font-weight:700">${esc(severity)}</span>` : '—'],
    ['Issue Category', esc(c.issue_category || c.intent || '—')],
    ['Resolution',     c.resolution_status ? `<span style="color:${resColor};font-weight:700">${esc(c.resolution_status)}</span>` : '—'],
    ['Language',       esc(c.language || '—')],
    ['Agent Score',    c.agent_performance_score != null ? esc(String(c.agent_performance_score)) : '—'],
    ['Agent Notes',    esc(c.agent_performance_notes || '—')],
    ['Key Quotes',     esc(c.key_quotes || '—')],
    ['Recommended',    esc(c.recommended_action || '—')],
    ['Alert',          c.is_alert_worthy ? `<span style="color:var(--red);font-weight:700">⚠ Yes — ${esc(c.alert_reason || '')}</span>` : c.is_alert_worthy === false ? '<span style="color:var(--green)">No</span>' : '—'],
  ].map(([label, val]) =>
    `<div class="conv-analysis-row"><span class="conv-analysis-lbl">${label}</span><span class="conv-analysis-val">${val}</span></div>`
  ).join('');

  return `<div class="conv-analysis-rows">${rows}</div>`;
}

function _buildCommentsList(c) {
  if (!c.notes || c.notes.length === 0) {
    return '<div class="conv-no-notes">No comments yet.</div>';
  }
  return c.notes.map(n => {
    const t = n.ts ? fmtTime(n.ts) : '';
    const cls = n.system ? 'conv-note system-note' : 'conv-note';
    return `<div class="${cls}">
      <div class="conv-note-meta">
        <span class="conv-note-author">${esc(n.author || 'Team')}</span>
        <span class="conv-note-ts">${t}</span>
      </div>
      <div class="conv-note-text">${esc(n.text)}</div>
    </div>`;
  }).join('');
}

// ── RUN AGAIN ──────────────────────────────────────────────────────

async function runAgainForConv(cid) {
  const c = conversations.find(x => x.id === cid);
  if (!c || !c.original_text) { toast('No transcript available to analyze', 'i'); return; }

  const btn = document.getElementById('run-again-btn-' + cid);
  if (btn) { btn.textContent = 'Analyzing…'; btn.disabled = true; }

  const analysisCol = document.getElementById('conv-analysis-col-' + cid);
  if (analysisCol) analysisCol.innerHTML = '<div class="conv-analyzing-msg">⏳ Analyzing…</div>';

  try {
    const payload = { text: c.original_text };
    if (typeof getActivePromptContent === 'function') payload.customSystemPrompt = getActivePromptContent();

    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const contentType = response.headers.get('content-type');
    const data = contentType?.includes('application/json') ? await response.json() : null;
    if (!response.ok || !data) throw new Error(data?.error || 'Analysis failed');

    // Update conversation object with full analysis data
    const prev = { sentiment: c.sentiment, intent: c.intent };
    c.sentiment              = data.sentiment              || c.sentiment;
    c.intent                 = data.intent                 || c.intent;
    c.summary                = data.summary                || c.summary;
    c.dissatisfaction_severity = data.dissatisfaction_severity || c.dissatisfaction_severity;
    c.issue_category         = data.issue_category         || c.issue_category;
    c.resolution_status      = data.resolution_status      || c.resolution_status;
    c.language               = data.language               || c.language;
    c.agent_performance_score  = data.agent_performance_score  ?? c.agent_performance_score;
    c.agent_performance_notes  = data.agent_performance_notes  || c.agent_performance_notes;
    c.key_quotes             = data.key_quotes             || c.key_quotes;
    c.recommended_action     = data.recommended_action     || c.recommended_action;
    c.is_alert_worthy        = data.is_alert_worthy        ?? c.is_alert_worthy;
    c.alert_reason           = data.alert_reason           || c.alert_reason;
    c.analyzed_at            = new Date().toISOString();

    if (!c.notes) c.notes = [];
    const sysNote = {
      author: 'System',
      text: `Re-analyzed. Sentiment: ${prev.sentiment} → ${c.sentiment} | Intent: ${prev.intent} → ${c.intent}`,
      ts: new Date().toISOString(),
      system: true
    };
    c.notes.push(sysNote);

    save();
    dbUpdateConversation(c);
    dbInsertConversationNote(cid, sysNote);

    // Re-render analysis column and comments
    if (analysisCol) analysisCol.innerHTML = _buildAnalysisHTML(c);
    const commentsList = document.getElementById('detail-comments-' + cid);
    if (commentsList) commentsList.innerHTML = _buildCommentsList(c);

    toast('Analysis updated ✨', 'ok');
  } catch (err) {
    toast(err.message, 'i');
    if (analysisCol) analysisCol.innerHTML = _buildAnalysisHTML(c);
  } finally {
    if (btn) { btn.textContent = '▶ Run Again'; btn.disabled = false; }
  }
}

// ── COMMENTS (DETAIL VIEW) ─────────────────────────────────────────

function detailCommentKey(e, cid) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addDetailComment(cid); }
}

function addDetailComment(cid) {
  const input = document.getElementById('detail-comment-input-' + cid);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const c = conversations.find(x => x.id === cid);
  if (!c) return;
  if (!c.notes) c.notes = [];

  const author = localStorage.getItem('qa_user') || 'Team';
  const note = { author, text, ts: new Date().toISOString() };
  c.notes.push(note);
  save();
  dbInsertConversationNote(cid, note);

  const list = document.getElementById('detail-comments-' + cid);
  if (list) list.innerHTML = _buildCommentsList(c);
  input.value = '';
  toast('Comment added', 'ok');
}

// ── HELPERS ────────────────────────────────────────────────────────

function getSentClass(s) {
  if (!s) return 'sent-neu';
  const l = s.toLowerCase();
  if (l.includes('pos')) return 'sent-pos';
  if (l.includes('neg')) return 'sent-neg';
  return 'sent-neu';
}

function addConvNote(cid) { addDetailComment(cid); } // backward compat

function deleteConversation(cid) {
  const c = conversations.find(x => x.id === cid);
  if (!c) return;
  if (!confirm(`Delete this conversation?\n\n"${c.title.slice(0, 80)}"\n\nThis cannot be undone.`)) return;
  conversations = conversations.filter(x => x.id !== cid);
  _selectedConvIds.delete(cid);
  if (_detailConvId === cid) _detailConvId = null;
  save();
  dbDeleteConversation(cid);
  renderConversations();
  renderOverview();
  toast('Conversation deleted', 'i');
}

// ── NAVIGATION ─────────────────────────────────────────────────────

function showConversations(navEl) {
  _detailConvId = null;
  document.querySelectorAll('.stage-blk').forEach(el => el.classList.remove('active'));
  const target = document.getElementById('stage-conversations');
  if (target) target.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const t = navEl || document.querySelector('.nav-item[data-stage="conversations"]');
  if (t) t.classList.add('active');
  renderConversations();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (window.innerWidth <= 768) closeSidebar();
}
