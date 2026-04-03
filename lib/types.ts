export interface ConversationNote {
  id: string;
  author: string;
  text: string;
  ts: string;
  system: boolean;
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

  // Transcript & notes
  original_text: string | null;
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

  transcript: string;
}

export interface AnalysisResult {
  language: string;
  summary: string;
  dissatisfaction_severity: string;
  issue_category: string;
  resolution_status: string;
  key_quotes: string;
  agent_performance_score: number | null;
  agent_performance_notes: string;
  recommended_action: string;
  is_alert_worthy: boolean;
  alert_reason: string | null;
}
