const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[\x21-\x7e]+$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+()-]*$/;
const RATING_KEYS = ["well", "issues", "unplayable", "no_start"];
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { ...CORS, ...headers } });
}
function invalid(name) { throw new HttpError(400, `Invalid ${name}`); }
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(name);
  return value;
}
function string(value, name, max, pattern) {
  if (typeof value !== "string" || !value.length || [...value].length > max || !pattern.test(value)) invalid(name);
  return value;
}
function number(value, name, min, max, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) invalid(name);
  return value;
}
function boolean(value, name) {
  if (typeof value !== "boolean") invalid(name);
  return Number(value);
}
function choice(value, name, values) {
  if (!values.includes(value)) invalid(name);
  return value;
}
/** Flatten only known schema fields; unknown keys never reach D1. */
export function validate(value, rating = false) {
  const b = object(value, "body"), mac = object(b.mac, "mac"), vm = object(b.vm, "vm");
  const row = {
    v: number(b.v, "v", 1, 1, true),
    install: string(b.install, "install", 36, UUID).toLowerCase(),
    launcher: string(b.launcher, "launcher", 64, VERSION),
    appid: number(b.appid, "appid", 1, 4294967295, true),
    mac_model: string(mac.model, "mac.model", 64, /^[A-Za-z0-9,._-]+$/),
    mac_chip: string(mac.chip, "mac.chip", 64, /^[A-Za-z0-9 +()._-]+$/),
    mac_cores: number(mac.cores, "mac.cores", 1, 1024, true),
    mac_ram_gb: number(mac.ram_gb, "mac.ram_gb", 1, 4096, true),
    mac_macos: string(mac.macos, "mac.macos", 64, VERSION),
    vm_driver: choice(vm.driver, "vm.driver", ["moltenvk", "kosmickrisp"]),
    vm_wmtr: boolean(vm.wmtr, "vm.wmtr"),
  };
  if ("game" in b) row.game = string(b.game, "game", 128, /^[^\p{Cc}\p{Cs}\p{Cf}]+$/u);
  if ("pcores" in mac) {
    row.mac_pcores = number(mac.pcores, "mac.pcores", 0, 1024, true);
    if (row.mac_pcores > row.mac_cores) invalid("mac.pcores");
  }
  if ("gpu_cores" in mac) row.mac_gpu_cores = number(mac.gpu_cores, "mac.gpu_cores", 1, 4096, true);
  const vmFields = {
    cpus: () => number(vm.cpus, "vm.cpus", 1, 1024, true),
    mem_mib: () => number(vm.mem_mib, "vm.mem_mib", 1, 4194304, true),
    hz: () => number(vm.hz, "vm.hz", 1, 1000),
  };
  for (const [key, parse] of Object.entries(vmFields)) {
    if (!rating || key in vm) row[`vm_${key}`] = parse();
  }
  if ("steamos" in vm) row.vm_steamos = string(vm.steamos, "vm.steamos", 64, VERSION);
  if (rating) {
    row.rating = choice(b.rating, "rating", [...RATING_KEYS, "none"]);
    return row;
  }
  Object.assign(row, {
    sid: string(b.sid, "sid", 36, UUID).toLowerCase(),
    launched: boolean(b.launched, "launched"),
    end: choice(b.end, "end", ["exit", "shutdown", "session", "replaced"]),
    run_s: number(b.run_s, "run_s", 0, 604800),
    play_s: number(b.play_s, "play_s", 0, 604800),
  });
  if (row.play_s > row.run_s) invalid("play_s");
  if ("first_window_s" in b) row.first_window_s = number(b.first_window_s, "first_window_s", 0, row.run_s);
  if ("proton" in b) row.proton = string(b.proton, "proton", 64, TOKEN);
  if ("res" in b) {
    row.res = string(b.res, "res", 11, /^\d{1,5}x\d{1,5}$/);
    if (!row.res.split("x").every((n) => Number(n) >= 1 && Number(n) <= 32768)) invalid("res");
  }
  if ("fps" in b) {
    const fps = object(b.fps, "fps");
    for (const key of ["avg", "p50", "low1", "hitches_per_min"]) {
      row[`fps_${key}`] = number(fps[key], `fps.${key}`, 0, key === "hitches_per_min" ? 60000 : 1000);
    }
  }
  if ("mem" in b) {
    const mem = object(b.mem, "mem");
    for (const key of ["game_mib", "guest_mib", "host_mib"]) {
      if (key in mem) row[`mem_${key}`] = number(mem[key], `mem.${key}`, 0, 4194304);
    }
  }
  return row;
}
async function bodyJSON(request, max) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "")) invalid("Content-Type");
  if (Number(request.headers.get("Content-Length")) > max) throw new HttpError(413, "Body too large");
  const reader = request.body?.getReader();
  if (!reader) invalid("body");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new HttpError(413, "Body too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { invalid("JSON"); }
}
async function post(request, env, rating) {
  const row = validate(await bodyJSON(request, rating ? 4096 : 8192), rating);
  if (!rating && await env.DB.prepare("SELECT 1 FROM sessions WHERE sid = ?").bind(row.sid).first()) {
    return json({ status: "duplicate" });
  }
  // The address is used only as a transient limiter key, never persisted or logged.
  if (!(await env.POST_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") || "local" })).success) {
    throw new HttpError(429, "IP rate limit");
  }
  try {
    if (rating && row.rating === "none") {
      await env.DB.prepare("DELETE FROM ratings WHERE install = ? AND appid = ?").bind(row.install, row.appid).run();
      return json({ status: "cleared" });
    }
    const columns = Object.keys(row);
    const sql = `${rating ? "INSERT OR REPLACE" : "INSERT"} INTO ${rating ? "ratings" : "sessions"}
      (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})${rating ? "" : " ON CONFLICT(sid) DO NOTHING"}`;
    const result = await env.DB.prepare(sql).bind(...Object.values(row)).run();
    return json({ status: rating ? "stored" : result.meta.changes ? "stored" : "duplicate" }, rating ? 200 : result.meta.changes ? 201 : 200);
  } catch (error) {
    if (String(error).includes("daily rate limit")) throw new HttpError(429, "Installation daily rate limit");
    throw error;
  }
}
const MEDIANS = { fps_avg: "fps_avg_median", fps_low1: "fps_low1_median", mem_game_mib: "game_mib_median", mem_host_mib: "host_mib_median" };
const HARDWARE_FILTERS = {
  max_gpu_cores: { column: "mac_gpu_cores", max: 4096 },
  max_ram_gb: { column: "mac_ram_gb", max: 4096 },
  max_pcores: { column: "mac_pcores", max: 1024 },
};
function hardwareFilters(params) {
  const filters = {};
  for (const [key, { max }] of Object.entries(HARDWARE_FILTERS)) {
    const values = params.getAll(key);
    if (!values.length) continue;
    if (values.length !== 1 || !/^\d+$/.test(values[0])) invalid(key);
    filters[key] = number(Number(values[0]), key, 1, max, true);
  }
  return filters;
}
/** One bound predicate is shared by every session/rating aggregate; NULL never satisfies <=. */
function reportScope(appid, filters) {
  const clauses = [], bindings = [];
  if (appid !== undefined) { clauses.push("appid = ?"); bindings.push(appid); }
  for (const [key, value] of Object.entries(filters)) {
    clauses.push(`${HARDWARE_FILTERS[key].column} <= ?`);
    bindings.push(value);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", bindings };
}
/** Window ranks produce exact medians, ignoring missing measurements, without transferring raw history. */
async function summaries(db, scope, config = false) {
  const group = config ? "appid, mac_chip, mac_ram_gb, vm_driver, vm_wmtr" : "appid";
  const metrics = config ? Object.entries(MEDIANS) : [["fps_avg", "fps_avg_median"]];
  const ranks = metrics.map(([key]) => `row_number() OVER (PARTITION BY ${group} ORDER BY ${key} IS NULL, ${key}) AS ${key}_rank,
    count(${key}) OVER (PARTITION BY ${group}) AS ${key}_count`).join(",");
  const medians = metrics.map(([key, name]) => `avg(CASE WHEN ${key}_rank IN ((${key}_count + 1) / 2, (${key}_count + 2) / 2) THEN ${key} END) AS ${name}`).join(",");
  const rows = await db.prepare(`WITH ranked AS (
    SELECT *, ${ranks}
    FROM sessions ${scope.where}
  ) SELECT appid, (SELECT game FROM game_names WHERE game_names.appid = ranked.appid) AS game,
    count(*) AS sessions, count(DISTINCT install) AS installs, avg(launched) AS launch_rate,
    sum(play_s) / 3600.0 AS play_hours, max(received) AS last_seen, ${medians}
    ${config ? ", mac_chip AS chip, mac_ram_gb AS ram_gb, vm_driver AS driver, vm_wmtr AS wmtr, 1.0 * sum(CASE WHEN launched = 1 AND end = 'exit' AND run_s < 60 THEN 1 ELSE 0 END) / nullif(sum(launched), 0) AS early_exit_rate" : ""}
    FROM ranked GROUP BY ${group} ORDER BY sessions DESC, appid`).bind(...scope.bindings).all();
  return rows.results;
}
function emptyRatings() { return { well: 0, issues: 0, unplayable: 0, no_start: 0 }; }
function configKey(row) { return JSON.stringify([row.chip, row.ram_gb, row.driver, Number(row.wmtr)]); }
async function ratingRows(db, scope, config = false) {
  return (await db.prepare(`SELECT appid, (SELECT game FROM game_names WHERE game_names.appid = ranked.appid) AS game,
    ${RATING_KEYS.map((key) => `sum(rating = '${key}') AS ${key}`).join(",")}, max(received) AS last_seen
    ${config ? ", mac_chip AS chip, mac_ram_gb AS ram_gb, vm_driver AS driver, vm_wmtr AS wmtr" : ""}
    FROM ratings AS ranked ${scope.where}
    GROUP BY appid ${config ? ", mac_chip, mac_ram_gb, vm_driver, vm_wmtr" : ""}`).bind(...scope.bindings).all()).results;
}
function mergeRatings(sessions, ratings, config = false) {
  const key = config ? configKey : (row) => row.appid;
  const rows = new Map(sessions.map((row) => [key(row), { ...row, ratings: emptyRatings() }]));
  for (const r of ratings) {
    let row = rows.get(key(r));
    if (!row) {
      row = { appid: r.appid, game: r.game, sessions: 0, installs: 0, launch_rate: null, play_hours: 0, fps_avg_median: null, last_seen: r.last_seen, ratings: emptyRatings() };
      if (config) Object.assign(row, { chip: r.chip, ram_gb: r.ram_gb, driver: r.driver, wmtr: r.wmtr, early_exit_rate: null, fps_low1_median: null, game_mib_median: null, host_mib_median: null });
      rows.set(key(r), row);
    }
    for (const name of RATING_KEYS) row.ratings[name] = r[name];
  }
  return [...rows.values()].map((row) => config ? { ...row, wmtr: Boolean(row.wmtr) } : row);
}
/** Distinct tested chips include rating-only configurations, ranked by session sample size. */
async function testedChips(db, scope) {
  const rows = (await db.prepare(`SELECT appid, chip, sum(sessions) AS sessions FROM (
    SELECT appid, mac_chip AS chip, count(*) AS sessions FROM sessions ${scope.where} GROUP BY appid, mac_chip
    UNION ALL
    SELECT appid, mac_chip AS chip, 0 AS sessions FROM ratings ${scope.where} GROUP BY appid, mac_chip
  ) GROUP BY appid, chip ORDER BY appid, sessions DESC, chip`).bind(...scope.bindings, ...scope.bindings).all()).results;
  const chips = new Map();
  for (const row of rows) {
    if (!chips.has(row.appid)) chips.set(row.appid, []);
    chips.get(row.appid).push(row.chip);
  }
  return chips;
}
async function get(env, appid, filters) {
  const scope = reportScope(appid, filters);
  const games = mergeRatings(await summaries(env.DB, scope), await ratingRows(env.DB, scope));
  const chips = await testedChips(env.DB, scope);
  for (const game of games) game.chips = chips.get(game.appid) || [];
  if (appid === undefined) return { generated: new Date().toISOString(), games };
  if (!games.length) throw new HttpError(404, "Game not found");
  const configs = mergeRatings(await summaries(env.DB, scope, true), await ratingRows(env.DB, scope, true), true);
  return { generated: new Date().toISOString(), ...games[0], configs };
}
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url), path = url.pathname;
      const detail = /^\/v1\/games\/([1-9]\d*)$/.exec(path);
      const isGet = path === "/v1/games" || (detail && Number(detail[1]) <= 4294967295);
      const isPost = path === "/v1/sessions" || path === "/v1/ratings";
      if (!isGet && !isPost) throw new HttpError(404, "Not found");
      if (request.method === "OPTIONS") return json({ status: "ok" });
      if (isPost && request.method === "POST") return await post(request, env, path === "/v1/ratings");
      if (!isGet || request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: isGet ? "GET, OPTIONS" : "POST, OPTIONS" });
      // Do not serve cached responses from the earlier API that included individual sessions.
      const filters = hardwareFilters(url.searchParams);
      const cacheParams = new URLSearchParams({ aggregates: "2", ...filters });
      const cacheKey = new Request(`${url.origin}${path}?${cacheParams}`, { method: "GET" });
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      const response = json(await get(env, detail ? Number(detail[1]) : undefined, filters), 200, { "Cache-Control": "public, max-age=300" });
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      return json({ error: error instanceof HttpError ? error.message : "Internal server error" }, error instanceof HttpError ? error.status : 500);
    }
  },
};
