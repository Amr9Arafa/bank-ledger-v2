import { getTranslations, setRequestLocale } from "next-intl/server";
import { rejectEntry } from "@/actions/inbox";
import InboxReviewForm from "@/components/InboxReviewForm";
import InlineAction from "@/components/InlineAction";
import { panel } from "@/components/styles";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { formatDay, todayInCairo } from "@/lib/dates";
import { checkExtraction, reviewDefaults, WARNING_FIELDS } from "@/lib/extraction";
import { formatEGP, toMinor } from "@/lib/money";
import { getUserWithRole } from "@/server/auth/session";
import { getActiveAccounts } from "@/server/ledger/accounts";
import { listPendingEntries, type PendingEntryStatus } from "@/server/ledger/pendingEntries";
import { listCounterparties } from "@/server/ledger/transactions";
import { signedInboxImageUrl } from "@/server/storage";

const TABS: PendingEntryStatus[] = ["pending", "approved", "rejected"];

export default async function InboxPage({ params, searchParams }: PageProps<"/[locale]/inbox">) {
  const locale = (await params).locale as Locale;
  setRequestLocale(locale);
  const t = await getTranslations("inbox");
  const tl = await getTranslations("ledger");

  const requested = (await searchParams).tab;
  const tab = TABS.find((s) => s === requested) ?? "pending";

  // Same permission as entering movements by hand: viewers never see the inbox.
  const user = await getUserWithRole("accountant");
  const entries = await listPendingEntries(user.organizationId, tab);
  const today = todayInCairo();

  // Only the review forms need accounts and names to prefill from.
  const [accounts, counterparties] =
    tab === "pending"
      ? await Promise.all([
          getActiveAccounts(user.organizationId),
          listCounterparties(user.organizationId),
        ])
      : [[], []];
  // Photos live in a private bucket: each gets a link that expires in 10 minutes.
  const imageUrls = await Promise.all(
    entries.map((e) => (e.imagePath ? signedInboxImageUrl(e.imagePath) : null)),
  );

  const when = new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  });

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-foreground-secondary">{t("description")}</p>

      <nav className="mt-4 flex flex-wrap gap-2" aria-label={t("title")}>
        {TABS.map((s) => (
          <Link
            key={s}
            href={{ pathname: "/inbox", query: { tab: s } }}
            aria-current={s === tab ? "page" : undefined}
            className="rounded-full border border-border px-3 py-1.5 text-sm aria-[current=page]:bg-navy aria-[current=page]:text-white"
          >
            {t(`tabs.${s}`)}
          </Link>
        ))}
      </nav>

      {entries.length === 0 && (
        <p className="mt-6 text-foreground-secondary">{t(`empty.${tab}`)}</p>
      )}

      <div className="mt-6 space-y-6">
        {entries.map((entry, i) => {
          const imageUrl = imageUrls[i];
          const x = entry.extracted;
          // Approved: what was saved. Rejected: what the model read.
          const read = x.amount ? toMinor(x.amount) : null;
          const summary =
            tab === "approved"
              ? {
                  amountMinor: entry.resultAmountMinor,
                  party: entry.resultPartyName,
                  date: entry.resultDate,
                }
              : {
                  amountMinor: read?.ok ? read.minor : null,
                  party: x.counterparty,
                  date: x.date,
                };

          return (
            <article
              key={entry.id}
              className={`${panel} grid gap-6 p-4 sm:p-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]`}
            >
              {/* What was sent, exactly as received. */}
              <section aria-label={t("original")} className="min-w-0 space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-secondary">
                  <span className="rounded bg-navy-tint px-1.5 py-0.5 font-medium text-navy">
                    {t(`kinds.${entry.type}`)}
                  </span>
                  <span>{t(`sources.${entry.source}`)}</span>
                  <span>
                    · <bdi>{entry.createdByName}</bdi> · {when.format(entry.createdAt)}
                  </span>
                </div>
                {entry.rawText && (
                  <p
                    dir="auto"
                    className="whitespace-pre-wrap rounded-md bg-surface-subtle p-3 text-sm"
                  >
                    {entry.rawText}
                  </p>
                )}
                {imageUrl && (
                  <a href={imageUrl} target="_blank" rel="noreferrer" className="block">
                    {/* A signed, expiring URL from Supabase: next/image would cache it. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={imageUrl}
                      alt={t("photoAlt")}
                      className="max-h-96 w-auto rounded-md border border-border"
                    />
                  </a>
                )}
                {entry.imagePath && !imageUrl && (
                  <p className="text-sm text-foreground-tertiary">{t("photoUnavailable")}</p>
                )}
                {tab === "rejected" && !entry.rawText && (
                  <p className="text-sm text-foreground-tertiary">{t("photoDeleted")}</p>
                )}
              </section>

              {tab === "pending" ? (
                <section aria-label={t("extracted")} className="min-w-0 space-y-4">
                  {entry.warnings.length > 0 && (
                    <ul className="space-y-1 rounded-md bg-warning-tint p-3 text-sm text-warning">
                      {entry.warnings.map((w, j) => (
                        <li key={j}>
                          <bdi>{t(`warnings.${w.code}`, { value: w.value ?? "" })}</bdi>
                        </li>
                      ))}
                    </ul>
                  )}
                  <InboxReviewForm
                    entryId={entry.id}
                    type={entry.type}
                    defaults={reviewDefaults(
                      x,
                      checkExtraction(x, { accounts, counterparties, today, hasImage: false })
                        .resolved,
                      today,
                    )}
                    accounts={accounts}
                    warnedFields={entry.warnings.flatMap((w) => WARNING_FIELDS[w.code] ?? [])}
                  />
                  <div className="border-t border-border pt-3">
                    <InlineAction
                      action={rejectEntry}
                      transactionId={entry.id}
                      idName="entryId"
                      label={t("reject")}
                      confirmLabel={t("confirmReject")}
                      keepLabel={tl("keep")}
                      note={t("rejectNote")}
                    />
                  </div>
                </section>
              ) : (
                <section aria-label={t("extracted")} className="min-w-0 space-y-2 text-sm">
                  <p className="text-foreground-secondary">
                    {t(tab === "approved" ? "approvedBy" : "rejectedBy", {
                      name: entry.reviewedByName ?? "",
                      when: entry.reviewedAt ? when.format(entry.reviewedAt) : "",
                    })}
                  </p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                    <dt className="text-foreground-secondary">{tl("amount")}</dt>
                    <dd className="tabular-nums">
                      {summary.amountMinor === null ? "—" : formatEGP(summary.amountMinor, locale)}
                    </dd>
                    <dt className="text-foreground-secondary">{t("party")}</dt>
                    <dd>
                      <bdi>{summary.party ?? "—"}</bdi>
                    </dd>
                    <dt className="text-foreground-secondary">{tl("date")}</dt>
                    <dd className="tabular-nums">
                      {summary.date ? formatDay(summary.date, locale) : "—"}
                    </dd>
                  </dl>
                  {tab === "approved" && entry.resultAccountId && (
                    <Link
                      href={`/accounts/${entry.resultAccountId}`}
                      className="inline-block text-navy underline-offset-2 hover:underline"
                    >
                      {t("viewInLedger")}
                    </Link>
                  )}
                </section>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
