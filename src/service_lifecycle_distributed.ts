/** Portable evaluator for the pre-normative distributed lifecycle profile. */
const ALLOWED = new Set(["event_id", "progress", "reason_code", "outcome", "receipt_digest", "checkpoint_digest"]);

export function evaluateDistributedLifecycle(vector: Record<string, unknown>): string {
  switch (vector.kind) {
    case "owner_write": return vector.writer_epoch === vector.current_epoch ? "write_accepted" : "stale_owner_rejected";
    case "failover_submit":
      if (vector.request_digest_matches !== true || vector.idempotency_key_matches !== true) return "conflict_no_new_execution";
      return vector.execution_started === true ? "existing_execution_recovered" : "existing_record_recovered";
    case "append_event":
      if (vector.event_id_seen === true) return "duplicate_event_ignored";
      return typeof vector.sequence === "number" && vector.sequence === Number(vector.latest_sequence) + 1 ? "event_appended" : "sequence_gap_rejected";
    case "observe": {
      const gap = Number(vector.after_sequence) + 1 < Number(vector.first_retained_sequence);
      return gap ? (vector.terminal === true ? "terminal_snapshot_with_replay_gap" : "resume_unavailable") : "replay_available";
    }
    case "terminal_retention": return Number(vector.age_ms) > Number(vector.ttl_ms) ? "unknown_task_after_expiry" : "terminal_snapshot_available";
    case "mutation_admission": return vector.quorum_available === true ? "mutation_allowed" : "temporarily_unavailable_no_write";
    case "content_minimization": {
      const detail = vector.detail && typeof vector.detail === "object" ? Object.keys(vector.detail) : [];
      return detail.every(field => ALLOWED.has(field)) ? "accepted" : "reject_before_write";
    }
    default: return "unsupported_vector";
  }
}
