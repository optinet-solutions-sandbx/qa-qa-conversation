/**
 * setup.js
 * Handles User Onboarding (Welcome Modal) and AI Import Logic.
 */

let setupRole = null;
let uploadedFileContent = null;

// ── INITIALIZATION ────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  checkUserSession();
});

function checkUserSession() {
  const user = localStorage.getItem('qa_user');
  const role = localStorage.getItem('qa_role_pref');

  if (user && role) {
    // User exists, show dashboard
    updateUserDisplay(user, role);
    
    // Sync with app state if functions exist
    if (typeof setRole === 'function') {
      setRole(role);
    }
    // Add the live analysis button now that we know the user is set up
    addLiveAnalysisButton();
  } else {
    // First visit, show modal
    document.getElementById('welcome-overlay').classList.add('open');
  }
}

function addLiveAnalysisButton() {
  const headerRight = document.querySelector('.hdr-r');
  if (headerRight && !document.getElementById('live-analysis-btn')) {
      const liveButton = document.createElement('button');
      liveButton.id = 'live-analysis-btn';
      liveButton.className = 'btn btn-g';
      liveButton.innerHTML = '⚡️ Analyze Recent';
      liveButton.onclick = runLiveAnalysis;
      
      const addQuestionBtn = headerRight.querySelector('.btn-p');
      if (addQuestionBtn) {
          headerRight.insertBefore(liveButton, addQuestionBtn);
      } else {
          headerRight.appendChild(liveButton);
      }
  }
}

function updateUserDisplay(name, role) {
  const disp = document.getElementById('user-display');
  const label = role === 'admin' ? 'Admin' : 'User';
  const icon = role === 'admin' ? '👤' : '🏢';
  
  disp.innerHTML = `${icon} ${esc(name)} <span style="opacity:0.5;margin:0 4px">|</span> ${label}`;
  disp.classList.remove('hidden');

  // Optionally hide the manual switcher if you want strict enforcement
  // document.querySelector('.role-sw').style.display = 'none';
}

// ── WELCOME MODAL LOGIC ───────────────────────────────────────────

function selectSetupRole(role, el) {
  setupRole = role;
  
  // UI Toggle
  document.querySelectorAll('.role-opt').forEach(opt => opt.classList.remove('selected'));
  el.classList.add('selected');
  
  // Clear error
  document.getElementById('err-role').classList.remove('vis');
}

function saveUserSetup() {
  const nameInput = document.getElementById('setup-name');
  const name = nameInput.value.trim();
  
  let isValid = true;

  // Validation
  if (!name) {
    document.getElementById('err-name').classList.add('vis');
    isValid = false;
  } else {
    document.getElementById('err-name').classList.remove('vis');
  }

  if (!setupRole) {
    document.getElementById('err-role').classList.add('vis');
    isValid = false;
  }

  if (!isValid) return;

  // Save to LocalStorage
  localStorage.setItem('qa_user', name);
  localStorage.setItem('qa_role_pref', setupRole);

  // Apply settings
  updateUserDisplay(name, setupRole);
  if (typeof setRole === 'function') {
    setRole(setupRole);
  }

  // Close Modal
  document.getElementById('welcome-overlay').classList.remove('open');
  if (typeof toast === 'function') toast(`Welcome, ${name}!`, 'ok');
  
}

// ── IMPORT / AI MODAL LOGIC ───────────────────────────────────────

function openImportModal() {
  document.getElementById('import-overlay').classList.add('open');
}

function closeImportModal() {
  document.getElementById('import-overlay').classList.remove('open');
  // Reset fields
  document.getElementById('file-input').value = '';
  document.getElementById('file-name').textContent = 'No file selected';
  document.getElementById('import-text').value = '';
  document.getElementById('intercom-id').value = '';
  uploadedFileContent = null;
  
  // Clear analysis result
  const res = document.getElementById('ai-res-box');
  if (res) res.remove();
  
  // Reset button text
  const btn = document.querySelector('#import-overlay .btn-p');
  if (btn) btn.textContent = 'Run Analysis';
}

function switchImportTab(mode) {
  // Update Buttons
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');

  // Update Content
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-' + mode).classList.add('active');
}

function handleFileSelect(input) {
  const file = input.files[0];
  if (!file) return;

  document.getElementById('file-name').textContent = file.name;

  const reader = new FileReader();
  reader.onload = (e) => {
    uploadedFileContent = e.target.result;
    // Always populate the analyze field so the user can see/edit the content
    document.getElementById('import-text').value = uploadedFileContent;
  };
  reader.readAsText(file);
}

// ── AI ANALYSIS PLACEHOLDER ───────────────────────────────────────

async function analyzeConversation(analysisInput) {
  try {
    // Call our serverless API endpoint. This relative path works for both
    // local development and production deployments (e.g., on Vercel).
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(analysisInput)
    });

    // Check contentType to avoid parsing errors if Vercel returns an HTML error page (like 404/500)
    const contentType = response.headers.get("content-type");
    let data;
    if (contentType && contentType.includes("application/json")) {
      data = await response.json();
    } else {
      throw new Error(`Server returned non-JSON response: ${response.status} ${response.statusText}`);
    }

    if (!response.ok) {
      throw new Error(data.error || `Analysis failed (Status: ${response.status})`);
    }

    // Pass the full structured data object from the API to the next function.
    // The `summary` property is kept for backward compatibility with `applyAnalysisToDashboard`.
    return { status: 'success', summary: data.summary, structuredData: data };

  } catch (err) {
    throw err;
  }
}

function showAnalysisResult(data) {
  // Remove existing if any
  const existing = document.getElementById('ai-res-box');
  if (existing) existing.remove();

  // Store structured data for application
  window.aiAnalysisData = data.structuredData;

  const box = document.createElement('div');
  box.id = 'ai-res-box';
  box.className = 'ai-res-box';

  // Display the structured data from the analysis
  const sentiment = esc(data.structuredData.sentiment || 'N/A');
  const intent = esc(data.structuredData.intent || 'N/A');
  const summary = esc(data.structuredData.summary || 'No summary provided.');

  box.innerHTML = `
    <div class="ai-res-h">✨ AI Analysis Result</div>
    <div class="ai-res-content" style="display: grid; grid-template-columns: auto 1fr; gap: 5px 10px; align-items: center;">
      <strong style="color: var(--text2);">Sentiment:</strong><span>${sentiment}</span>
      <strong style="color: var(--text2);">Intent:</strong><span>${intent}</span>
    </div>
    <div class="ai-res-content" style="margin-top: 10px; white-space: pre-wrap; border-top: 1px solid var(--border); padding-top: 10px;">${summary}</div>
    <div style="margin-top:12px;text-align:right">
      <button class="btn-sm btn-p" onclick="applyAnalysisToDashboard()">Apply to Dashboard</button>
    </div>`;

  // Insert into active tab content at the top
  const activeTab = document.querySelector('.tab-content.active');
  if (activeTab) activeTab.insertBefore(box, activeTab.firstChild);
  else document.querySelector('.modal-body')?.prepend(box);
}

function applyAnalysisToDashboard() {
  if (!window.aiAnalysisData) return;
  const analysis = window.aiAnalysisData;

  const id = 'conv-' + Date.now();
  const title = `${analysis.intent || 'General'} — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  // Prefer conversation_text returned by the API (covers Intercom fetch too),
  // fall back to whatever is in the paste textarea
  const pasteText = document.getElementById('import-text')?.value?.trim() || '';

  const conv = {
    id,
    title,
    sentiment:         analysis.sentiment        || 'Neutral',
    intent:            analysis.intent           || 'General',
    summary:           analysis.summary          || '',
    intercom_id:       analysis.intercom_id ? String(analysis.intercom_id) : null,
    original_text:     analysis.conversation_text || pasteText || null,
    analyzed_at:       new Date().toISOString(),
    notes: []
  };

  conversations.push(conv);
  save();
  renderConversations();
  renderOverview();
  closeImportModal();
  showConversations(null);
  toast('Conversation analysis saved', 'ok');
}

async function runLiveAnalysis() {
  const btn = document.getElementById('live-analysis-btn');
  if (!btn) return;

  const originalText = btn.innerHTML;
  btn.innerHTML = 'Analyzing...';
  btn.disabled = true;

  try {
    const response = await fetch('/api/analyze-recent', { method: 'POST' });
    const data = await response.json();

    if (!response.ok) throw new Error(data.error || `Live analysis failed`);
    if (!data.analyses || data.analyses.length === 0) {
      if (typeof toast === 'function') toast(data.message || 'No new conversations to analyze.', 'i');
      return;
    }
    
    addAnalysesToDashboard(data.analyses);
    if (typeof toast === 'function') toast(`Added ${data.analyses.length} new analyses.`, 'ok');
  } catch (err) {
    console.error('Live Analysis Error:', err);
    if (typeof toast === 'function') toast(err.message, 'i');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

function addAnalysesToDashboard(analyses) {
  let added = 0;

  analyses.forEach(analysis => {
    const existing = conversations.some(c => c.intercom_id && c.intercom_id === String(analysis.intercom_id));
    if (existing) return;

    const id = 'conv-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const title = `${analysis.intent || 'General'} — ${new Date(analysis.created_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;

    conversations.push({
      id,
      title,
      sentiment:     analysis.sentiment         || 'Neutral',
      intent:        analysis.intent            || 'General',
      summary:       analysis.summary           || '',
      intercom_id:   String(analysis.intercom_id),
      original_text: analysis.conversation_text || null,
      analyzed_at:   new Date(analysis.created_at * 1000).toISOString(),
      notes: []
    });
    added++;
  });

  if (added > 0) {
    save();
    renderConversations();
    renderOverview();
    showConversations(null);
  }
}

async function runAnalysis() {
  const activeTabId = document.querySelector('.tab-content.active').id;
  let analysisInput = {};
  let hasInput = false;

  if (activeTabId === 'tab-paste' || activeTabId === 'tab-upload') {
    let textToAnalyze = document.getElementById('import-text').value.trim();
    if (!textToAnalyze && uploadedFileContent) {
      textToAnalyze = uploadedFileContent;
    }
    if (textToAnalyze) {
      analysisInput = { text: textToAnalyze };
      hasInput = true;
    }
  } else if (activeTabId === 'tab-intercom') {
    const intercomId = document.getElementById('intercom-id').value.trim();
    if (intercomId) {
      analysisInput = { intercomId: intercomId };
      hasInput = true;
    }
  }

  if (!hasInput) {
    if (typeof toast === 'function') toast('Please provide input for analysis', 'i');
    return;
  }

  const btn = document.querySelector('#import-overlay .btn-p');
  const originalText = btn.dataset.defaultText || btn.textContent;
  if (!btn.dataset.defaultText) btn.dataset.defaultText = originalText;

  btn.textContent = 'Analyzing...';
  btn.disabled = true;

  try {
    const result = await analyzeConversation(analysisInput);
    if (typeof toast === 'function') toast('Conversation analyzed successfully', 'ok');
    
    showAnalysisResult(result);
    btn.textContent = 'Re-analyze';
  } catch (err) {
    console.error('Analysis Error:', err);
    let errorMessage = 'Analysis failed. See browser console for details.';
    if (err instanceof TypeError) { // This often indicates a network error
      errorMessage = 'Analysis failed. Could not connect to the backend. Is the server running?';
    } else if (err.message) {
      errorMessage = err.message.startsWith('Analysis failed:') ? err.message : `Analysis failed: ${err.message}`;
    }
    if (typeof toast === 'function') toast(errorMessage, 'i');
    btn.textContent = originalText;
  } finally {
    btn.disabled = false;
  }
}