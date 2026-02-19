import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';

type SourceStatus = {
  id: string;
  displayName: string;
  rootPath: string;
  enabled: boolean;
  detected: boolean;
};

type Project = {
  id: string;
  sourceId: string;
  displayPath: string;
  name: string;
  lastActivityAt: string | null;
};

type SessionRef = {
  id: string;
  projectId: string;
  sourceSessionRef: string;
  updatedAt: string | null;
};

type Session = {
  id: string;
  model: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  turns: Array<{
    index: number;
    userText: string;
    assistantText: string;
    thinkingBlocks: string[];
    toolCalls: Array<{ name: string; args: string }>;
    toolResults: Array<{ output: string; status?: string }>;
  }>;
};

function tokenStorageKey(): string {
  return 'tracevault_token';
}

async function api<T>(path: string): Promise<T> {
  const token = localStorage.getItem(tokenStorageKey()) ?? '';
  const response = await fetch(path, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function TopBar() {
  const [token, setToken] = useState(localStorage.getItem(tokenStorageKey()) ?? '');

  return (
    <header className="topbar">
      <div className="brand">TraceVault</div>
      <nav>
        <Link to="/dashboard">Dashboard</Link>
        <Link to="/explorer">Explorer</Link>
        <Link to="/search">Search</Link>
      </nav>
      <input
        value={token}
        onChange={(event) => {
          const value = event.target.value;
          setToken(value);
          localStorage.setItem(tokenStorageKey(), value);
        }}
        placeholder="Bearer token"
      />
    </header>
  );
}

function DashboardPage() {
  const [stats, setStats] = useState<any>(null);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api('/api/v1/stats'), api<SourceStatus[]>('/api/v1/sources')])
      .then(([statsValue, sourcesValue]) => {
        setStats(statsValue);
        setSources(sourcesValue);
        setError('');
      })
      .catch((err) => setError(err.message));
  }, []);

  return (
    <section className="grid-two">
      <article className="panel">
        <h2>Recent Activity</h2>
        {error && <p className="error">{error}</p>}
        <pre>{stats ? JSON.stringify(stats, null, 2) : 'Loading stats...'}</pre>
      </article>
      <article className="panel">
        <h2>Sources</h2>
        <ul>
          {sources.map((source) => (
            <li key={source.id}>
              <strong>{source.displayName}</strong> enabled={String(source.enabled)} detected={String(source.detected)}
            </li>
          ))}
        </ul>
      </article>
    </section>
  );
}

function ExplorerPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SessionRef[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [selectedSession, setSelectedSession] = useState<string>('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<Project[]>('/api/v1/projects')
      .then((rows) => {
        setProjects(rows);
        if (rows.length > 0) setSelectedProject(rows[0].id);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!selectedProject) return;
    api<SessionRef[]>(`/api/v1/projects/${selectedProject}/sessions`)
      .then((rows) => {
        setSessions(rows);
        if (rows.length > 0) setSelectedSession(rows[0].id);
      })
      .catch((err) => setError(err.message));
  }, [selectedProject]);

  useEffect(() => {
    if (!selectedSession) return;
    api<Session>(`/api/v1/sessions/${selectedSession}`)
      .then((row) => setSession(row))
      .catch((err) => setError(err.message));
  }, [selectedSession]);

  return (
    <section className="explorer-grid">
      <article className="panel">
        <h3>Projects</h3>
        <ul>
          {projects.map((project) => (
            <li key={project.id}>
              <button
                className={project.id === selectedProject ? 'active' : ''}
                onClick={() => setSelectedProject(project.id)}
              >
                {project.sourceId} :: {project.name}
              </button>
            </li>
          ))}
        </ul>
      </article>
      <article className="panel">
        <h3>Sessions</h3>
        <ul>
          {sessions.map((item) => (
            <li key={item.id}>
              <button
                className={item.id === selectedSession ? 'active' : ''}
                onClick={() => setSelectedSession(item.id)}
              >
                {item.id.slice(0, 10)} {item.updatedAt ?? ''}
              </button>
            </li>
          ))}
        </ul>
      </article>
      <article className="panel viewer">
        <h3>Session</h3>
        {error && <p className="error">{error}</p>}
        {session ? (
          <div>
            <p>
              <strong>{session.id}</strong> model={session.model ?? 'unknown'}
            </p>
            {session.turns.map((turn) => (
              <div key={turn.index} className="turn">
                <p>
                  <strong>Turn {turn.index}</strong>
                </p>
                <p>User: {turn.userText || '(empty)'}</p>
                <p>Assistant: {turn.assistantText || '(empty)'}</p>
                {turn.thinkingBlocks.length > 0 && (
                  <details>
                    <summary>Thinking</summary>
                    <pre>{turn.thinkingBlocks.join('\n')}</pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p>Select a session.</p>
        )}
      </article>
    </section>
  );
}

function SessionPage() {
  const params = useParams();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!params.id) return;
    api<Session>(`/api/v1/sessions/${params.id}`)
      .then(setSession)
      .catch((err) => setError(err.message));
  }, [params.id]);

  return (
    <section className="panel">
      <h2>Session Detail</h2>
      {error && <p className="error">{error}</p>}
      <pre>{session ? JSON.stringify(session, null, 2) : 'Loading...'}</pre>
    </section>
  );
}

function SearchPage() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const hasQuery = useMemo(() => query.trim().length > 0, [query]);

  async function runSearch(): Promise<void> {
    if (!hasQuery) return;
    try {
      const rows = await api<any>(`/api/v1/search?q=${encodeURIComponent(query)}&limit=50`);
      setResult(rows);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="panel">
      <h2>Search</h2>
      <div className="search-row">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find sessions" />
        <button onClick={() => void runSearch()} disabled={!hasQuery}>
          Search
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <ul>
        {result?.results?.map((row: any) => (
          <li key={`${row.sessionId}-${row.turnIndex}`}>
            <button onClick={() => navigate(`/session/${row.sessionId}`)}>{row.sessionId.slice(0, 10)}</button>
            <span>{row.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SharePage() {
  const { bundleId } = useParams();
  return (
    <section className="panel">
      <h2>Shared Bundle</h2>
      <p>Bundle id: {bundleId}</p>
      <p>This route renders sanitized bundle metadata.</p>
    </section>
  );
}

export function App() {
  return (
    <div className="app-shell">
      <TopBar />
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/explorer" element={<ExplorerPage />} />
          <Route path="/session/:id" element={<SessionPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/share/:bundleId" element={<SharePage />} />
        </Routes>
      </main>
    </div>
  );
}

