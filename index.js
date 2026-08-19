// ==================== 全局基础配置 ====================
// ⚠️ 环境变量（Cloudflare 后台配置）：
//   WEBHOOK_URL          (文本)
//   WEBHOOK_AUTH_TOKEN   (密钥)
//   GITHUB_TOKEN         (密钥)
//   API_KEY              (密钥)
//   DB                   (D1 绑定名)

const DEFAULT_SETTINGS = {
  repoIntervalMinutes: 5,
  cycleIntervalHours: 8,
  dnd: { enabled: false, start: "23:00", end: "08:00" }
};

const DEFAULT_NOTIFICATION_TEMPLATE = {
  update: {
    title: "📢 项目更新通知",
    content: "{repo_name}\n{url}",
    platform: "GitHub",
    username: "{repo_name}",
    eventLabel: "📢",
    taskType: "项目更新",
    taskStatus: "{tag}",
    filename: "{repo_name}",
    error: "{url}"
  },
  alert: {
    title: "🚨 监控异常告警",
    content: "{repo}\n原因：{reason}\n判定：{judge_reason}",
    platform: "GitHub Monitor",
    username: "System Alert",
    eventLabel: "🚨",
    taskType: "异常通知",
    taskStatus: "Failed",
    filename: "{repo}",
    error: "{reason}"
  }
};

const ALLOWED_TEMPLATE_VARS = {
  update: ['repo', 'repo_name', 'url', 'repo_url', 'tag'],
  alert:  ['repo', 'message', 'reason', 'judge_reason']
};

const ALERT_FAILURE_COUNT = 5;
const RECOVERED_SUCCESS_THRESHOLD = 3;
const ALERTED_AT_EXPIRE_HOURS = 24;

const TIMEOUT_GITHUB = 10000;
const TIMEOUT_WEBHOOK = 8000;

// Webhook 推送失败时的重试上限：每个新版本最多推送 MAX_NOTIFY_ATTEMPTS 次（按巡检周期约 8h 间隔），
// 达到上限后停止，避免 Webhook 长期不可达时无限重复同一条通知。
// 若 Webhook 恢复，下一次成功推送即标记该版本为已通知；如需立即补发可手动触发测试。
const MAX_NOTIFY_ATTEMPTS = 3;

const SANITIZE_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g;
const VAR_REGEX = /\{(\w+)\}/g;

function sanitizeTemplate(obj) {
  if (typeof obj === 'string') return obj.replace(SANITIZE_REGEX, '');
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const cleaned = {};
    for (const key of Object.keys(obj)) {
      cleaned[key] = sanitizeTemplate(obj[key]);
    }
    return cleaned;
  }
  return obj;
}

// ==================== 免打扰模式（时间按北京时间 UTC+8 解释） ====================
// 判断当前是否处于免打扰时段；start/end 为 "HH:MM"（北京时间），end<=start 视为跨午夜。
function parseHHMM(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str || "");
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// 将当前 UTC 时刻换算为北京分钟数（0~1439），用于免打扰判断
function beijingMinutes(now = new Date()) {
  return (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % (24 * 60);
}

function isDndActive(dnd, now = new Date()) {
  if (!dnd || !dnd.enabled) return false;
  const s = parseHHMM(dnd.start);
  const e = parseHHMM(dnd.end);
  if (s === null || e === null || s === e) return false;
  const cur = beijingMinutes(now);
  if (s < e) return cur >= s && cur < e;
  return cur >= s || cur < e;
}

// ==================== D1 表初始化（使用单行 prepare + run） ====================
let dbInitPromise = null;

async function initDB(db, retries = 3) {
  if (dbInitPromise) {
    try {
      await dbInitPromise;
      return;
    } catch (e) {
      dbInitPromise = null;
    }
  }

  const attempt = async (remaining) => {
    try {
      // 全部使用 prepare().run()，每条 SQL 为单行字符串，末尾不带分号
      await db.prepare(`CREATE TABLE IF NOT EXISTS check_state (id INTEGER PRIMARY KEY DEFAULT 1, phase TEXT NOT NULL DEFAULT 'waiting', current_index INTEGER NOT NULL DEFAULT 0, cycle_start_time TEXT, last_repo_check_time TEXT, cycle_end_time TEXT, cycle_repos TEXT, total_repos INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 0)`).run();

      await db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).run();

      await db.prepare(`CREATE TABLE IF NOT EXISTS repos (repo TEXT PRIMARY KEY, custom_url TEXT NOT NULL, note TEXT)`).run();

      await db.prepare(`CREATE TABLE IF NOT EXISTS repo_state (repo TEXT PRIMARY KEY, tag TEXT, etag TEXT, errors_json TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();

      await db.prepare(`INSERT OR IGNORE INTO check_state (id) VALUES (1)`).run();

      // 兼容旧表 version 列
      const cols = await db.prepare(`PRAGMA table_info(check_state)`).all();
      const hasVersion = cols.results.some(c => c.name === 'version');
      if (!hasVersion) {
        try {
          await db.prepare(`ALTER TABLE check_state ADD COLUMN version INTEGER NOT NULL DEFAULT 0`).run();
        } catch (e) {
          if (!e.message.includes('duplicate column')) throw e;
        }
      }

      // 兼容旧表 note 列（备注）
      const repoCols = await db.prepare(`PRAGMA table_info(repos)`).all();
      const hasNote = repoCols.results.some(c => c.name === 'note');
      if (!hasNote) {
        try {
          await db.prepare(`ALTER TABLE repos ADD COLUMN note TEXT`).run();
        } catch (e) {
          if (!e.message.includes('duplicate column')) throw e;
        }
      }

      // 兼容旧表 repo_state：新增「已通知版本」与「推送尝试次数」两列
      // last_notified_tag：最近一次成功推送通知的版本（用于去重，避免重复通知）
      // notify_attempts：当前版本推送失败后的重试计数（达到上限即停止，防止无限重复）
      const stateCols = await db.prepare(`PRAGMA table_info(repo_state)`).all();
      const stateColNames = stateCols.results.map(c => c.name);
      if (!stateColNames.includes('last_notified_tag')) {
        try {
          await db.prepare(`ALTER TABLE repo_state ADD COLUMN last_notified_tag TEXT`).run();
        } catch (e) {
          if (!e.message.includes('duplicate column')) throw e;
        }
      }
      if (!stateColNames.includes('notify_attempts')) {
        try {
          await db.prepare(`ALTER TABLE repo_state ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0`).run();
        } catch (e) {
          if (!e.message.includes('duplicate column')) throw e;
        }
      }

      dbInitPromise = Promise.resolve();
      return;
    } catch (e) {
      if (remaining > 0) {
        console.warn(`数据库初始化失败，剩余重试次数 ${remaining}，错误：`, e);
        await new Promise(r => setTimeout(r, 500 * (4 - remaining)));
        return attempt(remaining - 1);
      }
      throw e;
    }
  };

  dbInitPromise = attempt(retries);
  return dbInitPromise;
}

// ==================== check_state 乐观锁操作 ====================
async function getCheckState(db) {
  const row = await db.prepare("SELECT * FROM check_state WHERE id = 1").first();
  if (!row) {
    return {
      phase: "waiting",
      currentIndex: 0,
      cycleStartTime: new Date().toISOString(),
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

async function setCheckState(db, state) {
  const phase = state.phase || 'waiting';
  const currentIndex = typeof state.currentIndex === 'number' ? state.currentIndex : 0;
  const cycleStartTime = state.cycleStartTime || null;
  const lastRepoCheckTime = state.lastRepoCheckTime || null;
  const cycleEndTime = state.cycleEndTime || null;
  const cycleRepos = state.cycleRepos ? JSON.stringify(state.cycleRepos) : null;
  const totalRepos = typeof state.totalRepos === 'number' ? state.totalRepos : 0;
  const version = typeof state.version === 'number' ? state.version : 0;
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
    WHERE id = 1 AND version = ?9`)
    .bind(phase, currentIndex, cycleStartTime, lastRepoCheckTime, cycleEndTime, cycleRepos, totalRepos, newVersion, version)
    .run();
  if (result.meta.changes === 0) {
    throw new Error("CAS_WRITE_CONFLICT");
  }
}

async function withOptimisticLock(db, mutator, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const state = await getCheckState(db);
      const modified = await mutator(state);
      if (modified === null) return;
      await setCheckState(db, modified);
      return;
    } catch (e) {
      if (e.message !== "CAS_WRITE_CONFLICT" || i === maxRetries - 1) throw e;
      await new Promise(r => setTimeout(r, 50 * Math.pow(2, i)));
    }
  }
}

// 原子地获取下一个要检查的仓库（闭包传出 item）
async function tryAdvanceAndGetRepo(db) {
  let advancedItem = null;
  await withOptimisticLock(db, (state) => {
    if (state.phase !== 'checking') return null;
    const repos = state.cycleRepos;
    if (!repos || state.currentIndex >= repos.length) {
      state.phase = 'waiting';
      state.cycleEndTime = new Date().toISOString();
      return state;
    }
    advancedItem = repos[state.currentIndex];
    state.currentIndex += 1;
    state.lastRepoCheckTime = new Date().toISOString();
    if (state.currentIndex >= repos.length) {
      state.phase = 'waiting';
      state.cycleEndTime = state.lastRepoCheckTime;
    }
    return state;
  }, 3);
  return advancedItem ? { item: advancedItem } : null;
}

// ==================== 数据访问层 ====================
async function getSettings(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'system:settings'").first();
  if (!row) return { ...DEFAULT_SETTINGS };
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

async function saveSettings(db, settings) {
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('system:settings', ?)")
    .bind(JSON.stringify(settings)).run();
}

async function getNotificationTemplate(db) {
  const defaults = DEFAULT_NOTIFICATION_TEMPLATE;
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'system:notification_template'").first();
  if (!row) return JSON.parse(JSON.stringify(defaults));
  try {
    const parsed = JSON.parse(row.value);
    return sanitizeTemplate({
      update: { ...defaults.update, ...(parsed.update || {}) },
      alert:  { ...defaults.alert,  ...(parsed.alert  || {}) }
    });
  } catch {
    return JSON.parse(JSON.stringify(defaults));
  }
}

async function saveNotificationTemplate(db, template) {
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('system:notification_template', ?)")
    .bind(JSON.stringify(template)).run();
}

// ==================== 通知通道（配置驱动单通道，按部署隔离） ====================
async function getNotifyChannel(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'system:notify_channel'").first();
  if (!row) return null;
  try { return sanitizeNotifyChannel(JSON.parse(row.value)); }
  catch { return null; }
}
async function saveNotifyChannel(db, channel) {
  const clean = sanitizeNotifyChannel(channel);
  if (!clean) return false;
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('system:notify_channel', ?)").bind(JSON.stringify(clean)).run();
  return true;
}
function sanitizeNotifyChannel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) return null;            // 必须是 http(s) 绝对地址
  const method = (typeof raw.method === 'string' ? raw.method.toUpperCase() : 'POST');
  if (!['GET','POST','PUT','PATCH','DELETE'].includes(method)) return null;
  const headers = {};
  if (raw.headers && typeof raw.headers === 'object') {
    for (const [k, v] of Object.entries(raw.headers)) {
      if (typeof k === 'string' && (typeof v === 'string' || typeof v === 'number')) headers[k] = String(v);
    }
  }
  if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  const bodyTemplate = typeof raw.bodyTemplate === 'string' && raw.bodyTemplate.length > 0
    ? raw.bodyTemplate
    : '{"title":"{title}","content":"{content}"}';
  const enabled = raw.enabled !== false;
  return { type: 'custom_http', enabled, url, method, headers, bodyTemplate };
}

async function getStoredRepos(db) {
  const { results } = await db.prepare("SELECT repo, custom_url, note FROM repos").all();
  return (results || []).map(r => ({ ...r, note: r.note || '' }));
}

async function addRepo(db, repo, custom_url, note = '') {
  await db.prepare("INSERT OR IGNORE INTO repos (repo, custom_url, note) VALUES (?1, ?2, ?3)")
    .bind(repo, custom_url, note).run();
}

async function deleteRepo(db, repo) {
  await db.batch([
    db.prepare("DELETE FROM repos WHERE repo = ?").bind(repo),
    db.prepare("DELETE FROM repo_state WHERE repo = ?").bind(repo)
  ]);
}

// repo_state 单列更新统一使用 ON CONFLICT 避免覆盖
async function getRepoTag(db, repo) {
  const row = await db.prepare("SELECT tag FROM repo_state WHERE repo = ?").bind(repo).first();
  return row ? row.tag : null;
}

async function setRepoTag(db, repo, tag) {
  await db.prepare(`INSERT INTO repo_state (repo, tag) VALUES (?1, ?2)
    ON CONFLICT(repo) DO UPDATE SET tag = excluded.tag`).bind(repo, tag).run();
}

async function getRepoEtag(db, repo) {
  const row = await db.prepare("SELECT etag FROM repo_state WHERE repo = ?").bind(repo).first();
  return row ? row.etag : null;
}

async function setRepoEtag(db, repo, etag) {
  await db.prepare(`INSERT INTO repo_state (repo, etag) VALUES (?1, ?2)
    ON CONFLICT(repo) DO UPDATE SET etag = excluded.etag`).bind(repo, etag).run();
}

// 最近一次成功推送通知的版本（用于去重，避免同一版本被反复通知）
async function getRepoNotifiedTag(db, repo) {
  const row = await db.prepare("SELECT last_notified_tag FROM repo_state WHERE repo = ?").bind(repo).first();
  return row ? row.last_notified_tag : null;
}
async function setRepoNotifiedTag(db, repo, tag) {
  await db.prepare(`INSERT INTO repo_state (repo, last_notified_tag) VALUES (?1, ?2)
    ON CONFLICT(repo) DO UPDATE SET last_notified_tag = excluded.last_notified_tag`).bind(repo, tag).run();
}

// 当前版本推送失败后的重试计数
async function getNotifyAttempts(db, repo) {
  const row = await db.prepare("SELECT notify_attempts FROM repo_state WHERE repo = ?").bind(repo).first();
  return row ? (row.notify_attempts || 0) : 0;
}
async function resetNotifyAttempts(db, repo) {
  await db.prepare(`INSERT INTO repo_state (repo, notify_attempts) VALUES (?1, 0)
    ON CONFLICT(repo) DO UPDATE SET notify_attempts = 0`).bind(repo).run();
}
async function incNotifyAttempts(db, repo) {
  await db.prepare(`INSERT INTO repo_state (repo, notify_attempts) VALUES (?1, 1)
    ON CONFLICT(repo) DO UPDATE SET notify_attempts = notify_attempts + 1`).bind(repo).run();
}

async function getErrorsForRepo(db, repo) {
  const row = await db.prepare("SELECT errors_json FROM repo_state WHERE repo = ?").bind(repo).first();
  if (row && row.errors_json) {
    try { return JSON.parse(row.errors_json); } catch {}
  }
  return null;
}

async function getErrorsMap(db) {
  const { results } = await db.prepare("SELECT repo, errors_json FROM repo_state WHERE errors_json IS NOT NULL").all();
  const map = {};
  for (const r of results) {
    try { map[r.repo] = JSON.parse(r.errors_json); } catch {}
  }
  return map;
}

async function saveErrorsForRepo(db, repo, errorsObj) {
  if (errorsObj === null) {
    await db.prepare("UPDATE repo_state SET errors_json = NULL WHERE repo = ?").bind(repo).run();
  } else {
    await db.prepare(`INSERT INTO repo_state (repo, errors_json) VALUES (?1, ?2)
      ON CONFLICT(repo) DO UPDATE SET errors_json = excluded.errors_json`)
      .bind(repo, JSON.stringify(errorsObj)).run();
  }
}

// ==================== Worker 入口 ====================
let lastTestTime = 0;
export default {
  async scheduled(event, env, ctx) {
    const db = env.DB;
    try {
      await initDB(db);
      ctx.waitUntil(performScheduledCheck(env));
      try { ctx.waitUntil(checkCloudflareQuotas(env)); } catch (e) { console.error("配额监控调度失败", e); }
    } catch (e) {
      console.error("定时任务初始化失败", e);
    }
  },

  async fetch(request, env, ctx) {
    const db = env.DB;
    const url = new URL(request.url);

    // 尝试初始化数据库，若失败则根据路径返回错误或面板
    let dbReady = false;
    let initError = null;
    try {
      await initDB(db);
      dbReady = true;
    } catch (e) {
      initError = e;
    }

    // API 请求必须数据库可用
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

    // 解析请求体（仅 POST/PUT）
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

    // ---- 路由 ----
    // 设置
    if (url.pathname === "/api/get-settings") {
      try {
        const settings = await getSettings(db);
        const state = await getCheckState(db);
        return jsonResponse({ settings, state });
      } catch (e) {
        return jsonResponse({ error: "D1 状态读取失败: " + e.message }, 500);
      }
    }

    if (url.pathname === "/api/save-settings" && request.method === "POST") {
      if (!body) return jsonResponse({ error: "Missing body" }, 400);
      const settings = await getSettings(db);
      if (body.repoIntervalMinutes !== undefined) {
        const v = parseInt(body.repoIntervalMinutes, 10);
        if (isNaN(v) || v < 5 || v > 60) return jsonResponse({ success: false, error: "仓库间隔需在 5~60 分钟之间" }, 400);
        settings.repoIntervalMinutes = v;
      }
      if (body.cycleIntervalHours !== undefined) {
        const v = parseInt(body.cycleIntervalHours, 10);
        if (isNaN(v) || v < 1 || v > 48) return jsonResponse({ success: false, error: "周期间隔需在 1~48 小时之间" }, 400);
        settings.cycleIntervalHours = v;
      }
      if (body.dnd !== undefined) {
        const d = body.dnd;
        if (typeof d !== 'object' || d === null) return jsonResponse({ success: false, error: "dnd 必须为对象" }, 400);
        const dnd = { ...(settings.dnd || { enabled: false, start: "23:00", end: "08:00" }) };
        if (d.enabled !== undefined) {
          if (typeof d.enabled !== 'boolean') return jsonResponse({ success: false, error: "dnd.enabled 必须为布尔值" }, 400);
          dnd.enabled = d.enabled;
        }
        if (d.start !== undefined) {
          if (!/^\d{1,2}:\d{2}$/.test(d.start)) return jsonResponse({ success: false, error: "dnd.start 格式应为 HH:MM（北京时间）" }, 400);
          const [sh, sm] = d.start.split(':').map(Number);
          if (sh > 23 || sm > 59) return jsonResponse({ success: false, error: "dnd.start 时间超出范围" }, 400);
          dnd.start = d.start;
        }
        if (d.end !== undefined) {
          if (!/^\d{1,2}:\d{2}$/.test(d.end)) return jsonResponse({ success: false, error: "dnd.end 格式应为 HH:MM（北京时间）" }, 400);
          const [eh, em] = d.end.split(':').map(Number);
          if (eh > 23 || em > 59) return jsonResponse({ success: false, error: "dnd.end 时间超出范围" }, 400);
          dnd.end = d.end;
        }
        settings.dnd = dnd;
      }
      await saveSettings(db, settings);
      return jsonResponse({ success: true, settings });
    }

    // 通知模板
    if (url.pathname === "/api/get-notification-config") {
      const config = await getNotificationTemplate(db);
      return jsonResponse(config);
    }

    if (url.pathname === "/api/save-notification-config" && request.method === "POST") {
      if (!body) return jsonResponse({ error: "Missing body" }, 400);
      if (!body.update || !body.alert) return jsonResponse({ success: false, error: "配置必须包含 update 和 alert 对象" }, 400);

      const MAX_FIELDS = 20;
      const MAX_FIELD_LENGTH = 500;

      for (const section of ['update', 'alert']) {
        const sectionObj = body[section];
        if (!sectionObj || typeof sectionObj !== 'object') return jsonResponse({ success: false, error: `${section} 必须为对象` }, 400);
        const keys = Object.keys(sectionObj);
        if (keys.length > MAX_FIELDS) return jsonResponse({ success: false, error: `${section} 字段数量不能超过 ${MAX_FIELDS}` }, 400);
        for (const [k, v] of Object.entries(sectionObj)) {
          if (typeof v !== 'string') return jsonResponse({ success: false, error: `${section}.${k} 必须为字符串` }, 400);
          if (v.length > MAX_FIELD_LENGTH) return jsonResponse({ success: false, error: `${section}.${k} 长度不能超过 ${MAX_FIELD_LENGTH} 字符` }, 400);
        }
      }

      for (const section of ['update', 'alert']) {
        for (const [k, v] of Object.entries(body[section])) {
          const matches = v.matchAll(VAR_REGEX);
          for (const m of matches) {
            if (!ALLOWED_TEMPLATE_VARS[section].includes(m[1])) {
              return jsonResponse({ success: false, error: `不允许的变量 {${m[1]}} 在 ${section}.${k} 中` }, 400);
            }
          }
        }
      }

      const cleaned = sanitizeTemplate(body);
      await saveNotificationTemplate(db, cleaned);
      const merged = {
        update: { ...DEFAULT_NOTIFICATION_TEMPLATE.update, ...cleaned.update },
        alert:  { ...DEFAULT_NOTIFICATION_TEMPLATE.alert,  ...cleaned.alert }
      };
      return jsonResponse({ success: true, config: merged });
    }

    // 通知通道（配置驱动单通道）
    if (url.pathname === "/api/get-notify-channel") {
      const ch = await getNotifyChannel(db);
      let masked = null;
      if (ch) {
        masked = { ...ch };
        if (masked.headers && masked.headers['Authorization']) {
          masked.headers = { ...masked.headers, Authorization: '***' };
        }
      }
      return jsonResponse({ channel: masked });
    }

    if (url.pathname === "/api/save-notify-channel" && request.method === "POST") {
      if (!body) return jsonResponse({ error: "Missing body" }, 400);
      const clean = sanitizeNotifyChannel(body);
      if (!clean) return jsonResponse({ success: false, error: "无效的通知通道配置：url 须为 http(s) 绝对地址，method 须为 GET/POST/PUT/PATCH/DELETE" }, 400);
      await saveNotifyChannel(db, clean);
      const outHeaders = clean.headers.Authorization ? { ...clean.headers, Authorization: '***' } : clean.headers;
      return jsonResponse({ success: true, channel: { ...clean, headers: outHeaders } });
    }

    // 仓库管理
    if (url.pathname === "/api/get-repos") {
      const repos = await getStoredRepos(db);
      const errorsMap = await getErrorsMap(db);
      const enriched = repos.map(item => {
        const err = errorsMap[item.repo];
        let health = "ok", lastError = "", reason = "", judgeReason = "";
        if (err) {
          if (err.permanent) health = "dead";
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

    if (url.pathname === "/api/get-quota") {
      try {
        const cfg = await getQuotaConfig(db);
        const todayUTC = new Date().toISOString().slice(0, 10);
        const usage = await fetchCloudflareUsage(env, todayUTC);
        const state = await getQuotaAlertState(db);
        if (!usage) return jsonResponse({ error: "配额查询失败（CF_API_TOKEN 未配置或查询出错）" }, 502);
        const metrics = QUOTA_METRICS.map(m => {
          const limit = cfg.limits[m.key] || FREE_TIER_LIMITS[m.key];
          const used = usage[m.key] || 0;
          const ratio = limit > 0 ? used / limit : 0;
          return { key: m.key, name: m.name, used: used, limit: limit, percent: Math.round(ratio * 100), level: state.levels[m.key] || 'normal' };
        });
        return jsonResponse({ date: todayUTC, enabled: cfg.enabled, metrics: metrics });
      } catch (e) {
        return jsonResponse({ error: "配额查询异常: " + e.message }, 500);
      }
    }

    if (url.pathname === "/api/add-repo" && request.method === "POST") {
      if (!body) return jsonResponse({ error: "Missing body" }, 400);
      const { repo, note } = body;
      if (!repo || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || repo.includes("..")) {
        return jsonResponse({ success: false, error: "格式应为「作者/项目名」" }, 400);
      }
      const repos = await getStoredRepos(db);
      if (repos.some(item => item.repo.toLowerCase() === repo.toLowerCase())) {
        return jsonResponse({ success: false, error: "项目已在监控中" }, 400);
      }
      const custom_url = `https://github.com/${repo}/releases`;
      await addRepo(db, repo, custom_url, note || '');
      const updated = await getStoredRepos(db);
      return jsonResponse({ success: true, repos: updated });
    }

    if (url.pathname === "/api/update-note" && request.method === "POST") {
      if (!body) return jsonResponse({ error: "Missing body" }, 400);
      const { repo, note } = body;
      if (!repo) return jsonResponse({ success: false, error: "缺少 repo 参数" }, 400);
      const repos = await getStoredRepos(db);
      if (!repos.some(item => item.repo === repo)) {
        return jsonResponse({ success: false, error: "项目不存在" }, 404);
      }
      await db.prepare("UPDATE repos SET note = ?1 WHERE repo = ?2").bind(note || '', repo).run();
      return jsonResponse({ success: true });
    }

    if (url.pathname === "/api/delete-repo" && request.method === "POST") {
      if (!body) return jsonResponse({ error: "Missing body" }, 400);
      const { repo } = body;
      if (!repo) return jsonResponse({ success: false, error: "缺少 repo 参数" }, 400);
      let repos = await getStoredRepos(db);
      if (!repos.some(item => item.repo === repo)) {
        return jsonResponse({ success: false, error: "项目不存在" }, 404);
      }
      await deleteRepo(db, repo);

      try {
        await withOptimisticLock(db, (state) => {
          if (!state.cycleRepos) return null;
          const idx = state.cycleRepos.findIndex(r => r.repo === repo);
          if (idx === -1) return null;
          state.cycleRepos.splice(idx, 1);
          state.totalRepos = state.cycleRepos.length;
          if (idx < state.currentIndex) {
            state.currentIndex--;
          } else if (state.currentIndex >= state.cycleRepos.length) {
            state.currentIndex = state.cycleRepos.length;
            if (state.phase === 'checking') {
              state.phase = 'waiting';
              state.cycleEndTime = new Date().toISOString();
            }
          }
          return state;
        }, 3);
      } catch (e) {
        console.error("删除仓库时同步 check_state 失败（不影响核心删除）", e);
      }

      const updated = await getStoredRepos(db);
      return jsonResponse({ success: true, repos: updated });
    }

    // 批量导出（逐行输出 owner/name 为 TXT 附件）
    if (url.pathname === "/api/export-repos") {
      const repos = await getStoredRepos(db);
      const lines = (repos || []).map(r => r.repo);
      const txt = lines.join("\n") + (lines.length ? "\n" : "");
      return new Response(txt, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="repos_export.txt"'
        }
      });
    }

    // 批量导入（逐行识别 TXT，支持 `owner/name` 或 `owner/name|备注`）
    if (url.pathname === "/api/import-repos" && request.method === "POST") {
      if (!body || typeof body.content !== "string") {
        return jsonResponse({ success: false, error: "缺少文件内容（content 字段）" }, 400);
      }
      const lines = body.content.split(/\r?\n/);
      const existing = new Set((await getStoredRepos(db)).map(r => r.repo.toLowerCase()));
      const seen = new Set();
      const stmts = [];
      let imported = 0, skipped = 0, invalid = 0;
      const invalidLines = [];
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        let repo = line, note = '';
        const pipe = line.indexOf("|");
        if (pipe > 0) { repo = line.slice(0, pipe).trim(); note = line.slice(pipe + 1).trim(); }
        if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || repo.includes("..")) {
          invalid++;
          if (invalidLines.length < 10) invalidLines.push(rawLine);
          continue;
        }
        const key = repo.toLowerCase();
        if (existing.has(key) || seen.has(key)) { skipped++; continue; }
        seen.add(key);
        stmts.push(db.prepare("INSERT OR IGNORE INTO repos (repo, custom_url, note) VALUES (?1, ?2, ?3)").bind(repo, `https://github.com/${repo}/releases`, note));
        imported++;
      }
      if (stmts.length) await db.batch(stmts);
      const updated = await getStoredRepos(db);
      return jsonResponse({ success: true, imported, skipped, invalid, invalidLines, repos: updated });
    }

    // 手动测试：随机选一个仓库，跑完整「检测 + 发送通知」逻辑（用于排查 bug / 验证整条链路）
    if (url.pathname === "/api/test") {
      if (Date.now() - lastTestTime < 10000) {
        return jsonResponse({ error: "请求过于频繁，请 10 秒后再试" }, 429);
      }
      lastTestTime = Date.now();

      const repos = await getStoredRepos(db);
      if (!repos.length) {
        return jsonResponse({ tested: 0, total: 0, picked: null, results: [], error: "暂无监控仓库，请先添加至少一个仓库" });
      }
      // 随机选一个仓库，确保每次点测试都覆盖不同仓库，更利于发现潜在 bug
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

    // 触发新周期
    if (url.pathname === "/api/trigger-cycle" && request.method === "POST") {
      try {
        await startNewCycle(db);
        return jsonResponse({ success: true, message: "已触发新一轮检测" });
      } catch (e) {
        return jsonResponse({ success: false, error: "D1 操作失败: " + e.message }, 500);
      }
    }

    // 已禁用日志
    if (url.pathname === "/api/get-logs") {
      return jsonResponse([]);
    }

    // 默认返回前端面板（即使数据库不可用也能加载）
    return new Response(HTML_TEMPLATE, {
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
      }
    });
  }
};

// ==================== 定时检查主逻辑 ====================
async function performScheduledCheck(env) {
  const db = env.DB;

  let state;
  try {
    state = await getCheckState(db);
  } catch (e) {
    console.error("读取检查状态失败", e);
    return;
  }

  let settings;
  try {
    settings = await getSettings(db);
  } catch (e) {
    console.error("读取设置失败", e);
    return;
  }

  if (state.phase === "waiting") {
    const now = Date.now();
    const waitSince = state.cycleEndTime
      ? new Date(state.cycleEndTime).getTime()
      : (state.cycleStartTime ? new Date(state.cycleStartTime).getTime() : NaN);
    if (isNaN(waitSince)) {
      console.error('状态异常（cycleStartTime/cycleEndTime 均为 null），强制启动新周期');
      await startNewCycle(db);
      return;
    }
    const cycleMs = settings.cycleIntervalHours * 3600 * 1000;
    if (now - waitSince >= cycleMs) {
      try {
        await startNewCycle(db);
      } catch (e) {
        console.error("启动新周期失败", e);
      }
    }
    return;
  }

  if (state.phase === "checking") {
    if (state.lastRepoCheckTime) {
      const intervalMs = settings.repoIntervalMinutes * 60 * 1000;
      if (Date.now() - new Date(state.lastRepoCheckTime).getTime() < intervalMs - 5000) {
        return;
      }
    }

    const result = await tryAdvanceAndGetRepo(db);
    if (!result) return;

    await checkSingleRepo(env, result.item, false, settings.dnd);
  }
}

async function startNewCycle(db) {
  const repos = await getStoredRepos(db);
  await withOptimisticLock(db, (state) => {
    state.phase = "checking";
    state.currentIndex = 0;
    state.cycleStartTime = new Date().toISOString();
    state.lastRepoCheckTime = null;
    state.cycleEndTime = null;
    state.cycleRepos = repos;
    state.totalRepos = repos.length;
    return state;
  }, 3);
}

// ==================== 核心检测逻辑 ====================
async function checkSingleRepo(env, item, forceTrigger, dndSettings) {
  const db = env.DB;
  let repo = item.repo;
  let targetUrl = item.custom_url;
  const now = new Date().toISOString();

  // 免打扰判断：手动测试(forceTrigger)不受限，始终可发送通知
  let dndActive = false;
  if (!forceTrigger) {
    dndActive = isDndActive(dndSettings);
  }

  let errorInfo = null;
  if (!forceTrigger) {
    errorInfo = await getErrorsForRepo(db, repo);
    if (errorInfo && errorInfo.permanent) return { repo, success: true, skipped: true };
  }

  const oldTag = forceTrigger ? null : await getRepoTag(db, repo);
  const githubHeaders = {
    "User-Agent": "CF-Worker-Release-Monitor",
    Accept: "application/vnd.github+json"
  };
  if (env.GITHUB_TOKEN) githubHeaders["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;

  let data, fromCache = false, res;
  try {
    let etagCache = null;
    if (!forceTrigger) {
      const etagStr = await getRepoEtag(db, repo);
      if (etagStr) try { etagCache = JSON.parse(etagStr); } catch {}
    }

    const headers = { ...githubHeaders };
    if (etagCache?.etag && oldTag !== null) headers["If-None-Match"] = etagCache.etag;

    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        res = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases/latest`, { headers }, TIMEOUT_GITHUB);

        if (res.status === 404) {
          // 免打扰时段内不处理 404（不落库、不告警），待免打扰结束后的下一轮巡检再判定并补发告警，避免被标记 permanent 后永久丢失
          if (!forceTrigger && !dndActive) {
            const cause404 = 'GitHub 返回 404：仓库可能已删除、改名或转为私有';
            errorInfo = {
              count: ALERT_FAILURE_COUNT,
              lastError: cause404,
              lastReason: cause404,
              lastCategory: '404',
              judgeReason: 'GitHub API 返回 404，直接判定为永久失效（状态异常：dead）',
              lastTime: now,
              permanent: true
            };
            await saveErrorsForRepo(db, repo, errorInfo);
            const template = await getNotificationTemplate(db);
            await sendAlertNotification(env, db, buildPayload(template.alert, { repo, message: cause404, reason: cause404, judge_reason: errorInfo.judgeReason }));
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
          if (attempt < 1) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        throw new Error(`GitHub API ${res.status}`);
      } catch (e) {
        if (attempt === 1 || e.message.startsWith("GitHub API")) throw e;
        if (attempt < 1) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }

    if (!data) throw new Error("无法获取 release 信息");
    const latestTag = data.tag_name;

    if (!forceTrigger && !fromCache && res) {
      await setRepoEtag(db, repo, JSON.stringify({ etag: res.headers.get("etag") || "" }));
    }

    if (!forceTrigger && errorInfo) {
      errorInfo = decayErrorCountForRepo(errorInfo, now);
      await saveErrorsForRepo(db, repo, errorInfo);
    }

    const isNew = latestTag && latestTag !== oldTag;
    // 已成功通知的版本（去重依据）；forceTrigger 时不读取，始终强制推送
    const lastNotified = forceTrigger ? null : await getRepoNotifiedTag(db, repo);
    const alreadyNotified = !!latestTag && latestTag === lastNotified;
    const attempts = forceTrigger ? 0 : await getNotifyAttempts(db, repo);

    // 观测到全新版本：立即记录已观测版本并重置重试计数（避免反复当作「全新」重抓 / 重复判定）
    if (!forceTrigger && isNew) {
      await setRepoTag(db, repo, latestTag);
      await resetNotifyAttempts(db, repo);
    }

    // 仅在「未成功通知过当前版本」且「重试次数未达上限」时才推送；forceTrigger 始终推送
    const needNotify = forceTrigger || (!alreadyNotified && attempts < MAX_NOTIFY_ATTEMPTS);
    if (needNotify) {
      // 免打扰时段：保留已观测到的版本（tag 已记录），不发送；免打扰结束后下一轮检查自动补发
      if (dndActive) {
        return { repo, success: true, dnd_hold: true };
      }
      const template = await getNotificationTemplate(db);
      const repoName = repo.split("/")[1] || repo;
      const notifVars = { repo, repo_name: repoName, url: targetUrl, repo_url: targetUrl, tag: latestTag || oldTag || "测试" };
      const fields = buildPayload(template.update, notifVars);
      const pushOk = await deliverNotification(env, db, fields, { rawVars: notifVars });

      if (pushOk) {
        // 推送成功：标记该版本已通知并清零重试计数
        await setRepoNotifiedTag(db, repo, latestTag);
        await resetNotifyAttempts(db, repo);
        if (forceTrigger) await setRepoTag(db, repo, latestTag);
      } else {
        // 推送失败：递增重试计数；达到上限后停止，避免无限重复通知
        // 手动测试(forceTrigger)失败不计入重试次数，避免抬高真实巡检的 attempts
        if (!forceTrigger) await incNotifyAttempts(db, repo);
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

      const judgeReason = '连续 ' + errorInfo.count + ' 次检测失败（告警阈值 ' + ALERT_FAILURE_COUNT + '）：' + cls.reason;
      // 免打扰时段内不发送异常告警，也不标记 alertedAt，免打扰结束后下一轮会重试
      if (errorInfo.count >= ALERT_FAILURE_COUNT && !errorInfo.alertedAt && !dndActive) {
        const template = await getNotificationTemplate(db);
        await sendAlertNotification(env, db, buildPayload(template.alert, { repo, message: err.message, reason: cls.reason, judge_reason: judgeReason }));
        errorInfo.alertedAt = now;
      }

      await saveErrorsForRepo(db, repo, errorInfo);
    }
    return { repo, success: false };
  }
}

// ==================== 错误计数逻辑（返回新对象或 null） ====================
function decayErrorCountForRepo(errorInfo, now) {
  if (!errorInfo || errorInfo.permanent) return errorInfo;

  if (errorInfo.alertedAt) {
    const alertedTime = new Date(errorInfo.alertedAt).getTime();
    if (Date.now() - alertedTime > ALERTED_AT_EXPIRE_HOURS * 3600 * 1000) {
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

// ==================== 仓库重命名处理 ====================
async function handleRename(env, oldRepo, newRepo, tag) {
  const db = env.DB;

  await db.batch([
    db.prepare("UPDATE repos SET repo = ?1, custom_url = ?2 WHERE repo = ?3")
      .bind(newRepo, `https://github.com/${newRepo}/releases`, oldRepo),
    db.prepare("INSERT OR IGNORE INTO repo_state (repo, tag, etag, errors_json, last_notified_tag, notify_attempts) SELECT ?1, tag, etag, errors_json, last_notified_tag, notify_attempts FROM repo_state WHERE repo = ?2")
      .bind(newRepo, oldRepo),
    db.prepare("DELETE FROM repo_state WHERE repo = ?").bind(oldRepo),
    db.prepare("INSERT OR IGNORE INTO repo_state (repo) VALUES (?)").bind(newRepo)
  ]);

  try {
    await withOptimisticLock(db, (state) => {
      if (!state.cycleRepos) return null;
      const repoInSnapshot = state.cycleRepos.find(r => r.repo === oldRepo);
      if (!repoInSnapshot) return null;
      repoInSnapshot.repo = newRepo;
      repoInSnapshot.custom_url = `https://github.com/${newRepo}/releases`;
      return state;
    }, 3);
  } catch (e) {
    console.error("重命名同步 check_state 快照失败", e);
  }

  return { repo: newRepo, success: true };
}

// ==================== 辅助函数 ====================
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" }
  });
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

async function sendAlertNotification(env, db, payload) {
  try { await deliverNotification(env, db, payload, { isAlert: true }); } catch (e) { /* 忽略 */ }
}

async function deliverNotification(env, db, fields, opts = {}) {
  const channel = await getNotifyChannel(db);
  let url, method, headers, bodyStr;
  if (channel && channel.enabled && channel.url) {
    // 走配置驱动通道（别人的/自己的都在各自的 D1 配置里）
    url = channel.url;
    method = channel.method;
    headers = { ...channel.headers };
    const mergedVars = { ...fields, ...(opts.rawVars || {}) };
    bodyStr = substituteVars(channel.bodyTemplate, mergedVars);
  } else {
    // 回退：沿用 WEBHOOK_URL + WEBHOOK_AUTH_TOKEN secret（兼容现有部署）
    url = env.WEBHOOK_URL;
    method = "POST";
    headers = { "Content-Type": "application/json", ...(env.WEBHOOK_AUTH_TOKEN ? { Authorization: env.WEBHOOK_AUTH_TOKEN } : {}) };
    bodyStr = JSON.stringify({ title: fields.title, content: fields.content });
  }
  if (!url) return false;
  let pushOk = false;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        method,
        headers,
        body: method === "GET" ? undefined : bodyStr
      }, TIMEOUT_WEBHOOK);
      if (res.ok) { pushOk = true; break; }
    } catch (e) {
      if (attempt === 1) break;
    }
    if (attempt < 1) await new Promise(r => setTimeout(r, 1000));
  }
  return pushOk;
}
function substituteVars(template, vars) {
  return template.replace(VAR_REGEX, (_, name) => {
    let val = vars[name] !== undefined ? vars[name] : '{' + name + '}';
    if (typeof val === 'string') val = val.replace(SANITIZE_REGEX, '');
    return val;
  });
}

function buildPayload(template, vars) {
  const payload = {};
  for (const key of Object.keys(template)) {
    let value = template[key];
    if (typeof value === 'string') {
      value = value.replace(VAR_REGEX, (_, varName) => {
        let val = vars[varName] !== undefined ? vars[varName] : `{${varName}}`;
        if (typeof val === 'string') val = val.replace(SANITIZE_REGEX, '');
        return val;
      });
    }
    payload[key] = value;
  }
  return payload;
}

// 把原始异常归类为"导致状态异常的原因"（结构化根因）
function classifyError(err, res) {
  const status = res && res.status ? res.status : null;
  const msg = (err && err.message) ? err.message : '';
  if (status === 404) return { reason: 'GitHub 返回 404：仓库可能已删除、改名或转为私有', category: '404' };
  if (status === 403 || status === 429) return { reason: 'GitHub API 限流或无权限（' + status + '）', category: 'rate_limit' };
  if (status >= 500) return { reason: 'GitHub 服务器错误（' + status + '）', category: 'server_error' };
  if (/fetch|timeout|timed out|network|ECONN|abort|Failed to fetch/i.test(msg)) return { reason: '网络请求失败或超时，无法连接 GitHub', category: 'network' };
  if (/JSON|parse|Unexpected token|SyntaxError/i.test(msg)) return { reason: '响应解析失败，GitHub 返回了非预期内容', category: 'parse' };
  return { reason: msg || '未知错误', category: 'unknown' };
}

// ==================== Cloudflare 配额监控 ====================
// 监控本部署所在 Cloudflare 账户的免费额度用量：达到 80% 发预警、100% 发超限通知。
// 通知文案精简："{name}额度达{pct}%（{used}/{limit}）"。
// 去重：按指标记录等级（normal/warn/over），仅在等级跨越时发一次通知，避免每 5 分钟刷屏。
// 配额超限属于运维级紧急事件（监控可能因此停摆），故不走免打扰（DND）抑制。
const CF_ACCOUNT_ID_FALLBACK = "cad20ea1689e9bd3d559496d3f5617c0";
const QUOTA_WARN = 0.8;
const QUOTA_OVER = 1.0;
// 免费版默认额度（可在 D1 settings 键 system:quota_config 里用 limits 覆盖）
const FREE_TIER_LIMITS = {
  workers_requests: 100000,
  d1_rows_read: 5000000,
  d1_rows_written: 100000
};
const QUOTA_METRICS = [
  { key: 'workers_requests', name: 'Workers请求' },
  { key: 'd1_rows_read',    name: 'D1读行' },
  { key: 'd1_rows_written', name: 'D1写行' }
];

function quotaLevelFor(ratio) {
  if (ratio >= QUOTA_OVER) return 'over';
  if (ratio >= QUOTA_WARN) return 'warn';
  return 'normal';
}

async function getQuotaConfig(db) {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'system:quota_config'").first();
    if (row && row.value) {
      const cfg = JSON.parse(row.value);
      return { enabled: cfg.enabled !== false, limits: Object.assign({}, FREE_TIER_LIMITS, cfg.limits || {}) };
    }
  } catch (e) { /* ignore */ }
  return { enabled: true, limits: Object.assign({}, FREE_TIER_LIMITS) };
}

async function getQuotaAlertState(db) {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'system:quota_alerts'").first();
    if (row && row.value) return JSON.parse(row.value);
  } catch (e) { /* ignore */ }
  return { levels: {}, pending: [] };
}

async function saveQuotaAlertState(db, state) {
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('system:quota_alerts', ?)").bind(JSON.stringify(state)).run();
}

async function fetchCloudflareUsage(env, todayUTC) {
  const token = env.CF_API_TOKEN;
  if (!token) { console.warn('CF_API_TOKEN 未配置，跳过配额监控'); return null; }
  const accountId = env.CF_ACCOUNT_ID || CF_ACCOUNT_ID_FALLBACK;
  const query = 'query { viewer { accounts(filter: { accountTag: "' + accountId + '" }) {'
    + ' workersInvocationsAdaptive(limit: 1, filter: { date_geq: "' + todayUTC + '" }) { sum { requests } }'
    + ' d1AnalyticsAdaptiveGroups(limit: 1, filter: { date_geq: "' + todayUTC + '" }) { sum { rowsRead rowsWritten } }'
    + ' } } }';
  let res;
  try {
    res = await fetchWithTimeout("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    }, TIMEOUT_WEBHOOK);
  } catch (e) { console.error('配额查询请求失败', e); return null; }
  if (!res || !res.ok) { console.error('配额查询 HTTP 状态异常', res && res.status); return null; }
  let json;
  try { json = await res.json(); } catch (e) { console.error('配额查询响应解析失败', e); return null; }
  if (json.errors && json.errors.length) { console.error('配额查询 GraphQL 错误', JSON.stringify(json.errors)); return null; }
  const acc = json && json.data && json.data.viewer && json.data.viewer.accounts && json.data.viewer.accounts[0];
  if (!acc) return null;
  const w = (acc.workersInvocationsAdaptive && acc.workersInvocationsAdaptive[0] && acc.workersInvocationsAdaptive[0].sum) || {};
  const d = (acc.d1AnalyticsAdaptiveGroups && acc.d1AnalyticsAdaptiveGroups[0] && acc.d1AnalyticsAdaptiveGroups[0].sum) || {};
  return {
    workers_requests: Number(w.requests) || 0,
    d1_rows_read: Number(d.rowsRead) || 0,
    d1_rows_written: Number(d.rowsWritten) || 0
  };
}

async function checkCloudflareQuotas(env) {
  const db = env.DB;
  try {
    const cfg = await getQuotaConfig(db);
    if (!cfg.enabled) return;
    const todayUTC = new Date().toISOString().slice(0, 10);
    const usage = await fetchCloudflareUsage(env, todayUTC);
    if (!usage) return;
    const state = await getQuotaAlertState(db);
    let changed = false;
    for (const m of QUOTA_METRICS) {
      const limit = cfg.limits[m.key] || FREE_TIER_LIMITS[m.key];
      const used = usage[m.key] || 0;
      if (!limit || limit <= 0) continue;
      const ratio = used / limit;
      const level = quotaLevelFor(ratio);
      const prev = state.levels[m.key] || 'normal';
      if (level === prev) continue;
      state.levels[m.key] = level;
      changed = true;
      if (level === 'warn' || level === 'over') {
        const pct = Math.round(ratio * 100);
        const content = m.name + "额度达" + pct + "%（" + used + "/" + limit + "）";
        const title = (level === 'over' ? "🚨 CF配额超限 " : "⚠️ CF配额预警 ") + pct + "%";
        const fields = {
          title: title,
          content: content,
          eventLabel: level === 'over' ? "🚨" : "⚠️",
          taskStatus: level === 'over' ? "超限" : "预警",
          error: m.name + " " + pct + "%",
          repo: m.name,
          message: content,
          reason: content,
          judge_reason: ""
        };
        try { await sendAlertNotification(env, db, fields); } catch (e) { console.error('配额通知发送失败', e); }
      }
    }
    if (changed) await saveQuotaAlertState(db, state);
  } catch (e) {
    console.error('配额监控异常', e);
  }
}

// ==================== 完整前端面板 ====================
const FAVICON_B64 = "AAABAAEAQEAAAAEAIAAoQgAAFgAAACgAAABAAAAAgAAAAAEAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAbAAAAP8AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAD/AAAAJgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA+gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAGgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAB2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAA/AAAAP8AAAD8AAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAIAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKYAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAHgAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAIIAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAC4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACGAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAD0AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAALIAAAAiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASgAAAN4AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAHIAAAAAAAAAAAAAABIAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAJQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAyAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAADgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOgAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAADuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAQAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAACMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADWAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAADoAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAADaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPwAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACYAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAXAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAWAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANQAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAOQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAACyAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAACwAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAARgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqgAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAZgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMQAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAANYAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAADSAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4gAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAABeAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC4AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAFwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACUAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAACQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEwAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAhAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAANYAAACyAAAAtAAAANoAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD6AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAFgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOwAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAygAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAACWAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAHgAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAE4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC0AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAALIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMQAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAiAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAIwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKoAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAArgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMoAAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAAzgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACqAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAALIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABqAAAAyAAAAP8AAAD/AAAA/wAAAP8AAADIAAAAagAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//////////////3//7//////4P//B/////+A//8B/////gD//wB////8AP//AD////AA//8AD///4AD//wAH///Af///AAP//4H///8AAf//A////wAA//4D////AAB//Afj//8AAD/8B4D//wAAP/gPAP/+AAAf8B4Af/4AAA/wHAB//AAAD+B4AH/+AAAH4PAH///gAAfAAD////wAA8AAf////gADwAD/////AAOAAf////+AAYAD/////8ABgAf/////4AGAB//////gAQAP/////+AAAA//////8AAAD//////wAAAP//////AAAA//////8AAAD//////wAAAP//////AAAA//////8AAAD//////wAAAP//////AAAA//////8ACAD//////gAYAH/////+ABgAf/////wAGAA//////AAcAB/////4ADwAP/////gAPgA//////AB+AD/////8AH4AP/////wAfwA//////AD/gB/AAAP4Af+AHwAAAPgB/8AYAAAAOAP/4AAAAAAAB//wAAAAAAAP//AAAAAAAA//+AAAAAAAH//8AAAAAAA///8AAAAAAP///4AAAAAB////wAAAAAP////wAAAAD/////wAAAA//////wAAAP//////4AAH////////gf//////////////8=";

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>GitHub Release 监控控制台</title>
  <link rel="icon" href="data:image/x-icon;base64,${FAVICON_B64}">
  <style>
    :root {
      /* Home Assistant 风格：主色 HA 蓝，浅灰背景 + 白卡 */
      --md-sys-color-primary: #03A9F4;
      --md-sys-color-on-primary: #FFFFFF;
      --md-sys-color-primary-container: #E1F5FE;
      --md-sys-color-on-primary-container: #01579B;
      --md-sys-color-secondary: #0288D1;
      --md-sys-color-on-secondary: #FFFFFF;
      --md-sys-color-secondary-container: #E1F5FE;
      --md-sys-color-on-secondary-container: #01579B;
      --md-sys-color-error: #B00020;
      --md-sys-color-on-error: #FFFFFF;
      --md-sys-color-error-container: #FDECEA;
      --md-sys-color-on-error-container: #410E0B;
      --md-sys-color-background: #FAFAFA;
      --md-sys-color-on-background: #212121;
      --md-sys-color-surface: #FFFFFF;
      --md-sys-color-on-surface: #212121;
      --md-sys-color-surface-variant: #F1F3F4;
      --md-sys-color-on-surface-variant: #5F6368;
      --md-sys-color-outline: #DADCE0;
      --md-sys-color-outline-variant: #ECEFF1;
      --md-sys-color-surface-1: #F5F5F5;
      --md-sys-color-surface-2: #EEEEEE;
      --md-sys-elevation-1: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06);
      --md-sys-elevation-2: 0 2px 8px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --md-sys-color-primary: #29B6F6;
        --md-sys-color-on-primary: #012A36;
        --md-sys-color-primary-container: #003B4A;
        --md-sys-color-on-primary-container: #A6E7FF;
        --md-sys-color-secondary: #4FC3F7;
        --md-sys-color-on-secondary: #012A36;
        --md-sys-color-secondary-container: #003B4A;
        --md-sys-color-on-secondary-container: #A6E7FF;
        --md-sys-color-error: #CF6679;
        --md-sys-color-on-error: #381E1E;
        --md-sys-color-error-container: #5C1A17;
        --md-sys-color-on-error-container: #F9DEDC;
        --md-sys-color-background: #121212;
        --md-sys-color-on-background: #E6E1E5;
        --md-sys-color-surface: #1E1E1E;
        --md-sys-color-on-surface: #E6E1E5;
        --md-sys-color-surface-variant: #2A2A2A;
        --md-sys-color-on-surface-variant: #B0B0B0;
        --md-sys-color-outline: #3C4043;
        --md-sys-color-outline-variant: #2A2A2A;
        --md-sys-color-surface-1: #242424;
        --md-sys-color-surface-2: #2C2C2C;
      }
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-size: 16px; }
    body {
      font-family: "Google Sans Text", "Roboto", "Segoe UI", -apple-system, sans-serif;
      background: var(--md-sys-color-background);
      color: var(--md-sys-color-on-background);
      line-height: 1.5;
      padding: 16px;
      max-width: 1020px;
      margin: 0 auto;
    }
    .app-header { text-align: center; margin: 24px 0 32px; }
    .app-header h1 { font-size: 2rem; font-weight: 500; color: var(--md-sys-color-primary); }
    .version {
      background: var(--md-sys-color-primary-container);
      color: var(--md-sys-color-on-primary-container);
      padding: 2px 12px; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; margin-left: 8px;
    }
    .subtitle { color: var(--md-sys-color-on-surface-variant); font-size: 0.875rem; margin-top: 4px; }
    .card {
      background: var(--md-sys-color-surface); border-radius: 16px; padding: 24px;
      margin-bottom: 24px; box-shadow: var(--md-sys-elevation-1);
      border: 1px solid var(--md-sys-color-outline-variant);
    }
    .card h2 { font-size: 1.25rem; font-weight: 500; margin-bottom: 16px; }
    .form-group { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
    .form-group label { min-width: 160px; font-size: 0.875rem; color: var(--md-sys-color-on-surface-variant); }
    .input {
      padding: 8px 12px; border: 1px solid var(--md-sys-color-outline);
      border-radius: 8px; background: var(--md-sys-color-surface); color: var(--md-sys-color-on-surface);
      font-size: 0.875rem; outline: none;
    }
    .input:focus { border-color: var(--md-sys-color-primary); border-width: 2px; padding: 7px 11px; }
    input[type="number"] { width: 80px; text-align: center; }
    input[type="text"] { flex: 1; min-width: 200px; }
    textarea {
      width: 100%; min-height: 180px; font-family: "JetBrains Mono", monospace; font-size: 0.8rem;
      padding: 12px; border-radius: 8px; border: 1px solid var(--md-sys-color-outline);
      background: var(--md-sys-color-surface-variant); color: var(--md-sys-color-on-surface);
      resize: vertical; outline: none;
    }
    textarea:focus { border-color: var(--md-sys-color-primary); border-width: 2px; padding: 11px; }
    .help-text { font-size: 0.75rem; color: var(--md-sys-color-on-surface-variant); margin-bottom: 8px; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      height: 40px; padding: 0 24px; border-radius: 9999px; font-family: inherit;
      font-size: 0.875rem; font-weight: 500; border: none; cursor: pointer; transition: box-shadow 0.2s;
    }
    .btn-filled { background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary); }
    .btn-filled:hover { box-shadow: var(--md-sys-elevation-2); }
    .btn-tonal { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
    .btn-tonal:hover { box-shadow: var(--md-sys-elevation-2); }
    .btn-outlined { background: transparent; border: 1px solid var(--md-sys-color-outline); color: var(--md-sys-color-primary); }
    .btn-error { background: var(--md-sys-color-error); color: var(--md-sys-color-on-error); }
    .btn-error:hover { box-shadow: var(--md-sys-elevation-2); }
    .btn:disabled { opacity: 0.5; pointer-events: none; }
    .table-wrapper { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; min-width: 600px; }
    th { text-align: left; padding: 12px 8px; border-bottom: 2px solid var(--md-sys-color-outline-variant); font-size: 0.75rem; text-transform: uppercase; color: var(--md-sys-color-on-surface-variant); }
    td { padding: 10px 8px; border-bottom: 1px solid var(--md-sys-color-outline-variant); }
    tbody tr:hover { background: var(--md-sys-color-surface-1); }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; }
    .badge-ok { background: #E6F4EA; color: #188038; }
    .badge-warn { background: #FEF7E0; color: #E37400; }
    .badge-dead { background: #FCE8E6; color: #D93025; }
    .badge-recov { background: #FFFDE7; color: #9E7D00; }
    .note-input { width: 100%; min-width: 120px; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--md-sys-color-outline, #ccc); border-radius: 6px; background: var(--md-sys-color-surface, #fff); color: inherit; font-size: 0.8rem; }
    .note-input:focus { outline: 2px solid var(--md-sys-color-primary); outline-offset: 1px; }
    @media (prefers-color-scheme: dark) {
      .badge-ok { background: #1A3C28; color: #81C995; }
      .badge-warn { background: #3C3014; color: #FDD663; }
      .badge-dead { background: #3C1E1C; color: #F28B82; }
      .badge-recov { background: #3C3414; color: #FDD663; }
    }
    .info-panel {
      background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container);
      padding: 12px 16px; border-radius: 8px; margin-top: 16px; font-size: 0.85rem;
    }
    .auth-error {
      background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);
      padding: 12px 16px; border-radius: 8px; margin-bottom: 24px; display: none;
    }
    @media (max-width: 768px) {
      body { padding: 8px; }
      .card { padding: 16px; }
      .form-group { flex-direction: column; align-items: stretch; }
      .btn { width: 100%; }
    }
    .result-block {
      background: var(--md-sys-color-surface-variant); padding: 16px; border-radius: 8px;
      font-family: monospace; font-size: 0.75rem; overflow-x: auto; margin-top: 16px; white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div id="authError" class="auth-error">⛔ 鉴权失败：请提供有效的 API Key</div>
  <header class="app-header">
    <h1>🔍 GitHub Release 监控</h1>
    <div class="subtitle" id="clock">北京时间 --:--:--</div>
  </header>

  <div class="card">
    <h2>⚙️ 检测节奏设置</h2>
    <div class="form-group">
      <label for="repoInterval">仓库检查间隔（分钟）</label>
      <input type="number" id="repoInterval" class="input" min="5" max="60" value="5">
      <span style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">每仓库等待时间</span>
    </div>
    <div class="form-group">
      <label for="cycleInterval">检测周期间隔（小时）</label>
      <input type="number" id="cycleInterval" class="input" min="1" max="48" value="8">
      <span style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">两轮检测之间等待</span>
    </div>
    <hr style="border:none;border-top:1px solid var(--md-sys-color-outline-variant);margin:8px 0 16px;">
    <h3 style="font-size:1rem;font-weight:500;margin-bottom:8px;">🔕 免打扰模式</h3>
    <p class="help-text">在指定时段（北京时间 UTC+8）内不发送任何通知；若此间有版本更新，将保留并在免打扰结束后自动补发。</p>
    <div class="form-group">
      <label for="dndEnabled">启用免打扰</label>
      <input type="checkbox" id="dndEnabled">
      <span id="dndStatus" style="font-size:0.8rem;color:var(--md-sys-color-on-surface-variant);"></span>
    </div>
    <div class="form-group">
      <label for="dndStart">开始时间 (北京时间)</label>
      <input type="time" id="dndStart" class="input" value="23:00">
    </div>
    <div class="form-group">
      <label for="dndEnd">结束时间 (北京时间)</label>
      <input type="time" id="dndEnd" class="input" value="08:00">
      <span style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">结束≤开始表示跨午夜</span>
    </div>
    <div class="form-group">
      <button class="btn btn-filled" onclick="saveSettings()">💾 保存设置</button>
      <span id="settingsSaved" style="color:var(--md-sys-color-primary);display:none;">✅ 已保存</span>
    </div>
    <div id="stateInfo" class="info-panel">正在加载状态...</div>
  </div>

  <div class="card">
    <h2>📝 通知内容配置</h2>
    <p class="help-text">
      可用变量：<b>update</b>：<code>{repo}</code> <code>{repo_name}</code> <code>{url}</code> <code>{repo_url}</code> <code>{tag}</code>
      &nbsp;&nbsp;<b>alert</b>：<code>{repo}</code> <code>{message}</code>
    </p>
    <textarea id="notificationTemplate" spellcheck="false" placeholder="JSON 模板内容..."></textarea>
    <div class="form-group" style="margin-top:12px;">
      <button class="btn btn-filled" onclick="saveNotificationConfig()">💾 保存模板</button>
      <span id="notifSaved" style="color:var(--md-sys-color-primary);display:none;">✅ 已保存</span>
    </div>
  </div>

  <div class="card">
    <h2>🔔 通知渠道配置</h2>
    <p class="help-text">通知发送目的地。留空则回退使用 Cloudflare  secret 的 WEBHOOK_URL / WEBHOOK_AUTH_TOKEN。每个部署读自己的配置，互不干扰。</p>
    <div class="form-group">
      <label for="chEnabled">启用自定义通道</label>
      <input type="checkbox" id="chEnabled" checked>
    </div>
    <div class="form-group">
      <label for="chUrl">请求 URL</label>
      <input type="text" id="chUrl" class="input" placeholder="https://example.com/webhook" style="flex:1;min-width:240px;">
    </div>
    <div class="form-group">
      <label for="chMethod">请求方法</label>
      <select id="chMethod" class="input">
        <option>POST</option><option>GET</option><option>PUT</option><option>PATCH</option>
      </select>
    </div>
    <div class="form-group">
      <label for="chToken">Authorization 令牌</label>
      <input type="text" id="chToken" class="input" placeholder="留空则不带 Authorization 头" style="flex:1;min-width:240px;">
    </div>
    <div class="form-group">
      <label for="chBody">请求体模板</label>
    </div>
    <textarea id="chBody" spellcheck="false" placeholder='{"title":"{title}","content":"{content}"}' style="width:100%;min-height:90px;font-family:monospace;font-size:0.8rem;"></textarea>
    <p class="help-text">可用变量：<code>{title}</code> <code>{content}</code> <code>{repo_name}</code> <code>{url}</code> <code>{tag}</code> <code>{message}</code> 等（取自上方通知内容模板的解析结果）。</p>
    <div class="form-group" style="margin-top:12px;">
      <button class="btn btn-filled" onclick="saveNotifyChannel()">💾 保存通道</button>
      <span id="chSaved" style="color:var(--md-sys-color-primary);display:none;">✅ 已保存</span>
    </div>
  </div>

  <div class="card">
    <h2>➕ 添加新监控项目</h2>
    <div class="form-group">
      <input type="text" id="repoInput" class="input" placeholder="例如: vuejs/core" onkeydown="if(event.key==='Enter')addRepo()">
      <button class="btn btn-filled" onclick="addRepo()">确认添加</button>
    </div>
  </div>

  <div class="card">
    <h2>📦 批量导入 / 导出项目</h2>
    <p class="help-text">导入：选择 TXT，逐行识别 <code>owner/name</code>（可附加 <code>owner/name|备注</code>），自动跳过空白、注释（# 开头）、重复与非法行。导出：把所有监控项目按行输出为 TXT。</p>
    <div class="form-group">
      <input type="file" id="importFile" accept=".txt,text/plain" style="flex:1;min-width:200px;">
      <button class="btn btn-filled" onclick="importRepos()">📥 导入 TXT</button>
      <button class="btn btn-tonal" onclick="exportRepos()">📤 导出 TXT</button>
    </div>
    <div id="importResult" class="help-text"></div>
  </div>

  <div class="card">
    <h2>📋 正在监控的项目 (<span id="repoCount">0</span>)</h2>
    <div class="table-wrapper">
      <table>
        <thead><tr><th>状态</th><th>项目路径</th><th>备注</th><th>通知链接</th><th style="width:80px">操作</th></tr></thead>
        <tbody id="repoTableBody"></tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <h2>🧪 手动操作</h2>
    <div style="display:flex;gap:12px;flex-wrap:wrap;">
      <button class="btn btn-tonal" id="testBtn" onclick="runTest()">🎯 立即测试（随机一个仓库）</button>
      <button class="btn btn-outlined" onclick="triggerCycle()">🔄 触发新一轮检测</button>
    </div>
    <div id="loadingText" style="display:none;margin-top:12px;color:var(--md-sys-color-on-surface-variant);">⏳ 正在执行，请稍候...</div>
    <pre id="resultBlock" class="result-block">// 操作结果显示在这里</pre>
  </div>

  <script>
    const params = new URLSearchParams(window.location.search);
    let API_KEY = sessionStorage.getItem('api_key') || '';
    if (params.get('key')) { API_KEY = params.get('key'); sessionStorage.setItem('api_key', API_KEY); window.history.replaceState({}, document.title, window.location.origin + window.location.pathname); }
    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    // 将 UTC ISO 时间字符串格式化为北京时间（UTC+8）显示；withZone=false 时只返回 "YYYY-MM-DD HH:MM:SS"
    function fmtBJ(iso, withZone = true) {
      const d = (typeof iso === 'string') ? new Date(iso) : iso;
      if (!d || isNaN(d.getTime())) return '';
      const b = new Date(d.getTime() + 8 * 3600 * 1000);
      const p = n => String(n).padStart(2, '0');
      const s = b.getUTCFullYear() + '-' + p(b.getUTCMonth() + 1) + '-' + p(b.getUTCDate()) + ' ' + p(b.getUTCHours()) + ':' + p(b.getUTCMinutes()) + ':' + p(b.getUTCSeconds());
      return withZone ? s + ' (北京时间)' : s;
    }
    function tickClock() {
      const el = document.getElementById('clock');
      if (el) el.textContent = '北京时间 ' + fmtBJ(new Date(), false);
    }

    async function apiFetch(url, options = {}) {
      const headers = options.headers || {};
      if (API_KEY) headers['X-API-Key'] = API_KEY;
      const res = await fetch(url, { ...options, headers });
      if (res.status === 403) { document.getElementById('authError').style.display = 'block'; throw new Error('鉴权失败'); }
      if (res.status === 503) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || '数据库不可用');
      }
      if (res.status === 500) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || '服务端错误');
      }
      return res;
    }

    document.addEventListener('DOMContentLoaded', () => {
      if (!API_KEY) document.getElementById('authError').style.display = 'block';
      tickClock(); setInterval(tickClock, 1000);
      document.getElementById('repoTableBody').addEventListener('click', (e) => {
        const btn = e.target.closest('.delete-repo-btn');
        if (btn) { const repo = btn.dataset.repo; if (repo) deleteRepo(repo); }
      });
      document.getElementById('repoTableBody').addEventListener('change', (e) => {
        const input = e.target.closest('.note-input');
        if (input) saveNote(input.dataset.repo, input.value);
      });
      loadSettings(); loadNotificationConfig(); loadNotifyChannel(); loadRepos();
    });

    async function loadSettings() {
      try {
        const res = await apiFetch('/api/get-settings');
        const { settings, state } = await res.json();
        document.getElementById('repoInterval').value = settings.repoIntervalMinutes;
        document.getElementById('cycleInterval').value = settings.cycleIntervalHours;
        const dnd = settings.dnd || { enabled: false, start: "23:00", end: "08:00" };
        document.getElementById('dndEnabled').checked = !!dnd.enabled;
        document.getElementById('dndStart').value = dnd.start || "23:00";
        document.getElementById('dndEnd').value = dnd.end || "08:00";
        updateDndStatus(settings);
        renderState(state, settings);
      } catch (e) {
        document.getElementById('stateInfo').innerHTML = '❌ 加载失败 — ' + esc(e.message || '请检查 D1 绑定与 API Key');
      }
    }
    function isDndActiveClient(dnd) {
      if (!dnd || !dnd.enabled) return false;
      const parse = (s) => { const m=/^(\\d{1,2}):(\\d{2})$/.exec(s||""); if(!m) return null; const h=+m[1],mi=+m[2]; if(h>23||mi>59) return null; return h*60+mi; };
      const s = parse(dnd.start), e = parse(dnd.end);
      if (s===null||e===null||s===e) return false;
      const d = new Date();
      const cur = (d.getUTCHours()*60 + d.getUTCMinutes() + 8*60) % (24*60);
      if (s<e) return cur>=s && cur<e;
      return cur>=s || cur<e;
    }
    function updateDndStatus(settings) {
      const el = document.getElementById('dndStatus');
      if (!el) return;
      const dnd = settings.dnd;
      if (!dnd || !dnd.enabled) { el.textContent = '（已关闭）'; el.style.color = 'var(--md-sys-color-on-surface-variant)'; return; }
      if (dnd.start === dnd.end) { el.textContent = '⚠️ 开始=结束，免打扰未生效（请设为不同时间）'; el.style.color = 'var(--md-sys-color-error)'; return; }
      if (isDndActiveClient(dnd)) { el.textContent = '🔕 当前处于免打扰时段'; el.style.color = 'var(--md-sys-color-error)'; }
      else { el.textContent = '🟢 当前可通知（北京时间 '+dnd.start+'–'+dnd.end+' 免打扰）'; el.style.color = 'var(--md-sys-color-primary)'; }
    }
    function renderState(state, settings) {
      const el = document.getElementById('stateInfo');
      if (!state || !state.phase || !state.cycleStartTime && !state.cycleEndTime) {
        el.innerHTML = '⚠️ 调度服务未就绪，请检查 D1 配置';
        return;
      }
      let total = parseInt(state.totalRepos,10)||0;
      if (total===0) total = parseInt(document.getElementById('repoCount').textContent,10)||0;
      let html = '';
      if (state.phase==='checking') {
        let nextIn = settings.repoIntervalMinutes;
        if (state.lastRepoCheckTime) {
          const elapsed = (Date.now() - new Date(state.lastRepoCheckTime).getTime())/60000;
          nextIn = Math.max(0, Math.ceil(settings.repoIntervalMinutes - elapsed));
        }
        html = '🟢 <b>检测中</b> — 进度: '+state.currentIndex+'/'+total+' | 下一个仓库约 '+nextIn+' 分钟后检查';
        if (state.lastRepoCheckTime) html += '<br>上次检查: '+esc(fmtBJ(state.lastRepoCheckTime));
      } else {
        const cycleMs = settings.cycleIntervalHours*3600000;
        const waitSince = state.cycleEndTime ? new Date(state.cycleEndTime) : (state.cycleStartTime ? new Date(state.cycleStartTime) : new Date());
        const next = new Date(waitSince.getTime()+cycleMs);
        html = '💤 <b>等待中</b> — 预计下次: '+esc(fmtBJ(next.toISOString()));
        if (state.cycleStartTime) html += '<br>本轮开始: '+esc(fmtBJ(state.cycleStartTime));
        if (state.cycleEndTime) html += '，结束: '+esc(fmtBJ(state.cycleEndTime));
      }
      if (settings.dnd && settings.dnd.enabled && isDndActiveClient(settings.dnd)) {
        html += '<br>🔕 免打扰时段中，更新将延后通知';
      }
      el.innerHTML = html;
    }

    async function saveSettings() {
      const repoIntervalMinutes = parseInt(document.getElementById('repoInterval').value,10);
      const cycleIntervalHours = parseInt(document.getElementById('cycleInterval').value,10);
      const dnd = {
        enabled: document.getElementById('dndEnabled').checked,
        start: document.getElementById('dndStart').value || "23:00",
        end: document.getElementById('dndEnd').value || "08:00"
      };
      try {
        const res = await apiFetch('/api/save-settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ repoIntervalMinutes, cycleIntervalHours, dnd }) });
        const data = await res.json();
        if (data.success) { document.getElementById('settingsSaved').style.display = 'inline'; setTimeout(() => document.getElementById('settingsSaved').style.display = 'none', 2600); loadSettings(); }
        else alert('错误: ' + data.error);
      } catch (e) { alert('保存失败: ' + e.message); }
    }

    async function loadNotificationConfig() {
      try { const res = await apiFetch('/api/get-notification-config'); document.getElementById('notificationTemplate').value = JSON.stringify(await res.json(), null, 2); } catch (e) {}
    }
    async function saveNotificationConfig() {
      const textarea = document.getElementById('notificationTemplate');
      let config; try { config = JSON.parse(textarea.value); } catch (e) { alert('JSON 格式无效'); return; }
      if (!config.update || !config.alert) { alert('配置必须包含 update 和 alert 对象'); return; }
      try {
        const res = await apiFetch('/api/save-notification-config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(config) });
        const data = await res.json();
        if (data.success) { document.getElementById('notifSaved').style.display = 'inline'; setTimeout(() => document.getElementById('notifSaved').style.display = 'none', 2600); }
        else alert('保存失败: ' + data.error);
      } catch (e) { alert('保存失败: ' + e.message); }
    }

    async function loadNotifyChannel() {
      try {
        const res = await apiFetch('/api/get-notify-channel');
        const data = await res.json();
        const ch = data.channel;
        if (!ch) return;
        document.getElementById('chEnabled').checked = ch.enabled !== false;
        document.getElementById('chUrl').value = ch.url || '';
        const m = document.getElementById('chMethod');
        if (ch.method) { for (const o of m.options) { if (o.value === ch.method) { o.selected = true; break; } } }
        document.getElementById('chToken').value = (ch.headers && ch.headers['Authorization'] && ch.headers['Authorization'] !== '***') ? ch.headers['Authorization'] : '';
        document.getElementById('chBody').value = ch.bodyTemplate || '';
      } catch (e) { /* 忽略 */ }
    }
    async function saveNotifyChannel() {
      const enabled = document.getElementById('chEnabled').checked;
      const url = document.getElementById('chUrl').value.trim();
      const method = document.getElementById('chMethod').value;
      const token = document.getElementById('chToken').value.trim();
      const bodyTemplate = document.getElementById('chBody').value;
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = token;
      const payload = { enabled, url, method, headers, bodyTemplate };
      try {
        const res = await apiFetch('/api/save-notify-channel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (data.success) { document.getElementById('chSaved').style.display = 'inline'; setTimeout(() => { document.getElementById('chSaved').style.display = 'none'; }, 2000); }
        else if (data.error) alert(data.error);
      } catch (e) { alert('保存失败: ' + e.message); }
    }

    async function triggerCycle() {
      try {
        const res = await apiFetch('/api/trigger-cycle', { method:'POST' });
        document.getElementById('resultBlock').textContent = JSON.stringify(await res.json(), null, 2);
        await loadSettings();
      } catch (e) {
        document.getElementById('resultBlock').textContent = '请求失败: ' + e.message;
      }
    }

    async function loadRepos() {
      try { const res = await apiFetch('/api/get-repos'); renderTable(await res.json()); } catch (e) {}
    }
    function renderTable(repos) {
      document.getElementById('repoCount').textContent = repos.length;
      const tbody = document.getElementById('repoTableBody');
      if (!repos.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--md-sys-color-on-surface-variant);">暂无监控项目</td></tr>'; return; }
      tbody.innerHTML = repos.map(item => {
        let badgeClass = 'badge-ok', badgeText = '正常';
        if (item.health==='dead') { badgeClass = 'badge-dead'; badgeText = '失效'; }
        else if (item.health==='warning') { badgeClass = 'badge-warn'; badgeText = '异常'; }
        else if (item.health==='recovered') { badgeClass = 'badge-recov'; badgeText = '观察中'; }
        const tip = (item.lastError||'') + (item.reason ? ' | 原因：'+item.reason : '') + (item.judgeReason ? ' | 判定：'+item.judgeReason : '');
        return '<tr><td><span class="badge '+badgeClass+'" title="'+escAttr(tip)+'">'+badgeText+'</span></td><td>'+esc(item.repo)+'</td><td><input class="note-input" data-repo="'+escAttr(item.repo)+'" value="'+escAttr(item.note||'')+'" placeholder="备注..."></td><td><code style="background:var(--md-sys-color-surface-variant);padding:2px 6px;border-radius:4px;">'+esc(item.custom_url)+'</code></td><td><button class="btn btn-error delete-repo-btn" data-repo="'+escAttr(item.repo)+'" style="height:32px;padding:0 12px;font-size:0.7rem;">删除</button></td></tr>';
      }).join('');
    }

    async function addRepo() {
      const input = document.getElementById('repoInput'); const repo = input.value.trim(); if (!repo) return;
      try {
        const res = await apiFetch('/api/add-repo', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ repo }) });
        const data = await res.json();
        if (data.success) { input.value = ''; renderTable(data.repos); loadSettings(); }
        else alert('错误: ' + data.error);
      } catch (e) { alert('请求失败: ' + e.message); }
    }

    async function deleteRepo(repo) {
      if (!confirm('确定取消监控 ' + repo + ' 吗？')) return;
      try {
        const res = await apiFetch('/api/delete-repo', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ repo }) });
        const data = await res.json();
        if (data.success) { renderTable(data.repos); loadSettings(); }
        else alert('错误: ' + data.error);
      } catch (e) { alert('请求失败: ' + e.message); }
    }

    async function importRepos() {
      const fileInput = document.getElementById('importFile');
      const resultEl = document.getElementById('importResult');
      const file = fileInput.files && fileInput.files[0];
      if (!file) { resultEl.textContent = '⚠️ 请先选择一个 .txt 文件'; resultEl.style.color = 'var(--md-sys-color-error)'; return; }
      resultEl.textContent = '⏳ 正在导入...'; resultEl.style.color = 'var(--md-sys-color-on-surface-variant)';
      try {
        const content = await file.text();
        const res = await apiFetch('/api/import-repos', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ content }) });
        const data = await res.json();
        if (data.success) {
          let msg = '✅ 导入完成：新增 ' + data.imported + ' 个，跳过重复 ' + data.skipped + ' 个，非法 ' + data.invalid + ' 行';
          if (data.invalidLines && data.invalidLines.length) msg += '\\n⚠️ 非法行示例：' + data.invalidLines.slice(0,3).join(' | ');
          resultEl.textContent = msg; resultEl.style.color = 'var(--md-sys-color-primary)';
          renderTable(data.repos); loadSettings();
          fileInput.value = '';
        } else { resultEl.textContent = '❌ ' + (data.error || '导入失败'); resultEl.style.color = 'var(--md-sys-color-error)'; }
      } catch (e) { resultEl.textContent = '请求失败: ' + e.message; resultEl.style.color = 'var(--md-sys-color-error)'; }
    }

    async function exportRepos() {
      try {
        const res = await apiFetch('/api/export-repos');
        const txt = await res.text();
        const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'repos_export.txt';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      } catch (e) { alert('导出失败: ' + e.message); }
    }

    async function saveNote(repo, note) {
      try {
        await apiFetch('/api/update-note', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ repo, note }) });
      } catch (e) { alert('备注保存失败: ' + e.message); }
    }

    async function runTest() {
      const btn = document.getElementById('testBtn'), loading = document.getElementById('loadingText'), resultBlock = document.getElementById('resultBlock');
      btn.disabled = true; loading.style.display = 'block'; resultBlock.textContent = '// 随机选取一个仓库，跑完整「检测 + 发送通知」逻辑中...';
      try {
        const res = await apiFetch('/api/test');
        if (res.status === 429) {
          resultBlock.textContent = '请求过于频繁，请 10 秒后再试';
        } else {
          const data = await res.json();
          const sep = String.fromCharCode(10);
          const lines = [];
          lines.push('随机选中仓库: ' + (data.picked || '未知'));
          lines.push('监控仓库总数: ' + (data.total || 0));
          if (data.results && data.results[0]) {
            const r = data.results[0];
            lines.push('检测成功: ' + (r.success ? '是' : '否'));
            lines.push('通知已发送: ' + (r.push_ok ? '是' : '否'));
            if (r.push_ok === false) lines.push('提示: 通知发送失败，请检查 WEBHOOK_URL / WEBHOOK_AUTH_TOKEN 配置');
          }
          lines.push('');
          lines.push(JSON.stringify(data, null, 2));
          resultBlock.textContent = lines.join(sep);
        }
      }
      catch (e) { resultBlock.textContent = '请求失败: ' + e.message; }
      finally { btn.disabled = false; loading.style.display = 'none'; }
    }
  </script>
</body>
</html>`;