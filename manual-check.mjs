import fs from 'node:fs';
const BASE = process.env.API || 'http://localhost:3000';
const H = 'x-api-key';
const STATE = '.manual.json';
const cmd = process.argv[2];
const n = Number(process.argv[3] || 1);

async function api(path, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers[H] = key;
  const r = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

if (cmd === 'setup') {
  const deviceId = 'manual-' + Date.now();
  const dev = await api('/v1/devices', { deviceId, name: deviceId, location: 'lab' });
  const r1 = await api('/v1/rules', {
    name: 'Manual High Heat',
    type: 'threshold',
    metric: 'temperature',
    operator: '>',
    value: 70,
    severity: 'high',
    enabled: true,
    cooldownSeconds: 0
  });
  const r2 = await api('/v1/rules', {
    name: 'Manual Stale',
    type: 'no_report',
    durationSeconds: 30,
    severity: 'medium',
    enabled: true,
    cooldownSeconds: 0
  });
  console.log('Setup statuses (dev, r1, r2):', dev.status, r1.status, r2.status);
  console.log('Rule 1 response:', JSON.stringify(r1.json));
  console.log('Rule 2 response:', JSON.stringify(r2.json));
  fs.writeFileSync(STATE, JSON.stringify({ deviceId, key: dev.json.apiKey, seq: 0 }));
  console.log('Registered deviceId:', deviceId);
} else if (cmd === 'send') {
  if (!fs.existsSync(STATE)) {
    console.error(`State file ${STATE} not found. Run 'node manual-check.mjs setup' first.`);
    process.exit(1);
  }
  const s = JSON.parse(fs.readFileSync(STATE));
  const out = {};
  for (let i = 0; i < n; i++) {
    s.seq++;
    const r = await api(
      '/v1/events',
      {
        eventId: crypto.randomUUID(),
        deviceId: s.deviceId,
        seq: s.seq,
        type: 'reading',
        timestamp: new Date().toISOString(),
        payload: { metric: 'temperature', value: 80 }
      },
      s.key
    );
    out[r.status] = (out[r.status] || 0) + 1;
    await new Promise((res) => setTimeout(res, 150)); // stay under the rate limit
  }
  fs.writeFileSync(STATE, JSON.stringify(s));
  console.log('sent', n, 'events, statuses:', out);
} else {
  console.log("Usage: node manual-check.mjs setup | send [count]");
}
