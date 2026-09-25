#!/usr/bin/env tsx

/** Reproducible measurements for issues #1323, #1325, and #1327. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { isMockNetwork } from "../shared/network-mode.ts";
import { getPharmacyPrices } from "../shared/pharmacy-pricing.ts";
import { Journal } from "../agent/journal.ts";

const iterations = Number(process.env.BENCHMARK_ITERATIONS ?? 100_000);
const journalSizes = [1_000, 10_000, 100_000];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measure(fn: () => void, count: number): { totalMs: number; perCallUs: number } {
  const start = performance.now();
  for (let i = 0; i < count; i++) fn();
  const totalMs = performance.now() - start;
  return { totalMs, perCallUs: (totalMs * 1_000) / count };
}

function benchmarkNetworkMode() {
  const env = { MOCK_NETWORK: "1", NODE_ENV: "test" } as NodeJS.ProcessEnv;
  const samples = Array.from({ length: 5 }, () => measure(() => isMockNetwork(env), iterations));
  return { iterations, medianTotalMs: median(samples.map((sample) => sample.totalMs)), medianPerCallUs: median(samples.map((sample) => sample.perCallUs)) };
}

function benchmarkPricing() {
  const key = ["lisinopril", "90210"] as const;
  const cold = measure(() => getPharmacyPrices(...key), 1);
  const warm = measure(() => getPharmacyPrices(...key), iterations);
  const popularDrugs = ["lisinopril", "metformin", "atorvastatin", "amlodipine"];
  const mixed = measure(() => {
    const drug = popularDrugs[Math.floor(Math.random() * popularDrugs.length)] ?? popularDrugs[0];
    getPharmacyPrices(drug, Math.random() < 0.8 ? "90210" : `long-tail-${Math.random()}`);
  }, iterations);
  return { cold, warm, mixed, cache: { configured: false, ttlMs: null, hitRate: 0 } };
}

function benchmarkJournal(size: number) {
  const directory = mkdtempSync(join(tmpdir(), "careguard-journal-benchmark-"));
  const journal = new Journal({ journalPath: join(directory, "journal.jsonl"), snapshotPath: join(directory, "snapshot.json"), compactionThreshold: size + 1 });
  const append = measure(() => journal.append("update", { value: 1 }), size);
  const replay = measure(() => journal.replay({ count: 0 }, { update: (state, data) => ({ count: state.count + (data as { value: number }).value }) }), 1);
  rmSync(directory, { recursive: true, force: true });
  return { entries: size, append, replay };
}

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), networkMode: benchmarkNetworkMode(), pharmacyPricing: benchmarkPricing(), journal: journalSizes.map(benchmarkJournal) }, null, 2));
