import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function npmRelease(env: NodeJS.ProcessEnv): { version: string; tag: 'canary' | 'latest' } {
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REPOSITORY !== 'tuuject/plastic-wan') {
    throw new Error('npm releases require a push in tuuject/plastic-wan');
  }
  if (env.GITHUB_REF === 'refs/heads/main') {
    const run = env.GITHUB_RUN_NUMBER ?? '';
    const attempt = env.GITHUB_RUN_ATTEMPT ?? '';
    const sha = env.GITHUB_SHA ?? '';
    if (!/^[1-9]\d*$/.test(run) || !/^[1-9]\d*$/.test(attempt) || !/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error('canary releases require a run number, run attempt and full commit SHA');
    }
    return { version: `0.0.0-canary.${run}.${attempt}.g${sha.slice(0, 12)}`, tag: 'canary' };
  }
  const stable = /^refs\/tags\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(env.GITHUB_REF ?? '');
  if (stable === null || stable.slice(1).some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new Error('stable releases require an exact vMAJOR.MINOR.PATCH tag (no prerelease or build suffix)');
  }
  return { version: stable.slice(1).join('.'), tag: 'latest' };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const release = npmRelease(process.env);
  if (!process.env.GITHUB_OUTPUT) {
    throw new Error('GITHUB_OUTPUT is required');
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${release.version}\ntag=${release.tag}\n`);
}
