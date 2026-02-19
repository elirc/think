import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import blessed from 'blessed';
import { redactSession, type Project, type SessionRef, type SourceId, TraceVaultService } from '@tracevault/core';

interface TuiState {
  sourceFilter: SourceId | 'all';
  query: string;
  treeMode: boolean;
  projects: Project[];
  sessions: SessionRef[];
  selectedProjectId: string | null;
  selectedSessionId: string | null;
}

function renderTreeLabel(project: Project, treeMode: boolean): string {
  if (!treeMode) return `${project.name} (${project.sourceId})`;
  return `${project.sourceId} :: ${project.displayPath}`;
}

function sessionToText(session: Awaited<ReturnType<TraceVaultService['getSession']>>): string {
  if (!session) return 'No session selected.';

  const lines: string[] = [];
  lines.push(`Session: ${session.id}`);
  lines.push(`Model: ${session.model ?? 'unknown'}`);
  lines.push(`Started: ${session.startedAt ?? 'unknown'}`);
  lines.push(`Updated: ${session.updatedAt ?? 'unknown'}`);
  lines.push('');

  for (const turn of session.turns) {
    lines.push(`Turn ${turn.index} @ ${turn.timestamp ?? 'unknown'}`);
    lines.push(`U> ${turn.userText || '(empty)'}`);
    lines.push(`A> ${turn.assistantText || '(empty)'}`);

    if (turn.thinkingBlocks.length > 0) {
      lines.push('thinking:');
      for (const block of turn.thinkingBlocks) {
        lines.push(`  - ${block}`);
      }
    }

    if (turn.toolCalls.length > 0) {
      lines.push('tool calls:');
      for (const call of turn.toolCalls) {
        lines.push(`  - ${call.name} ${call.args}`);
      }
    }

    if (turn.toolResults.length > 0) {
      lines.push('tool results:');
      for (const result of turn.toolResults) {
        lines.push(`  - (${result.status ?? 'ok'}) ${result.output}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

export async function launchTui(service: TraceVaultService): Promise<void> {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'TraceVault'
  });

  const state: TuiState = {
    sourceFilter: 'all',
    query: '',
    treeMode: true,
    projects: [],
    sessions: [],
    selectedProjectId: null,
    selectedSessionId: null
  };

  const header = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ' TraceVault  / filter  s source  t tree/flat  e export  esc back  q quit ',
    style: { fg: 'black', bg: 'green' }
  });

  const projectList = blessed.list({
    top: 1,
    left: 0,
    width: '30%',
    height: '100%-1',
    border: 'line',
    label: ' Projects ',
    keys: true,
    vi: true,
    style: {
      selected: { bg: 'blue' }
    }
  });

  const sessionList = blessed.list({
    top: 1,
    left: '30%',
    width: '30%',
    height: '100%-1',
    border: 'line',
    label: ' Sessions ',
    keys: true,
    vi: true,
    style: {
      selected: { bg: 'blue' }
    }
  });

  const viewer = blessed.box({
    top: 1,
    left: '60%',
    width: '40%',
    height: '100%-1',
    border: 'line',
    label: ' Viewer ',
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    vi: true
  });

  screen.append(header);
  screen.append(projectList);
  screen.append(sessionList);
  screen.append(viewer);

  async function refreshProjects(): Promise<void> {
    let projects = await service.listProjects(
      state.sourceFilter === 'all' ? undefined : state.sourceFilter
    );

    if (state.query) {
      const needle = state.query.toLowerCase();
      projects = projects.filter(
        (project) => project.name.toLowerCase().includes(needle) || project.displayPath.toLowerCase().includes(needle)
      );
    }

    state.projects = projects;
    projectList.setItems(projects.map((project) => renderTreeLabel(project, state.treeMode)));

    if (projects.length > 0) {
      const selectedIndex = Math.max(0, (projectList as any).selected ?? 0);
      projectList.select(selectedIndex);
      state.selectedProjectId = projects[selectedIndex]?.id ?? null;
      await refreshSessions();
    } else {
      state.sessions = [];
      sessionList.setItems([]);
      viewer.setContent('No projects found for current filters.');
    }

    updateHeader();
    screen.render();
  }

  async function refreshSessions(): Promise<void> {
    const projectId = state.selectedProjectId;
    if (!projectId) {
      state.sessions = [];
      sessionList.setItems([]);
      return;
    }

    const sessions = await service.listSessions(projectId);
    state.sessions = sessions;
    sessionList.setItems(
      sessions.map((session) => `${session.id.slice(0, 10)}  ${session.updatedAt ?? 'unknown'}`)
    );

    if (sessions.length > 0) {
      const index = Math.max(0, (sessionList as any).selected ?? 0);
      sessionList.select(index);
      state.selectedSessionId = sessions[index]?.id ?? null;
      await refreshViewer();
    } else {
      state.selectedSessionId = null;
      viewer.setContent('No sessions in selected project.');
    }
  }

  async function refreshViewer(): Promise<void> {
    if (!state.selectedSessionId) {
      viewer.setContent('No session selected.');
      screen.render();
      return;
    }

    const session = await service.getSession(state.selectedSessionId);
    viewer.setContent(sessionToText(session));
    viewer.setScroll(0);
    screen.render();
  }

  function updateHeader(): void {
    header.setContent(
      ` TraceVault  source=${state.sourceFilter}  query=${state.query || '*'}  view=${state.treeMode ? 'tree' : 'flat'}  / filter  s source  t tree/flat  e export  esc back  q quit `
    );
  }

  function promptInput(label: string, initialValue: string, onSubmit: (value: string) => Promise<void>): void {
    const prompt = blessed.prompt({
      parent: screen,
      border: 'line',
      height: 7,
      width: '70%',
      top: 'center',
      left: 'center',
      label,
      keys: true,
      vi: true
    });

    prompt.input(label, initialValue, async (_error, value) => {
      prompt.destroy();
      await onSubmit((value ?? '').trim());
      screen.render();
    });
  }

  screen.key(['q', 'C-c'], () => {
    screen.destroy();
    process.exit(0);
  });

  screen.key('/', () => {
    promptInput('Filter projects', state.query, async (value) => {
      state.query = value;
      await refreshProjects();
    });
  });

  screen.key('s', async () => {
    const sourceOrder: Array<TuiState['sourceFilter']> = ['all', 'claude', 'kimi', 'gemini', 'copilot', 'codex'];
    const idx = sourceOrder.indexOf(state.sourceFilter);
    state.sourceFilter = sourceOrder[(idx + 1) % sourceOrder.length] ?? 'all';
    await refreshProjects();
  });

  screen.key('t', async () => {
    state.treeMode = !state.treeMode;
    await refreshProjects();
  });

  screen.key('escape', () => {
    if (viewer.getScroll() > 0) {
      viewer.setScroll(0);
      screen.render();
      return;
    }
    sessionList.focus();
  });

  screen.key('e', async () => {
    if (!state.selectedSessionId) return;
    const session = await service.getSession(state.selectedSessionId);
    if (!session) return;
    const safeProfile = service.getConfig().redaction.profiles.safe;
    const redacted = redactSession(session, safeProfile);
    const filePath = join(process.cwd(), `tracevault-export-${redacted.id}.md`);
    writeFileSync(filePath, sessionToText(redacted), 'utf8');
    viewer.setContent(`${viewer.getContent()}\n\nExported to: ${filePath}`);
    screen.render();
  });

  projectList.on('select', async (_item, index) => {
    const selected = state.projects[index];
    state.selectedProjectId = selected?.id ?? null;
    await refreshSessions();
  });

  sessionList.on('select', async (_item, index) => {
    const selected = state.sessions[index];
    state.selectedSessionId = selected?.id ?? null;
    await refreshViewer();
  });

  projectList.focus();
  await refreshProjects();
}
