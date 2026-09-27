export interface TestEvidence {
  tests: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
  todo: number;
}

const names = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const;

export function parseNodeTestEvidence(output: string): TestEvidence | null {
  const values = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(?:#|ℹ)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/.exec(line);
    if (match) values.set(match[1]!, Number(match[2]));
  }
  if (names.some(name => !values.has(name))) return null;
  return Object.fromEntries(names.map(name => [name, values.get(name)!])) as unknown as TestEvidence;
}

export function testEvidenceFailure(output: string): string | null {
  const evidence = parseNodeTestEvidence(output);
  if (!evidence) return 'Test runner did not emit a complete node:test summary';
  if (evidence.tests === 0) return 'Test runner reported zero tests';
  if (evidence.fail > 0) return `Test runner reported ${evidence.fail} failed test(s)`;
  if (evidence.cancelled > 0) return `Test runner reported ${evidence.cancelled} cancelled test(s)`;
  if (evidence.skipped > 0) return `Test runner reported ${evidence.skipped} skipped test(s)`;
  if (evidence.todo > 0) return `Test runner reported ${evidence.todo} todo test(s)`;
  if (evidence.pass !== evidence.tests) {
    return `Test summary is incomplete: ${evidence.pass} passed of ${evidence.tests} test(s)`;
  }
  return null;
}
