import { z } from 'zod';

/**
 * Domain contracts for the image generation core. This module must stay safe to
 * import from browsers and adapters: no Node, SQLite or Sharp imports. Product
 * assumptions from the standalone app (auth, API keys, HTTP URLs, config files)
 * are deliberately absent; ownership is an opaque string supplied by the host.
 */

export const idSchema = z.uuid();
export const nameSchema = z.string().trim().min(1).max(160);
const descriptionSchema = z.string().max(2000);
const categorySchema = z.string().trim().max(80);
export const promptBodySchema = z
  .string()
  .min(1)
  .max(32000)
  .refine((value) => !value.includes('{{') && !value.includes('}}'), 'Prompt 素材不支持递归引用或引用分隔符');
export const promptCreateSchema = z
  .object({
    name: nameSchema,
    body: promptBodySchema,
    description: descriptionSchema.default(''),
    category: categorySchema.default(''),
  })
  .strict();
export const promptUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    body: promptBodySchema.optional(),
    description: descriptionSchema.optional(),
    category: categorySchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '至少修改一个字段');
export const maxImageBytes = 20 * 1024 * 1024;
export const imageCreateSchema = z
  .object({
    name: nameSchema,
    base64: z
      .string()
      .min(4)
      .max(Math.ceil(maxImageBytes / 3) * 4),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    description: descriptionSchema.default(''),
    category: categorySchema.default(''),
  })
  .strict();
export const imageUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    category: categorySchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '至少修改一个字段');
export const listSchema = z
  .object({
    q: z.string().max(200).default(''),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListQuery = z.infer<typeof listSchema>;
export type Page<T> = { items: T[]; total: number; limit: number; offset: number };
export type PromptAsset = {
  id: string;
  name: string;
  body: string;
  description: string;
  category: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
export type ImageAsset = {
  id: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  description: string;
  category: string;
  source: 'upload' | 'generation';
  generationId: string | null;
  outputIndex: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

/**
 * Public generation intent. The abstraction is intentionally lossy: these two
 * enums are the only generation controls the core exposes, and every provider
 * adapter maps them onto its own vendor parameters. Provider-specific concepts
 * (seed, sampler, LoRA, arbitrary width/height, ...) stay with the adapter via
 * `extendedData` — never in this schema.
 */
export const aspectRatios = ['auto', '1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16'] as const;
export type AspectRatio = (typeof aspectRatios)[number];
export const resolutionClasses = ['auto', 'low', 'medium', 'high'] as const;
export type ResolutionClass = (typeof resolutionClasses)[number];

/**
 * Provider-specific escape hatch. The core validates the container shape only:
 * the active adapter interprets every value, nothing is portable across
 * providers, and there is deliberately no core-level per-provider registry.
 */
export const extendedDataSchema = z.record(z.string(), z.unknown());

export const modelCapabilitySchema = z
  .object({
    imageInput: z.boolean(),
    maxInputImages: z.number().int().min(0).max(16),
    maxOutputs: z.number().int().min(1).max(10),
    aspectRatios: z.array(z.enum(aspectRatios)).min(1),
    resolutionClasses: z.array(z.enum(resolutionClasses)).min(1),
  })
  .strict();
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export const modelDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    name: nameSchema,
    description: z.string().max(1000).optional(),
    provider: z.literal('openrouter'),
    upstreamModel: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
    credentialRef: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    providerTag: z.string().regex(/^[a-zA-Z0-9_-]{1,80}(?:\/[a-zA-Z0-9_-]{1,80})?$/),
    capabilities: modelCapabilitySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.capabilities.imageInput && value.capabilities.maxInputImages > 0) {
      ctx.addIssue({ code: 'custom', message: '不支持图片输入的模型不能声明输入图片上限' });
    }
  });
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>;
export type PublicModel = Omit<ModelDefinition, 'credentialRef'>;
export const generationCreateSchema = z
  .object({
    authoredPrompt: z.string().min(1).max(32000),
    modelId: z.string().min(1).max(80),
    aspectRatio: z.enum(aspectRatios).default('auto'),
    resolution: z.enum(resolutionClasses).default('auto'),
    outputCount: z.number().int().min(1).max(10).default(1),
    /**
     * Explicit input images as asset ids. This is the intent-level form of
     * "optional input images"; the `{{image:UUID}}` prompt syntax remains the
     * inline alternative. Both merge into one ordered, de-duplicated list.
     */
    inputImages: z.array(z.string().uuid()).max(16).default([]),
    extendedData: extendedDataSchema.optional(),
  })
  .strict();
export type GenerationInput = z.infer<typeof generationCreateSchema>;
export const idempotencyKeySchema = z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/, '幂等键必须为1..128位安全字符');

/**
 * Ownership vocabulary. `source` names the calling surface (for example "admin"
 * or "agent"), `scopes` are checked per operation, and `privileged` marks an
 * actor the host vouches for (it bypasses per-scope checks). The core never
 * interprets these values beyond equality and scope membership.
 */
export const generationScopes = [
  'asset:read',
  'asset:write',
  'asset:delete',
  'generation:read',
  'generation:create',
  'model:read',
] as const;
export type GenerationScope = (typeof generationScopes)[number];
export const generationSourceSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9._-]*$/);
export type GenerationSource = string;
export type GenerationActor = {
  id: string;
  name: string;
  source: GenerationSource;
  scopes: readonly GenerationScope[];
  privileged: boolean;
};

export type GenerationSnapshot = {
  schemaVersion: 1;
  authored: GenerationInput;
  resolvedPrompt: string;
  finalPrompt: string;
  promptAssets: PromptAsset[];
  imageAssets: ImageAsset[];
  model: ModelDefinition;
  configVersion: string;
  requestSemantics: { adapterVersion: 1 | 2; calls: number; imagesPerCall: 1; appendedInstructions: string[] };
};
export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
export type AttemptStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';
export type SafeError = { code: string; message: string; stage?: 'input' | 'provider' | 'storage' | 'interrupted' };
export type GenerationAttempt = {
  id: string;
  generationId: string;
  round: number;
  itemIndex: number;
  status: AttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  error: SafeError | null;
  providerRequestId: string | null;
  usage: Record<string, number> | null;
  outputAssetId: string | null;
};
export type Generation = {
  id: string;
  status: GenerationStatus;
  source: GenerationSource;
  actorName: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  snapshot: GenerationSnapshot;
  attempts: GenerationAttempt[];
  outputs: ImageAsset[];
  error: SafeError | null;
  round: number;
};
export type ResolvedInput = { snapshot: GenerationSnapshot };
export type ErrorResponse = { error: SafeError };

export type Reference = { kind: 'prompt' | 'image'; id: string; token: string; start: number; end: number };
export function referenceToken(kind: Reference['kind'], id: string): string {
  return `{{${kind}:${id}}}`;
}
export function scanReferences(text: string): Reference[] {
  const pattern = /\{\{(prompt|image):([0-9a-fA-F-]{36})\}\}/g;
  const references: Reference[] = [];
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const id = idSchema.parse(match[2]);
    references.push({
      kind: match[1] as Reference['kind'],
      id: id.toLowerCase(),
      token: match[0],
      start: match.index,
      end: pattern.lastIndex,
    });
    match = pattern.exec(text);
  }
  const remainder = text.replace(pattern, '');
  if (remainder.includes('{{') || remainder.includes('}}')) {
    throw new Error('素材引用语法损坏；请使用 {{prompt:UUID}} 或 {{image:UUID}}');
  }
  return references;
}
export function removeReference(text: string, kind: Reference['kind'], id: string): string {
  const refs = scanReferences(text).filter((ref) => ref.kind === kind && ref.id === id.toLowerCase());
  for (const ref of refs.reverse()) {
    text = text.slice(0, ref.start) + text.slice(ref.end);
  }
  return text;
}
export function assertGenerationFitsCapability(model: ModelDefinition, input: GenerationInput): void {
  if (input.outputCount > model.capabilities.maxOutputs) {
    throw new Error(`输出数量超过模型上限（${model.capabilities.maxOutputs}）`);
  }
  if (!model.capabilities.aspectRatios.includes(input.aspectRatio)) {
    throw new Error(`模型不支持画面比例 ${input.aspectRatio}`);
  }
  if (!model.capabilities.resolutionClasses.includes(input.resolution)) {
    throw new Error(`模型不支持分辨率档位 ${input.resolution}`);
  }
}
