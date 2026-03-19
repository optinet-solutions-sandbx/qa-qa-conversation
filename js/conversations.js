// ── CONVERSATION ANALYSIS SECTION ─────────────────────────────────

function renderConversations() {
  const container = document.getElementById('conv-list');
  if (!container) return;
  container.innerHTML = '';

  if (conversations.length === 0) {
    container.innerHTML = '<div class="conv-empty">No conversations analyzed yet. Use "Add Conversation" to analyze your first conversation.</div>';
    const pill = document.getElementById('pill-conversations');
    if (pill) { pill.textContent = '0'; pill.className = 'npill'; }
    return;
  }

  const sorted = conversations.slice().sort((a, b) => new Date(b.analyzed_at) - new Date(a.analyzed_at));
  sorted.forEach(c => container.appendChild(buildConvCard(c)));

  const pill = document.getElementById('pill-conversations');
  if (pill) {
    pill.textContent = conversations.length;
    pill.className = 'npill part';
  }
}

function buildConvCard(c) {
  const sentClass = getSentClass(c.sentiment);
  const date = c.analyzed_at ? fmtTime(c.analyzed_at) : '';

  const wrap = document.createElement('div');
  wrap.className = 'conv-card';
  wrap.id = 'conv-' + c.id;

  wrap.innerHTML = `
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
    <div class="conv-notes-section">
      <div class="conv-notes-hdr">💬 Team Notes <span class="conv-note-count" id="conv-nc-${c.id}">${c.notes && c.notes.length > 0 ? '(' + c.notes.length + ')' : ''}</span></div>
      <div class="conv-notes-list" id="notes-list-${c.id}">${buildNotesList(c)}</div>
      <div class="conv-note-input-row">
        <input class="conv-note-input" id="note-input-${c.id}"
               placeholder="Add a note to improve future analysis… (Enter to send)"
               onkeydown="convNoteKey(event,'${c.id}')"/>
        <button class="conv-note-btn" onclick="addConvNote('${c.id}')">Add</button>
      </div>
    </div>
    <div class="conv-card-footer">
      <button class="conv-del-btn" onclick="deleteConversation('${c.id}')">🗑 Delete</button>
    </div>`;

  return wrap;
}

function buildNotesList(c) {
  if (!c.notes || c.notes.length === 0) {
    return '<div class="conv-no-notes">No notes yet — add a note to help improve future analysis.</div>';
  }
  return c.notes.map(n => {
    const t = n.ts ? fmtTime(n.ts) : '';
    return `<div class="conv-note">
      <div class="conv-note-meta"><span class="conv-note-author">${esc(n.author || 'Team')}</span><span class="conv-note-ts">${t}</span></div>
      <div class="conv-note-text">${esc(n.text)}</div>
    </div>`;
  }).join('');
}

function getSentClass(s) {
  if (!s) return 'sent-neu';
  const l = s.toLowerCase();
  if (l.includes('pos')) return 'sent-pos';
  if (l.includes('neg')) return 'sent-neg';
  return 'sent-neu';
}

function convNoteKey(e, cid) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    addConvNote(cid);
  }
}

function addConvNote(cid) {
  const input = document.getElementById('note-input-' + cid);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const c = conversations.find(x => x.id === cid);
  if (!c) return;
  if (!c.notes) c.notes = [];

  const author = localStorage.getItem('qa_user') || 'Team';
  c.notes.push({ author, text, ts: new Date().toISOString() });
  save();

  const notesList = document.getElementById('notes-list-' + cid);
  if (notesList) notesList.innerHTML = buildNotesList(c);

  const nc = document.getElementById('conv-nc-' + cid);
  if (nc) nc.textContent = '(' + c.notes.length + ')';

  input.value = '';
  toast('Note added', 'ok');
}

function deleteConversation(cid) {
  const c = conversations.find(x => x.id === cid);
  if (!c) return;
  if (!confirm(`Delete this conversation analysis?\n\n"${c.title.slice(0, 80)}"\n\nThis cannot be undone.`)) return;
  conversations = conversations.filter(x => x.id !== cid);
  save();
  renderConversations();
  renderOverview();
  toast('Conversation deleted', 'i');
}

function showConversations(navEl) {
  document.querySelectorAll('.stage-blk').forEach(el => el.classList.remove('active'));
  const target = document.getElementById('stage-conversations');
  if (target) target.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const t = navEl || document.querySelector('.nav-item[data-stage="conversations"]');
  if (t) t.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (window.innerWidth <= 768) closeSidebar();
}
