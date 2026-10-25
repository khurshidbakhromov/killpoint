const REDACTED = '[REDACTED]';

const PATTERNS: Array<[RegExp, string]> = [
  // Credentials embedded in connection URLs: postgres://user:pass@host -> postgres://[REDACTED]@host
  [/\b([a-z][a-z0-9+.-]*):\/\/[^\s/'"@]+@/gi, `$1://${REDACTED}@`],
  // key=value / key: value pairs whose key looks secret.
  [/\b(password|passwd|pwd|secret|token|api[_-]?key)(["']?\s*[:=]\s*["']?)([^\s"',;}&]+)/gi, `$1$2${REDACTED}`],
];

/**
 * Removes known run secrets (exact values) and common credential shapes from any string,
 * recursively through plain objects and arrays. Applied to every event, report, manifest
 * and diagnostic log line before it is written.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  constructor(secrets: Iterable<string> = []) {
    for (const secret of secrets) this.addSecret(secret);
  }

  addSecret(secret: string | undefined): void {
    // Very short values would redact ordinary words; generated secrets are long.
    if (secret && secret.length >= 6) this.secrets.add(secret);
  }

  redactString(input: string): string {
    let out = input;
    for (const secret of this.secrets) out = out.split(secret).join(REDACTED);
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
  }

  redact<T>(value: T): T {
    return this.walk(value, 0) as T;
  }

  private walk(value: unknown, depth: number): unknown {
    if (depth > 32) return '[TRUNCATED]';
    if (typeof value === 'string') return this.redactString(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item, depth + 1));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = this.walk(item, depth + 1);
      return out;
    }
    return value;
  }
}

/** Reduce an unknown thrown value to a redacted, serializable shape. */
export function describeError(error: unknown, redactor: Redactor): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: redactor.redactString(error.message).slice(0, 2000) };
  }
  return { name: 'NonError', message: redactor.redactString(String(error)).slice(0, 2000) };
}
