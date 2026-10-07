import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { npmRelease } from '../scripts/npm-release.ts';

const env: NodeJS.ProcessEnv = {
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REPOSITORY: 'tuuject/plastic-wan',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_RUN_NUMBER: '123',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: `${'0123456789abcdef'.repeat(2)}01234567`,
};

const packagePath = new URL('../packages/cli/package.json', import.meta.url);
const releaseScript = fileURLToPath(new URL('../scripts/npm-release.ts', import.meta.url));

describe('npm release selection', () => {
  it('publishes main to canary with unique versions for different runs, retries and commits', () => {
    expect(npmRelease(env)).toEqual({ version: '0.0.0-canary.123.1.g0123456789ab', tag: 'canary' });
    const releases = [
      env,
      { ...env, GITHUB_RUN_NUMBER: '124' },
      { ...env, GITHUB_RUN_ATTEMPT: '2' },
      { ...env, GITHUB_SHA: 'a'.repeat(40) },
    ].map((input) => npmRelease(input).version);
    expect(new Set(releases).size).toBe(4);
  });

  it.each(['0.1.0', '1.0.0', '10.20.30'])('uses tag v%s as the exact latest version', (version) => {
    expect(npmRelease({ ...env, GITHUB_REF: `refs/tags/v${version}` })).toEqual({ version, tag: 'latest' });
  });

  it.each([
    'refs/heads/develop',
    'refs/heads/feature/npm',
    'refs/pull/1/merge',
    'refs/tags/v1.0',
    'refs/tags/v01.0.0',
    'refs/tags/v1.00.0',
    'refs/tags/v1.0.01',
    'refs/tags/v1.0.0-rc.1',
    'refs/tags/v0.0.0-next-20261006000000',
    'refs/tags/v1.0.0+build.1',
    'refs/tags/v9007199254740992.0.0',
    'refs/tags/v1.0.0\n',
    'refs/tags/v1.0.0\ntag=canary',
    '',
  ])('rejects unsupported or malformed ref %j', (ref) => {
    expect(() => npmRelease({ ...env, GITHUB_REF: ref })).toThrow('exact vMAJOR.MINOR.PATCH');
  });

  it.each([
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_EVENT_NAME: 'workflow_run' },
    { GITHUB_REPOSITORY: 'someone/plastic-wan' },
    { GITHUB_RUN_NUMBER: '0' },
    { GITHUB_RUN_NUMBER: '123\ntag=latest' },
    { GITHUB_RUN_ATTEMPT: '01' },
    { GITHUB_RUN_ATTEMPT: '' },
    { GITHUB_SHA: 'short' },
    { GITHUB_SHA: '' },
  ])('rejects untrusted or incomplete workflow inputs %j', (override) => {
    expect(() => npmRelease({ ...env, ...override })).toThrow();
  });

  it('writes validated GitHub outputs without changing the package manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plasticwan-npm-release-'));
    try {
      const output = join(dir, 'output');
      const before = readFileSync(packagePath, 'utf8');
      const result = spawnSync(process.execPath, [releaseScript], {
        env: { ...env, GITHUB_OUTPUT: output },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe('version=0.0.0-canary.123.1.g0123456789ab\ntag=canary\n');
      expect(readFileSync(packagePath, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes only the standalone CLI package without bundling a Skill', () => {
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    expect(manifest.name).toBe('@tuuject/plasticwan-utils');
    expect(manifest.private).not.toBe(true);
    expect(manifest.publishConfig).toEqual({ access: 'public', registry: 'https://registry.npmjs.org/' });
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/tuuject/plastic-wan.git',
      directory: 'packages/cli',
    });
    expect(manifest.bin).toEqual({ 'plasticwan-utils': './dist/bin.js' });
    expect(manifest.files).toEqual(['dist', 'README.md']);
    expect(manifest.dependencies).toBeUndefined();
    expect(existsSync(new URL('../packages/cli/skills/', import.meta.url))).toBe(false);
    const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const image = JSON.parse(readFileSync(new URL('../packages/image-service/package.json', import.meta.url), 'utf8'));
    expect(root.private).toBe(true);
    expect(root.bin).toEqual({ plasticwan: './src/cli.ts' });
    expect(image.private).toBe(true);
  });

  it('keeps the project-root Skill entry small and links to separate Invocation guides', () => {
    const skill = new URL('../.agents/skills/plasticwan-utils/', import.meta.url);
    const entry = readFileSync(new URL('SKILL.md', skill), 'utf8');
    expect(entry).toContain('name: plasticwan-utils');
    expect(entry).toContain('(references/invocations.md)');
    expect(entry).toContain('(references/replay.md)');
    expect(entry).not.toContain('fidelity.');
    expect(entry).not.toContain('plasticwan-utils invocation replay');
    expect(entry).toContain('plasticwan-utils doctor --json');
    expect(entry).toContain('退出码为 `0`');
    expect(entry).toContain('stdout 的 `status` 为 `ok`');
    expect(entry).toContain('未通过时立即停止');
    expect(entry).toContain('不自动执行 `login`');
    expect(entry).toContain('不要循环重试');
    const audit = readFileSync(new URL('references/invocations.md', skill), 'utf8');
    expect(audit).toContain('plasticwan-utils invocation get');
    expect(audit).toContain('telegram_sends[]');
    const replay = readFileSync(new URL('references/replay.md', skill), 'utf8');
    expect(replay).toContain('plasticwan-utils invocation replay');
    expect(replay).toContain('明确授权');
    expect(replay).toContain('fidelity.omitted_images');
    const metadata = readFileSync(new URL('agents/openai.yaml', skill), 'utf8');
    expect(metadata).toContain('$plasticwan-utils');
  });
});
