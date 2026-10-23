"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "@/i18n/navigation";

// Below the lg breakpoint the sidebar collapses into this menu button. The menu content
// is the same server-rendered sidebar, passed in as children.
export default function MobileMenu({
  openLabel,
  closeLabel,
  children,
}: {
  openLabel: string;
  closeLabel: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  // The page the menu was opened on: navigating elsewhere closes it, with no extra render.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenOn(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpenOn(open ? null : pathname)}
        className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium"
      >
        {open ? closeLabel : openLabel}
      </button>
      {open && (
        <div
          id="mobile-menu"
          className="absolute inset-x-0 top-full max-h-[calc(100vh-3.5rem)] overflow-y-auto border-b border-border bg-surface-subtle shadow-hairline"
        >
          {children}
        </div>
      )}
    </>
  );
}
