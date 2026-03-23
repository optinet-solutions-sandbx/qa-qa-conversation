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
    ${c.original_text ? `
    <div class="conv-transcript-toggle" onclick="toggleTranscript('${c.id}')">
      <span id="conv-tog-lbl-${c.id}">▶ View Conversation</span>
    </div>
    <div class="conv-transcript" id="conv-transcript-${c.id}">${esc(c.original_text)}</div>` : ''}
    <div class="conv-notes-section">
      <div class="conv-notes-hdr">💬 Team Notes <span class="conv-note-count" id="conv-nc-${c.id}">${c.notes && c.notes.length > 0 ? '(' + c.notes.length + ')' : ''}</span></div>
      <div class="conv-notes-list" id="notes-list-${c.id}">${buildNotesList(c)}</div>
      <div class="conv-note-input-row">
        <input class="conv-note-input" id="note-input-${c.id}"
               placeholder="Add a team note… (Enter to send)"
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
    const cls = n.system ? 'conv-note system-note' : 'conv-note';
    return `<div class="${cls}">
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

function toggleTranscript(cid) {
  const el = document.getElementById('conv-transcript-' + cid);
  const lbl = document.getElementById('conv-tog-lbl-' + cid);
  if (!el) return;
  const open = el.classList.toggle('open');
  if (lbl) lbl.textContent = open ? '▼ Hide Conversation' : '▶ View Conversation';
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
  const note = { author, text, ts: new Date().toISOString() };
  c.notes.push(note);
  save();
  dbInsertConversationNote(cid, note);

  const notesList = document.getElementById('notes-list-' + cid);
  if (notesList) notesList.innerHTML = buildNotesList(c);

  const nc = document.getElementById('conv-nc-' + cid);
  if (nc) nc.textContent = '(' + c.notes.length + ')';

  input.value = '';
  toast('Note added', 'ok');
}

async function reanalyzeConversation(cid) {
  const c = conversations.find(x => x.id === cid);
  if (!c) return;

  const btn = document.getElementById('reanalyze-btn-' + cid);
  if (btn) { btn.textContent = 'Analyzing…'; btn.disabled = true; }

  try {
    const notesText = c.notes
      .filter(n => !n.system)
      .map(n => `- ${n.author}: ${n.text}`)
      .join('\n');

    let textToSend;
    if (c.original_text) {
      textToSend = `${c.original_text}\n\n=== TEAM NOTES FOR IMPROVED ANALYSIS ===\n${notesText}\n\nPlease re-analyze the conversation above, taking the team notes into account to produce an improved sentiment, intent, and summary.`;
    } else if (c.intercom_id) {
      textToSend = `Previous analysis of Intercom conversation ${c.intercom_id}:\nSentiment: ${c.sentiment}\nIntent: ${c.intent}\nSummary: ${c.summary}\n\n=== TEAM NOTES FOR IMPROVED ANALYSIS ===\n${notesText}\n\nBased on the team's feedback, provide an improved sentiment, intent, and summary.`;
    } else {
      textToSend = `Previous analysis:\nSentiment: ${c.sentiment}\nIntent: ${c.intent}\nSummary: ${c.summary}\n\n=== TEAM NOTES FOR IMPROVED ANALYSIS ===\n${notesText}\n\nBased on the team's feedback, provide an improved sentiment, intent, and summary.`;
    }

    const payload = { text: textToSend };
    if (typeof getActivePromptContent === 'function') {
      payload.customSystemPrompt = getActivePromptContent();
    }

    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const contentType = response.headers.get('content-type');
    const data = contentType?.includes('application/json') ? await response.json() : null;
    if (!response.ok || !data) throw new Error(data?.error || 'Re-analysis failed');

    const prevSentiment = c.sentiment;
    const prevIntent = c.intent;

    c.sentiment = data.sentiment || c.sentiment;
    c.intent    = data.intent    || c.intent;
    c.summary   = data.summary   || c.summary;
    c.analyzed_at = new Date().toISOString();
    c.notes.push({
      author: 'System',
      text: `Re-analyzed. Sentiment: ${prevSentiment} → ${c.sentiment} | Intent: ${prevIntent} → ${c.intent}`,
      ts: new Date().toISOString(),
      system: true
    });

    save();
    dbUpdateConversation(c);
    const systemNote = c.notes[c.notes.length - 1];
    dbInsertConversationNote(cid, systemNote);

    const cardEl = document.getElementById('conv-' + cid);
    if (cardEl) cardEl.replaceWith(buildConvCard(c));

    toast('Re-analysis complete ✨', 'ok');
  } catch (err) {
    toast(err.message, 'i');
    if (btn) { btn.textContent = '✨ Re-analyze with Notes'; btn.disabled = false; }
  }
}

function deleteConversation(cid) {
  const c = conversations.find(x => x.id === cid);
  if (!c) return;
  if (!confirm(`Delete this conversation analysis?\n\n"${c.title.slice(0, 80)}"\n\nThis cannot be undone.`)) return;
  conversations = conversations.filter(x => x.id !== cid);
  save();
  dbDeleteConversation(cid);
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
