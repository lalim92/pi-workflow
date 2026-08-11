import { transition } from "./workflow-core.mjs";

const SIGNAL_PHASES = new Set(["analysis", "implementation", "review", "fixes", "final_validation"]);

export function applyWorkflowSignal(state, signal, options = {}) {
  const { planSummary, maxReviewRounds = 2 } = options;

  if (!SIGNAL_PHASES.has(state.phase)) {
    return { state, action: undefined, handled: false };
  }

  switch (signal) {
    case "PLAN_READY":
      if (state.phase !== "analysis") return { state, action: undefined, handled: false };
      return {
        state: transition(state, "awaiting_plan_approval", {
          planSummary: planSummary ?? state.planSummary,
          planRevision: state.planRevision + 1,
          blockedFromPhase: undefined,
          lastError: undefined,
        }),
        action: undefined,
        handled: true,
      };

    case "BLOCKED":
      return {
        state: {
          ...state,
          phase: "blocked",
          blockedFromPhase: state.phase,
          lastError: "The agent reported a blocking question or decision.",
          updatedAt: new Date().toISOString(),
        },
        action: undefined,
        handled: true,
      };

    case "IMPLEMENTATION_COMPLETE":
      if (state.phase !== "implementation") return { state, action: undefined, handled: false };
      return {
        state: transition(state, "review", {
          reviewRound: state.reviewRound + 1,
          blockedFromPhase: undefined,
          lastError: undefined,
        }),
        action: { kind: "prompt", phase: "review" },
        handled: true,
      };

    case "REVIEW_NO_FINDINGS":
      if (state.phase !== "review") return { state, action: undefined, handled: false };
      return {
        state: transition(state, "final_validation", {
          openFindings: 0,
          blockedFromPhase: undefined,
          lastError: undefined,
        }),
        action: { kind: "prompt", phase: "final_validation" },
        handled: true,
      };

    case "REVIEW_FINDINGS":
      if (state.phase !== "review") return { state, action: undefined, handled: false };
      return {
        state: transition(state, "fixes", {
          openFindings: Math.max(1, state.openFindings),
          blockedFromPhase: undefined,
          lastError: undefined,
        }),
        action: { kind: "prompt", phase: "fixes" },
        handled: true,
      };

    case "FIXES_COMPLETE":
      if (state.phase !== "fixes") return { state, action: undefined, handled: false };
      if (state.reviewRound < maxReviewRounds) {
        return {
          state: transition(state, "review", {
            reviewRound: state.reviewRound + 1,
            blockedFromPhase: undefined,
            lastError: undefined,
          }),
          action: { kind: "prompt", phase: "review" },
          handled: true,
        };
      }
      return {
        state: transition(state, "final_validation", {
          openFindings: 0,
          blockedFromPhase: undefined,
          lastError: undefined,
        }),
        action: { kind: "prompt", phase: "final_validation" },
        handled: true,
      };

    case "VALIDATION_PASSED":
      if (state.phase !== "final_validation") return { state, action: undefined, handled: false };
      return {
        state: { ...state, finalValidationPassed: true, updatedAt: new Date().toISOString() },
        action: { kind: "commit" },
        handled: true,
      };

    case "VALIDATION_FAILED":
      if (state.phase !== "final_validation") return { state, action: undefined, handled: false };
      return {
        state: {
          ...state,
          phase: "blocked",
          blockedFromPhase: "final_validation",
          finalValidationPassed: false,
          lastError: "Required final validation failed.",
          updatedAt: new Date().toISOString(),
        },
        action: undefined,
        handled: true,
      };

    default:
      return { state, action: undefined, handled: false };
  }
}
