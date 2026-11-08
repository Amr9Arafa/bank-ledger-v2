"use client";

import { type ReactNode, useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  backToSuggestionsAction,
  confirmMatchAction,
  confirmUniqueAction,
  createAllFeesAction,
  createAllInterestAction,
  ignoreLineAction,
  notInAppAction,
  notTheSameAction,
  unignoreLineAction,
  unmatchAction,
} from "@/actions/statements";
import type { InlineActionState } from "@/actions/form-data";
import CreateFromLineForm, { type CreateDefaults } from "@/components/CreateFromLineForm";
import InlineAction from "@/components/InlineAction";
import { inputClass, panel, primaryButton, secondaryButton } from "@/components/styles";
import type { Locale } from "@/i18n/routing";
import { formatDay } from "@/lib/dates";
import { formatEGP } from "@/lib/money";

// A ledger record that could be this line, with the same fields as the bank side.
export type ReviewCandidate = {
  transactionId: string;
  type: string;
  status: string;
  date: string; // the day it hits the bank balance (cleared date for cleared cheques)
  signedMinor: number;
  name: string | null;
  reference: string | null;
  notes: string | null;
  chequeNumber: string | null;
  dayDiff: number; // ledger date - bank date
  nameMatch: boolean;
  chequeNumberMatch: boolean;
};

export type ReviewLine = {
  id: string;
  lineNo: number;
  bookingDate: string;
  valueDate: string;
  direction: "credit" | "debit";
  signedMinor: number;
  kind: string;
  counterparty: string | null;
  description: string;
  bankRef: string;
  chequeRef: string | null;
  status: "unmatched" | "matched" | "created" | "ignored" | "before_start";
  ignoreReason: string | null;
  reviewState: "needs_decision" | "not_in_app" | null; // the reviewer's saved call
  sure: boolean; // exactly one candidate that no other line wants, not dated later
  candidates: ReviewCandidate[]; // suggested first
  matched: {
    type: string;
    date: string;
    name: string | null;
    chequeNumber: string | null;
    origin: "matched" | "created";
    clearedCheque: boolean;
  } | null;
  createDefaults: CreateDefaults;
};

type Props = {
  importId: string;
  lines: ReviewLine[];
  canWrite: boolean;
  otherAccounts: { id: string; name: string }[];
  canIssueCheques: boolean;
  bulk: { fees: number; interest: number };
};

// The import page as four steps: sure matches, decisions, missing records, done.
// The reviewer's calls ("Not the same", "Not in the app") are saved on the line, so the
// steps are the same after a reload. The server already applies them: a "Not the same"
// line is never sure, and a "Not in the app" line has no candidates.
export default function StatementReview({ importId, lines, canWrite, otherAccounts, canIssueCheques, bulk }: Props) {
  const t = useTranslations("statements.review");

  const open = lines.filter((l) => l.status === "unmatched");
  const sure = open.filter((l) => l.sure);
  const decide = open.filter((l) => !l.sure && l.candidates.length > 0);
  const missing = open.filter((l) => l.candidates.length === 0);
  const done = lines.filter((l) => l.status === "matched" || l.status === "created" || l.status === "ignored");
  const beforeStart = lines.filter((l) => l.status === "before_start").length;

  return (
    <div className="space-y-5">
      <Step number={1} title={t("sure.title")} count={sure.length}>
        {sure.length === 0 ? (
          <p className="text-sm text-foreground-secondary">{t("sure.empty")}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-4">
              <p className="text-sm">{t("sure.summary", { count: sure.length })}</p>
              {canWrite && (
                <InlineAction
                  action={confirmUniqueAction}
                  transactionId={importId}
                  idName="importId"
                  tone="normal"
                  label={t("sure.confirmAll")}
                  confirmLabel={t("sure.confirmAllCount", { count: sure.length })}
                  keepLabel={t("keep")}
                />
              )}
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-navy">{t("sure.show")}</summary>
              <ul className="mt-2 space-y-2">
                {sure.map((l) => (
                  <li key={l.id} className="rounded-md border border-border p-3">
                    <Comparison line={l} candidate={l.candidates[0]} />
                    {canWrite && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <LineAction action={notTheSameAction} lineId={l.id} label={t("sure.notSame")} />
                        <span className="text-xs text-foreground-tertiary">{t("sure.notSameHint")}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </Step>

      <Step number={2} title={t("decide.title")} count={decide.length}>
        {decide.length === 0 ? (
          <p className="text-sm text-foreground-secondary">{t("decide.empty")}</p>
        ) : (
          <>
            <p className="text-sm text-foreground-secondary">{t("decide.intro")}</p>
            <ul className="mt-3 space-y-3">
              {decide.map((l) => (
                <li key={l.id}>
                  <DecisionCard line={l} canWrite={canWrite} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Step>

      <Step number={3} title={t("missing.title")} count={missing.length}>
        {missing.length === 0 ? (
          <p className="text-sm text-foreground-secondary">{t("missing.empty")}</p>
        ) : (
          <>
            <p className="text-sm text-foreground-secondary">{t("missing.intro")}</p>
            {canWrite && bulk.fees + bulk.interest > 0 && (
              <div className="mt-3 flex flex-wrap items-start gap-6 text-sm">
                {bulk.fees > 0 && (
                  <InlineAction
                    action={createAllFeesAction}
                    transactionId={importId}
                    idName="importId"
                    tone="normal"
                    label={t("missing.bulkFees", { count: bulk.fees })}
                    confirmLabel={t("missing.bulkFees", { count: bulk.fees })}
                    keepLabel={t("keep")}
                    note={t("missing.bulkNote")}
                  />
                )}
                {bulk.interest > 0 && (
                  <InlineAction
                    action={createAllInterestAction}
                    transactionId={importId}
                    idName="importId"
                    tone="normal"
                    label={t("missing.bulkInterest", { count: bulk.interest })}
                    confirmLabel={t("missing.bulkInterest", { count: bulk.interest })}
                    keepLabel={t("keep")}
                    note={t("missing.bulkNote")}
                  />
                )}
              </div>
            )}
            <ul className="mt-3 divide-y divide-border rounded-md border border-border">
              {missing.map((l) => (
                <li key={l.id} className="flex flex-col gap-3 p-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <BankSummary line={l} />
                    {canWrite && l.reviewState === "not_in_app" && (
                      <div className="mt-1">
                        <LineAction action={backToSuggestionsAction} lineId={l.id} label={t("missing.backToSuggestions")} variant="link" />
                      </div>
                    )}
                  </div>
                  {canWrite && (
                    <div className="flex flex-col gap-2 lg:w-80 lg:shrink-0">
                      <CreateFromLineForm
                        lineId={l.id}
                        direction={l.direction}
                        defaults={l.createDefaults}
                        otherAccounts={otherAccounts}
                        canIssueCheques={canIssueCheques}
                      />
                      <InlineAction
                        action={ignoreLineAction}
                        transactionId={l.id}
                        idName="lineId"
                        tone="normal"
                        label={t("missing.ignore")}
                        confirmLabel={t("missing.confirmIgnore")}
                        keepLabel={t("keep")}
                        input={{ name: "reason", type: "text", label: t("missing.ignoreReason") }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </Step>

      <Step number={4} title={t("done.title")} count={done.length}>
        {done.length === 0 ? (
          <p className="text-sm text-foreground-secondary">{t("done.empty")}</p>
        ) : (
          <details>
            <summary className="cursor-pointer text-sm text-navy">{t("done.show", { count: done.length })}</summary>
            <ul className="mt-2 divide-y divide-border rounded-md border border-border">
              {done.map((l) => (
                <li key={l.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <BankSummary line={l} />
                    <DoneOutcome line={l} />
                  </div>
                  {canWrite && <UndoButton line={l} />}
                </li>
              ))}
            </ul>
          </details>
        )}
        {beforeStart > 0 && <p className="mt-3 text-xs text-foreground-tertiary">{t("beforeStart", { count: beforeStart })}</p>}
      </Step>
    </div>
  );
}

function Step({ number, title, count, children }: { number: number; title: string; count: number; children: ReactNode }) {
  return (
    <section className={`${panel} p-4`} aria-labelledby={`step-${number}`}>
      <h2 id={`step-${number}`} className="mb-3 flex items-center gap-2 text-base font-semibold">
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-navy text-xs text-white">{number}</span>
        {title}
        <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium tabular-nums text-foreground-secondary">{count}</span>
      </h2>
      {children}
    </section>
  );
}

function useFormat() {
  const locale = useLocale() as Locale;
  return { day: (d: string) => formatDay(d, locale), money: (m: number) => formatEGP(m, locale) };
}

// Date, amount, name, reference/notes: the same four fields, in the same order, on both sides.
function Fields({ date, signedMinor, name, reference, extra }: { date: string; signedMinor: number; name: string | null; reference: ReactNode; extra?: ReactNode }) {
  const t = useTranslations("statements.review.fields");
  const { day, money } = useFormat();
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-foreground-secondary">{t("date")}</dt>
      <dd className="tabular-nums">{day(date)}</dd>
      <dt className="text-foreground-secondary">{t("amount")}</dt>
      <dd className={`font-medium tabular-nums ${signedMinor >= 0 ? "text-credit" : "text-debit"}`}>{money(signedMinor)}</dd>
      <dt className="text-foreground-secondary">{t("name")}</dt>
      <dd>{name ? <bdi>{name}</bdi> : <span className="text-foreground-tertiary">—</span>}</dd>
      <dt className="text-foreground-secondary">{t("reference")}</dt>
      <dd className="min-w-0 break-words text-xs text-foreground-secondary">{reference}</dd>
      {extra}
    </dl>
  );
}

function BankFields({ line }: { line: ReviewLine }) {
  const tk = useTranslations("statements.kinds");
  return (
    <Fields
      date={line.bookingDate}
      signedMinor={line.signedMinor}
      name={line.counterparty ?? tk(line.kind as "other")}
      reference={
        <>
          <bdi dir="ltr">{line.bankRef}</bdi>
          {line.chequeRef && <> · #<bdi dir="ltr">{line.chequeRef}</bdi></>}
          <div><bdi dir="auto">{line.description}</bdi></div>
        </>
      }
    />
  );
}

function AppFields({ candidate }: { candidate: ReviewCandidate }) {
  const tl = useTranslations("ledger");
  const tm = useTranslations("statements.match");
  const t = useTranslations("statements.review");
  return (
    <Fields
      date={candidate.date}
      signedMinor={candidate.signedMinor}
      name={candidate.name}
      reference={
        <>
          {tl(`types.${candidate.type}` as "types.fee")}
          {candidate.chequeNumber && <> #<bdi dir="ltr">{candidate.chequeNumber}</bdi></>}
          {candidate.type === "cheque" && candidate.status === "issued" && <> · {t("outstandingCheque")}</>}
          {candidate.reference && <> · <bdi dir="ltr">{candidate.reference}</bdi></>}
          {candidate.notes && <div><bdi dir="auto">{candidate.notes}</bdi></div>}
        </>
      }
      extra={
        <>
          <dt className="sr-only">{t("signals")}</dt>
          <dd className="col-span-2 flex flex-wrap gap-1 pt-1 text-xs">
            <Signal tone={candidate.dayDiff > 0 ? "warn" : "ok"}>
              {candidate.dayDiff > 0 ? tm("datedLater", { days: candidate.dayDiff }) : tm("dayDiff", { days: Math.abs(candidate.dayDiff) })}
            </Signal>
            {candidate.nameMatch && <Signal tone="ok">{tm("nameMatch")}</Signal>}
            {candidate.chequeNumberMatch && <Signal tone="ok">{tm("chequeNumberMatch")}</Signal>}
            {candidate.type === "cheque" && candidate.status === "issued" && <Signal tone="info">{tm("clearsCheque")}</Signal>}
          </dd>
        </>
      }
    />
  );
}

function Signal({ tone, children }: { tone: "ok" | "warn" | "info"; children: ReactNode }) {
  const color = tone === "ok" ? "bg-credit-tint text-credit" : tone === "warn" ? "bg-warning-tint text-warning" : "bg-navy-tint text-navy";
  return <span className={`rounded px-1.5 py-0.5 ${color}`}>{children}</span>;
}

// Bank on the start side, app on the end side: in Arabic the bank line is on the right.
function Comparison({ line, candidate }: { line: ReviewLine; candidate: ReviewCandidate }) {
  const t = useTranslations("statements.review");
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-tertiary">{t("bank")}</h3>
        <BankFields line={line} />
      </div>
      <div className="sm:border-s sm:border-border sm:ps-3">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-tertiary">{t("app")}</h3>
        <AppFields candidate={candidate} />
      </div>
    </div>
  );
}

function DecisionCard({ line, canWrite }: { line: ReviewLine; canWrite: boolean }) {
  const t = useTranslations("statements.review.decide");
  const te = useTranslations("errors");
  const { day, money } = useFormat();
  const [picking, setPicking] = useState(false);
  const [chosenId, setChosenId] = useState(line.candidates[0].transactionId);
  const chosen = line.candidates.find((c) => c.transactionId === chosenId) ?? line.candidates[0];
  const [state, formAction, pending] = useActionState<InlineActionState, FormData>(confirmMatchAction, {});

  return (
    <article className="rounded-md border border-border p-3">
      <Comparison line={line} candidate={chosen} />
      {picking && line.candidates.length > 1 && (
        <label className="mt-3 block text-sm">
          <span className="mb-1 block text-foreground-secondary">{t("pick")}</span>
          <select value={chosenId} onChange={(e) => setChosenId(e.currentTarget.value)} className={inputClass}>
            {line.candidates.map((c) => (
              <option key={c.transactionId} value={c.transactionId}>
                {day(c.date)} · {money(c.signedMinor)} · {c.name ?? "—"}
              </option>
            ))}
          </select>
        </label>
      )}
      {canWrite && (
        <div className="mt-3 flex flex-wrap items-start gap-2">
          <form action={formAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="lineId" value={line.id} />
            <input type="hidden" name="transactionId" value={chosen.transactionId} />
            <button type="submit" disabled={pending} className={`${primaryButton} px-3 py-1.5`}>
              {t("same")}
            </button>
            {line.candidates.length > 1 && !picking && (
              <button type="button" onClick={() => setPicking(true)} className={`${secondaryButton} px-3 py-1.5`}>
                {t("different", { count: line.candidates.length - 1 })}
              </button>
            )}
          </form>
          <LineAction action={notInAppAction} lineId={line.id} label={t("notInApp")} />
          {state.error && (
            <p role="alert" className="w-full text-sm text-debit">
              {te(state.error as "notACandidate")}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

// A one-click saved call on a line ("Not the same", "Not in the app", "Back to suggestions").
function LineAction({
  action,
  lineId,
  label,
  variant = "button",
}: {
  action: (state: InlineActionState, formData: FormData) => Promise<InlineActionState>;
  lineId: string;
  label: string;
  variant?: "button" | "link";
}) {
  const te = useTranslations("errors");
  const [state, formAction, pending] = useActionState<InlineActionState, FormData>(action, {});
  return (
    <form action={formAction} className="inline-flex flex-col gap-1">
      <input type="hidden" name="lineId" value={lineId} />
      <button
        type="submit"
        disabled={pending}
        className={variant === "link" ? "text-start text-xs text-navy underline-offset-2 hover:underline disabled:opacity-50" : `${secondaryButton} px-3 py-1.5`}
      >
        {label}
      </button>
      {state.error && (
        <p role="alert" className="text-sm text-debit">
          {te(state.error as "lineNotUnmatched")}
        </p>
      )}
    </form>
  );
}

// One line, compactly: date, amount, what the bank says.
function BankSummary({ line }: { line: ReviewLine }) {
  const tk = useTranslations("statements.kinds");
  const { day, money } = useFormat();
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="tabular-nums">{day(line.bookingDate)}</span>
        <span className={`font-medium tabular-nums ${line.signedMinor >= 0 ? "text-credit" : "text-debit"}`}>{money(line.signedMinor)}</span>
        <span className="text-xs text-foreground-secondary">{tk(line.kind as "other")}</span>
        {line.counterparty && <bdi className="font-medium">{line.counterparty}</bdi>}
      </div>
      <div className="text-xs text-foreground-secondary">
        <bdi dir="auto">{line.description}</bdi>
        {line.chequeRef && <> · #<bdi dir="ltr">{line.chequeRef}</bdi></>}
      </div>
    </div>
  );
}

function DoneOutcome({ line }: { line: ReviewLine }) {
  const t = useTranslations("statements.review.done");
  const tl = useTranslations("ledger");
  const { day } = useFormat();
  if (line.status === "ignored") {
    return (
      <p className="mt-1 text-xs">
        <span className="rounded bg-surface-muted px-1.5 py-0.5">{t("ignored")}</span> <bdi dir="auto">{line.ignoreReason}</bdi>
      </p>
    );
  }
  const m = line.matched;
  if (!m) return null;
  return (
    <p className="mt-1 text-xs">
      <span className="rounded bg-credit-tint px-1.5 py-0.5 text-credit">{m.origin === "created" ? t("created") : t("matched")}</span>{" "}
      {tl(`types.${m.type}` as "types.fee")}
      {m.chequeNumber && <> #<bdi dir="ltr">{m.chequeNumber}</bdi></>}
      {m.name && <> · <bdi>{m.name}</bdi></>} · <span className="tabular-nums">{day(m.date)}</span>
      {m.clearedCheque && <> · {t("clearedByMatch")}</>}
    </p>
  );
}

function UndoButton({ line }: { line: ReviewLine }) {
  const t = useTranslations("statements.review.done");
  const keep = useTranslations("statements.review")("keep");
  if (line.status === "ignored") {
    return (
      <InlineAction action={unignoreLineAction} transactionId={line.id} idName="lineId" tone="normal" label={t("undo")} confirmLabel={t("restore")} keepLabel={keep} />
    );
  }
  return (
    <InlineAction
      action={unmatchAction}
      transactionId={line.id}
      idName="lineId"
      label={t("undo")}
      confirmLabel={t("undo")}
      keepLabel={keep}
      note={line.matched?.origin === "created" ? t("undoCreatedNote") : t("undoMatchedNote")}
    />
  );
}
