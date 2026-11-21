import type { Role } from "./types";

export interface NavItem {
  href: string;
  label: string;
  /** Roles that can see this item. Omit for "everyone". */
  roles?: Role[];
  icon: string;
  /** Shown in the command palette as a shortcut hint. */
  shortcut?: string;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

/**
 * The four-part navigation from the product specification.
 *
 * Each group is filtered by role, so a viewer never sees an administration
 * link they cannot use, and an analyst never sees an administrative action
 * they would be refused.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: "workspace",
    label: "Workspace",
    items: [
      { href: "/dashboard", label: "Overview", icon: "gauge" },
      { href: "/ask", label: "Ask the Archive", icon: "spark" },
      { href: "/research", label: "Research Mode", icon: "compass" },
      { href: "/conversations", label: "Conversations", icon: "chat" },
    ],
  },
  {
    id: "knowledge",
    label: "Knowledge",
    items: [
      { href: "/library", label: "Document Library", icon: "folder" },
      { href: "/warehouse", label: "Warehouse", icon: "warehouse" },
      { href: "/collections", label: "Smart Collections", icon: "stack" },
      {
        href: "/compare",
        label: "Document Comparison",
        icon: "columns",
        roles: ["admin", "analyst"],
      },
      { href: "/graph", label: "Knowledge Graph", icon: "network" },
      {
        href: "/extraction",
        label: "Extraction Studio",
        icon: "table",
        roles: ["admin", "analyst"],
      },
    ],
  },
  {
    id: "intelligence",
    label: "Intelligence",
    items: [
      { href: "/insights", label: "Archive Insights", icon: "alert" },
      { href: "/dates", label: "Important Dates", icon: "calendar" },
      { href: "/analytics", label: "Analytics", icon: "chart" },
    ],
  },
  {
    id: "administration",
    label: "Administration",
    items: [
      {
        href: "/admin/users",
        label: "Users",
        icon: "users",
        roles: ["admin"],
      },
      {
        href: "/admin/permissions",
        label: "Permissions",
        icon: "key",
        roles: ["admin"],
      },
      {
        href: "/admin/audit",
        label: "Audit Centre",
        icon: "shield",
        roles: ["admin"],
      },
      {
        href: "/admin/settings",
        label: "Settings",
        icon: "sliders",
        roles: ["admin"],
      },
    ],
  },
];

/** The navigation a given role actually sees. */
export function navForRole(role: Role | undefined): NavGroup[] {
  if (!role) return [];
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.roles || item.roles.includes(role)),
  })).filter((group) => group.items.length > 0);
}

/** Every page the role can reach, for the command palette. */
export function pagesForRole(role: Role | undefined): NavItem[] {
  return navForRole(role).flatMap((group) => group.items);
}
