import type { AssistantMessage } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import Type, { type Static } from 'typebox';
import Compile from 'typebox/compile';
import { PROVIDER_ALIAS_PATTERN } from '../../platform/config.ts';
import { deepEqual } from '../../platform/config-diff.ts';
import { sameConnection } from '../../platform/providers.ts';
import type { SqliteStore } from '../../store/database.ts';
import { modelCalls } from '../../store/schema.ts';
import { AdminQueryError } from './audit.ts';
import type { ProviderWriteContext } from './providers-admin.ts';

const HEALTH_PROMPT = 'reply with extract content: ok';
const TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARS = 4_096;
const HealthCheckBodySchema = Type.Object(
  {
    provider: Type.String({ pattern: PROVIDER_ALIAS_PATTERN.source }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);
const healthCheckValidator = Compile(HealthCheckBodySchema);

type HealthCheckBody = Static<typeof HealthCheckBodySchema>;

export interface ModelHealthResult {
  readonly provider: string;
  readonly model: string;
  readonly status: 'ok' | 'unexpected_response' | 'error';
  /** HTTP response headers, not the first generated token; null when the adapter has no hook. */
  readonly ttfb_ms: number | null;
  readonly duration_ms: number;
  readonly response_text: string;
  readonly error: string | null;
}

export function parseHealthCheckBody(body: unknown): HealthCheckBody {
  if (!healthCheckValidator.Check(body)) {
    throw new AdminQueryError('invalid_body', 'Expected only a configured provider and model');
  }
  return body;
}

export async function checkModelHealth(
  store: SqliteStore,
  context: ProviderWriteContext,
  body: HealthCheckBody,
  requestSignal: AbortSignal,
): Promise<ModelHealthResult> {
  const { provider: alias, model: modelId } = body;
  const configured = context.file.providers[alias];
  const definition = configured?.models.find((candidate) => candidate.id === modelId);
  if (configured === undefined || definition === undefined) {
    throw new AdminQueryError('model_not_found', 'The model is not configured on this provider', 404);
  }
  const active = context.snapshot.config.providers[alias];
  if (active === undefined || !sameConnection(active, configured)) {
    throw new AdminQueryError(
      'connection_not_applied',
      'Apply the provider connection before checking its models',
      409,
    );
  }
  if (
    !deepEqual(
      definition,
      active.models.find((candidate) => candidate.id === modelId),
    )
  ) {
    throw new AdminQueryError('model_not_applied', 'Apply the model definition before checking it', 409);
  }
  const model = context.snapshot.models.getModel(alias, modelId);
  if (model === undefined) {
    throw new AdminQueryError('model_not_registered', 'The model is not registered in the running process', 409);
  }
  if (!model.input.includes('text')) {
    throw new AdminQueryError('not_text_capable', 'The health check requires text input', 422);
  }

  const startedAt = performance.now();
  const elapsed = (): number => Math.max(0, Math.round(performance.now() - startedAt));
  const call = store.orm
    .insert(modelCalls)
    .values({
      role: 'doctor',
      provider: alias,
      model: modelId,
      attempt: 1n,
      state: 'pending',
      toolsJson: '[]',
      createdAt: new Date().toISOString(),
    })
    .returning({ id: modelCalls.id })
    .get();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('Model health check timed out after 30 seconds')),
    TIMEOUT_MS,
  );
  const signal = AbortSignal.any([requestSignal, controller.signal]);
  const cancelled = Promise.withResolvers<never>();
  const onAbort = (): void => cancelled.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  let ttfbMs: number | null = null;
  let response: AssistantMessage | undefined;
  let responseText = '';
  let status: ModelHealthResult['status'] = 'error';
  let error: string | null = null;
  const redact = (text: string): string => context.secrets.redact(text).slice(0, MAX_RESULT_CHARS);
  try {
    signal.throwIfAborted();
    // Reuse the active registry: no SecretRef resolution, alternate endpoint, or
    // agent context. Keep the adapter's default reasoning behavior.
    response = await Promise.race([
      context.snapshot.models.completeSimple(
        model,
        { messages: [{ role: 'user', content: HEALTH_PROMPT, timestamp: Date.now() }] },
        {
          signal,
          timeoutMs: TIMEOUT_MS,
          maxTokens: Math.min(128, model.maxTokens),
          maxRetries: 0,
          maxRetryDelayMs: 0,
          cacheRetention: 'none',
          transport: 'sse',
          onResponse: () => {
            ttfbMs ??= elapsed();
          },
        },
      ),
      cancelled.promise,
    ]);
    const text = response.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
    responseText = redact(text);
    if (response.stopReason !== 'stop' || response.content.some((part) => part.type === 'toolCall')) {
      error = redact(response.errorMessage ?? `Model did not finish normally (${response.stopReason})`);
    } else if (text.trim().length === 0) {
      error = 'Model returned an empty response';
    } else {
      status = text.trim() === 'ok' ? 'ok' : 'unexpected_response';
    }
  } catch (cause) {
    error = redact(cause instanceof Error ? cause.message : String(cause));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
  const durationMs = elapsed();
  const usage = response?.usage;
  // Health checks are diagnostic calls like CLI doctor, not conversation turns.
  store.orm
    .update(modelCalls)
    .set({
      state: status === 'ok' ? 'success' : 'error',
      inputTokens: usage === undefined ? null : BigInt(usage.input),
      outputTokens: usage === undefined ? null : BigInt(usage.output),
      cacheReadTokens: usage === undefined ? null : BigInt(usage.cacheRead),
      cacheWriteTokens: usage === undefined ? null : BigInt(usage.cacheWrite),
      totalTokens: usage === undefined ? null : BigInt(usage.totalTokens),
      cost: usage?.cost.total ?? null,
      durationMs: BigInt(durationMs),
      errorCode: status === 'ok' ? null : `model_health_${status}`,
      errorDetail: error,
      finishedAt: new Date().toISOString(),
    })
    .where(eq(modelCalls.id, call.id))
    .run();
  return {
    provider: alias,
    model: modelId,
    status,
    ttfb_ms: ttfbMs,
    duration_ms: durationMs,
    response_text: responseText,
    error,
  };
}
