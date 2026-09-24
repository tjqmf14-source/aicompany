import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  DashboardAction, DashboardProjectState, DashboardProjectSummary, DashboardRealtimeState,
} from '../dashboard/types.js';
import {
  connectionText, readClientSettings, readSelectedProject, writeClientSettings, writeSelectedProject,
  type DashboardClientSettings,
} from '../dashboard/client-state.js';
import './styles.css';

type Screen = 'command' | 'projects' | 'tasks' | 'activity' | 'changes' | 'validation' | 'codex' | 'checkpoints' | 'capabilities' | 'settings';
const screens: { id: Screen; label: string }[] = [
  { id: 'command', label: 'COMMAND CENTER' },
  { id: 'projects', label: 'PROJECTS' },
  { id: 'tasks', label: 'TASKS' },
  { id: 'activity', label: 'ACTIVITY' },
  { id: 'changes', label: 'CHANGES' },
  { id: 'validation', label: 'VALIDATION' },
  { id: 'codex', label: 'CODEX' },
  { id: 'checkpoints', label: 'CHECKPOINTS' },
  { id: 'capabilities', label: 'CAPABILITIES' },
  { id: 'settings', label: 'SETTINGS' },
];

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const text = await response.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) as unknown : null; } catch { data = text; }
  if (!response.ok) {
    const message = data && typeof data === 'object' && !Array.isArray(data) && 'message' in data
      ? String((data as { message: unknown }).message)
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

const short = (value: string | null, length = 10): string => value ? value.slice(0, length) : '없음';
const date = (value: string | null): string => value ? new Date(value).toLocaleString('ko-KR') : '기록 없음';
const statusClass = (value: string): string => {
  const normalized = value.toLowerCase().replaceAll(' ', '-').replaceAll('_', '-');
  if (normalized.includes('pass') || normalized.includes('available') || normalized === 'ready' || normalized === 'completed' || normalized === 'active') return 'good';
  if (normalized.includes('fail') || normalized.includes('error') || normalized.includes('blocked') || normalized.includes('unavailable')) return 'bad';
  if (normalized.includes('waiting') || normalized.includes('paused') || normalized.includes('auth') || normalized.includes('review')) return 'warn';
  return 'neutral';
};

function Badge({ value }: { value: string }) {
  return <span className={`badge ${statusClass(value)}`}>{value}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

function ActionButton({
  label, availability, onClick, busy,
}: { label: string; availability: DashboardAction; onClick: () => void; busy: boolean }) {
  return <div className="action-item">
    <button type="button" disabled={!availability.enabled || busy} onClick={onClick} title={availability.reason ?? label}>
      {label}
    </button>
    <small><Badge value={availability.state} /> {availability.reason ?? ''}</small>
  </div>;
}

function Metric({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return <div className="metric">
    <span>{label}</span>
    <strong className={mono ? 'mono' : ''}>{value}</strong>
  </div>;
}

function App() {
  const [screen, setScreen] = useState<Screen>('command');
  const [projects, setProjects] = useState<DashboardProjectSummary[]>([]);
  const [selected, setSelected] = useState(() => readSelectedProject(window.localStorage));
  const [state, setState] = useState<DashboardProjectState | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [highResponse, setHighResponse] = useState('');
  const [settings, setSettings] = useState<DashboardClientSettings>(() => readClientSettings(window.localStorage));
  const [codexLive, setCodexLive] = useState<string>('NOT_CHECKED');
  const [codexAuth, setCodexAuth] = useState<boolean | null>(null);
  const [skillSourcePath, setSkillSourcePath] = useState('');

  const refreshProjects = useCallback(async () => {
    const rows = await request<DashboardProjectSummary[]>('/api/dashboard/projects');
    setProjects(rows);
    if (!selected && rows[0]) {
      setSelected(rows[0].project.id);
      writeSelectedProject(window.localStorage, rows[0].project.id);
    }
  }, [selected]);

  const refreshState = useCallback(async () => {
    if (!selected) {
      setState(null);
      return;
    }
    const next = await request<DashboardProjectState>(`/api/dashboard/projects/${selected}`);
    setState(next);
  }, [selected]);

  const refreshAll = useCallback(async () => {
    setError('');
    try {
      await refreshProjects();
      await refreshState();
      setConnected(true);
    } catch (caught) {
      setConnected(false);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [refreshProjects, refreshState]);

  useEffect(() => { void refreshAll(); }, [refreshAll]);

  useEffect(() => {
    if (!selected) return;
    writeSelectedProject(window.localStorage, selected);
    setCodexLive('NOT_CHECKED');
    setCodexAuth(null);
    setLoading(true);
    void refreshState()
      .then(() => { setConnected(true); setError(''); })
      .catch(caught => { setConnected(false); setError(caught instanceof Error ? caught.message : String(caught)); })
      .finally(() => setLoading(false));
  }, [selected, refreshState]);

  useEffect(() => {
    if (!selected) return;
    const source = new EventSource(`/api/dashboard/projects/${selected}/stream`);
    source.onopen = () => setConnected(true);
    source.addEventListener('snapshot', event => {
      const realtime = JSON.parse((event as MessageEvent<string>).data) as DashboardRealtimeState;
      setState(current => current ? { ...current, ...realtime } : current);
      setConnected(true);
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [selected]);

  useEffect(() => {
    const timer = window.setInterval(() => { void refreshAll(); }, settings.refreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [refreshAll, settings.refreshSeconds]);

  const run = useCallback(async (path: string, payload?: unknown) => {
    setBusy(true); setError('');
    try {
      await request(path, { method: 'POST', body: JSON.stringify(payload ?? {}) });
      await refreshAll();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [refreshAll]);

  const currentTask = state?.commandCenter.currentTask ?? null;
  const latestHandoff = state?.handoffs[0] ?? null;
  const latestExecution = state?.codex.latestExecution ?? null;
  const pendingApproval = state?.approvals.find(item => item.status === 'pending') ?? null;

  const controlHandlers = useMemo(() => {
    if (!state) return null;
    const base = `/api/dashboard/projects/${state.project.id}`;
    return {
      pause: () => void run(`${base}/actions/pause`),
      resume: () => void run(`${base}/actions/resume`),
      cancel: () => void run(`${base}/actions/cancel`),
      checkpoint: () => void run(`${base}/actions/checkpoint`, { taskId: currentTask?.id, note: 'Dashboard checkpoint' }),
      approve: () => pendingApproval && void run(`${base}/approvals/${pendingApproval.id}/resolve`, { status: 'approved' }),
      reject: () => pendingApproval && void run(`${base}/approvals/${pendingApproval.id}/resolve`, { status: 'rejected' }),
      high: () => currentTask && void run(`${base}/handoffs`, { taskId: currentTask.id, objective: state.commandCenter.objective ?? currentTask.title }),
      importHigh: () => {
        if (!latestHandoff) return;
        try {
          const response = JSON.parse(highResponse) as unknown;
          void run(`${base}/handoffs/${latestHandoff.id}/import`, { response });
        } catch {
          setError('High 결과 JSON 형식이 올바르지 않습니다.');
        }
      },
      sendCodex: () => currentTask && void run(`${base}/codex/dispatch`, { taskId: currentTask.id, objective: state.commandCenter.objective ?? undefined }),
      resumeCodex: () => latestExecution && void run(`${base}/codex/${latestExecution.id}/resume`),
      apply: () => latestHandoff && void run(`${base}/handoffs/${latestHandoff.id}/apply`),
      rollback: () => latestHandoff && void run(`${base}/handoffs/${latestHandoff.id}/rollback`),
    };
  }, [state, run, currentTask, pendingApproval, latestHandoff, latestExecution, highResponse]);

  const checkCodex = async () => {
    if (!state) return;
    setBusy(true);
    try {
      const result = await request<{ state: string; reason: string | null; authenticated: boolean | null }>(`/api/dashboard/projects/${state.project.id}/codex/check`);
      setCodexLive(result.state.toUpperCase());
      setCodexAuth(result.authenticated);
      if (result.reason) setError(result.reason);
    } catch (caught) {
      setCodexLive('UNAVAILABLE');
      setCodexAuth(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(false); }
  };

  const effectiveCodexAuth = codexAuth ?? state?.codex.authenticated ?? null;

  const discoverCapabilities = () => {
    if (!state) return;
    void run(`/api/capability-manager/projects/${state.project.id}/discover`);
  };

  const requestSkillInstall = () => {
    if (!state || !skillSourcePath.trim()) {
      setError('설치할 로컬 Skill 폴더 경로를 입력하세요.');
      return;
    }
    void run(`/api/capability-manager/projects/${state.project.id}/skills/install-request`, { sourcePath: skillSourcePath.trim() });
  };

  const resolveCapabilityApproval = (approvalId: string, status: 'approved' | 'rejected') => {
    if (!state) return;
    void run(`/api/dashboard/projects/${state.project.id}/approvals/${approvalId}/resolve`, { status });
  };

  const executeCapabilityOperation = (operationId: string, kind: string) => {
    if (!state) return;
    const action = kind === 'INSTALL' ? 'install' : kind === 'VERIFY_MCP' ? 'verify-mcp' : '';
    if (!action) return;
    void run(`/api/capability-manager/projects/${state.project.id}/operations/${operationId}/${action}`);
  };

  const rollbackCapabilityInstall = (operationId: string) => {
    if (!state) return;
    void run(`/api/capability-manager/projects/${state.project.id}/operations/${operationId}/rollback`);
  };

  const requestMcpVerification = (capabilityId: string) => {
    if (!state) return;
    void run(`/api/capability-manager/projects/${state.project.id}/capabilities/${capabilityId}/mcp-verify-request`);
  };

  const saveSettings = (next: DashboardClientSettings) => {
    setSettings(next);
    writeClientSettings(window.localStorage, next);
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <strong>AI COMPANY</strong>
        <span>Bridge Dashboard</span>
      </div>
      <nav aria-label="Dashboard navigation">
        {screens.map(item => <button
          key={item.id}
          type="button"
          className={screen === item.id ? 'active' : ''}
          aria-current={screen === item.id ? 'page' : undefined}
          onClick={() => setScreen(item.id)}
        >{item.label}</button>)}
      </nav>
      <div className="policy">
        <span>ZERO-COST POLICY</span>
        <strong>ON</strong>
        <small>유료 API Key 입력 없음</small>
      </div>
    </aside>

    <main className="workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">LOCAL CONTROL PLANE</p>
          <h1>{screens.find(item => item.id === screen)?.label}</h1>
        </div>
        <div className="top-actions">
          <label>
            <span className="sr-only">프로젝트 선택</span>
            <select value={selected} onChange={event => setSelected(event.target.value)}>
              <option value="">프로젝트 없음</option>
              {projects.map(item => <option key={item.project.id} value={item.project.id}>{item.project.name}</option>)}
            </select>
          </label>
          <Badge value={connectionText(connected, loading)} />
          <button type="button" className="secondary" onClick={() => void refreshAll()} disabled={loading}>새로고침</button>
        </div>
      </header>

      {error && <div className="alert" role="alert"><strong>오류</strong><span>{error}</span></div>}
      {!loading && projects.length === 0 && <Empty>등록된 Project가 없습니다. 기존 Core API에서 프로젝트를 먼저 등록하십시오.</Empty>}
      {loading && <div className="loading" aria-live="polite">실제 상태를 불러오는 중…</div>}
      {!loading && selected && !state && <Empty>Project 상태를 불러오지 못했습니다.</Empty>}

      {state && screen === 'command' && <section className="content-grid">
        <div className="panel span-2">
          <div className="panel-heading">
            <div><p className="eyebrow">CURRENT STATE</p><h2>{state.project.name}</h2></div>
            <Badge value={state.project.status} />
          </div>
          <div className="metrics">
            <Metric label="현재 Objective" value={state.commandCenter.objective ?? '기록 없음'} />
            <Metric label="PD Stage" value={state.commandCenter.phase ?? '기록 없음'} />
            <Metric label="현재 Role" value={state.commandCenter.currentRole ?? '없음'} />
            <Metric label="활성 Role" value={state.commandCenter.activeRoles.length ? state.commandCenter.activeRoles.join(' · ') : '없음'} />
            <Metric label="현재 Task" value={currentTask?.title ?? '없음'} />
            <Metric label="Provider" value={<Badge value={state.commandCenter.provider} />} />
            <Metric label="Run 상태" value={state.commandCenter.runStatus ?? '실행 없음'} />
            <Metric label="Codex 상태" value={<Badge value={state.commandCenter.codexStatus} />} />
            <Metric label="Blocked reason" value={state.commandCenter.blockedReason ?? '없음'} />
            <Metric label="Approval required" value={state.commandCenter.approvalRequired ? 'YES' : 'NO'} />
            <Metric label="Independent Review" value={state.commandCenter.pendingReview ? 'PENDING' : '없음'} />
            <Metric label="QA" value={state.commandCenter.qaStatus} />
            <Metric label="PD Acceptance" value={state.commandCenter.pdAcceptance} />
            <Metric label="최근 Checkpoint" value={state.commandCenter.latestCheckpoint ? date(state.commandCenter.latestCheckpoint.createdAt) : '없음'} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-heading"><h2>Task 상태</h2></div>
          <div className="task-counts">
            {Object.entries(state.commandCenter.taskCounts).map(([key, value]) => <div key={key}><span>{key}</span><strong>{value}</strong></div>)}
          </div>
        </div>

        <div className="panel span-2">
          <div className="panel-heading"><h2>Validation</h2><button type="button" className="link-button" onClick={() => setScreen('validation')}>상세 보기</button></div>
          <div className="validation-strip">
            {state.validation.map(item => <div key={item.key}><span>{item.label}</span><Badge value={item.status} /></div>)}
          </div>
        </div>

        <div className="panel span-3">
          <div className="panel-heading"><h2>제어</h2><span className="muted">실제 Backend primitive가 있을 때만 활성화</span></div>
          <div className="actions-grid">
            {controlHandlers && <>
              <ActionButton label="Pause" availability={state.controls.pause} onClick={controlHandlers.pause} busy={busy} />
              <ActionButton label="Resume" availability={state.controls.resume} onClick={controlHandlers.resume} busy={busy} />
              <ActionButton label="Cancel" availability={state.controls.cancel} onClick={controlHandlers.cancel} busy={busy} />
              <ActionButton label="Approve" availability={state.controls.approve} onClick={controlHandlers.approve} busy={busy} />
              <ActionButton label="Reject" availability={state.controls.reject} onClick={controlHandlers.reject} busy={busy} />
              <ActionButton label="Create Checkpoint" availability={state.controls.createCheckpoint} onClick={controlHandlers.checkpoint} busy={busy} />
              <ActionButton label="ChatGPT High에서 계속하기" availability={state.controls.continueHigh} onClick={controlHandlers.high} busy={busy} />
              <ActionButton label="Codex로 보내기" availability={state.controls.sendCodex} onClick={controlHandlers.sendCodex} busy={busy} />
              <ActionButton label="Codex 재개" availability={state.controls.resumeCodex} onClick={controlHandlers.resumeCodex} busy={busy} />
              <ActionButton label="Diff 보기" availability={state.controls.viewDiff} onClick={() => setScreen('changes')} busy={busy} />
              <ActionButton label="Patch Preview" availability={state.controls.patchPreview} onClick={() => setScreen('changes')} busy={busy} />
              <ActionButton label="Patch Apply" availability={state.controls.patchApply} onClick={controlHandlers.apply} busy={busy} />
              <ActionButton label="Rollback" availability={state.controls.rollback} onClick={controlHandlers.rollback} busy={busy} />
            </>}
          </div>
          <div className="high-import">
            <label htmlFor="high-response">High 결과 JSON</label>
            <textarea id="high-response" rows={5} value={highResponse} onChange={event => setHighResponse(event.target.value)} placeholder="수동 Handoff 응답 JSON을 붙여넣습니다." />
            {controlHandlers && <ActionButton label="High 결과 가져오기" availability={state.controls.importHigh} onClick={controlHandlers.importHigh} busy={busy || !highResponse.trim()} />}
          </div>
        </div>
      </section>}

      {state && screen === 'projects' && <section className="stack">
        <div className="cards">
          {projects.map(item => <button type="button" className={item.project.id === selected ? 'project-card selected' : 'project-card'} key={item.project.id} onClick={() => setSelected(item.project.id)}>
            <div><strong>{item.project.name}</strong><Badge value={item.project.status} /></div>
            <span>{item.project.rootPath}</span>
            <small>{item.branch ?? 'detached'} · {short(item.head)} · {item.dirty ? 'dirty' : 'clean'}</small>
          </button>)}
        </div>
        <div className="panel">
          <h2>Project 상세</h2>
          <div className="metrics">
            <Metric label="Workspace" value={state.project.rootPath} mono />
            <Metric label="Status" value={state.project.status} />
            <Metric label="Current objective" value={state.commandCenter.objective ?? '기록 없음'} />
            <Metric label="Branch / HEAD" value={`${state.git.branch ?? '없음'} / ${short(state.git.head, 12)}`} mono />
            <Metric label="Created" value={date(state.project.createdAt)} />
            <Metric label="Updated" value={date(state.project.updatedAt)} />
            <Metric label="Latest checkpoint" value={state.checkpoints[0] ? date(state.checkpoints[0].createdAt) : '없음'} />
            <Metric label="Latest validation" value={state.validation.map(item => `${item.label}: ${item.status}`).join(' · ')} />
          </div>
          <div className="subgrid">
            <div><h3>Decisions</h3>{state.decisions.length ? state.decisions.map(item => <p key={item.id}>{item.summary}</p>) : <span className="muted">없음</span>}</div>
            <div><h3>Artifacts</h3>{state.artifacts.length ? state.artifacts.map(item => <p key={item.id} className="mono">{item.relativePath}</p>) : <span className="muted">없음</span>}</div>
            <div><h3>Runs</h3><p>{state.tasks.reduce((sum, task) => sum + task.runs.length, 0)}개</p></div>
            <div><h3>Git state</h3><p>{state.git.dirty ? '변경 있음' : '깨끗함'}</p></div>
          </div>
        </div>
      </section>}

      {state && screen === 'tasks' && <section className="panel">
        <div className="panel-heading"><h2>Task Tree / Dependency</h2><span className="muted">Dependency가 Core에 기록되지 않은 경우 “기록 없음”으로 표시</span></div>
        {state.tasks.length === 0 ? <Empty>Task가 없습니다.</Empty> : <div className="table-wrap"><table>
          <thead><tr><th>Title</th><th>Status</th><th>Role</th><th>Provider</th><th>Priority</th><th>Dependency</th><th>Retry</th><th>Acceptance criteria</th><th>Time</th></tr></thead>
          <tbody>{state.tasks.map(task => <tr key={task.id}>
            <td><strong>{task.title}</strong><small>{task.description || '설명 없음'}</small></td>
            <td><Badge value={task.status} /></td>
            <td>{task.role ?? '기록 없음'}</td>
            <td>{task.provider}</td>
            <td>{task.priority ?? '기록 없음'}</td>
            <td>{task.dependencies.length ? task.dependencies.join(', ') : '기록 없음'}</td>
            <td>{task.retryCount}</td>
            <td>{task.acceptanceCriteria.length ? task.acceptanceCriteria.map(item => <div key={item}>• {item}</div>) : '기록 없음'}</td>
            <td><small>시작 {date(task.startedAt)}<br />완료 {date(task.completedAt)}</small></td>
          </tr>)}</tbody>
        </table></div>}
      </section>}

      {state && screen === 'activity' && <section className="panel">
        <div className="panel-heading"><h2>실제 Event Log</h2><span className="muted">가짜 Agent 대화 없음</span></div>
        {state.activity.length === 0 ? <Empty>Event가 없습니다.</Empty> : <div className="timeline">
          {state.activity.map(item => <article key={item.id}>
            <time>{date(item.createdAt)}</time>
            <Badge value={item.category} />
            <div><strong>{item.type}</strong><pre>{JSON.stringify(item.payload, null, 2)}</pre></div>
          </article>)}
        </div>}
      </section>}

      {state && screen === 'changes' && <section className="stack">
        <div className="panel">
          <div className="panel-heading"><h2>Git 상태</h2><Badge value={state.git.dirty ? 'DIRTY' : 'CLEAN'} /></div>
          <div className="metrics">
            <Metric label="Branch" value={state.git.branch ?? '없음'} mono />
            <Metric label="HEAD" value={state.git.head ?? '없음'} mono />
            <Metric label="Changed files" value={state.git.changes.length} />
            <Metric label="Staged" value={state.git.changes.filter(item => item.code[0] !== ' ' && item.code[0] !== '?').length} />
            <Metric label="Unstaged" value={state.git.changes.filter(item => item.code[1] !== ' ').length} />
          </div>
          <div className="file-list">{state.git.changes.map(item => <div key={`${item.code}-${item.path}`}><code>{item.code}</code><span>{item.path}</span></div>)}</div>
        </div>
        <div className="panel">
          <h2>Diff Viewer</h2>
          <pre className="diff">{state.git.diff || 'Tracked diff가 없습니다. Untracked 파일 내용은 Core Git snapshot에 포함되지 않습니다.'}</pre>
        </div>
        <div className="panel">
          <h2>Patch Preview</h2>
          <pre className="diff">{latestHandoff?.preview?.diff ?? '검토 가능한 Patch preview가 없습니다.'}</pre>
        </div>
      </section>}

      {state && screen === 'validation' && <section className="panel">
        <div className="panel-heading"><h2>Validation 결과</h2><span className="muted">기록되지 않은 검사는 NOT RUN</span></div>
        <div className="table-wrap"><table>
          <thead><tr><th>검사</th><th>상태</th><th>실행 시각</th><th>Source</th><th>Log</th></tr></thead>
          <tbody>{state.validation.map(item => <tr key={item.key}>
            <td>{item.label}<small className="mono">{item.command ?? '별도 runner 없음'}</small></td>
            <td><Badge value={item.status} /></td>
            <td>{date(item.checkedAt)}</td>
            <td>{item.source}</td>
            <td><details><summary>상세 보기</summary><pre>{item.output ?? '저장된 로그 없음'}</pre></details></td>
          </tr>)}</tbody>
        </table></div>
      </section>}

      {state && screen === 'codex' && <section className="content-grid">
        <div className="panel span-2">
          <div className="panel-heading"><h2>Codex Provider</h2><Badge value={state.codex.status} /></div>
          <div className="metrics">
            <Metric label="Installed" value={state.codex.installed ? 'YES' : 'NO'} />
            <Metric label="Authenticated" value={effectiveCodexAuth === null ? 'NOT CHECKED' : effectiveCodexAuth ? 'YES' : 'NO'} />
            <Metric label="Live availability" value={<Badge value={codexLive} />} />
            <Metric label="Provider" value={state.codex.provider} />
            <Metric label="Thread ID" value={state.codex.threadId ?? '없음'} mono />
            <Metric label="Turn ID" value={state.codex.turnId ?? '없음'} mono />
            <Metric label="Current status" value={state.codex.currentStatus ?? '실행 없음'} />
            <Metric label="Resume availability" value={state.codex.resumeAvailable ? 'YES' : 'NO'} />
            <Metric label="Paused reason" value={state.codex.pausedReason ?? '없음'} />
            <Metric label="Last error" value={state.codex.lastError ?? '없음'} />
          </div>
          <button type="button" onClick={() => void checkCodex()} disabled={busy}>실제 Codex 상태 확인</button>
        </div>
        <div className="panel">
          <h2>안전 정책</h2>
          <p>Phase 3 Provider의 ChatGPT 인증 및 ZERO-COST 정책을 그대로 사용합니다.</p>
          <p>API Key 입력 UI는 제공하지 않습니다.</p>
        </div>
      </section>}

      {state && screen === 'checkpoints' && <section className="stack">
        {state.checkpoints.length === 0 ? <Empty>Checkpoint가 없습니다.</Empty> : state.checkpoints.map(item => <article className="panel checkpoint" key={item.id}>
          <div className="panel-heading"><h2>{item.note || 'Checkpoint'}</h2><time>{date(item.createdAt)}</time></div>
          <div className="metrics">
            <Metric label="Project" value={state.project.name} />
            <Metric label="Task" value={state.tasks.find(task => task.id === item.taskId)?.title ?? '없음'} />
            <Metric label="Git HEAD" value={item.snapshot.head ?? '없음'} mono />
            <Metric label="Changed files" value={item.snapshot.changes.length} />
            <Metric label="Validation result" value="Checkpoint 자체에는 Validation 결과 미기록" />
            <Metric label="Reason" value={item.note || '기록 없음'} />
          </div>
          <details><summary>Diff 보기</summary><pre className="diff">{item.snapshot.diff || 'Diff 없음'}</pre></details>
          <p className="muted">Rollback 요청은 Handoff의 recoverable checkpoint가 존재할 때만 Command Center에서 활성화됩니다.</p>
        </article>)}
      </section>}

      {state && screen === 'capabilities' && <section className="stack">
        <div className="panel">
          <div className="panel-heading">
            <div><h2>Capability / Skill / MCP Manager</h2><span className="muted">실제 탐색·비용·신뢰·검증 상태만 표시</span></div>
            <button type="button" onClick={discoverCapabilities} disabled={busy}>실제 Capability 탐색</button>
          </div>
          <div className="settings-form">
            <label>로컬 Skill 소스 폴더
              <input
                value={skillSourcePath}
                onChange={event => setSkillSourcePath(event.target.value)}
                placeholder="예: C:\\work\\my-skill"
              />
            </label>
            <button type="button" onClick={requestSkillInstall} disabled={busy || !skillSourcePath.trim()}>
              Skill 설치 승인 요청
            </button>
          </div>
          <p className="muted">외부 다운로드나 임의 shell 설치는 지원하지 않습니다. 로컬 Skill 복사도 Approval과 hash 재검증 후 실행됩니다.</p>
        </div>

        <div className="panel">
          <div className="table-wrap"><table>
            <thead><tr>
              <th>Capability</th><th>Type</th><th>Status</th><th>Discovery</th><th>Install</th><th>Auth</th>
              <th>Cost</th><th>Verify</th><th>Runtime</th><th>Approval</th><th>Trust</th><th>Source</th><th>Checked</th><th>Action</th>
            </tr></thead>
            <tbody>{state.capabilities.map(item => <tr key={item.name}>
              <td><strong>{item.name}</strong></td>
              <td>{item.type}</td>
              <td><Badge value={item.status} /></td>
              <td><Badge value={item.discovery} /></td>
              <td>{item.installation}</td>
              <td>{item.authentication}</td>
              <td><Badge value={item.cost} /></td>
              <td>{item.verification}</td>
              <td>{item.runtime}</td>
              <td>{item.approval}</td>
              <td>{item.sourceTrust}</td>
              <td className="mono">{item.source}</td>
              <td>{date(item.lastChecked)}</td>
              <td>
                {item.type === 'MCP' && item.name.startsWith('MCP:') && <button
                  type="button"
                  className="secondary"
                  disabled={busy || item.cost === 'UNKNOWN_COST' || item.cost === 'PAID' || item.cost === 'USAGE_BASED_PAID' || item.sourceTrust === 'UNKNOWN' || item.sourceTrust === 'BLOCKED'}
                  onClick={() => requestMcpVerification(item.id)}
                >MCP 검증 요청</button>}
              </td>
            </tr>)}</tbody>
          </table></div>
          <p className="muted">상세 JSON은 API의 capability detail에서 확인할 수 있으며, AVAILABLE은 Verification과 Runtime Gate가 모두 충족된 경우에만 표시됩니다.</p>
        </div>

        <div className="panel">
          <div className="panel-heading"><h2>Capability Operations</h2><span className="muted">Approval → 실행 → 검증 → 복구</span></div>
          {state.capabilityOperations.length === 0 ? <Empty>Capability operation이 없습니다.</Empty> : <div className="table-wrap"><table>
            <thead><tr><th>Kind</th><th>Status</th><th>Approval</th><th>Checkpoint</th><th>Error</th><th>Actions</th></tr></thead>
            <tbody>{state.capabilityOperations.map(operation => <tr key={operation.id}>
              <td>{operation.kind}</td>
              <td><Badge value={operation.status} /></td>
              <td className="mono">{operation.approvalId ?? '없음'}</td>
              <td className="mono">{operation.checkpointId ?? '없음'}</td>
              <td>{operation.error ?? '없음'}</td>
              <td>
                {operation.status === 'APPROVAL_PENDING' && operation.approvalId && <>
                  <button type="button" className="secondary" disabled={busy} onClick={() => resolveCapabilityApproval(operation.approvalId!, 'approved')}>승인</button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => resolveCapabilityApproval(operation.approvalId!, 'rejected')}>거절</button>
                </>}
                {(operation.status === 'APPROVAL_PENDING' || operation.status === 'APPROVED') && (operation.kind === 'INSTALL' || operation.kind === 'VERIFY_MCP') &&
                  <button type="button" disabled={busy} onClick={() => executeCapabilityOperation(operation.id, operation.kind)}>실행</button>}
                {operation.kind === 'INSTALL' && operation.status === 'COMPLETED' &&
                  <button type="button" className="secondary" disabled={busy} onClick={() => rollbackCapabilityInstall(operation.id)}>Rollback</button>}
              </td>
            </tr>)}</tbody>
          </table></div>}
        </div>
      </section>}

      {state && screen === 'settings' && <section className="content-grid">
        <div className="panel span-2">
          <h2>Backend 설정</h2>
          <div className="settings-form">
            <label>Workspace<input value={state.settings.workspace ?? ''} readOnly /></label>
            <label>Approval policy<input value={state.settings.approvalPolicy} readOnly /></label>
            <label>Log retention<input value={state.settings.logRetention} readOnly /></label>
            <label>Realtime<input value={state.settings.realtime} readOnly /></label>
            <label>Provider preference<input value={state.settings.providerPreference} readOnly /></label>
          </div>
        </div>
        <div className="panel">
          <h2>브라우저 로컬 설정</h2>
          <div className="settings-form">
            <label>보조 전체 재조회 간격(초)<input type="number" min={10} max={300} value={settings.refreshSeconds} onChange={event => saveSettings({ ...settings, refreshSeconds: Number(event.target.value) || 30 })} /></label>
            <label>Provider 표시 선호<select value={settings.providerPreference} onChange={event => saveSettings({ ...settings, providerPreference: event.target.value === 'high_then_codex' ? 'high_then_codex' : 'codex_then_high' })}>
              <option value="codex_then_high">Codex → High</option>
              <option value="high_then_codex">High → Codex</option>
            </select></label>
          </div>
          <p className="muted">실시간 상태는 SSE가 주 경로이며, 이 값은 연결 복구를 위한 저빈도 전체 재조회 간격입니다.</p>
        </div>
      </section>}
    </main>
  </div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Dashboard root element is missing');
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
