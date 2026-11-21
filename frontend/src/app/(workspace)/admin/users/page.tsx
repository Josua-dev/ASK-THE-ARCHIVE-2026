"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  KeyRound,
  Loader2,
  Pencil,
  Search,
  ShieldAlert,
  UserPlus,
  Users as UsersIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import type { Role, User } from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";
import { PageBody, PageHeader } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  LoadingPanel,
  StatCard,
} from "@/components/states";
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
import { Input } from "@/components/ui/input";
import { Label, Separator } from "@/components/ui/primitives";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const ROLES: Role[] = ["admin", "analyst", "viewer"];

const ROLE_VARIANT: Record<
  string,
  "default" | "accent" | "success" | "warning" | "danger"
> = {
  admin: "danger",
  analyst: "accent",
  viewer: "default",
};

const ROLE_BLURB: Record<Role, string> = {
  admin: "Full access, including user and permission administration.",
  analyst: "Can ingest documents, extract profiles and rescan the archive.",
  viewer: "Read-only access to the documents they are permitted to open.",
};

export default function AdminUsersPage() {
  const { user } = useAuth();
  const toast = useToast();

  const isAdmin = user?.role === "admin";

  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);

  const [createForm, setCreateForm] = useState({
    email: "",
    display_name: "",
    password: "",
    role: "viewer" as Role,
  });

  const [editForm, setEditForm] = useState({
    display_name: "",
    role: "viewer" as Role,
    is_active: true,
    password: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.adminUsers();
      setUsers(response.items);
      setTotal(response.total);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not load the user directory.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    load();
  }, [isAdmin, load]);

  const roleCounts = useMemo(() => {
    const counts: Record<Role, number> = { admin: 0, analyst: 0, viewer: 0 };
    users.forEach((account) => {
      if (account.role in counts) counts[account.role] += 1;
    });
    return counts;
  }, [users]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return users;
    return users.filter(
      (account) =>
        account.email.toLowerCase().includes(term) ||
        account.display_name.toLowerCase().includes(term) ||
        account.role.toLowerCase().includes(term) ||
        (account.is_active ? "active" : "inactive disabled").includes(term),
    );
  }, [users, query]);

  function openEdit(account: User) {
    setEditing(account);
    setEditForm({
      display_name: account.display_name,
      role: account.role,
      is_active: account.is_active,
      password: "",
    });
  }

  async function createUser(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.adminCreateUser({
        email: createForm.email.trim(),
        display_name: createForm.display_name.trim(),
        password: createForm.password,
        role: createForm.role,
      });
      toast.success(
        "Account created",
        `${createForm.display_name.trim()} can now sign in as ${createForm.role}.`,
      );
      setCreateForm({ email: "", display_name: "", password: "", role: "viewer" });
      setCreating(false);
      await load();
    } catch (err) {
      toast.error(
        "Could not create the account",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    try {
      const body: Parameters<typeof api.adminUpdateUser>[1] = {
        display_name: editForm.display_name.trim(),
        role: editForm.role,
        is_active: editForm.is_active,
      };
      if (editForm.password) body.password = editForm.password;
      await api.adminUpdateUser(editing.id, body);
      toast.success("Account updated", editing.email);
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(
        "Could not update the account",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(account: User) {
    setBusy(true);
    try {
      await api.adminDeleteUser(account.id);
      toast.success(
        "Account deactivated",
        `${account.email} can no longer sign in.`,
      );
      await load();
    } catch (err) {
      toast.error(
        "Could not deactivate the account",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }

  async function reactivate(account: User) {
    setBusy(true);
    try {
      await api.adminUpdateUser(account.id, { is_active: true });
      toast.success("Account reactivated", account.email);
      await load();
    } catch (err) {
      toast.error(
        "Could not reactivate the account",
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
          title="Users"
          description="Account management, roles and access status."
        />
        <EmptyState
          className="mt-6 panel border-dashed"
          icon={<ShieldAlert className="h-4 w-4" />}
          title="Administrator access required"
          description="Managing accounts is reserved for administrators. Sign in with an administrator account to manage users, permissions, the audit trail and the system configuration."
        />
      </PageBody>
    );
  }

  return (
    <PageBody>
      <PageHeader
        eyebrow="Administration"
        title="Users"
        description="Every account that can reach the archive, with the role that decides what it may open. A role change takes effect on the very next query."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <UserPlus className="h-3.5 w-3.5" />
            Create user
          </Button>
        }
      />

      {error && (
        <ErrorState className="mt-6" message={error} onRetry={load} />
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Accounts"
          value={loading ? null : (total ?? 0)}
          hint="Total in the directory"
        />
        <StatCard
          label="Administrators"
          value={loading ? null : roleCounts.admin}
          hint="Full access to the archive"
          tone="danger"
        />
        <StatCard
          label="Analysts"
          value={loading ? null : roleCounts.analyst}
          hint="Can ingest and extract"
          tone="accent"
        />
        <StatCard
          label="Viewers"
          value={loading ? null : roleCounts.viewer}
          hint="Read-only access"
        />
      </div>

      <div className="mt-6 flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <label
            htmlFor="user-search"
            className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
          >
            Find an account
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="user-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, email or role…"
              className="pl-8"
            />
          </div>
        </div>
        {total !== null && users.length < total && (
          <p className="text-[11px] text-muted-foreground">
            Showing the first {users.length} of {total} accounts.
          </p>
        )}
      </div>

      <section className="mt-4 overflow-hidden rounded-lg border border-border bg-surface">
        {loading ? (
          <div className="p-4">
            <LoadingPanel label="Reading the directory…" rows={5} />
          </div>
        ) : users.length === 0 ? (
          <EmptyState
            className="m-4 border-0"
            icon={<UsersIcon className="h-4 w-4" />}
            title="No accounts yet"
            description="Create the first account to give someone access to the archive."
            action={
              <Button size="sm" onClick={() => setCreating(true)}>
                <UserPlus className="h-3.5 w-3.5" />
                Create user
              </Button>
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            className="m-4 border-0"
            icon={<Search className="h-4 w-4" />}
            title="No account matches that search"
            description="Try a different name, email address or role."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <p className="text-[13px] font-medium">
                        {account.display_name}
                        {account.id === user?.id && (
                          <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                            (you)
                          </span>
                        )}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {account.email}
                      </p>
                    </td>
                    <td>
                      <Badge variant={ROLE_VARIANT[account.role] ?? "default"}>
                        {account.role}
                      </Badge>
                    </td>
                    <td>
                      <span
                        className={cn(
                          "chip",
                          account.is_active
                            ? "bg-success/12 text-success"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {account.is_active ? "active" : "deactivated"}
                      </span>
                    </td>
                    <td className="font-mono text-[11px] text-muted-foreground">
                      {formatDate(account.created_at)}
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => openEdit(account)}
                        >
                          <Pencil className="h-3 w-3" />
                          Edit
                        </Button>
                        {account.is_active ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy || account.id === user?.id}
                            title={
                              account.id === user?.id
                                ? "You cannot deactivate your own account"
                                : undefined
                            }
                            onClick={() => deactivate(account)}
                          >
                            Deactivate
                          </Button>
                        ) : (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => reactivate(account)}
                          >
                            Reactivate
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Create */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create an account</DialogTitle>
            <DialogDescription>
              The new account can sign in immediately with the password you
              choose here.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={createUser} className="space-y-3.5">
            <div>
              <Label htmlFor="new-email">Email</Label>
              <Input
                id="new-email"
                type="email"
                required
                autoComplete="off"
                className="mt-1.5"
                value={createForm.email}
                onChange={(event) =>
                  setCreateForm({ ...createForm, email: event.target.value })
                }
              />
            </div>
            <div>
              <Label htmlFor="new-name">Display name</Label>
              <Input
                id="new-name"
                required
                maxLength={200}
                className="mt-1.5"
                value={createForm.display_name}
                onChange={(event) =>
                  setCreateForm({ ...createForm, display_name: event.target.value })
                }
              />
            </div>
            <div>
              <Label htmlFor="new-password">Password</Label>
              <Input
                id="new-password"
                type="password"
                required
                minLength={8}
                maxLength={200}
                autoComplete="new-password"
                className="mt-1.5"
                value={createForm.password}
                onChange={(event) =>
                  setCreateForm({ ...createForm, password: event.target.value })
                }
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                At least 8 characters.
              </p>
            </div>
            <div>
              <Label htmlFor="new-role">Role</Label>
              <Select
                value={createForm.role}
                onValueChange={(value) =>
                  setCreateForm({ ...createForm, role: value as Role })
                }
              >
                <SelectTrigger id="new-role" className="mt-1.5">
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
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {ROLE_BLURB[createForm.role]}
              </p>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Create account
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit account</DialogTitle>
            <DialogDescription>{editing?.email}</DialogDescription>
          </DialogHeader>

          <form onSubmit={saveEdit} className="space-y-3.5">
            <div>
              <Label htmlFor="edit-name">Display name</Label>
              <Input
                id="edit-name"
                required
                maxLength={200}
                className="mt-1.5"
                value={editForm.display_name}
                onChange={(event) =>
                  setEditForm({ ...editForm, display_name: event.target.value })
                }
              />
            </div>

            <div>
              <Label htmlFor="edit-role">Role</Label>
              <Select
                value={editForm.role}
                onValueChange={(value) =>
                  setEditForm({ ...editForm, role: value as Role })
                }
              >
                <SelectTrigger id="edit-role" className="mt-1.5">
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
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {ROLE_BLURB[editForm.role]}
              </p>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2.5">
              <div>
                <Label htmlFor="edit-active">Account active</Label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  An inactive account cannot sign in.
                </p>
              </div>
              <Switch
                id="edit-active"
                checked={editForm.is_active}
                onCheckedChange={(checked) =>
                  setEditForm({ ...editForm, is_active: checked })
                }
              />
            </div>

            <Separator />

            <div>
              <Label htmlFor="edit-password">Reset password</Label>
              <Input
                id="edit-password"
                type="password"
                minLength={8}
                maxLength={200}
                autoComplete="new-password"
                placeholder="Leave blank to keep the current password"
                className="mt-1.5"
                value={editForm.password}
                onChange={(event) =>
                  setEditForm({ ...editForm, password: event.target.value })
                }
              />
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <KeyRound className="h-3 w-3" />
                Only sent if you enter a new one.
              </p>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageBody>
  );
}
