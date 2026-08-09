/** Transport-independent validation for negotiated native RESPONSE sequences. */
export type NativeLifecycleEnvelope = {
  task_id: string;
  sequence: number;
  event: string;
  is_final: boolean;
};

export type NativeResponseFrame = {
  session_id: string;
  call_id: string;
  status: string;
  is_final: boolean;
  lifecycle: NativeLifecycleEnvelope;
  result?: unknown;
  error?: unknown;
};

export class NativeResponseSequenceError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export class NativeResponseSequence {
  private nextSequence = 0;
  private terminalSeen = false;

  constructor(
    private readonly sessionId: string,
    private readonly callId: string,
    private readonly taskId: string,
  ) {}

  accept(frame: NativeResponseFrame): void {
    if (this.terminalSeen) throw new NativeResponseSequenceError("response_after_terminal");
    if (!frame.lifecycle) throw new NativeResponseSequenceError("missing_lifecycle");
    if (frame.session_id !== this.sessionId) throw new NativeResponseSequenceError("session_id_drift");
    if (frame.call_id !== this.callId) throw new NativeResponseSequenceError("call_id_drift");
    if (frame.lifecycle.task_id !== this.taskId) throw new NativeResponseSequenceError("task_id_drift");
    if (frame.lifecycle.sequence !== this.nextSequence) throw new NativeResponseSequenceError("sequence_drift");
    if (frame.is_final !== frame.lifecycle.is_final) throw new NativeResponseSequenceError("finality_disagreement");

    const expectedEvents: Record<string, Set<string>> = {
      partial: new Set(["partial"]),
      success: new Set(["completed"]),
      error: new Set(["failed", "cancelled"]),
      timeout: new Set(["timed_out", "expired"]),
    };
    if (!expectedEvents[frame.status]?.has(frame.lifecycle.event)) {
      throw new NativeResponseSequenceError("status_event_disagreement");
    }
    if ((frame.status === "partial" && frame.is_final) || (frame.status !== "partial" && !frame.is_final)) {
      throw new NativeResponseSequenceError("terminal_flag_mismatch");
    }
    this.nextSequence += 1;
    this.terminalSeen = frame.is_final;
  }

  finish(): void {
    if (!this.terminalSeen) throw new NativeResponseSequenceError("missing_terminal_response");
  }
}
