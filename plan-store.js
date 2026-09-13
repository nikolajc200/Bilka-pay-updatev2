import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const { Pool } = pg;

function clientUpdatedAt(state) {
  const value = new Date(state?.updatedAt);
  return Number.isNaN(value.getTime()) ? null : value;
}

// Never let a password hash escape the store; every read path goes through this.
function publicUser(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    username: row.username,
    role: row.role,
    mustChangePassword: Boolean(row.must_change_password ?? row.mustChangePassword),
    disabled: Boolean(row.disabled),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : row.createdAt ?? null,
    lastLoginAt: row.last_login_at
      ? new Date(row.last_login_at).toISOString()
      : row.lastLoginAt ?? null
  };
}

export class FilePlanStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.kind = "file";
    this.sessions = new Map();
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true });
  }

  async ping() {
    await mkdir(this.dataDir, { recursive: true });
  }

  async readJson(file, fallback) {
    try {
      return JSON.parse(await readFile(join(this.dataDir, file), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      throw error;
    }
  }

  async writeJson(file, value) {
    const target = join(this.dataDir, file);
    const temporary = `${target}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  async allUsers() {
    return this.readJson("users.json", []);
  }

  async listUsers() {
    const users = await this.allUsers();
    return users.map(publicUser).sort((a, b) => a.username.localeCompare(b.username));
  }

  async findUserByUsername(username) {
    return (await this.allUsers()).find((user) => user.username === username) || null;
  }

  async findUserById(id) {
    return (await this.allUsers()).find((user) => String(user.id) === String(id)) || null;
  }

  async countAdmins() {
    return (await this.allUsers()).filter((user) => user.role === "admin" && !user.disabled).length;
  }

  async createUser({ username, passwordHash, role = "user", mustChangePassword = false }) {
    const users = await this.allUsers();
    if (users.some((user) => user.username === username)) {
      throw Object.assign(new Error("Username already exists"), { code: "USERNAME_TAKEN" });
    }
    const user = {
      id: String(Date.now()) + String(users.length),
      username,
      password_hash: passwordHash,
      role,
      must_change_password: mustChangePassword,
      disabled: false,
      created_at: new Date().toISOString(),
      last_login_at: null
    };
    users.push(user);
    await this.writeJson("users.json", users);
    return publicUser(user);
  }

  async updateUser(id, patch) {
    const users = await this.allUsers();
    const user = users.find((entry) => String(entry.id) === String(id));
    if (!user) return null;
    if (patch.passwordHash !== undefined) user.password_hash = patch.passwordHash;
    if (patch.role !== undefined) user.role = patch.role;
    if (patch.mustChangePassword !== undefined) user.must_change_password = patch.mustChangePassword;
    if (patch.disabled !== undefined) user.disabled = patch.disabled;
    if (patch.lastLoginAt !== undefined) user.last_login_at = patch.lastLoginAt;
    if (patch.scheduleUrl !== undefined) user.schedule_url = patch.scheduleUrl;
    if (patch.discordWebhook !== undefined) user.discord_webhook = patch.discordWebhook;
    if (patch.scheduleSyncedOn !== undefined) user.schedule_synced_on = patch.scheduleSyncedOn;
    if (patch.reminderSentOn !== undefined) user.reminder_sent_on = patch.reminderSentOn;
    if (patch.discordUserId !== undefined) user.discord_user_id = patch.discordUserId;
    if (patch.discordLinkCode !== undefined) user.discord_link_code = patch.discordLinkCode;
    if (patch.discordLinkExpires !== undefined) {
      user.discord_link_expires = patch.discordLinkExpires;
    }
    await this.writeJson("users.json", users);
    return publicUser(user);
  }

  async findUserByDiscordId(discordUserId) {
    return (await this.allUsers())
      .find((user) => user.discord_user_id === String(discordUserId)) || null;
  }

  async findUserByLinkCode(code) {
    const now = Date.now();
    return (await this.allUsers()).find((user) =>
      user.discord_link_code === code
      && user.discord_link_expires
      && new Date(user.discord_link_expires).getTime() > now) || null;
  }

  async getScheduleUrl(userId) {
    return (await this.findUserById(userId))?.schedule_url || null;
  }

  async getDiscordWebhook(userId) {
    return (await this.findUserById(userId))?.discord_webhook || null;
  }

  async listAutomationTargets() {
    return (await this.allUsers())
      .filter((user) => !user.disabled && (user.schedule_url || user.discord_webhook))
      .map((user) => ({
        id: String(user.id),
        username: user.username,
        scheduleUrl: user.schedule_url || null,
        discordWebhook: user.discord_webhook || null,
        scheduleSyncedOn: user.schedule_synced_on || null,
        reminderSentOn: user.reminder_sent_on || null
      }));
  }

  async deleteUser(id) {
    const users = await this.allUsers();
    const remaining = users.filter((user) => String(user.id) !== String(id));
    if (remaining.length === users.length) return false;
    await this.writeJson("users.json", remaining);
    await this.deleteUserSessions(id);
    return true;
  }

  async createSession(userId, tokenHash, expiresAt) {
    this.sessions.set(tokenHash, { userId: String(userId), expiresAt });
  }

  async findSession(tokenHash) {
    const session = this.sessions.get(tokenHash);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      this.sessions.delete(tokenHash);
      return null;
    }
    const user = await this.findUserById(session.userId);
    if (!user || user.disabled) return null;
    return { user: publicUser(user), expiresAt: session.expiresAt };
  }

  async deleteSession(tokenHash) {
    this.sessions.delete(tokenHash);
  }

  async deleteUserSessions(userId) {
    for (const [hash, session] of this.sessions) {
      if (session.userId === String(userId)) this.sessions.delete(hash);
    }
  }

  planFile(userId) {
    return `plan-${userId}.json`;
  }

  async loadPlan(userId) {
    return this.readJson(this.planFile(userId), null);
  }

  async savePlan(userId, state) {
    const existing = await this.loadPlan(userId);
    const incomingDate = clientUpdatedAt(state);
    const existingDate = clientUpdatedAt(existing?.state);

    if (existingDate && incomingDate && existingDate > incomingDate) {
      return { saved: false, current: existing };
    }

    const payload = { state, savedAt: new Date().toISOString() };
    await this.writeJson(this.planFile(userId), payload);
    return { saved: true, current: payload };
  }

  async close() {}
}

export class PostgresPlanStore {
  constructor({ connectionString, ssl, pool } = {}) {
    this.pool = pool || new Pool({ connectionString, ssl });
    this.kind = "postgres";
  }

  async ping() {
    await this.pool.query("SELECT 1");
  }

  async initialize() {
    const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
    await this.pool.query(schema);
  }

  async listUsers() {
    const result = await this.pool.query(
      `SELECT id, username, role, must_change_password, disabled, created_at, last_login_at
       FROM users ORDER BY username`
    );
    return result.rows.map(publicUser);
  }

  async findUserByUsername(username) {
    const result = await this.pool.query("SELECT * FROM users WHERE username = $1", [username]);
    return result.rows[0] || null;
  }

  async findUserById(id) {
    const result = await this.pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return result.rows[0] || null;
  }

  async countAdmins() {
    const result = await this.pool.query(
      "SELECT count(*)::int AS total FROM users WHERE role = 'admin' AND NOT disabled"
    );
    return result.rows[0].total;
  }

  async getScheduleUrl(userId) {
    const result = await this.pool.query("SELECT schedule_url FROM users WHERE id = $1", [userId]);
    return result.rows[0]?.schedule_url || null;
  }

  async getDiscordWebhook(userId) {
    const result = await this.pool.query(
      "SELECT discord_webhook FROM users WHERE id = $1", [userId]
    );
    return result.rows[0]?.discord_webhook || null;
  }

  async findUserByDiscordId(discordUserId) {
    const result = await this.pool.query(
      "SELECT * FROM users WHERE discord_user_id = $1", [String(discordUserId)]
    );
    return result.rows[0] || null;
  }

  async findUserByLinkCode(code) {
    const result = await this.pool.query(
      `SELECT * FROM users
       WHERE discord_link_code = $1 AND discord_link_expires > NOW()`,
      [code]
    );
    return result.rows[0] || null;
  }

  async listAutomationTargets() {
    const result = await this.pool.query(
      `SELECT id, username, schedule_url, discord_webhook, schedule_synced_on, reminder_sent_on
       FROM users
       WHERE NOT disabled AND (schedule_url IS NOT NULL OR discord_webhook IS NOT NULL)
       ORDER BY id`
    );
    const asDate = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null);
    return result.rows.map((row) => ({
      id: String(row.id),
      username: row.username,
      scheduleUrl: row.schedule_url,
      discordWebhook: row.discord_webhook,
      scheduleSyncedOn: asDate(row.schedule_synced_on),
      reminderSentOn: asDate(row.reminder_sent_on)
    }));
  }

  async createUser({ username, passwordHash, role = "user", mustChangePassword = false }) {
    try {
      const result = await this.pool.query(
        `INSERT INTO users (username, password_hash, role, must_change_password)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, role, must_change_password, disabled, created_at, last_login_at`,
        [username, passwordHash, role, mustChangePassword]
      );
      return publicUser(result.rows[0]);
    } catch (error) {
      if (error.code === "23505") {
        throw Object.assign(new Error("Username already exists"), { code: "USERNAME_TAKEN" });
      }
      throw error;
    }
  }

  async updateUser(id, patch) {
    const columns = {
      passwordHash: "password_hash",
      role: "role",
      mustChangePassword: "must_change_password",
      disabled: "disabled",
      lastLoginAt: "last_login_at",
      scheduleUrl: "schedule_url",
      discordWebhook: "discord_webhook",
      scheduleSyncedOn: "schedule_synced_on",
      reminderSentOn: "reminder_sent_on",
      discordUserId: "discord_user_id",
      discordLinkCode: "discord_link_code",
      discordLinkExpires: "discord_link_expires"
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      values.push(patch[key]);
      assignments.push(`${column} = $${values.length}`);
    }
    if (!assignments.length) return publicUser(await this.findUserById(id));

    values.push(id);
    const result = await this.pool.query(
      `UPDATE users SET ${assignments.join(", ")} WHERE id = $${values.length}
       RETURNING id, username, role, must_change_password, disabled, created_at, last_login_at`,
      values
    );
    return publicUser(result.rows[0]);
  }

  async deleteUser(id) {
    const result = await this.pool.query("DELETE FROM users WHERE id = $1", [id]);
    return result.rowCount > 0;
  }

  async createSession(userId, tokenHash, expiresAt) {
    await this.pool.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
      [tokenHash, userId, expiresAt]
    );
    // Opportunistic cleanup keeps the table from accumulating dead rows.
    await this.pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
  }

  async findSession(tokenHash) {
    const result = await this.pool.query(
      `SELECT u.id, u.username, u.role, u.must_change_password, u.disabled,
              u.created_at, u.last_login_at, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW() AND NOT u.disabled`,
      [tokenHash]
    );
    if (!result.rows.length) return null;
    return {
      user: publicUser(result.rows[0]),
      expiresAt: new Date(result.rows[0].expires_at).toISOString()
    };
  }

  async deleteSession(tokenHash) {
    await this.pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  }

  async deleteUserSessions(userId) {
    await this.pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  }

  async loadPlan(userId) {
    const result = await this.pool.query(
      "SELECT plan_data, updated_at FROM plans WHERE user_id = $1",
      [userId]
    );
    if (!result.rows.length) return null;
    return {
      state: result.rows[0].plan_data,
      savedAt: new Date(result.rows[0].updated_at).toISOString()
    };
  }

  async savePlan(userId, state) {
    const updatedAt = clientUpdatedAt(state);
    if (!updatedAt) throw new Error("Plan is missing a valid updatedAt");

    const result = await this.pool.query(
      `INSERT INTO plans (user_id, plan_data, client_updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (user_id) DO UPDATE
       SET plan_data = EXCLUDED.plan_data,
           client_updated_at = EXCLUDED.client_updated_at,
           updated_at = NOW()
       WHERE plans.client_updated_at <= EXCLUDED.client_updated_at
       RETURNING plan_data, updated_at`,
      [userId, JSON.stringify(state), updatedAt.toISOString()]
    );

    if (!result.rows.length) {
      return { saved: false, current: await this.loadPlan(userId) };
    }

    return {
      saved: true,
      current: {
        state: result.rows[0].plan_data,
        savedAt: new Date(result.rows[0].updated_at).toISOString()
      }
    };
  }

  async close() {
    await this.pool.end();
  }
}

export async function createPlanStore({ dataDir, env = process.env } = {}) {
  let store;
  if (env.DATABASE_URL) {
    const ssl = env.DATABASE_SSL === "false"
      ? false
      : env.DATABASE_SSL === "true" || env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : undefined;
    store = new PostgresPlanStore({
      connectionString: env.DATABASE_URL,
      ssl
    });
  } else {
    store = new FilePlanStore(dataDir);
  }
  await store.initialize();
  return store;
}
