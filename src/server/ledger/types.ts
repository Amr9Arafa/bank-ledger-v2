// The part of the signed-in user the ledger needs: who did it, and which company.
export type LedgerUser = { id: string; organizationId: string };

export type LedgerErrorCode =
  | "accountNotFound"
  | "accountArchived"
  | "accountNoTransfers"
  | "beforeOpeningDate"
  | "transactionNotFound"
  | "notActive"
  | "chequeUseCancel"
  | "accountNoCheques"
  | "chequeNumberTaken"
  | "notIssued"
  | "notCleared"
  | "clearedBeforeIssue"
  | "cannotChangeOwnRole"
  | "userNotFound"
  | "telegramIdTaken"
  | "emailTaken"
  | "secretKeyMissing"
  | "openingAfterTransactions"
  | "hasOutstandingCheques"
  | "entryNotFound"
  | "entryNotPending";

// A business rule was broken. Thrown inside the DB transaction, so nothing is saved.
export class LedgerError extends Error {
  code: LedgerErrorCode;
  // The form field to show the error on, when there is one.
  field?: string;

  constructor(code: LedgerErrorCode, field?: string) {
    super(code);
    this.name = "LedgerError";
    this.code = code;
    this.field = field;
  }
}
