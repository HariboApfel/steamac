import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker, { validate } from "../src/index.js";

export function sample(overrides = {}) {
  return {
    v: 1, sid: crypto.randomUUID(), install: crypto.randomUUID(), launcher: "1.9.2", appid: 1091500, game: "Cyberpunk 2077",
    mac: { model: "Mac15,9", chip: "Apple M3 Max", pcores: 12, cores: 16, gpu_cores: 40, ram_gb: 64, macos: "26.1" },
    vm: { cpus: 10, mem_mib: 24576, driver: "kosmickrisp", wmtr: false, hz: 60, steamos: "20251001.1" },
    launched: true, end: "exit", run_s: 1832, play_s: 1700, first_window_s: 12, proton: "10.0-104", res: "1920x1080",
    fps: { avg: 54.3, p50: 59.9, low1: 31.2, hitches_per_min: 1.2 },
    mem: { game_mib: 5400, guest_mib: 9800, host_mib: 14200 }, ...overrides,
  };
}
let host = 0;
async function request(path, body, options = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://case${host}.example${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    ...options,
  }), options.bindings || { ...env, POST_LIMITER: { limit: async () => ({ success: true }) } }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  host++;
  // Delete ratings before resetting the quota because clearing is itself a write.
  await env.DB.prepare("DELETE FROM daily_usage").run();
  await env.DB.prepare("DELETE FROM ratings").run();
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("DELETE FROM daily_usage").run();
  await env.DB.prepare("DELETE FROM game_names").run();
});

describe("schema validation", () => {
  it("accepts schema v1 and ignores unknown fields", () => {
    const row = validate(sample({ extra: { ignored: true } }));
    expect(row.appid).toBe(1091500);
    expect(row).not.toHaveProperty("extra");
  });
  it.each([
    ["schema", (b) => { b.v = 2; }], ["UUID", (b) => { b.sid = "bad"; }],
    ["appid zero", (b) => { b.appid = 0; }], ["appid overflow", (b) => { b.appid = 4294967296; }],
    ["boolean type", (b) => { b.launched = 1; }], ["driver", (b) => { b.vm.driver = "other"; }],
    ["end", (b) => { b.end = "crash"; }], ["duration", (b) => { b.run_s = 604801; }],
    ["play duration", (b) => { b.play_s = b.run_s + 1; }], ["FPS", (b) => { b.fps.avg = 1001; }],
    ["negative memory", (b) => { b.mem.host_mib = -1; }], ["control text", (b) => { b.game = "bad\nname"; }],
    ["long name", (b) => { b.game = "x".repeat(129); }], ["null optional", (b) => { b.proton = null; }],
    ["resolution", (b) => { b.res = "0x1080"; }], ["fractional cores", (b) => { b.mac.cores = 1.5; }],
  ])("rejects invalid %s", async (_name, mutate) => {
    const body = sample(); mutate(body);
    expect((await request("/v1/sessions", body)).status).toBe(400);
  });
  it("allows missing measurements and rejects malformed JSON and large bodies", async () => {
    const body = sample(); delete body.fps; delete body.mem; delete body.first_window_s;
    expect((await request("/v1/sessions", body)).status).toBe(201);
    expect((await request("/v1/sessions", "{")).status).toBe(400);
    expect((await request("/v1/sessions", " ".repeat(8193))).status).toBe(413);
    expect((await request("/v1/ratings", " ".repeat(4097))).status).toBe(413);
  });
});
it("stores a session exactly once, normalizing UUID case", async () => {
  const body = sample();
  expect((await request("/v1/sessions", body)).status).toBe(201);
  body.sid = body.sid.toUpperCase();
  expect((await request("/v1/sessions", body)).status).toBe(200);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM sessions").first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT requests FROM daily_usage").first("requests")).toBe(1);
});
it("enforces the IP limiter", async () => {
  const bindings = { ...env, POST_LIMITER: { limit: async () => ({ success: false }) } };
  expect((await request("/v1/sessions", sample(), { bindings })).status).toBe(429);
});
it("enforces a shared atomic SQL daily quota for sessions and ratings", async () => {
  const body = sample();
  await env.DB.prepare("INSERT INTO daily_usage VALUES (?, date('now'), 199)").bind(body.install).run();
  const rating = { ...body, rating: "well" };
  expect((await request("/v1/ratings", rating)).status).toBe(200);
  expect((await request("/v1/sessions", body)).status).toBe(429);
  expect((await request("/v1/ratings", { ...rating, rating: "issues" })).status).toBe(429);
  expect((await request("/v1/ratings", { ...rating, rating: "none" })).status).toBe(429);
  expect(await env.DB.prepare("SELECT rating FROM ratings").first("rating")).toBe("well");
  expect(await env.DB.prepare("SELECT count(*) AS n FROM sessions").first("n")).toBe(0);
});
it("upserts ratings per installation/game, clears them and validates reduced VM fields", async () => {
  const rating = { ...sample(), rating: "well", vm: { driver: "moltenvk", wmtr: true } };
  expect((await request("/v1/ratings", rating)).status).toBe(200);
  expect((await request("/v1/ratings", { ...rating, rating: "issues" })).status).toBe(200);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM ratings").first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT requests FROM daily_usage").first("requests")).toBe(2);
  expect((await request("/v1/ratings", { ...rating, rating: null })).status).toBe(400);
  expect((await request("/v1/ratings", { ...rating, rating: "bad" })).status).toBe(400);
  expect((await request("/v1/ratings", { ...rating, rating: "none" })).status).toBe(200);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM ratings").first("n")).toBe(0);
});
it("computes exact medians, launch and early-exit rates, config ratings and anonymous recent rows", async () => {
  const install = crypto.randomUUID();
  for (const [index, fps] of [20, 40, 60, 80].entries()) {
    const b = sample({ install: index < 2 ? install : crypto.randomUUID(), launched: index !== 3, run_s: index === 0 ? 30 : 100, play_s: index === 0 ? 20 : 90, first_window_s: 1, fps: { avg: fps, p50: fps, low1: fps / 2, hitches_per_min: 0 } });
    expect((await request("/v1/sessions", b)).status).toBe(201);
  }
  const missing = sample({ run_s: 100, play_s: 10 }); delete missing.fps;
  expect((await request("/v1/sessions", missing)).status).toBe(201);
  expect((await request("/v1/ratings", { ...sample({ install }), rating: "well" })).status).toBe(200);
  expect((await request("/v1/ratings", { ...sample(), rating: "no_start", mac: { ...sample().mac, chip: "Apple M4" } })).status).toBe(200);
  const listResponse = await request("/v1/games"), list = await listResponse.json();
  expect(listResponse.headers.get("Cache-Control")).toContain("300");
  expect(list.games[0]).toMatchObject({ sessions: 5, installs: 4, launch_rate: 0.8, fps_avg_median: 50, ratings: { well: 1, issues: 0, unplayable: 0, no_start: 1 } });
  const response = await request("/v1/games/1091500"), game = await response.json();
  expect(game.configs.find((c) => c.chip === "Apple M3 Max")).toMatchObject({ early_exit_rate: 0.25, fps_avg_median: 50, fps_low1_median: 25, ratings: { well: 1 } });
  expect(game.configs.find((c) => c.chip === "Apple M4")).toMatchObject({ sessions: 0, ratings: { no_start: 1 } });
  expect(game.recent).toHaveLength(5);
  expect(game.recent[0]).not.toHaveProperty("sid"); expect(game.recent[0]).not.toHaveProperty("install");
  expect(game.recent[0].mac.chip).toBe("Apple M3 Max");
  expect(game.play_hours).toBeCloseTo(300 / 3600);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
});
it("supports rating-only games and JSON routing errors", async () => {
  expect((await request("/v1/ratings", { ...sample(), rating: "well" })).status).toBe(200);
  expect((await (await request("/v1/games")).json()).games[0]).toMatchObject({ sessions: 0, ratings: { well: 1 } });
  expect((await request("/v1/games/1234")).status).toBe(404);
  expect((await request("/unknown")).status).toBe(404);
  expect((await request("/v1/games", {}, { method: "POST" })).status).toBe(405);
  const options = await request("/v1/sessions", undefined, { method: "OPTIONS" });
  expect(options.status).toBe(200); expect(options.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
});

it("accepts omitted optional metadata on sessions and ratings and omits unknown recent fields", async () => {
  const body = sample();
  delete body.game; delete body.mac.pcores; delete body.mac.gpu_cores; delete body.vm.steamos;
  expect((await request("/v1/sessions", body)).status).toBe(201);
  expect(await env.DB.prepare("SELECT game, mac_pcores, mac_gpu_cores, vm_steamos FROM sessions").first()).toEqual({
    game: null, mac_pcores: null, mac_gpu_cores: null, vm_steamos: null,
  });
  const rating = { ...body, rating: "issues", vm: { driver: body.vm.driver, wmtr: body.vm.wmtr } };
  expect((await request("/v1/ratings", rating)).status).toBe(200);
  const game = await (await request(`/v1/games/${body.appid}`)).json();
  expect(game).toMatchObject({ game: null, sessions: 1, ratings: { issues: 1 } });
  expect(game.configs[0]).toMatchObject({ game: null, sessions: 1, ratings: { issues: 1 } });
  expect(game.recent[0]).not.toHaveProperty("game");
  expect(game.recent[0].mac).not.toHaveProperty("pcores");
  expect(game.recent[0].mac).not.toHaveProperty("gpu_cores");
  expect(game.recent[0].vm).not.toHaveProperty("steamos");
  const list = await (await request("/v1/games")).json();
  expect(list.games[0]).toMatchObject({ game: null, sessions: 1 });
});
it("retains the latest known app name across unnamed sessions, rating replacement and clearing", async () => {
  const body = sample({ game: "First name" });
  expect((await request("/v1/sessions", body)).status).toBe(201);
  const unnamed = sample(); delete unnamed.game;
  expect((await request("/v1/sessions", unnamed)).status).toBe(201);
  expect(await env.DB.prepare("SELECT game FROM game_names WHERE appid = ?").bind(body.appid).first("game")).toBe("First name");
  const rating = { ...sample(), game: "Latest name", rating: "well" };
  expect((await request("/v1/ratings", rating)).status).toBe(200);
  delete rating.game;
  expect((await request("/v1/ratings", { ...rating, rating: "issues" })).status).toBe(200);
  expect((await request("/v1/ratings", { ...rating, rating: "none" })).status).toBe(200);
  const list = await (await request("/v1/games")).json();
  expect(list.games[0].game).toBe("Latest name");
  const game = await (await request(`/v1/games/${body.appid}`)).json();
  expect(game.game).toBe("Latest name");
  expect(game.configs[0].game).toBe("Latest name");
});
it.each(["game", "pcores", "gpu_cores", "steamos"])("rejects explicit null for optional %s", async (key) => {
  const body = sample();
  if (key === "game") body.game = null;
  else if (key === "steamos") body.vm.steamos = null;
  else body.mac[key] = null;
  expect((await request("/v1/sessions", body)).status).toBe(400);
  expect((await request("/v1/ratings", { ...body, rating: "well" })).status).toBe(400);
});
