// ==================== 全局基础配置 ====================
// ⚠️ 环境变量（Cloudflare 后台配置）：
//   WEBHOOK_URL          (文本)
//   WEBHOOK_AUTH_TOKEN   (密钥)
//   GITHUB_TOKEN         (密钥)
//   API_KEY              (密钥)
//   DB                   (D1 绑定名)

const DEFAULT_SETTINGS = {
  repoIntervalMinutes: 5,
  cycleIntervalHours: 8
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
    content: "{repo}\n{message}",
    platform: "GitHub Monitor",
    username: "System Alert",
    eventLabel: "🚨",
    taskType: "异常通知",
    taskStatus: "Failed",
    filename: "{repo}",
    error: "{message}"
  }
};

const ALLOWED_TEMPLATE_VARS = {
  update: ['repo', 'repo_name', 'url', 'repo_url', 'tag'],
  alert:  ['repo', 'message']
};

const ALERT_FAILURE_COUNT = 5;
const MAX_TEST_REPOS = 1;
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
        if (text.length > 4096) return jsonResponse({ error: "Request body too large" }, 413);
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

    // 仓库管理
    if (url.pathname === "/api/get-repos") {
      const repos = await getStoredRepos(db);
      const errorsMap = await getErrorsMap(db);
      const enriched = repos.map(item => {
        const err = errorsMap[item.repo];
        let health = "ok", lastError = "";
        if (err) {
          if (err.permanent) health = "dead";
          else if (err.count > 0) health = "warning";
          else if (err.alertedAt) health = "recovered";
          lastError = err.lastError || "";
        }
        return { ...item, health, lastError };
      });
      return jsonResponse(enriched);
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

    // 手动测试
    if (url.pathname === "/api/test") {
      if (Date.now() - lastTestTime < 10000) {
        return jsonResponse({ error: "请求过于频繁，请 10 秒后再试" }, 429);
      }
      lastTestTime = Date.now();

      const repos = await getStoredRepos(db);
      const toTest = repos.slice(0, MAX_TEST_REPOS);
      const results = [];
      for (const item of toTest) {
        const res = await checkSingleRepo(env, item, true);
        results.push({ repo: res.repo, success: res.success, push_ok: res.push_ok });
      }
      return jsonResponse({ tested: toTest.length, total: repos.length, results });
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

    await checkSingleRepo(env, result.item, false);
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
async function checkSingleRepo(env, item, forceTrigger) {
  const db = env.DB;
  let repo = item.repo;
  let targetUrl = item.custom_url;
  const now = new Date().toISOString();

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

  try {
    let etagCache = null;
    if (!forceTrigger) {
      const etagStr = await getRepoEtag(db, repo);
      if (etagStr) try { etagCache = JSON.parse(etagStr); } catch {}
    }

    let data, fromCache = false, res;
    const headers = { ...githubHeaders };
    if (etagCache?.etag && oldTag !== null) headers["If-None-Match"] = etagCache.etag;

    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        res = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases/latest`, { headers }, TIMEOUT_GITHUB);

        if (res.status === 404) {
          if (!forceTrigger) {
            errorInfo = {
              count: ALERT_FAILURE_COUNT,
              lastError: "404 — 仓库可能已删除、改名或转为私有",
              lastTime: now,
              permanent: true
            };
            await saveErrorsForRepo(db, repo, errorInfo);
            const template = await getNotificationTemplate(db);
            await sendAlertNotification(env, buildPayload(template.alert, { repo, message: "404" }));
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
      const template = await getNotificationTemplate(db);
      const repoName = repo.split("/")[1] || repo;
      const payload = buildPayload(template.update, {
        repo,
        repo_name: repoName,
        url: targetUrl,
        repo_url: targetUrl,
        tag: latestTag || oldTag || "测试"
      });

      let pushOk = false;
      for (let attempt = 0; attempt <= 1; attempt++) {
        try {
          const pushRes = await fetchWithTimeout(env.WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(env.WEBHOOK_AUTH_TOKEN ? { Authorization: env.WEBHOOK_AUTH_TOKEN } : {}) },
            body: JSON.stringify(payload)
          }, TIMEOUT_WEBHOOK);
          if (pushRes.ok) {
            pushOk = true;
            break;
          }
        } catch (e) {
          if (attempt === 1) break;
        }
        if (attempt < 1) await new Promise(r => setTimeout(r, 1000));
      }

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
      errorInfo = errorInfo || { count: 0 };
      errorInfo.count = (errorInfo.count || 0) + 1;
      errorInfo.lastError = err.message;
      errorInfo.lastTime = now;
      errorInfo.successCount = 0;

      if (errorInfo.count >= ALERT_FAILURE_COUNT && !errorInfo.alertedAt) {
        const template = await getNotificationTemplate(db);
        await sendAlertNotification(env, buildPayload(template.alert, { repo, message: err.message }));
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
      return { ...errorInfo, count: 0, lastError: "", lastTime: now, successCount };
    }
  } else {
    return { ...errorInfo, count: newCount, lastError: "", lastTime: now, successCount: 0 };
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

async function sendAlertNotification(env, payload) {
  try {
    await fetchWithTimeout(env.WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(env.WEBHOOK_AUTH_TOKEN ? { Authorization: env.WEBHOOK_AUTH_TOKEN } : {}) },
      body: JSON.stringify(payload)
    }, TIMEOUT_WEBHOOK);
  } catch (e) { /* 忽略 */ }
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

// ==================== 完整前端面板 ====================
const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>GitHub Release 监控控制台</title>
  <style>
    :root {
      --md-sys-color-primary: #6750A4;
      --md-sys-color-on-primary: #FFFFFF;
      --md-sys-color-primary-container: #EADDFF;
      --md-sys-color-on-primary-container: #21005D;
      --md-sys-color-secondary: #625B71;
      --md-sys-color-on-secondary: #FFFFFF;
      --md-sys-color-secondary-container: #E8DEF8;
      --md-sys-color-on-secondary-container: #1D192B;
      --md-sys-color-error: #B3261E;
      --md-sys-color-on-error: #FFFFFF;
      --md-sys-color-error-container: #F9DEDC;
      --md-sys-color-on-error-container: #410E0B;
      --md-sys-color-background: #FFFBFE;
      --md-sys-color-on-background: #1C1B1F;
      --md-sys-color-surface: #FFFBFE;
      --md-sys-color-on-surface: #1C1B1F;
      --md-sys-color-surface-variant: #E7E0EC;
      --md-sys-color-on-surface-variant: #49454F;
      --md-sys-color-outline: #79747E;
      --md-sys-color-outline-variant: #CAC4D0;
      --md-sys-color-surface-1: #F7F2FA;
      --md-sys-color-surface-2: #F2ECF5;
      --md-sys-elevation-1: 0 1px 2px rgba(0,0,0,0.3), 0 1px 3px 1px rgba(0,0,0,0.15);
      --md-sys-elevation-2: 0 1px 2px rgba(0,0,0,0.3), 0 2px 6px 2px rgba(0,0,0,0.15);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --md-sys-color-primary: #D0BCFF;
        --md-sys-color-on-primary: #381E72;
        --md-sys-color-primary-container: #4F378B;
        --md-sys-color-on-primary-container: #EADDFF;
        --md-sys-color-secondary: #CCC2DC;
        --md-sys-color-on-secondary: #332D41;
        --md-sys-color-secondary-container: #4A4458;
        --md-sys-color-on-secondary-container: #E8DEF8;
        --md-sys-color-error: #F2B8B5;
        --md-sys-color-on-error: #601410;
        --md-sys-color-error-container: #8C1D18;
        --md-sys-color-on-error-container: #F9DEDC;
        --md-sys-color-background: #1C1B1F;
        --md-sys-color-on-background: #E6E1E5;
        --md-sys-color-surface: #1C1B1F;
        --md-sys-color-on-surface: #E6E1E5;
        --md-sys-color-surface-variant: #49454F;
        --md-sys-color-on-surface-variant: #CAC4D0;
        --md-sys-color-outline: #938F99;
        --md-sys-color-outline-variant: #49454F;
        --md-sys-color-surface-1: #242329;
        --md-sys-color-surface-2: #2A2830;
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
    .app-header h1 { font-size: 2rem; font-weight: 500; }
    .version {
      background: var(--md-sys-color-primary-container);
      color: var(--md-sys-color-on-primary-container);
      padding: 2px 12px; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; margin-left: 8px;
    }
    .subtitle { color: var(--md-sys-color-on-surface-variant); font-size: 0.875rem; margin-top: 4px; }
    .card {
      background: var(--md-sys-color-surface); border-radius: 12px; padding: 24px;
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
    <h2>➕ 添加新监控项目</h2>
    <div class="form-group">
      <input type="text" id="repoInput" class="input" placeholder="例如: vuejs/core" onkeydown="if(event.key==='Enter')addRepo()">
      <button class="btn btn-filled" onclick="addRepo()">确认添加</button>
    </div>
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
      <button class="btn btn-tonal" id="testBtn" onclick="runTest()">🎯 立即测试一个</button>
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
      document.getElementById('repoTableBody').addEventListener('click', (e) => {
        const btn = e.target.closest('.delete-repo-btn');
        if (btn) { const repo = btn.dataset.repo; if (repo) deleteRepo(repo); }
      });
      document.getElementById('repoTableBody').addEventListener('change', (e) => {
        const input = e.target.closest('.note-input');
        if (input) saveNote(input.dataset.repo, input.value);
      });
      loadSettings(); loadNotificationConfig(); loadRepos();
    });

    async function loadSettings() {
      try {
        const res = await apiFetch('/api/get-settings');
        const { settings, state } = await res.json();
        document.getElementById('repoInterval').value = settings.repoIntervalMinutes;
        document.getElementById('cycleInterval').value = settings.cycleIntervalHours;
        renderState(state, settings);
      } catch (e) {
        document.getElementById('stateInfo').innerHTML = '❌ 加载失败 — ' + esc(e.message || '请检查 D1 绑定与 API Key');
      }
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
        if (state.lastRepoCheckTime) html += '<br>上次检查: '+esc(state.lastRepoCheckTime.slice(0,19).replace('T',' '));
      } else {
        const cycleMs = settings.cycleIntervalHours*3600000;
        const waitSince = state.cycleEndTime ? new Date(state.cycleEndTime) : (state.cycleStartTime ? new Date(state.cycleStartTime) : new Date());
        const next = new Date(waitSince.getTime()+cycleMs);
        html = '💤 <b>等待中</b> — 预计下次: '+esc(next.toISOString().slice(0,19).replace('T',' '))+' UTC';
        if (state.cycleStartTime) html += '<br>本轮开始: '+esc(state.cycleStartTime.slice(0,19).replace('T',' '));
        if (state.cycleEndTime) html += '，结束: '+esc(state.cycleEndTime.slice(0,19).replace('T',' '));
      }
      el.innerHTML = html;
    }

    async function saveSettings() {
      const repoIntervalMinutes = parseInt(document.getElementById('repoInterval').value,10);
      const cycleIntervalHours = parseInt(document.getElementById('cycleInterval').value,10);
      try {
        const res = await apiFetch('/api/save-settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ repoIntervalMinutes, cycleIntervalHours }) });
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
        return '<tr><td><span class="badge '+badgeClass+'" title="'+escAttr(item.lastError||'')+'">'+badgeText+'</span></td><td>'+esc(item.repo)+'</td><td><input class="note-input" data-repo="'+escAttr(item.repo)+'" value="'+escAttr(item.note||'')+'" placeholder="备注..."></td><td><code style="background:var(--md-sys-color-surface-variant);padding:2px 6px;border-radius:4px;">'+esc(item.custom_url)+'</code></td><td><button class="btn btn-error delete-repo-btn" data-repo="'+escAttr(item.repo)+'" style="height:32px;padding:0 12px;font-size:0.7rem;">删除</button></td></tr>';
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

    async function saveNote(repo, note) {
      try {
        await apiFetch('/api/update-note', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ repo, note }) });
      } catch (e) { alert('备注保存失败: ' + e.message); }
    }

    async function runTest() {
      const btn = document.getElementById('testBtn'), loading = document.getElementById('loadingText'), resultBlock = document.getElementById('resultBlock');
      btn.disabled = true; loading.style.display = 'block'; resultBlock.textContent = '// 执行中...';
      try {
        const res = await apiFetch('/api/test');
        if (res.status === 429) {
          resultBlock.textContent = '请求过于频繁，请 10 秒后再试';
        } else {
          resultBlock.textContent = JSON.stringify(await res.json(), null, 2);
        }
      }
      catch (e) { resultBlock.textContent = '请求失败: ' + e.message; }
      finally { btn.disabled = false; loading.style.display = 'none'; }
    }
  </script>
</body>
</html>`;