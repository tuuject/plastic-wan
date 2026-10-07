import {
  type GenerationActor,
  type GenerationStatus,
  generationCreateSchema,
  type ImageAsset,
} from '@plasticwan/image-service';
import { and, eq } from 'drizzle-orm';
import type { SqliteStore } from '../store/database.ts';
import type { LongTaskService } from '../store/long-tasks.ts';
import { longTasks } from '../store/schema.ts';
import type { ImageService } from './service.ts';

/**
 * Host-side bridge between the image core and the agent tool surface.
 *
 * The plugin declares `image_generate` and the skill; this object owns
 * everything a stateless plugin must not: media-to-asset input translation,
 * idempotent submission, long-task creation, and completion reconciliation
 * (generation settles → task completes → scheduler delivers a receipt into the
 * conversation, where the model decides whether and what to send).
 */

/** Hard cap on generation input images accepted from one tool call. */
const MAX_INPUT_REFS = 16;

/** Outstanding generations per conversation per invocation, matching alarm's quota style. */
const MAX_PER_INVOCATION = 3;

const RECEIPT_PROMPT_PREVIEW_LENGTH = 200;

export interface SubmitParams {
  readonly conversationId: bigint;
  /** Null outside a live invocation (tests, reconciliation): quota is skipped. */
  readonly invocationId: bigint | null;
  readonly toolCallId: string;
  readonly authoredPrompt: string;
  readonly modelId: string | undefined;
  readonly aspectRatio: string | undefined;
  readonly resolution: string | undefined;
  readonly outputCount: number | undefined;
  /** Conversation-authorized media references (img_…), resolved by the caller. */
  readonly inputMediaIds: readonly bigint[];
  readonly extendedData: Record<string, unknown> | undefined;
}

export interface SubmitResult {
  readonly generationId: string;
  readonly replayed: boolean;
  readonly modelId: string;
  readonly outputCount: number;
}

export interface SendableOutput {
  readonly asset_id: string;
  readonly file_name: string;
  readonly mime: string;
}

/** Receipt payload; snake_case matches the tool surface the model already sees. */
export interface GenerationDelivery {
  readonly generation_id: string;
  readonly status: GenerationStatus;
  readonly model_id: string;
  readonly prompt_preview: string;
  readonly outputs: readonly SendableOutput[];
  readonly error: string | null;
}

export interface ImageBridgeOptions {
  readonly service: ImageService;
  readonly store: SqliteStore;
  readonly tasks: LongTaskService;
  /** Prepares a stored media row (conversation media) as generation input. */
  readonly prepareInputImage: (
    mediaId: bigint,
    signal: AbortSignal,
  ) => Promise<{ readonly base64: string; readonly mime: string }>;
}

/** Actor identity for agent-submitted generations; binds results to one conversation. */
export function agentActor(conversationId: bigint): GenerationActor {
  return {
    id: `agent:${conversationId.toString()}`,
    name: 'agent',
    source: 'agent',
    scopes: [],
    privileged: true,
  };
}

export function createImageBridge(options: ImageBridgeOptions) {
  const { service, store, tasks } = options;
  const core = service.core;
  // A media row re-used as input within this process resolves to the same
  // asset, so repeated generations do not copy the same source image again.
  const inputAssetCache = new Map<bigint, string>();

  const unsubscribeFinished = core.onFinished((generationId) => {
    try {
      reconcileOne(generationId);
    } catch {
      // Listener errors are logged inside the core; reconciliation is retried
      // by the next explicit reload/reconcile call.
    }
  });

  function enabled(): boolean {
    return core.config.hasValidConfig();
  }

  /** Resolves one media row to a core input asset, reusing prior conversions. */
  async function inputAssetId(mediaId: bigint, signal: AbortSignal): Promise<string> {
    const cached = inputAssetCache.get(mediaId);
    if (cached !== undefined) {
      const existing = core.images.get(cached);
      if (existing !== null && existing.deletedAt === null) {
        return cached;
      }
      inputAssetCache.delete(mediaId);
    }
    const { base64, mime } = await options.prepareInputImage(mediaId, signal);
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') {
      throw new Error(`Media type ${mime} is not supported as generation input`);
    }
    const asset = await core.images.create({
      name: `输入图 media-${mediaId.toString()}`,
      base64,
      mime,
      description: '',
      category: '',
      source: 'upload',
    });
    inputAssetCache.set(mediaId, asset.id);
    return asset.id;
  }

  async function submit(
    params: SubmitParams,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SubmitResult> {
    if (!enabled()) {
      throw new Error('image generation is disabled');
    }
    if (params.inputMediaIds.length > MAX_INPUT_REFS) {
      throw new Error(`at most ${MAX_INPUT_REFS} input images are accepted`);
    }
    const inputAssetIds: string[] = [];
    for (const mediaId of params.inputMediaIds) {
      inputAssetIds.push(await inputAssetId(mediaId, signal));
    }

    const parsed = generationCreateSchema.parse({
      authoredPrompt: params.authoredPrompt,
      modelId: params.modelId ?? singleModelId(),
      ...(params.aspectRatio === undefined ? {} : { aspectRatio: params.aspectRatio }),
      ...(params.resolution === undefined ? {} : { resolution: params.resolution }),
      ...(params.outputCount === undefined ? {} : { outputCount: params.outputCount }),
      inputImages: inputAssetIds,
      ...(params.extendedData === undefined ? {} : { extendedData: params.extendedData }),
    });
    const actor = agentActor(params.conversationId);
    const { generation, replayed } = core.generations.create(parsed, actor, `tool:${params.toolCallId}`);

    if (!replayed) {
      tasks.taskScope('image', params.conversationId, params.invocationId).create(
        {
          payload: {
            generation_id: generation.id,
            model_id: generation.snapshot.model.id,
            prompt_preview: generation.snapshot.authored.authoredPrompt.slice(0, RECEIPT_PROMPT_PREVIEW_LENGTH),
            output_count: generation.snapshot.authored.outputCount,
          },
          ...(params.invocationId === null ? {} : { maxPerInvocation: MAX_PER_INVOCATION }),
        },
        new Date(),
      );
    }
    return {
      generationId: generation.id,
      replayed,
      modelId: generation.snapshot.model.id,
      outputCount: generation.snapshot.authored.outputCount,
    };
  }

  function singleModelId(): string {
    const snapshot = core.config.current();
    const models = snapshot.models;
    if (models.length !== 1) {
      throw new Error(
        models.length === 0
          ? 'no image models are configured'
          : `multiple image models are configured (${models.map((model) => model.id).join(', ')}); model_id is required`,
      );
    }
    return models[0]?.id ?? '';
  }

  /**
   * Completion reconciliation for one generation: settles the long task that
   * represents it. Called by the core's finished listener and by `reconcile`
   * after a restart (a restart interrupts in-flight rounds without firing the
   * listener).
   */
  function reconcileOne(generationId: string): void {
    const rows = store.orm
      .select({ id: longTasks.id, conversationId: longTasks.conversationId, payloadJson: longTasks.payloadJson })
      .from(longTasks)
      .where(and(eq(longTasks.pluginId, 'image'), eq(longTasks.state, 'waiting')))
      .all();
    const row = rows.find((candidate) => {
      try {
        return (JSON.parse(candidate.payloadJson) as { generation_id?: string }).generation_id === generationId;
      } catch {
        return false;
      }
    });
    if (row === undefined) {
      return;
    }
    const generation = core.generations.get(generationId, agentActor(row.conversationId));
    const delivery = deliveryOf(generation);
    const scope = tasks.scoped('image', row.conversationId);
    if (delivery === null) {
      scope.fail(row.id, { generation_id: generationId, status: generation.status }, undefined, new Date());
      return;
    }
    scope.complete(row.id, delivery, undefined, new Date());
  }

  function deliveryOf(generation: {
    readonly id: string;
    readonly status: GenerationStatus;
    readonly snapshot: {
      readonly model: { readonly id: string };
      readonly authored: { readonly authoredPrompt: string };
    };
    readonly outputs: readonly ImageAsset[];
    readonly error: { readonly message: string } | null;
  }): GenerationDelivery | null {
    const outputs = generation.outputs.map(toSendable);
    if (generation.status === 'succeeded' || generation.status === 'partial') {
      if (outputs.length === 0) {
        return null;
      }
      return {
        generation_id: generation.id,
        status: generation.status,
        model_id: generation.snapshot.model.id,
        prompt_preview: generation.snapshot.authored.authoredPrompt.slice(0, RECEIPT_PROMPT_PREVIEW_LENGTH),
        outputs,
        error: generation.error?.message ?? null,
      };
    }
    // A failed or interrupted round still completes the task: the receipt
    // carries the error so the conversation learns the outcome instead of
    // waiting forever.
    return {
      generation_id: generation.id,
      status: generation.status,
      model_id: generation.snapshot.model.id,
      prompt_preview: generation.snapshot.authored.authoredPrompt.slice(0, RECEIPT_PROMPT_PREVIEW_LENGTH),
      outputs,
      error: generation.error?.message ?? '生成失败',
    };
  }

  function toSendable(asset: ImageAsset): SendableOutput {
    return { asset_id: asset.id, file_name: asset.name, mime: asset.mime };
  }

  /**
   * Deliverable outputs of one generation, authorized only when the generation
   * belongs to the asking conversation. `undefined` = not found or foreign;
   * an empty array means it settled without outputs (failed/interrupted).
   */
  function sendableOutputs(generationId: string, conversationId: bigint): readonly SendableOutput[] | undefined {
    // The authorization rule is explicit: a generation belongs to the
    // conversation whose agent actor submitted it. Privileged actors would
    // bypass scope checks inside get(), so the binding is checked here first.
    const row = core.generations.getRow(generationId);
    if (row === null || row.actorId !== `agent:${conversationId.toString()}`) {
      return undefined;
    }
    return core.generations.get(generationId, agentActor(conversationId)).outputs.map(toSendable);
  }

  /** Missing output files must fail delivery, not silently shrink the picture set. */
  function assetContent(assetId: string): { readonly bytes: Buffer; readonly mime: string } {
    const { asset, bytes } = core.images.readContent(assetId);
    return { bytes, mime: asset.mime };
  }

  /** Reconciles every waiting image task after a restart. */
  function reconcile(): void {
    const rows = store.orm
      .select({ id: longTasks.id, conversationId: longTasks.conversationId, payloadJson: longTasks.payloadJson })
      .from(longTasks)
      .where(and(eq(longTasks.pluginId, 'image'), eq(longTasks.state, 'waiting')))
      .all();
    for (const row of rows) {
      let generationId: string | undefined;
      try {
        generationId = (JSON.parse(row.payloadJson) as { generation_id?: string }).generation_id;
      } catch {
        generationId = undefined;
      }
      if (generationId === undefined) {
        tasks
          .scoped('image', row.conversationId)
          .fail(row.id, { error: 'image task payload is unreadable' }, undefined, new Date());
        continue;
      }
      reconcileOne(generationId);
    }
  }

  function stop(): void {
    unsubscribeFinished();
  }

  return {
    enabled,
    submit,
    sendableOutputs,
    assetContent,
    reconcile,
    stop,
    /** The live model directory shared by Agent discovery and Admin views; no credentials. */
    modelList: () => core.config.publicModels(),
  };
}

export type ImageBridge = ReturnType<typeof createImageBridge>;
