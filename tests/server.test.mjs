import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppServer, createRateLimiter, bootstrapRootUser } from "../server.js";
import { FilePlanStore } from "../plan-store.js";
import { hashPassword } from "../auth.js";

// A tiny cookie jar; Node's fetch has none, and every auth test needs one.
function createClient(baseUrl) {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
    set cookie(value) {
      cookie = value;
    },
    async fetch(path, options = {}) {
      const headers = { ...options.headers };
      if (cookie) headers.Cookie = cookie;
      if (options.body && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
      const response = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: "manual" });
      const setCookie = response.headers.getSetCookie?.() ?? [];
      for (const entry of setCookie) {
        const value = entry.split(";")[0];
        if (value.endsWith("=")) cookie = "";
        else cookie = value;
      }
      let payload = null;
      const type = response.headers.get("content-type") || "";
      if (type.includes("application/json")) payload = await response.json();
      return { response, payload, status: response.status };
    },
    login(username, password) {
      return this.fetch("/api/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
    }
  };
}

async function withServer(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bilka-pay-srv-"));
  const store = new FilePlanStore(directory);
  await store.initialize();

  // Two accounts every test can rely on, with cheap fixed passwords.
  const rootUser = await store.createUser({
    username: "root",
    passwordHash: await hashPassword("root-password-1"),
    role: "admin"
  });
  const annaUser = await store.createUser({
    username: "anna",
    passwordHash: await hashPassword("anna-password-1"),
    role: "user"
  });

  const server = createAppServer({ store, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await run({ baseUrl, store, rootUser, annaUser, client: () => createClient(baseUrl) });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test("the app and its API are closed to anonymous visitors", () => withServer(async ({ client }) => {
  const anonymous = client();

  const page = await anonymous.fetch("/");
  assert.equal(page.status, 302);
  assert.equal(page.response.headers.get("location"), "/login");

  assert.equal((await anonymous.fetch("/app.js")).status, 302);
  assert.equal((await anonymous.fetch("/api/plan")).status, 401);
  assert.equal((await anonymous.fetch("/api/admin/users")).status, 401);

  // The login page itself must stay reachable, or nobody can get in.
  assert.equal((await anonymous.fetch("/login")).status, 200);
  assert.equal((await anonymous.fetch("/styles.css")).status, 200);
}));

test("login rejects bad credentials and accepts good ones", () => withServer(async ({ client }) => {
  const user = client();

  assert.equal((await user.login("anna", "wrong-password")).status, 401);
  assert.equal((await user.login("ghost", "anna-password-1")).status, 401);
  assert.equal(user.cookie, "", "no session cookie should be issued on failure");

  const ok = await user.login("anna", "anna-password-1");
  assert.equal(ok.status, 200);
  assert.match(user.cookie, /^bp_session=/);
  assert.equal((await user.fetch("/")).status, 200);
}));

test("usernames are matched case-insensitively", () => withServer(async ({ client }) => {
  assert.equal((await client().login("  ANNA ", "anna-password-1")).status, 200);
}));

test("a disabled account cannot log in", () => withServer(async ({ store, annaUser, client }) => {
  await store.updateUser(annaUser.id, { disabled: true });
  assert.equal((await client().login("anna", "anna-password-1")).status, 401);
}));

test("plans are private to their account", () => withServer(async ({ client }) => {
  const anna = client();
  await anna.login("anna", "anna-password-1");
  await anna.fetch("/api/plan", {
    method: "PUT",
    body: JSON.stringify({ state: { updatedAt: "2026-08-01T10:00:00.000Z", goalTarget: 4242 } })
  });
  assert.equal((await anna.fetch("/api/plan")).payload.state.goalTarget, 4242);

  // A different account must not see it, and starts empty.
  const root = client();
  await root.login("root", "root-password-1");
  assert.equal((await root.fetch("/api/plan")).status, 404);
}));

test("stale plan writes lose to the newer stored version", () => withServer(async ({ client }) => {
  const anna = client();
  await anna.login("anna", "anna-password-1");

  await anna.fetch("/api/plan", {
    method: "PUT",
    body: JSON.stringify({ state: { updatedAt: "2026-08-02T10:00:00.000Z", goalTarget: 5000 } })
  });
  const stale = await anna.fetch("/api/plan", {
    method: "PUT",
    body: JSON.stringify({ state: { updatedAt: "2026-08-01T10:00:00.000Z", goalTarget: 1000 } })
  });

  assert.equal(stale.payload.conflict, true);
  assert.equal(stale.payload.state.goalTarget, 5000);
}));

test("plan writes reject junk payloads", () => withServer(async ({ client }) => {
  const anna = client();
  await anna.login("anna", "anna-password-1");

  assert.equal((await anna.fetch("/api/plan", {
    method: "PUT",
    body: JSON.stringify({ state: { goalTarget: 1 } })
  })).status, 400);

  // Cross-site forms cannot send application/json, so this is the CSRF guard.
  assert.equal((await anna.fetch("/api/plan", {
    method: "PUT",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "state=nope"
  })).status, 415);
}));

test("non-admins cannot reach the admin panel or its API",
  () => withServer(async ({ client }) => {
    const anna = client();
    await anna.login("anna", "anna-password-1");

    assert.equal((await anna.fetch("/admin")).status, 403);
    assert.equal((await anna.fetch("/api/admin/users")).status, 403);
    assert.equal((await anna.fetch("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ username: "sneaky", role: "admin" })
    })).status, 403);
  }));

test("an admin can create an account, and the new user must change its password",
  () => withServer(async ({ client }) => {
    const root = client();
    await root.login("root", "root-password-1");

    const created = await root.fetch("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ username: "Bo", role: "user" })
    });
    assert.equal(created.status, 201);
    assert.equal(created.payload.user.username, "bo");
    assert.equal(created.payload.user.mustChangePassword, true);
    assert.ok(created.payload.password.length >= 16);

    const bo = client();
    const login = await bo.login("bo", created.payload.password);
    assert.equal(login.payload.mustChangePassword, true);

    // Everything except changing the password is blocked until they do.
    assert.equal((await bo.fetch("/api/plan")).status, 403);
    assert.equal((await bo.fetch("/")).status, 302);

    const changed = await bo.fetch("/api/password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: created.payload.password,
        newPassword: "a-brand-new-password"
      })
    });
    assert.equal(changed.status, 200);
    assert.equal((await bo.fetch("/api/plan")).status, 404);
  }));

test("duplicate and malformed usernames are refused", () => withServer(async ({ client }) => {
  const root = client();
  await root.login("root", "root-password-1");

  assert.equal((await root.fetch("/api/admin/users", {
    method: "POST", body: JSON.stringify({ username: "anna" })
  })).status, 409);

  assert.equal((await root.fetch("/api/admin/users", {
    method: "POST", body: JSON.stringify({ username: "no spaces" })
  })).status, 400);
}));

test("the last admin cannot be removed, demoted, disabled or self-deleted",
  () => withServer(async ({ rootUser, client }) => {
    const root = client();
    await root.login("root", "root-password-1");

    const demote = await root.fetch(`/api/admin/users/${rootUser.id}`, {
      method: "PATCH", body: JSON.stringify({ role: "user" })
    });
    assert.equal(demote.status, 409);

    const disable = await root.fetch(`/api/admin/users/${rootUser.id}`, {
      method: "PATCH", body: JSON.stringify({ disabled: true })
    });
    assert.equal(disable.status, 409);

    assert.equal((await root.fetch(`/api/admin/users/${rootUser.id}`, {
      method: "DELETE"
    })).status, 409);

    // Still an admin afterwards, so the instance is never locked out.
    assert.equal((await root.fetch("/api/me")).payload.user.role, "admin");
  }));

test("changing a password signs the account out everywhere else",
  () => withServer(async ({ client }) => {
    const phone = client();
    const laptop = client();
    await phone.login("anna", "anna-password-1");
    await laptop.login("anna", "anna-password-1");
    assert.equal((await laptop.fetch("/api/me")).status, 200);

    await phone.fetch("/api/password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: "anna-password-1",
        newPassword: "a-different-password"
      })
    });

    assert.equal((await laptop.fetch("/api/me")).status, 401);
    assert.equal((await phone.fetch("/api/me")).status, 200);
  }));

test("an admin resetting a password kicks that user off every device",
  () => withServer(async ({ annaUser, client }) => {
    const anna = client();
    await anna.login("anna", "anna-password-1");

    const root = client();
    await root.login("root", "root-password-1");
    const reset = await root.fetch(`/api/admin/users/${annaUser.id}/reset-password`, {
      method: "POST"
    });

    assert.equal(reset.status, 200);
    assert.ok(reset.payload.password);
    assert.equal((await anna.fetch("/api/me")).status, 401);
  }));

test("logging out invalidates the session server-side", () => withServer(async ({ client }) => {
  const anna = client();
  await anna.login("anna", "anna-password-1");
  const sessionCookie = anna.cookie;

  await anna.fetch("/api/logout", { method: "POST", body: JSON.stringify({}) });

  // Replaying the old cookie must not work, not merely be cleared client-side.
  anna.cookie = sessionCookie;
  assert.equal((await anna.fetch("/api/me")).status, 401);
}));

test("the session cookie is only marked Secure when the request was HTTPS", async () => {
  // A Secure cookie is discarded by the browser over http://, which would make
  // login silently fail on the LAN while working through the HTTPS tunnel.
  const loginCookie = async (headers, options) => {
    let cookie = null;
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ username: "anna", password: "anna-password-1" })
      });
      cookie = response.headers.getSetCookie()[0];
    }, options);
    return cookie;
  };

  const plain = await loginCookie({}, { trustProxy: true });
  assert.doesNotMatch(plain, /Secure/, "plain HTTP must not get a Secure cookie");

  const proxied = await loginCookie({ "X-Forwarded-Proto": "https" }, { trustProxy: true });
  assert.match(proxied, /Secure/, "HTTPS through the proxy must get a Secure cookie");

  // An untrusted proxy header must not be able to flip it.
  const spoofed = await loginCookie({ "X-Forwarded-Proto": "https" }, { trustProxy: false });
  assert.doesNotMatch(spoofed, /Secure/);

  // And an explicit setting still wins over detection.
  const forced = await loginCookie({}, { trustProxy: true, secureCookies: true });
  assert.match(forced, /Secure/);
});

test("code is revalidated rather than cached, so a stale app.js cannot pair with fresh markup",
  () => withServer(async ({ client }) => {
    const anna = client();
    await anna.login("anna", "anna-password-1");

    for (const path of ["/", "/app.js", "/calculator.js", "/styles.css"]) {
      const { response } = await anna.fetch(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("cache-control"), "no-cache", path);
      assert.ok(response.headers.get("etag"), `${path} needs an ETag to stay cheap`);
    }

    // Unchanged files must still answer 304 so revalidation costs almost nothing.
    const first = await anna.fetch("/app.js");
    const etag = first.response.headers.get("etag");
    const second = await anna.fetch("/app.js", { headers: { "If-None-Match": etag } });
    assert.equal(second.status, 304);
  }));

test("repeated failed logins are rate limited", () => withServer(async ({ client }) => {
  const attacker = client();
  let sawLimit = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if ((await attacker.login("anna", "guess")).status === 429) {
      sawLimit = true;
      break;
    }
  }
  assert.ok(sawLimit, "expected a 429 before the 8th guess");
}, { loginLimiter: createRateLimiter({ limit: 3, windowMs: 60_000 }) }));

test("bootstrap creates root once, and never again", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bilka-pay-boot-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FilePlanStore(directory);
  await store.initialize();

  const created = await bootstrapRootUser(store, { log() {} });
  assert.equal(created.username, "root");
  assert.ok(created.password.length >= 16);

  const users = await store.listUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].role, "admin");
  assert.equal(users[0].mustChangePassword, true);

  assert.equal(await bootstrapRootUser(store, { log() {} }), null);
  assert.equal((await store.listUsers()).length, 1);
});

test("health endpoint reports storage availability", () => withServer(async ({ client }) => {
  const result = await client().fetch("/healthz");
  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
}));

test("rate limiter separates proxied clients only when proxies are trusted", async () => {
  const call = (client, ip) => client.fetch("/api/plan", { headers: { "X-Forwarded-For": ip } });

  await withServer(async ({ client }) => {
    const anna = client();
    await anna.login("anna", "anna-password-1");
    assert.equal((await call(anna, "10.0.0.1")).status, 404);
    assert.equal((await call(anna, "10.0.0.1")).status, 429);
    assert.equal((await call(anna, "10.0.0.2")).status, 404);
  }, { trustProxy: true, rateLimiter: createRateLimiter({ limit: 1 }) });

  await withServer(async ({ client }) => {
    const anna = client();
    await anna.login("anna", "anna-password-1");
    assert.equal((await call(anna, "10.0.0.1")).status, 404);
    assert.equal((await call(anna, "10.0.0.2")).status, 429);
  }, { rateLimiter: createRateLimiter({ limit: 1 }) });
});

test("rate limiter discards expired buckets instead of growing forever", () => {
  let now = 0;
  const limiter = createRateLimiter({
    limit: 5,
    windowMs: 1_000,
    maxKeys: 10,
    clock: () => now
  });

  // Each caller arrives a full window apart, so every earlier bucket is stale
  // by the time the next one is created.
  for (let index = 0; index < 200; index += 1) {
    limiter.check(`10.0.0.${index}`);
    now += 1_000;
  }
  assert.ok(limiter.size <= 10, `expected at most 10 tracked keys, saw ${limiter.size}`);

  assert.equal(limiter.check("10.0.0.1"), true);
  assert.equal(limiter.check("10.0.0.1"), true);
});
