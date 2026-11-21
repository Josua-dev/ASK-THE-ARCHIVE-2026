/**
 * API client.
 *
 * The browser never holds database URLs, model endpoints or any other secret —
 * it only ever talks to our own backend through the Next.js rewrite proxy.
 *
 * The access token is short-lived and kept in memory only. The refresh token
 * is issued to this browser by the backend on login; we keep it in
 * localStorage because the backend returns it in the response body rather than
 * an httpOnly cookie. It is still scoped to this origin and never leaves the
 * browser except to our own /auth/refresh endpoint.
 */

import type {
  AdminStats,
  Answer,
  ArchiveDocument,
  ArchiveInsight,
  AuditEntry,
  CheckinResponse,
  CheckoutResponse,
  ComparisonListItem,
  ComparisonListOut,
  Conversation,
  ConversationAccess,
  DocumentComparison,
  DocumentList,
  DocumentProfile,
  DocumentLocation,
  EntityDetail,
  ExtractionListItem,
  ExtractionListOut,
  ExtractionRun,
  GraphResponse,
  InsightListOut,
  Permission,
  ProfileEntry,
  ResearchListOut,
  ResearchReport,
  ResearchReportSummary,
  Role,
  SearchResult,
  Share,
  ShareListOut,
  SharedConversation,
  StoredMessage,
  Summary,
  User,
  WarehouseLayout,
} from "./types";

const BASE = process.env.NEXT_PUBLIC_API_BASE || "/api/v1";
const REFRESH_KEY = "ata.refresh_token";

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}
export function getAccessToken() {
  return accessToken;
}
export function getRefreshToken() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(REFRESH_KEY);
}
export function clearTokens() {
  accessToken = null;
  if (typeof window !== "undefined") window.localStorage.removeItem(REFRESH_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
    if (Array.isArray(body?.detail)) {
      return body.detail
        .map((d: { msg?: string }) => d?.msg ?? JSON.stringify(d))
        .join("; ");
    }
    if (body?.message) return String(body.message);
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return `Request failed (${res.status})`;
  }
}

async function rawRequest<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

  if (res.status === 401 && retry && !path.startsWith("/auth/")) {
    if (await tryRefresh()) return rawRequest<T>(path, init, false);
  }

  if (!res.ok) throw new ApiError(res.status, await parseError(res));
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Refresh the access token; concurrent callers share one in-flight refresh. */
export async function tryRefresh(): Promise<boolean> {
  if (refreshing) return refreshing;
  const token = getRefreshToken();
  if (!token) return false;
  refreshing = (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: token }),
      });
      if (!res.ok) {
        clearTokens();
        return false;
      }
      const data = await res.json();
      accessToken = data.access_token;
      if (data.refresh_token) {
        window.localStorage.setItem(REFRESH_KEY, data.refresh_token);
      }
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Build a query string, dropping empty values so the backend sees clean params. */
export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/**
 * A type alias rather than an interface, so it keeps the implicit index
 * signature that `qs` expects when it is spread into a query string.
 */
export type DocumentQuery = {
  doc_type?: string;
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

export interface ShareUser {
  id: string;
  display_name: string;
  email: string;
  role: Role;
}

export const api = {
  health: () => rawRequest<Record<string, unknown>>("/health"),

  async login(email: string, password: string) {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new ApiError(res.status, await parseError(res));
    const data = await res.json();
    accessToken = data.access_token;
    if (typeof window !== "undefined" && data.refresh_token) {
      window.localStorage.setItem(REFRESH_KEY, data.refresh_token);
    }
    return data;
  },

  logout() {
    clearTokens();
  },

  me: () => rawRequest<User>("/auth/me"),

  /* --------------------------------------------------------------- chat */

  ask: (question: string, conversationId?: string | null) =>
    rawRequest<Answer>("/chat/ask", {
      method: "POST",
      body: JSON.stringify({ question, conversation_id: conversationId ?? null }),
    }),

  conversations: () => rawRequest<Conversation[]>("/chat/conversations"),

  messages: (id: string) =>
    rawRequest<StoredMessage[]>(`/chat/conversations/${id}/messages`),

  /* ----------------------------------------------------------- documents */

  documents: (query: DocumentQuery = {}) =>
    rawRequest<DocumentList>(`/documents${qs(query)}`),

  document: (id: string) => rawRequest<ArchiveDocument>(`/documents/${id}`),

  preview: (id: string) =>
    rawRequest<{
      id: string;
      filename: string;
      doc_type: string | null;
      expiry_date: string | null;
      status: string;
      pages: {
        chunk_index: number;
        page_start: number;
        page_end: number;
        text: string;
      }[];
    }>(`/documents/${id}/preview`),

  download: (id: string) =>
    rawRequest<{ url: string; expires_in: number }>(`/documents/${id}/download`),

  /**
   * Download the original file.
   *
   * The backend returns a short-lived signed link scoped to this document.
   * The link already carries its own authority in the `token` query string,
   * so it must be fetched WITHOUT an Authorization header — sending a
   * second credential makes the request ambiguous and the backend refuses it.
   */
  downloadBlob: async (id: string, filename: string) => {
    const { url } = await api.download(id);
    const res = await fetch(url);
    if (!res.ok) throw new ApiError(res.status, await parseError(res));
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
  },

  upload: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return rawRequest<ArchiveDocument>("/documents", { method: "POST", body: form });
  },

  deleteDocument: (id: string) =>
    rawRequest<void>(`/documents/${id}`, { method: "DELETE" }),

  /* ----------------------------------------------------------- warehouse */

  /** Where a document physically sits in the archive. */
  location: (id: string) =>
    rawRequest<DocumentLocation>(`/documents/${id}/location`),

  /**
   * Assign or clear a document's slot.
   *
   * All four parts are sent, or all four are null to clear the location. The
   * backend refuses a partial tuple, an unknown value and an occupied slot.
   */
  setLocation: (
    id: string,
    body: {
      zone: string | null;
      rack: string | null;
      shelf: string | null;
      box: string | null;
    },
  ) =>
    rawRequest<DocumentLocation>(`/documents/${id}/location`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  /** Put the document in the first free slot. */
  autoLocation: (id: string) =>
    rawRequest<DocumentLocation>(`/documents/${id}/location/auto`, {
      method: "POST",
    }),

  /**
   * The warehouse vocabulary and the occupied slots the caller may read.
   *
   * The vocabulary comes from the backend so the two can never drift; the
   * frontend never hardcodes zone, rack, shelf or box names.
   */
  warehouseLayout: () => rawRequest<WarehouseLayout>("/warehouse/layout"),

  /** Physically check a document out of the archive. */
  checkout: (id: string, body: {due_at?: string }) =>
    rawRequest<CheckoutResponse>(`/documents/${id}/checkout`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Return a checked-out document to the archive. */
  checkin: (id: string) =>
    rawRequest<CheckinResponse>(`/documents/${id}/checkin`, {
      method: "POST",
    }),

  permissions: (id: string) =>
    rawRequest<Permission[]>(`/documents/${id}/permissions`),

  addPermission: (
    id: string,
    body: {
      grantee_type: "user" | "role";
      grantee_user_id?: string | null;
      grantee_role?: string | null;
      permission: "view" | "download" | "manage";
    },
  ) =>
    rawRequest<Permission>(`/documents/${id}/permissions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  removePermission: (
    id: string,
    body: {
      grantee_type: "user" | "role";
      grantee_user_id?: string | null;
      grantee_role?: string | null;
      permission: "view" | "download" | "manage";
    },
  ) =>
    rawRequest<{ removed: number }>(`/documents/${id}/permissions`, {
      method: "DELETE",
      body: JSON.stringify(body),
    }),

  summary: (id: string) => rawRequest<Summary>(`/summaries/${id}`),

  createSummary: (id: string) =>
    rawRequest<Summary>(`/summaries/${id}`, { method: "POST" }),

  /* ------------------------------------------------------------- search */

  search: (q: string, topK = 10, docType?: string | null) =>
    rawRequest<SearchResult>(
      `/search${qs({ q, top_k: topK, doc_type: docType ?? undefined })}`,
    ),

  /* ----------------------------------------------------------- profiles */

  profile: (documentId: string) =>
    rawRequest<DocumentProfile>(`/profiles/${documentId}`),

  createProfile: (documentId: string) =>
    rawRequest<DocumentProfile>(`/profiles/${documentId}`, { method: "POST" }),

  /* ------------------------------------------------------------ compare */

  compare: (body: {
    document_a_id: string;
    document_b_id: string;
    instruction?: string | null;
  }) =>
    rawRequest<DocumentComparison>("/compare", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  comparisons: (limit = 25, offset = 0) =>
    rawRequest<ComparisonListOut>(`/compare${qs({ limit, offset })}`),

  comparison: (id: string) =>
    rawRequest<DocumentComparison>(`/compare/${id}`),

  /* ----------------------------------------------------------- research */

  research: (body: {
    question: string;
    conversation_id?: string | null;
    instruction?: string | null;
  }) =>
    rawRequest<ResearchReport>("/research", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  researchReports: (limit = 25, offset = 0) =>
    rawRequest<ResearchListOut>(`/research${qs({ limit, offset })}`),

  researchReport: (id: string) =>
    rawRequest<ResearchReport>(`/research/${id}`),

  /* -------------------------------------------------------------- graph */

  graph: (query: {
    doc_type?: string | null;
    kind?: string | null;
    min_weight?: number | null;
    max_nodes?: number | null;
  } = {}) => rawRequest<GraphResponse>(`/graph${qs(query)}`),

  entity: (entityId: string) =>
    rawRequest<EntityDetail>(`/graph/entities/${entityId}`),

  /* ---------------------------------------------------------- extraction */

  createExtraction: (body: {
    instruction: string;
    document_ids: string[];
    columns: { key: string; label: string; type: string }[];
    max_rows?: number | null;
  }) =>
    rawRequest<ExtractionRun>("/extractions", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  extractions: (limit = 25, offset = 0) =>
    rawRequest<ExtractionListOut>(`/extractions${qs({ limit, offset })}`),

  extraction: (runId: string) =>
    rawRequest<ExtractionRun>(`/extractions/${runId}`),

  /* ----------------------------------------------------------- insights */

  insights: (query: { status?: string | null; kind?: string | null; limit?: number } = {}) =>
    rawRequest<InsightListOut>(`/insights${qs(query)}`),

  scanInsights: () =>
    rawRequest<InsightListOut>("/insights/scan", { method: "POST" }),

  updateInsight: (id: string, status: string) =>
    rawRequest<ArchiveInsight>(`/insights/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  /* ----------------------------------------------------------- analytics */

  analytics: () => rawRequest<import("./types").Analytics>("/analytics"),

  /* --------------------------------------------------------------- admin */

  adminUsers: () =>
    rawRequest<{ items: User[]; total: number }>("/admin/users"),

  adminCreateUser: (body: {
    email: string;
    display_name: string;
    password: string;
    role: Role;
  }) =>
    rawRequest<User>("/admin/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  adminUpdateUser: (
    id: string,
    body: Partial<{
      display_name: string;
      role: Role;
      is_active: boolean;
      password: string;
    }>,
  ) =>
    rawRequest<User>(`/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  adminDeleteUser: (id: string) =>
    rawRequest<void>(`/admin/users/${id}`, { method: "DELETE" }),

  adminAudit: (limit = 100, action?: string | null) =>
    rawRequest<AuditEntry[]>(`/admin/audit${qs({ limit, action: action ?? undefined })}`),

  adminStats: () => rawRequest<AdminStats>("/admin/stats"),

  /* ------------------------------------------------------------- sharing */

  sharedWithMe: () =>
    rawRequest<SharedConversation[]>("/conversations/shared-with-me"),

  shareableUsers: () => rawRequest<ShareUser[]>("/conversations/users"),

  conversationAccess: (id: string) =>
    rawRequest<ConversationAccess>(`/conversations/${id}/access`),

  conversationShares: (id: string) =>
    rawRequest<ShareListOut>(`/conversations/${id}/shares`),

  shareConversation: (id: string, body: { shared_with_user_id: string; permission: string }) =>
    rawRequest<Share>(`/conversations/${id}/shares`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  revokeShare: (id: string, userId: string) =>
    rawRequest<void>(`/conversations/${id}/shares/${userId}`, { method: "DELETE" }),
};

export interface StreamHandlers {
  onEvidence?: (payload: {
    intent: string;
    found: boolean;
    passages: import("./types").Passage[];
  }) => void;
  onDelta?: (text: string) => void;
  onCitations?: (citations: import("./types").Citation[]) => void;
  onDone?: (payload: Record<string, unknown>) => void;
  onError?: (message: string) => void;
}

/** Stream an answer as SSE, surfacing each frame to the caller as it lands. */
export async function streamAnswer(
  question: string,
  handlers: StreamHandlers,
  conversationId?: string | null,
): Promise<void> {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({
      question,
      conversation_id: conversationId ?? null,
    }),
  });

  if (!res.ok || !res.body) {
    handlers.onError?.(await parseError(res));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (raw: string) => {
    let event = "";
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (!data.length) return;
    const text = data.join("\n");
    let payload: any = text;
    try {
      payload = JSON.parse(text);
    } catch {
      /* plain-text frame */
    }
    switch (event) {
      case "evidence":
        handlers.onEvidence?.(payload);
        break;
      case "delta":
        handlers.onDelta?.(payload?.text ?? String(payload));
        break;
      case "citations":
        handlers.onCitations?.(payload?.citations ?? []);
        break;
      case "done":
        handlers.onDone?.(payload);
        break;
      case "error":
        handlers.onError?.(payload?.message ?? "Generation failed");
        break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) if (part.trim()) dispatch(part);
  }
  if (buffer.trim()) dispatch(buffer);
}

export type {
  ComparisonListItem,
  DocumentComparison,
  DocumentProfile,
  EntityDetail,
  ExtractionListItem,
  ExtractionRun,
  GraphResponse,
  InsightListOut,
  ProfileEntry,
  ResearchListOut,
  ResearchReport,
  ResearchReportSummary,
};
