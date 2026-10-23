// Roles are ordered: an admin passes an accountant check, an accountant passes a viewer check.
export type Role = "viewer" | "accountant" | "admin";

const RANK: Record<Role, number> = { viewer: 0, accountant: 1, admin: 2 };

export class ForbiddenError extends Error {
  constructor(required: Role) {
    super(`Requires role ${required}`);
    this.name = "ForbiddenError";
  }
}

export function hasRole(user: { role: Role }, minimum: Role): boolean {
  return RANK[user.role] >= RANK[minimum];
}

// Call at the top of every server action that writes. Hiding a button is not security.
export function requireRole(user: { role: Role }, minimum: Role): void {
  if (!hasRole(user, minimum)) throw new ForbiddenError(minimum);
}
