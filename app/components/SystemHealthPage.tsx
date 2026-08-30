'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, SystemHealth } from '../lib/api';
import { staffError } from '../lib/staff';
import { Empty, Notice, PageHeading } from './ui';

function Status({ value }: { value: string }) {
  const tone =
    value === 'Working' || value === 'Ready' || value === 'Healthy'
      ? 'healthy'
      : value === 'Critical' || value === 'Error'
        ? 'critical'
        : 'warning';
  return <span className={`system-status ${tone}`}>{value}</span>;
}

export default function SystemHealthPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [data, setData] = useState<SystemHealth | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    api<SystemHealth>('/developer/system-health', { signal: controller.signal })
      .then((result) => {
        if (alive) {
          setData(result);
          setError('');
        }
      })
      .catch((problem) => {
        if (!alive) return;
        if (problem instanceof ApiError && problem.status === 401) {
          onUnauthorized();
          return;
        }
        setError(staffError(problem));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const timer = window.setInterval(() => setRefresh((value) => value + 1), 15000);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [onUnauthorized, refresh]);

  return (
    <>
      <PageHeading
        eyebrow="Developer tools"
        title="System health"
        description="See API traffic, errors, speed, throttling and capacity guidance."
      >
        <button
          className="button"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setRefresh((value) => value + 1);
          }}
        >
          {loading ? 'Checking…' : '↻ Refresh now'}
        </button>
      </PageHeading>

      {error && <Notice>{error}</Notice>}
      {loading && !data ? (
        <div className="panel loading">Checking the system…</div>
      ) : data ? (
        <div className="system-health" aria-live="polite">
          <section className="system-overview panel">
            <div>
              <span className="eyebrow">Current state</span>
              <h2>
                <Status value={data.overall_status} />
              </h2>
              <p>Last {data.window_minutes} minutes · updates automatically every 15 seconds</p>
            </div>
            <div className="system-updated">
              <span>Last checked</span>
              <strong>{new Date(data.generated_at).toLocaleTimeString('en-IN')}</strong>
              <small>API uptime {Math.floor(data.uptime_seconds / 60)} minutes</small>
            </div>
          </section>

          <section className="stats-grid" aria-label="API summary">
            <article className="panel stat">
              <span>Requests</span>
              <strong>{data.summary.requests.toLocaleString('en-IN')}</strong>
              <p>{data.summary.requests_per_minute} per minute</p>
            </article>
            <article className="panel stat">
              <span>Error rate</span>
              <strong>{data.summary.error_rate}%</strong>
              <p>{data.summary.server_errors} server errors</p>
            </article>
            <article className="panel stat">
              <span>95% response time</span>
              <strong>{data.summary.p95_latency_ms} ms</strong>
              <p>Average {data.summary.average_latency_ms} ms</p>
            </article>
            <article className="panel stat">
              <span>Throttled</span>
              <strong>{data.summary.throttled}</strong>
              <p>Requests blocked by limits</p>
            </article>
          </section>

          <section className="dashboard-section" aria-labelledby="dependency-heading">
            <div className="panel-heading">
              <div>
                <h2 id="dependency-heading">Services</h2>
                <p>Connection checks and recent AI fallback activity.</p>
              </div>
            </div>
            <div className="system-service-grid">
              {data.dependencies.map((dependency) => (
                <article className="panel system-service" key={dependency.name}>
                  <div>
                    <strong>{dependency.name}</strong>
                    <Status value={dependency.status} />
                  </div>
                  <p>{dependency.detail}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="dashboard-section table-panel panel" aria-labelledby="routes-heading">
            <div className="panel-heading">
              <div>
                <h2 id="routes-heading">API endpoints</h2>
                <p>Slow or failing endpoints appear first.</p>
              </div>
            </div>
            {data.routes.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Endpoint</th>
                      <th>Requests</th>
                      <th>Errors</th>
                      <th>Average</th>
                      <th>95%</th>
                      <th>Capacity advice</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.routes.map((route) => (
                      <tr key={`${route.method}-${route.path}`}>
                        <td>
                          <Status value={route.status} />
                        </td>
                        <td>
                          <code>
                            {route.method} {route.path}
                          </code>
                          <small>Last HTTP {route.last_status}</small>
                        </td>
                        <td>
                          {route.requests}
                          <small>{route.requests_per_minute}/min</small>
                        </td>
                        <td>
                          {route.errors}
                          <small>{route.error_rate}%</small>
                        </td>
                        <td>{route.average_latency_ms} ms</td>
                        <td>{route.p95_latency_ms} ms</td>
                        <td>{route.recommendation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No recent API traffic">
                Use the app, then return here to see endpoint measurements.
              </Empty>
            )}
          </section>

          <div className="dashboard-grid">
            <section
              className="dashboard-section table-panel panel"
              aria-labelledby="limits-heading"
            >
              <div className="panel-heading">
                <div>
                  <h2 id="limits-heading">Throttle limits</h2>
                  <p>Per client, per time window.</p>
                </div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>API</th>
                      <th>Limit</th>
                      <th>Current peak</th>
                      <th>Blocked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rate_limits.map((limit) => (
                      <tr key={limit.name}>
                        <td>
                          {limit.name}
                          <small>{limit.path}</small>
                        </td>
                        <td>
                          {limit.maximum} / {limit.window_seconds}s
                        </td>
                        <td>
                          {limit.highest_current_usage}
                          <small>{limit.active_clients} active clients</small>
                        </td>
                        <td>{limit.throttled}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section
              className="dashboard-section panel system-recommendations"
              aria-labelledby="advice-heading"
            >
              <div className="panel-heading">
                <div>
                  <h2 id="advice-heading">Recommended action</h2>
                  <p>Guidance from the current traffic window.</p>
                </div>
              </div>
              <ul>
                {data.recommendations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <Notice tone="info">
                Scaling advice is informational. Confirm it with longer production history before
                changing capacity.
              </Notice>
            </section>
          </div>
          <p className="small-note">{data.note}</p>
        </div>
      ) : null}
    </>
  );
}
