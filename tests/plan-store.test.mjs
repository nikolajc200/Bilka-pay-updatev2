import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilePlanStore, PostgresPlanStore } from "../plan-store.js";

async function freshFileStore(context) {
  const directory = await mkdtemp(join(tmpdir(), "bilka-pay-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FilePlanStore(directory);
  await store.initialize();
  return store;
}

test("file fallback saves, loads and protects newer plans", async (context) => {
  const store = await freshFileStore(context);
  const user = await store.createUser({ username: "anna", passwordHash: "x" });
  const newer = { updatedAt: "2026-06-11T12:00:00.000Z", goalTarget: 5000 };
  const older = { updatedAt: "2026-06-10T12:00:00.000Z", goalTarget: 1000 };

  assert.equal((await store.savePlan(user.id, newer)).saved, true);
  assert.equal((await store.savePlan(user.id, older)).saved, false);
  assert.deepEqual((await store.loadPlan(user.id)).state, newer);
});

test("each account gets its own plan", async (context) => {
  const store = await freshFileStore(context);
  const anna = await store.createUser({ username: "anna", passwordHash: "x" });
  const bo = await store.createUser({ username: "bo", passwordHash: "y" });

  await store.savePlan(anna.id, { updatedAt: "2026-06-11T12:00:00.000Z", goalTarget: 111 });
  await store.savePlan(bo.id, { updatedAt: "2026-06-11T12:00:00.000Z", goalTarget: 222 });

  assert.equal((await store.loadPlan(anna.id)).state.goalTarget, 111);
  assert.equal((await store.loadPlan(bo.id)).state.goalTarget, 222);
});

test("stored users never expose their password hash", async (context) => {
  const store = await freshFileStore(context);
  const created = await store.createUser({ username: "anna", passwordHash: "super-secret" });

  assert.equal(created.passwordHash, undefined);
  assert.equal(created.password_hash, undefined);
  for (const user of await store.listUsers()) {
    assert.equal(user.password_hash, undefined);
    assert.equal(user.passwordHash, undefined);
  }
  // The internal lookup still has it, which is how login verifies.
  assert.equal((await store.findUserByUsername("anna")).password_hash, "super-secret");
});

test("duplicate usernames are refused", async (context) => {
  const store = await freshFileStore(context);
  await store.createUser({ username: "anna", passwordHash: "x" });
  await assert.rejects(
    () => store.createUser({ username: "anna", passwordHash: "y" }),
    (error) => error.code === "USERNAME_TAKEN"
  );
});

test("sessions expire, and disabling a user invalidates theirs immediately", async (context) => {
  const store = await freshFileStore(context);
  const user = await store.createUser({ username: "anna", passwordHash: "x" });

  await store.createSession(user.id, "live", new Date(Date.now() + 60_000).toISOString());
  await store.createSession(user.id, "stale", new Date(Date.now() - 1).toISOString());

  assert.equal((await store.findSession("live")).user.username, "anna");
  assert.equal(await store.findSession("stale"), null);

  await store.updateUser(user.id, { disabled: true });
  assert.equal(await store.findSession("live"), null);
});

test("counting admins ignores disabled ones", async (context) => {
  const store = await freshFileStore(context);
  await store.createUser({ username: "root", passwordHash: "x", role: "admin" });
  const second = await store.createUser({ username: "other", passwordHash: "y", role: "admin" });
  assert.equal(await store.countAdmins(), 2);

  await store.updateUser(second.id, { disabled: true });
  assert.equal(await store.countAdmins(), 1);
});

test("deleting a user removes their sessions too", async (context) => {
  const store = await freshFileStore(context);
  const user = await store.createUser({ username: "anna", passwordHash: "x" });
  await store.createSession(user.id, "token", new Date(Date.now() + 60_000).toISOString());

  assert.equal(await store.deleteUser(user.id), true);
  assert.equal(await store.findSession("token"), null);
  assert.equal(await store.deleteUser(user.id), false);
});

test("PostgreSQL store migrates the schema and writes JSONB plans per user", async () => {
  const calls = [];
  const state = { updatedAt: "2026-06-11T12:00:00.000Z", goalTarget: 5000 };
  const pool = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes("RETURNING plan_data")) {
        return { rows: [{ plan_data: state, updated_at: new Date("2026-06-11T12:01:00.000Z") }] };
      }
      return { rows: [] };
    },
    async end() {}
  };
  const store = new PostgresPlanStore({ pool });

  await store.initialize();
  const result = await store.savePlan("7", state);
  await store.close();

  assert.match(calls[0].sql, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(calls[0].sql, /ALTER TABLE plans ADD COLUMN IF NOT EXISTS user_id/);
  assert.match(calls[1].sql, /ON CONFLICT \(user_id\)/);
  assert.equal(calls[1].parameters[0], "7");
  assert.equal(JSON.parse(calls[1].parameters[1]).goalTarget, 5000);
  assert.equal(result.saved, true);
});

test("a plan without a usable timestamp is refused rather than stored wrong", async () => {
  const store = new PostgresPlanStore({ pool: { async query() { return { rows: [] }; } } });
  await assert.rejects(() => store.savePlan("7", { updatedAt: "not-a-date" }), /updatedAt/);
});
