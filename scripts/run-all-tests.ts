import { spawn } from 'node:child_process';

interface Suite {
  name: string;
  command: string;
  args: string[];
}

const suites: Suite[] = [
  {
    name: 'Unit Tests (API & Worker health/readiness)',
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['vitest', 'run']
  },
  {
    name: 'Phase 1 Acceptance Suite (Ingestion, Deduplication, Rejection, Backpressure)',
    command: 'node',
    args: ['test-acceptance.mjs']
  },
  {
    name: 'Phase 2 Acceptance Suite (Rules Engine, Explainability, Sweeper, Replay Isolation)',
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['tsx', 'test-phase2.mjs']
  },
  {
    name: 'Phase 3 Acceptance Suite (Incident Dedupe, Concurrency, Outbox Atomicity, Notifier Resilience)',
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['tsx', 'test-phase3.mjs']
  },
  {
    name: 'Phase 4 Acceptance Suite (Realtime SSE, Last-Event-ID, Multi-Instance Fan-Out, Status APIs)',
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['tsx', 'test-phase4.mjs']
  }
];

async function runSuite(suite: Suite): Promise<{ name: string; durationMs: number; success: boolean }> {
  console.log(`\n================================================================================`);
  console.log(`▶️ RUNNING SUITE: ${suite.name}`);
  console.log(`  Command: ${suite.command} ${suite.args.join(' ')}`);
  console.log(`================================================================================\n`);

  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(suite.command, suite.args, {
      stdio: 'inherit',
      shell: true,
      cwd: process.cwd()
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - start;
      const success = code === 0;
      if (success) {
        console.log(`\n✅ SUITE PASSED [${(durationMs / 1000).toFixed(2)}s]: ${suite.name}`);
      } else {
        console.error(`\n❌ SUITE FAILED (exit code ${code}) [${(durationMs / 1000).toFixed(2)}s]: ${suite.name}`);
      }
      resolve({ name: suite.name, durationMs, success });
    });

    child.on('error', (err) => {
      const durationMs = Date.now() - start;
      console.error(`\n❌ SUITE ERROR: ${err.message}`);
      resolve({ name: suite.name, durationMs, success: false });
    });
  });
}

async function main() {
  console.log('🚀 Consolidated Test Runner Starting...');
  const overallStart = Date.now();
  const results: Array<{ name: string; durationMs: number; success: boolean }> = [];

  for (const suite of suites) {
    const res = await runSuite(suite);
    results.push(res);
    if (!res.success) {
      console.error(`\n💥 Consolidated test run aborted due to failure in: ${suite.name}`);
      process.exit(1);
    }
  }

  const totalTime = ((Date.now() - overallStart) / 1000).toFixed(2);
  console.log(`\n================================================================================`);
  console.log(`🏆 ALL ${results.length} TEST SUITES PASSED SUCCESSFULLY IN ${totalTime}s`);
  console.log(`================================================================================`);
  results.forEach((r, idx) => {
    console.log(`  ${idx + 1}. [PASS] ${(r.durationMs / 1000).toFixed(2)}s - ${r.name}`);
  });
  console.log(`================================================================================\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
