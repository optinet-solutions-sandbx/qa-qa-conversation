export interface ConversationNote {
  id: string;
  author: string;
  text: string;
  ts: string;
  system: boolean;
}

export interface RawMessage {
  author_type: string;
  body: string;
}

export interface PlayerCompany {
  id: string;
  name: string;
  session_count: number | null;
  monthly_spend: number | null;
}

export interface PlayerEventSummary {
  name: string;
  first: string;
  last: string;
  count: number;
}

export interface Conversation {
  id: string;
  title: string;
  analyzed_at: string;

  // Intercom identifiers
  intercom_id: string | null;
  intercom_created_at: string | null;

  // Player — core
  player_name: string | null;
  player_email: string | null;
  player_id: string | null;
  player_external_id: string | null;
  player_phone: string | null;
  player_tags: string[];

  // Player — timestamps
  player_signed_up_at: string | null;
  player_last_seen_at: string | null;
  player_last_replied_at: string | null;
  player_last_contacted_at: string | null;

  // Player — location & device
  player_country: string | null;
  player_city: string | null;
  player_browser: string | null;
  player_os: string | null;

  // Player — rich data
  player_custom_attributes: Record<string, unknown> | null;
  player_companies: PlayerCompany[];
  player_segments: string[];
  player_event_summaries: PlayerEventSummary[];

  // Agent
  agent_name: string | null;
  agent_email: string | null;
  is_bot_handled: boolean;

  // Intercom metadata
  brand: string | null;
  tags: string[];
  query_type: string | null;
  ai_subject: string | null;
  ai_issue_summary: string | null;
  cx_score_rating: number | null;
  cx_score_explanation: string | null;
  conversation_rating_score: number | null;
  conversation_rating_remark: string | null;

  // Intercom statistics (seconds)
  time_to_assignment: number | null;
  time_to_admin_reply: number | null;
  time_to_first_close: number | null;
  median_time_to_reply: number | null;
  count_reopens: number | null;

  // AI analysis (null until analysis is run)
  sentiment: string | null;
  summary: string | null;
  dissatisfaction_severity: 'Low' | 'Medium' | 'High' | 'Critical' | null;
  issue_category: string | null;
  resolution_status: 'Resolved' | 'Partially Resolved' | 'Unresolved' | null;
  language: string | null;
  agent_performance_score: number | null;
  agent_performance_notes: string | null;
  key_quotes: string | null;
  recommended_action: string | null;
  is_alert_worthy: boolean;
  alert_reason: string | null;

  // Last analysis prompt
  last_prompt_id: string | null;
  last_prompt_content: string | null;

  // Derived — stored for efficient filtering
  account_manager: string | null;

  // Transcript & notes
  original_text: string | null;
  raw_messages: RawMessage[] | null;
  notes: ConversationNote[];
}

export interface PromptVersion {
  id: string;
  title: string;
  content: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ConversationFetchResult {
  intercom_id: string;
  intercom_created_at: string | null;

  // Player — core
  player_name: string | null;
  player_email: string | null;
  player_id: string | null;
  player_external_id: string | null;
  player_phone: string | null;
  player_tags: string[];

  // Player — timestamps
  player_signed_up_at: string | null;
  player_last_seen_at: string | null;
  player_last_replied_at: string | null;
  player_last_contacted_at: string | null;

  // Player — location & device
  player_country: string | null;
  player_city: string | null;
  player_browser: string | null;
  player_os: string | null;

  // Player — rich data
  player_custom_attributes: Record<string, unknown> | null;
  player_companies: PlayerCompany[];
  player_segments: string[];
  player_event_summaries: PlayerEventSummary[];

  // Agent
  agent_name: string | null;
  agent_email: string | null;
  is_bot_handled: boolean;

  // Intercom metadata
  brand: string | null;
  tags: string[];
  query_type: string | null;
  ai_subject: string | null;
  ai_issue_summary: string | null;
  cx_score_rating: number | null;
  cx_score_explanation: string | null;
  conversation_rating_score: number | null;
  conversation_rating_remark: string | null;

  // Intercom statistics (seconds)
  time_to_assignment: number | null;
  time_to_admin_reply: number | null;
  time_to_first_close: number | null;
  median_time_to_reply: number | null;
  count_reopens: number | null;

  // Derived at collection time
  account_manager: string | null;

  transcript: string;
  raw_messages: RawMessage[];
}

export interface AnalysisRun {
  id: string;
  conversation_id: string;
  // Denormalised for table display
  conversation_title: string | null;
  player_name: string | null;
  analyzed_at: string;
  // Prompt used
  prompt_id: string | null;
  prompt_title: string | null;
  prompt_content: string;
  // Result fields
  language: string | null;
  summary: string | null;
  dissatisfaction_severity: string | null;
  issue_category: string | null;
  resolution_status: string | null;
  key_quotes: string | null;
  agent_performance_score: number | null;
  agent_performance_notes: string | null;
  recommended_action: string | null;
  is_alert_worthy: boolean;
  alert_reason: string | null;
}

export interface AnalysisResult {
  analysisText: string;
}

export type SyncStatus = 'running' | 'done' | 'cancelled' | 'error';

export interface SyncJob {
  id: string;           // date string "YYYY-MM-DD" — one job per date
  status: SyncStatus;
  total: number;
  done: number;
  error_count: number;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
}

// OpenAI statuses + our own 'importing' sentinel
export type BatchJobStatus =
  | 'pending'
  | 'validating'
  | 'in_progress'
  | 'finalizing'
  | 'completed'
  | 'expired'
  | 'cancelling'
  | 'cancelled'
  | 'failed';

export interface AiQuery {
  id: string;
  question: string;
  answer: string;
  tools_used: unknown;           // ToolCallResult[] serialised
  is_irrelevant: boolean;
  created_at: string;
}

export interface BatchJob {
  id: string;
  openai_batch_id: string | null;
  openai_file_id: string | null;   // input JSONL file uploaded to OpenAI
  output_file_id: string | null;   // result JSONL, set when batch completes
  status: BatchJobStatus;
  prompt_id: string | null;
  prompt_content: string | null;
  chunk_index: number;             // 0-based — which chunk of the full dataset
  total_chunks: number;            // how many chunks were submitted in this run
  total_conversations: number;
  completed_conversations: number;
  failed_conversations: number;
  imported_count: number;          // resume cursor: how many lines have been imported so far
  error_message: string | null;
  created_at: string;
  submitted_at: string | null;
  completed_at: string | null;
}
