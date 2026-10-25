import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Activity,
  Radio,
  AlertTriangle,
  Layers,
  Pause,
  Play,
  CheckCircle,
  XCircle,
  ShieldAlert,
  RefreshCw,
  Cpu,
  X
} from 'lucide-react';
import './App.css';

// Types
export interface Stats {
  eventsPerMinute: number;
  devicesByStatus: {
    online: number;
    stale: number;
    offline: number;
    registered: number;
  };
  incidentsBySeverity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  queueDepth: number;
  failedJobs: number;
  duplicatesCount: number;
  rejectedCount: number;
  notifications: {
    pending: number;
    failed: number;
    dead: number;
    sent: number;
  };
  sseClients: number;
}

export interface ActivityItem {
  id: string | number;
  type: string;
  data: any;
  timestamp: string;
}

export interface DeviceItem {
  deviceId: string;
  name: string;
  location: string;
  status: 'online' | 'stale' | 'offline' | 'registered';
  lastSeenAt: string | null;
  lastSeq: number;
  eventCount: number;
  createdAt: string;
}

export interface TelemetryEvent {
  eventId: string;
  deviceId: string;
  seq: number;
  type: string;
  timestamp: string;
  receivedAt?: string;
  payload?: any;
}

export interface IncidentItem {
  _id: string;
  incidentId: string;
  ruleId: string;
  deviceId: string;
  dedupeKey: string;
  state: 'open' | 'acknowledged' | 'resolved';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  occurrenceCount: number;
  createdAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  triggeringEvents?: string[];
  timeline?: Array<{
    action: string;
    timestamp: string;
    operator?: string;
    note?: string;
  }>;
}

export interface IncidentDetail {
  incident: IncidentItem;
  events: TelemetryEvent[];
  ruleEvaluations: Array<{
    _id: string;
    eventId: string;
    ruleId: string;
    ruleName?: string;
    matched: boolean;
    reason: string;
    evaluatedAt: string;
  }>;
}

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  text: string;
}

export const App: React.FC = () => {
  // Navigation
  const [activeTab, setActiveTab] = useState<'overview' | 'devices' | 'events' | 'incidents'>('overview');

  // Connection & Stale State
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'reconnecting' | 'offline'>('reconnecting');
  const [isStale, setIsStale] = useState<boolean>(false);

  // Core Data
  const [stats, setStats] = useState<Stats | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [incidents, setIncidents] = useState<IncidentItem[]>([]);

  // Live Events Feed State
  const [liveEvents, setLiveEvents] = useState<TelemetryEvent[]>([]);
  const [isStreamPaused, setIsStreamPaused] = useState<boolean>(false);
  const [eventSearch, setEventSearch] = useState<string>('');
  const [eventTypeFilter, setEventTypeFilter] = useState<string>('all');
  const seenEventIds = useRef<Set<string>>(new Set());

  // Incident Filters & Selection
  const [incidentStateFilter, setIncidentStateFilter] = useState<string>('all');
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [incidentDetail, setIncidentDetail] = useState<IncidentDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState<boolean>(false);

  // Device Detail Modal
  const [selectedDevice, setSelectedDevice] = useState<DeviceItem | null>(null);
  const [deviceEvents, setDeviceEvents] = useState<TelemetryEvent[]>([]);
  const [isLoadingDeviceEvents, setIsLoadingDeviceEvents] = useState<boolean>(false);
  const [deviceSearch, setDeviceSearch] = useState<string>('');
  const [deviceStatusFilter, setDeviceStatusFilter] = useState<string>('all');

  // Toasts
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = (type: 'success' | 'error' | 'info', text: string) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, type, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  };

  // REST Snapshot Fetchers
  const fetchStats = async () => {
    try {
      const res = await fetch('/v1/stats');
      if (res.ok) setStats(await res.json());
    } catch {}
  };

  const fetchActivity = async () => {
    try {
      const res = await fetch('/v1/activity');
      if (res.ok) {
        const json = await res.json();
        setActivity(json.activity || []);
      }
    } catch {}
  };

  const fetchDevices = async () => {
    try {
      const res = await fetch('/v1/devices');
      if (res.ok) {
        const json = await res.json();
        setDevices(json.devices || []);
      }
    } catch {}
  };

  const fetchIncidents = async () => {
    try {
      const res = await fetch('/v1/incidents?limit=100');
      if (res.ok) {
        const json = await res.json();
        setIncidents(json.incidents || []);
      }
    } catch {}
  };

  const refetchAllSnapshots = async () => {
    await Promise.all([fetchStats(), fetchActivity(), fetchDevices(), fetchIncidents()]);
  };

  // Initial load
  useEffect(() => {
    refetchAllSnapshots();
  }, []);

  // EventSource Live Realtime Connection
  useEffect(() => {
    let es: EventSource | null = null;
    let isCancelled = false;

    const setupSSE = () => {
      try {
        es = new EventSource('/v1/stream');

        es.onopen = () => {
          if (isCancelled) return;
          setConnectionStatus('connected');
          setIsStale(false);
        };

        es.onerror = () => {
          if (isCancelled) return;
          // EventSource will automatically retry with Last-Event-ID header
          setConnectionStatus('reconnecting');
          setIsStale(true);
        };

        // 1. Ingested events
        es.addEventListener('event_ingested', (event: MessageEvent) => {
          try {
            const data: TelemetryEvent = JSON.parse(event.data);
            if (!data || !data.eventId) return;

            // Client-side deduplication
            if (seenEventIds.current.has(data.eventId)) return;
            seenEventIds.current.add(data.eventId);

            // Prepend if not paused and enforce capped 200 rows limit
            setLiveEvents((prev) => {
              if (isStreamPaused) return prev;
              const next = [data, ...prev];
              return next.length > 200 ? next.slice(0, 200) : next;
            });

            // Dynamically update device lastSeen in local state
            setDevices((prev) =>
              prev.map((d) =>
                d.deviceId === data.deviceId
                  ? {
                      ...d,
                      lastSeenAt: data.receivedAt || data.timestamp,
                      lastSeq: Math.max(d.lastSeq, data.seq),
                      eventCount: (d.eventCount || 0) + 1,
                      status: 'online'
                    }
                  : d
              )
            );
          } catch {}
        });

        // 2. Incident Created
        es.addEventListener('incident_created', (event: MessageEvent) => {
          try {
            const incident: IncidentItem = JSON.parse(event.data);
            if (!incident) return;

            setIncidents((prev) => {
              const filtered = prev.filter((i) => i.incidentId !== incident.incidentId && i._id !== incident._id);
              return [incident, ...filtered];
            });

            addToast('info', `Incident Created: ${incident.severity.toUpperCase()} on ${incident.deviceId}`);
            fetchStats();
            fetchActivity();
          } catch {}
        });

        // 3. Incident Updated
        es.addEventListener('incident_updated', (event: MessageEvent) => {
          try {
            const incident: IncidentItem = JSON.parse(event.data);
            if (!incident) return;

            setIncidents((prev) =>
              prev.map((i) => (i.incidentId === incident.incidentId || i._id === incident._id ? incident : i))
            );

            if (selectedIncidentId === incident.incidentId || selectedIncidentId === incident._id) {
              setIncidentDetail((prev) => (prev ? { ...prev, incident } : null));
            }

            fetchStats();
            fetchActivity();
          } catch {}
        });

        // 4. Device status changed
        es.addEventListener('device_status_changed', (event: MessageEvent) => {
          try {
            const change = JSON.parse(event.data);
            if (change?.deviceId && change?.status) {
              setDevices((prev) =>
                prev.map((d) => (d.deviceId === change.deviceId ? { ...d, status: change.status } : d))
              );
            }
            fetchStats();
          } catch {}
        });

        // 5. Stream Log Truncation Resync Signal
        es.addEventListener('resync_required', () => {
          addToast('info', 'Reconnection log truncated: Resyncing fleet snapshot...');
          refetchAllSnapshots();
        });
      } catch {
        setConnectionStatus('offline');
        setIsStale(true);
      }
    };

    setupSSE();

    return () => {
      isCancelled = true;
      if (es) es.close();
    };
  }, [isStreamPaused, selectedIncidentId]);

  // Load Incident Detail
  useEffect(() => {
    if (!selectedIncidentId) {
      setIncidentDetail(null);
      return;
    }

    let isSubscribed = true;
    setIsLoadingDetail(true);

    fetch(`/v1/incidents/${selectedIncidentId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (isSubscribed && data) {
          setIncidentDetail(data);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (isSubscribed) setIsLoadingDetail(false);
      });

    return () => {
      isSubscribed = false;
    };
  }, [selectedIncidentId]);

  // Load Device Recent Events when clicked
  const handleSelectDevice = async (device: DeviceItem) => {
    setSelectedDevice(device);
    setIsLoadingDeviceEvents(true);
    try {
      const res = await fetch(`/v1/devices/${device.deviceId}/events?limit=25`);
      if (res.ok) {
        const json = await res.json();
        setDeviceEvents(json.events || []);
      }
    } catch {
      setDeviceEvents([]);
    } finally {
      setIsLoadingDeviceEvents(false);
    }
  };

  // Optimistic Acknowledge & Resolve Actions
  const handleTransitionIncident = async (action: 'acknowledge' | 'resolve') => {
    if (!incidentDetail?.incident) return;
    const current = incidentDetail.incident;
    const targetState = action === 'acknowledge' ? 'acknowledged' : 'resolved';

    // Store backup for rollback
    const previousIncidents = [...incidents];
    const previousDetail = { ...incidentDetail };

    // 1. Optimistic local state update
    const now = new Date().toISOString();
    const optimisticIncident: IncidentItem = {
      ...current,
      state: targetState,
      ...(action === 'acknowledge' ? { acknowledgedAt: now, acknowledgedBy: 'operator (dashboard)' } : {}),
      ...(action === 'resolve' ? { resolvedAt: now, resolvedBy: 'operator (dashboard)' } : {}),
      timeline: [
        ...(current.timeline || []),
        {
          action: targetState,
          timestamp: now,
          operator: 'operator (dashboard)',
          note: `Incident ${targetState} via web dashboard`
        }
      ]
    };

    setIncidents((prev) =>
      prev.map((i) => (i.incidentId === current.incidentId || i._id === current._id ? optimisticIncident : i))
    );
    setIncidentDetail({
      ...incidentDetail,
      incident: optimisticIncident
    });

    addToast('success', `Optimistically marked incident as ${targetState}`);

    // 2. Perform API request
    try {
      const endpoint = `/v1/incidents/${current.incidentId || current._id}/${action}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operator: 'operator (dashboard)',
          note: `Incident ${targetState} via web dashboard`
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}: Failed to ${action} incident`);
      }

      // Re-fetch detail to sync server timeline
      fetch(`/v1/incidents/${current.incidentId || current._id}`)
        .then((r) => r.json())
        .then((data) => {
          if (data?.incident) setIncidentDetail(data);
        })
        .catch(() => {});
      fetchStats();
    } catch (err: any) {
      // 3. Rollback on failure
      setIncidents(previousIncidents);
      setIncidentDetail(previousDetail);
      addToast('error', `Failed to ${action} incident: ${err.message}. State rolled back.`);
    }
  };

  // Filtered Devices
  const filteredDevices = useMemo(() => {
    return devices.filter((d) => {
      const matchesSearch =
        d.deviceId.toLowerCase().includes(deviceSearch.toLowerCase()) ||
        d.name.toLowerCase().includes(deviceSearch.toLowerCase()) ||
        d.location.toLowerCase().includes(deviceSearch.toLowerCase());
      const matchesStatus = deviceStatusFilter === 'all' || d.status === deviceStatusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [devices, deviceSearch, deviceStatusFilter]);

  // Filtered Live Events
  const filteredEvents = useMemo(() => {
    return liveEvents.filter((e) => {
      const matchesDev = !eventSearch || e.deviceId.toLowerCase().includes(eventSearch.toLowerCase());
      const matchesType = eventTypeFilter === 'all' || e.type.toLowerCase() === eventTypeFilter.toLowerCase();
      return matchesDev && matchesType;
    });
  }, [liveEvents, eventSearch, eventTypeFilter]);

  // Filtered Incidents
  const filteredIncidents = useMemo(() => {
    return incidents.filter((i) => {
      if (incidentStateFilter === 'all') return true;
      return i.state === incidentStateFilter;
    });
  }, [incidents, incidentStateFilter]);

  return (
    <div className="app-wrapper">
      {/* Top Navbar */}
      <header className="navbar">
        <div className="navbar-container">
          <div className="brand-section">
            <div className="brand-logo">
              <div className="logo-badge">⚡</div>
              <span>Fleet Operations</span>
            </div>

            <nav className="nav-tabs">
              <button
                className={`tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
                onClick={() => setActiveTab('overview')}
              >
                <Activity size={16} />
                <span>Overview</span>
              </button>
              <button
                className={`tab-btn ${activeTab === 'devices' ? 'active' : ''}`}
                onClick={() => setActiveTab('devices')}
              >
                <Cpu size={16} />
                <span>Devices</span>
              </button>
              <button
                className={`tab-btn ${activeTab === 'events' ? 'active' : ''}`}
                onClick={() => setActiveTab('events')}
              >
                <Radio size={16} />
                <span>Live Events</span>
              </button>
              <button
                className={`tab-btn ${activeTab === 'incidents' ? 'active' : ''}`}
                onClick={() => setActiveTab('incidents')}
              >
                <AlertTriangle size={16} />
                <span>Incidents</span>
                {stats && stats.incidentsBySeverity && (
                  <span className="badge critical" style={{ padding: '0.1rem 0.35rem', fontSize: '0.65rem' }}>
                    {(stats.incidentsBySeverity.critical || 0) + (stats.incidentsBySeverity.high || 0)}
                  </span>
                )}
              </button>
            </nav>
          </div>

          <div className="navbar-right">
            <button className="btn" onClick={refetchAllSnapshots} title="Refresh all snapshot metrics">
              <RefreshCw size={14} />
              <span>Refresh</span>
            </button>
          </div>
        </div>
      </header>

      {/* Connection State Banner */}
      <div className={`conn-banner ${connectionStatus}`}>
        <div className={`status-dot ${connectionStatus === 'connected' ? 'green' : connectionStatus === 'reconnecting' ? 'amber' : 'red'}`} />
        {connectionStatus === 'connected' && <span>Connected to Realtime SSE Stream (/v1/stream)</span>}
        {connectionStatus === 'reconnecting' && (
          <span>Connection interrupted. Reconnecting with Last-Event-ID... (Showing cached stale data)</span>
        )}
        {connectionStatus === 'offline' && <span>Stream connection offline. Showing last known state.</span>}
      </div>

      {/* Main Content Area */}
      <main className="main-content">
        {/* ==================================================================== */}
        {/* TAB 1: OVERVIEW */}
        {/* ==================================================================== */}
        {activeTab === 'overview' && (
          <div>
            <div className="card-grid">
              {/* Device Status Card */}
              <div className="card">
                <div className="card-title">
                  <span>Device Fleet Status</span>
                  {isStale && <span className="stale-tag">stale</span>}
                </div>
                <div className="card-value">
                  {devices.length || (stats?.devicesByStatus ? Object.values(stats.devicesByStatus).reduce((a, b) => a + b, 0) : 0)}
                </div>
                <div className="badge-row">
                  <span className="badge online">Online: {stats?.devicesByStatus?.online ?? 0}</span>
                  <span className="badge stale">Stale: {stats?.devicesByStatus?.stale ?? 0}</span>
                  <span className="badge offline">Offline: {stats?.devicesByStatus?.offline ?? 0}</span>
                  <span className="badge registered">Reg: {stats?.devicesByStatus?.registered ?? 0}</span>
                </div>
              </div>

              {/* Incidents Card */}
              <div className="card">
                <div className="card-title">
                  <span>Active Incidents</span>
                  {isStale && <span className="stale-tag">stale</span>}
                </div>
                <div className="card-value">
                  {stats?.incidentsBySeverity
                    ? Object.values(stats.incidentsBySeverity).reduce((a, b) => a + b, 0)
                    : 0}
                </div>
                <div className="badge-row">
                  <span className="badge critical">Crit: {stats?.incidentsBySeverity?.critical ?? 0}</span>
                  <span className="badge high">High: {stats?.incidentsBySeverity?.high ?? 0}</span>
                  <span className="badge medium">Med: {stats?.incidentsBySeverity?.medium ?? 0}</span>
                  <span className="badge low">Low: {stats?.incidentsBySeverity?.low ?? 0}</span>
                </div>
              </div>

              {/* Ingestion Velocity */}
              <div className="card">
                <div className="card-title">
                  <span>Ingestion Throughput</span>
                  {isStale && <span className="stale-tag">stale</span>}
                </div>
                <div className="card-value">
                  {stats?.eventsPerMinute ?? 0} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>ev/min</span>
                </div>
                <div className="badge-row">
                  <span className="badge offline">Duplicates: {stats?.duplicatesCount ?? 0}</span>
                  <span className="badge critical">Rejected: {stats?.rejectedCount ?? 0}</span>
                </div>
              </div>

              {/* Ingestion Queue & Dispatcher */}
              <div className="card">
                <div className="card-title">
                  <span>Queue & Notifications</span>
                  {isStale && <span className="stale-tag">stale</span>}
                </div>
                <div className="card-value">
                  {stats?.queueDepth ?? 0} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>queued</span>
                </div>
                <div className="badge-row">
                  <span className="badge online">Sent: {stats?.notifications?.sent ?? 0}</span>
                  <span className="badge stale">Pending: {stats?.notifications?.pending ?? 0}</span>
                  <span className="badge critical">Dead: {stats?.notifications?.dead ?? 0}</span>
                </div>
              </div>
            </div>

            {/* Recent Activity Feed */}
            <div className="card">
              <div className="card-title" style={{ marginBottom: '1rem' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Layers size={16} /> Recent Activity Feed (/v1/activity)
                </span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Bounded 100 recent entries</span>
              </div>

              <div style={{ maxHeight: '420px', overflowY: 'auto' }}>
                {activity.length === 0 ? (
                  <div style={{ color: 'var(--text-dim)', textAlign: 'center', padding: '2rem' }}>
                    No recent activity recorded yet.
                  </div>
                ) : (
                  activity.map((item, idx) => (
                    <div
                      key={item.id || idx}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '0.85rem',
                        padding: '0.65rem 0',
                        borderBottom: '1px solid var(--border-subtle)'
                      }}
                    >
                      <div style={{ marginTop: '0.15rem' }}>
                        {item.type.includes('created') ? (
                          <AlertTriangle size={15} color="#f43f5e" />
                        ) : item.type.includes('updated') || item.type.includes('resolve') ? (
                          <CheckCircle size={15} color="#10b981" />
                        ) : item.type.includes('device') ? (
                          <Cpu size={15} color="#06b6d4" />
                        ) : (
                          <Activity size={15} color="#94a3b8" />
                        )}
                      </div>

                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                            {item.type.replace(/_/g, ' ').toUpperCase()}
                          </span>
                          <span className="mono" style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                            {new Date(item.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                          {item.data?.deviceId && <span>Device: <b>{item.data.deviceId}</b> </span>}
                          {item.data?.incidentId && <span>| Incident: <b>{item.data.incidentId}</b> </span>}
                          {item.data?.severity && (
                            <span className={`badge ${item.data.severity}`} style={{ fontSize: '0.65rem', marginLeft: '0.4rem' }}>
                              {item.data.severity}
                            </span>
                          )}
                          {item.data?.state && <span> State: <b>{item.data.state}</b></span>}
                          {item.data?.error && <span style={{ color: '#f43f5e' }}> | Error: {item.data.error}</span>}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* ==================================================================== */}
        {/* TAB 2: DEVICES */}
        {/* ==================================================================== */}
        {activeTab === 'devices' && (
          <div>
            <div className="filter-bar">
              <input
                type="text"
                className="input-box"
                placeholder="Search device ID, name, location..."
                value={deviceSearch}
                onChange={(e) => setDeviceSearch(e.target.value)}
              />

              <select
                className="select-box"
                value={deviceStatusFilter}
                onChange={(e) => setDeviceStatusFilter(e.target.value)}
              >
                <option value="all">All Statuses</option>
                <option value="online">Online</option>
                <option value="stale">Stale</option>
                <option value="offline">Offline</option>
                <option value="registered">Registered</option>
              </select>

              <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginLeft: 'auto' }}>
                Showing {filteredDevices.length} of {devices.length} devices
              </span>
            </div>

            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Device ID</th>
                    <th>Name</th>
                    <th>Location</th>
                    <th>Last Seen</th>
                    <th>Last Seq</th>
                    <th>Total Events</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDevices.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '2rem' }}>
                        No devices match current filters.
                      </td>
                    </tr>
                  ) : (
                    filteredDevices.map((dev) => (
                      <tr
                        key={dev.deviceId}
                        className="clickable"
                        onClick={() => handleSelectDevice(dev)}
                        title="Click to view recent events for this device"
                      >
                        <td>
                          <span className={`badge ${dev.status}`}>{dev.status}</span>
                        </td>
                        <td className="mono" style={{ fontWeight: 600 }}>{dev.deviceId}</td>
                        <td>{dev.name}</td>
                        <td>{dev.location}</td>
                        <td className="mono" style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                          {dev.lastSeenAt ? new Date(dev.lastSeenAt).toLocaleString() : 'Never'}
                        </td>
                        <td className="mono">{dev.lastSeq}</td>
                        <td>{dev.eventCount || 0}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ==================================================================== */}
        {/* TAB 3: LIVE EVENTS */}
        {/* ==================================================================== */}
        {activeTab === 'events' && (
          <div>
            <div className="filter-bar">
              <button
                className={`btn ${isStreamPaused ? 'btn-success' : ''}`}
                onClick={() => setIsStreamPaused(!isStreamPaused)}
              >
                {isStreamPaused ? <Play size={14} /> : <Pause size={14} />}
                <span>{isStreamPaused ? 'Resume Stream' : 'Pause Stream'}</span>
              </button>

              <input
                type="text"
                className="input-box"
                placeholder="Filter by deviceId..."
                value={eventSearch}
                onChange={(e) => setEventSearch(e.target.value)}
              />

              <select
                className="select-box"
                value={eventTypeFilter}
                onChange={(e) => setEventTypeFilter(e.target.value)}
              >
                <option value="all">All Types</option>
                <option value="telemetry">Telemetry</option>
                <option value="reading">Reading</option>
                <option value="status">Status</option>
              </select>

              <button className="btn" onClick={() => setLiveEvents([])} title="Clear buffer">
                <span>Clear Buffer</span>
              </button>

              <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginLeft: 'auto' }}>
                Buffer: {filteredEvents.length} / 200 events {isStreamPaused ? '(PAUSED)' : '(STREAMING)'}
              </span>
            </div>

            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Seq</th>
                    <th>Device ID</th>
                    <th>Type</th>
                    <th>Timestamp</th>
                    <th>Event ID</th>
                    <th>Payload</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '3rem' }}>
                        {isStreamPaused
                          ? 'Stream is paused. Click Resume Stream to receive live telemetry.'
                          : 'Waiting for live telemetry events from SSE stream...'}
                      </td>
                    </tr>
                  ) : (
                    filteredEvents.map((ev) => (
                      <tr key={ev.eventId}>
                        <td className="mono" style={{ fontWeight: 600 }}>{ev.seq}</td>
                        <td className="mono" style={{ color: 'var(--accent-cyan)' }}>{ev.deviceId}</td>
                        <td>
                          <span className="badge registered" style={{ fontSize: '0.7rem' }}>{ev.type}</span>
                        </td>
                        <td className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {new Date(ev.timestamp).toLocaleTimeString()}
                        </td>
                        <td className="mono" style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                          {ev.eventId.substring(0, 8)}...
                        </td>
                        <td>
                          <div className="code-box" style={{ maxWidth: '400px', maxHeight: '42px', padding: '0.2rem 0.5rem' }}>
                            {JSON.stringify(ev.payload || {})}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ==================================================================== */}
        {/* TAB 4: INCIDENTS */}
        {/* ==================================================================== */}
        {activeTab === 'incidents' && (
          <div>
            <div className="filter-bar">
              <div style={{ display: 'flex', gap: '0.35rem' }}>
                {['all', 'open', 'acknowledged', 'resolved'].map((st) => (
                  <button
                    key={st}
                    className={`btn ${incidentStateFilter === st ? 'btn-primary' : ''}`}
                    onClick={() => setIncidentStateFilter(st)}
                  >
                    <span>{st.toUpperCase()}</span>
                  </button>
                ))}
              </div>

              <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginLeft: 'auto' }}>
                Showing {filteredIncidents.length} incidents
              </span>
            </div>

            <div className="split-view">
              {/* Incidents List */}
              <div style={{ maxHeight: 'calc(100vh - 12rem)', overflowY: 'auto' }}>
                {filteredIncidents.length === 0 ? (
                  <div className="card" style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '2rem' }}>
                    No incidents matching "{incidentStateFilter}".
                  </div>
                ) : (
                  filteredIncidents.map((inc) => {
                    const isSelected = selectedIncidentId === inc.incidentId || selectedIncidentId === inc._id;
                    return (
                      <div
                        key={inc.incidentId || inc._id}
                        className={`incident-card-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => setSelectedIncidentId(inc.incidentId || inc._id)}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                          <span className={`badge ${inc.severity}`}>{inc.severity.toUpperCase()}</span>
                          <span className={`badge ${inc.state}`}>{inc.state.toUpperCase()}</span>
                        </div>

                        <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.2rem' }}>
                          Device: {inc.deviceId}
                        </div>

                        <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginBottom: '0.4rem' }}>
                          DedupeKey: <span className="mono">{inc.dedupeKey}</span>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                          <span>Occurrences: <b>{inc.occurrenceCount}</b></span>
                          <span>{new Date(inc.createdAt).toLocaleString()}</span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Detail Panel */}
              <div className="incident-detail-panel">
                {!selectedIncidentId ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '4rem 1rem' }}>
                    <ShieldAlert size={36} style={{ margin: '0 auto 1rem', opacity: 0.4 }} />
                    <p>Select an incident from the list to view its audit timeline, triggering events, and rule evaluations.</p>
                  </div>
                ) : isLoadingDetail ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '4rem 1rem' }}>
                    <RefreshCw size={24} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 1rem' }} />
                    <p>Loading incident details...</p>
                  </div>
                ) : incidentDetail ? (
                  <div>
                    {/* Header with Action Buttons */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                          <span className={`badge ${incidentDetail.incident.severity}`}>
                            {incidentDetail.incident.severity.toUpperCase()}
                          </span>
                          <span className={`badge ${incidentDetail.incident.state}`}>
                            {incidentDetail.incident.state.toUpperCase()}
                          </span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                            Occurrences: <b>{incidentDetail.incident.occurrenceCount}</b>
                          </span>
                        </div>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>
                          Device: {incidentDetail.incident.deviceId}
                        </h3>
                        <p className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                          ID: {incidentDetail.incident.incidentId || incidentDetail.incident._id}
                        </p>
                      </div>

                      {/* Acknowledge & Resolve Buttons with Optimistic Updates */}
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          className="btn btn-primary"
                          disabled={incidentDetail.incident.state !== 'open'}
                          onClick={() => handleTransitionIncident('acknowledge')}
                        >
                          <CheckCircle size={14} />
                          <span>Acknowledge</span>
                        </button>

                        <button
                          className="btn btn-success"
                          disabled={incidentDetail.incident.state === 'resolved'}
                          onClick={() => handleTransitionIncident('resolve')}
                        >
                          <CheckCircle size={14} />
                          <span>Resolve</span>
                        </button>
                      </div>
                    </div>

                    {/* Timeline */}
                    <div style={{ marginBottom: '1.5rem' }}>
                      <h4 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
                        Audit Timeline
                      </h4>

                      <div className="timeline">
                        {(incidentDetail.incident.timeline || []).map((t, idx) => (
                          <div className="timeline-item" key={idx}>
                            <div className="timeline-dot" />
                            <div className="timeline-content">
                              <div className="timeline-title">{t.action}</div>
                              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                                {t.note || 'No note provided'}
                              </div>
                              <div className="timeline-meta mono">
                                By: {t.operator || 'system'} • {new Date(t.timestamp).toLocaleString()}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Rule Evaluation Reasons */}
                    <div style={{ marginBottom: '1.5rem' }}>
                      <h4 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
                        Rule Evaluation Explanations
                      </h4>

                      {incidentDetail.ruleEvaluations.length === 0 ? (
                        <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>No evaluation records found.</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          {incidentDetail.ruleEvaluations.slice(0, 5).map((ev) => (
                            <div key={ev._id} className="code-box" style={{ fontSize: '0.8rem', padding: '0.5rem 0.75rem' }}>
                              <span style={{ color: '#f59e0b' }}>Rule:</span> {ev.ruleName || ev.ruleId} •{' '}
                              <span style={{ color: '#34d399' }}>Matched:</span> {String(ev.matched)} •{' '}
                              <span style={{ color: '#38bdf8' }}>Reason:</span> {ev.reason}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Associated Triggering Events */}
                    <div>
                      <h4 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
                        Associated Triggering Events ({incidentDetail.events.length})
                      </h4>

                      <div className="table-wrapper">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Seq</th>
                              <th>Event ID</th>
                              <th>Timestamp</th>
                              <th>Payload</th>
                            </tr>
                          </thead>
                          <tbody>
                            {incidentDetail.events.slice(0, 10).map((ev) => (
                              <tr key={ev.eventId}>
                                <td className="mono">{ev.seq}</td>
                                <td className="mono" style={{ fontSize: '0.7rem' }}>{ev.eventId.substring(0, 8)}...</td>
                                <td className="mono" style={{ fontSize: '0.75rem' }}>{new Date(ev.timestamp).toLocaleTimeString()}</td>
                                <td>
                                  <div className="code-box" style={{ padding: '0.15rem 0.4rem', maxHeight: '36px' }}>
                                    {JSON.stringify(ev.payload || {})}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Device Recent Events Modal */}
      {selectedDevice && (
        <div className="modal-overlay" onClick={() => setSelectedDevice(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700 }}>
                  Device Recent Events: {selectedDevice.name}
                </h3>
                <p className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  ID: {selectedDevice.deviceId} • Location: {selectedDevice.location} • Status: {selectedDevice.status}
                </p>
              </div>
              <button className="btn" onClick={() => setSelectedDevice(null)}>
                <X size={16} />
              </button>
            </div>

            {isLoadingDeviceEvents ? (
              <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
                Loading recent device events...
              </div>
            ) : deviceEvents.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
                No events recorded for this device.
              </div>
            ) : (
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Seq</th>
                      <th>Type</th>
                      <th>Event ID</th>
                      <th>Timestamp</th>
                      <th>Payload</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deviceEvents.map((ev) => (
                      <tr key={ev.eventId}>
                        <td className="mono" style={{ fontWeight: 600 }}>{ev.seq}</td>
                        <td><span className="badge registered">{ev.type}</span></td>
                        <td className="mono" style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>{ev.eventId}</td>
                        <td className="mono" style={{ fontSize: '0.78rem' }}>{new Date(ev.timestamp).toLocaleString()}</td>
                        <td>
                          <div className="code-box" style={{ maxHeight: '48px', padding: '0.2rem 0.5rem' }}>
                            {JSON.stringify(ev.payload || {})}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Toast Notifications */}
      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.type}`}>
            {toast.type === 'error' ? (
              <XCircle size={16} />
            ) : toast.type === 'success' ? (
              <CheckCircle size={16} />
            ) : (
              <AlertTriangle size={16} />
            )}
            <span>{toast.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
export default App;
