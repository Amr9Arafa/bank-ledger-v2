// Helpers for server actions (no "use server": these are plain functions, not endpoints).
import { LedgerError } from "@/server/ledger/types";

// Text fields of a submitted form, without React's internal $ACTION_ fields.
export function formValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of formData) {
    if (typeof value === "string" && !key.startsWith("$ACTION")) values[key] = value;
  }
  return values;
}

// Result of a small inline action (void, clear, cancel...): an error key, or done.
export type InlineActionState = { error?: string; done?: boolean };

// Runs fn and turns a broken business rule into an error key; other errors propagate.
export async function asInlineAction(fn: () => Promise<unknown>): Promise<InlineActionState> {
  try {
    await fn();
    return { done: true };
  } catch (error) {
    if (error instanceof LedgerError) return { error: error.code };
    throw error;
  }
}
