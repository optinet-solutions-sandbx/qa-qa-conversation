// ── SUPABASE DATABASE OPERATIONS ─────────────────────────────────
// All functions are async and fire-and-forget safe.
// If window.db is null (Supabase not configured), they do nothing.

async function dbInsertMessage(questionId, role, text) {
  if (!window.db) return;
  const { error } = await window.db
    .from('messages')
    .insert({ question_id: questionId, role, text });
  if (error) console.error('[db] insertMessage:', error.message);
}

async function dbSetResolved(questionId, resolved) {
  if (!window.db) return;
  const { error } = await window.db
    .from('questions')
    .update({ resolved })
    .eq('id', questionId);
  if (error) console.error('[db] setResolved:', error.message);
}

async function dbDeleteQuestion(questionId) {
  if (!window.db) return;
  const { error } = await window.db
    .from('questions')
    .delete()
    .eq('id', questionId);
  if (error) console.error('[db] deleteQuestion:', error.message);
}

async function dbInsertQuestion(q) {
  if (!window.db) return;
  const { error } = await window.db
    .from('questions')
    .insert({ id: q.id, stage_id: q.stage, num: q.num, text: q.text, resolved: q.resolved });
  if (error) console.error('[db] insertQuestion:', error.message);
}

async function dbInsertStage(stage, sortOrder) {
  if (!window.db) return;
  const { error } = await window.db
    .from('stages')
    .insert({ id: stage.id, label: stage.label, emoji: stage.emoji, sort_order: sortOrder });
  if (error) console.error('[db] insertStage:', error.message);
}

async function dbDeleteStage(stageId) {
  if (!window.db) return;
  // ON DELETE CASCADE handles questions + messages automatically
  const { error } = await window.db
    .from('stages')
    .delete()
    .eq('id', stageId);
  if (error) console.error('[db] deleteStage:', error.message);
}

// ── CONVERSATION DB OPERATIONS ────────────────────────────────────

async function dbInsertConversation(c) {
  if (!window.db) return;
  const { error } = await window.db.from('conversations').insert({
    id:            c.id,
    title:         c.title,
    sentiment:     c.sentiment,
    intent:        c.intent,
    summary:       c.summary,
    intercom_id:   c.intercom_id || null,
    original_text: c.original_text || null,
    analyzed_at:   c.analyzed_at,
  });
  if (error) console.error('[db] insertConversation:', error.message);
}

async function dbUpdateConversation(c) {
  if (!window.db) return;
  const { error } = await window.db.from('conversations').update({
    title:       c.title,
    sentiment:   c.sentiment,
    intent:      c.intent,
    summary:     c.summary,
    analyzed_at: c.analyzed_at,
  }).eq('id', c.id);
  if (error) console.error('[db] updateConversation:', error.message);
}

async function dbDeleteConversation(id) {
  if (!window.db) return;
  const { error } = await window.db.from('conversations').delete().eq('id', id);
  if (error) console.error('[db] deleteConversation:', error.message);
}

async function dbInsertConversationNote(convId, note) {
  if (!window.db) return;
  const { error } = await window.db.from('conversation_notes').insert({
    conversation_id: convId,
    author:          note.author,
    text:            note.text,
    is_system:       note.system || false,
  });
  if (error) console.error('[db] insertConversationNote:', error.message);
}

async function dbUpdateConversationNote(convId, noteIdx, note) {
  if (!window.db) return;
  // Notes are stored in local state only; Supabase sync is fire-and-forget
  // Update is handled via full conversation update or note-level update if schema supports it
}

async function dbDeleteConversationNote(convId, noteIdx) {
  if (!window.db) return;
  // Notes are stored in local state only; Supabase sync is fire-and-forget
  // Delete is handled via full conversation update or note-level delete if schema supports it
}
