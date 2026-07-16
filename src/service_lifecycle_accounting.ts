/** Pure, opt-in accounting decisions for the draft service lifecycle profile. */
export interface LifecycleAccountingDecision {
  decision: string;
  reservation_action: "none" | "create" | "reuse" | "release";
  settlement_action: "none" | "create" | "reuse";
  new_execution: boolean;
}

export type LifecycleAccountingInput = Record<string, unknown>;

const result = (
  decision: string,
  reservation_action: LifecycleAccountingDecision["reservation_action"] = "none",
  settlement_action: LifecycleAccountingDecision["settlement_action"] = "none",
  new_execution = false,
): LifecycleAccountingDecision => ({ decision, reservation_action, settlement_action, new_execution });

export function decideLifecycleAccounting(input: LifecycleAccountingInput): LifecycleAccountingDecision {
  const operation = input.operation;
  const binding = input.binding;
  const reservationExists = input.reservation_exists === true;
  const settlementExists = input.settlement_exists === true;
  const accepted = input.accepted === true;
  const delivery = input.delivery;

  if (!["submit", "status", "observe", "resume", "cancel", "terminal"].includes(String(operation))) {
    return result("reject_invalid_input");
  }
  if (!["same", "conflict", "fresh"].includes(String(binding))) return result("reject_invalid_input");
  if (!["none", "partial", "complete"].includes(String(delivery))) return result("reject_invalid_input");
  if (["status", "observe", "cancel", "terminal"].includes(String(operation)) && binding !== "same") {
    return result("reject_conflict");
  }

  if (operation === "status") return result("return_status");
  if (operation === "observe") return result("replay_events");
  if (operation === "resume") {
    if (input.resume_available === true) return result("replay_events");
    if (input.explicit_new_task !== true) return result("explicit_new_task_required");
    if (binding !== "fresh" || input.fresh_task_id !== true || input.fresh_idempotency_key !== true) {
      return result("reject_identifier_reuse");
    }
    return result("start_new_task", "create", "none", true);
  }

  if (operation === "submit") {
    if (binding === "conflict") return result("reject_conflict");
    if (binding === "same" && reservationExists) return result("reuse_execution", "reuse");
    if (binding === "same") return result("reject_missing_reservation");
    if (reservationExists) return result("reject_conflict");
    return result("start_execution", "create", "none", true);
  }

  if (operation === "cancel") {
    if (settlementExists) return result("return_existing_settlement", "reuse", "reuse");
    if (!reservationExists) return result("cancel_without_accounting");
    if (!accepted) return result("cancel_before_acceptance", "release");
    const reason = delivery === "partial" ? "cancel_after_partial_delivery" : "cancel_after_acceptance";
    return result(reason, "reuse", "create");
  }

  if (settlementExists) return result("return_existing_settlement", "reuse", "reuse");
  if (!reservationExists) return result("reject_missing_reservation");
  if (!["completed", "failed", "cancelled", "expired"].includes(String(input.terminal_state))) {
    return result("reject_invalid_input");
  }
  const suffix = delivery === "partial" ? "_partial" : "";
  return result(`settle_${String(input.terminal_state)}${suffix}`, "reuse", "create");
}
