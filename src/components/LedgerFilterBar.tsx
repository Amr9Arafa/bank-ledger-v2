import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { LEDGER_STATUSES, LEDGER_TYPES, type LedgerFilters } from "@/lib/validation";

const field = "rounded-md border border-foreground/20 bg-background px-2 py-1.5 text-sm";

// FR-11: a plain GET form, so filters live in the URL: shareable, bookmarkable,
// and the same URL drives the CSV export. No client JavaScript needed.
export default async function LedgerFilterBar({
  action,
  resetHref,
  filters,
}: {
  // The page's own URL (with locale), e.g. /ar/accounts/<id>.
  action: string;
  resetHref: string;
  filters: LedgerFilters;
}) {
  const t = await getTranslations("filters");

  return (
    <form
      method="get"
      action={action}
      className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-foreground/10 p-3"
    >
      <label className="flex flex-col gap-1 text-xs text-foreground/70">
        {t("from")}
        <input type="date" name="from" defaultValue={filters.from} className={field} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-foreground/70">
        {t("to")}
        <input type="date" name="to" defaultValue={filters.to} className={field} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-foreground/70">
        {t("type")}
        <select name="type" defaultValue={filters.type ?? ""} className={field}>
          <option value="">{t("all")}</option>
          {LEDGER_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`types.${type}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-foreground/70">
        {t("status")}
        <select name="status" defaultValue={filters.status ?? ""} className={field}>
          <option value="">{t("all")}</option>
          {LEDGER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`statuses.${status}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-foreground/70">
        {t("search")}
        <input
          type="search"
          name="q"
          defaultValue={filters.q}
          placeholder={t("searchPlaceholder")}
          className={field}
        />
      </label>
      <div className="flex gap-2">
        <button type="submit" className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background">
          {t("apply")}
        </button>
        <Link href={resetHref} className="rounded-md px-3 py-1.5 text-sm hover:underline">
          {t("reset")}
        </Link>
      </div>
    </form>
  );
}
