// A statement line's stable identity, the same for every bank and format, so the same line
// in two overlapping statements is stored once. Identical lines within one statement get
// #1, #2... so they stay distinct but stable.
import { createHash } from "node:crypto";
import type { Direction } from "./types.ts";

export type KeyFields = {
  bookingDate: string;
  valueDate: string;
  direction: Direction;
  amountMinor: number;
  typeCode: string;
  bankRef: string;
  description: string;
};

// Returns a function that keys the lines of one statement, in order.
export function lineKeyer(accountNumber: string) {
  const seen = new Map<string, number>();
  return (l: KeyFields): string => {
    const base = createHash("sha256")
      .update([accountNumber, l.bookingDate, l.valueDate, l.direction, l.amountMinor, l.typeCode, l.bankRef, l.description].join("\u001f"))
      .digest("hex")
      .slice(0, 32);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return `${base}#${occurrence}`;
  };
}
