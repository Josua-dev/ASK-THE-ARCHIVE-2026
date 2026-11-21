"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  FileText,
  KeyRound,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserRound,
  UsersRound,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import type { DocumentList, Permission, Role, User } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { PageBody, PageHeader } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  LoadingPanel,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label, Separator } from "@/components/ui/primitives";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ROLES: Role[] = ["admin", "analyst", "viewer"];

const LEVELS: Permission["permission"][] = ["view", "download", "manage"];

const LEVEL_VARIANT: Record<
  Permission["permission"],
  "default" | "accent" | "success" | "warning" | "danger"
> = {
  view: "default",
  download: "accent",
  manage: "warning",
};

const LEVEL_BLURB: Record<Permission["permission"], string> = {
  view: "May open the document and read its passages.",
  download: "May open and download the original file.",
  manage: "May open, download and change the document's access list.",
};

export default function AdminPermissionsPage() {
  const { user } = useAuth();
  const toast = useToast();

  const isAdmin = user?.role === "admin";

  const [docs, setDocs] = useState<DocumentList | null>(null);
  const [accounts, setAccounts] = useState<User[]>([]);
  const [documentId, setDocumentId] = useState<string>("");
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [loadingPermissions, setLoadingPermissions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [granteeType, setGranteeType] = useState<"user" | "role">("user");
  const [granteeUserId, setGranteeUserId] = useState("");
  const [granteeRole, setGranteeRole] = useState<Role>("viewer");
  const [level, setLevel] = useState<Permission["permission"]>("view");
  const [formError, setFormError] = useState<string | null>(null);

  const loadDocuments = useCallback(async () => {
    setLoadingDocs(true);
    setError(null);
    try {
      const [documents, users] = await Promise.all([
        api.documents({ limit: 200 }),
        api.adminUsers(),
      ]);
      setDocs(documents);
      setAccounts(users.items);
      setDocumentId((current) => current || documents.items[0]?.id || "");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not load the documents.",
      );
    } finally {
      setLoadingDocs(false);
    }
  }, []);

  const loadPermissions = useCallback(async (id: string) => {
    if (!id) {
      setPermissions([]);
      return;
    }
    setLoadingPermissions(true);
    try {
      setPermissions(await api.permissions(id));
    } catch (err) {
      toast.error(
        "Could not load the permissions",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setLoadingPermissions(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!isAdmin) {
      setLoadingDocs(false);
      return;
    }
    loadDocuments();
  }, [isAdmin, loadDocuments]);

  useEffect(() => {
    if (!isAdmin) return;
    loadPermissions(documentId);
  }, [isAdmin, documentId, loadPermissions]);

  const accountById = useMemo(() => {
    const map = new Map<string, User>();
    accounts.forEach((account) => map.set(account.id, account));
    return map;
  }, [accounts]);

  const selectedDocument = useMemo(
    () => docs?.items.find((doc) => doc.id === documentId) ?? null,
    [docs, documentId],
  );

  async function grant(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);

    const body: Parameters<typeof api.addPermission>[1] = {
      grantee_type: granteeType,
      permission: level,
    };
    if (granteeType === "user") {
      if (!granteeUserId) {
        setFormError("Choose the person who should receive the access.");
        return;
      }
      body.grantee_user_id = granteeUserId;
      body.grantee_role = null;
    } else {
      body.grantee_role = granteeRole;
      body.grantee_user_id = null;
    }

    setBusy(true);
    try {
      await api.addPermission(documentId, body);
      toast.success(
        "Access granted",
        `${granteeType === "user" ? "The person" : `The ${granteeRole} role`} can now ${level}.`,
      );
      setGranteeUserId("");
      await loadPermissions(documentId);
    } catch (err) {
      const message = err instanceof Error ? err.message : undefined;
      setFormError(message ?? "The access could not be granted.");
      toast.error("Could not grant access", message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(permission: Permission) {
    setBusy(true);
    try {
      const result = await api.removePermission(documentId, {
        grantee_type: permission.grantee_type,
        grantee_user_id: permission.grantee_user_id,
        grantee_role: permission.grantee_role,
        permission: permission.permission,
      });
      toast.success(
        "Access revoked",
        result.removed > 0
          ? "The grant was removed."
          : "That grant was already gone.",
      );
      await loadPermissions(documentId);
    } catch (err) {
      toast.error(
        "Could not revoke the access",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }

  if (!isAdmin) {
    return (
      <PageBody>
        <PageHeader
          eyebrow="Administration"
          title="Permissions"
          description="Document-level access control."
        />
        <EmptyState
          className="mt-6 panel border-dashed"
          icon={<ShieldAlert className="h-4 w-4" />}
          title="Administrator access required"
          description="Changing who may read which document is reserved for administrators. Sign in with an administrator account to manage document access."
        />
      </PageBody>
    );
  }

  return (
    <PageBody>
      <PageHeader
        eyebrow="Administration"
        title="Permissions"
        description="Document-level access control. A grant is matched against the reader on every request — retrieval, preview and download all resolve through the same rules, so a change here takes effect immediately."
      />

      {error && (
        <ErrorState className="mt-6" message={error} onRetry={loadDocuments} />
      )}

      {/* Document selector */}
      <section className="mt-6 panel p-4 shadow-panel">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <label
              htmlFor="permission-document"
              className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
            >
              Document
            </label>
            <Select value={documentId} onValueChange={setDocumentId}>
              <SelectTrigger id="permission-document">
                <SelectValue placeholder="Choose a document…" />
              </SelectTrigger>
              <SelectContent>
                {(docs?.items ?? []).map((doc) => (
                  <SelectItem key={doc.id} value={doc.id}>
                    {doc.title || doc.filename}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedDocument && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="chip bg-muted text-muted-foreground">
                <FileText className="h-3 w-3" />
                {selectedDocument.filename}
              </span>
              <Link
                href={`/library/${selectedDocument.id}`}
                className="text-[12px] font-medium text-accent transition-colors hover:underline"
              >
                Open the document
              </Link>
            </div>
          )}
        </div>

        {loadingDocs && (
          <p className="mt-3 flex items-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading the document list…
          </p>
        )}
      </section>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1.45fr_1fr]">
        {/* Grants */}
        <section className="panel p-4 shadow-panel">
          <p className="label flex items-center gap-1.5">
            <KeyRound className="h-3 w-3" />
            Access list
          </p>

          {!documentId ? (
            <EmptyState
              className="mt-3 border-0 px-2 py-10"
              icon={<FileText className="h-4 w-4" />}
              title="Choose a document"
              description="Pick a document above to see who may open it."
            />
          ) : loadingPermissions ? (
            <div className="mt-3">
              <LoadingPanel label="Reading the access list…" rows={4} />
            </div>
          ) : permissions.length === 0 ? (
            <EmptyState
              className="mt-3 border-0 px-2 py-10"
              icon={<ShieldCheck className="h-4 w-4" />}
              title="No explicit grants"
              description="Nobody outside the administrators and the uploader has a named grant on this document. Grant access on the right."
            />
          ) : (
            <div className="mt-2.5 overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Granted to</th>
                    <th>Level</th>
                    <th>Granted by</th>
                    <th>When</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {permissions.map((permission) => {
                    const granteeUser =
                      permission.grantee_user_id
                        ? accountById.get(permission.grantee_user_id)
                        : undefined;
                    const grantedBy = permission.granted_by
                      ? accountById.get(permission.granted_by)
                      : undefined;

                    return (
                      <tr key={permission.id}>
                        <td>
                          <p className="flex items-center gap-1.5 text-[13px] font-medium">
                            {permission.grantee_type === "user" ? (
                              <UserRound className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <UsersRound className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            {permission.grantee_type === "user"
                              ? (granteeUser?.display_name ??
                                `Account ${permission.grantee_user_id?.slice(0, 8)}`)
                              : `Role: ${permission.grantee_role}`}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {permission.grantee_type === "user"
                              ? (granteeUser?.email ??
                                "User grant")
                              : "Every account holding this role"}
                          </p>
                        </td>
                        <td>
                          <Badge variant={LEVEL_VARIANT[permission.permission]}>
                            {permission.permission}
                          </Badge>
                        </td>
                        <td className="text-[12px] text-muted-foreground">
                          {grantedBy
                            ? grantedBy.display_name
                            : permission.granted_by
                              ? `Account ${permission.granted_by.slice(0, 8)}`
                              : "—"}
                        </td>
                        <td className="font-mono text-[11px] text-muted-foreground">
                          {formatDate(permission.granted_at)}
                        </td>
                        <td>
                          <div className="flex justify-end">
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => revoke(permission)}
                            >
                              <Trash2 className="h-3 w-3" />
                              Revoke
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Grant form */}
        <section className="panel p-4 shadow-panel">
          <p className="label flex items-center gap-1.5">
            <ShieldCheck className="h-3 w-3" />
            Grant access
          </p>

          {!documentId ? (
            <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
              Choose a document before granting access.
            </p>
          ) : (
            <form onSubmit={grant} className="mt-3 space-y-3.5">
              <div>
                <Label htmlFor="grant-type">Grant to</Label>
                <Select
                  value={granteeType}
                  onValueChange={(value) =>
                    setGranteeType(value as "user" | "role")
                  }
                >
                  <SelectTrigger id="grant-type" className="mt-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">A specific person</SelectItem>
                    <SelectItem value="role">Everyone with a role</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {granteeType === "user" ? (
                <div>
                  <Label htmlFor="grant-user">Person</Label>
                  <Select
                    value={granteeUserId}
                    onValueChange={setGranteeUserId}
                  >
                    <SelectTrigger id="grant-user" className="mt-1.5">
                      <SelectValue placeholder="Choose an account…" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.display_name} · {account.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div>
                  <Label htmlFor="grant-role">Role</Label>
                  <Select
                    value={granteeRole}
                    onValueChange={(value) =>
                      setGranteeRole(value as Role)
                    }
                  >
                    <SelectTrigger id="grant-role" className="mt-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((role) => (
                        <SelectItem key={role} value={role}>
                          {role}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div>
                <Label htmlFor="grant-level">Level</Label>
                <Select
                  value={level}
                  onValueChange={(value) =>
                    setLevel(value as Permission["permission"])
                  }
                >
                  <SelectTrigger id="grant-level" className="mt-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEVELS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  {LEVEL_BLURB[level]}
                </p>
              </div>

              {formError && (
                <p
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger/6 px-3 py-2 text-[11px] leading-relaxed text-danger"
                >
                  {formError}
                </p>
              )}

              <Separator />

              <Button type="submit" disabled={busy} className="w-full">
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
                Grant access
              </Button>
            </form>
          )}
        </section>
      </div>

      <p className="mt-5 flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
        <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
        Administrators bypass the access list entirely, and whoever uploaded a
        document always keeps access to it. A grant of download or manage
        implies the right to view.
      </p>
    </PageBody>
  );
}
