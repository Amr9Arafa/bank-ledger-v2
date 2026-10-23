// Shared class strings for buttons, inputs and panels. A plain module (no "use client"),
// so server pages and client components can both import the actual strings.

export const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-foreground-tertiary focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy aria-invalid:border-debit";

export const primaryButton =
  "inline-flex items-center justify-center gap-2 rounded-md bg-navy px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-navy-hover disabled:opacity-50";

export const secondaryButton =
  "inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-subtle disabled:opacity-50";

// A bordered white panel: summary tiles, account cards, table cards.
export const panel = "rounded-lg border border-border bg-background shadow-hairline";
