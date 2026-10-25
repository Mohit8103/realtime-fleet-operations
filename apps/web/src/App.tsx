import React, { useState, useEffect } from 'react';
import './App.css';

interface ServiceStatus {
  name: string;
  role: string;
  port: string;
  endpoint: string;
  status: 'healthy' | 'checking' | 'offline';
}

export const App: React.FC = () => {
  const [currentTime, setCurrentTime] = useState<string>(new Date().toISOString());
  const [apiHealth, setApiHealth] = useState<'healthy' | 'offline' | 'checking'>('checking');

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date().toISOString());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    // Probe API health from web app
    const checkApi = async () => {
      try {
        const res = await fetch('http://localhost:3000/healthz');
        if (res.ok) {
          setApiHealth('healthy');
        } else {
          setApiHealth('offline');
        }
      } catch {
        setApiHealth('offline');
      }
    };

    checkApi();
    const interval = setInterval(checkApi, 5000);
    return () => clearInterval(interval);
  }, []);

  const services: ServiceStatus[] = [
    {
      name: 'API Gateway',
      role: 'HTTP Ingestion, REST, & SSE Live Stream',
      port: '3000',
      endpoint: '/healthz',
      status: apiHealth
    },
    {
      name: 'Worker Engine',
      role: 'BullMQ Consumers, Stale Detector & Dispatcher',
      port: '3001',
      endpoint: '/healthz',
      status: 'healthy'
    },
    {
      name: 'MongoDB 7.0',
      role: 'Device Documents & Incident Log Store',
      port: '27017',
      endpoint: 'db.ping()',
      status: 'healthy'
    },
    {
      name: 'Redis 7.2',
      role: 'BullMQ Queue & Heartbeat Cache',
      port: '6379',
      endpoint: 'PING PONG',
      status: 'healthy'
    }
  ];

  return (
    <div className="app-container">
      <header className="header">
        <div className="brand">
          <div className="brand-icon">FL</div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="brand-title">Fleet Ops Platform</span>
              <span className="brand-badge">Mission Control</span>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Real-Time Device Telemetry & Incident Orchestration
            </p>
          </div>
        </div>

        <div className="header-right">
          <div className="status-pill">
            <span className="status-dot"></span>
            <span>Platform Core Online</span>
          </div>
          <div className="mono" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            UTC: {currentTime.split('T')[1].replace('Z', '')}
          </div>
        </div>
      </header>

      <section className="banner">
        <h2>Cluster Foundation Initialized</h2>
        <p>
          Monorepo scaffolded with Node.js Express API, BullMQ Background Worker,
          React/Vite Operations Dashboard, Pino Structured Logging with Correlation IDs,
          and Docker Compose orchestration.
        </p>
      </section>

      <h3 style={{ fontSize: '1.1rem', marginBottom: '1rem', fontWeight: 600 }}>
        Cluster Topology & Health Checks
      </h3>

      <div className="services-grid">
        {services.map((svc) => (
          <div key={svc.name} className="service-card">
            <div className="service-card-top">
              <span className="service-name">{svc.name}</span>
              <span
                style={{
                  fontSize: '0.75rem',
                  padding: '0.2rem 0.5rem',
                  borderRadius: '4px',
                  backgroundColor:
                    svc.status === 'healthy'
                      ? 'rgba(16, 185, 129, 0.15)'
                      : 'rgba(244, 63, 94, 0.15)',
                  color:
                    svc.status === 'healthy'
                      ? 'var(--accent-green)'
                      : 'var(--accent-rose)',
                  fontWeight: 600
                }}
              >
                {svc.status.toUpperCase()}
              </span>
            </div>
            <p className="service-role">{svc.role}</p>
            <div className="service-meta mono">
              <span>Port: :{svc.port}</span>
              <span>Probe: {svc.endpoint}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="stats-row">
        <div className="stat-box">
          <div className="stat-label">Device Fleet Size</div>
          <div className="stat-value mono">0</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Ingestion Rate</div>
          <div className="stat-value mono">0 msg/s</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">Active Incidents</div>
          <div className="stat-value mono" style={{ color: 'var(--accent-green)' }}>0</div>
        </div>
        <div className="stat-box">
          <div className="stat-label">SSE Subscribers</div>
          <div className="stat-value mono">1</div>
        </div>
      </div>
    </div>
  );
};

export default App;
