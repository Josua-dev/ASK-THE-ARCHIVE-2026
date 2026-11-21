"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

/**
 * `/activity` was the original combined page for conversation history and the
 * audit trail. Both now have dedicated homes — `/conversations` for a user's own
 * threads, and `/admin/audit` for administrators — so this route forwards to
 * whichever one the caller is allowed to use.
 */
export default function ActivityPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading || !user) return;
    router.replace(user.role === "admin" ? "/admin/audit" : "/conversations");
  }, [loading, user, router]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="space-y-2">
        <div className="skeleton h-3 w-48 rounded" />
        <div className="skeleton h-3 w-32 rounded" />
      </div>
    </div>
  );
}
