#!/usr/bin/env node
/**
 * End-to-end tests for bridge/cross-claude-bridge.mjs.
 *
 * Suite A — Cursor persistence (local, always runs):
 *   Spawns server.mjs + bridge locally. Verifies that messages sent while the
 *   bridge is down are delivered after restart via the persisted cursor file.
 *
 * Suite B — Live push (requires CROSS_CLAUDE_API_KEY, skips if absent):
 *   listen_live → REST message → notifications/claude/channel push.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, "bridge", "cross-claude-bridge.mjs");
const serverPath = join(here, "server.mjs");

const KEY = process.env.CROSS_CLAUDE_API_KEY;
const URL_BASE = process.env.CROSS_CLAUDE_URL || "https://cross-claude-mcp-production.up.railway.app";

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else       { failed++; console.log(`  ✗ ${msg}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function startLocalServer(port, tmpDir) {
  const lsof = spawnSync("lsof", ["-ti", `:${port}`], { encoding: "utf-8" });
  if (!lsof.error && lsof.stdout?.trim()) {
    for (const pid of lsof.stdout.trim().split("\n")) spawnSync("kill", ["-9", pid]);
  }
  const { MCP_API_KEY: _omit, DATABASE_URL: _omit2, ...cleanEnv } = process.env;
  const server = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    // MCP_API_KEY must match CROSS_CLAUDE_API_KEY used by the bridge ("local-test")
    env: { ...cleanEnv, PORT: String(port), HOME: tmpDir, MCP_API_KEY: "local-test" },
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server start timeout")), 10000);
    server.stdout.on("data", (data) => {
      if (data.toString().includes("listening on port")) { clearTimeout(timeout); resolve(); }
    });
    server.on("error", reject);
  });
  return server;
}

async function spawnBridgeClient(urlBase, cursorFile) {
  const pushed = [];
  const transport = new StdioClientTransport({
    command: "node",
    args: [bridgePath],
    env: {
      CROSS_CLAUDE_API_KEY: "local-test",
      CROSS_CLAUDE_URL: urlBase,
      BRIDGE_POLL_MS: "1000",
      BRIDGE_CURSOR_FILE: cursorFile,
      PATH: process.env.PATH,
    },
  });
  const client = new Client({ name: "cursor-test", version: "0.0.0" }, { capabilities: {} });
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") pushed.push(n.params);
  };
  await client.connect(transport);
  return { client, pushed };
}

// ─── Suite A: Cursor persistence (local, always runs) ────────────────────────

async function runCursorTest() {
  console.log("=== Suite A: Cursor Persistence (local) ===\n");

  const PORT = 19877;
  const tmpDir = mkdtempSync(join(tmpdir(), "cc-cursor-test-"));
  const cursorFile = join(tmpDir, "cursors.json");
  const channel = "cursor-test";
  let server;

  try {
    server = await startLocalServer(PORT, tmpDir);
    const urlBase = `http://localhost:${PORT}`;

    async function rest(path, opts = {}) {
      const res = await fetch(`${urlBase}${path}`, {
        ...opts,
        headers: { "Authorization": "Bearer local-test", "Content-Type": "application/json", ...opts.headers },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${path}`);
      return res.json();
    }

    await rest("/api/channels", { method: "POST", body: JSON.stringify({ name: channel }) });

    // --- First bridge run ---
    const { client: c1, pushed: pushed1 } = await spawnBridgeClient(urlBase, cursorFile);
    await c1.callTool({ name: "listen_live", arguments: { channel } });

    await rest("/api/messages", {
      method: "POST",
      body: JSON.stringify({ channel, sender: "tester", content: "msg-before-restart", message_type: "message" }),
    });

    for (let i = 0; i < 20 && !pushed1.some(p => p.content?.includes("msg-before-restart")); i++) await sleep(500);
    ok(pushed1.some(p => p.content?.includes("msg-before-restart")), "bridge delivers message before restart");

    try { await c1.close(); } catch { /* ignore */ }
    await sleep(400);

    ok(existsSync(cursorFile), "cursor file written after first poll");
    const savedState = JSON.parse(readFileSync(cursorFile, "utf8"));
    ok(typeof savedState[channel] === "number", `cursor file has numeric cursor for #${channel}`);

    // --- Messages sent while bridge is down ---
    await rest("/api/messages", {
      method: "POST",
      body: JSON.stringify({ channel, sender: "tester", content: "msg-downtime-1", message_type: "message" }),
    });
    await rest("/api/messages", {
      method: "POST",
      body: JSON.stringify({ channel, sender: "tester", content: "msg-downtime-2", message_type: "message" }),
    });

    // --- Second bridge run (same cursor file) ---
    const { client: c2, pushed: pushed2 } = await spawnBridgeClient(urlBase, cursorFile);
    await c2.callTool({ name: "listen_live", arguments: { channel } });

    for (let i = 0; i < 30 && pushed2.filter(p => p.content?.includes("msg-downtime")).length < 2; i++) await sleep(500);
    ok(pushed2.some(p => p.content?.includes("msg-downtime-1")), "bridge delivers msg-downtime-1 after restart");
    ok(pushed2.some(p => p.content?.includes("msg-downtime-2")), "bridge delivers msg-downtime-2 after restart");

    try { await c2.close(); } catch { /* ignore */ }

  } catch (err) {
    failed++;
    console.error(`  ERROR in cursor test: ${err.message}\n${err.stack}`);
  } finally {
    if (server) server.kill("SIGKILL");
    await sleep(300);
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Suite B: Live push via external server (skips if no key) ────────────────

async function runLivePushTest() {
  if (!KEY) {
    console.log("\n=== Suite B: Live Push (skipped — CROSS_CLAUDE_API_KEY not set) ===\n");
    return;
  }
  console.log("\n=== Suite B: Live Push (external server) ===\n");

  const channel = `bridge-test-${Math.random().toString(36).slice(2, 8)}`;
  const sender  = `bridge-tester-${Math.random().toString(36).slice(2, 6)}`;

  async function rest(path, opts = {}) {
    const res = await fetch(`${URL_BASE}${path}`, {
      ...opts,
      headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json", ...opts.headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
    return res.json();
  }

  const pushed = [];
  const transport = new StdioClientTransport({
    command: "node",
    args: [bridgePath],
    env: { CROSS_CLAUDE_API_KEY: KEY, CROSS_CLAUDE_URL: URL_BASE, BRIDGE_POLL_MS: "2000", PATH: process.env.PATH },
  });
  const client = new Client({ name: "bridge-test", version: "0.0.0" }, { capabilities: {} });
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") pushed.push(n.params);
  };

  try {
    await client.connect(transport);

    const tools = (await client.listTools()).tools.map((t) => t.name);
    ok(
      tools.includes("listen_live") && tools.includes("stop_listening") && tools.includes("delivery_status"),
      `bridge exposes listen_live / stop_listening / delivery_status (got: ${tools.join(", ")})`
    );

    const s0 = await client.callTool({ name: "delivery_status", arguments: {} });
    ok(/no channels are live-pushing/i.test(s0.content[0].text), "delivery_status idle before listen_live");

    const r1 = await client.callTool({ name: "listen_live", arguments: { channel } });
    ok(/Live push ON/i.test(r1.content[0].text), `listen_live turns on push for #${channel}`);

    const s1 = await client.callTool({ name: "delivery_status", arguments: {} });
    ok(s1.content[0].text.includes(`#${channel}`) && /live push ON/i.test(s1.content[0].text),
      "delivery_status lists the live channel");

    const body = `hello-${Math.random().toString(36).slice(2, 8)}`;
    await rest("/api/messages", {
      method: "POST",
      body: JSON.stringify({ channel, sender, content: body, message_type: "message" }),
    });

    for (let i = 0; i < 16 && !pushed.some((p) => p.content?.includes(body)); i++) await sleep(500);
    ok(
      pushed.some((p) => p.content?.includes(body) && p.meta?.channel === channel),
      `REST message delivered as notifications/claude/channel push (${pushed.length} push(es))`
    );

    const r2 = await client.callTool({ name: "stop_listening", arguments: { channel } });
    ok(/Live push OFF/i.test(r2.content[0].text), "stop_listening turns off push");

    const s2 = await client.callTool({ name: "delivery_status", arguments: {} });
    ok(/no channels are live-pushing/i.test(s2.content[0].text), "delivery_status idle after stop_listening");

  } catch (err) {
    failed++;
    console.error(`  ERROR: ${err.message}\n${err.stack}`);
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await runCursorTest();
  await runLivePushTest();

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Bridge tests — passed: ${passed}, failed: ${failed}`);
  console.log(`${"=".repeat(50)}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
