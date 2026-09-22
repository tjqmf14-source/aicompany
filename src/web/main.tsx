import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

type Project = { id: string; name: string; rootPath: string; status: string };
type Task = { id: string; title: string; status: string };
type Snapshot = { branch: string | null; head: string | null; dirty: boolean; changes: { code: string; path: string }[] };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(data.message ?? `HTTP ${response.status}`);
  return data;
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');

  const refreshProjects = async () => setProjects(await request<Project[]>('/api/projects'));
  useEffect(() => { void refreshProjects().catch(error => setError(String(error))); }, []);
  useEffect(() => {
    if (!selected) return;
    void Promise.all([request<Task[]>(`/api/projects/${selected}/tasks`), request<Snapshot>(`/api/projects/${selected}/git`)])
      .then(([nextTasks, nextSnapshot]) => { setTasks(nextTasks); setSnapshot(nextSnapshot); })
      .catch(error => setError(String(error)));
  }, [selected]);

  async function createProject(event: React.FormEvent) {
    event.preventDefault(); setError('');
    try {
      const project = await request<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name, rootPath }) });
      await refreshProjects(); setSelected(project.id); setName(''); setRootPath('');
    } catch (error) { setError(String(error)); }
  }
  async function createTask(event: React.FormEvent) {
    event.preventDefault(); setError('');
    try {
      const task = await request<Task>(`/api/projects/${selected}/tasks`, { method: 'POST', body: JSON.stringify({ title }) });
      setTasks(current => [...current, task]); setTitle('');
    } catch (error) { setError(String(error)); }
  }

  return <main>
    <h1>AI Company Core</h1>
    <p>로컬 저장소 · Git · SQLite</p>
    {error && <p role="alert">{error}</p>}
    <section>
      <h2>프로젝트</h2>
      <form onSubmit={createProject}>
        <input aria-label="프로젝트 이름" placeholder="프로젝트 이름" value={name} onChange={event => setName(event.target.value)} required />
        <input aria-label="저장소 경로" placeholder="로컬 Git 저장소 절대 경로" value={rootPath} onChange={event => setRootPath(event.target.value)} required />
        <button type="submit">추가</button>
      </form>
      <ul>{projects.map(project => <li key={project.id}><button onClick={() => setSelected(project.id)}>{project.name}</button> {project.status} · {project.rootPath}</li>)}</ul>
    </section>
    {selected && <section>
      <h2>선택한 저장소</h2>
      <p>브랜치: {snapshot?.branch ?? '없음'} · HEAD: {snapshot?.head ?? '첫 커밋 전'} · 작업 트리: {snapshot?.dirty ? '변경 있음' : '깨끗함'}</p>
      <ul>{snapshot?.changes.map(change => <li key={`${change.code}-${change.path}`}>{change.code} {change.path}</li>)}</ul>
      <h2>작업</h2>
      <form onSubmit={createTask}>
        <input aria-label="작업 제목" placeholder="작업 제목" value={title} onChange={event => setTitle(event.target.value)} required />
        <button type="submit">추가</button>
      </form>
      <ul>{tasks.map(task => <li key={task.id}>{task.title} · {task.status}</li>)}</ul>
    </section>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
