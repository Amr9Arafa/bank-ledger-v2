// Per-request memoized reads for data that several components of one page need
// (e.g. the sidebar and the dashboard both show account balances).
import { cache } from "react";
import { getAccountBalances } from "./balances";

export const getAccountBalancesForRequest = cache((organizationId: string) =>
  getAccountBalances(organizationId),
);
