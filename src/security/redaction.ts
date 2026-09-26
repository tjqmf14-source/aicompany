const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'api_token', pattern: /(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/i },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'bearer_token', pattern: /Bearer\s+[^\s]+/i },
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

export function detectSecretKinds(value: string): string[] {
  const candidate = value.replaceAll('[REDACTED]', '');
  return SECRET_PATTERNS.filter(item => item.pattern.test(candidate)).map(item => item.name);
}

export function redactSensitive(value: string, max = 20_000): string {
  let result = value.slice(0, max);
  for (const item of SECRET_PATTERNS) {
    const flags = item.pattern.flags.includes('g') ? item.pattern.flags : `${item.pattern.flags}g`;
    result = result.replace(new RegExp(item.pattern.source, flags), '[REDACTED]');
  }
  return result;
}
