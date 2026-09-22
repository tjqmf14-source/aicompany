export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DashboardClientSettings {
  refreshSeconds: number;
  providerPreference: 'codex_then_high' | 'high_then_codex';
}

export const DEFAULT_CLIENT_SETTINGS: DashboardClientSettings = {
  refreshSeconds: 30,
  providerPreference: 'codex_then_high',
};

export function readSelectedProject(storage: KeyValueStorage): string {
  return storage.getItem('ai-company.selected-project') ?? '';
}

export function writeSelectedProject(storage: KeyValueStorage, projectId: string): void {
  storage.setItem('ai-company.selected-project', projectId);
}

export function readClientSettings(storage: KeyValueStorage): DashboardClientSettings {
  const raw = storage.getItem('ai-company.dashboard-settings');
  if (!raw) return DEFAULT_CLIENT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<DashboardClientSettings>;
    const refreshSeconds = typeof parsed.refreshSeconds === 'number' && Number.isFinite(parsed.refreshSeconds)
      ? Math.min(300, Math.max(10, Math.round(parsed.refreshSeconds)))
      : DEFAULT_CLIENT_SETTINGS.refreshSeconds;
    const providerPreference = parsed.providerPreference === 'high_then_codex' ? 'high_then_codex' : 'codex_then_high';
    return { refreshSeconds, providerPreference };
  } catch {
    return DEFAULT_CLIENT_SETTINGS;
  }
}

export function writeClientSettings(storage: KeyValueStorage, settings: DashboardClientSettings): void {
  storage.setItem('ai-company.dashboard-settings', JSON.stringify(settings));
}

export function connectionText(connected: boolean, loading: boolean): string {
  if (loading) return '연결 중';
  return connected ? '연결됨' : '백엔드 연결 끊김';
}
