import { useEffect, useState } from 'react';

type Source = {
  id: string;
  displayName: string;
  enabled: boolean;
  detected: boolean;
};

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = localStorage.getItem('tracevault_token') ?? '';
  const response = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

export function LiteApp() {
  const [health, setHealth] = useState<any>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [token, setToken] = useState(localStorage.getItem('tracevault_token') ?? '');
  const [pathInput, setPathInput] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    api('/api/v1/health')
      .then(setHealth)
      .catch((err) => setStatus(err.message));

    api<Source[]>('/api/v1/sources')
      .then(setSources)
      .catch((err) => setStatus(err.message));
  }, []);

  return (
    <div className="lite-shell">
      <h1>TraceVault Lite</h1>
      <p>Connection status and quick actions.</p>

      <label>
        Bearer token
        <input
          value={token}
          onChange={(event) => {
            const value = event.target.value;
            setToken(value);
            localStorage.setItem('tracevault_token', value);
          }}
        />
      </label>

      <section>
        <h2>Connection</h2>
        <pre>{health ? JSON.stringify(health, null, 2) : 'Loading...'}</pre>
      </section>

      <section>
        <h2>Sources</h2>
        <ul>
          {sources.map((source) => (
            <li key={source.id}>
              <input type="checkbox" checked={source.enabled} readOnly />
              {source.displayName} detected={String(source.detected)}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Open-in</h2>
        <div className="row">
          <input value={pathInput} onChange={(event) => setPathInput(event.target.value)} placeholder="File path" />
          <button
            onClick={() => {
              api('/api/v1/open-in', 'POST', { path: pathInput, app: 'code' })
                .then(() => setStatus('Open request sent.'))
                .catch((err) => setStatus(err.message));
            }}
          >
            VS Code
          </button>
          <button
            onClick={() => {
              api('/api/v1/open-in', 'POST', { path: pathInput, app: 'cursor' })
                .then(() => setStatus('Open request sent.'))
                .catch((err) => setStatus(err.message));
            }}
          >
            Cursor
          </button>
        </div>
      </section>

      {status && <p className="status">{status}</p>}
    </div>
  );
}

