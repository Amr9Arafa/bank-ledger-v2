// SWIFT MT940 parser, bank-independent. Bank-specific reading of the :86: text lives in
// separate enrichers (nbe.ts). Pure: no database, no I/O except hashing.
import { lineKeyer } from "./lineKey.ts";
import type { Direction, ParsedStatement, ParseResult, StatementLine } from "./types.ts";

type Tag = { tag: string; value: string };

// Bidi control marks (e.g. U+200F around Arabic names) carry no meaning and break matching.
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;

export function cleanText(text: string): string {
  return text.replace(BIDI_MARKS, "").replace(/\s+/g, " ").trim();
}

// "5000,00" -> 500000, "5000," -> 500000, "25,6" -> 2560. MT940 uses a comma as the decimal
// mark and no thousands separator, so money.ts toMinor (which strips commas) must not be used.
export function parseMt940Amount(input: string): number | null {
  const match = /^(\d+),(\d{0,2})$/.exec(input);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number(match[2].padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

// Builds YYYY-MM-DD, or null when the day does not exist (e.g. 02-30).
function isoDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

// "261031" -> "2026-10-31". MT940 years are two digits; this app only sees 20xx.
export function parseYymmdd(input: string): string | null {
  if (!/^\d{6}$/.test(input)) return null;
  return isoDate(2000 + Number(input.slice(0, 2)), Number(input.slice(2, 4)), Number(input.slice(4, 6)));
}

const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

// The :61: entry date is MMDD with no year. Take the year that puts it inside the statement
// period (opening..closing date); otherwise the year that puts it nearest to the period.
// A statement spanning Dec-Jan therefore gets 12-31 -> old year and 01-02 -> new year.
export function inferEntryDate(mmdd: string, openingDate: string, closingDate: string): string | null {
  const month = Number(mmdd.slice(0, 2));
  const day = Number(mmdd.slice(2, 4));
  const first = Number(openingDate.slice(0, 4)) - 1;
  const last = Number(closingDate.slice(0, 4)) + 1;
  const from = dayNumber(openingDate);
  const to = dayNumber(closingDate);

  let best: string | null = null;
  let bestDistance = Infinity;
  for (let year = first; year <= last; year++) {
    const candidate = isoDate(year, month, day);
    if (!candidate) continue;
    const n = dayNumber(candidate);
    const distance = n < from ? from - n : n > to ? n - to : 0;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

// The message bodies ({4: ... -}) of every SWIFT message in the file; a file without SWIFT
// headers is treated as one bare body.
function bodies(text: string): string[] {
  const found = [...text.matchAll(/\{4:([\s\S]*?)(?:\n-\}|-\})/g)].map((m) => m[1]);
  if (found.length > 0) return found;
  return /(^|\n):20:/.test(text) ? [text] : [];
}

// Splits a body into tags; lines that do not start with ":NNx:" continue the previous tag.
function tags(body: string): Tag[] {
  const result: Tag[] = [];
  for (const line of body.split("\n")) {
    const match = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (match) result.push({ tag: match[1], value: match[2] });
    else if (result.length > 0 && line.trim() !== "") {
      // :86: is wrapped at a fixed width, often mid-word, so it is joined without a space.
      const last = result[result.length - 1];
      last.value += last.tag === "86" ? line : `\n${line}`;
    }
  }
  return result;
}

type Balance = { date: string; currency: string; minor: number };

function parseBalance(value: string): Balance | null {
  const match = /^([CD])(\d{6})([A-Z]{3})(\d+,\d*)$/.exec(value.trim());
  if (!match) return null;
  const date = parseYymmdd(match[2]);
  const amount = parseMt940Amount(match[4]);
  if (!date || amount === null) return null;
  return { date, currency: match[3], minor: match[1] === "D" ? -amount : amount };
}

// value date, optional entry date, mark (RC/RD = reversals), optional funds code (the 3rd
// letter of the currency, "P" for EGP), amount, type (N/F + 3 chars, or S + 3 digits), refs.
const LINE_61 = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+,\d*)([NF][A-Z0-9]{3}|S\d{3})(.*)$/;

const DIRECTION: Record<string, Direction> = { C: "credit", D: "debit", RC: "debit", RD: "credit" };

type Fail = { ok: false; error: Extract<ParseResult, { ok: false }>["error"]; detail?: string };
const fail = (error: Fail["error"], detail?: string): Fail => ({ ok: false, error, detail });

function parseStatement(items: Tag[], bic: string | null): ParsedStatement | Fail {
  const one = (...names: string[]) => items.find((t) => names.includes(t.tag))?.value.trim();
  const statementRef = one("20");
  const accountNumber = one("25");
  const openingRaw = one("60F", "60M");
  const closingRaw = one("62F", "62M");
  if (!statementRef) return fail("missingTag", ":20:");
  if (!accountNumber) return fail("missingTag", ":25:");
  if (!openingRaw) return fail("missingTag", ":60F:");
  if (!closingRaw) return fail("missingTag", ":62F:");

  const opening = parseBalance(openingRaw);
  const closing = parseBalance(closingRaw);
  if (!opening) return fail("badBalance", ":60F:");
  if (!closing) return fail("badBalance", ":62F:");
  if (opening.currency !== closing.currency) return fail("currencyMismatch");

  const lines: StatementLine[] = [];
  const keyOf = lineKeyer(accountNumber);
  for (let i = 0; i < items.length; i++) {
    if (items[i].tag !== "61") continue;
    const lineNo = lines.length + 1;
    const first = items[i].value.split("\n")[0].trim();
    const m = LINE_61.exec(first);
    if (!m) return fail("badLine", `line ${lineNo}`);

    const valueDate = parseYymmdd(m[1]);
    const bookingDate = m[2] ? inferEntryDate(m[2], opening.date, closing.date) : valueDate;
    const amountMinor = parseMt940Amount(m[5]);
    if (!valueDate || !bookingDate) return fail("badLine", `line ${lineNo}`);
    if (!amountMinor) return fail("badAmount", `line ${lineNo}`);

    const refs = m[7];
    const split = refs.indexOf("//");
    const customerRef = (split >= 0 ? refs.slice(0, split) : refs).trim();
    const bankRef = split >= 0 ? refs.slice(split + 2).trim() : "";
    const next = items[i + 1];
    const description = next?.tag === "86" ? cleanText(next.value) : "";
    const direction = DIRECTION[m[3]];
    const typeCode = m[6].slice(1);

    lines.push({
      lineNo,
      bookingDate,
      valueDate,
      direction,
      amountMinor,
      typeCode,
      customerRef,
      bankRef,
      description,
      paymentRef: null,
      kind: "other",
      counterparty: null,
      chequeRef: null,
      lineKey: keyOf({ bookingDate, valueDate, direction, amountMinor, typeCode, bankRef, description }),
    });
  }

  // Integrity check: if the lines do not add up, we misread the file; never import it.
  const total = lines.reduce((sum, l) => sum + (l.direction === "credit" ? l.amountMinor : -l.amountMinor), 0);
  if (opening.minor + total !== closing.minor) {
    return fail("unbalanced", `${statementRef}: ${opening.minor} + ${total} != ${closing.minor}`);
  }

  return {
    bank: "unknown",
    format: "mt940",
    bic,
    statementRef,
    accountNumber,
    sequence: one("28C", "28") ?? null,
    currency: opening.currency,
    openingDate: opening.date,
    openingBalanceMinor: opening.minor,
    closingDate: closing.date,
    closingBalanceMinor: closing.minor,
    lines,
  };
}

// Parses every statement in an MT940 file. Lines come back with kind "other"; a bank enricher
// fills kind, counterparty and cheque reference.
export function parseMt940(input: string): ParseResult {
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (text.trim() === "") return fail("empty");

  const bic = /\{1:F\d{2}([A-Z0-9]{8})/.exec(text)?.[1] ?? null;
  const statements: ParsedStatement[] = [];
  for (const body of bodies(text)) {
    // A body can hold several statements; each starts at :20:.
    let group: Tag[] = [];
    const groups: Tag[][] = [];
    for (const t of tags(body)) {
      if (t.tag === "20" && group.length > 0) {
        groups.push(group);
        group = [];
      }
      group.push(t);
    }
    if (group.length > 0) groups.push(group);

    for (const g of groups) {
      const result = parseStatement(g, bic);
      if ("ok" in result) return result;
      statements.push(result);
    }
  }
  if (statements.length === 0) return fail("unknownFormat");
  return { ok: true, statements };
}
