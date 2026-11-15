import { describe, expect, it } from 'vitest';
import { chunkId, chunkMarkdown, extractConfigKeys, slugify } from '../src/ingest/chunker.js';

const doc = `Intro line.

# TLS configuration

## Secure defaults

Set \`tls.min_version\` to "1.2".

\`\`\`yaml
# not a heading
tls.min_version: "1.2"
\`\`\`

## Secure defaults

Duplicate heading.
`;

describe('markdown chunker', () => {
  const chunks = chunkMarkdown(doc);
  const lines = doc.split('\n');

  it('splits on headings, ignoring "#" inside code fences', () => {
    expect(chunks.map((c) => c.anchor)).toEqual(['', 'tls-configuration', 'secure-defaults', 'secure-defaults-1']);
    expect(chunks[2]!.heading_path).toEqual(['TLS configuration', 'Secure defaults']);
    expect(chunks[2]!.text).toContain('# not a heading');
  });

  it('records exact 1-based line ranges whose text matches the source', () => {
    for (const c of chunks) {
      expect(c.text).toBe(lines.slice(c.line_start - 1, c.line_end).join('\n'));
    }
    expect(chunks[2]!.line_start).toBe(5);
  });

  it('splits long sections at paragraph boundaries with overlap, never across headings', () => {
    const para = (n: number) => `Paragraph ${n} ` + 'word '.repeat(150);
    const long = `# Big\n\n${Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n')}\n\n# Next\n\nTail.`;
    const parts = chunkMarkdown(long);
    const big = parts.filter((c) => c.anchor === 'big');
    expect(big.length).toBeGreaterThan(1);
    for (const c of big) expect(c.text.length).toBeLessThanOrEqual(3200);
    for (let i = 1; i < big.length; i++) expect(big[i]!.line_start).toBeLessThanOrEqual(big[i - 1]!.line_end + 2);
    expect(parts.at(-1)!.anchor).toBe('next');
    expect(big.some((c) => c.text.includes('# Next'))).toBe(false);
  });

  it('keeps a code block whole when within the limit', () => {
    const code = '# Code\n\n```\n' + 'x = 1\n'.repeat(500) + '```\n';
    const parts = chunkMarkdown(code);
    expect(parts.filter((c) => c.text.includes('```')).every((c) => (c.text.match(/```/g) ?? []).length % 2 === 0)).toBe(true);
  });

  it('produces deterministic chunk ids', () => {
    expect(chunkId('r1', 'docs/tls.md', 7, 'secure-defaults', 2)).toBe(chunkId('r1', 'docs/tls.md', 7, 'secure-defaults', 2));
    expect(chunkId('r1', 'docs/tls.md', 7, 'secure-defaults', 2)).not.toBe(chunkId('r1', 'docs/tls.md', 8, 'secure-defaults', 2));
  });

  it('slugifies like GitHub', () => {
    expect(slugify('Secure `defaults` (TLS 1.2)!')).toBe('secure-defaults-tls-12');
  });
});

describe('config key extraction', () => {
  it('finds dotted keys and flags in code, ignoring file names and prose', () => {
    expect(extractConfigKeys(doc)).toEqual(['tls.min_version']);
    expect(extractConfigKeys('Use `--insecure-skip-verify` and see `docs/tls.md` or `example.com`.')).toEqual(['--insecure-skip-verify']);
    expect(extractConfigKeys('tls.min_version in plain prose')).toEqual([]);
  });
});
