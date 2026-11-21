export type Role = "admin" | "analyst" | "viewer";

export interface User {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
}

export interface Department {
  id: string;
  name: string;
  description: string | null;
  created_at?: string | null;
}

export interface UserGroup {
  id: string;
  name: string;
  description: string | null;
  department_id: string | null;
  created_by: string | null;
  created_at: string | null;
  member_count?: number;
}

export interface GroupMember {
  id: string;
  group_id: string;
  user_id: string;
  created_at: string | null;
  user?: {
    id: string;
    email: string;
    display_name: string;
    role: Role;
  };
}

export interface ArchiveDocument {
  id: string;
  filename: string;
  title: string | null;
  content_type: string;
  byte_size: number;
  status: string;
  doc_type: string | null;
  expiry_date: string | null;
  classification_confidence: number | null;
  page_count: number | null;
  uploaded_by: string | null;
  created_at: string | null;
  indexed_at: string | null;
  extracted_metadata: Record<string, unknown> | null;
  /**
   * Where the document physically sits in the archive. All four parts are
   * present or all four are null — a partial location names no real place.
   */
  zone: string | null;
  rack: string | null;
  shelf: string | null;
  box: string | null;
}

export interface DocumentList {
  items: ArchiveDocument[];
  total: number;
}

// ── Warehouse ────────────────────────────────────────────────────────────────

/** The physical slot a document occupies, plus the human-readable path. */
export interface DocumentLocation {
  zone: string | null;
  rack: string | null;
  shelf: string | null;
  box: string | null;
  /** e.g. "Zone A · Rack R3 · Shelf 2 · Box B4"; null when unlocated. */
  label: string | null;
}

/** One occupied slot, as the layout endpoint reports it. */
export interface WarehouseSlot {
  zone: string;
  rack: string;
  shelf: string;
  box: string;
  document_id: string;
  filename: string;
  title: string | null;
  /** ISO timestamp of when the document was created (stable for position calc). */
  created_at: string;
  /** Position of this document within its box, 1..N, sorted by filed-at date. */
  position: number;
  /** Total number of documents in the same box. */
  total_in_box: number;
  /** Checkout info if the document is checked out; null otherwise. */
  checkout: CheckoutInfo | null;
}

export interface CheckoutInfo {
  by: string;
  dueAt: string;
}

export interface CheckoutResponse {
  id: string;
  document_id: string;
  checked_out_by: string;
  checked_out_at: string;
  due_at: string;
  checked_in_at: string | null;
  checked_in_by: string | null;
}

export interface CheckinResponse {
  id: string;
  document_id: string;
  checked_out_by: string;
  checked_out_at: string;
  due_at: string;
  checked_in_at: string;
  checked_in_by: string;
}

/**
 * The warehouse vocabulary and the occupied slots the caller may read.
 *
 * The vocabulary is the backend's single source of truth — the frontend reads
 * it from here rather than hardcoding zones, racks, shelves and boxes.
 */
export interface WarehouseLayout {
  zones: string[];
  racks: string[];
  shelves: string[];
  boxes: string[];
  slots: WarehouseSlot[];
}

export interface Permission {
  id: string;
  grantee_type: "user" | "role";
  grantee_user_id: string | null;
  grantee_role: string | null;
  permission: "view" | "download" | "manage";
  granted_by: string | null;
  granted_at: string | null;
}

export interface Citation {
  index: number;
  document_id: string;
  filename: string;
  page_start: number;
  page_end: number;
  quote: string;
  score?: number | null;
}

/** A passage surfaced in the evidence panel before the answer is generated. */
export interface Passage {
  index: number;
  document_id: string;
  filename: string;
  page_start: number;
  page_end: number;
  quote?: string;
  score?: number;
}

export interface Answer {
  answer: string;
  found: boolean;
  citations: Citation[];
  intent: string;
  model: string;
  conversation_id: string | null;
  message_id: string | null;
}

export interface SearchHit {
  chunk_id: string;
  document_id: string;
  filename: string;
  doc_type: string | null;
  page_start: number;
  page_end: number;
  score: number;
  excerpt: string;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  count: number;
}

export interface Conversation {
  id: string;
  title: string | null;
  created_at: string | null;
  /**
   * What the caller may do with this conversation:
   * "owner" | "contribute" | "read" | "" (no access).
   */
  access?: string;
}

/** A conversation another user has shared with the caller. */
export interface SharedConversation {
  id: string;
  title: string | null;
  created_at: string | null;
  access: string;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  answer_found: boolean | null;
  created_at: string | null;
}

export interface AuditEntry {
  id: string;
  actor_user_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  ip: string | null;
  meta: Record<string, unknown> | null;
  created_at: string | null;
}

export interface AdminStats {
  users: number;
  documents: number;
  ready_documents: number;
  conversations: number;
  citations: number;
}

export interface Summary {
  document_id: string;
  summary: string;
  model: string;
  prompt_version: string;
  generated_at: string | null;
}

// ── Document Intelligence Profiles ───────────────────────────────────────────

export interface ProfileEntry {
  name?: string | null;
  label?: string | null;
  role?: string | null;
  date?: string | null;
  amount?: number | null;
  currency?: string | null;
  reference?: string | null;
  title?: string | null;
  text?: string | null;
  party?: string | null;
  due?: string | null;
  reason?: string | null;
  page?: number | null;
  field?: string | null;
  excerpt?: string | null;
}

export interface DocumentProfile {
  id: string;
  document_id: string;
  doc_type: string | null;
  parties: ProfileEntry[];
  organisations: ProfileEntry[];
  individuals: ProfileEntry[];
  important_dates: ProfileEntry[];
  monetary_values: ProfileEntry[];
  currency: string | null;
  contract_references: ProfileEntry[];
  important_clauses: ProfileEntry[];
  obligations: ProfileEntry[];
  keywords: string[];
  related_documents: { document_id: string; reason: string }[];
  source_refs: ProfileEntry[];
  confidence: number | null;
  model: string | null;
  created_at: string | null;
  updated_at: string | null;
}

// ── Document Comparison ──────────────────────────────────────────────────────

export type ComparisonFindingKind =
  | "added"
  | "removed"
  | "modified"
  | "changed_date"
  | "changed_value"
  | "different_obligation"
  | "inconsistency";

export type Severity = "info" | "low" | "medium" | "high";

export interface ComparisonCitation {
  document_id: string;
  filename: string;
  page: number | null;
  excerpt: string | null;
}

export interface ComparisonFinding {
  id: string;
  kind: ComparisonFindingKind;
  category: string | null;
  title: string;
  detail: string | null;
  severity: Severity;
  citation_a: ComparisonCitation | null;
  citation_b: ComparisonCitation | null;
  sort_order: number;
}

export interface DocumentComparison {
  id: string;
  document_a_id: string;
  document_b_id: string;
  filename_a: string | null;
  filename_b: string | null;
  status: string;
  summary: string | null;
  model: string | null;
  error: string | null;
  created_by: string | null;
  created_at: string | null;
  completed_at: string | null;
  findings: ComparisonFinding[];
}

export interface ComparisonListItem {
  id: string;
  document_a_id: string;
  document_b_id: string;
  filename_a: string | null;
  filename_b: string | null;
  status: string;
  summary: string | null;
  created_at: string | null;
  finding_count: number;
}

export interface ComparisonListOut {
  items: ComparisonListItem[];
  total: number;
}

// ── Research Mode ────────────────────────────────────────────────────────────

export interface ResearchCitation {
  index: number;
  document_id: string;
  filename: string;
  page_start: number;
  page_end: number;
  excerpt: string;
}

export interface ResearchSection {
  key: string;
  title: string;
  body: string;
  citations: number[];
}

export interface ResearchReport {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  question: string;
  sections: ResearchSection[];
  citations: ResearchCitation[];
  model: string | null;
  tokens_used: number | null;
  created_by: string | null;
  created_at: string | null;
}

export interface ResearchReportSummary {
  id: string;
  question: string;
  model: string | null;
  created_at: string | null;
  citation_count: number;
}

export interface ResearchListOut {
  items: ResearchReportSummary[];
  total: number;
}

// ── Knowledge Graph ──────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  document_count: number;
  mention_count: number;
  attributes: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  weight: number;
  label: string | null;
  document_ids: string[];
  pages: { document_id: string; page_start: number; page_end: number; excerpt?: string }[];
}

export interface GraphStats {
  document_count: number;
  entity_count: number;
  contract_reference_count: number;
  edge_count: number;
  sources: string[];
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}

export interface EntityDetail {
  id: string;
  kind: string;
  name: string;
  attributes: Record<string, unknown>;
  mention_count: number;
  documents: {
    document_id: string;
    filename: string | null;
    page_start: number | null;
    page_end: number | null;
    excerpt: string;
  }[];
}

// ── Extraction Studio ────────────────────────────────────────────────────────

export interface ExtractionColumn {
  key: string;
  label: string;
  type: string;
}

export interface ExtractionCitation {
  column: string;
  document_id: string;
  filename: string;
  page: number | null;
  excerpt: string;
}

export interface ExtractionRow {
  id: string;
  row_index: number;
  data: Record<string, string | number | boolean | null>;
  document_id: string | null;
  citations: ExtractionCitation[];
}

export interface ExtractionRun {
  id: string;
  instruction: string;
  question: string | null;
  status: string;
  columns: ExtractionColumn[];
  row_count: number;
  model: string | null;
  error: string | null;
  created_by: string | null;
  created_at: string | null;
  completed_at: string | null;
  rows: ExtractionRow[];
}

export interface ExtractionListItem {
  id: string;
  instruction: string;
  status: string;
  row_count: number;
  model: string | null;
  created_at: string | null;
}

export interface ExtractionListOut {
  items: ExtractionListItem[];
  total: number;
}

// ── Archive Insights ─────────────────────────────────────────────────────────

export interface InsightEvidence {
  document_id: string;
  filename?: string | null;
  page?: number | null;
  excerpt?: string | null;
}

export interface ArchiveInsight {
  id: string | null;
  kind: string;
  severity: Severity;
  title: string;
  detail: string | null;
  document_ids: string[];
  evidence: InsightEvidence[];
  status: "open" | "acknowledged" | "resolved" | "dismissed";
  detected_at: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
}

export interface InsightListOut {
  items: ArchiveInsight[];
  total: number;
  counts: Record<string, number>;
}

// ── Analytics ────────────────────────────────────────────────────────────────

export interface BreakdownItem {
  key: string;
  label: string;
  count: number;
}

export interface TimePoint {
  period: string;
  documents: number;
  questions: number;
}

export interface TopDocument {
  document_id: string;
  filename: string | null;
  citations: number;
  mentions: number;
}

export interface AnalyticsOverview {
  documents_total: number;
  documents_indexed: number;
  documents_pending: number;
  documents_failed: number;
  storage_bytes: number;
  page_count: number;
  chunk_count: number;
  entity_count: number;
  entity_mention_count: number;
  profile_count: number;
  average_profile_confidence: number | null;
  conversations: number;
  questions_asked: number;
  answers_found: number;
  abstentions: number;
  abstention_rate: number;
  citation_count: number;
  searches: number;
  comparisons: number;
  research_reports: number;
  extraction_runs: number;
  extraction_rows: number;
  graph_nodes: number;
  graph_edges: number;
  generated_at: string | null;
}

export interface Analytics {
  overview: AnalyticsOverview;
  documents_by_type: BreakdownItem[];
  documents_by_status: BreakdownItem[];
  timeline: TimePoint[];
  top_cited: TopDocument[];
  top_entities: BreakdownItem[];
}

// ── Conversation sharing ─────────────────────────────────────────────────────

export interface Share {
  id: string;
  conversation_id: string;
  shared_with_user_id: string;
  shared_with_email: string | null;
  shared_with_name: string | null;
  permission: "read" | "contribute";
  created_by: string | null;
  created_at: string | null;
}

export interface ShareListOut {
  items: Share[];
  total: number;
}

export interface ConversationAccess {
  conversation_id: string;
  access: string;
  can_read: boolean;
  can_contribute: boolean;
}
