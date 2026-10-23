// FR-12: the current ledger view (same filters as the page) as an Excel-friendly CSV.
import type { NextRequest } from "next/server";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { hasLocale } from "next-intl";
import { routing } from "@/i18n/routing";
import { toCsv } from "@/lib/csv";
import { todayInCairo } from "@/lib/dates";
import { minorToDecimal } from "@/lib/money";
import { parseLedgerFilters } from "@/lib/validation";
import { getSessionUser } from "@/server/auth/session";
import { getAccountBalances } from "@/server/ledger/balances";
import { getAccountLedger } from "@/server/ledger/ledger";

type RowType = "transfer_in" | "deposit" | "fee" | "internal_in" | "internal_out" | "cheque";
type Status = "active" | "voided" | "issued" | "cleared" | "cancelled";

export async function GET(request: NextRequest, ctx: RouteContext<"/[locale]/accounts/[id]/export">) {
  const { locale, id } = await ctx.params;
  if (!hasLocale(routing.locales, locale) || !z.uuid().safeParse(id).success) {
    return new Response("Not found", { status: 404 });
  }
  // Same rule as every page: signed in, and only your own organization's accounts.
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const account = (
    await getAccountBalances(user.organizationId, undefined, { includeArchived: true })
  ).find((a) => a.id === id);
  if (!account) return new Response("Not found", { status: 404 });

  const filters = parseLedgerFilters(Object.fromEntries(request.nextUrl.searchParams));
  const rows = await getAccountLedger(user.organizationId, id, filters);
  const t = await getTranslations({ locale, namespace: "ledger" });
  const tc = await getTranslations({ locale, namespace: "csv" });

  const details = (r: (typeof rows)[number]) =>
    r.type === "internal_out"
      ? t("internalTo", { name: r.counterpartName ?? "" })
      : r.type === "internal_in"
        ? t("internalFrom", { name: r.counterpartName ?? "" })
        : (r.partyName ?? r.description ?? "");

  const csv = toCsv([
    [
      tc("date"), tc("type"), tc("details"), tc("reference"), tc("chequeNumber"),
      tc("status"), tc("clearedDate"), tc("amount"), tc("balance"), tc("notes"),
    ],
    // Oldest first reads naturally in a spreadsheet; amounts are plain decimals (EGP).
    ...rows.toReversed().map((r) => [
      r.transactionDate,
      t(`types.${r.type as RowType}`),
      details(r),
      r.reference,
      r.chequeNumber,
      tc(`statuses.${r.status as Status}`),
      r.clearedDate,
      minorToDecimal(r.signedAmountMinor),
      minorToDecimal(r.runningBalanceMinor),
      [r.notes, r.statusReason].filter(Boolean).join(" · "),
    ]),
  ]);

  const filename = `${account.name}-${todayInCairo()}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      // filename*: RFC 5987, so Arabic account names survive in the download name.
      "Content-Disposition": `attachment; filename="ledger-${todayInCairo()}.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
