export const WORKFLOW_NAME = "software-development";
export const STATE_ENTRY_TYPE = "software-development-workflow-state";
export const CONTEXT_MESSAGE_TYPE = "software-development-workflow-context";

export const PHASES = Object.freeze([
  "idle",
  "preflight",
  "analysis",
  "awaiting_plan_approval",
  "implementation",
  "review",
  "fixes",
  "final_validation",
  "awaiting_push_confirmation",
  "awaiting_pr_confirmation",
  "completed",
  "blocked",
  "aborted",
]);

const TRANSITIONS = new Map([
  ["idle", new Set(["preflight"])],
  ["preflight", new Set(["analysis", "blocked"])],
  ["analysis", new Set(["awaiting_plan_approval", "blocked"])],
  ["awaiting_plan_approval", new Set(["analysis", "implementation", "aborted"])],
  ["implementation", new Set(["review", "blocked"])],
  ["review", new Set(["fixes", "final_validation", "blocked"])],
  ["fixes", new Set(["review", "final_validation", "blocked"])],
  ["final_validation", new Set(["awaiting_push_confirmation", "blocked"])],
  ["awaiting_push_confirmation", new Set(["awaiting_pr_confirmation", "completed"])],
  ["awaiting_pr_confirmation", new Set(["completed"])],
  ["completed", new Set()],
  ["blocked", new Set(["analysis", "implementation", "review", "fixes", "final_validation", "aborted"])],
  ["aborted", new Set()],
]);

export const READ_ONLY_PHASES = new Set([
  "idle",
  "preflight",
  "analysis",
  "awaiting_plan_approval",
  "review",
  "final_validation",
  "awaiting_push_confirmation",
  "awaiting_pr_confirmation",
  "completed",
  "blocked",
  "aborted",
]);

export const BRANCH_PREFIXES = Object.freeze([
  "feature",
  "fix",
  "refactor",
  "chore",
  "docs",
  "test",
  "ci",
  "perf",
]);

export function createInitialState(sessionId = "") {
  return {
    workflow: WORKFLOW_NAME,
    version: 1,
    phase: "idle",
    sessionId,
    repositoryRoot: "",
    baseBranch: "",
    baseCommit: "",
    workingBranch: undefined,
    requestSummary: "",
    planSummary: "",
    planApproved: false,
    planRevision: 0,
    reviewRound: 0,
    openFindings: 0,
    finalValidationPassed: false,
    commit: undefined,
    push: { attempted: false, completed: false },
    pullRequest: { attempted: false, completed: false },
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  };
}

export function transition(state, nextPhase, patch = {}) {
  if (!PHASES.includes(nextPhase)) {
    throw new Error(`Unknown workflow phase: ${nextPhase}`);
  }

  if (state.phase !== nextPhase && !TRANSITIONS.get(state.phase)?.has(nextPhase)) {
    throw new Error(`Invalid workflow transition: ${state.phase} -> ${nextPhase}`);
  }

  return {
    ...state,
    ...patch,
    phase: nextPhase,
    updatedAt: new Date().toISOString(),
  };
}

export function canTransition(from, to) {
  return from === to || Boolean(TRANSITIONS.get(from)?.has(to));
}

export function parseWorkflowCommand(args = "") {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const action = tokens[0] || "status";
  return { action, value: tokens.slice(1).join(" ") };
}

export function normalizeBranchSlug(value = "") {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64)
    .replace(/-+$/, "");
}

export function branchName(request, type = "feature", issueNumber = "") {
  const prefix = BRANCH_PREFIXES.includes(type) ? type : "feature";
  const slug = normalizeBranchSlug(request) || "software-change";
  const issue = String(issueNumber).trim().replace(/[^0-9]/g, "");
  return `${prefix}/${issue ? `${issue}-` : ""}${slug}`;
}

export function isWriteTool(toolName) {
  return toolName === "write" || toolName === "edit";
}

export function isGitPublicationCommand(command = "") {
  return /\bgit\s+(push|pull|fetch|merge|rebase|cherry-pick)\b/.test(command)
    || /\bgh\s+pr\s+(create|merge|close)\b/.test(command);
}

export function isMutatingShellCommand(command = "") {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  if (isGitPublicationCommand(normalized)) return true;
  if (/\bgit\s+(add|commit|switch|checkout|reset|restore|clean|branch\s+(-d|-D)|tag|stash)\b/.test(normalized)) return true;
  if (/\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|install)\b/.test(normalized)) return true;
  if (/\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|uninstall|link)\b/.test(normalized)) return true;
  if (/(^|[^<])>>?\s*[^&|;]/.test(normalized) || /\btee\s+/.test(normalized)) return true;
  if (/\b(sed|perl)\s+(-[^ ]*i|--in-place)\b/.test(normalized)) return true;

  return false;
}

export function shouldBlockTool(phase, toolName, input = {}) {
  if (["idle", "completed", "aborted"].includes(phase)) return undefined;

  if (isWriteTool(toolName) && READ_ONLY_PHASES.has(phase)) {
    return `The ${toolName} tool is blocked during the ${phase} phase.`;
  }

  if (toolName === "bash" && isMutatingShellCommand(input.command || "")) {
    return `This shell command is blocked during the ${phase} phase because it can modify the repository or publish changes.`;
  }

  return undefined;
}

export function extractTextFromMessage(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && part.type === "text")
    .map((part) => part.text || "")
    .join("\n");
}

export function extractWorkflowSignal(messages = []) {
  const text = messages
    .map(extractTextFromMessage)
    .filter(Boolean)
    .join("\n");

  const signals = [
    "PLAN_READY",
    "BLOCKED",
    "IMPLEMENTATION_COMPLETE",
    "REVIEW_NO_FINDINGS",
    "REVIEW_FINDINGS",
    "FIXES_COMPLETE",
    "VALIDATION_PASSED",
    "VALIDATION_FAILED",
  ];

  for (const signal of signals) {
    if (new RegExp(`WORKFLOW_STATUS:\\s*${signal}\\b`, "i").test(text)) {
      return signal;
    }
  }

  return undefined;
}

export function extractCommitMessage(messages = []) {
  const text = messages.map(extractTextFromMessage).join("\n");
  const match = text.match(/WORKFLOW_COMMIT:\s*(.+)/i);
  return match?.[1]?.trim().replace(/^`|`$/g, "");
}

export function compactPlan(text = "", maxLength = 6000) {
  const normalized = text.trim().replace(/\n{3,}/g, "\n\n");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 80).trim()}\n\n[Plan summary truncated by workflow]`;
}

export function formatStatus(state) {
  const lines = [
    `Workflow: ${state.workflow}`,
    `Phase: ${state.phase}`,
    `Repository: ${state.repositoryRoot || "not detected"}`,
    `Base: ${state.baseBranch || "not detected"}${state.baseCommit ? ` @ ${state.baseCommit.slice(0, 12)}` : ""}`,
    `Branch: ${state.workingBranch || "not created"}`,
    `Plan: ${state.planApproved ? `approved (revision ${state.planRevision})` : "not approved"}`,
    `Review: round ${state.reviewRound}, ${state.openFindings} open finding(s)`,
    `Commit: ${state.commit ? `${state.commit.hash.slice(0, 12)} ${state.commit.message}` : "not created"}`,
    `Push: ${state.push?.completed ? "completed" : state.push?.attempted ? "attempted" : "not attempted"}`,
    `PR: ${state.pullRequest?.completed ? state.pullRequest.url || "created" : state.pullRequest?.attempted ? "attempted" : "not attempted"}`,
  ];
  if (state.lastError) lines.push(`Blocker: ${state.lastError}`);
  return lines.join("\n");
}
