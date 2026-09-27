const namedSecret = /((?:api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|secret|password|passwd|credential|client[-_]?secret|_authtoken)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const secretArgument = /((?:--)?(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|credential)\s+)[^\s]+/gi;

export function redactSensitive(value: string, max = 20_000): string {
  return value
    .replace(/(?:sk|pk|rk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{12,}/gi, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s]+/gi, match => `${match.split(/\s+/, 1)[0]} [REDACTED]`)
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(namedSecret, '$1[REDACTED]')
    .replace(secretArgument, '$1[REDACTED]')
    .slice(0, max);
}
