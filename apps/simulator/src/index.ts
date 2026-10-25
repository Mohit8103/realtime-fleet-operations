import { Command } from 'commander';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Persistence files
const KEYS_FILE = path.resolve(process.cwd(), '.simulator-keys.json');
const BUFFER_FILE = path.resolve(process.cwd(), '.simulator-buffer.json');

interface DeviceKeyRecord {
  deviceId: string;
  apiKey: string;
  seq: number;
}
type KeysMap = Record<string, DeviceKeyRecord>;

interface SimulatorEvent {
  eventId: string;
  deviceId: string;
  seq: number | string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
  replayed?: boolean;
}

interface SimulatorStats {
  sent: number;
  accepted: number;
  duplicate: number;
  rejected: number;
  retries: number;
}

type SimulatorState = 'online' | 'offline' | 'replaying';

// Global state
const stats: SimulatorStats = {
  sent: 0,
  accepted: 0,
  duplicate: 0,
  rejected: 0,
  retries: 0
};

let currentState: SimulatorState = 'online';
let buffer: SimulatorEvent[] = [];

// Helper functions for persistence
function loadKeys(): KeysMap {
  try {
    if (fs.existsSync(KEYS_FILE)) {
      return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
    }
  } catch (err: any) {
    console.warn(`[Simulator] Warning loading keys file: ${err.message}`);
  }
  return {};
}

function saveKeys(keys: KeysMap): void {
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn(`[Simulator] Warning saving keys file: ${err.message}`);
  }
}

function loadBuffer(): SimulatorEvent[] {
  try {
    if (fs.existsSync(BUFFER_FILE)) {
      const data = JSON.parse(fs.readFileSync(BUFFER_FILE, 'utf-8'));
      if (Array.isArray(data)) return data;
    }
  } catch (err: any) {
    console.warn(`[Simulator] Warning loading buffer file: ${err.message}`);
  }
  return [];
}

function saveBuffer(buf: SimulatorEvent[]): void {
  try {
    fs.writeFileSync(BUFFER_FILE, JSON.stringify(buf, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn(`[Simulator] Warning saving buffer file: ${err.message}`);
  }
}

function appendToBuffer(event: SimulatorEvent): void {
  buffer.push(event);
  saveBuffer(buffer);
}

function removeDeviceKey(deviceId: string, keys: KeysMap): void {
  delete keys[deviceId];
  saveKeys(keys);
  console.log(`[Simulator] Removed stale key for ${deviceId} from .simulator-keys.json`);
}

// Ensure device is registered and key is valid
async function ensureDevice(
  deviceId: string,
  apiBase: string,
  keys: KeysMap,
  forceRegister = false
): Promise<string> {
  if (forceRegister) {
    removeDeviceKey(deviceId, keys);
  } else if (keys[deviceId]?.apiKey) {
    return keys[deviceId].apiKey;
  }

  const res = await fetch(`${apiBase}/v1/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, name: deviceId, location: 'lab' })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Device registration failed (${res.status}): ${text}`);
  }

  const body: any = await res.json().catch(() => ({}));
  const apiKey = body.apiKey;
  if (!apiKey) {
    throw new Error(`No apiKey returned for device ${deviceId}`);
  }

  keys[deviceId] = {
    deviceId,
    apiKey,
    seq: keys[deviceId]?.seq || 0
  };
  saveKeys(keys);
  console.log(`[Simulator] Successfully registered ${deviceId} in database and saved key`);
  return apiKey;
}

// Dispatch single event with exponential backoff and jitter
async function sendEventWithRetry(
  event: SimulatorEvent,
  deviceId: string,
  keys: KeysMap,
  apiBase: string,
  maxAttempts = 5
): Promise<{ status: 'accepted' | 'duplicate' | 'rejected' | 'failed' }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const apiKey = keys[deviceId]?.apiKey;
    if (!apiKey) {
      await ensureDevice(deviceId, apiBase, keys, true);
    }

    try {
      const res = await fetch(`${apiBase}/v1/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': keys[deviceId]?.apiKey || ''
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000)
      });

      // 202 Accepted
      if (res.status === 202) {
        stats.sent++;
        stats.accepted++;
        return { status: 'accepted' };
      }

      // 200 Duplicate or Success
      if (res.status === 200) {
        const data: any = await res.json().catch(() => ({}));
        stats.sent++;
        if (data.status === 'duplicate') {
          stats.duplicate++;
          return { status: 'duplicate' };
        }
        stats.accepted++;
        return { status: 'accepted' };
      }

      // 400 Bad Request (Validation failure from intentional malformed chaos)
      if (res.status === 400) {
        stats.sent++;
        stats.rejected++;
        return { status: 'rejected' };
      }

      // 401 Unauthorized -> Delete key from .simulator-keys.json, re-register and retry
      if (res.status === 401) {
        stats.retries++;
        console.warn(`[Simulator] 401 Unauthorized for ${deviceId}. Removing key and re-registering...`);
        removeDeviceKey(deviceId, keys);
        await ensureDevice(deviceId, apiBase, keys, true);
        continue;
      }

      // 429 Too Many Requests or 5xx Server Error -> Backoff with jitter
      if (res.status === 429 || res.status >= 500) {
        stats.retries++;
        const retryAfterHeader = res.headers.get('retry-after');
        let delayMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 0;
        if (!delayMs || isNaN(delayMs)) {
          delayMs = Math.min(5000, 250 * Math.pow(2, attempt) + Math.random() * 200);
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      stats.sent++;
      stats.rejected++;
      return { status: 'rejected' };
    } catch {
      // Network error or timeout -> Backoff with jitter
      stats.retries++;
      const delayMs = Math.min(5000, 250 * Math.pow(2, attempt) + Math.random() * 200);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { status: 'failed' };
}

// Replay buffer in batches of 50 via /v1/events/batch
async function replayBatch(
  batch: SimulatorEvent[],
  deviceId: string,
  keys: KeysMap,
  apiBase: string,
  maxAttempts = 5
): Promise<boolean> {
  const payload = {
    events: batch.map((e) => ({ ...e, replayed: true }))
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let apiKey = keys[deviceId]?.apiKey;
    if (!apiKey) {
      apiKey = await ensureDevice(deviceId, apiBase, keys, true);
    }

    try {
      const res = await fetch(`${apiBase}/v1/events/batch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': keys[deviceId]?.apiKey || apiKey
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
      });

      if (res.ok) {
        const body: any = await res.json().catch(() => ({}));
        const summary = body.summary || {};
        stats.sent += summary.total || batch.length;
        stats.accepted += summary.accepted || 0;
        stats.duplicate += summary.duplicate || 0;
        stats.rejected += summary.rejected || 0;
        return true;
      }

      // 401 Unauthorized -> Delete key from .simulator-keys.json and re-register
      if (res.status === 401) {
        stats.retries++;
        console.warn(`[Simulator] Replay batch 401 Unauthorized for ${deviceId}. Removing key and re-registering...`);
        removeDeviceKey(deviceId, keys);
        await ensureDevice(deviceId, apiBase, keys, true);
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        stats.retries++;
        const retryAfterHeader = res.headers.get('retry-after');
        let delayMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 0;
        if (!delayMs || isNaN(delayMs)) {
          delayMs = Math.min(5000, 300 * Math.pow(2, attempt) + Math.random() * 200);
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      return false;
    } catch {
      stats.retries++;
      const delayMs = Math.min(5000, 300 * Math.pow(2, attempt) + Math.random() * 200);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return false;
}

// Drain buffer in order, in chunks of 50
async function drainBuffer(keys: KeysMap, apiBase: string, defaultApiKey: string): Promise<void> {
  if (buffer.length === 0) return;

  currentState = 'replaying';

  while (buffer.length > 0) {
    const chunk = buffer.slice(0, 50);
    const primaryDeviceId = chunk[0].deviceId;

    const ok = await replayBatch(chunk, primaryDeviceId, keys, apiBase);
    if (!ok) {
      // Replay failed; preserve buffer and back off
      break;
    }

    // Server accepted batch -> remove from buffer and persist
    buffer.splice(0, chunk.length);
    saveBuffer(buffer);
  }

  if (buffer.length === 0) {
    currentState = 'online';
  }
}

// Main CLI setup
const program = new Command();

program
  .name('fleet-sim')
  .description('Device Fleet Telemetry Simulator CLI')
  .version('1.0.0')
  .option('-d, --devices <count>', 'Number of simulated IoT devices', '3')
  .option('-r, --rate <rate>', 'Events per second per device', '1')
  .option('-a, --api <url>', 'Ingestion API base URL', 'http://localhost:3000')
  .option('--offline-after <seconds>', 'Seconds after start when devices go offline', '0')
  .option('--offline-for <seconds>', 'Seconds devices stay offline before replaying', '0')
  .option('--duplicate-rate <rate>', 'Probability of resending identical event (0.0 - 1.0)', '0')
  .option('--out-of-order-rate <rate>', 'Probability of swapping nearby events (0.0 - 1.0)', '0')
  .option('--malformed-rate <rate>', 'Probability of sending a broken payload (0.0 - 1.0)', '0')
  .option('--anomaly-rate <rate>', 'Probability of temperature anomaly > 70 (0.0 - 1.0)', '0')
  .option('--anomaly-device <deviceIndex>', 'Device index (1-based) to apply anomaly to (default: all if omitted)', '0')
  .option('--burst <count>', 'Send N events at once at startup', '0')
  .option('--duration <seconds>', 'Stop simulator after N seconds (0 = run indefinitely)', '0')
  .action(async (options) => {
    const deviceCount = Math.max(1, parseInt(options.devices, 10) || 3);
    const rate = Math.max(0.1, parseFloat(options.rate) || 1);
    const apiBase = (options.api || 'http://localhost:3000').replace(/\/$/, '');
    const offlineAfter = Math.max(0, parseInt(options.offlineAfter, 10) || 0);
    const offlineFor = Math.max(0, parseInt(options.offlineFor, 10) || 0);
    const duplicateRate = Math.max(0, parseFloat(options.duplicateRate) || 0);
    const outOfOrderRate = Math.max(0, parseFloat(options.outOfOrderRate) || 0);
    const malformedRate = Math.max(0, parseFloat(options.malformedRate) || 0);
    const anomalyRate = Math.max(0, parseFloat(options.anomalyRate) || 0);
    const anomalyDevice = parseInt(options.anomalyDevice, 10) || 0;
    const burstCount = Math.max(0, parseInt(options.burst, 10) || 0);
    const maxDurationSec = Math.max(0, parseInt(options.duration, 10) || 0);

    console.log('🚀 Initializing Fleet Simulator CLI');
    console.log(`📡 Target API: ${apiBase}`);
    console.log(`📱 Devices: ${deviceCount} | Rate: ${rate} evt/s/dev`);
    if (offlineAfter > 0 && offlineFor > 0) {
      console.log(`🔌 Offline Scenario: Goes offline at ${offlineAfter}s for ${offlineFor}s`);
    }
    if (anomalyRate > 0) {
      console.log(
        `🔥 Anomaly Rate: ${anomalyRate * 100}% on ${anomalyDevice ? `device ${anomalyDevice}` : 'all devices'}`
      );
    }
    if (duplicateRate > 0 || outOfOrderRate > 0 || malformedRate > 0) {
      console.log(
        `🎲 Chaos flags: duplicate=${duplicateRate}, outOfOrder=${outOfOrderRate}, malformed=${malformedRate}`
      );
    }

    // 1. Load keys and existing buffer
    const keys = loadKeys();
    buffer = loadBuffer();
    if (buffer.length > 0) {
      console.log(`📦 Restored ${buffer.length} events from .simulator-buffer.json`);
    }

    // 2. Ensure all simulated devices are registered
    const deviceIds: string[] = [];
    for (let i = 1; i <= deviceCount; i++) {
      const devId = `sim-dev-${i}`;
      deviceIds.push(devId);
      try {
        await ensureDevice(devId, apiBase, keys);
      } catch (err: any) {
        console.error(`❌ Failed to register ${devId}: ${err.message}`);
      }
    }
    console.log(`✅ All ${deviceCount} devices registered and keys cached in .simulator-keys.json\n`);

    // 3. Handle burst if requested
    if (burstCount > 0) {
      console.log(`💥 Sending burst of ${burstCount} events...`);
      const burstChunkSize = 25;
      for (let i = 0; i < burstCount; i += burstChunkSize) {
        const batchPromises: Promise<any>[] = [];
        const limit = Math.min(burstChunkSize, burstCount - i);
        for (let j = 0; j < limit; j++) {
          const devId = deviceIds[(i + j) % deviceIds.length];
          const rec = keys[devId] || { deviceId: devId, apiKey: '', seq: 0 };
          rec.seq = (rec.seq || 0) + 1;
          const burstEvent: SimulatorEvent = {
            eventId: crypto.randomUUID(),
            deviceId: devId,
            seq: rec.seq,
            type: 'reading',
            timestamp: new Date().toISOString(),
            payload: { metric: 'temperature', value: 20 + Math.floor(Math.random() * 10) },
            replayed: false
          };
          batchPromises.push(sendEventWithRetry(burstEvent, devId, keys, apiBase));
        }
        await Promise.all(batchPromises);
      }
      saveKeys(keys);
      console.log(`✅ Burst of ${burstCount} events completed.\n`);
    }

    // 4. Start periodic 5s summary logging
    const summaryTimer = setInterval(() => {
      const timeStr = new Date().toTimeString().split(' ')[0];
      console.log(
        `[${timeStr}] sent: ${stats.sent} | accepted: ${stats.accepted} | duplicate: ${stats.duplicate} | rejected: ${stats.rejected} | buffered: ${buffer.length} | retries: ${stats.retries} | state: ${currentState}`
      );
    }, 5000);

    // Initial log
    console.log(
      `[${new Date().toTimeString().split(' ')[0]}] sent: ${stats.sent} | accepted: ${stats.accepted} | duplicate: ${stats.duplicate} | rejected: ${stats.rejected} | buffered: ${buffer.length} | retries: ${stats.retries} | state: ${currentState}`
    );

    // 5. Simulation Event Loop
    const startTime = Date.now();
    const heldOutOfOrderEvents: Record<string, SimulatorEvent | undefined> = {};
    const lastHeartbeatSent: Record<string, number> = {};

    let isRunning = true;

    // Graceful shutdown
    const cleanup = () => {
      if (!isRunning) return;
      isRunning = false;
      clearInterval(summaryTimer);
      saveKeys(keys);
      saveBuffer(buffer);
      console.log('\n🛑 Simulator stopped.');
      console.log(
        `[Final] sent: ${stats.sent} | accepted: ${stats.accepted} | duplicate: ${stats.duplicate} | rejected: ${stats.rejected} | buffered: ${buffer.length} | retries: ${stats.retries}`
      );
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Drain any leftover buffer from previous run
    if (buffer.length > 0 && deviceIds.length > 0) {
      await drainBuffer(keys, apiBase, keys[deviceIds[0]]?.apiKey || '');
    }

    const intervalMs = Math.max(20, Math.floor(1000 / rate));

    while (isRunning) {
      const elapsedSec = (Date.now() - startTime) / 1000;

      if (maxDurationSec > 0 && elapsedSec >= maxDurationSec) {
        cleanup();
        break;
      }

      // Check offline scenario
      const isOfflineWindow =
        offlineAfter > 0 &&
        offlineFor > 0 &&
        elapsedSec >= offlineAfter &&
        elapsedSec < offlineAfter + offlineFor;

      if (isOfflineWindow) {
        currentState = 'offline';
      } else if (buffer.length > 0) {
        // Draining buffer on reconnect
        await drainBuffer(keys, apiBase, keys[deviceIds[0]]?.apiKey || '');
      } else {
        currentState = 'online';
      }

      const loopStart = Date.now();

      // Generate events for each device concurrently in this tick
      await Promise.all(
        deviceIds.map(async (devId, d) => {
          const rec = keys[devId] || { deviceId: devId, apiKey: '', seq: 0 };
          const now = Date.now();

          // 1. Check Heartbeat (every 10 seconds)
          if (!lastHeartbeatSent[devId] || now - lastHeartbeatSent[devId] >= 10000) {
            lastHeartbeatSent[devId] = now;
            rec.seq = (rec.seq || 0) + 1;
            const heartbeatEvent: SimulatorEvent = {
              eventId: crypto.randomUUID(),
              deviceId: devId,
              seq: rec.seq,
              type: 'heartbeat',
              timestamp: new Date().toISOString(),
              payload: { uptime: Math.floor(elapsedSec), status: 'ok' },
              replayed: false
            };

            if (currentState === 'offline') {
              appendToBuffer(heartbeatEvent);
            } else {
              const res = await sendEventWithRetry(heartbeatEvent, devId, keys, apiBase);
              if (res.status === 'failed') {
                appendToBuffer(heartbeatEvent);
              }
            }
          }

          // 2. Generate Reading Event (Temperature, Humidity, or Battery)
          rec.seq = (rec.seq || 0) + 1;

          const isAnomaly =
            anomalyRate > 0 &&
            Math.random() < anomalyRate &&
            (!anomalyDevice || d === anomalyDevice - 1);

          const metric = isAnomaly
            ? 'temperature'
            : ['temperature', 'humidity', 'battery'][Math.floor(Math.random() * 3)];

          let payload: Record<string, unknown> = {};
          if (isAnomaly) {
            payload = { metric: 'temperature', value: 75 + Math.floor(Math.random() * 15) };
          } else if (metric === 'temperature') {
            payload = { metric: 'temperature', value: 20 + Math.floor(Math.random() * 15) };
          } else if (metric === 'humidity') {
            payload = { metric: 'humidity', value: 40 + Math.floor(Math.random() * 25) };
          } else {
            payload = { metric: 'battery', value: 70 + Math.floor(Math.random() * 30) };
          }

          // Malformed chaos injection
          const isMalformed = malformedRate > 0 && Math.random() < malformedRate;
          const currentEvent: SimulatorEvent = isMalformed
            ? {
                eventId: crypto.randomUUID(),
                deviceId: devId,
                seq: 'invalid-non-number-seq',
                type: 'reading',
                timestamp: 'invalid-timestamp-iso',
                payload: { badData: true },
                replayed: false
              }
            : {
                eventId: crypto.randomUUID(),
                deviceId: devId,
                seq: rec.seq,
                type: 'reading',
                timestamp: new Date().toISOString(),
                payload,
                replayed: false
              };

          // Out-of-order chaos injection
          if (outOfOrderRate > 0 && Math.random() < outOfOrderRate && !heldOutOfOrderEvents[devId]) {
            // Hold this event and send the next one first
            heldOutOfOrderEvents[devId] = currentEvent;
            return;
          }

          const eventsToSend: SimulatorEvent[] = [];
          if (heldOutOfOrderEvents[devId]) {
            // Send current event first, then the previously held event
            eventsToSend.push(currentEvent);
            eventsToSend.push(heldOutOfOrderEvents[devId]!);
            heldOutOfOrderEvents[devId] = undefined;
          } else {
            eventsToSend.push(currentEvent);
          }

          // Duplicate chaos injection
          if (duplicateRate > 0 && Math.random() < duplicateRate) {
            eventsToSend.push(currentEvent);
          }

          // Process the events to send
          for (const evt of eventsToSend) {
            if (currentState === 'offline') {
              appendToBuffer(evt);
            } else {
              const res = await sendEventWithRetry(evt, devId, keys, apiBase);
              if (res.status === 'failed') {
                appendToBuffer(evt);
              }
            }
          }
        })
      );

      saveKeys(keys);

      const loopElapsed = Date.now() - loopStart;
      const sleepTime = Math.max(10, intervalMs - loopElapsed);
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
    }
  });

program.parse(process.argv);
