import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  aspectRatios,
  assertGenerationFitsCapability,
  generationCreateSchema,
  idempotencyKeySchema,
  imageUpdateSchema,
  modelDefinitionSchema,
  promptCreateSchema,
  promptUpdateSchema,
  removeReference,
  resolutionClasses,
  scanReferences,
} from '../src/contracts.ts';

const id = '550e8400-e29b-41d4-a716-446655440000';
test('PATCH不注入默认值且禁止空更新，Prompt禁止递归引用', () => {
  assert.deepEqual(promptUpdateSchema.parse({ name: 'rename' }), { name: 'rename' });
  assert.deepEqual(imageUpdateSchema.parse({ name: 'rename' }), { name: 'rename' });
  assert.throws(() => promptUpdateSchema.parse({}));
  assert.throws(() => imageUpdateSchema.parse({}));
  assert.throws(() => promptCreateSchema.parse({ name: 'recursive', body: `hello {{prompt:${id}}}` }));
  assert.throws(() => idempotencyKeySchema.parse('unsafe/key'));
  assert.equal(idempotencyKeySchema.parse('request:123'), 'request:123');
});
test('引用稳定、顺序明确、按身份移除所有重复出现', () => {
  const text = `draw {{prompt:${id}}} with {{image:${id}}} {{prompt:${id}}}`;
  assert.deepEqual(
    scanReferences(text).map(({ kind, id: refId }) => [kind, refId]),
    [
      ['prompt', id],
      ['image', id],
      ['prompt', id],
    ],
  );
  assert.equal(removeReference(text, 'prompt', id), `draw  with {{image:${id}}} `);
  assert.throws(() => scanReferences('{{prompt:missing}}'));
  assert.throws(() => scanReferences(`{{image:${id}}`));
  assert.throws(() => scanReferences('{{unknown:thing}}'));
});
test('生成意图默认值收敛为离散档位，扩展数据是自由形状容器', () => {
  const parsed = generationCreateSchema.parse({ authoredPrompt: 'draw', modelId: 'model' });
  assert.equal(parsed.outputCount, 1);
  assert.equal(parsed.aspectRatio, 'auto');
  assert.equal(parsed.resolution, 'auto');
  assert.equal(parsed.extendedData, undefined);
  assert.equal(
    generationCreateSchema.parse({ authoredPrompt: 'd', modelId: 'm', aspectRatio: '2:3' }).aspectRatio,
    '2:3',
  );
  // extendedData is adapter-owned: any string-keyed payload passes, unknown
  // top-level fields never do.
  assert.deepEqual(
    generationCreateSchema.parse({ authoredPrompt: 'd', modelId: 'm', extendedData: { seed: 7, nested: { a: true } } })
      .extendedData,
    { seed: 7, nested: { a: true } },
  );
  assert.throws(() => generationCreateSchema.parse({ authoredPrompt: 'd', modelId: 'm', referenceIds: [] }));
  assert.throws(() => generationCreateSchema.parse({ authoredPrompt: 'd', modelId: 'm', aspectRatio: '8:1' }));
  assert.throws(() => generationCreateSchema.parse({ authoredPrompt: 'd', modelId: 'm', quality: 'high' }));
});
test('providerTag 接受带区域的上游端点标签', () => {
  const base = {
    id: 'model',
    name: 'Model',
    provider: 'openrouter',
    upstreamModel: 'google/gemini-3-pro-image',
    credentialRef: 'openrouter',
    capabilities: {
      imageInput: true,
      maxInputImages: 14,
      maxOutputs: 1,
      aspectRatios: ['auto', '1:1'],
      resolutionClasses: ['auto', 'high'],
    },
  };
  assert.equal(
    modelDefinitionSchema.parse({ ...base, providerTag: 'google-ai-studio/global' }).providerTag,
    'google-ai-studio/global',
  );
  for (const providerTag of ['google-ai-studio/', '/global', 'a/b/c', 'google ai']) {
    assert.throws(() => modelDefinitionSchema.parse({ ...base, providerTag }));
  }
});
test('模型描述是可选备注：省略/空/1000 通过，超长或非字符串拒绝，未知字段仍拒绝', () => {
  const base = {
    id: 'model',
    name: 'Model',
    provider: 'openrouter',
    upstreamModel: 'openai/gpt-image-1',
    credentialRef: 'openrouter',
    providerTag: 'openai',
    capabilities: {
      imageInput: false,
      maxInputImages: 0,
      maxOutputs: 1,
      aspectRatios: ['auto'],
      resolutionClasses: ['auto'],
    },
  };
  const omitted = modelDefinitionSchema.parse(base);
  assert.equal(omitted.description, undefined);
  assert.equal(modelDefinitionSchema.parse({ ...base, description: '' }).description, '');
  assert.equal(modelDefinitionSchema.parse({ ...base, description: 'x'.repeat(1000) }).description, 'x'.repeat(1000));
  assert.throws(() => modelDefinitionSchema.parse({ ...base, description: 'x'.repeat(1001) }));
  assert.throws(() => modelDefinitionSchema.parse({ ...base, description: 42 }));
  // strict() survives the new field: no unknown keys sneak in alongside it.
  assert.throws(() => modelDefinitionSchema.parse({ ...base, description: 'note', notes: 'extra' }));
});
test('能力声明覆盖意图档位，不支持图片输入时不能声明输入上限', () => {
  const base = {
    id: 'model',
    name: 'Model',
    provider: 'openrouter',
    upstreamModel: 'openai/gpt-image-1',
    credentialRef: 'openrouter',
    providerTag: 'openai',
  };
  const model = modelDefinitionSchema.parse({
    ...base,
    capabilities: {
      imageInput: false,
      maxInputImages: 0,
      maxOutputs: 2,
      aspectRatios: ['auto', '1:1'],
      resolutionClasses: ['auto'],
    },
  });
  assert.throws(() =>
    modelDefinitionSchema.parse({
      ...base,
      capabilities: {
        imageInput: false,
        maxInputImages: 3,
        maxOutputs: 2,
        aspectRatios: ['auto'],
        resolutionClasses: ['auto'],
      },
    }),
  );
  assert.throws(() =>
    modelDefinitionSchema.parse({ ...base, capabilities: { imageInput: true, maxInputImages: 1, maxOutputs: 2 } }),
  );

  // Intent beyond the declared capability is rejected before any paid call.
  assert.doesNotThrow(() =>
    assertGenerationFitsCapability(model, generationCreateSchema.parse({ authoredPrompt: 'd', modelId: 'model' })),
  );
  assert.throws(
    () =>
      assertGenerationFitsCapability(
        model,
        generationCreateSchema.parse({ authoredPrompt: 'd', modelId: 'model', aspectRatio: '16:9' }),
      ),
    /画面比例/,
  );
  assert.throws(
    () =>
      assertGenerationFitsCapability(
        model,
        generationCreateSchema.parse({ authoredPrompt: 'd', modelId: 'model', resolution: 'high' }),
      ),
    /分辨率/,
  );
  assert.throws(
    () =>
      assertGenerationFitsCapability(
        model,
        generationCreateSchema.parse({ authoredPrompt: 'd', modelId: 'model', outputCount: 3 }),
      ),
    /输出数量/,
  );
  // Provider-specific concepts never enter the public schema.
  for (const banned of ['seed', 'lora', 'sampler', 'steps', 'size', 'background']) {
    assert.ok(!aspectRatios.includes(banned as never));
    assert.ok(!resolutionClasses.includes(banned as never));
  }
});
