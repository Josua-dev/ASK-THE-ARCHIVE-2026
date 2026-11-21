"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { api, type ShareUser } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type {
  Conversation,
  ConversationAccess,
  Share,
  SharedConversation,
  StoredMessage,
} from "@/lib/types";
import { cn, formatDate, formatRelative } from "@/lib/utils";
import { PageBody, PageHeader } from "@/components/ui";
import { EmptyState, ErrorState, LoadingPanel } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label, Separator } from "@/components/ui/primitives";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Access = "owner" | "contribute" | "read";

/**
 * Normalise whatever the backend hands back into one of the three access
 * levels. The conversations endpoint is being updated to carry an `access`
 * field; until it does, a conversation without one belongs to the caller.
 */
function normaliseAccess(value: string | null | undefined): Access {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "contribute") return "contribute";
  if (raw === "read") return "read";
  return "owner";
}

export default function ConversationsPage() {
  const toast = useToast();

  const [mine, setMine] = useState<Conversation[]>([]);
  const [shared, setShared] = useState<SharedConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<StoredMessage[] | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [accessState, setAccessState] = useState<ConversationAccess | null>(null);

  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);

  const [shareOpen, setShareOpen] = useState(false);
  const [shareableUsers, setShareableUsers] = useState<ShareUser[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState("");
  const [sharePermission, setSharePermission] = useState<"read" | "contribute">(
    "read",
  );
  const [granting, setGranting] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [owned, sharedWithMe] = await Promise.all([
        api.conversations(),
        // The shared list is a nice-to-have; a failure here must not stop
        // the caller's own conversations from loading.
        api.sharedWithMe().catch(() => [] as SharedConversation[]),
      ]);

      const ownedList: Conversation[] = [];
      const sharedList: SharedConversation[] = [];

      for (const conversation of owned) {
        const access = normaliseAccess(conversation.access);
        if (access === "owner") {
          ownedList.push(conversation);
        } else {
          sharedList.push({
            id: conversation.id,
            title: conversation.title,
            created_at: conversation.created_at,
            access,
          });
        }
      }

      for (const conversation of sharedWithMe) {
        if (sharedList.some((entry) => entry.id === conversation.id)) continue;
        sharedList.push({
          id: conversation.id,
          title: conversation.title,
          created_at: conversation.created_at,
          access: normaliseAccess(conversation.access),
        });
      }

      setMine(ownedList);
      setShared(sharedList);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not load your conversations.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadMessages = useCallback(async (id: string) => {
    setMessagesLoading(true);
    setMessagesError(null);
    try {
      setMessages(await api.messages(id));
    } catch (err) {
      setMessages(null);
      setMessagesError(
        err instanceof Error ? err.message : "Could not load this conversation.",
      );
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setMessages(null);
      setMessagesError(null);
      setAccessState(null);
      return;
    }
    let cancelled = false;
    loadMessages(selectedId);
    api
      .conversationAccess(selectedId)
      .then((state) => {
        if (!cancelled) setAccessState(state);
      })
      .catch(() => {
        if (!cancelled) setAccessState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, loadMessages]);

  const selectedEntry = useMemo(() => {
    const owned = mine.find((entry) => entry.id === selectedId);
    if (owned) return owned;
    return shared.find((entry) => entry.id === selectedId) ?? null;
  }, [mine, shared, selectedId]);

  const access = useMemo<Access>(() => {
    const fromEndpoint = accessState?.access
      ? normaliseAccess(accessState.access)
      : null;
    if (fromEndpoint) return fromEndpoint;
    if (!selectedEntry) return "owner";
    return normaliseAccess(selectedEntry.access);
  }, [accessState, selectedEntry]);

  const isOwner = access === "owner";
  const canContribute =
    accessState?.can_contribute ?? (access === "owner" || access === "contribute");

  async function askIntoConversation(event: React.FormEvent) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || !selectedId || asking) return;
    setAsking(true);
    try {
      await api.ask(question, selectedId);
      setDraft("");
      await loadMessages(selectedId);
      toast.success("Added to the conversation");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "The question could not be sent.";
      toast.error("The question was not sent", message);
    } finally {
      setAsking(false);
    }
  }

  useEffect(() => {
    if (!shareOpen || !selectedId) return;
    let cancelled = false;
    setShareLoading(true);
    setShareError(null);
    Promise.all([api.shareableUsers(), api.conversationShares(selectedId)])
      .then(([users, shareList]) => {
        if (cancelled) return;
        setShareableUsers(users);
        setShares(shareList.items);
      })
      .catch((err) => {
        if (cancelled) return;
        setShareError(
          err instanceof Error
            ? err.message
            : "Could not load the sharing details.",
        );
      })
      .finally(() => {
        if (!cancelled) setShareLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shareOpen, selectedId]);

  async function grantShare() {
    if (!selectedId || !shareTarget) return;
    setGranting(true);
    setShareError(null);
    try {
      await api.shareConversation(selectedId, {
        shared_with_user_id: shareTarget,
        permission: sharePermission,
      });
      const refreshed = await api.conversationShares(selectedId);
      setShares(refreshed.items);
      setShareTarget("");
      toast.success(
        "Conversation shared",
        sharePermission === "read"
          ? "The recipient can read it."
          : "The recipient can read it and add questions.",
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "The conversation could not be shared.";
      setShareError(message);
      toast.error("Could not share", message);
    } finally {
      setGranting(false);
    }
  }

  async function revokeShare(userId: string) {
    if (!selectedId) return;
    setRevokingId(userId);
    setShareError(null);
    try {
      await api.revokeShare(selectedId, userId);
      setShares((all) =>
        all.filter((share) => share.shared_with_user_id !== userId),
      );
      toast.success("Share revoked");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "The share could not be revoked.";
      setShareError(message);
      toast.error("Could not revoke the share", message);
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <PageBody>
      <PageHeader
        eyebrow="Workspace"
        title="Conversations"
        description="Every question you have put to the archive, and the conversations other people have shared with you. Only the owner of a conversation can share it."
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        }
      />

      {error && (
        <ErrorState
          className="mt-6"
          title="The conversations could not be loaded"
          message={error}
          onRetry={load}
        />
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        {/* ── Conversation list ─────────────────────────────────────── */}
        <aside className="panel flex flex-col overflow-hidden shadow-panel lg:max-h-[calc(100vh-13rem)]">
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-4">
                <LoadingPanel label="Loading conversations…" rows={4} />
              </div>
            ) : (
              <>
                <p className="label border-b border-border px-4 py-2.5">
                  Yours
                  <span className="ml-2 font-mono">{mine.length}</span>
                </p>
                {mine.length === 0 ? (
                  <p className="px-4 py-5 text-[12px] leading-relaxed text-muted-foreground">
                    You have not asked the archive anything yet.
                  </p>
                ) : (
                  mine.map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      id={conversation.id}
                      title={conversation.title}
                      createdAt={conversation.created_at}
                      access="owner"
                      selected={selectedId === conversation.id}
                      onSelect={setSelectedId}
                    />
                  ))
                )}

                <p className="label border-y border-border px-4 py-2.5">
                  Shared with you
                  <span className="ml-2 font-mono">{shared.length}</span>
                </p>
                {shared.length === 0 ? (
                  <p className="px-4 py-5 text-[12px] leading-relaxed text-muted-foreground">
                    No one has shared a conversation with you yet.
                  </p>
                ) : (
                  shared.map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      id={conversation.id}
                      title={conversation.title}
                      createdAt={conversation.created_at}
                      access={normaliseAccess(conversation.access)}
                      selected={selectedId === conversation.id}
                      onSelect={setSelectedId}
                    />
                  ))
                )}
              </>
            )}
          </div>
        </aside>

        {/* ── Transcript ─────────────────────────────────────────────── */}
        <section className="panel flex flex-col overflow-hidden shadow-panel lg:max-h-[calc(100vh-13rem)]">
          {!selectedId ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                className="border-0"
                icon={<MessageSquare className="h-4 w-4" />}
                title="Select a conversation"
                description="Pick a conversation on the left to read the questions you asked and the answers the archive gave."
              />
            </div>
          ) : (
            <>
              <header className="border-b border-border px-4 py-3.5 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="label">
                      {isOwner ? "Your conversation" : "Shared with you"}
                    </p>
                    <h2 className="mt-1 truncate text-[15px] font-semibold tracking-tight">
                      {selectedEntry?.title || "Untitled conversation"}
                    </h2>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {selectedEntry?.created_at
                        ? `Started ${formatDate(selectedEntry.created_at)}`
                        : "No date recorded"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <AccessBadge access={access} />
                    {isOwner && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShareOpen(true)}
                      >
                        <Users className="h-3.5 w-3.5" />
                        Share
                      </Button>
                    )}
                  </div>
                </div>

                {!isOwner && (
                  <p className="mt-3 flex items-start gap-2 rounded-md border border-border bg-background px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                    <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0" />
                    {canContribute
                      ? "You have contribute access: you can read this conversation and add questions to it."
                      : "You have read access: you can read this conversation, but you cannot add to it."}
                  </p>
                )}
              </header>

              <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">
                {messagesLoading ? (
                  <LoadingPanel label="Loading the transcript…" rows={4} />
                ) : messagesError ? (
                  <ErrorState
                    message={messagesError}
                    onRetry={() => loadMessages(selectedId)}
                  />
                ) : !messages || messages.length === 0 ? (
                  <EmptyState
                    className="border-0"
                    icon={<MessageSquare className="h-4 w-4" />}
                    title="Nothing in this conversation yet"
                    description="When a question is asked here, the question and the archive's answer appear in this transcript."
                  />
                ) : (
                  <ol className="space-y-4">
                    {messages.map((message) => (
                      <li key={message.id}>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="label">
                            {message.role === "user" ? "You" : "Archive"}
                          </p>
                          {message.created_at && (
                            <span
                              className="font-mono text-[10px] text-muted-foreground"
                              title={formatDate(message.created_at)}
                            >
                              {formatRelative(message.created_at)}
                            </span>
                          )}
                          {message.role === "assistant" &&
                            message.answer_found === false && (
                              <span className="chip bg-warning/15 text-warning">
                                no answer found
                              </span>
                            )}
                        </div>
                        {/* Messages are stored text and are rendered as text. */}
                        <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
                          {message.content}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              {canContribute && (
                <form
                  onSubmit={askIntoConversation}
                  className="border-t border-border bg-background/60 p-3 sm:p-4"
                >
                  <Label htmlFor="conversation-question">
                    Add a question to this conversation
                  </Label>
                  <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-end">
                    <Textarea
                      id="conversation-question"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={2}
                      placeholder="Ask a follow-up…"
                      className="flex-1 resize-none"
                      disabled={asking}
                    />
                    <Button
                      type="submit"
                      variant="accent"
                      disabled={asking || !draft.trim()}
                      className="sm:mb-0"
                    >
                      {asking ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Asking
                        </>
                      ) : (
                        <>
                          <Send className="h-4 w-4" />
                          Ask
                        </>
                      )}
                    </Button>
                  </div>
                </form>
              )}
            </>
          )}
        </section>
      </div>

      {/* ── Share dialog ─────────────────────────────────────────────── */}
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Share this conversation</DialogTitle>
            <DialogDescription>
              Only the owner can share. A recipient with read access sees the
              transcript; contribute access also lets them ask new questions
              in it.
            </DialogDescription>
          </DialogHeader>

          {shareError && (
            <ErrorState message={shareError} onRetry={() => setShareOpen(true)} />
          )}

          {shareLoading ? (
            <LoadingPanel label="Loading people and shares…" rows={3} />
          ) : (
            <>
              <div className="space-y-2">
                <p className="label">Current shares</p>
                {shares.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-3 text-[12px] leading-relaxed text-muted-foreground">
                    This conversation is not shared with anyone yet.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {shares.map((share) => (
                      <li
                        key={share.id}
                        className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[12px] font-medium">
                            {share.shared_with_name || share.shared_with_email}
                          </span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {share.shared_with_email}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <Badge
                            variant={
                              share.permission === "contribute"
                                ? "accent"
                                : "outline"
                            }
                          >
                            {share.permission}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="iconSm"
                            aria-label={`Revoke access for ${
                              share.shared_with_name || share.shared_with_email
                            }`}
                            disabled={revokingId === share.shared_with_user_id}
                            onClick={() => revokeShare(share.shared_with_user_id)}
                          >
                            {revokingId === share.shared_with_user_id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <Separator />

              <div className="space-y-3">
                <p className="label">Share with someone</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="share-user">Person</Label>
                    <Select
                      value={shareTarget}
                      onValueChange={setShareTarget}
                    >
                      <SelectTrigger id="share-user" className="mt-1.5">
                        <SelectValue placeholder="Choose a colleague" />
                      </SelectTrigger>
                      <SelectContent>
                        {shareableUsers.length === 0 ? (
                          <div className="px-2 py-3 text-[12px] text-muted-foreground">
                            There is nobody else to share with.
                          </div>
                        ) : (
                          shareableUsers.map((person) => (
                            <SelectItem key={person.id} value={person.id}>
                              {person.display_name} — {person.role}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label htmlFor="share-permission">Permission</Label>
                    <Select
                      value={sharePermission}
                      onValueChange={(value) =>
                        setSharePermission(value === "contribute" ? "contribute" : "read")
                      }
                    >
                      <SelectTrigger id="share-permission" className="mt-1.5">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="read">Read only</SelectItem>
                        <SelectItem value="contribute">
                          Read and contribute
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setShareOpen(false)}>
              Close
            </Button>
            <Button
              variant="accent"
              onClick={grantShare}
              disabled={granting || !shareTarget || shareLoading}
            >
              {granting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="h-4 w-4" />
              )}
              Share conversation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageBody>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

function ConversationRow({
  id,
  title,
  createdAt,
  access,
  selected,
  onSelect,
}: {
  id: string;
  title: string | null;
  createdAt: string | null;
  access: Access;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full items-start gap-2.5 border-b border-border/70 px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/50",
        selected && "bg-accent/[0.07]",
      )}
    >
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-[12px] font-medium",
            selected && "text-accent",
          )}
        >
          {title || "Untitled conversation"}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <span className="font-mono">{formatRelative(createdAt)}</span>
          {access !== "owner" && <AccessBadge access={access} />}
        </span>
      </span>
    </button>
  );
}

function AccessBadge({ access }: { access: Access }) {
  if (access === "owner") return <Badge variant="outline">owner</Badge>;
  if (access === "contribute") return <Badge variant="accent">contribute</Badge>;
  return <Badge variant="default">read</Badge>;
}
