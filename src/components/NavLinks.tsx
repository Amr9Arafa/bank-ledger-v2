"use client";

import { Link, usePathname } from "@/i18n/navigation";

export type NavItem = { href: string; label: string; hint?: string };

// Sidebar links with the active one highlighted. Needs the current path, so it runs
// in the browser; the labels and hrefs come from the server.
export default function NavLinks({
  items,
  size = "regular",
}: {
  items: NavItem[];
  size?: "regular" | "compact";
}) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <ul className={size === "regular" ? "space-y-0.5" : "space-y-1"}>
      {items.map((item) => {
        const active = isActive(item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-baseline justify-between gap-3 rounded-md px-3 text-sm transition-colors ${
                size === "regular" ? "py-2 font-medium" : "py-1.5"
              } ${
                active
                  ? "bg-navy-tint text-navy"
                  : "text-foreground-secondary hover:bg-surface-muted hover:text-foreground"
              }`}
            >
              <span className="truncate">{item.label}</span>
              {item.hint && (
                <span
                  className={`shrink-0 tabular-nums ${active ? "text-navy" : "text-foreground"}`}
                >
                  {item.hint}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
