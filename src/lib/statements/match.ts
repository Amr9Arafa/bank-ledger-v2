// Matching statement lines to ledger rows. Pure: the ledger loads the data, this decides.
//
// A ledger row is a candidate for a line when:
//   - same direction (credit types <-> credit lines, everything else <-> debit lines),
//   - exactly the same amount,
//   - cheque lines only match cheques, other lines only match non-cheques,
//   - dates fit: movements within ±window days of the booking date; an issued cheque any
//     time before the booking date (+window); a cleared cheque cleared within ±window,
//   - for cheques with a number on both sides: the trailing digits agree.
// Sender names differ between the bank and our records, so they are not used.

export const MATCH_WINDOW_DAYS = 4;

export type MatchLine = {
  id: string;
  bookingDate: string;
  direction: "credit" | "debit";
  amountMinor: number;
  kind: string;
  bankRef: string;
  chequeRef: string | null;
};

export type MatchRow = {
  id: string;
  type: string;
  status: string;
  amountMinor: number;
  transactionDate: string;
  clearedDate: string | null;
  chequeNumber: string | null;
  reference: string | null;
  notes: string | null;
};

export type ScoredCandidate = { transactionId: string; score: number; dayDiff: number; chequeNumberMatch: boolean };

export type LineSuggestion = {
  // The row this line is paired with after one-to-one assignment, if any.
  suggested: ScoredCandidate | null;
  // Every possible row, best first (for "pick another").
  candidates: ScoredCandidate[];
  // Exactly one candidate, and no other line wants it: safe to confirm in bulk.
  unique: boolean;
};

const CREDIT = new Set(["transfer_in", "deposit", "internal_in", "interest"]);

const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

// How many trailing digits of the bank's cheque reference are the serial printed on our
// cheques (NBE: "07817000208006" -> "208006"). Old cheques created from statement lines
// are stored as this serial, the same format as cheques entered by hand, so the
// next-number suggestion keeps working. Change here if the printed number differs.
export const CHEQUE_SERIAL_DIGITS = 6;

// The serial part of a bank cheque reference: its last CHEQUE_SERIAL_DIGITS digits.
export function chequeSerial(statementRef: string): string {
  return statementRef.replace(/\D/g, "").slice(-CHEQUE_SERIAL_DIGITS);
}

// Cheque numbers: the number we store (as typed from the cheque) must equal the trailing
// digits of the bank's reference, leading zeros ignored on our side. "208006" and
// "00208006" both match "07817000208006". Fewer than 4 digits is too weak to decide.
export function chequeNumberMatches(stored: string, statementRef: string): boolean | null {
  const ours = stored.replace(/\D/g, "").replace(/^0+/, "");
  const theirs = statementRef.replace(/\D/g, "");
  if (ours.length < 4 || theirs.length === 0) return null;
  return theirs.endsWith(ours);
}

// Null when `row` cannot match `line`; otherwise how good the match is.
export function scoreCandidate(line: MatchLine, row: MatchRow, windowDays = MATCH_WINDOW_DAYS): ScoredCandidate | null {
  if (row.status === "voided" || row.status === "cancelled") return null;
  if (row.amountMinor !== line.amountMinor) return null;
  if (CREDIT.has(row.type) !== (line.direction === "credit")) return null;
  const isCheque = row.type === "cheque";
  if (isCheque !== (line.kind === "cheque")) return null;

  const booking = dayNumber(line.bookingDate);
  let dayDiff: number;
  if (isCheque && row.status === "issued") {
    // Written any time before; cashed on the booking date. A few days of slack for a
    // cheque dated slightly after it was actually handed over.
    if (dayNumber(row.transactionDate) > booking + windowDays) return null;
    dayDiff = 0;
  } else {
    const date = isCheque ? row.clearedDate : row.transactionDate;
    if (!date) return null;
    dayDiff = dayNumber(date) - booking;
    if (Math.abs(dayDiff) > windowDays) return null;
  }

  let chequeNumberMatch = false;
  if (isCheque && row.chequeNumber && line.chequeRef) {
    const same = chequeNumberMatches(row.chequeNumber, line.chequeRef);
    if (same === false) return null; // both numbers known and different: another cheque
    chequeNumberMatch = same === true;
  }

  let score = 100 - 10 * Math.abs(dayDiff);
  if (chequeNumberMatch) score += 1000;
  if (line.bankRef && [row.reference, row.notes].some((t) => t?.includes(line.bankRef))) score += 500;
  if (kindFits(line.kind, row.type)) score += 20;
  return { transactionId: row.id, score, dayDiff, chequeNumberMatch };
}

function kindFits(kind: string, type: string): boolean {
  switch (kind) {
    case "fee":
      return type === "fee";
    case "interest":
      return type === "interest";
    case "account_transfer":
      return type === "internal_in" || type === "internal_out";
    case "incoming_transfer":
      return type === "transfer_in";
    case "outgoing_transfer":
      return type === "transfer_out";
    default:
      return false;
  }
}

// Scores every (line, row) pair, then pairs them one-to-one, best score first. Ties go to the
// smaller date difference, then the earlier line, then the earlier row, so the result is
// stable: two equal transfers on different days pair up in date order.
export function suggestMatches(
  lines: MatchLine[],
  rows: MatchRow[],
  windowDays = MATCH_WINDOW_DAYS,
): Map<string, LineSuggestion> {
  const rowOrder = new Map(
    [...rows]
      .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate) || a.id.localeCompare(b.id))
      .map((r, i) => [r.id, i]),
  );
  const lineOrder = new Map(
    [...lines]
      .sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id))
      .map((l, i) => [l.id, i]),
  );

  const pairs: { lineId: string; candidate: ScoredCandidate }[] = [];
  const byLine = new Map<string, ScoredCandidate[]>();
  const linesPerRow = new Map<string, number>();
  for (const line of lines) {
    const candidates: ScoredCandidate[] = [];
    for (const row of rows) {
      const c = scoreCandidate(line, row, windowDays);
      if (!c) continue;
      candidates.push(c);
      pairs.push({ lineId: line.id, candidate: c });
      linesPerRow.set(row.id, (linesPerRow.get(row.id) ?? 0) + 1);
    }
    candidates.sort((a, b) => b.score - a.score || Math.abs(a.dayDiff) - Math.abs(b.dayDiff) || rowOrder.get(a.transactionId)! - rowOrder.get(b.transactionId)!);
    byLine.set(line.id, candidates);
  }

  pairs.sort(
    (a, b) =>
      b.candidate.score - a.candidate.score ||
      Math.abs(a.candidate.dayDiff) - Math.abs(b.candidate.dayDiff) ||
      lineOrder.get(a.lineId)! - lineOrder.get(b.lineId)! ||
      rowOrder.get(a.candidate.transactionId)! - rowOrder.get(b.candidate.transactionId)!,
  );
  const assigned = new Map<string, ScoredCandidate>();
  const taken = new Set<string>();
  for (const { lineId, candidate } of pairs) {
    if (assigned.has(lineId) || taken.has(candidate.transactionId)) continue;
    assigned.set(lineId, candidate);
    taken.add(candidate.transactionId);
  }

  const result = new Map<string, LineSuggestion>();
  for (const line of lines) {
    const candidates = byLine.get(line.id) ?? [];
    const suggested = assigned.get(line.id) ?? null;
    result.set(line.id, {
      suggested,
      candidates,
      unique: candidates.length === 1 && suggested !== null && linesPerRow.get(suggested.transactionId) === 1,
    });
  }
  return result;
}
