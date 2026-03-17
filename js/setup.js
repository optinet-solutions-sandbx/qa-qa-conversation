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
  } else {
    // First visit, show modal
    document.getElementById('welcome-overlay').classList.add('open');
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

async function analyzeConversation(conversationText) {
  try {
    // Call our own server-side API endpoint
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: conversationText })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Analysis failed');
    }

    return { status: 'success', summary: data.summary };
  } catch (err) {
    throw err;
  }
}

function showAnalysisResult(data) {
  // Remove existing if any
  const existing = document.getElementById('ai-res-box');
  if (existing) existing.remove();

  // Store for application
  window.aiAnalysisData = data.summary;

  const box = document.createElement('div');
  box.id = 'ai-res-box';
  box.className = 'ai-res-box';
  box.innerHTML = `
    <div class="ai-res-h">✨ Analysis Result</div>
    <div class="ai-res-content">${data.summary}</div>
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

  // Default to 's3' (AI Monitoring) or fallback to first stage
  let targetStage = stages.find(s => s.id === 's3') || stages[0];
  if (!targetStage) {
    if (typeof toast === 'function') toast('No sections available', 'i');
    return;
  }

  const sq = questions.filter(q => q.stage === targetStage.id);
  const stIdx = stages.findIndex(s => s.id === targetStage.id);
  
  const id = `q-${targetStage.id}-${Date.now()}`;
  const num = `Q${stIdx + 1}.${sq.length + 1} (AI)`;
  const role = (typeof currentRole !== 'undefined') ? currentRole : 'admin';
  
  const newQ = {
    id,
    stage: targetStage.id,
    num,
    text: `AI Analysis: ${new Date().toLocaleTimeString()}`,
    resolved: false,
    thread: [{ role, text: window.aiAnalysisData, ts: new Date().toISOString() }]
  };

  questions.push(newQ);
  save();
  
  if (typeof dbInsertQuestion === 'function') dbInsertQuestion(newQ);
  if (typeof dbInsertMessage === 'function') dbInsertMessage(id, role, window.aiAnalysisData);

  renderStageBlocks();
  stages.forEach(st => renderStage(st.id));
  updateGlobal();
  updatePills();
  renderOverview();

  closeImportModal();
  showStage(targetStage.id);
  toast(`Added analysis to ${targetStage.label}`, 'ok');
}

async function runAnalysis() {
  // Determine source
  let textToAnalyze = document.getElementById('import-text').value.trim();
  
  // If text is empty but we have a file loaded, use that
  if (!textToAnalyze && uploadedFileContent) {
    textToAnalyze = uploadedFileContent;
  }

  if (!textToAnalyze) {
    if (typeof toast === 'function') toast('Please upload a file or paste text', 'i');
    else alert('Please upload a file or paste text');
    return;
  }

  const btn = document.querySelector('#import-overlay .btn-p');
  const originalText = btn.dataset.defaultText || btn.textContent;
  if (!btn.dataset.defaultText) btn.dataset.defaultText = originalText;

  btn.textContent = 'Analyzing...';
  btn.disabled = true;

  try {
    const result = await analyzeConversation(textToAnalyze);
    if (typeof toast === 'function') toast('Conversation analyzed successfully', 'ok');
    
    showAnalysisResult(result);
    btn.textContent = 'Re-analyze';
  } catch (err) {
    console.error(err);
    if (typeof toast === 'function') toast('Analysis failed', 'i');
    btn.textContent = originalText;
  } finally {
    btn.disabled = false;
  }
}