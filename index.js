var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// index.js
var DEFAULT_SETTINGS = {
  repoIntervalMinutes: 5,
  cycleIntervalHours: 8,
  dnd: { enabled: false, start: "23:00", end: "08:00" }
};
var DEFAULT_NOTIFICATION_TEMPLATE = {
  update: {
    title: "\u{1F4E2} \u9879\u76EE\u66F4\u65B0\u901A\u77E5",
    content: "{repo_name}\n{url}",
    platform: "GitHub",
    username: "{repo_name}",
    eventLabel: "\u{1F4E2}",
    taskType: "\u9879\u76EE\u66F4\u65B0",
    taskStatus: "{tag}",
    filename: "{repo_name}",
    error: "{url}"
  },
  alert: {
    title: "\u{1F6A8} \u76D1\u63A7\u5F02\u5E38\u544A\u8B66",
    content: "{repo}\n\u539F\u56E0\uFF1A{reason}\n\u5224\u5B9A\uFF1A{judge_reason}",
    platform: "GitHub Monitor",
    username: "System Alert",
    eventLabel: "\u{1F6A8}",
    taskType: "\u5F02\u5E38\u901A\u77E5",
    taskStatus: "Failed",
    filename: "{repo}",
    error: "{reason}"
  }
};
var ALLOWED_TEMPLATE_VARS = {
  update: ["repo", "repo_name", "url", "repo_url", "tag"],
  alert: ["repo", "message", "reason", "judge_reason"]
};
var ALERT_FAILURE_COUNT = 5;
var RECOVERED_SUCCESS_THRESHOLD = 3;
var ALERTED_AT_EXPIRE_HOURS = 24;
var TIMEOUT_GITHUB = 1e4;
var TIMEOUT_WEBHOOK = 8e3;
var MAX_NOTIFY_ATTEMPTS = 3;
var SANITIZE_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g;
var VAR_REGEX = /\{(\w+)\}/g;
function sanitizeTemplate(obj) {
  if (typeof obj === "string") return obj.replace(SANITIZE_REGEX, "");
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const cleaned = {};
    for (const key of Object.keys(obj)) {
      cleaned[key] = sanitizeTemplate(obj[key]);
    }
    return cleaned;
  }
  return obj;
}
__name(sanitizeTemplate, "sanitizeTemplate");
function parseHHMM(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str || "");
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
__name(parseHHMM, "parseHHMM");
function beijingMinutes(now = /* @__PURE__ */ new Date()) {
  return (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % (24 * 60);
}
__name(beijingMinutes, "beijingMinutes");
function isDndActive(dnd, now = /* @__PURE__ */ new Date()) {
  if (!dnd || !dnd.enabled) return false;
  const s = parseHHMM(dnd.start);
  const e = parseHHMM(dnd.end);
  if (s === null || e === null || s === e) return false;
  const cur = beijingMinutes(now);
  if (s < e) return cur >= s && cur < e;
  return cur >= s || cur < e;
}
__name(isDndActive, "isDndActive");
var dbInitPromise = null;
var SCHEMA_VERSION = 2;
async function initDB(db, retries = 3) {
  if (dbInitPromise) {
    try {
      await dbInitPromise;
      return;
    } catch (e) {
      dbInitPromise = null;
    }
  }
  const attempt = /* @__PURE__ */ __name(async (remaining) => {
    try {
      let marker = null;
      try {
        marker = await db.prepare("SELECT value FROM settings WHERE key = 'system:schema_version'").first();
      } catch (e) {
        console.warn("\u8BFB\u53D6 schema \u7248\u672C\u6807\u8BB0\u5931\u8D25\uFF08\u5C06\u6267\u884C\u5B8C\u6574\u5EFA\u8868\u6D41\u7A0B\uFF09", e && e.message);
        marker = null;
      }
      if (marker && Number(marker.value) === SCHEMA_VERSION) {
        dbInitPromise = Promise.resolve();
        return;
      }
      await db.prepare(`CREATE TABLE IF NOT EXISTS check_state (id INTEGER PRIMARY KEY DEFAULT 1, phase TEXT NOT NULL DEFAULT 'waiting', current_index INTEGER NOT NULL DEFAULT 0, cycle_start_time TEXT, last_repo_check_time TEXT, cycle_end_time TEXT, cycle_repos TEXT, total_repos INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 0)`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS repos (repo TEXT PRIMARY KEY, custom_url TEXT NOT NULL, note TEXT)`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS repo_state (repo TEXT PRIMARY KEY, tag TEXT, etag TEXT, errors_json TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS release_events (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, tag TEXT NOT NULL, url TEXT NOT NULL, detected_at TEXT NOT NULL, UNIQUE(repo, tag))`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS quota_state (id INTEGER PRIMARY KEY DEFAULT 1, payload TEXT, sig TEXT, updated_at TEXT)`).run();
      await db.prepare(`INSERT OR IGNORE INTO check_state (id) VALUES (1)`).run();
      const cols = await db.prepare(`PRAGMA table_info(check_state)`).all();
      const hasVersion = cols.results.some((c) => c.name === "version");
      if (!hasVersion) {
        try {
          await db.prepare(`ALTER TABLE check_state ADD COLUMN version INTEGER NOT NULL DEFAULT 0`).run();
        } catch (e) {
          if (!e.message.includes("duplicate column")) throw e;
        }
      }
      const repoCols = await db.prepare(`PRAGMA table_info(repos)`).all();
      const hasNote = repoCols.results.some((c) => c.name === "note");
      if (!hasNote) {
        try {
          await db.prepare(`ALTER TABLE repos ADD COLUMN note TEXT`).run();
        } catch (e) {
          if (!e.message.includes("duplicate column")) throw e;
        }
      }
      const stateCols = await db.prepare(`PRAGMA table_info(repo_state)`).all();
      const stateColNames = stateCols.results.map((c) => c.name);
      if (!stateColNames.includes("last_notified_tag")) {
        try {
          await db.prepare(`ALTER TABLE repo_state ADD COLUMN last_notified_tag TEXT`).run();
        } catch (e) {
          if (!e.message.includes("duplicate column")) throw e;
        }
      }
      if (!stateColNames.includes("notify_attempts")) {
        try {
          await db.prepare(`ALTER TABLE repo_state ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0`).run();
        } catch (e) {
          if (!e.message.includes("duplicate column")) throw e;
        }
      }
      await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('system:schema_version', ?1)").bind(String(SCHEMA_VERSION)).run();
      dbInitPromise = Promise.resolve();
      return;
    } catch (e) {
      if (remaining > 0) {
        console.warn(`\u6570\u636E\u5E93\u521D\u59CB\u5316\u5931\u8D25\uFF0C\u5269\u4F59\u91CD\u8BD5\u6B21\u6570 ${remaining}\uFF0C\u9519\u8BEF\uFF1A`, e);
        await new Promise((r) => setTimeout(r, 500 * (4 - remaining)));
        return attempt(remaining - 1);
      }
      throw e;
    }
  }, "attempt");
  dbInitPromise = attempt(retries);
  return dbInitPromise;
}
__name(initDB, "initDB");
async function getCheckState(db) {
  const row = await db.prepare("SELECT * FROM check_state WHERE id = 1").first();
  if (!row) {
    return {
      phase: "waiting",
      currentIndex: 0,
      cycleStartTime: (/* @__PURE__ */ new Date()).toISOString(),
      lastRepoCheckTime: null,
      cycleEndTime: null,
      cycleRepos: [],
      totalRepos: 0,
      version: 0
    };
  }
  return {
    phase: row.phase,
    currentIndex: row.current_index,
    cycleStartTime: row.cycle_start_time,
    lastRepoCheckTime: row.last_repo_check_time,
    cycleEndTime: row.cycle_end_time,
    cycleRepos: row.cycle_repos ? JSON.parse(row.cycle_repos) : [],
    totalRepos: row.total_repos,
    version: row.version
  };
}
__name(getCheckState, "getCheckState");
async function setCheckState(db, state) {
  const phase = state.phase || "waiting";
  const currentIndex = typeof state.currentIndex === "number" ? state.currentIndex : 0;
  const cycleStartTime = state.cycleStartTime || null;
  const lastRepoCheckTime = state.lastRepoCheckTime || null;
  const cycleEndTime = state.cycleEndTime || null;
  const cycleRepos = state.cycleRepos ? JSON.stringify(state.cycleRepos) : null;
  const totalRepos = typeof state.totalRepos === "number" ? state.totalRepos : 0;
  const version = typeof state.version === "number" ? state.version : 0;
  const newVersion = version + 1;
  const result = await db.prepare(`UPDATE check_state SET
    phase = ?1,
    current_index = ?2,
    cycle_start_time = ?3,
    last_repo_check_time = ?4,
    cycle_end_time = ?5,
    cycle_repos = ?6,
    total_repos = ?7,
    version = ?8
    WHERE id = 1 AND version = ?9`).bind(phase, currentIndex, cycleStartTime, lastRepoCheckTime, cycleEndTime, cycleRepos, totalRepos, newVersion, version).run();
  if (result.meta.changes === 0) {
    throw new Error("CAS_WRITE_CONFLICT");
  }
}
__name(setCheckState, "setCheckState");
async function withOptimisticLock(db, mutator, maxRetries = 3, initialState = null) {
  let state = initialState;
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (state === null) state = await getCheckState(db);
      const modified = await mutator(state);
      if (modified === null) return;
      await setCheckState(db, modified);
      return;
    } catch (e) {
      state = null;
      if (e.message !== "CAS_WRITE_CONFLICT" || i === maxRetries - 1) throw e;
      await new Promise((r) => setTimeout(r, 50 * Math.pow(2, i)));
    }
  }
}
__name(withOptimisticLock, "withOptimisticLock");
async function tryAdvanceAndGetRepo(db, preState = null) {
  let advancedItem = null;
  await withOptimisticLock(db, (state) => {
    if (state.phase !== "checking") return null;
    const repos = state.cycleRepos;
    if (!repos || state.currentIndex >= repos.length) {
      state.phase = "waiting";
      state.cycleEndTime = (/* @__PURE__ */ new Date()).toISOString();
      return state;
    }
    advancedItem = repos[state.currentIndex];
    state.currentIndex += 1;
    state.lastRepoCheckTime = (/* @__PURE__ */ new Date()).toISOString();
    if (state.currentIndex >= repos.length) {
      state.phase = "waiting";
      state.cycleEndTime = state.lastRepoCheckTime;
    }
    return state;
  }, 3, preState);
  return advancedItem ? { item: advancedItem } : null;
}
__name(tryAdvanceAndGetRepo, "tryAdvanceAndGetRepo");
var _settingsCache = null;
var _settingsCacheAt = 0;
var SETTINGS_CACHE_TTL_MS = 15e3;
async function getSettings(db) {
  const now = Date.now();
  if (_settingsCache && now - _settingsCacheAt < SETTINGS_CACHE_TTL_MS) {
    return { ..._settingsCache, dnd: { ..._settingsCache.dnd || {} } };
  }
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'system:settings'").first();
  let s;
  if (!row) s = { ...DEFAULT_SETTINGS };
  else {
    try {
      s = { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) };
    } catch {
      s = { ...DEFAULT_SETTINGS };
    }
  }
  s.dnd = { ...DEFAULT_SETTINGS.dnd || {}, ...s.dnd || {} };
  _settingsCache = s;
  _settingsCacheAt = now;
  return { ...s, dnd: { ...s.dnd } };
}
__name(getSettings, "getSettings");
async function saveSettings(db, settings) {
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('system:settings', ?)").bind(JSON.stringify(settings)).run();
  _settingsCache = null;
  _settingsCacheAt = 0;
}
__name(saveSettings, "saveSettings");
async function getNotificationTemplate(db) {
  const defaults = DEFAULT_NOTIFICATION_TEMPLATE;
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'system:notification_template'").first();
  if (!row) return JSON.parse(JSON.stringify(defaults));
  try {
    const parsed = JSON.parse(row.value);
    return sanitizeTemplate({
      update: { ...defaults.update, ...parsed.update || {} },
      alert: { ...defaults.alert, ...parsed.alert || {} }
    });
  } catch {
    return JSON.parse(JSON.stringify(defaults));
  }
}
__name(getNotificationTemplate, "getNotificationTemplate");
async function saveNotificationTemplate(db, template) {
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('system:notification_template', ?)").bind(JSON.stringify(template)).run();
}
__name(saveNotificationTemplate, "saveNotificationTemplate");
async function getNotifyChannel(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'system:notify_channel'").first();
  if (!row) return null;
  try {
    return sanitizeNotifyChannel(JSON.parse(row.value));
  } catch {
    return null;
  }
}
__name(getNotifyChannel, "getNotifyChannel");
async function saveNotifyChannel(db, channel) {
  const clean = sanitizeNotifyChannel(channel);
  if (!clean) return false;
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('system:notify_channel', ?)").bind(JSON.stringify(clean)).run();
  return true;
}
__name(saveNotifyChannel, "saveNotifyChannel");
function sanitizeNotifyChannel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return null;
  const method = typeof raw.method === "string" ? raw.method.toUpperCase() : "POST";
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return null;
  const headers = {};
  if (raw.headers && typeof raw.headers === "object") {
    for (const [k, v] of Object.entries(raw.headers)) {
      if (typeof k === "string" && (typeof v === "string" || typeof v === "number")) headers[k] = String(v);
    }
  }
  if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
  const bodyTemplate = typeof raw.bodyTemplate === "string" && raw.bodyTemplate.length > 0 ? raw.bodyTemplate : '{"title":"{title}","content":"{content}"}';
  const enabled = raw.enabled !== false;
  return { type: "custom_http", enabled, url, method, headers, bodyTemplate };
}
__name(sanitizeNotifyChannel, "sanitizeNotifyChannel");
var RELEASE_EVENTS_KEEP = 200;
var INAPP_CHANNEL_KEY = "system:inapp_channel";
function sanitizeInappChannel(raw) {
  return { enabled: !raw || raw.enabled !== false };
}
__name(sanitizeInappChannel, "sanitizeInappChannel");
async function getInappChannel(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(INAPP_CHANNEL_KEY).first();
  if (!row) return { enabled: true };
  try {
    return sanitizeInappChannel(JSON.parse(row.value));
  } catch {
    return { enabled: true };
  }
}
__name(getInappChannel, "getInappChannel");
async function saveInappChannel(db, val) {
  const clean = sanitizeInappChannel(val);
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(INAPP_CHANNEL_KEY, JSON.stringify(clean)).run();
  return clean;
}
__name(saveInappChannel, "saveInappChannel");
var RELEASE_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\//i;
function isReleaseUrl(u) {
  return typeof u === "string" && RELEASE_URL_RE.test(u);
}
__name(isReleaseUrl, "isReleaseUrl");
async function recordReleaseEvent(db, repo, tag, url) {
  try {
    const repoStr = String(repo || "");
    const tagStr = String(tag || "");
    const res = await db.prepare("INSERT OR IGNORE INTO release_events (repo, tag, url, detected_at) VALUES (?1, ?2, ?3, ?4)").bind(repoStr, tagStr, String(url || ""), (/* @__PURE__ */ new Date()).toISOString()).run();
    const inserted = !(res && res.meta && typeof res.meta.changes === "number") || res.meta.changes > 0;
    if (inserted) {
      await db.prepare("DELETE FROM release_events WHERE id NOT IN (SELECT id FROM release_events ORDER BY id DESC LIMIT " + RELEASE_EVENTS_KEEP + ")").run();
    } else if (isReleaseUrl(url)) {
      const row = await db.prepare("SELECT url FROM release_events WHERE repo = ?1 AND tag = ?2").bind(repoStr, tagStr).first();
      if (row && !isReleaseUrl(row.url)) {
        await db.prepare("UPDATE release_events SET url = ?1 WHERE repo = ?2 AND tag = ?3").bind(String(url), repoStr, tagStr).run();
      }
    }
  } catch (e) {
    console.error("\u8BB0\u5F55 release_events \u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u5DE1\u68C0\u4E3B\u6D41\u7A0B\uFF09", e);
  }
}
__name(recordReleaseEvent, "recordReleaseEvent");
async function getStoredRepos(db) {
  const { results } = await db.prepare("SELECT repo, custom_url, note FROM repos").all();
  return (results || []).map((r) => ({ ...r, note: r.note || "" }));
}
__name(getStoredRepos, "getStoredRepos");
async function addRepo(db, repo, custom_url, note = "") {
  await db.prepare("INSERT OR IGNORE INTO repos (repo, custom_url, note) VALUES (?1, ?2, ?3)").bind(repo, custom_url, note).run();
}
__name(addRepo, "addRepo");
async function deleteRepo(db, repo) {
  await db.batch([
    db.prepare("DELETE FROM repos WHERE repo = ?").bind(repo),
    db.prepare("DELETE FROM repo_state WHERE repo = ?").bind(repo),
    db.prepare("DELETE FROM release_events WHERE repo = ?").bind(repo)
  ]);
}
__name(deleteRepo, "deleteRepo");
var STATE_EMPTY = { tag: null, etag: null, errors: null, notifiedTag: null, attempts: 0 };
async function getRepoStateRow(db, repo) {
  const row = await db.prepare("SELECT tag, etag, errors_json, last_notified_tag, notify_attempts FROM repo_state WHERE repo = ?").bind(repo).first();
  if (!row) return { ...STATE_EMPTY };
  let errors = null;
  if (row.errors_json) {
    try {
      errors = JSON.parse(row.errors_json);
    } catch (e) {
      errors = null;
    }
  }
  return {
    tag: row.tag || null,
    etag: row.etag || null,
    errors,
    notifiedTag: row.last_notified_tag || null,
    attempts: row.notify_attempts || 0
  };
}
__name(getRepoStateRow, "getRepoStateRow");
var STATE_WRITE_COLS = ["tag", "etag", "errors_json", "last_notified_tag", "notify_attempts"];
async function writeRepoState(db, repo, patch) {
  const cols = [];
  const vals = [];
  for (const c of STATE_WRITE_COLS) {
    if (!(c in patch)) continue;
    const v = patch[c];
    cols.push(c);
    vals.push(c === "errors_json" ? v === null || v === void 0 ? null : JSON.stringify(v) : v === void 0 ? null : v);
  }
  if (!cols.length) return;
  const n = cols.length;
  const marks = cols.map((_, i) => "?" + (i + 1)).join(", ");
  const sets = cols.map((c) => c + " = excluded." + c).join(", ");
  await db.prepare(`INSERT INTO repo_state (repo, ${cols.join(", ")}) VALUES (?${n + 1}, ${marks}) ON CONFLICT(repo) DO UPDATE SET ${sets}`).bind(...vals, repo).run();
}
__name(writeRepoState, "writeRepoState");
async function incNotifyAttempts(db, repo) {
  await db.prepare(`INSERT INTO repo_state (repo, notify_attempts) VALUES (?1, 1)
    ON CONFLICT(repo) DO UPDATE SET notify_attempts = notify_attempts + 1`).bind(repo).run();
}
__name(incNotifyAttempts, "incNotifyAttempts");
async function getErrorsMap(db) {
  const { results } = await db.prepare("SELECT repo, errors_json FROM repo_state WHERE errors_json IS NOT NULL").all();
  const map = {};
  for (const r of results) {
    try {
      map[r.repo] = JSON.parse(r.errors_json);
    } catch {
    }
  }
  return map;
}
__name(getErrorsMap, "getErrorsMap");
var lastTestTime = 0;
var index_default = {
  async scheduled(event, env, ctx) {
    const db = env.DB;
    try {
      await initDB(db);
    } catch (e) {
      console.error("\u5B9A\u65F6\u4EFB\u52A1\u521D\u59CB\u5316\u5931\u8D25", e);
      return;
    }
    ctx.waitUntil(performScheduledCheck(env).catch((e) => console.error("\u5B9A\u65F6\u5DE1\u68C0\u5F02\u5E38", e)));
    // Cloudflare 配额巡检：距上次成功巡检超过 55 分钟才跑，约合每小时一次。
    // 用「时间差」而不是「整点分钟数」判断，cron 抖动或漏跑都能自愈。
    ctx.waitUntil((async () => {
      try {
        const last = await getQuotaState(db);
        const lastTs = last && last.timestamp ? new Date(last.timestamp).getTime() : 0;
        if (Date.now() - lastTs >= 55 * 60 * 1000) {
          await runQuotaCheckAndNotify(env, db);
        }
      } catch (e) {
        console.error("配额巡检失败", e && e.message || e);
      }
    })());
  },
  async fetch(request, env, ctx) {
    const db = env.DB;
    const url = new URL(request.url);
    let dbReady = false;
    let initError = null;
    try {
      await initDB(db);
      dbReady = true;
    } catch (e) {
      initError = e;
    }
    if (url.pathname.startsWith("/api/")) {
      if (!dbReady) {
        const errorMsg = initError ? initError.message : "Database unavailable";
        return new Response(JSON.stringify({ error: errorMsg }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        });
      }
      const providedKey = request.headers.get("X-API-Key") || url.searchParams.get("key");
      if (!providedKey || providedKey !== env.API_KEY) {
        return jsonResponse({ error: "Unauthorized" }, 403);
      }
    }
    let body = null;
    if (request.method === "POST" || request.method === "PUT") {
      try {
        const text = await request.text();
        if (text.length > 65536) return jsonResponse({ error: "Request body too large" }, 413);
        if (text.length > 0) body = JSON.parse(text);
      } catch (err) {
        if (err instanceof SyntaxError) return jsonResponse({ error: "Invalid JSON" }, 400);
        throw err;
      }
    }
    if (url.pathname === "/api/get-settings") {
      try {
        const [settings, state] = await Promise.all([getSettings(db), getCheckState(db)]);
        return jsonResponse({ settings, state });
      } catch (e) {
        return jsonResponse({ error: "D1 \u72B6\u6001\u8BFB\u53D6\u5931\u8D25: " + e.message }, 500);
      }
    }
    if (url.pathname === "/api/save-settings" && request.method === "POST") {
      if (!body) return jsonResponse({ error: "Missing body" }, 400);
      const settings = await getSettings(db);
      if (body.repoIntervalMinutes !== void 0) {
        const v = parseInt(body.repoIntervalMinutes, 10);
        if (isNaN(v) || v < 5 || v > 60) return jsonResponse({ success: false, error: "\u4ED3\u5E93\u95F4\u9694\u9700\u5728 5~60 \u5206\u949F\u4E4B\u95F4" }, 400);
        settings.repoIntervalMinutes = v;
      }
      if (body.cycleIntervalHours !== void 0) {
        const v = parseInt(body.cycleIntervalHours, 10);
        if (isNaN(v) || v < 1 || v > 48) return jsonResponse({ success: false, error: "\u5468\u671F\u95F4\u9694\u9700\u5728 1~48 \u5C0F\u65F6\u4E4B\u95F4" }, 400);
        settings.cycleIntervalHours = v;
      }
      if (body.dnd !== void 0) {
        const d = body.dnd;
        if (typeof d !== "object" || d === null) return jsonResponse({ success: false, error: "dnd \u5FC5\u987B\u4E3A\u5BF9\u8C61" }, 400);
        const dnd = { ...settings.dnd || { enabled: false, start: "23:00", end: "08:00" } };
        if (d.enabled !== void 0) {
          if (typeof d.enabled !== "boolean") return jsonResponse({ success: false, error: "dnd.enabled \u5FC5\u987B\u4E3A\u5E03\u5C14\u503C" }, 400);
          dnd.enabled = d.enabled;
        }
        if (d.start !== void 0) {
          if (!/^\d{1,2}:\d{2}$/.test(d.start)) return jsonResponse({ success: false, error: "dnd.start \u683C\u5F0F\u5E94\u4E3A HH:MM\uFF08\u5317\u4EAC\u65F6\u95F4\uFF09" }, 400);
          const [sh, sm] = d.start.split(":").map(Number);
          if (sh > 23 || sm > 59) return jsonResponse({ success: false, error: "dnd.start \u65F6\u95F4\u8D85\u51FA\u8303\u56F4" }, 400);
          dnd.start = d.start;
        }
        if (d.end !== void 0) {
          if (!/^\d{1,2}:\d{2}$/.test(d.end)) return jsonResponse({ success: false, error: "dnd.end \u683C\u5F0F\u5E94\u4E3A HH:MM\uFF08\u5317\u4EAC\u65F6\u95F4\uFF09" }, 400);
          const [eh, em] = d.end.split(":").map(Number);
          if (eh > 23 || em > 59) return jsonResponse({ success: false, error: "dnd.end \u65F6\u95F4\u8D85\u51FA\u8303\u56F4" }, 400);
          dnd.end = d.end;
        }
        settings.dnd = dnd;
      }
      await saveSettings(db, settings);
      return jsonResponse({ success: true, settings });
    }
    if (url.pathname === "/api/quota" && request.method === "GET") {
      try {
        const quota = await getQuotaState(db);
        const configured = !!(String(env.CF_API_TOKEN || "").trim() && String(env.CF_ACCOUNT_ID || "").trim());
        return jsonResponse({ quota, configured });
      } catch (e) {
        return jsonResponse({ error: "配额状态读取失败: " + e.message }, 500);
      }
    }
    if (url.pathname === "/api/quota/check" && request.method === "POST") {
      try {
        const quota = await runQuotaCheckAndNotify(env, db);
        return jsonResponse({ success: true, quota });
      } catch (e) {
        return jsonResponse({ success: false, error: e.message || String(e) }, 500);
      }
    }
    if (url.pathname === "/api/get-notification-config") {
      const config = await getNotificationTemplate(db);
      return jsonResponse(config);
    }
    if (url.pathname === "/api/save-notification-config" && request.method === "POST") {
      if (!body) return jsonResponse({ error: "Missing body" }, 400);
      if (!body.update || !body.alert) return jsonResponse({ success: false, error: "\u914D\u7F6E\u5FC5\u987B\u5305\u542B update \u548C alert \u5BF9\u8C61" }, 400);
      const MAX_FIELDS = 20;
      const MAX_FIELD_LENGTH = 500;
      for (const section of ["update", "alert"]) {
        const sectionObj = body[section];
        if (!sectionObj || typeof sectionObj !== "object") return jsonResponse({ success: false, error: `${section} \u5FC5\u987B\u4E3A\u5BF9\u8C61` }, 400);
        const keys = Object.keys(sectionObj);
        if (keys.length > MAX_FIELDS) return jsonResponse({ success: false, error: `${section} \u5B57\u6BB5\u6570\u91CF\u4E0D\u80FD\u8D85\u8FC7 ${MAX_FIELDS}` }, 400);
        for (const [k, v] of Object.entries(sectionObj)) {
          if (typeof v !== "string") return jsonResponse({ success: false, error: `${section}.${k} \u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32` }, 400);
          if (v.length > MAX_FIELD_LENGTH) return jsonResponse({ success: false, error: `${section}.${k} \u957F\u5EA6\u4E0D\u80FD\u8D85\u8FC7 ${MAX_FIELD_LENGTH} \u5B57\u7B26` }, 400);
        }
      }
      for (const section of ["update", "alert"]) {
        for (const [k, v] of Object.entries(body[section])) {
          const matches = v.matchAll(VAR_REGEX);
          for (const m of matches) {
            if (!ALLOWED_TEMPLATE_VARS[section].includes(m[1])) {
              return jsonResponse({ success: false, error: `\u4E0D\u5141\u8BB8\u7684\u53D8\u91CF {${m[1]}} \u5728 ${section}.${k} \u4E2D` }, 400);
            }
          }
        }
      }
      const cleaned = sanitizeTemplate(body);
      await saveNotificationTemplate(db, cleaned);
      const merged = {
        update: { ...DEFAULT_NOTIFICATION_TEMPLATE.update, ...cleaned.update },
        alert: { ...DEFAULT_NOTIFICATION_TEMPLATE.alert, ...cleaned.alert }
      };
      return jsonResponse({ success: true, config: merged });
    }
    if (url.pathname === "/api/get-notify-channel") {
      const ch = await getNotifyChannel(db);
      let masked = null;
      if (ch) {
        masked = { ...ch };
        if (masked.headers && masked.headers["Authorization"]) {
          masked.headers = { ...masked.headers, Authorization: "***" };
        }
      }
      return jsonResponse({ channel: masked });
    }
    if (url.pathname === "/api/save-notify-channel" && request.method === "POST") {
      if (!body) return jsonResponse({ error: "Missing body" }, 400);
      const clean = sanitizeNotifyChannel(body);
      if (!clean) return jsonResponse({ success: false, error: "\u65E0\u6548\u7684\u901A\u77E5\u901A\u9053\u914D\u7F6E\uFF1Aurl \u987B\u4E3A http(s) \u7EDD\u5BF9\u5730\u5740\uFF0Cmethod \u987B\u4E3A GET/POST/PUT/PATCH/DELETE" }, 400);
      await saveNotifyChannel(db, clean);
      const outHeaders = clean.headers.Authorization ? { ...clean.headers, Authorization: "***" } : clean.headers;
      return jsonResponse({ success: true, channel: { ...clean, headers: outHeaders } });
    }
    if (url.pathname === "/api/get-inapp-channel") {
      const channel = await getInappChannel(db);
      return jsonResponse({ channel });
    }
    if (url.pathname === "/api/save-inapp-channel" && request.method === "POST") {
      if (!body) return jsonResponse({ error: "Missing body" }, 400);
      if (body.enabled !== void 0 && typeof body.enabled !== "boolean") {
        return jsonResponse({ success: false, error: "enabled \u5FC5\u987B\u4E3A\u5E03\u5C14\u503C" }, 400);
      }
      const channel = await saveInappChannel(db, body);
      return jsonResponse({ success: true, channel });
    }
    if (url.pathname === "/api/get-repos") {
      const repos = await getStoredRepos(db);
      const errorsMap = await getErrorsMap(db);
      const enriched = repos.map((item) => {
        const err = errorsMap[item.repo];
        let health = "ok", lastError = "", reason = "", judgeReason = "";
        if (err) {
          if (err.permanent) health = "dead";
          else if (err.noRelease) health = "empty";
          else if (err.count > 0) health = "warning";
          else if (err.alertedAt) health = "recovered";
          lastError = err.lastError || "";
          reason = err.lastReason || "";
          judgeReason = err.judgeReason || "";
        }
        return { ...item, health, lastError, reason, judgeReason };
      });
      return jsonResponse(enriched);
    }
    if (url.pathname === "/api/get-updates") {
      try {
        const { results } = await db.prepare("SELECT id, repo, tag, url, detected_at FROM release_events ORDER BY id DESC LIMIT 100").all();
        return jsonResponse({ updates: (results || []).map((r) => ({ id: r.id, repo: r.repo, tag: r.tag, url: r.url, detected_at: r.detected_at })) });
      } catch (e) {
        return jsonResponse({ error: "\u8BFB\u53D6\u66F4\u65B0\u4E8B\u4EF6\u5931\u8D25: " + e.message }, 500);
      }
    }
    if (url.pathname === "/api/dismiss-update" && request.method === "POST") {
      if (!body) return jsonResponse({ error: "Missing body" }, 400);
      const id = parseInt(body.id, 10);
      if (!Number.isFinite(id)) return jsonResponse({ success: false, error: "缺少有效的 id 参数" }, 400);
      try {
        await db.prepare("DELETE FROM release_events WHERE id = ?1").bind(id).run();
        return jsonResponse({ success: true });
      } catch (e) {
        return jsonResponse({ success: false, error: "删除失败: " + e.message }, 500);
      }
    }
    if (url.pathname === "/api/clear-updates" && request.method === "POST") {
      try {
        await db.prepare("DELETE FROM release_events").run();
        return jsonResponse({ success: true });
      } catch (e) {
        return jsonResponse({ success: false, error: "清空失败: " + e.message }, 500);
      }
    }
    if (url.pathname === "/api/add-repo" && request.method === "POST") {
      if (!body) return jsonResponse({ error: "Missing body" }, 400);
      const { repo, note } = body;
      if (!repo || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || repo.includes("..")) {
        return jsonResponse({ success: false, error: "\u683C\u5F0F\u5E94\u4E3A\u300C\u4F5C\u8005/\u9879\u76EE\u540D\u300D" }, 400);
      }
      const repos = await getStoredRepos(db);
      if (repos.some((item) => item.repo.toLowerCase() === repo.toLowerCase())) {
        return jsonResponse({ success: false, error: "\u9879\u76EE\u5DF2\u5728\u76D1\u63A7\u4E2D" }, 400);
      }
      const custom_url = `https://github.com/${repo}/releases`;
      await addRepo(db, repo, custom_url, note || "");
      const updated = await getStoredRepos(db);
      return jsonResponse({ success: true, repos: updated });
    }
    if (url.pathname === "/api/update-note" && request.method === "POST") {
      if (!body) return jsonResponse({ error: "Missing body" }, 400);
      const { repo, note } = body;
      if (!repo) return jsonResponse({ success: false, error: "\u7F3A\u5C11 repo \u53C2\u6570" }, 400);
      const repos = await getStoredRepos(db);
      if (!repos.some((item) => item.repo === repo)) {
        return jsonResponse({ success: false, error: "\u9879\u76EE\u4E0D\u5B58\u5728" }, 404);
      }
      await db.prepare("UPDATE repos SET note = ?1 WHERE repo = ?2").bind(note || "", repo).run();
      return jsonResponse({ success: true });
    }
    if (url.pathname === "/api/delete-repo" && request.method === "POST") {
      if (!body) return jsonResponse({ error: "Missing body" }, 400);
      const { repo } = body;
      if (!repo) return jsonResponse({ success: false, error: "\u7F3A\u5C11 repo \u53C2\u6570" }, 400);
      let repos = await getStoredRepos(db);
      if (!repos.some((item) => item.repo === repo)) {
        return jsonResponse({ success: false, error: "\u9879\u76EE\u4E0D\u5B58\u5728" }, 404);
      }
      await deleteRepo(db, repo);
      try {
        await withOptimisticLock(db, (state) => {
          if (!state.cycleRepos) return null;
          const idx = state.cycleRepos.findIndex((r) => r.repo === repo);
          if (idx === -1) return null;
          state.cycleRepos.splice(idx, 1);
          state.totalRepos = state.cycleRepos.length;
          if (idx < state.currentIndex) {
            state.currentIndex--;
          } else if (state.currentIndex >= state.cycleRepos.length) {
            state.currentIndex = state.cycleRepos.length;
            if (state.phase === "checking") {
              state.phase = "waiting";
              state.cycleEndTime = (/* @__PURE__ */ new Date()).toISOString();
            }
          }
          return state;
        }, 3);
      } catch (e) {
        console.error("\u5220\u9664\u4ED3\u5E93\u65F6\u540C\u6B65 check_state \u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u6838\u5FC3\u5220\u9664\uFF09", e);
      }
      const updated = await getStoredRepos(db);
      return jsonResponse({ success: true, repos: updated });
    }
    if (url.pathname === "/api/export-repos") {
      const repos = await getStoredRepos(db);
      const lines = (repos || []).map((r) => r.repo);
      const txt = lines.join("\n") + (lines.length ? "\n" : "");
      return new Response(txt, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="repos_export.txt"'
        }
      });
    }
    if (url.pathname === "/api/import-repos" && request.method === "POST") {
      if (!body || typeof body.content !== "string") {
        return jsonResponse({ success: false, error: "\u7F3A\u5C11\u6587\u4EF6\u5185\u5BB9\uFF08content \u5B57\u6BB5\uFF09" }, 400);
      }
      const lines = body.content.split(/\r?\n/);
      const existing = new Set((await getStoredRepos(db)).map((r) => r.repo.toLowerCase()));
      const seen = /* @__PURE__ */ new Set();
      const stmts = [];
      let imported = 0, skipped = 0, invalid = 0;
      const invalidLines = [];
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        let repo = line, note = "";
        const pipe = line.indexOf("|");
        if (pipe > 0) {
          repo = line.slice(0, pipe).trim();
          note = line.slice(pipe + 1).trim();
        }
        if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || repo.includes("..")) {
          invalid++;
          if (invalidLines.length < 10) invalidLines.push(rawLine);
          continue;
        }
        const key = repo.toLowerCase();
        if (existing.has(key) || seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        stmts.push(db.prepare("INSERT OR IGNORE INTO repos (repo, custom_url, note) VALUES (?1, ?2, ?3)").bind(repo, `https://github.com/${repo}/releases`, note));
        imported++;
      }
      if (stmts.length) await db.batch(stmts);
      const updated = await getStoredRepos(db);
      return jsonResponse({ success: true, imported, skipped, invalid, invalidLines, repos: updated });
    }
    if (url.pathname === "/api/test") {
      if (Date.now() - lastTestTime < 1e4) {
        return jsonResponse({ error: "\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7 10 \u79D2\u540E\u518D\u8BD5" }, 429);
      }
      lastTestTime = Date.now();
      const repos = await getStoredRepos(db);
      if (!repos.length) {
        return jsonResponse({ tested: 0, total: 0, picked: null, results: [], error: "\u6682\u65E0\u76D1\u63A7\u4ED3\u5E93\uFF0C\u8BF7\u5148\u6DFB\u52A0\u81F3\u5C11\u4E00\u4E2A\u4ED3\u5E93" });
      }
      const idx = Math.floor(Math.random() * repos.length);
      const item = repos[idx];
      const res = await checkSingleRepo(env, item, true);
      const result = {
        repo: res.repo,
        success: res.success,
        push_ok: res.push_ok === true,
        is_new: !!res.is_new,
        dnd_hold: !!res.dnd_hold,
        skipped: !!res.skipped
      };
      return jsonResponse({ tested: 1, total: repos.length, picked: item.repo, results: [result] });
    }
    if (url.pathname === "/api/trigger-cycle" && request.method === "POST") {
      try {
        await startNewCycle(db);
        return jsonResponse({ success: true, message: "\u5DF2\u89E6\u53D1\u65B0\u4E00\u8F6E\u68C0\u6D4B" });
      } catch (e) {
        return jsonResponse({ success: false, error: "D1 \u64CD\u4F5C\u5931\u8D25: " + e.message }, 500);
      }
    }
    if (url.pathname === "/api/get-logs") {
      return jsonResponse([]);
    }
    return new Response(HTML_TEMPLATE, {
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
      }
    });
  }
};
// ==================== Cloudflare 配额巡检 ====================
// 由原 cf-quota-monitor 合并而来：同一个 Worker 内每小时整点巡检一次，
// 超阈值时复用本项目的通知渠道推送，不再单独占用 Worker 与 cron 名额。
var QUOTA_LIMITS = {
  d1: { rowsRead: 5e6, rowsWritten: 1e5, storageBytes: 5 * 1024 ** 3 },
  // Durable Objects：requests 为加权计费请求（HTTP 1:1、Hibernation 1:1、入站 WS 20:1，出站 WS 不计费）
  do: { requests: 1e5, durationPerDay: 13e3 },
  r2: { storageBytes: 10 * 1024 ** 3, classA: 1e6, classB: 1e7 },
  workers: { requestsPerDay: 1e5, buildMinutes: 3e3 },
  workflows: { stepsPerDay: 3e3 },
  kv: { storageBytes: 1 * 1024 ** 3, readsPerDay: 1e5, writesPerDay: 1e3 },
  queues: { opsPerDay: 1e4 }
};
var QUOTA_WARN = 0.8;
var QUOTA_CRIT = 1;
var QUOTA_CLASS_A = new Set(["PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "UploadPart", "DeleteObject"]);
var QUOTA_WS_RATIO = 20;
var QUOTA_QUERY = `query($acct:String,$daily:String,$monthly:String,$dayStart:String,$dayEnd:String){
  viewer { accounts(filter:{accountTag:$acct}) {
    d1q: d1QueriesAdaptiveGroups(limit:1000, filter:{date_geq:$daily}) { dimensions { date databaseId } sum { rowsRead rowsWritten } }
    d1s: d1StorageAdaptiveGroups(limit:1000, filter:{date_geq:$daily}) { dimensions { date } max { databaseSizeBytes } }
    r2s: r2StorageAdaptiveGroups(limit:2000, filter:{date_geq:$monthly}) { dimensions { bucketName date } max { payloadSize metadataSize objectCount } }
    r2o: r2OperationsAdaptiveGroups(limit:5000, filter:{date_geq:$monthly}) { dimensions { date actionType } sum { requests } }
    doi: durableObjectsInvocationsAdaptiveGroups(limit:1000, filter:{date_geq:$daily}) { dimensions { date scriptName type } sum { requests errors } }
    dodur: durableObjectsPeriodicGroups(limit:1000, filter:{date_geq:$daily, date_leq:$daily}) { dimensions { date } sum { duration inboundWebsocketMsgCount outboundWebsocketMsgCount } }
    wreq: workersInvocationsAdaptive(limit:5000, filter:{datetime_geq:$dayStart, datetime_leq:$dayEnd}) { dimensions { datetime scriptName } sum { requests } }
    wf: workflowsAdaptiveGroups(limit:10, filter:{date_geq:$daily}) { dimensions { date } sum { stepCount } }
    wbuild: workersBuildsBuildMinutesAdaptiveGroups(limit:1000, filter:{date_geq:$monthly}) { dimensions { date } sum { buildMinutes } }
    kvop: kvOperationsAdaptiveGroups(limit:2000, filter:{date_geq:$daily}) { dimensions { date actionType } sum { requests objectBytes } max { objectBytes } }
    kvst: kvStorageAdaptiveGroups(limit:1000, filter:{date_geq:$monthly}) { dimensions { date } max { byteCount keyCount } }
    q: queueMessageOperationsAdaptiveGroups(limit:1000, filter:{date_geq:$daily}) { dimensions { date } sum { billableOperations bytes } }
  } }
}`;

function quotaNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function quotaYmd(d) {
  return d.toISOString().slice(0, 10);
}
function quotaIsHibType(value) {
  const t = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!t) return false;
  return t.includes("hibernation") || (t.includes("websocket") && t.includes("message"));
}
function quotaMaxDaily(rows, fn) {
  const byDate = {};
  for (const r of rows || []) {
    const d = r.dimensions.date;
    const v = fn(r);
    if (!(d in byDate) || v > byDate[d]) byDate[d] = v;
  }
  const vals = Object.values(byDate);
  return vals.length ? Math.max(...vals) : 0;
}
function quotaLevel(pct) {
  return pct >= QUOTA_CRIT ? "critical" : pct >= QUOTA_WARN ? "warn" : "ok";
}
async function quotaGql(query, variables, token) {
  const res = await fetchWithTimeout("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  }, TIMEOUT_GITHUB);
  const j = await res.json();
  if (!j.data || j.errors) throw new Error("GraphQL error: " + JSON.stringify(j.errors || j));
  const acc = j.data.viewer.accounts[0];
  if (!acc) throw new Error("账号下没有可读数据，请检查 CF_ACCOUNT_ID 与令牌权限");
  return acc;
}
async function runQuotaCheck(env) {
  const token = String(env.CF_API_TOKEN || "").trim();
  const acct = String(env.CF_ACCOUNT_ID || "").trim();
  if (!token) throw new Error("未配置 CF_API_TOKEN");
  if (!acct) throw new Error("未配置 CF_ACCOUNT_ID");

  const now = new Date();
  const daily = quotaYmd(now);
  const monthly = quotaYmd(new Date(now.getTime() - 30 * 864e5));
  const dayStart = now.toISOString().slice(0, 11) + "00:00:00.000Z";
  const dayEnd = new Date(now.getTime() + 864e5).toISOString().slice(0, 11) + "00:00:00.000Z";
  const data = await quotaGql(QUOTA_QUERY, { acct, daily, monthly, dayStart, dayEnd }, token);

  let d1Read = 0, d1Write = 0, d1Store = 0, doErr = 0, doDur = 0, r2A = 0, r2B = 0;
  let doHttp = 0, doHib = 0, doInboundWS = 0, doOutboundWS = 0;
  let buildMin = 0, kvStore = 0, qOpsDay = 0, wReq = 0, wfSteps = 0;
  for (const r of data.d1q || []) {
    d1Read += Number(r.sum.rowsRead || 0);
    d1Write += Number(r.sum.rowsWritten || 0);
  }
  for (const r of data.d1s || []) d1Store += Number(r.max.databaseSizeBytes || 0);
  for (const r of data.doi || []) {
    const req = quotaNum(r.sum.requests);
    doErr += Number(r.sum.errors || 0);
    if (quotaIsHibType(r.dimensions.type)) doHib += req; else doHttp += req;
  }
  for (const r of data.dodur || []) {
    doDur += quotaNum(r.sum.duration);
    doInboundWS += quotaNum(r.sum.inboundWebsocketMsgCount);
    doOutboundWS += quotaNum(r.sum.outboundWebsocketMsgCount);
  }
  const doBillable = Math.ceil(doHttp) + Math.ceil(doHib) + Math.ceil(doInboundWS / QUOTA_WS_RATIO);
  for (const r of data.wreq || []) wReq += Number(r.sum.requests || 0);
  for (const r of data.wf || []) wfSteps += Number(r.sum.stepCount || 0);

  const r2StoreMap = {};
  for (const r of data.r2s || []) {
    const b = r.dimensions.bucketName;
    const p = Number(r.max.payloadSize || 0);
    if (!(b in r2StoreMap) || p > r2StoreMap[b]) r2StoreMap[b] = p;
  }
  const r2Store = Object.values(r2StoreMap).reduce((a, b) => a + b, 0);
  for (const r of data.r2o || []) {
    const req = Number(r.sum.requests || 0);
    if (QUOTA_CLASS_A.has(r.dimensions.actionType)) r2A += req; else r2B += req;
  }
  for (const r of data.wbuild || []) buildMin += Number(r.sum.buildMinutes || 0);
  for (const r of data.kvst || []) {
    const b = Number(r.max.byteCount || 0);
    if (b > kvStore) kvStore = b;
  }
  const kvReadDay = quotaMaxDaily(data.kvop || [], (r) => r.dimensions.actionType === "read" ? Number(r.sum.requests || 0) : 0);
  const kvWriteDay = quotaMaxDaily(data.kvop || [], (r) => r.dimensions.actionType === "write" ? Number(r.sum.requests || 0) : 0);
  qOpsDay = quotaMaxDaily(data.q || [], (r) => Number(r.sum.billableOperations || 0));

  const items = [
    { service: "Workers", metric: "请求 / 日", usage: wReq, limit: QUOTA_LIMITS.workers.requestsPerDay, unit: "req" },
    { service: "Workers", metric: "构建分钟 / 月", usage: Math.round(buildMin * 100) / 100, limit: QUOTA_LIMITS.workers.buildMinutes, unit: "min" },
    { service: "D1", metric: "行读取 / 日", usage: d1Read, limit: QUOTA_LIMITS.d1.rowsRead, unit: "rows" },
    { service: "D1", metric: "行写入 / 日", usage: d1Write, limit: QUOTA_LIMITS.d1.rowsWritten, unit: "rows" },
    { service: "D1", metric: "存储", usage: d1Store, limit: QUOTA_LIMITS.d1.storageBytes, unit: "bytes" },
    { service: "Durable Objects", metric: "计费请求 / 日", usage: doBillable, limit: QUOTA_LIMITS.do.requests, unit: "req" },
    { service: "Durable Objects", metric: "时长 GB-s / 日", usage: doDur, limit: QUOTA_LIMITS.do.durationPerDay, unit: "num" },
    { service: "R2", metric: "存储 (峰值)", usage: r2Store, limit: QUOTA_LIMITS.r2.storageBytes, unit: "bytes" },
    { service: "R2", metric: "A 类操作 / 月", usage: r2A, limit: QUOTA_LIMITS.r2.classA, unit: "ops" },
    { service: "R2", metric: "B 类操作 / 月", usage: r2B, limit: QUOTA_LIMITS.r2.classB, unit: "ops" },
    { service: "Workers KV", metric: "存储", usage: kvStore, limit: QUOTA_LIMITS.kv.storageBytes, unit: "bytes" },
    { service: "Workers KV", metric: "读取 / 日", usage: kvReadDay, limit: QUOTA_LIMITS.kv.readsPerDay, unit: "ops" },
    { service: "Workers KV", metric: "写入 / 日", usage: kvWriteDay, limit: QUOTA_LIMITS.kv.writesPerDay, unit: "ops" },
    { service: "Queues", metric: "操作 / 日", usage: qOpsDay, limit: QUOTA_LIMITS.queues.opsPerDay, unit: "ops" },
    { service: "Workflows", metric: "步骤 / 日", usage: wfSteps, limit: QUOTA_LIMITS.workflows.stepsPerDay, unit: "steps" }
  ];
  for (const it of items) {
    it.pct = it.limit > 0 ? it.usage / it.limit : 0;
    it.level = quotaLevel(it.pct);
  }
  const order = { critical: 3, warn: 2, ok: 1 };
  const overall = items.reduce((m, it) => order[it.level] > order[m] ? it.level : m, "ok");
  return { timestamp: now.toISOString(), overall, items, doErrors: doErr };
}
function quotaSignature(result) {
  return result.overall + ":" + result.items.filter((i) => i.level !== "ok").map((i) => i.service + "|" + i.metric + "|" + i.level).join(",");
}
function quotaAlertContent(result) {
  const risks = result.items.filter((i) => i.level !== "ok");
  const lines = risks.map((i) => i.service + " " + i.metric + " 已达 " + Math.round(i.pct * 100) + "%");
  return "Cloudflare 配额预警[" + result.overall.toUpperCase() + "] " + lines.join("，");
}
async function getQuotaState(db) {
  try {
    const row = await db.prepare("SELECT payload, updated_at FROM quota_state WHERE id = 1").first();
    if (!row || !row.payload) return null;
    return JSON.parse(row.payload);
  } catch (e) {
    return null;
  }
}
async function saveQuotaState(db, result, sig) {
  await db.prepare("INSERT INTO quota_state (id, payload, sig, updated_at) VALUES (1, ?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET payload = ?1, sig = ?2, updated_at = ?3")
    .bind(JSON.stringify(result), sig, result.timestamp).run();
}
async function getQuotaSig(db) {
  try {
    const row = await db.prepare("SELECT sig FROM quota_state WHERE id = 1").first();
    return row ? row.sig : null;
  } catch (e) {
    return null;
  }
}
// 巡检一次；overall 非 ok 且风险签名变化时才推送，避免重复打扰
async function runQuotaCheckAndNotify(env, db) {
  const result = await runQuotaCheck(env);
  const sig = quotaSignature(result);
  const lastSig = await getQuotaSig(db);
  let notified = false;
  if (result.overall !== "ok" && sig !== lastSig) {
    notified = await deliverNotification(env, db, {
      title: "Cloudflare 配额预警",
      content: quotaAlertContent(result)
    });
  }
  result.notified = !!notified;
  await saveQuotaState(db, result, sig);
  return result;
}
// ==================== 配额巡检结束 ====================

async function performScheduledCheck(env) {
  const db = env.DB;
  let state, settings;
  try {
    [state, settings] = await Promise.all([getCheckState(db), getSettings(db)]);
  } catch (e) {
    console.error("\u8BFB\u53D6\u68C0\u67E5\u72B6\u6001/\u8BBE\u7F6E\u5931\u8D25", e);
    return;
  }
  if (state.phase === "waiting") {
    const now = Date.now();
    const waitSince = state.cycleEndTime ? new Date(state.cycleEndTime).getTime() : state.cycleStartTime ? new Date(state.cycleStartTime).getTime() : NaN;
    if (isNaN(waitSince)) {
      console.error("\u72B6\u6001\u5F02\u5E38\uFF08cycleStartTime/cycleEndTime \u5747\u4E3A null\uFF09\uFF0C\u5F3A\u5236\u542F\u52A8\u65B0\u5468\u671F");
      await startNewCycle(db);
      return;
    }
    const cycleMs = settings.cycleIntervalHours * 3600 * 1e3;
    if (now - waitSince >= cycleMs) {
      try {
        await startNewCycle(db);
      } catch (e) {
        console.error("\u542F\u52A8\u65B0\u5468\u671F\u5931\u8D25", e);
      }
    }
    return;
  }
  if (state.phase === "checking") {
    if (state.lastRepoCheckTime) {
      const intervalMs = settings.repoIntervalMinutes * 60 * 1e3;
      if (Date.now() - new Date(state.lastRepoCheckTime).getTime() < intervalMs - 5e3) {
        return;
      }
    }
    const result = await tryAdvanceAndGetRepo(db, state);
    if (!result) return;
    await checkSingleRepo(env, result.item, false, settings.dnd);
  }
}
__name(performScheduledCheck, "performScheduledCheck");
async function startNewCycle(db) {
  const repos = await getStoredRepos(db);
  await withOptimisticLock(db, (state) => {
    state.phase = "checking";
    state.currentIndex = 0;
    state.cycleStartTime = (/* @__PURE__ */ new Date()).toISOString();
    state.lastRepoCheckTime = null;
    state.cycleEndTime = null;
    state.cycleRepos = repos;
    state.totalRepos = repos.length;
    return state;
  }, 3);
}
__name(startNewCycle, "startNewCycle");
async function checkSingleRepo(env, item, forceTrigger, dndSettings) {
  const db = env.DB;
  let repo = item.repo;
  let targetUrl = item.custom_url;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  let dndActive = false;
  if (!forceTrigger) {
    dndActive = isDndActive(dndSettings);
  }
  const st = forceTrigger ? { ...STATE_EMPTY } : await getRepoStateRow(db, repo);
  let errorInfo = st.errors;
  if (!forceTrigger && errorInfo && errorInfo.permanent) {
    // 修正：历史上被判「永久失效」的仓库不再永久跳过。
    // 超过冷却期就重新探测一次，成功后由 decayErrorCountForRepo 自动清除状态。
    const lastSeen = errorInfo.lastTime ? new Date(errorInfo.lastTime).getTime() : 0;
    const PERMANENT_RECHECK_MS = 6 * 3600 * 1000;
    if (Date.now() - lastSeen < PERMANENT_RECHECK_MS) return { repo, success: true, skipped: true };
  }
  const oldTag = forceTrigger ? null : st.tag;
  const githubHeaders = {
    "User-Agent": "CF-Worker-Release-Monitor",
    Accept: "application/vnd.github+json"
  };
  if (env.GITHUB_TOKEN) githubHeaders["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
  let data, fromCache = false, res;
  try {
    let etagCache = null;
    if (!forceTrigger && st.etag) {
      try {
        etagCache = JSON.parse(st.etag);
      } catch (e) {
        etagCache = null;
      }
    }
    const headers = { ...githubHeaders };
    if (etagCache?.etag && oldTag !== null) headers["If-None-Match"] = etagCache.etag;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        res = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases/latest`, { headers }, TIMEOUT_GITHUB);
        if (res.status === 404) {
          // 修正：/releases/latest 在「仓库存在但没有正式 Release」「只有预发布」「瞬时 404」时同样返回 404，
          // 不能据此判定仓库失效。先探测仓库本体，再回退到 releases 列表取最新一条。
          let repoAlive = false;
          try {
            const probe = await fetchWithTimeout(`https://api.github.com/repos/${repo}`, { headers: githubHeaders }, TIMEOUT_GITHUB);
            repoAlive = probe.ok;
          } catch (e) {
            repoAlive = false;
          }
          if (repoAlive) {
            let fbRelease = null;
            try {
              const lr = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases?per_page=5`, { headers: githubHeaders }, TIMEOUT_GITHUB);
              if (lr.ok) {
                const arr = await lr.json();
                if (Array.isArray(arr)) fbRelease = arr.find((x) => x && !x.draft) || null;
              }
            } catch (e) {
              fbRelease = null;
            }
            if (fbRelease && fbRelease.tag_name) {
              data = { tag_name: fbRelease.tag_name, html_url: fbRelease.html_url, url: fbRelease.url };
              fromCache = true; // 数据来自回退路径，不缓存本次 404 响应的 ETag
              // 注意：错误状态衰减由循环结束后的统一逻辑处理，此处不要再调用，避免重复扣减计数
              break;
            }
            // 仓库正常但确实没有任何 Release：属正常状态，清掉历史错误并标记「无发布」
            if (!forceTrigger) {
              await writeRepoState(db, repo, { errors_json: { noRelease: true, lastTime: now } });
            }
            return { repo, success: true, no_release: true };
          }
          // 仓库本体也不可访问：按「可恢复失败」计次，不再一次性判永久失效
          if (!forceTrigger) {
            errorInfo = errorInfo || { count: 0 };
            errorInfo.count = Math.min(ALERT_FAILURE_COUNT, (errorInfo.count || 0) + 1);
            errorInfo.lastError = "GitHub 返回 404：仓库不存在或已转为私有";
            errorInfo.lastReason = errorInfo.lastError;
            errorInfo.lastCategory = "404";
            errorInfo.lastTime = now;
            errorInfo.permanent = false;
            const reachedAlert = errorInfo.count >= ALERT_FAILURE_COUNT && !errorInfo.alertedAt && !dndActive;
            if (reachedAlert) {
              errorInfo.alertedAt = now;
              errorInfo.judgeReason = "连续 " + errorInfo.count + " 次检测失败（告警阈值 " + ALERT_FAILURE_COUNT + "）：" + errorInfo.lastError;
            }
            await writeRepoState(db, repo, { errors_json: errorInfo });
            if (reachedAlert) {
              const template = await getNotificationTemplate(db);
              await sendAlertNotification(env, db, buildPayload(template.alert, { repo, message: errorInfo.lastError, reason: errorInfo.lastReason, judge_reason: errorInfo.judgeReason }));
            }
          }
          return { repo, success: false };
        }
        if (res.status === 304) {
          fromCache = true;
          data = { tag_name: oldTag };
          break;
        }
        if (res.ok) {
          data = await res.json();
          if (!forceTrigger && data.url) {
            const match = data.url.match(/\/repos\/([^/]+\/[^/]+)\/releases\//);
            if (match && match[1] !== repo) {
              return await handleRename(env, repo, match[1], data.tag_name);
            }
          }
          break;
        }
        if (res.status === 403 || res.status === 429 || res.status >= 500) {
          if (attempt < 1) await new Promise((r) => setTimeout(r, 1e3 * Math.pow(2, attempt)));
          continue;
        }
        throw new Error(`GitHub API ${res.status}`);
      } catch (e) {
        if (attempt === 1 || e.message.startsWith("GitHub API")) throw e;
        if (attempt < 1) await new Promise((r) => setTimeout(r, 1e3 * Math.pow(2, attempt)));
      }
    }
    if (!data) throw new Error("\u65E0\u6CD5\u83B7\u53D6 release \u4FE1\u606F");
    const latestTag = data.tag_name;
    const isNew = latestTag && latestTag !== oldTag;
    const patch = {};
    if (!forceTrigger && !fromCache && res) patch.etag = JSON.stringify({ etag: res.headers.get("etag") || "" });
    if (!forceTrigger && errorInfo) {
      errorInfo = decayErrorCountForRepo(errorInfo, now);
      patch.errors_json = errorInfo;
    }
    if (!forceTrigger && isNew) {
      patch.tag = latestTag;
      patch.notify_attempts = 0;
    }
    if (Object.keys(patch).length) await writeRepoState(db, repo, patch);
    if (isNew && (forceTrigger || oldTag)) {
      let eventUrl;
      const htmlUrl = data && typeof data.html_url === "string" ? data.html_url : "";
      if (/^https:\/\/github\.com\//i.test(htmlUrl)) {
        eventUrl = htmlUrl;
      } else if (/^[^/\s]+\/[^/\s]+$/.test(repo)) {
        eventUrl = "https://github.com/" + repo + "/releases/tag/" + encodeURIComponent(latestTag);
      } else {
        eventUrl = targetUrl;
      }
      await recordReleaseEvent(db, repo, latestTag, eventUrl);
    }
    const lastNotified = forceTrigger ? null : st.notifiedTag;
    const alreadyNotified = !!latestTag && latestTag === lastNotified;
    const attempts = forceTrigger ? 0 : isNew ? 0 : st.attempts;
    const needNotify = forceTrigger || !alreadyNotified && attempts < MAX_NOTIFY_ATTEMPTS;
    if (needNotify) {
      if (dndActive) {
        return { repo, success: true, dnd_hold: true };
      }
      const [template, channel] = await Promise.all([getNotificationTemplate(db), getNotifyChannel(db)]);
      const repoName = repo.split("/")[1] || repo;
      const notifVars = { repo, repo_name: repoName, url: targetUrl, repo_url: targetUrl, tag: latestTag || oldTag || "\u6D4B\u8BD5" };
      const fields = buildPayload(template.update, notifVars);
      const pushOk = await deliverNotification(env, db, fields, { rawVars: notifVars, channel });
      if (pushOk) {
        const patch2 = { last_notified_tag: latestTag, notify_attempts: 0 };
        if (forceTrigger) patch2.tag = latestTag;
        await writeRepoState(db, repo, patch2);
      } else if (!forceTrigger) {
        await incNotifyAttempts(db, repo);
      }
      return { repo, success: true, push_ok: pushOk, is_new: !forceTrigger && isNew };
    }
    return { repo, success: true };
  } catch (err) {
    if (!forceTrigger) {
      const cls = classifyError(err, res);
      errorInfo = errorInfo || { count: 0 };
      errorInfo.count = (errorInfo.count || 0) + 1;
      errorInfo.lastError = err.message;
      errorInfo.lastReason = cls.reason;
      errorInfo.lastCategory = cls.category;
      errorInfo.lastTime = now;
      errorInfo.successCount = 0;
      const judgeReason = "\u8FDE\u7EED " + errorInfo.count + " \u6B21\u68C0\u6D4B\u5931\u8D25\uFF08\u544A\u8B66\u9608\u503C " + ALERT_FAILURE_COUNT + "\uFF09\uFF1A" + cls.reason;
      if (errorInfo.count >= ALERT_FAILURE_COUNT && !errorInfo.alertedAt && !dndActive) {
        const template = await getNotificationTemplate(db);
        await sendAlertNotification(env, db, buildPayload(template.alert, { repo, message: err.message, reason: cls.reason, judge_reason: judgeReason }));
        errorInfo.alertedAt = now;
      }
      try {
        await writeRepoState(db, repo, { errors_json: errorInfo });
      } catch (e2) {
        console.error("\u4FDD\u5B58\u9519\u8BEF\u8BA1\u6570\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u672C\u8F6E\u8FD4\u56DE\uFF09", e2);
      }
    }
    return { repo, success: false };
  }
}
__name(checkSingleRepo, "checkSingleRepo");
function decayErrorCountForRepo(errorInfo, now) {
  if (!errorInfo) return errorInfo;
  // 修正：本函数只在「本次检测成功」的路径被调用，历史遗留的 permanent / noRelease 标记都应直接清除
  if (errorInfo.permanent || errorInfo.noRelease) return null;
  if (errorInfo.alertedAt) {
    const alertedTime = new Date(errorInfo.alertedAt).getTime();
    if (Date.now() - alertedTime > ALERTED_AT_EXPIRE_HOURS * 3600 * 1e3) {
      return { ...errorInfo, alertedAt: null, lastTime: now };
    }
  }
  const newCount = Math.max(0, (errorInfo.count || 0) - 2);
  if (newCount === 0 && !errorInfo.alertedAt) {
    return null;
  } else if (newCount === 0 && errorInfo.alertedAt) {
    const successCount = (errorInfo.successCount || 0) + 1;
    if (successCount >= RECOVERED_SUCCESS_THRESHOLD) {
      return null;
    } else {
      return { ...errorInfo, count: 0, lastError: "", lastReason: "", judgeReason: "", lastTime: now, successCount };
    }
  } else {
    return { ...errorInfo, count: newCount, lastError: "", lastReason: "", judgeReason: "", lastTime: now, successCount: 0 };
  }
}
__name(decayErrorCountForRepo, "decayErrorCountForRepo");
async function handleRename(env, oldRepo, newRepo, tag) {
  const db = env.DB;
  await db.batch([
    db.prepare("UPDATE repos SET repo = ?1, custom_url = ?2 WHERE repo = ?3").bind(newRepo, `https://github.com/${newRepo}/releases`, oldRepo),
    db.prepare("INSERT OR IGNORE INTO repo_state (repo, tag, etag, errors_json, last_notified_tag, notify_attempts) SELECT ?1, tag, etag, errors_json, last_notified_tag, notify_attempts FROM repo_state WHERE repo = ?2").bind(newRepo, oldRepo),
    db.prepare("DELETE FROM repo_state WHERE repo = ?").bind(oldRepo),
    // 历史通知跟随改名：先删掉会撞 UNIQUE(repo, tag) 的旧名行，避免残留孤儿数据长期占位
    db.prepare("DELETE FROM release_events WHERE repo = ?2 AND tag IN (SELECT tag FROM release_events WHERE repo = ?1)").bind(newRepo, oldRepo),
    db.prepare("UPDATE OR IGNORE release_events SET repo = ?1 WHERE repo = ?2").bind(newRepo, oldRepo),
    db.prepare("INSERT OR IGNORE INTO repo_state (repo) VALUES (?)").bind(newRepo)
  ]);
  try {
    await withOptimisticLock(db, (state) => {
      if (!state.cycleRepos) return null;
      const repoInSnapshot = state.cycleRepos.find((r) => r.repo === oldRepo);
      if (!repoInSnapshot) return null;
      repoInSnapshot.repo = newRepo;
      repoInSnapshot.custom_url = `https://github.com/${newRepo}/releases`;
      return state;
    }, 3);
  } catch (e) {
    console.error("\u91CD\u547D\u540D\u540C\u6B65 check_state \u5FEB\u7167\u5931\u8D25", e);
  }
  return { repo: newRepo, success: true };
}
__name(handleRename, "handleRename");
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" }
  });
}
__name(jsonResponse, "jsonResponse");
function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
}
__name(fetchWithTimeout, "fetchWithTimeout");
async function sendAlertNotification(env, db, payload) {
  try {
    await deliverNotification(env, db, payload, { isAlert: true });
  } catch (e) {
  }
}
__name(sendAlertNotification, "sendAlertNotification");
async function deliverNotification(env, db, fields, opts = {}) {
  const channel = opts.channel !== void 0 ? opts.channel : await getNotifyChannel(db);
  let url, method, headers, bodyStr;
  if (channel && channel.enabled && channel.url) {
    url = channel.url;
    method = channel.method;
    headers = { ...channel.headers };
    const mergedVars = { ...fields, ...opts.rawVars || {} };
    bodyStr = substituteVars(channel.bodyTemplate, mergedVars);
  } else {
    url = env.WEBHOOK_URL;
    method = "POST";
    headers = { "Content-Type": "application/json", ...env.WEBHOOK_AUTH_TOKEN ? { Authorization: env.WEBHOOK_AUTH_TOKEN } : {} };
    bodyStr = JSON.stringify({ title: fields.title, content: fields.content });
  }
  if (!url) return false;
  let pushOk = false;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        method,
        headers,
        body: method === "GET" ? void 0 : bodyStr
      }, TIMEOUT_WEBHOOK);
      if (res.ok) {
        pushOk = true;
        break;
      }
    } catch (e) {
      if (attempt === 1) break;
    }
    if (attempt < 1) await new Promise((r) => setTimeout(r, 1e3));
  }
  return pushOk;
}
__name(deliverNotification, "deliverNotification");
function substituteVars(template, vars) {
  return template.replace(VAR_REGEX, (_, name) => {
    let val = vars[name] !== void 0 ? vars[name] : "{" + name + "}";
    if (typeof val === "string") val = val.replace(SANITIZE_REGEX, "");
    return val;
  });
}
__name(substituteVars, "substituteVars");
function buildPayload(template, vars) {
  const payload = {};
  for (const key of Object.keys(template)) {
    let value = template[key];
    if (typeof value === "string") {
      value = value.replace(VAR_REGEX, (_, varName) => {
        let val = vars[varName] !== void 0 ? vars[varName] : `{${varName}}`;
        if (typeof val === "string") val = val.replace(SANITIZE_REGEX, "");
        return val;
      });
    }
    payload[key] = value;
  }
  return payload;
}
__name(buildPayload, "buildPayload");
function classifyError(err, res) {
  const status = res && res.status ? res.status : null;
  const msg = err && err.message ? err.message : "";
  if (status === 404) return { reason: "GitHub \u8FD4\u56DE 404\uFF1A\u4ED3\u5E93\u53EF\u80FD\u5DF2\u5220\u9664\u3001\u6539\u540D\u6216\u8F6C\u4E3A\u79C1\u6709", category: "404" };
  if (status === 403 || status === 429) return { reason: "GitHub API \u9650\u6D41\u6216\u65E0\u6743\u9650\uFF08" + status + "\uFF09", category: "rate_limit" };
  if (status >= 500) return { reason: "GitHub \u670D\u52A1\u5668\u9519\u8BEF\uFF08" + status + "\uFF09", category: "server_error" };
  if (/fetch|timeout|timed out|network|ECONN|abort|Failed to fetch/i.test(msg)) return { reason: "\u7F51\u7EDC\u8BF7\u6C42\u5931\u8D25\u6216\u8D85\u65F6\uFF0C\u65E0\u6CD5\u8FDE\u63A5 GitHub", category: "network" };
  if (/JSON|parse|Unexpected token|SyntaxError/i.test(msg)) return { reason: "\u54CD\u5E94\u89E3\u6790\u5931\u8D25\uFF0CGitHub \u8FD4\u56DE\u4E86\u975E\u9884\u671F\u5185\u5BB9", category: "parse" };
  return { reason: msg || "\u672A\u77E5\u9519\u8BEF", category: "unknown" };
}
__name(classifyError, "classifyError");
// 主题自适应图标：SVG 内部用 prefers-color-scheme 判断，浅色主题深色猫头、
// 深色主题自动换成浅色猫头，浏览器标签栏上两种主题都能看清。
// 老浏览器不支持 SVG 图标时，用下面的 ICO 兜底。
var FAVICON_SVG = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
  '<style>.c{fill:#181717}@media (prefers-color-scheme:dark){.c{fill:#e9edf2}}</style>' +
  '<path class="c" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>' +
  "</svg>"
);
var FAVICON_B64 = "AAABAAEAQEAAAAEAIAAoQgAAFgAAACgAAABAAAAAgAAAAAEAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAbAAAAP8AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAD/AAAAJgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA+gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAGgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAB2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAA/AAAAP8AAAD8AAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAIAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKYAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAHgAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAIIAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAC4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACGAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAD0AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAALIAAAAiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASgAAAN4AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAHIAAAAAAAAAAAAAABIAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAJQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAyAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAADgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOgAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAADuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAQAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAACMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADWAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAADoAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAADaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPwAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACYAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAXAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAWAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANQAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAOQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAACyAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAACwAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAARgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqgAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAZgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMQAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAANYAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAADSAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4gAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAABeAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC4AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAFwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACUAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAACQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEwAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAhAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAANYAAACyAAAAtAAAANoAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD6AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAFgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOwAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAygAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAACWAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAHgAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAE4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC0AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAALIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMQAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAiAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAIwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKoAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAArgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMoAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAzgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACqAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAALIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABqAAAAyAAAAP8AAAD/AAAA/wAAAP8AAADIAAAAagAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//////////////3//7//////4P//B/////+A//8B/////gD//wB////8AP//AD////AA//8AD///4AD//wAH///Af///AAP//4H///8AAf//A////wAA//4D////AAB//Afj//8AAD/8B4D//wAAP/gPAP/+AAAf8B4Af/4AAA/wHAB//AAAD+B4AH/+AAAH4PAH///gAAfAAD////wAA8AAf////gADwAD/////AAOAAf////+AAYAD/////8ABgAf/////4AGAB//////gAQAP/////+AAAA//////8AAAD//////wAAAP//////AAAA//////8AAAD//////wAAAP//////AAAA//////8AAAD//////wAAAP//////AAAA//////8ACAD//////gAYAH/////+ABgAf/////wAGAA//////AAcAB/////4ADwAP/////gAPgA//////AB+AD/////8AH4AP/////wAfwA//////AD/gB/AAAP4Af+AHwAAAPgB/8AYAAAAOAP/4AAAAAAAB//wAAAAAAAP//AAAAAAAA//+AAAAAAAH//8AAAAAAA///8AAAAAAP///4AAAAAB////wAAAAAP////wAAAAD/////wAAAA//////wAAAP//////4AAH////////gf//////////////8=";
var HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>GitHub Release 监控控制台</title>
  <link rel="icon" type="image/svg+xml" href="${FAVICON_SVG}">
  <link rel="alternate icon" href="data:image/x-icon;base64,${FAVICON_B64}">
  <style>
    /* ============================================================
       Material Design 3 —— 色板（Color roles / Tonal palette）
       扁平化：一律用 tonal 表面色表达层级，不用阴影渐变
       ============================================================ */
    :root{
      /* Primary */
      --primary:#0B57D0; --on-primary:#FFFFFF;
      --primary-container:#D8E2FF; --on-primary-container:#001A41;
      /* Secondary */
      --secondary:#565E71; --on-secondary:#FFFFFF;
      --secondary-container:#DAE2F9; --on-secondary-container:#131C2B;
      /* Tertiary */
      --tertiary:#6D5670; --on-tertiary:#FFFFFF;
      --tertiary-container:#F7D9FA; --on-tertiary-container:#28132D;
      /* Error */
      --error:#BA1A1A; --on-error:#FFFFFF;
      --error-container:#FFDAD6; --on-error-container:#410002;
      /* 扩展：成功 / 警告（M3 无内置角色，用同法构造） */
      --success:#146C43; --on-success:#FFFFFF;
      --success-container:#B7F0C7; --on-success-container:#002112;
      --warning:#8A5000; --on-warning:#FFFFFF;
      --warning-container:#FFDCB9; --on-warning-container:#2E1500;
      /* Surface */
      --surface:#FAFAFC; --surface-dim:#DBDBE0; --surface-bright:#FAFAFC;
      --surface-container-lowest:#FFFFFF;
      --surface-container-low:#F4F4F8;
      --surface-container:#EEEFF3;
      --surface-container-high:#E8E9EF;
      --surface-container-highest:#E2E3EA;
      --surface-variant:#E1E2EC;
      --on-surface:#1A1B21; --on-surface-variant:#45464F;
      /* Outline */
      --outline:#757681; --outline-variant:#C5C6D0;
      /* Inverse（Snackbar） */
      --inverse-surface:#2F3036; --inverse-on-surface:#F1F0F7;
      /* Scrim */
      --scrim:rgba(0,0,0,.32);

      /* Shape —— M3 圆角刻度 */
      --r-xs:4px; --r-sm:8px; --r-md:12px; --r-lg:16px; --r-xl:28px; --r-full:999px;

      /* State layer —— M3 交互态靠 8% 叠加，不用阴影 */
      --state-hover:color-mix(in srgb,var(--on-surface) 8%,transparent);
      --state-focus:color-mix(in srgb,var(--on-surface) 10%,transparent);
      --state-press:color-mix(in srgb,var(--on-surface) 10%,transparent);

      /* Motion —— M3 emphasized / standard */
      --ease:cubic-bezier(.2,0,0,1);
      --ease-out:cubic-bezier(.05,.7,.1,1);
      --dur-short:150ms; --dur-med:220ms; --dur-long:320ms;

      /* Typography */
      --font:Roboto,"Google Sans Text","Google Sans",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
      --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;

      /* Spacing */
      --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px; --sp-6:24px; --sp-8:32px;

      /* Elevation（扁平：只在 FAB / Snackbar 保留极轻的一层） */
      --shadow-1:0 1px 2px rgba(0,0,0,.10);
      --shadow-2:0 2px 6px rgba(0,0,0,.12);
      --shadow-3:0 4px 12px rgba(0,0,0,.16);

      /* ---- 旧变量名兼容别名（脚本内仍按旧名取色） ---- */
      --pri:var(--primary); --pri-strong:var(--primary); --pri-soft:var(--primary-container); --pri-ink:var(--on-primary-container);
      --bg:var(--surface-container); --surface:var(--surface-container-lowest);
      --surface-2:var(--surface-container-low); --surface-3:var(--surface-container-high);
      --text:var(--on-surface); --text-2:var(--on-surface-variant); --text-3:var(--outline);
      --line:var(--outline-variant); --line-strong:var(--outline);
      --ok:var(--success); --ok-bg:var(--success-container);
      --warn:var(--warning); --warn-bg:var(--warning-container);
      --err:var(--error); --err-bg:var(--error-container);
      --recov:var(--tertiary); --recov-bg:var(--tertiary-container);
    }
    @media (prefers-color-scheme: dark){
      :root{
        --primary:#A9C8FF; --on-primary:#002A63;
        --primary-container:#00448B; --on-primary-container:#D8E2FF;
        --secondary:#BEC6DC; --on-secondary:#283141;
        --secondary-container:#3F4859; --on-secondary-container:#DAE2F9;
        --tertiary:#DBBDE0; --on-tertiary:#3D2942;
        --tertiary-container:#563F5B; --on-tertiary-container:#F7D9FA;
        --error:#FFB4AB; --on-error:#690005;
        --error-container:#93000A; --on-error-container:#FFDAD6;
        --success:#7BDCA0; --on-success:#00391F;
        --success-container:#005231; --on-success-container:#B7F0C7;
        --warning:#FFB77E; --on-warning:#4F2600;
        --warning-container:#733800; --on-warning-container:#FFDCB9;
        --surface:#12131A; --surface-dim:#12131A; --surface-bright:#383941;
        --surface-container-lowest:#0D0E14;
        --surface-container-low:#191A22;
        --surface-container:#1D1E26;
        --surface-container-high:#282933;
        --surface-container-highest:#33343E;
        --surface-variant:#424453;
        --on-surface:#E3E2E9; --on-surface-variant:#C5C6D0;
        --outline:#8F909A; --outline-variant:#45464F;
        --inverse-surface:#E3E2E9; --inverse-on-surface:#2F3036;
        --scrim:rgba(0,0,0,.55);
        --shadow-1:0 1px 2px rgba(0,0,0,.5);
        --shadow-2:0 2px 6px rgba(0,0,0,.55);
        --shadow-3:0 4px 14px rgba(0,0,0,.6);
      }
    }

    *,*::before,*::after{box-sizing:border-box}
    html{-webkit-text-size-adjust:100%}
    /* ===== M3 细滚动条 ===== */
    *{scrollbar-width:thin;scrollbar-color:var(--outline-variant) transparent}
    ::-webkit-scrollbar{width:8px;height:8px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:var(--outline-variant);border-radius:var(--r-full);border:2px solid transparent;background-clip:content-box}
    ::-webkit-scrollbar-thumb:hover{background:var(--outline);background-clip:content-box}
    ::-webkit-scrollbar-corner{background:transparent}

    body{
      margin:0;font-family:var(--font);
      background:var(--surface-container);color:var(--on-surface);
      font-size:14px;line-height:1.5;letter-spacing:.1px;
      padding:var(--sp-4) var(--sp-4) 96px;max-width:1080px;margin:0 auto;
      -webkit-font-smoothing:antialiased;
    }
    code,kbd{font-family:var(--mono);font-size:.86em;background:var(--surface-container-high);color:var(--on-surface-variant);padding:2px 6px;border-radius:var(--r-xs)}
    a{color:var(--primary);text-decoration:none}
    a:hover{text-decoration:underline}
    ::selection{background:var(--primary-container);color:var(--on-primary-container)}

    /* ===================== 顶部应用栏（M3 Small Top App Bar） ===================== */
    .app-bar{
      position:sticky;top:0;z-index:50;height:64px;display:flex;align-items:center;justify-content:space-between;
      gap:var(--sp-2);margin:-16px -16px 20px;padding:0 6px 0 16px;
      background:color-mix(in srgb,var(--surface-container) 86%,transparent);
      -webkit-backdrop-filter:blur(16px) saturate(160%);backdrop-filter:blur(16px) saturate(160%);
      border-bottom:1px solid var(--outline-variant);
    }
    .brand{display:flex;align-items:center;gap:12px;min-width:0}
    .brand .dot{
      flex:0 0 auto;width:34px;height:34px;border-radius:var(--r-md);
      background:var(--primary-container);color:var(--on-primary-container);
      display:inline-flex;align-items:center;justify-content:center;
    }
    .brand span.t{font-size:22px;line-height:28px;font-weight:400;letter-spacing:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .bar-actions{display:flex;align-items:center;gap:2px;flex:0 0 auto}
    /* M3 标准图标按钮 */
    .icon-btn{
      position:relative;width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;
      border:none;border-radius:var(--r-full);background:transparent;color:var(--on-surface-variant);cursor:pointer;
      transition:background var(--dur-short) var(--ease),color var(--dur-short) var(--ease);
    }
    .icon-btn:hover{background:color-mix(in srgb,var(--on-surface-variant) 10%,transparent);color:var(--on-surface)}
    .icon-btn:active{background:color-mix(in srgb,var(--on-surface-variant) 14%,transparent)}
    .icon-btn:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
    /* M3 Badge */
    .doc-badge{
      position:absolute;top:5px;right:5px;min-width:16px;height:16px;padding:0 4px;border-radius:var(--r-full);
      background:var(--error);color:var(--on-error);font-size:10px;font-weight:500;line-height:16px;text-align:center;
      box-shadow:0 0 0 2px var(--surface-container);
    }
    .doc-badge[hidden]{display:none}

    /* ===================== 更新横幅（M3 tonal container） ===================== */
    #updateBanner{display:flex;flex-direction:column;gap:var(--sp-2);margin-bottom:var(--sp-5)}
    #updateBanner:empty{display:none}
    .banner{
      display:flex;align-items:center;gap:var(--sp-3);
      background:var(--primary-container);color:var(--on-primary-container);
      border:none;border-radius:var(--r-md);padding:14px 8px 14px 16px;box-shadow:none;
    }
    .banner .b-main{flex:1 1 auto;min-width:0}
    .banner .b-repo{font-weight:500;font-size:15px;word-break:break-all}
    .banner .b-tag{font-family:var(--mono);font-size:.84em;opacity:.8;margin-left:8px}
    .banner .b-time{font-size:12px;opacity:.72;margin-top:2px}
    .banner .b-more{font-size:14px}
    .banner .hint{margin:0;color:var(--on-primary-container);opacity:.75}
    /* M3 文本按钮（横幅内） */
    .ghost-btn{
      flex:0 0 auto;height:36px;padding:0 12px;border-radius:var(--r-full);border:none;
      background:transparent;color:var(--primary);font-size:13px;font-weight:500;letter-spacing:.1px;cursor:pointer;font-family:var(--font);
      transition:background var(--dur-short) var(--ease);
    }
    .ghost-btn:hover{background:color-mix(in srgb,var(--on-primary-container) 8%,transparent)}
    .x-btn{
      flex:0 0 auto;width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;
      border:none;border-radius:var(--r-full);background:transparent;color:inherit;opacity:.7;cursor:pointer;
      transition:background var(--dur-short) var(--ease),opacity var(--dur-short) var(--ease);
    }
    .x-btn:hover{background:color-mix(in srgb,var(--on-primary-container) 10%,transparent);opacity:1}

    /* ===================== 概览统计（M3 filled card） ===================== */
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:var(--sp-3);margin-bottom:var(--sp-4)}
    .stat{
      background:var(--surface-container-lowest);border:1px solid var(--outline-variant);
      border-radius:var(--r-lg);padding:16px 18px;box-shadow:none;
    }
    .stat .n{display:block;font-size:30px;line-height:38px;font-weight:400;letter-spacing:0}
    .stat .l{display:block;font-size:12px;line-height:16px;letter-spacing:.5px;font-weight:500;color:var(--on-surface-variant);margin-top:2px}
    .stat.ok .n{color:var(--success)} .stat.bad .n{color:var(--error)} .stat.warn .n{color:var(--warning)}
    .stat .n{color:var(--primary)}

    /* ===================== 卡片（M3 outlined card） ===================== */
    .card{
      background:var(--surface-container-lowest);border:1px solid var(--outline-variant);border-radius:var(--r-lg);
      padding:var(--sp-5);margin-bottom:var(--sp-4);box-shadow:none;
    }
    .card-head{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-3);margin-bottom:var(--sp-4);flex-wrap:wrap}
    .card-head h2{margin:0;font-size:16px;line-height:24px;font-weight:500;display:flex;align-items:center;gap:8px}
    .card-head .sub{font-size:12px;letter-spacing:.5px;font-weight:500;color:var(--on-surface-variant)}

    /* ===================== 表单（M3 outlined text field） ===================== */
    .field{display:flex;align-items:center;gap:var(--sp-3);flex-wrap:wrap;margin-bottom:var(--sp-4)}
    .field:last-child{margin-bottom:0}
    .field > label{min-width:132px;font-size:13px;color:var(--on-surface-variant);font-weight:400}
    .input{
      height:48px;padding:0 16px;border:1px solid var(--outline);border-radius:var(--r-xs);
      background:transparent;color:var(--on-surface);font-family:var(--font);font-size:15px;letter-spacing:.1px;outline:none;
      transition:border-color var(--dur-short) var(--ease),box-shadow var(--dur-short) var(--ease);
    }
    .input::placeholder{color:var(--outline)}
    .input:hover{border-color:var(--on-surface)}
    .input:focus{border-color:var(--primary);box-shadow:inset 0 0 0 1px var(--primary)}
    .input.grow{flex:1 1 220px;min-width:0;width:100%}
    input[type=number].input{width:104px;text-align:center}
    input[type=time].input{width:auto}
    input[type=file]{font-size:13px;color:var(--on-surface-variant)}
    select.input{appearance:none;-webkit-appearance:none;padding-right:38px;
      background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 24 24' fill='none' stroke='%23757681' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9l6 6 6-6'/></svg>");
      background-repeat:no-repeat;background-position:right 10px center;cursor:pointer}
    textarea{
      width:100%;min-height:150px;padding:14px 16px;border:1px solid var(--outline);border-radius:var(--r-sm);
      background:transparent;color:var(--on-surface);font-family:var(--mono);font-size:13px;line-height:1.6;
      resize:vertical;outline:none;transition:border-color var(--dur-short) var(--ease),box-shadow var(--dur-short) var(--ease);
    }
    textarea:hover{border-color:var(--on-surface)}
    textarea:focus{border-color:var(--primary);box-shadow:inset 0 0 0 1px var(--primary)}
    input[type=checkbox]{width:18px;height:18px;accent-color:var(--primary);cursor:pointer}
    .hint{font-size:12px;line-height:16px;letter-spacing:.4px;color:var(--on-surface-variant);margin:0 0 var(--sp-3)}
    .hint code{font-size:.94em}

    /* ===================== 按钮（M3 common button：胶囊圆角） ===================== */
    .btn{
      display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 24px;
      border:1px solid transparent;border-radius:var(--r-full);font-family:var(--font);font-size:14px;font-weight:500;letter-spacing:.1px;
      cursor:pointer;white-space:nowrap;box-shadow:none;
      transition:background var(--dur-short) var(--ease),border-color var(--dur-short) var(--ease),color var(--dur-short) var(--ease);
    }
    .btn:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
    /* filled */
    .btn-primary{background:var(--primary);color:var(--on-primary)}
    .btn-primary:hover{background:color-mix(in srgb,var(--primary) 92%,var(--on-primary))}
    .btn-primary:active{background:color-mix(in srgb,var(--primary) 88%,var(--on-primary))}
    /* tonal */
    .btn-tonal{background:var(--secondary-container);color:var(--on-secondary-container)}
    .btn-tonal:hover{background:color-mix(in srgb,var(--secondary-container) 92%,var(--on-secondary-container))}
    /* outlined */
    .btn-outline{background:transparent;border-color:var(--outline);color:var(--primary)}
    .btn-outline:hover{background:color-mix(in srgb,var(--primary) 8%,transparent);border-color:var(--primary)}
    /* tonal error */
    .btn-danger{background:var(--error-container);color:var(--on-error-container)}
    .btn-danger:hover{background:color-mix(in srgb,var(--error-container) 90%,var(--on-error-container))}
    .btn-sm{height:36px;padding:0 16px;font-size:13px}
    .btn[disabled]{opacity:.38;pointer-events:none}
    .saved{font-size:12px;font-weight:500;color:var(--success);display:none}
    .saved.on{display:inline}

    /* ===================== 收纳区块（M3 outlined card + 展开） ===================== */
    details.mini{border:1px solid var(--outline-variant);border-radius:var(--r-md);background:var(--surface-container-low);margin-top:var(--sp-4)}
    details.mini > summary{
      list-style:none;cursor:pointer;padding:14px 16px;font-size:14px;font-weight:500;color:var(--on-surface);
      display:flex;align-items:center;gap:8px;border-radius:var(--r-md);
      transition:background var(--dur-short) var(--ease);
    }
    details.mini > summary:hover{background:var(--state-hover)}
    details.mini > summary::-webkit-details-marker{display:none}
    details.mini > summary::before{
      content:"";width:18px;height:18px;flex:0 0 auto;
      background:var(--on-surface-variant);
      -webkit-mask:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M9 6l6 6-6 6'/></svg>") center/contain no-repeat;
      mask:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M9 6l6 6-6 6'/></svg>") center/contain no-repeat;
      transition:transform var(--dur-med) var(--ease-out);
    }
    details.mini[open] > summary::before{transform:rotate(90deg)}
    details.mini > summary:focus-visible{outline:2px solid var(--primary);outline-offset:-2px;border-radius:var(--r-md)}
    .mini-body{padding:4px 16px 16px}

    /* ===================== 项目列表（M3 list） ===================== */
    .repo-list{
      background:var(--surface-container-lowest);border:1px solid var(--outline-variant);
      border-radius:var(--r-md);overflow:hidden;
    }
    .repo-row{
      display:grid;grid-template-columns:auto minmax(0,1fr) minmax(120px,220px) auto;align-items:center;gap:var(--sp-3);
      padding:10px 16px 10px 12px;background:transparent;border-bottom:1px solid var(--outline-variant);
      transition:background var(--dur-short) var(--ease);
    }
    .repo-row:last-child{border-bottom:none}
    .repo-row:hover{background:var(--state-hover)}
    .repo-id{min-width:0}
    .repo-name{display:block;font-weight:500;font-size:14px;word-break:break-all;line-height:1.45}
    .repo-link{display:inline-block;font-size:12px;color:var(--on-surface-variant);margin-top:1px}
    .repo-link:hover{color:var(--primary)}
    .note-input{
      width:100%;height:40px;padding:0 12px;border:1px solid var(--outline-variant);border-radius:var(--r-xs);
      background:transparent;color:var(--on-surface);font-size:13px;font-family:var(--font);outline:none;
      transition:border-color var(--dur-short) var(--ease),box-shadow var(--dur-short) var(--ease);
    }
    .note-input::placeholder{color:var(--outline)}
    .note-input:hover{border-color:var(--outline)}
    .note-input:focus{border-color:var(--primary);box-shadow:inset 0 0 0 1px var(--primary)}
    .repo-del{
      width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;
      border:none;border-radius:var(--r-full);background:transparent;color:var(--on-surface-variant);
      cursor:pointer;transition:background var(--dur-short) var(--ease),color var(--dur-short) var(--ease);
    }
    .repo-del:hover{background:color-mix(in srgb,var(--error) 12%,transparent);color:var(--error)}

    /* ===================== 状态徽章（M3 chip / tonal） ===================== */
    .badge{
      display:inline-block;padding:0 10px;height:24px;line-height:24px;border-radius:var(--r-sm);
      font-size:11px;font-weight:500;letter-spacing:.5px;white-space:nowrap;border:none;
    }
    .b-ok{background:var(--success-container);color:var(--on-success-container)}
    .b-warn{background:var(--warning-container);color:var(--on-warning-container)}
    .b-dead{background:var(--error-container);color:var(--on-error-container)}
    .b-recov{background:var(--tertiary-container);color:var(--on-tertiary-container)}
    .b-empty{background:var(--surface-container-highest);color:var(--on-surface-variant)}

    /* ===================== 配额卡片（MD3 filled card 网格） ===================== */
    .quota-actions{display:flex;align-items:center;gap:var(--sp-2);flex-wrap:wrap}
    .quota-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(216px,1fr));gap:var(--sp-3)}
    .quota-grid.collapsed .quota-item:nth-child(n+9){display:none}
    .quota-more{display:flex;justify-content:center;margin-top:4px}
    .quota-item{padding:12px 14px;border-radius:var(--r-sm);background:var(--surface-container-low);border:none}
    .quota-item .q-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
    .quota-item .q-svc{font-size:12px;line-height:16px;letter-spacing:.5px;font-weight:500;color:var(--on-surface-variant)}
    .quota-item .q-pct{font-size:12px;line-height:16px;font-weight:500;font-variant-numeric:tabular-nums}
    .quota-item .q-metric{font-size:13px;line-height:20px;margin-top:2px;color:var(--on-surface)}
    .quota-item .q-val{font-size:12px;line-height:16px;color:var(--on-surface-variant);font-variant-numeric:tabular-nums}
    .quota-item .q-bar{height:4px;border-radius:var(--r-full);background:var(--surface-container-highest);margin-top:8px;overflow:hidden}
    .quota-item .q-fill{height:100%;border-radius:var(--r-full);width:0;transition:width var(--dur-med) var(--ease)}
    .quota-item.ok .q-pct{color:var(--success)}
    .quota-item.ok .q-fill{background:var(--success)}
    .quota-item.warn .q-pct{color:var(--warning)}
    .quota-item.warn .q-fill{background:var(--warning)}
    .quota-item.critical .q-pct{color:var(--error)}
    .quota-item.critical .q-fill{background:var(--error)}
    @media (max-width:640px){
      .quota-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
      .quota-actions{width:100%;justify-content:flex-end}
    }

    /* ===================== 状态面板 ===================== */
    .state-panel{
      display:flex;align-items:flex-start;gap:10px;padding:14px 16px;border-radius:var(--r-md);
      background:var(--surface-container);border:1px solid var(--outline-variant);
      font-size:13px;line-height:1.7;color:var(--on-surface-variant);
    }
    .state-panel b{color:var(--on-surface);font-weight:500}
    .auth-error{
      display:none;background:var(--error-container);color:var(--on-error-container);
      border:none;padding:14px 16px;border-radius:var(--r-md);margin-bottom:var(--sp-4);font-size:14px;font-weight:500;
    }
    .result-block{
      background:var(--surface-container-high);border:1px solid var(--outline-variant);padding:14px 16px;border-radius:var(--r-sm);
      font-family:var(--mono);font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word;
      margin-top:var(--sp-3);color:var(--on-surface-variant);max-height:280px;overflow:auto;
    }
    .empty-hint{padding:32px 16px;text-align:center;font-size:13px;color:var(--on-surface-variant)}

    /* ===================== FAB（M3 FAB：16dp 圆角） ===================== */
    .fab{
      position:fixed;right:24px;bottom:24px;width:56px;height:56px;border:none;border-radius:var(--r-lg);
      background:var(--primary-container);color:var(--on-primary-container);
      display:flex;align-items:center;justify-content:center;cursor:pointer;
      box-shadow:var(--shadow-2);z-index:60;
      transition:background var(--dur-short) var(--ease),box-shadow var(--dur-med) var(--ease-out),transform var(--dur-short) var(--ease);
    }
    .fab:hover{box-shadow:var(--shadow-3);transform:translateY(-1px)}
    .fab:active{transform:scale(.96)}
    .fab:focus-visible{outline:2px solid var(--primary);outline-offset:2px}

    /* ===================== 抽屉（M3 modal drawer） ===================== */
    .scrim{position:fixed;inset:0;z-index:70;background:var(--scrim);opacity:0;visibility:hidden;
      transition:opacity var(--dur-med) var(--ease),visibility var(--dur-med) var(--ease)}
    .scrim.on{opacity:1;visibility:visible}
    .drawer{
      position:fixed;top:0;right:0;bottom:0;z-index:71;width:min(400px,100vw);display:flex;flex-direction:column;
      background:var(--surface-container-low);border:none;border-radius:var(--r-lg) 0 0 var(--r-lg);
      box-shadow:none;transform:translateX(102%);visibility:hidden;
      transition:transform var(--dur-long) var(--ease-out),visibility var(--dur-long) var(--ease-out);
    }
    .drawer.on{transform:translateX(0);visibility:visible}
    body.locked{overflow:hidden}
    .drawer-head{
      flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;
      height:64px;padding:0 8px 0 20px;background:transparent;
    }
    .drawer-head h2{margin:0;font-size:22px;line-height:28px;font-weight:400}
    .drawer-body{flex:1 1 auto;overflow-y:auto;padding:8px 16px 24px;overscroll-behavior:contain}
    .pane{display:none}
    .pane.on{display:block}

    /* 手风琴（M3 list item 风格） */
    .acc{
      border:none;border-radius:var(--r-md);margin-bottom:var(--sp-2);
      background:var(--surface-container);overflow:hidden;
      transition:background var(--dur-short) var(--ease);
    }
    .acc-head{
      width:100%;display:flex;align-items:center;justify-content:space-between;gap:var(--sp-3);
      min-height:56px;padding:12px 16px;border:none;background:transparent;cursor:pointer;font-family:var(--font);
      font-size:14px;font-weight:500;letter-spacing:.1px;color:var(--on-surface);text-align:left;
      transition:background var(--dur-short) var(--ease);
    }
    .acc-head:hover{background:var(--state-hover)}
    .acc-head:focus-visible{outline:2px solid var(--primary);outline-offset:-2px}
    .acc-head > span:first-child{display:flex;align-items:center;min-width:0}
    .acc-head .chev{color:var(--on-surface-variant);transition:transform var(--dur-med) var(--ease-out);flex:0 0 auto;display:inline-flex}
    .acc.on .acc-head .chev{transform:rotate(180deg)}
    .acc-head .acc-ico{
      display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;
      width:30px;height:30px;border-radius:var(--r-sm);background:var(--primary-container);
      color:var(--on-primary-container);font-size:14px;margin-right:12px;
    }
    .acc-body{display:grid;grid-template-rows:0fr;transition:grid-template-rows var(--dur-long) var(--ease-out)}
    .acc.on .acc-body{grid-template-rows:1fr}
    .acc-inner{overflow:hidden}
    .acc-content{padding:0 16px 18px}

    /* 通知列表 */
    .notif{
      display:flex;align-items:center;gap:var(--sp-2);padding:8px 8px 8px 16px;margin-bottom:var(--sp-2);
      border:none;border-radius:var(--r-md);background:var(--surface-container-lowest);
      transition:background var(--dur-short) var(--ease);
    }
    .notif:hover{background:color-mix(in srgb,var(--on-surface) 5%,var(--surface-container-lowest))}
    .notif-main{flex:1 1 auto;min-width:0;cursor:pointer;padding:4px 0}
    .notif-title{font-size:14px;font-weight:500;word-break:break-all;line-height:1.45}
    .notif-title .tag{font-family:var(--mono);font-weight:400;font-size:.86em;color:var(--primary);margin-left:6px}
    .notif-meta{font-size:12px;color:var(--on-surface-variant);margin-top:2px}
    .notif .x-btn{color:var(--on-surface-variant)}
    .notif .x-btn:hover{background:color-mix(in srgb,var(--error) 12%,transparent);color:var(--error)}

    /* Snackbar */
    .toast{
      position:fixed;left:50%;bottom:24px;transform:translate(-50%,16px);z-index:90;
      background:var(--inverse-surface);color:var(--inverse-on-surface);
      padding:14px 16px;border-radius:var(--r-sm);box-shadow:var(--shadow-3);
      font-size:13px;letter-spacing:.1px;opacity:0;pointer-events:none;
      transition:opacity var(--dur-med) var(--ease),transform var(--dur-med) var(--ease-out);
      max-width:min(560px,90vw);text-align:center;
    }
    .toast.on{opacity:1;transform:translate(-50%,0)}

    /* ===================== 响应式 ===================== */
    @media (max-width:820px){
      .stats{grid-template-columns:repeat(2,1fr)}
      .repo-row{grid-template-columns:auto minmax(0,1fr) auto;grid-template-areas:"badge name del" ". note note";row-gap:var(--sp-2)}
      .repo-row .badge{grid-area:badge}
      .repo-row .repo-id{grid-area:name}
      .repo-row .note-input{grid-area:note}
      .repo-row .repo-del{grid-area:del}
    }
    @media (max-width:640px){
      body{padding:8px 12px 92px}
      .app-bar{margin:-8px -12px 16px;padding:0 4px 0 12px;height:60px}
      .brand span.t{font-size:20px}
      .card{padding:var(--sp-4);border-radius:var(--r-md)}
      .field{flex-direction:column;align-items:stretch;gap:6px}
      .field > label{min-width:0}
      .btn{width:100%}
      .card-head .btn,.field .btn,.field .btn-sm{width:auto}
      .fab{right:16px;bottom:16px}
      .toast{bottom:16px}
    }
    @media (prefers-reduced-motion: reduce){
      *{transition-duration:1ms !important;animation-duration:1ms !important}
    }
  </style>
</head>
<body>
  <div id="authError" class="auth-error">鉴权失败：请在 URL 后加 <code>?key=你的API_KEY</code> 后重试</div>

  <header class="app-bar">
    <div class="brand">
      <span class="dot" aria-hidden="true">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
      </span>
      <span class="t">GitHub Release 监控</span>
    </div>
    <div class="bar-actions">
      <button class="icon-btn" id="bellBtn" type="button" title="通知中心" aria-label="通知中心">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        <span class="doc-badge" id="updateBadge" hidden>0</span>
      </button>
      <button class="icon-btn" id="gearBtn" type="button" title="设置" aria-label="设置">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
    </div>
  </header>

  <div id="updateBanner"></div>

  <section class="stats">
    <div class="stat"><span class="n" id="statTotal">0</span><span class="l">监控项目</span></div>
    <div class="stat ok"><span class="n" id="statOk">0</span><span class="l">运行正常</span></div>
    <div class="stat bad"><span class="n" id="statBad">0</span><span class="l">失效 / 异常</span></div>
    <div class="stat warn"><span class="n" id="statUnread">0</span><span class="l">未读通知</span></div>
  </section>

  <section class="card">
    <div class="card-head"><h2>检测状态</h2></div>
    <div id="stateInfo" class="state-panel">正在加载状态…</div>
  </section>

  <section class="card">
    <div class="card-head"><h2>添加监控项目</h2></div>
    <div class="field">
      <input type="text" id="repoInput" class="input grow" placeholder="owner/repo，例如 vuejs/core" autocomplete="off" spellcheck="false">
      <button class="btn btn-primary" id="addRepoBtn" type="button">添加</button>
    </div>
    <details class="mini">
      <summary>批量导入 / 导出</summary>
      <div class="mini-body">
        <p class="hint">导入：TXT 每行一个 <code>owner/name</code>，可附加 <code>owner/name|备注</code>；自动跳过空白、<code>#</code> 注释、重复与非法行。</p>
        <div class="field">
          <input type="file" id="importFile" accept=".txt,text/plain" class="grow">
          <button class="btn btn-tonal btn-sm" id="importBtn" type="button">导入</button>
          <button class="btn btn-outline btn-sm" id="exportBtn" type="button">导出</button>
        </div>
        <div id="importResult" class="hint" style="margin:8px 0 0"></div>
      </div>
    </details>
  </section>

  <section class="card">
    <div class="card-head">
      <h2>监控项目 <span class="sub" id="repoCount">0 个</span></h2>
    </div>
    <div class="repo-list" id="repoList"></div>
  </section>

  <section class="card">
    <div class="card-head">
      <h2>Cloudflare 配额 <span class="sub" id="quotaUpdated">尚未检测</span></h2>
      <div class="quota-actions">
        <span class="badge b-empty" id="quotaOverall">未知</span>
        <button class="btn btn-tonal btn-sm" id="quotaCheckBtn" type="button">立即检测</button>
      </div>
    </div>
    <div class="quota-grid" id="quotaList"></div>
    <div class="quota-more"><button class="ghost-btn" id="quotaToggle" type="button" style="display:none">展开全部</button></div>
    <p class="hint" id="quotaHint" style="margin:8px 0 0">正在加载配额数据…</p>
  </section>

  <div id="drawerScrim" class="scrim"></div>
  <aside id="drawerPanel" class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle">
    <div class="drawer-head">
      <h2 id="drawerTitle">设置</h2>
      <button class="icon-btn" type="button" title="关闭" aria-label="关闭" id="drawerClose">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="drawer-body">

      <div id="paneNotifications" class="pane">
        <div class="field" style="justify-content:space-between;margin-bottom:12px">
          <span class="hint" id="updateSummary" style="margin:0">暂无通知</span>
          <button class="btn btn-outline btn-sm" id="clearAllBtn" type="button">全部删除</button>
        </div>
        <div id="updateList"></div>
      </div>

      <div id="paneSettings" class="pane">

        <div class="acc on" data-acc>
          <button class="acc-head" type="button"><span><span class="acc-ico">🔔</span>站内通知中心</span><span class="chev"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span></button>
          <div class="acc-body"><div class="acc-inner"><div class="acc-content">
            <p class="hint">开启后：检测到版本更新会在页面顶部常驻横幅、右上角铃铛显示未读数。关闭仅隐藏入口，后台仍会记录更新事件。</p>
            <div class="field">
              <label for="inappEnabled">启用站内通知</label>
              <input type="checkbox" id="inappEnabled" checked>
              <button class="btn btn-primary btn-sm" id="saveInappBtn" type="button">保存</button>
              <span class="saved" id="inappSaved">已保存</span>
            </div>
          </div></div></div>
        </div>

        <div class="acc" data-acc>
          <button class="acc-head" type="button"><span><span class="acc-ico">📮</span>通知渠道（Webhook）</span><span class="chev"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span></button>
          <div class="acc-body"><div class="acc-inner"><div class="acc-content">
            <p class="hint">通知发送目的地。留空则回退使用 Cloudflare secret 的 WEBHOOK_URL / WEBHOOK_AUTH_TOKEN。</p>
            <div class="field">
              <label for="chEnabled">启用自定义通道</label>
              <input type="checkbox" id="chEnabled" checked>
            </div>
            <div class="field">
              <label for="chUrl">请求 URL</label>
              <input type="text" id="chUrl" class="input grow" placeholder="https://example.com/webhook" spellcheck="false">
            </div>
            <div class="field">
              <label for="chMethod">请求方法</label>
              <select id="chMethod" class="input"><option>POST</option><option>GET</option><option>PUT</option><option>PATCH</option></select>
            </div>
            <div class="field">
              <label for="chToken">Authorization</label>
              <input type="text" id="chToken" class="input grow" placeholder="留空则不带 Authorization 头" spellcheck="false">
            </div>
            <p class="hint" style="margin-top:4px">请求体模板，可用变量：<code>{title}</code> <code>{content}</code> <code>{repo_name}</code> <code>{url}</code> <code>{tag}</code> <code>{message}</code></p>
            <textarea id="chBody" spellcheck="false" style="min-height:96px" placeholder='{"title":"{title}","content":"{content}"}'></textarea>
            <div class="field" style="margin-top:12px">
              <button class="btn btn-primary btn-sm" id="saveChannelBtn" type="button">保存通道</button>
              <span class="saved" id="chSaved">已保存</span>
            </div>
          </div></div></div>
        </div>

        <div class="acc" data-acc>
          <button class="acc-head" type="button"><span><span class="acc-ico">⏱</span>检测节奏与免打扰</span><span class="chev"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span></button>
          <div class="acc-body"><div class="acc-inner"><div class="acc-content">
            <div class="field">
              <label for="repoInterval">仓库间隔（分钟）</label>
              <input type="number" id="repoInterval" class="input" min="5" max="60" value="5">
              <span class="hint" style="margin:0">每个仓库等待时间</span>
            </div>
            <div class="field">
              <label for="cycleInterval">周期间隔（小时）</label>
              <input type="number" id="cycleInterval" class="input" min="1" max="48" value="8">
              <span class="hint" style="margin:0">两轮检测之间等待</span>
            </div>
            <p class="hint" style="margin-top:12px">免打扰：指定时段（北京时间 UTC+8）内不发通知；期间的更新会保留并在结束后补发。</p>
            <div class="field">
              <label for="dndEnabled">启用免打扰</label>
              <input type="checkbox" id="dndEnabled">
              <span class="hint" id="dndStatus" style="margin:0"></span>
            </div>
            <div class="field">
              <label for="dndStart">开始时间</label>
              <input type="time" id="dndStart" class="input" value="23:00">
            </div>
            <div class="field">
              <label for="dndEnd">结束时间</label>
              <input type="time" id="dndEnd" class="input" value="08:00">
              <span class="hint" style="margin:0">结束 ≤ 开始表示跨午夜</span>
            </div>
            <div class="field" style="margin-top:12px">
              <button class="btn btn-primary btn-sm" id="saveSettingsBtn" type="button">保存设置</button>
              <span class="saved" id="settingsSaved">已保存</span>
            </div>
          </div></div></div>
        </div>

        <div class="acc" data-acc>
          <button class="acc-head" type="button"><span><span class="acc-ico">📝</span>通知内容模板</span><span class="chev"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span></button>
          <div class="acc-body"><div class="acc-inner"><div class="acc-content">
            <p class="hint">update：<code>{repo}</code> <code>{repo_name}</code> <code>{url}</code> <code>{repo_url}</code> <code>{tag}</code>　alert：<code>{repo}</code> <code>{message}</code></p>
            <textarea id="notificationTemplate" spellcheck="false" placeholder="JSON 模板内容…"></textarea>
            <div class="field" style="margin-top:12px">
              <button class="btn btn-primary btn-sm" id="saveTemplateBtn" type="button">保存模板</button>
              <span class="saved" id="notifSaved">已保存</span>
            </div>
          </div></div></div>
        </div>

        <div class="acc" data-acc>
          <button class="acc-head" type="button"><span><span class="acc-ico">🧪</span>手动操作</span><span class="chev"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span></button>
          <div class="acc-body"><div class="acc-inner"><div class="acc-content">
            <div class="field">
              <button class="btn btn-tonal btn-sm" id="testBtn" type="button">立即测试（随机仓库）</button>
              <button class="btn btn-outline btn-sm" id="cycleBtn" type="button">触发新一轮检测</button>
            </div>
            <pre id="resultBlock" class="result-block">// 操作结果显示在这里</pre>
          </div></div></div>
        </div>

      </div>
    </div>
  </aside>

  <button class="fab" type="button" title="添加监控项目" aria-label="添加监控项目" id="fabBtn">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
  </button>

  <div class="toast" id="toast"></div>
  <script>
    // ============ 基础工具 ============
    var params = new URLSearchParams(window.location.search);
    var API_KEY = sessionStorage.getItem('api_key') || '';
    if (params.get('key')) {
      API_KEY = params.get('key');
      sessionStorage.setItem('api_key', API_KEY);
      window.history.replaceState({}, document.title, window.location.origin + window.location.pathname);
    }
    function $(id) { return document.getElementById(id); }
    function esc(s) { var d = document.createElement('div'); d.textContent = (s === null || s === undefined) ? '' : String(s); return d.innerHTML; }
    function escAttr(s) { return String(s === null || s === undefined ? '' : s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;'); }
    function fmtBJ(iso) {
      var d = (typeof iso === 'string') ? new Date(iso) : iso;
      if (!d || isNaN(d.getTime())) return '';
      var b = new Date(d.getTime() + 8 * 3600 * 1000);
      var p = function (n) { return String(n).padStart(2, '0'); };
      return b.getUTCFullYear() + '-' + p(b.getUTCMonth() + 1) + '-' + p(b.getUTCDate()) + ' ' + p(b.getUTCHours()) + ':' + p(b.getUTCMinutes());
    }
    var toastTimer = null;
    function toast(msg) {
      var t = $('toast'); if (!t) return;
      t.textContent = msg; t.classList.add('on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2200);
    }
    function markSaved(id) {
      var el = $(id); if (!el) return;
      el.classList.add('on');
      setTimeout(function () { el.classList.remove('on'); }, 1800);
    }
    async function apiFetch(url, options) {
      options = options || {};
      var headers = options.headers || {};
      if (API_KEY) headers['X-API-Key'] = API_KEY;
      var res = await fetch(url, Object.assign({}, options, { headers: headers }));
      if (res.status === 403) { $('authError').style.display = 'block'; throw new Error('鉴权失败'); }
      if (res.status === 503) { var e1 = await res.json().catch(function () { return {}; }); throw new Error(e1.error || '数据库不可用'); }
      if (res.status === 500) { var e2 = await res.json().catch(function () { return {}; }); throw new Error(e2.error || '服务端错误'); }
      return res;
    }

    // ============ 抽屉 ============
    function openDrawer(name) {
      var isNotif = name === 'notifications';
      $('paneNotifications').classList.toggle('on', isNotif);
      $('paneSettings').classList.toggle('on', !isNotif);
      $('drawerTitle').textContent = isNotif ? '通知中心' : '设置';
      $('drawerScrim').classList.add('on');
      $('drawerPanel').classList.add('on');
      document.body.classList.add('locked');
      if (isNotif) renderUpdates();
    }
    function closeDrawer() {
      $('drawerScrim').classList.remove('on');
      $('drawerPanel').classList.remove('on');
      document.body.classList.remove('locked');
    }

    // ============ 设置：检测节奏 / 免打扰 ============
    function isDndActiveClient(dnd) {
      if (!dnd || !dnd.enabled) return false;
      function parse(s) { var m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); if (!m) return null; var h = +m[1], mi = +m[2]; if (h > 23 || mi > 59) return null; return h * 60 + mi; }
      var s = parse(dnd.start), e = parse(dnd.end);
      if (s === null || e === null || s === e) return false;
      var d = new Date();
      var cur = (d.getUTCHours() * 60 + d.getUTCMinutes() + 8 * 60) % (24 * 60);
      if (s < e) return cur >= s && cur < e;
      return cur >= s || cur < e;
    }
    function updateDndStatus(settings) {
      var el = $('dndStatus'); if (!el) return;
      var dnd = settings.dnd;
      if (!dnd || !dnd.enabled) { el.textContent = '（已关闭）'; el.style.color = 'var(--text-3)'; return; }
      if (dnd.start === dnd.end) { el.textContent = '⚠️ 开始=结束，未生效'; el.style.color = 'var(--err)'; return; }
      if (isDndActiveClient(dnd)) { el.textContent = '🌙 当前处于免打扰'; el.style.color = 'var(--err)'; }
      else { el.textContent = '🟢 当前可通知（' + dnd.start + '–' + dnd.end + '）'; el.style.color = 'var(--pri)'; }
    }
    function renderState(state, settings) {
      var el = $('stateInfo'); if (!el) return;
      if (!state || !state.phase || (!state.cycleStartTime && !state.cycleEndTime)) {
        el.innerHTML = '⚠️ 调度服务未就绪，请检查 D1 配置';
        return;
      }
      var total = parseInt(state.totalRepos, 10) || 0;
      var html = '';
      if (state.phase === 'checking') {
        var nextIn = settings.repoIntervalMinutes;
        if (state.lastRepoCheckTime) {
          var elapsed = (Date.now() - new Date(state.lastRepoCheckTime).getTime()) / 60000;
          nextIn = Math.max(0, Math.ceil(settings.repoIntervalMinutes - elapsed));
        }
        html = '🟢 <b>检测中</b> · 进度 ' + state.currentIndex + '/' + total + ' · 下一个仓库约 ' + nextIn + ' 分钟后';
        if (state.lastRepoCheckTime) html += '<br>上次检查 ' + esc(fmtBJ(state.lastRepoCheckTime));
      } else {
        var cycleMs = settings.cycleIntervalHours * 3600000;
        var since = state.cycleEndTime ? new Date(state.cycleEndTime) : (state.cycleStartTime ? new Date(state.cycleStartTime) : new Date());
        var next = new Date(since.getTime() + cycleMs);
        html = '💤 <b>等待中</b> · 预计下次 ' + esc(fmtBJ(next.toISOString()));
        if (state.cycleEndTime) html += '<br>上轮结束 ' + esc(fmtBJ(state.cycleEndTime));
      }
      if (settings.dnd && settings.dnd.enabled && isDndActiveClient(settings.dnd)) {
        html += '<br>🌙 免打扰时段中，更新将延后通知';
      }
      el.innerHTML = html;
    }
    async function loadSettings() {
      try {
        var res = await apiFetch('/api/get-settings');
        var data = await res.json();
        var settings = data.settings, state = data.state;
        $('repoInterval').value = settings.repoIntervalMinutes;
        $('cycleInterval').value = settings.cycleIntervalHours;
        var dnd = settings.dnd || { enabled: false, start: '23:00', end: '08:00' };
        $('dndEnabled').checked = !!dnd.enabled;
        $('dndStart').value = dnd.start || '23:00';
        $('dndEnd').value = dnd.end || '08:00';
        updateDndStatus(settings);
        renderState(state, settings);
      } catch (e) {
        $('stateInfo').innerHTML = '❌ 加载失败 — ' + esc(e.message || '请检查 D1 绑定与 API Key');
      }
    }
    async function saveSettings() {
      var payload = {
        repoIntervalMinutes: parseInt($('repoInterval').value, 10),
        cycleIntervalHours: parseInt($('cycleInterval').value, 10),
        dnd: { enabled: $('dndEnabled').checked, start: $('dndStart').value || '23:00', end: $('dndEnd').value || '08:00' }
      };
      try {
        var res = await apiFetch('/api/save-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        var data = await res.json();
        if (data.success) { markSaved('settingsSaved'); toast('设置已保存并同步'); loadSettings(); }
        else toast('保存失败：' + data.error);
      } catch (e) { toast('保存失败：' + e.message); }
    }

    // ============ 通知模板 ============
    async function loadNotificationConfig() {
      try {
        var res = await apiFetch('/api/get-notification-config');
        $('notificationTemplate').value = JSON.stringify(await res.json(), null, 2);
      } catch (e) {}
    }
    async function saveNotificationConfig() {
      var raw = $('notificationTemplate').value;
      var cfg;
      try { cfg = JSON.parse(raw); } catch (e) { toast('JSON 格式无效'); return; }
      if (!cfg.update || !cfg.alert) { toast('模板必须包含 update 和 alert 对象'); return; }
      try {
        var res = await apiFetch('/api/save-notification-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
        var data = await res.json();
        if (data.success) { markSaved('notifSaved'); toast('模板已保存'); }
        else toast('保存失败：' + data.error);
      } catch (e) { toast('保存失败：' + e.message); }
    }

    // ============ 通知渠道 ============
    async function loadNotifyChannel() {
      try {
        var res = await apiFetch('/api/get-notify-channel');
        var ch = (await res.json()).channel;
        if (!ch) return;
        $('chEnabled').checked = ch.enabled !== false;
        $('chUrl').value = ch.url || '';
        var m = $('chMethod');
        if (ch.method) { for (var i = 0; i < m.options.length; i++) { if (m.options[i].value === ch.method) { m.selectedIndex = i; break; } } }
        $('chToken').value = (ch.headers && ch.headers['Authorization'] && ch.headers['Authorization'] !== '***') ? ch.headers['Authorization'] : '';
        $('chBody').value = ch.bodyTemplate || '';
      } catch (e) {}
    }
    async function saveNotifyChannel() {
      var token = $('chToken').value.trim();
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = token;
      var payload = { enabled: $('chEnabled').checked, url: $('chUrl').value.trim(), method: $('chMethod').value, headers: headers, bodyTemplate: $('chBody').value };
      try {
        var res = await apiFetch('/api/save-notify-channel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        var data = await res.json();
        if (data.success) { markSaved('chSaved'); toast('通道已保存'); }
        else toast(data.error || '保存失败');
      } catch (e) { toast('保存失败：' + e.message); }
    }

    // ============ 站内通知开关 ============
    async function loadInappChannel() {
      try {
        var res = await apiFetch('/api/get-inapp-channel');
        var ch = (await res.json()).channel;
        inappEnabled = !ch || ch.enabled !== false;
      } catch (e) { inappEnabled = true; }
      var cb = $('inappEnabled'); if (cb) cb.checked = inappEnabled;
      renderUpdates();
    }
    async function saveInappChannel() {
      var enabled = $('inappEnabled').checked;
      try {
        var res = await apiFetch('/api/save-inapp-channel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled }) });
        var data = await res.json();
        if (data.success) { inappEnabled = enabled; markSaved('inappSaved'); toast('已保存'); renderUpdates(); }
        else toast(data.error || '保存失败');
      } catch (e) { toast('保存失败：' + e.message); }
    }

    // ============ 通知中心（服务端为准，多端同步）============
    var inappEnabled = true;
    var updatesCache = [];
    var updatesInFlight = false;
    var BANNER_MAX = 5;
    var CLOSE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    function safeUrl(u) { return (typeof u === 'string' && (u.indexOf('http://') === 0 || u.indexOf('https://') === 0)) ? u : ''; }
    function updatesSignature(list) {
      return list.length + '|' + list.map(function (u) { return u.id + ':' + (u.repo || '') + ':' + u.tag + ':' + (u.url || '') + ':' + (u.detected_at || ''); }).join(',');
    }
    async function loadUpdates() {
      if (updatesInFlight) return;
      updatesInFlight = true;
      try {
        var res = await apiFetch('/api/get-updates');
        var data = await res.json();
        var fresh = Array.isArray(data.updates) ? data.updates : [];
        if (updatesSignature(fresh) !== updatesSignature(updatesCache)) { updatesCache = fresh; renderUpdates(); }
      } catch (e) { return; }
      finally { updatesInFlight = false; }
    }
    function renderUpdates() {
      var list = inappEnabled ? updatesCache : [];
      renderBanners(list);
      renderUpdateList(list);
      var badge = $('updateBadge');
      if (badge) {
        if (inappEnabled && updatesCache.length) { badge.textContent = updatesCache.length > 99 ? '99+' : String(updatesCache.length); badge.hidden = false; }
        else badge.hidden = true;
      }
      var st = $('statUnread'); if (st) st.textContent = inappEnabled ? updatesCache.length : 0;
      var bell = $('bellBtn'); if (bell) bell.style.display = inappEnabled ? '' : 'none';
    }
    function renderBanners(list) {
      var box = $('updateBanner'); if (!box) return;
      if (!list.length) { box.innerHTML = ''; return; }
      var shown = list.slice(0, BANNER_MAX);
      var html = shown.map(function (u) {
        var url = safeUrl(u.url);
        var link = url
          ? '<a class="ghost-btn" href="' + escAttr(url) + '" target="_blank" rel="noopener noreferrer">查看 Release ↗</a>'
          : '<span class="hint" style="margin:0">无可用链接</span>';
        return '<div class="banner">' +
            '<div class="b-main">' +
              '<div><span class="b-repo">' + esc(u.repo) + '</span><span class="b-tag">' + esc(u.tag) + '</span></div>' +
              '<div class="b-time">检测于 ' + esc(fmtBJ(u.detected_at)) + '</div>' +
            '</div>' + link +
            '<button class="x-btn" type="button" data-dismiss="' + escAttr(u.id) + '" title="关闭并删除这条通知" aria-label="关闭并删除">' + CLOSE_SVG + '</button>' +
          '</div>';
      }).join('');
      var rest = list.length - shown.length;
      if (rest > 0) {
        html += '<div class="banner"><div class="b-main"><span class="b-more">还有 ' + rest + ' 条更新</span></div>' +
          '<button class="ghost-btn" type="button" data-open-drawer="notifications">查看全部</button></div>';
      }
      box.innerHTML = html;
    }
    function renderUpdateList(list) {
      var box = $('updateList'); if (!box) return;
      var summary = $('updateSummary');
      if (summary) summary.textContent = list.length ? ('共 ' + list.length + ' 条未关闭通知') : '暂无通知';
      if (!list.length) { box.innerHTML = '<div class="empty-hint">暂无更新通知</div>'; return; }
      box.innerHTML = list.map(function (u) {
        var url = safeUrl(u.url);
        var attr = url ? ' data-url="' + escAttr(url) + '"' : '';
        return '<div class="notif">' +
            '<div class="notif-main" data-open' + attr + '>' +
              '<div class="notif-title">' + esc(u.repo) + '<span class="tag">' + esc(u.tag) + '</span></div>' +
              '<div class="notif-meta">' + esc(fmtBJ(u.detected_at)) + (url ? ' · 点击打开 Release' : '') + '</div>' +
            '</div>' +
            '<button class="x-btn" type="button" data-dismiss="' + escAttr(u.id) + '" title="关闭并删除这条通知" aria-label="关闭并删除">' + CLOSE_SVG + '</button>' +
          '</div>';
      }).join('');
    }
    // 关闭即永久删除（服务端），所有设备同步消失
    async function dismissUpdate(id) {
      try {
        var res = await apiFetch('/api/dismiss-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: Number(id) }) });
        var data = await res.json();
        if (data.success) {
          updatesCache = updatesCache.filter(function (u) { return Number(u.id) !== Number(id); });
          renderUpdates();
          toast('已删除并同步');
        } else toast('删除失败：' + (data.error || ''));
      } catch (e) { toast('删除失败：' + e.message); }
    }
    async function clearAllUpdates() {
      if (!updatesCache.length) { toast('没有可删除的通知'); return; }
      if (!confirm('确定删除全部 ' + updatesCache.length + ' 条通知？该操作会同步到所有设备。')) return;
      try {
        var res = await apiFetch('/api/clear-updates', { method: 'POST' });
        var data = await res.json();
        if (data.success) { updatesCache = []; renderUpdates(); toast('已全部删除'); }
        else toast('删除失败：' + (data.error || ''));
      } catch (e) { toast('删除失败：' + e.message); }
    }

    // ============ 项目列表 ============
    async function loadRepos() {
      try { var res = await apiFetch('/api/get-repos'); renderRepos(await res.json()); } catch (e) {}
    }
    function renderRepos(repos) {
      var list = $('repoList');
      $('repoCount').textContent = repos.length + ' 个';
      $('statTotal').textContent = repos.length;
      var ok = 0, bad = 0;
      for (var i = 0; i < repos.length; i++) {
        var h = repos[i].health;
        if (h === 'dead' || h === 'warning') bad++; else ok++;
      }
      $('statOk').textContent = ok;
      $('statBad').textContent = bad;
      if (!repos.length) { list.innerHTML = '<div class="empty-hint">暂无监控项目，先在上方添加一个吧</div>'; return; }
      list.innerHTML = repos.map(function (item) {
        var cls = 'b-ok', txt = '正常';
        if (item.health === 'dead') { cls = 'b-dead'; txt = '失效'; }
        else if (item.health === 'warning') { cls = 'b-warn'; txt = '异常'; }
        else if (item.health === 'empty') { cls = 'b-empty'; txt = '无发布'; }
        else if (item.health === 'recovered') { cls = 'b-recov'; txt = '观察中'; }
        var tip = (item.lastError || '') + (item.reason ? ' | 原因：' + item.reason : '') + (item.judgeReason ? ' | 判定：' + item.judgeReason : '');
        var url = safeUrl(item.custom_url);
        return '<div class="repo-row">' +
            '<span class="badge ' + cls + '" title="' + escAttr(tip) + '">' + txt + '</span>' +
            '<div class="repo-id">' +
              '<span class="repo-name">' + esc(item.repo) + '</span>' +
              (url ? '<a class="repo-link" href="' + escAttr(url) + '" target="_blank" rel="noopener noreferrer">releases ↗</a>' : '') +
            '</div>' +
            '<input class="note-input" data-note-repo="' + escAttr(item.repo) + '" value="' + escAttr(item.note || '') + '" placeholder="备注…">' +
            '<button class="repo-del" type="button" data-del-repo="' + escAttr(item.repo) + '" title="取消监控" aria-label="取消监控">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>' +
            '</button>' +
          '</div>';
      }).join('');
    }
    async function addRepo() {
      var input = $('repoInput');
      var repo = input.value.trim();
      if (!repo) { input.focus(); return; }
      try {
        var res = await apiFetch('/api/add-repo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: repo }) });
        var data = await res.json();
        if (data.success) { input.value = ''; renderRepos(data.repos); loadSettings(); toast('已添加 ' + repo); }
        else toast('错误：' + data.error);
      } catch (e) { toast('请求失败：' + e.message); }
    }
    async function deleteRepo(repo) {
      if (!confirm('确定取消监控 ' + repo + ' 吗？')) return;
      try {
        var res = await apiFetch('/api/delete-repo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: repo }) });
        var data = await res.json();
        if (data.success) { renderRepos(data.repos); loadSettings(); toast('已取消监控'); }
        else toast('错误：' + data.error);
      } catch (e) { toast('请求失败：' + e.message); }
    }
    async function saveNote(repo, note) {
      try { await apiFetch('/api/update-note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: repo, note: note }) }); toast('备注已保存'); }
      catch (e) { toast('备注保存失败：' + e.message); }
    }
    async function importRepos() {
      var fileInput = $('importFile'), resultEl = $('importResult');
      var file = fileInput.files && fileInput.files[0];
      if (!file) { resultEl.textContent = '⚠️ 请先选择一个 .txt 文件'; resultEl.style.color = 'var(--err)'; return; }
      resultEl.textContent = '⏳ 正在导入…'; resultEl.style.color = 'var(--text-2)';
      try {
        var content = await file.text();
        var res = await apiFetch('/api/import-repos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: content }) });
        var data = await res.json();
        if (data.success) {
          var msg = '✅ 导入完成：新增 ' + data.imported + ' 个，跳过重复 ' + data.skipped + ' 个，非法 ' + data.invalid + ' 行';
          if (data.invalidLines && data.invalidLines.length) msg += ' · 示例：' + data.invalidLines.slice(0, 3).join(' | ');
          resultEl.textContent = msg; resultEl.style.color = 'var(--ok)';
          renderRepos(data.repos); loadSettings(); fileInput.value = '';
        } else { resultEl.textContent = '❌ ' + (data.error || '导入失败'); resultEl.style.color = 'var(--err)'; }
      } catch (e) { resultEl.textContent = '请求失败：' + e.message; resultEl.style.color = 'var(--err)'; }
    }
    async function exportRepos() {
      try {
        var res = await apiFetch('/api/export-repos');
        var txt = await res.text();
        var blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'repos_export.txt';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        toast('已导出');
      } catch (e) { toast('导出失败：' + e.message); }
    }

    // ============ 手动操作 ============
    async function runTest() {
      var btn = $('testBtn'), resultBlock = $('resultBlock');
      btn.disabled = true;
      resultBlock.textContent = '// 随机选取一个仓库，执行「检测 + 发送通知」…';
      try {
        var res = await apiFetch('/api/test');
        if (res.status === 429) {
          resultBlock.textContent = '请求过于频繁，请 10 秒后再试';
        } else {
          var data = await res.json();
          var lines = [];
          lines.push('随机选中仓库: ' + (data.picked || '未知'));
          lines.push('监控仓库总数: ' + (data.total || 0));
          if (data.results && data.results[0]) {
            var r = data.results[0];
            lines.push('检测成功: ' + (r.success ? '是' : '否'));
            lines.push('通知已发送: ' + (r.push_ok ? '是' : '否'));
            if (r.push_ok === false) lines.push('提示: 通知发送失败，请检查 WEBHOOK_URL / WEBHOOK_AUTH_TOKEN');
          }
          lines.push('');
          lines.push(JSON.stringify(data, null, 2));
          resultBlock.textContent = lines.join(String.fromCharCode(10));
        }
      } catch (e) { resultBlock.textContent = '请求失败: ' + e.message; }
      finally { btn.disabled = false; loadUpdates(); }
    }
    async function triggerCycle() {
      var resultBlock = $('resultBlock');
      try {
        var res = await apiFetch('/api/trigger-cycle', { method: 'POST' });
        resultBlock.textContent = JSON.stringify(await res.json(), null, 2);
        await loadSettings();
        toast('已触发新一轮检测');
      } catch (e) { resultBlock.textContent = '请求失败: ' + e.message; }
    }

    // ============ 事件绑定 ============
    // ============ Cloudflare 配额 ============
    var quotaExpanded = false;
    var quotaLast = null;
    function qNum(n, unit) {
      if (unit === 'bytes') {
        var gb = n / 1073741824;
        if (gb >= 1) return gb.toFixed(2) + ' GB';
        return (n / 1048576).toFixed(1) + ' MB';
      }
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
      return String(Math.round(n * 100) / 100);
    }
    function renderQuota(quota, configured) {
      var box = $('quotaList'), badge = $('quotaOverall'), upd = $('quotaUpdated'), hint = $('quotaHint');
      if (!box) return;
      if (!quota || !quota.items || !quota.items.length) {
        box.innerHTML = '';
        if (badge) { badge.className = 'badge b-empty'; badge.textContent = '未知'; }
        if (upd) upd.textContent = configured === false ? '未启用' : '尚未检测';
        if (hint) {
          hint.textContent = configured === false
            ? '未配置 CF_API_TOKEN 与 CF_ACCOUNT_ID，配额巡检不会运行。这是一项可选功能，不影响版本监控；需要时补上这两个变量即可。'
            : '还没有数据，点「立即检测」跑一次。';
        }
        return;
      }
      var map = { ok: ['b-ok', '正常'], warn: ['b-warn', '偏高'], critical: ['b-dead', '超额'] };
      var b = map[quota.overall] || map.ok;
      if (badge) { badge.className = 'badge ' + b[0]; badge.textContent = b[1]; }
      if (upd) upd.textContent = '更新于 ' + fmtBJ(quota.timestamp);
      var items = quota.items.slice().sort(function (a, c) { return c.pct - a.pct; });
      box.innerHTML = items.map(function (it) {
        var pct = Math.max(0, Math.min(1, it.pct || 0));
        var cls = it.level === 'critical' ? 'critical' : it.level === 'warn' ? 'warn' : 'ok';
        return '<div class="quota-item ' + cls + '">' +
            '<div class="q-head"><span class="q-svc">' + esc(it.service) + '</span>' +
              '<span class="q-pct">' + (it.pct * 100).toFixed(1) + '%</span></div>' +
            '<div class="q-metric">' + esc(it.metric) + '</div>' +
            '<div class="q-val">' + esc(qNum(it.usage, it.unit)) + ' / ' + esc(qNum(it.limit, it.unit)) + '</div>' +
            '<div class="q-bar"><div class="q-fill" style="width:' + (pct * 100).toFixed(1) + '%"></div></div>' +
          '</div>';
      }).join('');
      quotaLast = quota;
      var toggle = $('quotaToggle');
      if (toggle) {
        if (items.length > 8) {
          toggle.style.display = '';
          box.classList.toggle('collapsed', !quotaExpanded);
          toggle.textContent = quotaExpanded ? '收起' : ('展开全部 ' + items.length + ' 项');
        } else {
          toggle.style.display = 'none';
          box.classList.remove('collapsed');
        }
      }
      var risk = items.filter(function (i) { return i.level !== 'ok'; });
      if (hint) {
        hint.textContent = risk.length
          ? '有 ' + risk.length + ' 项超过 80%：' + risk.map(function (i) { return i.service + ' ' + i.metric; }).join('、')
          : '全部指标在安全区间（阈值 80% 预警 / 100% 超额）。每小时整点自动巡检，异常时会推送到已配置的通知渠道。';
      }
    }
    async function loadQuota() {
      try {
        var res = await apiFetch('/api/quota');
        var data = await res.json();
        renderQuota(data.quota, data.configured);
      } catch (e) {}
    }
    async function runQuotaCheck() {
      var btn = $('quotaCheckBtn');
      if (btn) { btn.disabled = true; btn.textContent = '检测中…'; }
      try {
        var res = await apiFetch('/api/quota/check', { method: 'POST' });
        var data = await res.json();
        if (data.success) { renderQuota(data.quota); toast('配额检测完成'); }
        else toast(data.error || '配额检测失败');
      } catch (e) {
        toast('配额检测失败：' + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '立即检测'; }
      }
    }

    function bindEvents() {
      $('bellBtn').addEventListener('click', function () { openDrawer('notifications'); });
      $('gearBtn').addEventListener('click', function () { openDrawer('settings'); });
      $('drawerClose').addEventListener('click', closeDrawer);
      $('drawerScrim').addEventListener('click', closeDrawer);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
      $('fabBtn').addEventListener('click', function () { $('repoInput').focus(); $('repoInput').scrollIntoView({ behavior: 'smooth', block: 'center' }); });

      $('addRepoBtn').addEventListener('click', addRepo);
      $('repoInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') addRepo(); });
      var qb = $('quotaCheckBtn'); if (qb) qb.addEventListener('click', runQuotaCheck);
      var qt = $('quotaToggle');
      if (qt) qt.addEventListener('click', function () {
        quotaExpanded = !quotaExpanded;
        if (quotaLast) renderQuota(quotaLast);
      });
      $('importBtn').addEventListener('click', importRepos);
      $('exportBtn').addEventListener('click', exportRepos);

      $('saveSettingsBtn').addEventListener('click', saveSettings);
      $('saveTemplateBtn').addEventListener('click', saveNotificationConfig);
      $('saveChannelBtn').addEventListener('click', saveNotifyChannel);
      $('saveInappBtn').addEventListener('click', saveInappChannel);
      $('testBtn').addEventListener('click', runTest);
      $('cycleBtn').addEventListener('click', triggerCycle);
      $('clearAllBtn').addEventListener('click', clearAllUpdates);

      // 手风琴
      var accs = document.querySelectorAll('[data-acc] .acc-head');
      for (var i = 0; i < accs.length; i++) {
        accs[i].addEventListener('click', function () {
          this.parentElement.classList.toggle('on');
        });
      }

      // 项目列表：删除 / 备注 / 打开链接
      $('repoList').addEventListener('click', function (e) {
        var del = e.target.closest('[data-del-repo]');
        if (del) { deleteRepo(del.getAttribute('data-del-repo')); }
      });
      $('repoList').addEventListener('change', function (e) {
        var input = e.target.closest('[data-note-repo]');
        if (input) saveNote(input.getAttribute('data-note-repo'), input.value);
      });

      // 通知关闭（永久删除）
      function onDismissClick(e) {
        var btn = e.target.closest('[data-dismiss]');
        if (btn) { e.stopPropagation(); dismissUpdate(btn.getAttribute('data-dismiss')); return; }
        var opener = e.target.closest('[data-open-drawer]');
        if (opener) { openDrawer(opener.getAttribute('data-open-drawer')); return; }
        var main = e.target.closest('[data-open]');
        if (main) { var u = safeUrl(main.getAttribute('data-url')); if (u) { var w = window.open(u, '_blank'); if (w) w.opener = null; } }
      }
      $('updateBanner').addEventListener('click', onDismissClick);
      $('updateList').addEventListener('click', onDismissClick);
    }

    document.addEventListener('DOMContentLoaded', function () {
      if (!API_KEY) $('authError').style.display = 'block';
      bindEvents();
      loadSettings();
      loadNotificationConfig();
      loadNotifyChannel();
      loadRepos();
      loadInappChannel();
      loadUpdates();
      loadQuota();
      setInterval(loadUpdates, 60000);
    });
  <\/script>
</body>
</html>`;
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
