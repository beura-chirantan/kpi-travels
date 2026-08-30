'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, IncidentReport } from '../lib/api';
import { staffError } from '../lib/staff';
import { Empty, Notice, PageHeading } from './ui';

function payload(value: unknown) {
  return JSON.stringify(value, null, 2) || '{}';
}

function timestamp(value: string) {
  return new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: true,
  });
}

export default function IncidentsPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [data, setData] = useState<IncidentReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    api<IncidentReport>('/developer/incidents?limit=100', { signal: controller.signal })
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
        title="Incidents"
        description="Inspect failed API requests and their error responses for faster debugging."
      >
        <button
          className="button"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setRefresh((value) => value + 1);
          }}
        >
          {loading ? 'Checking…' : '↻ Refresh incidents'}
        </button>
      </PageHeading>

      <Notice tone="info">
        Passwords, API keys, session tokens, phone numbers and passenger details are automatically
        hidden.
      </Notice>
      {error && <Notice>{error}</Notice>}
      {loading && !data ? (
        <div className="panel loading">Loading incidents…</div>
      ) : data ? (
        <div className="incident-page" aria-live="polite">
          <section className="stats-grid" aria-label="Incident summary">
            <article className="panel stat">
              <span>Shown</span>
              <strong>{data.incident_count}</strong>
              <p>Newest incidents first</p>
            </article>
            <article className="panel stat">
              <span>Stored in memory</span>
              <strong>{data.retained_count}</strong>
              <p>Maximum {data.maximum_retained}</p>
            </article>
            <article className="panel stat">
              <span>Last checked</span>
              <strong className="incident-checked-time">
                {new Date(data.generated_at).toLocaleTimeString('en-IN', {
                  timeZone: 'Asia/Kolkata',
                })}
              </strong>
              <p>Updates every 15 seconds</p>
            </article>
          </section>

          <section className="dashboard-section" aria-labelledby="incident-list-heading">
            <div className="panel-heading">
              <div>
                <h2 id="incident-list-heading">Recent API errors</h2>
                <p>Timestamp, request payload and returned error response.</p>
              </div>
            </div>
            {data.incidents.length ? (
              <div className="incident-list">
                {data.incidents.map((incident) => (
                  <article className="panel incident-card" key={incident.id}>
                    <header>
                      <div>
                        <time dateTime={incident.timestamp}>
                          {timestamp(incident.timestamp)} IST
                        </time>
                        <code>
                          {incident.method} {incident.path}
                        </code>
                      </div>
                      <div className="incident-status">
                        <strong>HTTP {incident.status}</strong>
                        <span>{incident.error_type || 'Error response'}</span>
                      </div>
                    </header>
                    <div className="incident-payload-grid">
                      <section aria-label="Request payload">
                        <h3>Error payload</h3>
                        <pre>{payload(incident.request_payload)}</pre>
                      </section>
                      <section aria-label="Error response">
                        <h3>Response</h3>
                        <pre>{payload(incident.response)}</pre>
                      </section>
                    </div>
                    <small>Incident ID: {incident.id}</small>
                  </article>
                ))}
              </div>
            ) : (
              <Empty title="No incidents recorded">
                API errors will appear here automatically when they happen.
              </Empty>
            )}
          </section>
          <p className="small-note">{data.note}</p>
        </div>
      ) : null}
    </>
  );
}
