/**
 * Shared fixture data for the Models page E2E: the provider secrets that must
 * never reach the DOM, the relay model ids the local upstream serves, and the
 * models.dev catalog the E2E server primes so discovery never touches the
 * network. Both `e2e/server.ts` and the spec import this module.
 */

export const E2E_BUILTIN_ALIAS = 'openrouter';
export const E2E_BUILTIN_PROVIDER = 'openrouter';
export const E2E_RELAY_ALIAS = 'relay';

export const E2E_SECRETS = {
  /** Builtin provider key (key.json only, never returned by the API). */
  builtin: 'e2e-builtin-openrouter-secret',
  /** Custom relay key, also used as the temporary-mode key in the dialog. */
  relay: 'e2e-relay-secret',
  /** Header value of the relay provider: the API returns the name only. */
  relayHeader: 'e2e-relay-header-secret',
  /** Key typed into the new-provider wizard, which the local upstream accepts. */
  wizard: 'e2e-wizard-secret',
  /** Key of the health-check providers created by 16-model-health. */
  health: 'e2e-health-secret',
} as const;

/** Keys the local listing and chat endpoints accept, so every fixture provider can call them. */
export const E2E_ACCEPTED_RELAY_KEYS: readonly string[] = [E2E_SECRETS.relay, E2E_SECRETS.wizard, E2E_SECRETS.health];

/** Ids the local `/v1/models` upstream lists. */
export const E2E_RELAY_DISCOVERED_MODELS = ['relay-model-a', 'relay-model-b'] as const;
/** Served by the upstream and known to the fixture catalog: metadata is complete. */
export const E2E_RELAY_COMPLETE_MODEL = 'relay-model-a';
/** Served by the upstream but absent from the catalog: every field needs confirming. */
export const E2E_RELAY_INCOMPLETE_MODEL = 'relay-model-b';
/** Only reachable through `lookup-metadata` (the manual-add path). */
export const E2E_RELAY_MANUAL_MODEL = 'relay-manual-model';

/**
 * Health-check fixture: providers 16-model-health creates through the API and
 * the model ids whose upstream behavior is canned by id — `health-ok` and
 * `health-ok-2` stream the expected reply, `health-unexpected` streams a
 * different one, and `health-fail` answers HTTP 500.
 */
export const E2E_HEALTH_ALIAS_A = 'health-a';
export const E2E_HEALTH_ALIAS_B = 'health-b';
export const E2E_HEALTH_OK_MODEL = 'health-ok';
export const E2E_HEALTH_OK_2_MODEL = 'health-ok-2';
export const E2E_HEALTH_UNEXPECTED_MODEL = 'health-unexpected';
export const E2E_HEALTH_FAIL_MODEL = 'health-fail';
/** The fixed prompt the health check must send, verbatim, as its only message. */
export const E2E_HEALTH_PROMPT = 'reply with extract content: ok';

/** The models.dev catalog `GET /providers/discover` resolves metadata against. */
export const E2E_MODELS_DEV_CATALOG = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    models: {
      [E2E_RELAY_COMPLETE_MODEL]: {
        id: E2E_RELAY_COMPLETE_MODEL,
        name: 'Relay Model A',
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 200_000, output: 32_768 },
        cost: { input: 0.5, output: 1.5, cache_read: 0.05, cache_write: 0.5 },
      },
      [E2E_RELAY_MANUAL_MODEL]: {
        id: E2E_RELAY_MANUAL_MODEL,
        name: 'Relay Manual Model',
        reasoning: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 64_000, output: 8_192 },
        cost: { input: 0.1, output: 0.2, cache_read: 0, cache_write: 0 },
      },
    },
  },
} as const;
