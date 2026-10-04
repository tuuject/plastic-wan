import { afterAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FileConfig, loadConfig } from '../src/platform/config.ts';
import { diffConfig, type ConfigChange } from '../src/platform/config-diff.ts';
import { testConfigJsonc, writeTestConfig } from './helpers.ts';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

async function loadBoth(
  transform?: (config: FileConfig) => void,
  fileTransform?: (config: FileConfig) => void,
): Promise<{
  active: Awaited<ReturnType<typeof loadConfig>>;
  file: Awaited<ReturnType<typeof loadConfig>>;
  activeJsonc: (next: (config: FileConfig) => void) => string;
  directory: string;
  configPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-diff-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath, testConfigJsonc(directory, transform));
  const active = await loadConfig(configPath);
  const fileJsonc = testConfigJsonc(directory, (config) => {
    transform?.(config);
    fileTransform?.(config);
  });
  await writeTestConfig(directory, configPath, fileJsonc);
  const file = await loadConfig(configPath);
  return {
    active,
    file,
    directory,
    configPath,
    activeJsonc: (next) =>
      testConfigJsonc(directory, (config) => {
        transform?.(config);
        next(config);
      }),
  };
}

function paths(changes: readonly ConfigChange[], kind: ConfigChange['kind']): string[] {
  return changes.filter((change) => change.kind === kind).map((change) => change.path);
}

type ProviderEntry = FileConfig['providers'][string];
type ModelEntry = Extract<ProviderEntry, { kind: 'custom' }>['models'][number];

function spareModel(): ModelEntry {
  return {
    id: 'spare',
    reasoning: false,
    input: ['text'],
    context_window: 64_000,
    max_tokens: 4_096,
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
  };
}

function customModels(config: FileConfig, alias: string): readonly ModelEntry[] {
  const provider = config.providers[alias];
  if (provider === undefined || provider.kind !== 'custom') {
    throw new Error(`Expected a custom provider fixture: ${alias}`);
  }
  return provider.models;
}

test('classifies hot, restart and outside-serve fields', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.agent.thinking_level = 'high';
    config.agent.send_max_text_length = 100;
    config.agent.rate_limits.turns_per_injection = 3;
    config.agent.context.idle_grace_seconds = 40;
    config.agent.daily_budget.max_tokens = 400_000;
    config.agent.max_concurrency = 8;
    config.agent.history_messages = 5;
    config.retention.online_days = 7;
    config.paths.backups = config.paths.backups.replace('backups', 'backups2');
    config.telegram.bucket_window_seconds = 30;
    config.vision.max_output_tokens = 4096;
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'agent.context.idle_grace_seconds',
    'agent.daily_budget.max_tokens',
    'agent.history_messages',
    'agent.max_concurrency',
    'agent.rate_limits.turns_per_injection',
    'agent.send_max_text_length',
    'agent.thinking_level',
    'vision.max_output_tokens',
  ]);
  expect(paths(diff.changes, 'outside_serve')).toEqual(['paths.backups', 'retention.online_days']);
  expect(paths(diff.changes, 'restart')).toEqual(['telegram.bucket_window_seconds']);
  // Hot and outside-serve values come from the file; restart-only values stay.
  expect(diff.candidate.file.agent.thinking_level).toBe('high');
  expect(diff.candidate.file.agent.history_messages).toBe(5);
  expect(diff.candidate.file.retention.online_days).toBe(7);
  expect(diff.candidate.file.telegram.bucket_window_seconds).toBe(15);
  expect(diff.candidate.file.vision.max_output_tokens).toBe(4096);
  expect(diff.candidate.raw.agent.thinking_level).toBe('high');
});

test('reports prompt content and path changes on the prompt field', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plasticwan-diff-prompt-'));
  directories.push(directory);
  const configPath = join(directory, 'config.jsonc');
  await writeTestConfig(directory, configPath);
  const active = await loadConfig(configPath);
  await writeTestConfig(directory, configPath, testConfigJsonc(directory), 'A different prompt.');
  const file = await loadConfig(configPath);
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['agent.system_prompt_file']);
  expect(diff.candidate.raw.agent.system_prompt).toBe('A different prompt.');
});

test('aligns chats by id: additions are hot while removals wait for a restart', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats = [{ id: 111 }];
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual(['telegram.chats[123456789]']);
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[111]']);
  // The removed chat waits for a restart and keeps the active instructions; the
  // added chat is adopted immediately with its file instructions ('' here).
  expect(diff.candidate.file.telegram.chats.map((chat) => chat.id)).toEqual([123456789, 111]);
  expect(diff.candidate.raw.telegram.chats.map((chat) => chat.instructions)).toEqual(['private', '']);
});

test('adding a chat is hot and the candidate adopts it in file order', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats.push({ id: -987654321 });
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[-987654321]']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.telegram.chats.map((chat) => chat.id)).toEqual([123456789, -987654321]);
  expect(diff.candidate.raw.telegram.chats.map((chat) => chat.id)).toEqual([123456789, -987654321]);
});

test('treats a chat field other than instructions as restart-only', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats[0]!.timezone = 'Asia/Tokyo';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual(['telegram.chats[123456789].timezone']);
  expect(diff.candidate.file.telegram.chats[0]?.timezone).toBeUndefined();
});

test('adds, removes and edits provider models as hot changes in file order', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.providers.spare = {
        kind: 'custom',
        base_url: 'https://example.test/v1',
        api: 'openai-responses',
        api_key: { jar: 'spare' },
        models: [
          { ...spareModel(), id: 'spare-a' },
          { ...spareModel(), id: 'spare-b' },
        ],
      };
    },
    (config) => {
      const provider = config.providers.spare;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected a custom provider fixture');
      }
      provider.models = [
        { ...spareModel(), id: 'spare-b', context_window: 100_000 },
        { ...spareModel(), id: 'spare-c' },
      ];
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'providers.spare.models[spare-a]',
    'providers.spare.models[spare-b]',
    'providers.spare.models[spare-c]',
  ]);
  expect(customModels(diff.candidate.file, 'spare').map((model) => [model.id, model.context_window])).toEqual([
    ['spare-b', 100_000],
    ['spare-c', 64_000],
  ]);
});

test('takes the file definition of a model the candidate still uses', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Expected a custom provider fixture');
    }
    provider.models[0]!.context_window = 100_000;
    // The vision model is in use too, and its definition is as hot as any other.
    const vision = config.providers.vision;
    if (vision?.kind !== 'custom') {
      throw new Error('Expected a custom vision provider fixture');
    }
    vision.models[0]!.max_tokens = 4096;
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'providers.agent.models[agent-model]',
    'providers.vision.models[vision-model]',
  ]);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(customModels(diff.candidate.file, 'agent').map((model) => model.context_window)).toEqual([100_000]);
  expect(customModels(diff.candidate.file, 'vision').map((model) => model.max_tokens)).toEqual([4096]);
});

test('a model is hot once the agent points at another one', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Expected a custom provider fixture');
    }
    provider.models = [
      { ...provider.models[0]!, context_window: 100_000 },
      { ...provider.models[0]!, id: 'agent-model-2' },
    ];
    config.agent.model = 'agent-model-2';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'agent.model',
    'providers.agent.models[agent-model-2]',
    'providers.agent.models[agent-model]',
  ]);
  expect(customModels(diff.candidate.file, 'agent').map((model) => [model.id, model.context_window])).toEqual([
    ['agent-model', 100_000],
    ['agent-model-2', 200_000],
  ]);
});

test('editing the model the agent switches to in the same change is hot', async () => {
  // The target is not in use yet, so its new definition applies together with
  // the switch instead of waiting for a restart.
  const { active, file } = await loadBoth(
    (config) => {
      const provider = config.providers.agent;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected a custom provider fixture');
      }
      provider.models = [provider.models[0]!, { ...provider.models[0]!, id: 'agent-model-2' }];
    },
    (config) => {
      const provider = config.providers.agent;
      if (provider?.kind !== 'custom') {
        throw new Error('Expected a custom provider fixture');
      }
      provider.models[1]!.context_window = 100_000;
      config.agent.model = 'agent-model-2';
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['agent.model', 'providers.agent.models[agent-model-2]']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(customModels(diff.candidate.file, 'agent').map((model) => [model.id, model.context_window])).toEqual([
    ['agent-model', 200_000],
    ['agent-model-2', 100_000],
  ]);
});

test('an agent pointing at a new provider is hot', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.providers.extra = {
      kind: 'custom',
      base_url: 'https://example.test/v1',
      api: 'openai-responses',
      api_key: { jar: 'extra' },
      models: [
        {
          id: 'extra-model',
          reasoning: true,
          input: ['text'],
          context_window: 64_000,
          max_tokens: 4_096,
          cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
        },
      ],
    };
    config.agent.provider = 'extra';
    config.agent.model = 'extra-model';
    config.agent.thinking_level = 'high';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'agent.model',
    'agent.provider',
    'agent.thinking_level',
    'providers.extra',
  ]);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.agent).toMatchObject({ provider: 'extra', model: 'extra-model' });
  expect(diff.candidate.file.providers.extra).toMatchObject({ kind: 'custom', base_url: 'https://example.test/v1' });
});

test('removes a provider as a hot change', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.providers.spare = {
        kind: 'custom',
        base_url: 'https://example.test/v1',
        api: 'openai-responses',
        api_key: { jar: 'spare' },
        models: [spareModel()],
      };
    },
    (config) => {
      delete config.providers.spare;
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['providers.spare']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.providers.spare).toBeUndefined();
});

test('re-kinding a provider is hot and takes the file definition', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.providers.spare = {
        kind: 'custom',
        base_url: 'https://example.test/v1',
        api: 'openai-responses',
        api_key: { jar: 'spare' },
        models: [spareModel()],
      };
    },
    (config) => {
      config.providers.spare = {
        kind: 'builtin',
        provider: 'deepseek',
        api_key: { jar: 'spare' },
        models: [spareModel()],
      };
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['providers.spare']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.providers.spare).toMatchObject({ kind: 'builtin', provider: 'deepseek' });
});

test('a provider connection change is hot and takes the file provider', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    const provider = config.providers.agent;
    if (provider?.kind !== 'custom') {
      throw new Error('Expected a custom provider fixture');
    }
    provider.base_url = 'https://other.test/v1';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['providers.agent.base_url']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.providers.agent).toMatchObject({ base_url: 'https://other.test/v1' });
});

// --- Chat provider/model/thinking_level overrides are hot ---

test('adding a chat provider + model override is hot', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats[0]!.provider = 'agent';
    config.telegram.chats[0]!.model = 'agent-model';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[123456789].model', 'telegram.chats[123456789].provider']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.telegram.chats[0]?.provider).toBe('agent');
  expect(diff.candidate.file.telegram.chats[0]?.model).toBe('agent-model');
});

test('modifying a chat provider override is hot and takes the file value', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.telegram.chats[0]!.provider = 'agent';
      config.telegram.chats[0]!.model = 'agent-model';
    },
    (config) => {
      config.telegram.chats[0]!.provider = 'vision';
      config.telegram.chats[0]!.model = 'vision-model';
      config.telegram.chats[0]!.thinking_level = 'off';
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual([
    'telegram.chats[123456789].model',
    'telegram.chats[123456789].provider',
    'telegram.chats[123456789].thinking_level',
  ]);
  expect(diff.candidate.file.telegram.chats[0]?.provider).toBe('vision');
  expect(diff.candidate.file.telegram.chats[0]?.model).toBe('vision-model');
});

test('removing a chat provider override is hot and drops it from the candidate', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.telegram.chats[0]!.provider = 'agent';
      config.telegram.chats[0]!.model = 'agent-model';
    },
    (config) => {
      delete (config.telegram.chats[0] as Record<string, unknown>).provider;
      delete (config.telegram.chats[0] as Record<string, unknown>).model;
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[123456789].model', 'telegram.chats[123456789].provider']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.telegram.chats[0]?.provider).toBeUndefined();
  expect(diff.candidate.file.telegram.chats[0]?.model).toBeUndefined();
});

test('setting a chat thinking_level override is hot', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats[0]!.thinking_level = 'high';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[123456789].thinking_level']);
  expect(paths(diff.changes, 'restart')).toEqual([]);
  expect(diff.candidate.file.telegram.chats[0]?.thinking_level).toBe('high');
});

test('removing a chat thinking_level override is hot', async () => {
  const { active, file } = await loadBoth(
    (config) => {
      config.telegram.chats[0]!.thinking_level = 'high';
    },
    (config) => {
      delete (config.telegram.chats[0] as Record<string, unknown>).thinking_level;
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[123456789].thinking_level']);
  expect(diff.candidate.file.telegram.chats[0]?.thinking_level).toBeUndefined();
});

test('chat override is hot even when a restart-only field changes in the same chat', async () => {
  const { active, file } = await loadBoth(undefined, (config) => {
    config.telegram.chats[0]!.provider = 'agent';
    config.telegram.chats[0]!.model = 'agent-model';
    config.telegram.chats[0]!.timezone = 'Asia/Tokyo';
  });
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  // Override fields are hot; timezone is restart-only
  expect(paths(diff.changes, 'hot')).toEqual(['telegram.chats[123456789].model', 'telegram.chats[123456789].provider']);
  expect(paths(diff.changes, 'restart')).toEqual(['telegram.chats[123456789].timezone']);
  expect(diff.candidate.file.telegram.chats[0]?.provider).toBe('agent');
  expect(diff.candidate.file.telegram.chats[0]?.model).toBe('agent-model');
  // Restart-only field keeps the active value
  expect(diff.candidate.file.telegram.chats[0]?.timezone).toBeUndefined();
});

test('chat override persists after an unrelated chat is removed (ID-based merge)', async () => {
  // Active has two chats, one with an override
  // File removes the chat without override; the override chat survives
  const { active, file } = await loadBoth(
    (config) => {
      config.telegram.chats.push({ id: -987654321 });
      config.telegram.chats[0]!.provider = 'agent';
      config.telegram.chats[0]!.model = 'agent-model';
    },
    (config) => {
      // File only has the override chat (the non-override chat is removed)
      config.telegram.chats = [{ id: 123456789, provider: 'agent', model: 'agent-model' }];
    },
  );
  const diff = diffConfig({ file: active.fileConfig, raw: active.config }, { file: file.fileConfig, raw: file.config });
  expect(paths(diff.changes, 'restart')).toEqual(['telegram.chats[-987654321]']);
  // The override chat should still be present with its override
  const chat = diff.candidate.file.telegram.chats.find((c) => c.id === 123456789);
  expect(chat?.provider).toBe('agent');
  expect(chat?.model).toBe('agent-model');
  // New chat in file
  expect(diff.candidate.file.telegram.chats.map((c) => c.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([
    -987654321, 123456789,
  ]);
});
