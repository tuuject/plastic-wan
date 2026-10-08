import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Api, type Context, getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, test } from 'vitest';
import { findBuiltinProvider } from '../src/platform/builtin-providers.ts';
import { type FileConfig, type LoadedConfig, loadConfig, type RawConfig } from '../src/platform/config.ts';
import { keyJarPath } from '../src/platform/key-jar.ts';
import { buildModelRegistry, configuredAgentModels, mapCompat } from '../src/platform/providers.ts';
import { SecretStore } from '../src/platform/secrets.ts';
import { supportedThinkingLevels, THINKING_LEVELS } from '../src/platform/thinking-levels.ts';
import { testConfigJsonc, writeTestConfig, writeTestKeyJar } from './helpers.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function loadFixture(transform: (config: FileConfig) => void): Promise<LoadedConfig> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-providers-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  await writeTestKeyJar(directory, { builtin: 'builtin-secret', custom: 'custom-secret', rotated: 'rotated-secret' });
  return await loadConfig(configPath);
}

/** Counts SecretRef resolutions, so a rebuild can be shown to skip them. */
class CountingSecrets extends SecretStore {
  resolutions = 0;

  override async resolve(reference: Parameters<SecretStore['resolve']>[0]): Promise<string> {
    this.resolutions += 1;
    return await super.resolve(reference);
  }
}

function deepseekConfig(loaded: LoadedConfig): Extract<RawConfig['providers'][string], { kind: 'builtin' }> {
  const provider = loaded.config.providers.deepseek;
  if (provider === undefined || provider.kind !== 'builtin') {
    throw new Error('Expected the deepseek builtin provider fixture');
  }
  return provider;
}

const BUILTIN_MODEL = {
  id: 'deepseek-chat',
  name: 'DeepSeek Chat',
  reasoning: false,
  input: ['text' as const],
  context_window: 128_000,
  max_tokens: 8_192,
  cost: { input: 0.27, output: 1.1, cache_read: 0.07, cache_write: 0.27 },
};

describe('model registry', () => {
  test('enumerates every selected model and thinking pair without duplicate probes', async () => {
    const loaded = await loadFixture((config) => {
      config.telegram.chats = [
        { id: -1 },
        { id: -2, provider: 'agent', model: 'agent-model' },
        { id: -3, thinking_level: 'high' },
        { id: -4, provider: 'vision', model: 'vision-model', thinking_level: 'off' },
        { id: -5, provider: 'vision', model: 'vision-model', thinking_level: 'off' },
      ];
    });
    const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(loaded.configPath)));
    expect(
      configuredAgentModels(loaded.config, registry.models).map(({ model, thinkingLevel }) => ({
        provider: model.provider,
        model: model.id,
        thinkingLevel,
      })),
    ).toEqual([
      { provider: 'agent', model: 'agent-model', thinkingLevel: 'low' },
      { provider: 'agent', model: 'agent-model', thinkingLevel: 'high' },
      { provider: 'vision', model: 'vision-model', thinkingLevel: 'off' },
    ]);
  });

  test('registers only the models a builtin provider lists in the configuration', async () => {
    const loaded = await loadFixture((draft) => {
      draft.providers.deepseek = {
        kind: 'builtin',
        provider: 'deepseek',
        api_key: { jar: 'builtin' },
        models: [BUILTIN_MODEL],
      };
      draft.agent.provider = 'deepseek';
      draft.agent.model = 'deepseek-chat';
      draft.agent.thinking_level = 'off';
    });
    const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(loaded.configPath)));
    const registered = registry.models.getModels('deepseek');
    expect(registered.map((model) => model.id)).toEqual(['deepseek-chat']);
    // Pi's catalog carries this id; the configuration does not enable it.
    expect(registry.models.getModel('deepseek', 'deepseek-reasoner')).toBeUndefined();
    expect(registered[0]).toMatchObject({
      api: 'openai-completions',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
  });

  test('sends builtin requests under Pi’s own provider id', async () => {
    const loaded = await loadFixture((draft) => {
      draft.providers.mine = {
        kind: 'builtin',
        provider: 'deepseek',
        api_key: { jar: 'builtin' },
        models: [BUILTIN_MODEL],
      };
      draft.agent.provider = 'mine';
      draft.agent.model = 'deepseek-chat';
      draft.agent.thinking_level = 'off';
    });
    const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(loaded.configPath)));
    const provider = registry.models.getProvider('mine');
    const model = registry.models.getModel('mine', 'deepseek-chat');
    expect(provider).toBeDefined();
    expect(model).toBeDefined();
    if (provider === undefined || model === undefined) {
      throw new Error('Expected the builtin alias to be registered');
    }
    expect(provider.id).toBe('mine');
    expect(model.provider).toBe('mine');

    const source = findBuiltinProvider('deepseek');
    if (source === undefined) {
      throw new Error('Expected Pi to ship the deepseek provider');
    }
    const original = source.streamSimple;
    let observed: string | null = null;
    Object.assign(source, {
      streamSimple: (candidate: Model<Api>) => {
        observed = candidate.provider;
        throw new Error('stream-stop');
      },
    });
    try {
      expect(() => provider.streamSimple(model, {} as Context)).toThrow('stream-stop');
    } finally {
      Object.assign(source, { streamSimple: original });
    }
    // Automatic compat detection keys off the provider id, so the alias must not
    // reach the request.
    expect(observed).toBe('deepseek');
  });

  test('keeps a provider whose connection is unchanged and re-resolves no secret', async () => {
    const loaded = await loadFixture((draft) => {
      draft.providers.deepseek = {
        kind: 'builtin',
        provider: 'deepseek',
        api_key: { jar: 'builtin' },
        models: [BUILTIN_MODEL],
      };
      draft.agent.provider = 'deepseek';
      draft.agent.model = 'deepseek-chat';
      draft.agent.thinking_level = 'off';
    });
    const secrets = new CountingSecrets(keyJarPath(loaded.configPath));
    const registry = await buildModelRegistry(loaded.config, null, secrets);
    const resolvedAtStartup = secrets.resolutions;
    expect(resolvedAtStartup).toBeGreaterThan(0);
    const before = registry.models.getProvider('deepseek');

    // Same alias, same connection, a longer model list: the provider object is
    // reused, so a `command` SecretRef never runs a second time.
    const extended: RawConfig = {
      ...loaded.config,
      providers: {
        ...loaded.config.providers,
        deepseek: {
          ...deepseekConfig(loaded),
          models: [
            BUILTIN_MODEL,
            { ...BUILTIN_MODEL, id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: true },
          ],
        },
      },
    };
    const rebuilt = await buildModelRegistry(extended, { file: loaded.fileConfig, models: registry.models }, secrets);
    expect(secrets.resolutions).toBe(resolvedAtStartup);
    const after = rebuilt.models.getProvider('deepseek');
    expect(after?.auth).toBe(before?.auth);
    expect(after?.baseUrl).toBe('https://api.deepseek.com');
    expect(after?.getModels().map((model) => model.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(after?.getModels()[0]?.provider).toBe('deepseek');
  });

  test('rebuilds a provider whose connection changed and resolves its secret again', async () => {
    const loaded = await loadFixture((draft) => {
      draft.providers.deepseek = {
        kind: 'builtin',
        provider: 'deepseek',
        api_key: { jar: 'builtin' },
        models: [BUILTIN_MODEL],
      };
      draft.agent.provider = 'deepseek';
      draft.agent.model = 'deepseek-chat';
      draft.agent.thinking_level = 'off';
    });
    const secrets = new CountingSecrets(keyJarPath(loaded.configPath));
    const registry = await buildModelRegistry(loaded.config, null, secrets);
    const resolvedAtStartup = secrets.resolutions;

    const rotated: RawConfig = {
      ...loaded.config,
      providers: {
        ...loaded.config.providers,
        deepseek: { ...deepseekConfig(loaded), api_key: { jar: 'rotated' } },
      },
    };
    const rebuilt = await buildModelRegistry(rotated, { file: loaded.fileConfig, models: registry.models }, secrets);
    expect(secrets.resolutions).toBe(resolvedAtStartup + 1);
    const after = rebuilt.models.getProvider('deepseek');
    expect(after).not.toBe(registry.models.getProvider('deepseek'));
    expect(after?.auth).not.toBe(registry.models.getProvider('deepseek')?.auth);
  });

  test('treats a changed builtin provider id as a new connection', async () => {
    const loaded = await loadFixture((draft) => {
      draft.providers.deepseek = {
        kind: 'builtin',
        provider: 'deepseek',
        api_key: { jar: 'builtin' },
        models: [BUILTIN_MODEL],
      };
      draft.agent.provider = 'deepseek';
      draft.agent.model = 'deepseek-chat';
      draft.agent.thinking_level = 'off';
    });
    const secrets = new CountingSecrets(keyJarPath(loaded.configPath));
    const registry = await buildModelRegistry(loaded.config, null, secrets);
    const resolvedAtStartup = secrets.resolutions;

    // Pi's own provider id decides the adapter, so it counts as the connection.
    const swapped: RawConfig = {
      ...loaded.config,
      providers: { ...loaded.config.providers, deepseek: { ...deepseekConfig(loaded), provider: 'openai' } },
    };
    const rebuilt = await buildModelRegistry(swapped, { file: loaded.fileConfig, models: registry.models }, secrets);
    expect(secrets.resolutions).toBe(resolvedAtStartup + 1);
    expect(rebuilt.models.getProvider('deepseek')).not.toBe(registry.models.getProvider('deepseek'));
  });

  test('maps the selected compat fields onto Pi’s camelCase names', () => {
    expect(
      mapCompat({
        supports_developer_role: false,
        thinking_format: 'openrouter',
        max_tokens_field: 'max_tokens',
        requires_reasoning_content: true,
        cache_control_format: 'anthropic',
      }),
    ).toEqual({
      supportsDeveloperRole: false,
      thinkingFormat: 'openrouter',
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      cacheControlFormat: 'anthropic',
    });
    expect(mapCompat({})).toBeUndefined();
  });

  test('hands Pi the same thinking levels the configuration validates against', async () => {
    const declared = [['off', 'low', 'high', 'max'], ['low', 'medium', 'xhigh'], ['high', 'off'], ['max']] as const;
    const loaded = await loadFixture((draft) => {
      const provider = draft.providers.agent;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected custom agent provider fixture');
      }
      const base = provider.models[0];
      if (base === undefined) {
        throw new Error('Expected an agent model fixture');
      }
      provider.models = [
        { ...base, id: 'undeclared' },
        { ...base, id: 'plain', reasoning: false },
        ...declared.map((levels, index) => ({ ...base, id: `declared-${index}`, thinking_levels: [...levels] })),
      ];
      draft.agent.model = 'undeclared';
    });
    const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(loaded.configPath)));
    const configured = loaded.config.providers.agent?.models ?? [];
    expect(configured).toHaveLength(2 + declared.length);
    for (const model of configured) {
      const registered = registry.models.getModel('agent', model.id);
      if (registered === undefined) {
        throw new Error(`Expected ${model.id} to be registered`);
      }
      expect(getSupportedThinkingLevels(registered)).toEqual(supportedThinkingLevels(model));
    }
    // Declared levels come back weakest first, whatever order the file uses.
    expect(supportedThinkingLevels({ reasoning: true, thinking_levels: ['high', 'off'] })).toEqual(['off', 'high']);
    // Supported levels other than xhigh / max keep the adapter's own wire value.
    expect(registry.models.getModel('agent', 'declared-0')?.thinkingLevelMap).toEqual({
      minimal: null,
      medium: null,
      xhigh: null,
      max: 'max',
    });
    expect(registry.models.getModel('agent', 'undeclared')?.thinkingLevelMap).toBeUndefined();
    expect(THINKING_LEVELS).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('registers custom models with their compat overrides', async () => {
    const loaded = await loadFixture((draft) => {
      draft.providers.agent = {
        kind: 'custom',
        base_url: 'https://relay.example.test/v1/',
        api: 'openai-completions',
        api_key: { jar: 'custom' },
        models: [
          {
            id: 'agent-model',
            reasoning: true,
            compat: { requires_reasoning_content: true },
            input: ['text', 'image'],
            context_window: 200_000,
            max_tokens: 32_768,
            cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
          },
        ],
      };
    });
    const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(loaded.configPath)));
    const model = registry.models.getModel('agent', 'agent-model');
    expect(model).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'https://relay.example.test/v1',
      compat: { requiresReasoningContentOnAssistantMessages: true },
    });
  });

  test('carries resolved custom headers onto every registered model', async () => {
    const loaded = await loadFixture((draft) => {
      const provider = draft.providers.agent;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected custom agent provider fixture');
      }
      provider.headers = { 'x-route': { jar: 'custom' } };
    });
    const registry = await buildModelRegistry(loaded.config, null, new SecretStore(keyJarPath(loaded.configPath)));
    // Pi's request path only reads headers from the model, so the resolved
    // connection headers must travel with every registered model.
    expect(registry.models.getModels('agent').map((model) => model.headers)).toEqual([{ 'x-route': 'custom-secret' }]);
  });

  test('keeps resolved custom headers on a same-connection rebuild without re-resolving secrets', async () => {
    const loaded = await loadFixture((draft) => {
      const provider = draft.providers.agent;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected custom agent provider fixture');
      }
      provider.headers = { 'x-route': { jar: 'custom' } };
    });
    const secrets = new CountingSecrets(keyJarPath(loaded.configPath));
    const registry = await buildModelRegistry(loaded.config, null, secrets);
    const resolvedAtStartup = secrets.resolutions;
    expect(resolvedAtStartup).toBeGreaterThan(0);

    // Same alias, same connection: the provider's auth and resolved headers
    // survive the rebuilt model list without resolving SecretRefs again.
    const rebuilt = await buildModelRegistry(
      loaded.config,
      { file: loaded.fileConfig, models: registry.models },
      secrets,
    );
    expect(secrets.resolutions).toBe(resolvedAtStartup);
    const after = rebuilt.models.getProvider('agent');
    expect(after?.auth).toBe(registry.models.getProvider('agent')?.auth);
    expect(rebuilt.models.getModels('agent').map((model) => model.headers)).toEqual([{ 'x-route': 'custom-secret' }]);
  });
});
