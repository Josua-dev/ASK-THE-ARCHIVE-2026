"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Administration is split across four focused surfaces — users, permissions,
 * audit and settings. This index forwards to the first of them.
 */
export default function AdminIndexPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin/users");
  }, [router]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="space-y-2">
        <div className="skeleton h-3 w-48 rounded" />
        <div className="skeleton h-3 w-32 rounded" />
      </div>
    </div>
  );
}
