import { setImmediate } from 'node:timers/promises';
import { and, asc, desc, gt, isNotNull, lte, or } from 'drizzle-orm';
import Type from 'typebox';
import Compile from 'typebox/compile';
import type { Orm } from '../../store/database.ts';
import { modelCalls } from '../../store/schema.ts';
import { AdminQueryError } from './audit.ts';

const settingsValidator = Compile(
  Type.Object({ record_model_payloads: Type.Boolean() }, { additionalProperties: false }),
);

export function parseDeveloperSettings(value: unknown): { record_model_payloads: boolean } {
  if (!settingsValidator.Check(value)) {
    throw new AdminQueryError('invalid_body', 'record_model_payloads must be a boolean');
  }
  return value;
}

export async function clearModelPayloads(orm: Orm): Promise<number> {
  // Bound the sweep to existing calls; ongoing recording must not keep it alive forever.
  const upper = orm.select({ id: modelCalls.id }).from(modelCalls).orderBy(desc(modelCalls.id)).limit(1).get()?.id;
  if (upper === undefined) {
    return 0;
  }
  let cursor = 0n;
  let cleared = 0;
  while (cursor < upper) {
    const batch = orm
      .select({ id: modelCalls.id })
      .from(modelCalls)
      .where(and(gt(modelCalls.id, cursor), lte(modelCalls.id, upper)))
      .orderBy(asc(modelCalls.id))
      .limit(100)
      .all();
    const last = batch.at(-1)?.id;
    if (last === undefined) {
      break;
    }
    const result = orm
      .update(modelCalls)
      .set({ requestJson: null, responseJson: null })
      .where(
        and(
          gt(modelCalls.id, cursor),
          lte(modelCalls.id, last),
          or(isNotNull(modelCalls.requestJson), isNotNull(modelCalls.responseJson)),
        ),
      )
      .run();
    cleared += result.changes;
    cursor = last;
    // SQLite is synchronous: release the write lock and let the Bot run between batches.
    await setImmediate();
  }
  return cleared;
}
