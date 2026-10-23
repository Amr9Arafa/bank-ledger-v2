import { test } from "node:test";
import assert from "node:assert/strict";
import { ForbiddenError, hasRole, requireRole } from "./roles.ts";

test("roles are ordered viewer < accountant < admin", () => {
  assert.equal(hasRole({ role: "admin" }, "accountant"), true);
  assert.equal(hasRole({ role: "accountant" }, "accountant"), true);
  assert.equal(hasRole({ role: "accountant" }, "admin"), false);
  assert.equal(hasRole({ role: "viewer" }, "accountant"), false);
  assert.equal(hasRole({ role: "viewer" }, "viewer"), true);
});

test("requireRole throws ForbiddenError when the role is too low", () => {
  assert.doesNotThrow(() => requireRole({ role: "admin" }, "admin"));
  assert.throws(() => requireRole({ role: "viewer" }, "accountant"), ForbiddenError);
});
