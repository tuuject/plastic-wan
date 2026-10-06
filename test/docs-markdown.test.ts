import { expect, test } from 'vitest';
import { CODE_BLOCK_PATTERN } from '../scripts/docs-markdown.ts';

for (const newline of ['\n', '\r\n']) {
  test(`documentation checks exclude nested code blocks from H1 counts (${JSON.stringify(newline)})`, () => {
    const markdown = [
      '# CLI reference',
      '',
      '```bash',
      '# Top-level command comment',
      'plasticwan-utils --help',
      '```',
      '',
      '1. Save credentials:',
      '',
      '   ```bash',
      '   plasticwan-utils login',
      '   ```',
      '',
      '```bash',
      '# Credential input comment',
      '# Another command comment',
      'plasticwan-utils doctor --json',
      '```',
      '',
      '2. Copy the Skill:',
      '',
      '   ```powershell',
      '   Copy-Item -LiteralPath $source -Destination $target -Recurse',
      '   ```',
      '',
    ].join(newline);

    expect([...markdown.replace(CODE_BLOCK_PATTERN, '').matchAll(/^# .+$/gm)]).toHaveLength(1);
    const code = [...markdown.matchAll(CODE_BLOCK_PATTERN)].map((match) => match[2]?.replaceAll('\r\n', '\n'));
    expect(code).toEqual([
      '# Top-level command comment\nplasticwan-utils --help',
      '   plasticwan-utils login',
      '# Credential input comment\n# Another command comment\nplasticwan-utils doctor --json',
      '   Copy-Item -LiteralPath $source -Destination $target -Recurse',
    ]);
  });
}

test('a fence-like inline token does not hide the next real heading', () => {
  const markdown = '# First\n\nAn inline ``` token.\n\n# Second\n';
  expect([...markdown.replace(CODE_BLOCK_PATTERN, '').matchAll(/^# .+$/gm)]).toHaveLength(2);
});
