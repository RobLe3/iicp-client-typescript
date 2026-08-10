/** Fail-closed identity validation for negotiated native lifecycle CALLs. */

export const LIFECYCLE_PROFILE = "urn:iicp:profile:service-lifecycle:v1";

export class NativeCallIdentityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "NativeCallIdentityError";
  }
}

export class NativeCallIdentityRegistry {
  private readonly tasks = new Map<string, string>();
  private readonly calls = new Set<string>();

  accept(call: Record<string, unknown>): void {
    if (call.profile !== LIFECYCLE_PROFILE) return;
    const taskId = call.task_id;
    const callId = call.call_id;
    const idempotencyKey = call.idempotency_key;
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new NativeCallIdentityError("missing_task_id");
    }
    if (typeof callId !== "string" || callId.length === 0) {
      throw new NativeCallIdentityError("missing_call_id");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      throw new NativeCallIdentityError("missing_idempotency_key");
    }
    if (this.calls.has(callId)) throw new NativeCallIdentityError("call_id_reuse");
    const knownKey = this.tasks.get(taskId);
    if (knownKey !== undefined && knownKey !== idempotencyKey) {
      throw new NativeCallIdentityError("task_identity_conflict");
    }
    this.tasks.set(taskId, idempotencyKey);
    this.calls.add(callId);
  }
}
