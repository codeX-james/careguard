/**
 * Benchmark: cumulative overhead of the security middleware chain (#1313)
 *
 * Rebuilds the unified server's global middleware chain from server.ts one
 * layer at a time and measures real HTTP latency/throughput for each stage:
 *
 *   0 baseline      bare express + route handler
 *   1 rate-limit    + express-rate-limit (agent + default policies)
 *   2 helmet        + applySecurityMiddleware (shared/security-middleware.ts)
 *   3 cors          + createCorsMiddleware (shared/cors.ts)
 *   4 json          + path-selected express.json body parser
 *   5 lifecycle     + requestLifecycleMiddleware (request id, ALS, pino log line)
 *   6 api-key       + requireApiKey on /agent (full chain)
 *
 * Each stage runs in its own child process (so the load generator doesn't
 * share an event loop with the server) and is driven over keep-alive HTTP at
 * several concurrency levels. The per-middleware cost is the delta between
 * consecutive stages.
 *
 * Notes:
 * - Rate limiters use the real createRateLimiter() with a very high max so
 *   the benchmark measures the counting cost, not 429 responses.
 * - Sentry is omitted: initSentry() returns a no-op unless SENTRY_DSN is set.
 * - Servers run with NODE_ENV=production so logging is plain JSON pino
 *   (no pino-pretty worker) and helmet sends HSTS, as in production. Log
 *   output goes to /dev/null.
 *
 * Run: node --import tsx benchmarks/security-middleware-overhead.ts
 *      REQUESTS=5000 CONCURRENCY=1,10,50 ROUNDS=3 node --import tsx benchmarks/security-middleware-overhead.ts
 */

import http from "node:http";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import type { AddressInfo } from "node:net";

const STAGES = [
  "baseline",
  "rate-limit",
  "helmet",
  "cors",
  "json",
  "lifecycle",
  "api-key",
] as const;
type Stage = (typeof STAGES)[number];

const API_KEY = "bench-api-key-0123456789abcdef";
const REQUESTS = Number(process.env.REQUESTS ?? 4000);
const WARMUP = Math.min(500, Math.floor(REQUESTS / 4));
const CONCURRENCY = (process.env.CONCURRENCY ?? "1,10,50")
  .split(",")
  .map(Number);
// Each cell is measured ROUNDS times; the round with the median mean latency is reported.
const ROUNDS = Number(process.env.ROUNDS ?? 3);

// ─── Server side (child process) ─────────────────────────────────────────────

async function serve(stage: Stage): Promise<void> {
  const { default: express } = await import("express");
  const level = STAGES.indexOf(stage);
  const app = express();

  if (level >= 1) {
    const { createRateLimiter } = await import("../shared/rate-limit.ts");
    app.use("/agent", createRateLimiter("agent", 1e9));
    app.use(createRateLimiter("default", 1e9));
  }
  if (level >= 2) {
    const { applySecurityMiddleware } =
      await import("../shared/security-middleware.ts");
    applySecurityMiddleware(app);
  }
  if (level >= 3) {
    const { createCorsMiddleware } = await import("../shared/cors.ts");
    app.use(createCorsMiddleware());
  }
  if (level >= 4) {
    const small = express.json({ limit: "20kb" });
    const large = express.json({ limit: "256kb" });
    app.use((req, res, next) =>
      (req.path.startsWith("/bill/audit") ? large : small)(req, res, next),
    );
  }
  if (level >= 5) {
    const { requestLifecycleMiddleware } =
      await import("../shared/request-lifecycle.ts");
    app.use(requestLifecycleMiddleware());
  }
  if (level >= 6) {
    const { requireApiKey } = await import("../shared/auth.ts");
    app.use("/agent", requireApiKey);
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.post("/agent/echo", (req, res) => {
    res.json({
      ok: true,
      n: Array.isArray(req.body?.meds) ? req.body.meds.length : 0,
    });
  });

  const server = app.listen(0, "127.0.0.1", () => {
    process.send!({ port: (server.address() as AddressInfo).port });
  });
}

// ─── Client side (parent process) ────────────────────────────────────────────

interface Target {
  name: string;
  method: "GET" | "POST";
  path: string;
  body?: string;
}

const TARGETS: Target[] = [
  { name: "GET /health", method: "GET", path: "/health" },
  {
    name: "POST /agent/echo",
    method: "POST",
    path: "/agent/echo",
    body: JSON.stringify({
      meds: ["Lisinopril", "Metformin", "Atorvastatin", "Amlodipine"],
    }),
  },
];

interface Result {
  stage: Stage;
  target: string;
  concurrency: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function request(agent: http.Agent, port: number, t: Target): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      origin: "http://localhost:3000",
      authorization: `Bearer ${API_KEY}`,
    };
    if (t.body) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(t.body));
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: t.method,
        path: t.path,
        agent,
        headers,
      },
      (res) => {
        if (res.statusCode !== 200)
          reject(new Error(`${t.path} -> ${res.statusCode}`));
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.end(t.body);
  });
}

async function drive(
  port: number,
  t: Target,
  concurrency: number,
  total: number,
): Promise<number[] & { wallMs?: number }> {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const latencies: number[] = [];
  let issued = 0;
  const start = performance.now();
  async function worker() {
    while (issued < total) {
      issued++;
      const t0 = performance.now();
      await request(agent, port, t);
      latencies.push(performance.now() - t0);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = performance.now() - start;
  agent.destroy();
  return Object.assign(latencies, { wallMs });
}

function startServer(
  stage: Stage,
): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ["--serve", stage], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        AGENT_API_KEY: API_KEY,
        DASHBOARD_ORIGIN: "http://localhost:3000",
      },
    });
    child.once("message", (m: any) => resolve({ child, port: m.port }));
    child.once("error", reject);
    child.once(
      "exit",
      (code) =>
        code && reject(new Error(`${stage} server exited with ${code}`)),
    );
  });
}

async function main(): Promise<void> {
  const results: Result[] = [];

  for (const stage of STAGES) {
    const { child, port } = await startServer(stage);
    try {
      for (const t of TARGETS) {
        await drive(port, t, 1, WARMUP);
        for (const c of CONCURRENCY) {
          const rounds: Result[] = [];
          for (let r = 0; r < ROUNDS; r++) {
            const lat = await drive(port, t, c, REQUESTS);
            const sorted = [...lat].sort((a, b) => a - b);
            rounds.push({
              stage,
              target: t.name,
              concurrency: c,
              rps: Math.round((REQUESTS / lat.wallMs!) * 1000),
              p50: percentile(sorted, 50),
              p95: percentile(sorted, 95),
              p99: percentile(sorted, 99),
              mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
            });
          }
          rounds.sort((a, b) => a.mean - b.mean);
          results.push(rounds[Math.floor(rounds.length / 2)]!);
        }
      }
    } finally {
      child.kill();
    }
  }

  const f = (ms: number) => ms.toFixed(3);
  console.log(
    `\nSecurity middleware chain overhead (#1313) — ${REQUESTS} requests per cell, median of ${ROUNDS} rounds, node ${process.version}\n`,
  );
  for (const t of TARGETS) {
    for (const c of CONCURRENCY) {
      console.log(`${t.name} @ concurrency ${c}`);
      console.log(
        "| stage | rps | mean ms | p50 ms | p95 ms | p99 ms | Δ mean vs prev stage (ms) | Δ mean vs baseline (ms) |",
      );
      console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
      const rows = results.filter(
        (r) => r.target === t.name && r.concurrency === c,
      );
      rows.forEach((r, i) => {
        const prev = i === 0 ? r.mean : rows[i - 1]!.mean;
        console.log(
          `| ${r.stage} | ${r.rps} | ${f(r.mean)} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${i === 0 ? "—" : f(r.mean - prev)} | ${i === 0 ? "—" : f(r.mean - rows[0]!.mean)} |`,
        );
      });
      console.log();
    }
  }
}

const serveIdx = process.argv.indexOf("--serve");
if (serveIdx !== -1) {
  await serve(process.argv[serveIdx + 1] as Stage);
} else {
  await main();
}
