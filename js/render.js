// ── RENDER SIDEBAR NAV ────────────────────────────────────────────

function renderSidebar() {
  const aside = document.getElementById('sidebar-nav');
  aside.innerHTML = '';
  stages.forEach(st => {
    const sq = questions.filter(q => q.stage === st.id);
    const done = sq.filter(q => q.resolved).length;
    const nav = document.createElement('div');
    nav.className = 'nav-item';
    nav.dataset.stage = st.id;
    nav.onclick = function () { showStage(st.id, this); };
    nav.innerHTML = `
      <div class="nav-l"><div class="nav-ic">${st.emoji}</div><span class="nav-label">${esc(st.label)}</span></div>
      <span class="npill" id="pill-${st.id}">${done}/${sq.length}</span>`;
    aside.appendChild(nav);
  });

  // Add Stage button
  const addBtn = document.createElement('div');
  addBtn.className = 'nav-add-stage';
  addBtn.onclick = openStageModal;
  addBtn.innerHTML = `<span style="font-size:16px;line-height:1">＋</span> Add Section`;
  aside.appendChild(addBtn);

  updatePills();
}

// ── RENDER STAGE BLOCKS ───────────────────────────────────────────

function renderStageBlocks() {
  const main = document.getElementById('main-stages');
  main.innerHTML = '';
  stages.forEach((st, i) => {
    const sq = questions.filter(q => q.stage === st.id);
    const div = document.createElement('div');
    div.className = 'stage-blk';
    div.id = 'stage-' + st.id;
    div.innerHTML = `
      <div class="stage-hdr">
        <div>
          <div class="s-ey">${esc(st.emoji)} Section ${i + 1}</div>
          <div class="s-ti">${esc(st.label)}</div>
          <div class="s-sub">${sq.length} question${sq.length !== 1 ? 's' : ''} — click any to open the conversation thread</div>
        </div>
        <button class="btn-del-stage" onclick="deleteStage('${st.id}')" title="Delete section">🗑 Delete Section</button>
      </div>
      <div class="s-prog">
        <span class="spt"><strong id="${st.id}-d">0</strong> of ${sq.length} resolved</span>
        <div class="spb"><div class="spb-f" id="${st.id}-bar" style="width:0%"></div></div>
        <span class="spp" id="${st.id}-pct">0%</span>
      </div>
      <div id="qc-${st.id}"></div>`;
    main.appendChild(div);
  });
}

// ── RENDER ALL ────────────────────────────────────────────────────

function renderAll() {
  renderSidebar();
  renderStageBlocks();
  stages.forEach(st => renderStage(st.id));
  renderOverview();
  updateGlobal();
  updatePills();
  setRole(currentRole);
  renderConversations();
}

function renderStage(stage) {
  const c = document.getElementById('qc-' + stage);
  if (!c) return;
  c.innerHTML = '';
  questions.filter(q => q.stage === stage).forEach(q => c.appendChild(buildCard(q)));
  updateStageProg(stage);
}

function buildCard(q) {
  const hasThread = q.thread.length > 0;
  const sc = q.resolved ? 'resolved' : hasThread ? 'in-disc' : 'pending';
  const sl = q.resolved ? 'Resolved' : hasThread ? 'In Discussion' : 'Pending';

  const wrap = document.createElement('div');
  wrap.className = 'q-card-wrap';
  wrap.id = 'card-' + q.id;

  const div = document.createElement('div');
  div.className = 'q-card ' + sc;
  div.onclick = () => {
    if (window.innerWidth <= 768) toggleAccordion(q.id);
    else openThread(q.id);
  };
  div.innerHTML = `
    <span class="q-num">${esc(q.num)}</span>
    <span class="q-title">${esc(q.text)}</span>
    <div class="q-right">
      ${hasThread ? `<span class="q-rc">💬 ${q.thread.length}</span>` : ''}
      <span class="q-badge ${sc}">${sl}</span>
      <span class="q-arrow">›</span>
    </div>`;

  const panel = document.createElement('div');
  panel.className = 'q-panel';
  panel.id = 'panel-' + q.id;

  wrap.appendChild(div);
  wrap.appendChild(panel);
  return wrap;
}

// ── ACCORDION ─────────────────────────────────────────────────────

function toggleAccordion(qid) {
  const wrap = document.getElementById('card-' + qid);
  if (!wrap) return;
  const panel = wrap.querySelector('.q-panel');
  const card = wrap.querySelector('.q-card');
  const isOpen = panel.classList.contains('open');

  // Close all other open accordions
  document.querySelectorAll('.q-panel.open').forEach(p => {
    if (p !== panel) {
      p.classList.remove('open');
      const ow = p.closest('.q-card-wrap');
      if (ow) ow.querySelector('.q-card').classList.remove('acc-open');
    }
  });

  if (isOpen) {
    panel.classList.remove('open');
    card.classList.remove('acc-open');
    openQid = null;
    return;
  }

  openQid = qid;
  panel.classList.add('open');
  card.classList.add('acc-open');
  renderAccordionContent(qid);
  setTimeout(() => wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
}

function openAccordionPanel(qid) {
  const wrap = document.getElementById('card-' + qid);
  if (!wrap) return;
  const panel = wrap.querySelector('.q-panel');
  const card = wrap.querySelector('.q-card');
  if (panel && card) {
    panel.classList.add('open');
    card.classList.add('acc-open');
    renderAccordionContent(qid);
  }
}

function renderAccordionContent(qid) {
  const panel = document.getElementById('panel-' + qid);
  if (!panel) return;
  const q = questions.find(x => x.id === qid);
  if (!q) return;

  // Messages
  let msgsHtml = '';
  if (q.thread.length === 0) {
    msgsHtml = '<div class="thread-empty">No messages yet — start the conversation below.</div>';
  } else {
    q.thread.forEach(m => {
      const init = m.role === 'admin' ? 'ADM' : 'CLI';
      const name = m.role === 'admin' ? 'Admin' : 'Client';
      const t = m.ts ? fmtTime(m.ts) : '';
      msgsHtml += `<div class="msg ${m.role}">
        <div class="msg-av">${init}</div>
        <div class="msg-wrap">
          <div class="msg-meta"><span class="msg-who">${name}</span><span>${t}</span></div>
          <div class="msg-bub">${esc(m.text)}</div>
        </div>
      </div>`;
    });
    if (q.resolved) {
      msgsHtml += '<div class="res-mark">✅ Both parties reached agreement — marked as <strong>Resolved</strong></div>';
    }
  }

  // Reply section
  const replyHtml = q.resolved ? '' : `
    <div class="acc-reply-bar">
      <div class="who-row">
        <span class="who-lbl">Replying as:</span>
        <div class="who-tog">
          <button class="who-btn ${currentRole === 'admin' ? 'a-adm' : ''}" onclick="accSwitchWho('admin','${qid}')">👤 Admin</button>
          <button class="who-btn ${currentRole === 'client' ? 'a-cli' : ''}" onclick="accSwitchWho('client','${qid}')">🏢 Client</button>
        </div>
      </div>
      <div class="acc-input-row">
        <textarea class="acc-ta" id="acc-ta-${qid}" placeholder="Type your reply…" onkeydown="accHandleKey(event,'${qid}')"></textarea>
        <button class="send-btn" onclick="accSend('${qid}')">Send ↑</button>
      </div>
    </div>`;

  // Resolve/reopen section
  const hasAdm = q.thread.some(m => m.role === 'admin');
  const hasCli = q.thread.some(m => m.role === 'client');
  const canResolve = hasAdm && hasCli && !q.resolved;
  const resolveHtml = q.resolved
    ? `<span style="font-size:12px;color:var(--green)">✅ This question is <strong>Resolved</strong></span>
       <button class="btn-rop" onclick="accReopen('${qid}')">↩ Reopen</button>`
    : `<span class="resolve-hint">${canResolve ? 'Both sides replied — ready to resolve' : 'Need replies from both Admin and Client'}</span>
       <button class="btn-res" onclick="accResolve('${qid}')" ${canResolve ? '' : 'disabled'}>✓ Mark as Resolved</button>`;

  panel.innerHTML = `
    <div class="acc-msgs">${msgsHtml}</div>
    ${replyHtml}
    <div class="acc-resolve-row">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${resolveHtml}</div>
      <button class="acc-del-btn" onclick="accDelete('${qid}')">🗑 Delete</button>
    </div>`;

  const msgs = panel.querySelector('.acc-msgs');
  if (msgs) setTimeout(() => { msgs.scrollTop = msgs.scrollHeight; }, 50);
}

// ── PROGRESS ──────────────────────────────────────────────────────

function updateStageProg(stage) {
  const sq = questions.filter(q => q.stage === stage);
  const done = sq.filter(q => q.resolved).length;
  const pct = sq.length ? Math.round(done / sq.length * 100) : 0;
  const d = document.getElementById(stage + '-d');
  const b = document.getElementById(stage + '-bar');
  const p = document.getElementById(stage + '-pct');
  if (d) d.textContent = done;
  if (b) b.style.width = pct + '%';
  if (p) p.textContent = pct + '%';
}

function updateGlobal() {
  const done = questions.filter(q => q.resolved).length;
  const tot = questions.length;
  const pct = tot ? Math.round(done / tot * 100) : 0;
  document.getElementById('overall-num').innerHTML = `${done} <span>/ ${tot} resolved</span>`;
  document.getElementById('overall-bar').style.width = pct + '%';
}

function updatePills() {
  stages.forEach(st => {
    const sq = questions.filter(q => q.stage === st.id);
    const done = sq.filter(q => q.resolved).length;
    const p = document.getElementById('pill-' + st.id);
    if (!p) return;
    p.textContent = done + '/' + sq.length;
    p.className = 'npill' + (done === sq.length ? ' done' : done > 0 ? ' part' : '');
  });
}

// ── OVERVIEW ──────────────────────────────────────────────────────

function renderOverview() {
  const tot = questions.length;
  const res = questions.filter(q => q.resolved).length;
  const disc = questions.filter(q => !q.resolved && q.thread.length > 0).length;
  const pend = tot - res - disc;

  document.getElementById('ov-total').textContent = tot;
  document.getElementById('ov-res').textContent = res;
  document.getElementById('ov-disc').textContent = disc;
  document.getElementById('ov-pend').textContent = pend;
  const convEl = document.getElementById('ov-conv');
  if (convEl) convEl.textContent = conversations.length;
  document.getElementById('ov-date').textContent = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  document.getElementById('ov-role').textContent = currentRole === 'admin' ? 'Admin' : 'Client';

  const tbody = document.getElementById('sst-body');
  tbody.innerHTML = '';
  stages.forEach((st, i) => {
    const sq = questions.filter(q => q.stage === st.id);
    const done = sq.filter(q => q.resolved).length;
    const pct = sq.length ? Math.round(done / sq.length * 100) : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:500">${st.emoji} Section ${i + 1} — ${esc(st.label)}</td>
      <td style="color:var(--text2)">${done} / ${sq.length}</td>
      <td><span style="font-size:11px;color:var(--text3)">${pct}%</span><div class="sst-mini"><div class="sst-mini-f" style="width:${pct}%"></div></div></td>
      <td><span class="sst-go" onclick="showStage('${st.id}',null)">View →</span></td>`;
    tbody.appendChild(tr);
  });

  // Conversations row in section breakdown
  const convTr = document.createElement('tr');
  convTr.innerHTML = `
    <td style="font-weight:500">🔬 Conversation Analysis</td>
    <td style="color:var(--text2)">${conversations.length} total</td>
    <td><span style="font-size:11px;color:var(--text3)">${conversations.length > 0 ? conversations.length + ' analyzed' : 'None yet'}</span></td>
    <td><span class="sst-go" onclick="showConversations(null)">View →</span></td>`;
  tbody.appendChild(convTr);

  // Mobile stage navigation cards
  const msnEl = document.getElementById('mobile-stage-nav');
  if (msnEl) {
    msnEl.innerHTML = '';
    stages.forEach((st, i) => {
      const sq = questions.filter(q => q.stage === st.id);
      const done = sq.filter(q => q.resolved).length;
      const pillClass = done === sq.length ? 'done' : done > 0 ? 'part' : '';
      const item = document.createElement('div');
      item.className = 'msn-item';
      item.dataset.stage = st.id;
      item.onclick = () => showStage(st.id, null);
      item.innerHTML = `
        <div class="msn-l">
          <div class="msn-ic">${st.emoji}</div>
          <span>Section ${i + 1} — ${esc(st.label)}</span>
        </div>
        <span class="msn-pill ${pillClass}">${done}/${sq.length}</span>`;
      msnEl.appendChild(item);
    });
  }
}

// ── NAV ───────────────────────────────────────────────────────────

function showStage(id, navEl) {
  document.querySelectorAll('.stage-blk').forEach(el => el.classList.remove('active'));
  const target = document.getElementById('stage-' + id);
  if (target) target.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const t = navEl || document.querySelector(`.nav-item[data-stage="${id}"]`);
  if (t) t.classList.add('active');
  document.querySelectorAll('.msn-item').forEach(el => el.classList.remove('active'));
  const msn = document.querySelector(`.msn-item[data-stage="${id}"]`);
  if (msn) msn.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (window.innerWidth <= 768) closeSidebar();
}
