import { finishToolCall, rejectToolCall, type SqliteStore, startToolCall } from './database.ts';

/**
 * Invocation-bound audit for a capability that records its own `tool_calls`
 * row next to the `execute` row. Plugins get this instead of the store, so
 * audit stays the only database access a stateless plugin has.
 */
export interface ToolAudit {
  start(toolCallId: string, toolName: string, argumentsJson: string, sideEffect: boolean): ToolAuditRecord;
  reject(toolCallId: string, toolName: string, argumentsJson: string, sideEffect: boolean, errorCode: string): void;
}

export interface ToolAuditRecord {
  succeed(resultText: string): void;
  fail(errorCode: string): void;
}

export function createToolAudit(store: SqliteStore, invocationId: bigint): ToolAudit {
  return {
    start(toolCallId, toolName, argumentsJson, sideEffect) {
      const startedAt = performance.now();
      const auditId = startToolCall(store.orm, invocationId, toolCallId, toolName, argumentsJson, sideEffect);
      return {
        succeed: (resultText) =>
          finishToolCall(store.orm, auditId, 'success', resultText, null, { startedAt, pendingOnly: true }),
        fail: (errorCode) =>
          finishToolCall(store.orm, auditId, 'error', null, errorCode, { startedAt, pendingOnly: true }),
      };
    },
    reject(toolCallId, toolName, argumentsJson, sideEffect, errorCode) {
      rejectToolCall(store.orm, invocationId, toolCallId, toolName, argumentsJson, sideEffect, errorCode);
    },
  };
}
