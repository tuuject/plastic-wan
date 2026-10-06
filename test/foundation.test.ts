import { afterEach, describe, expect, test } from 'vitest';
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredToolSchemaKeywords, loadConfig } from '../src/platform/config.ts';
import { secretEdit, writeConfigEdits } from '../src/platform/config-file.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { buildModelRegistry, requireModel } from '../src/platform/providers.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { backupDatabase, SqliteStore } from '../src/store/database.ts';
import { schemaMigrations } from '../src/store/schema.ts';
import { pathExists, testConfigJsonc, writeTestConfig, writeTestKeyJar } from './helpers.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  return { directory, configPath };
}

describe('configuration', () => {
  test('accepts the complete version 1 contract', async () => {
    const { configPath } = await fixture();
    const loaded = await loadConfig(configPath);
    expect(loaded.config.agent.context.idle_grace_seconds).toBe(0);
    expect(loaded.config.agent.rate_limits.sends_per_window).toBe(6);
    expect(loaded.config.telegram.bucket_window_seconds).toBe(15);
    const agentProvider = loaded.config.providers.agent;
    expect(agentProvider?.kind).toBe('custom');
    if (agentProvider?.kind !== 'custom') {
      throw new Error('Expected the custom agent provider');
    }
    expect(agentProvider.models[0]?.compat?.supports_developer_role).toBe(false);
    const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(configPath)));
    expect(requireModel(registry.models, 'agent', 'agent-model', ['text']).compat).toMatchObject({
      supportsDeveloperRole: false,
    });
    expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('rejects unknown fields', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => Object.assign(config, { unknown: true })),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('rejects the removed per-invocation limits', async () => {
    const { directory, configPath } = await fixture();
    for (const key of ['max_turns', 'max_sends', 'timeout_seconds'] as const) {
      await writeFile(
        configPath,
        testConfigJsonc(directory, (config) => Object.assign(config.agent, { [key]: 5 })),
      );
      // The error has to name the offending key, otherwise the operator is left diffing by hand.
      await expect(loadConfig(configPath)).rejects.toThrow(key);
    }
  });

  test('enforces the Conversation Context invariants', async () => {
    const { directory, configPath } = await fixture();
    const reload = async (transform: Parameters<typeof testConfigJsonc>[1]): Promise<unknown> => {
      await writeFile(configPath, testConfigJsonc(directory, transform));
      return loadConfig(configPath);
    };
    // A target that is not below the trigger threshold can never converge.
    await expect(
      reload((config) => {
        config.agent.context.retained_sends_target = config.agent.context.retained_sends_max;
      }),
    ).rejects.toThrow('retained_sends_target must be smaller');
    // GC has to run before the closing mode takes over.
    await expect(
      reload((config) => {
        config.agent.context.hard_token_ratio = 0.9;
      }),
    ).rejects.toThrow('hard_token_ratio');
    // A grace shorter than one bucket window would look enabled while every run
    // ends before the next bucket is due.
    await expect(
      reload((config) => {
        config.telegram.bucket_window_seconds = 15;
        config.agent.context.idle_grace_seconds = 5;
      }),
    ).rejects.toThrow('idle_grace_seconds must be 0');
    // 0 is the supported way to turn long-lived invocations off.
    await expect(
      reload((config) => {
        config.agent.context.idle_grace_seconds = 0;
      }),
    ).resolves.toBeDefined();
    await expect(
      reload((config) => {
        config.agent.context.idle_grace_seconds = 15;
      }),
    ).resolves.toBeDefined();
    await expect(
      reload((config) => {
        config.agent.context.idle_grace_seconds = 15;
        config.agent.context.max_wall_clock_seconds = 15;
      }),
    ).rejects.toThrow('max_wall_clock_seconds must exceed');
  });

  test('accepts zero-second bucket windows and rejects values above three hundred seconds', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.bucket_window_seconds = 0;
      }),
    );
    expect((await loadConfig(configPath)).config.telegram.bucket_window_seconds).toBe(0);
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.bucket_window_seconds = 301;
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('accepts an agent model without image input', async () => {
    const { directory, configPath } = await fixture();
    const config = testConfigJsonc(directory, (fileConfig) => {
      const provider = fileConfig.providers.agent;
      if (provider?.kind !== 'custom' || provider.models[0] === undefined) {
        throw new Error('Expected custom agent provider fixture');
      }
      provider.models[0].input = ['text'];
    });
    await writeFile(configPath, config);
    const loaded = await loadConfig(configPath);
    const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(configPath)));
    expect(requireModel(registry.models, 'agent', 'agent-model', ['text']).input).toEqual(['text']);
  });

  test('rejects a vision model without image input', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const provider = config.providers.vision;
        if (provider?.kind !== 'custom' || provider.models[0] === undefined) {
          throw new Error('Expected custom vision provider fixture');
        }
        provider.models[0].input = ['text'];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('vision.model vision-model lacks image input capability');
  });

  test('rejects developer-role compatibility for an Anthropic adapter', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const provider = config.providers.agent;
        if (provider?.kind !== 'custom') {
          throw new Error('Expected custom agent provider fixture');
        }
        provider.api = 'anthropic-messages';
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(
      'cannot set supports_developer_role for api anthropic-messages',
    );
  });

  test('rejects compat values outside the selected set', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const provider = config.providers.agent;
        if (provider?.kind !== 'custom') {
          throw new Error('Expected custom agent provider fixture');
        }
        provider.api = 'openai-completions';
        const model = provider.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        // `baseten` needs kwargs, so it is not offered as a thinking format.
        model.compat = { thinking_format: 'baseten' } as never;
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('rejects a cache control format Pi cannot force off', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const provider = config.providers.agent;
        if (provider?.kind !== 'custom') {
          throw new Error('Expected custom agent provider fixture');
        }
        provider.api = 'openai-completions';
        const model = provider.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        model.compat = { cache_control_format: 'openai' } as never;
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('rejects a vision model a builtin provider does not list', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.providers.builtin = {
          kind: 'builtin',
          provider: 'google',
          api_key: { jar: 'agent' },
          models: [
            {
              id: 'gemini-3.7-flash',
              reasoning: true,
              input: ['text', 'image'],
              context_window: 1_048_576,
              max_tokens: 65_536,
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            },
          ],
        };
        config.vision.provider = 'builtin';
        config.vision.model = 'gemini-3.7-pro';
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('gemini-3.7-pro is absent from provider builtin');
  });

  test('rejects compat fields the model API does not honour', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const provider = config.providers.agent;
        if (provider?.kind !== 'custom') {
          throw new Error('Expected custom agent provider fixture');
        }
        // Responses adapters only read `supports_developer_role`.
        provider.api = 'openai-responses';
        const model = provider.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        model.compat = { thinking_format: 'deepseek' };
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('cannot set thinking_format for api openai-responses');
  });

  test('accepts the selected compat fields for an OpenAI completions adapter', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const provider = config.providers.agent;
        if (provider?.kind !== 'custom') {
          throw new Error('Expected custom agent provider fixture');
        }
        provider.api = 'openai-completions';
        const model = provider.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        model.compat = {
          supports_developer_role: false,
          thinking_format: 'openrouter',
          max_tokens_field: 'max_tokens',
          requires_reasoning_content: true,
          cache_control_format: 'anthropic',
        };
      }),
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.fileConfig.providers.agent?.models[0]?.compat).toMatchObject({ thinking_format: 'openrouter' });
  });

  test('accepts the minimal tool-schema keyword profile on any adapter', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const model = config.providers.agent?.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        model.tool_schema_keywords = 'minimal';
      }),
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.fileConfig.providers.agent?.models[0]?.tool_schema_keywords).toBe('minimal');
    expect(configuredToolSchemaKeywords(loaded.config, 'agent', 'agent-model')).toBe('minimal');
  });

  test('rejects a tool-schema keyword profile the runtime does not implement', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const model = config.providers.agent?.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        model.tool_schema_keywords = 'full' as never;
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('rejects thinking levels on a model that does not reason', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const model = config.providers.vision?.models[0];
        if (model === undefined) {
          throw new Error('Expected a vision model fixture');
        }
        model.thinking_levels = ['off', 'low'];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('declares thinking_levels but is not a reasoning model');
  });

  test('rejects an agent thinking level the agent model does not accept', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const model = config.providers.agent?.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        model.thinking_levels = ['off', 'high', 'max'];
        config.agent.thinking_level = 'low';
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(
      'agent.thinking_level low is not supported by agent/agent-model (supported: off, high, max)',
    );
  });

  test('offers xhigh and max only to a model that declares them', async () => {
    const { directory, configPath } = await fixture();
    // Undeclared, a reasoning model gets Pi's default, which stops at high.
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.agent.thinking_level = 'max';
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('(supported: off, minimal, low, medium, high)');
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const model = config.providers.agent?.models[0];
        if (model === undefined) {
          throw new Error('Expected an agent model fixture');
        }
        model.thinking_levels = ['max', 'high'];
        config.agent.thinking_level = 'max';
      }),
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.config.agent.thinking_level).toBe('max');
  });

  test('rejects a provider alias that cannot survive a URL path or restart string', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.providers['bad alias'] = {
          kind: 'custom',
          base_url: 'https://example.test/v1',
          api: 'openai-completions',
          api_key: { jar: 'agent' },
          models: [
            {
              id: 'model',
              reasoning: false,
              input: ['text'],
              context_window: 1_000,
              max_tokens: 100,
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            },
          ],
        };
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('must match');
  });

  test('rejects a builtin provider without a model list', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.providers.builtin = { kind: 'builtin', provider: 'openrouter', api_key: { jar: 'agent' } } as never;
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('rejects a builtin provider whose catalog is not supported', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.providers.unsupported = {
          kind: 'builtin',
          provider: 'mistral',
          api_key: { jar: 'agent' },
          models: [
            {
              id: 'mistral-large-latest',
              reasoning: false,
              input: ['text'],
              context_window: 128_000,
              max_tokens: 8_192,
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            },
          ],
        };
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('does not expose a single supported API');
  });

  test('rejects an agent model a builtin provider does not list', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.providers.builtin = {
          kind: 'builtin',
          provider: 'deepseek',
          api_key: { jar: 'agent' },
          models: [
            {
              id: 'deepseek-chat',
              reasoning: false,
              input: ['text'],
              context_window: 128_000,
              max_tokens: 8_192,
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            },
          ],
        };
        config.agent.provider = 'builtin';
        config.agent.model = 'deepseek-reasoner';
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('deepseek-reasoner is absent from provider builtin');
  });

  test('rejects a leftover max_output_tokens in the agent section', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => Object.assign(config.agent, { max_output_tokens: 4096 })),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('accepts chat-scoped ignored Telegram user IDs', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const chat = config.telegram.chats[0];
        if (chat === undefined) {
          throw new Error('Expected chat fixture');
        }
        chat.ignored_user_ids = [42, 99];
      }),
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.config.telegram.chats[0]?.ignored_user_ids).toEqual([42, 99]);
  });

  test('rejects invalid chat-scoped ignored Telegram user IDs', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const chat = config.telegram.chats[0];
        if (chat === undefined) {
          throw new Error('Expected chat fixture');
        }
        chat.ignored_user_ids = [0];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const chat = config.telegram.chats[0];
        if (chat === undefined) {
          throw new Error('Expected chat fixture');
        }
        chat.ignored_user_ids = [42, 42];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        const chat = config.telegram.chats[0];
        if (chat === undefined) {
          throw new Error('Expected chat fixture');
        }
        chat.ignored_user_ids = [9_007_199_254_740_992];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid ignored Telegram user ID in chat 123456789');
  });

  test('accepts configured telegram admin user IDs', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.admins = [42, 99];
      }),
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.config.telegram.admins).toEqual([42, 99]);
  });

  test('rejects invalid telegram admin user IDs', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.admins = [0];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.admins = [9_007_199_254_740_992];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid Telegram admin user ID');
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        config.telegram.admins = [42, 42];
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  test('accepts JSONC comments and trailing commas', async () => {
    const { directory, configPath } = await fixture();
    const source = testConfigJsonc(directory)
      .replace('{', '{\n  // Operator-managed configuration')
      .replace('"version": 1,', '"version": 1, /* schema version */');
    await writeFile(configPath, source.replace(/\n}\n$/, ',\n}\n'));
    expect((await loadConfig(configPath)).config.version).toBe(1);
  });

  test('rejects invalid JSONC syntax', async () => {
    const { configPath } = await fixture();
    await writeFile(configPath, '{ "version": 1,, }');
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid JSONC');
  });

  test('strips HTML comments from prompt files', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory),
      '# Persona\n<!-- Why this rule exists: operators read the file too -->\nStay kind.\n',
      'private<!-- and keep quiet -->',
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.config.agent.system_prompt).toBe('# Persona\nStay kind.\n');
    expect(loaded.config.telegram.chats[0]?.instructions).toBe('private');
  });

  test('ignores template expressions inside prompt annotations', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(
      directory,
      configPath,
      testConfigJsonc(directory),
      'You run as {{ agent.model }}.<!-- {{ agent.api_key }} is an annotation, not a template -->',
    );
    const loaded = await loadConfig(configPath);
    expect(loaded.config.agent.system_prompt).toBe('You run as {{ agent.model }}.');
  });

  test('a comment-only prompt edit still changes the config hash', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(directory, configPath, testConfigJsonc(directory), '# Persona\nStay kind.\n');
    const plain = await loadConfig(configPath);
    await writeTestConfig(directory, configPath, testConfigJsonc(directory), '# Persona\n<!-- note -->\nStay kind.\n');
    const annotated = await loadConfig(configPath);
    expect(annotated.config.agent.system_prompt).toBe(plain.config.agent.system_prompt);
    expect(annotated.hash).not.toBe(plain.hash);
  });

  test('rejects a system prompt that holds nothing but annotations', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(directory, configPath, testConfigJsonc(directory), '<!-- TODO: write the persona -->\n');
    await expect(loadConfig(configPath)).rejects.toThrow('is empty or contains only HTML comments');
  });

  test('rejects a prompt file containing a NUL character', async () => {
    const { directory, configPath } = await fixture();
    await writeTestConfig(directory, configPath, testConfigJsonc(directory), 'Persona\u0000here');
    await expect(loadConfig(configPath)).rejects.toThrow('contains a NUL character');
  });
});

describe('key jar', () => {
  test('names every plaintext secret instead of failing a union', async () => {
    const { directory, configPath } = await fixture();
    await writeFile(
      configPath,
      testConfigJsonc(directory, (config) => {
        (config.telegram as { token: unknown }).token = 'telegram-literal';
        const agent = config.providers.agent;
        if (agent?.kind === 'custom') {
          (agent as { headers: unknown }).headers = { 'x-route': 'header-literal', 'x-env': { env: 'ROUTE' } };
        }
      }),
    );
    const message = await loadConfig(configPath).then(
      () => '',
      (error: unknown) => (error as Error).message,
    );
    expect(message).toContain('plaintext secrets are not accepted');
    expect(message).toContain('telegram.token, providers.agent.headers.x-route');
    expect(message).not.toContain('x-env');
    expect(message).not.toContain('literal');
  });

  test('stores secret edits in the jar and drops the entries the file stops using', async () => {
    const { configPath } = await fixture();
    const jar = keyJarPath(configPath);
    await writeConfigEdits(configPath, [secretEdit(['providers', 'agent', 'api_key'], 'agent-rotated-key')]);
    const text = await readFile(configPath, 'utf8');
    expect(text).not.toContain('agent-rotated-key');
    const { fileConfig } = await loadConfig(configPath);
    const reference = fileConfig.providers.agent?.api_key as { jar: string };
    expect(reference.jar).toMatch(/^[0-9a-f]{16}$/);
    const stored = JSON.parse(await readFile(jar, 'utf8')) as Record<string, string>;
    // The replaced `agent` entry is gone; the untouched ones stay.
    expect(stored).toEqual({
      telegram: 'telegram-secret',
      vision: 'vision-secret',
      [reference.jar]: 'agent-rotated-key',
    });
    expect(await new SecretStore(jar).resolve(reference)).toBe('agent-rotated-key');

    // A rejected edit leaves neither file changed.
    await expect(
      writeConfigEdits(configPath, [
        secretEdit(['providers', 'vision', 'api_key'], 'never-stored'),
        { path: ['agent', 'model'], value: 'absent-model' },
      ]),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(await readFile(configPath, 'utf8')).toBe(text);
    expect(JSON.parse(await readFile(jar, 'utf8'))).toEqual(stored);
  });
});

describe('secrets', () => {
  test('removes one trailing newline and redacts exact values', async () => {
    const store = new SecretStore();
    const value = await store.resolve({ command: [process.execPath, '-e', "process.stdout.write('secret-value\\n')"] });
    expect(value).toBe('secret-value');
    expect(store.redact('failed secret-value request')).toBe('failed [REDACTED] request');
  });

  test('redacts a secret in full when another known secret is its prefix or overlaps it', () => {
    const store = new SecretStore();
    // Submission order used to decide the result: the shorter value replaced
    // first and left the longer one's tail in the clear.
    store.remember('abcdef-short');
    store.remember('abcdef-short-and-long');
    store.remember('xyz-overlap-1');
    store.remember('overlap-1-tail');
    expect(store.redact('key=abcdef-short-and-long;')).toBe('key=[REDACTED];');
    expect(store.redact('a abcdef-short b')).toBe('a [REDACTED] b');
    expect(store.redact('[xyz-overlap-1-tail]')).toBe('[[REDACTED]]');
    expect(store.redact('abcdef-short abcdef-short')).toBe('[REDACTED] [REDACTED]');
    expect(store.redact('nothing to hide')).toBe('nothing to hide');
  });

  test('keeps submitted plaintext redactable without letting it accumulate', async () => {
    const { directory, configPath } = await fixture();
    await writeTestKeyJar(directory, { configured: 'configured-api-key' });
    const store = new SecretStore(keyJarPath(configPath));
    const configured = await store.resolve({ jar: 'configured' });
    store.remember('submitted-api-key');
    expect(configured).toBe('configured-api-key');
    expect(store.redact('sent submitted-api-key upstream')).toBe('sent [REDACTED] upstream');
    // A session that keeps submitting keys must not grow the store forever, and
    // the configured secret is not what gets dropped.
    for (let index = 0; index < 200; index += 1) {
      store.remember(`throwaway-key-${String(index)}`);
    }
    expect(store.redact('sent submitted-api-key upstream')).toBe('sent submitted-api-key upstream');
    expect(store.redact('sent throwaway-key-199 upstream')).toBe('sent [REDACTED] upstream');
    expect(store.redact('sent configured-api-key upstream')).toBe('sent [REDACTED] upstream');
  });

  test('resolves key jar entries and redacts them', async () => {
    const { directory, configPath } = await fixture();
    await writeTestKeyJar(directory, { relay: 'relay-api-key' });
    const store = new SecretStore(keyJarPath(configPath));
    expect(await store.resolve({ jar: 'relay' })).toBe('relay-api-key');
    expect(store.redact('sent relay-api-key upstream')).toBe('sent [REDACTED] upstream');
    await expect(store.resolve({ jar: 'missing' })).rejects.toThrow('Key jar has no entry missing');
    // Inherited object members are not entries.
    await expect(store.resolve({ jar: 'constructor' })).rejects.toThrow('Key jar has no entry constructor');
    await expect(new SecretStore().resolve({ jar: 'relay' })).rejects.toThrow('No key jar is configured');
  });

  test('reports a broken key jar without quoting it', async () => {
    const { configPath } = await fixture();
    const jar = keyJarPath(configPath);
    const store = new SecretStore(jar);
    await unlink(jar);
    await expect(store.resolve({ jar: 'agent' })).rejects.toThrow('Key jar does not exist');
    // A parse error would echo the text around the fault, which is a secret.
    await writeFile(jar, '{ "agent": "sk-leaky-value" ', { mode: 0o600 });
    const invalid = await store.resolve({ jar: 'agent' }).catch((error: unknown) => error as Error);
    expect(invalid).toMatchObject({ name: 'SecretResolutionError', message: `Key jar is not valid JSON: ${jar}` });
    await writeFile(jar, '{ "agent": 42 }');
    await expect(store.resolve({ jar: 'agent' })).rejects.toThrow('JSON object of non-empty strings');
    if (process.platform !== 'win32') {
      await writeFile(jar, '{ "agent": "agent-secret" }');
      await chmod(jar, 0o644);
      await expect(store.resolve({ jar: 'agent' })).rejects.toThrow('Key jar must have mode 0600');
    }
  });

  test('does not turn a very short value into a redaction pattern', () => {
    const store = new SecretStore();
    store.remember('1');
    expect(store.redact('providers.relay.models[0] failed with status 1')).toBe(
      'providers.relay.models[0] failed with status 1',
    );
  });
});

describe('database', () => {
  test('closing the store invalidates prepared ORM queries and releases the file', async () => {
    const { configPath } = await fixture();
    const { config } = await loadConfig(configPath);
    const store = await SqliteStore.open(config);
    try {
      const prepared = store.orm.select().from(schemaMigrations).prepare();
      expect(prepared.all()).toHaveLength(30);
      store.close();
      expect(() => prepared.all()).toThrow();
      await unlink(config.paths.database);
      expect(await pathExists(config.paths.database)).toBe(false);
    } finally {
      store.db.close();
    }
  });

  test('applies migrations, creates a consistent backup, and releases the source file', async () => {
    const { configPath } = await fixture();
    const { config } = await loadConfig(configPath);
    const store = await SqliteStore.open(config);
    try {
      const version = store.db
        .prepare<[], { version: bigint }>('SELECT MAX(version) AS version FROM schema_migrations')
        .get();
      expect(version?.version).toBe(30n);
    } finally {
      store.close();
    }

    const backupPath = await backupDatabase(config);
    expect(await pathExists(backupPath)).toBe(true);
    await unlink(config.paths.database);
    expect(await pathExists(config.paths.database)).toBe(false);
  });

  test('a failed backup releases the source file after running ORM queries', async () => {
    const { configPath } = await fixture();
    const { config } = await loadConfig(configPath);
    const store = await SqliteStore.open(config);
    try {
      store.db.exec('DROP TABLE telegram_updates');
    } finally {
      store.close();
    }

    await expect(backupDatabase(config)).rejects.toThrow('telegram_updates');
    await unlink(config.paths.database);
    expect(await pathExists(config.paths.database)).toBe(false);
  });
});
