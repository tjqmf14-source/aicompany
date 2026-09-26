const patterns: RegExp[] = [
  /(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /Bearer\s+[^\s]+/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

export function redactSensitive(value: string, max = 20_000): string {
  let result = value.slice(0, max);
  for (const pattern of patterns) result = result.replace(pattern, '[REDACTED]');
  return result;
}
