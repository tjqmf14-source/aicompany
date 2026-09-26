const ALLOWED_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT',
  'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'LANG', 'LC_ALL', 'TERM',
] as const;

export function sanitizedProcessEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
