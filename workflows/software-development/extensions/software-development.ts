import type { AgentEndEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  STATE_ENTRY_TYPE,
  branchNameFromRequest,
  compactPlan,
  createInitialState,
  extractCommitMessage,
  extractTextFromMessage,
  extractWorkflowSignal,
  formatStatus,
  parseWorkflowCommand,
  shouldBlockTool,
  transition,
} from "../lib/workflow-core.mjs";
import { inspectGitRepository } from "../lib/git-preflight.mjs";
import { buildPullRequestBody, commitRepositoryChanges } from "../lib/git-delivery.mjs";

const MAX_REVIEW_ROUNDS = 2;

type WorkflowState = ReturnType<typeof createInitialState>;
type PendingAction =
  | { kind: "prompt"; content: string }
  | { kind: "commit" }
  | undefined;

function latestPersistedState(ctx: ExtensionContext): WorkflowState | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE || !entry.data) continue;
    const data = entry.data as Partial<WorkflowState>;
    if (data.workflow !== "software-development" || data.version !== 1) continue;
    return { ...createInitialState(ctx.sessionManager.getSessionId()), ...data } as WorkflowState;
  }
  return undefined;
}

function assistantText(event: AgentEndEvent): string {
  return event.messages
    .filter((message) => message.role === "assistant")
    .map(extractTextFromMessage)
    .filter(Boolean)
    .join("\n\n");
}

function phasePrompt(state: WorkflowState, phase: WorkflowState["phase"], extra = ""): string {
  const request = state.requestSummary || "the approved software development request";
  const plan = state.planSummary ? `\n\nApproved plan summary:\n${compactPlan(state.planSummary, 4200)}` : "";
  const common = `You are operating the Pi Software Development Workflow in the ${phase} phase.\nRequest: ${request}\nDo not change scope without stopping and asking the user. Follow the project guidelines already loaded by Pi. ${extra}`;

  switch (phase) {
    case "analysis":
      return `${common}\n\nAnalyze the repository and request using read-only tools. Ask only blocking questions. Produce the complete implementation plan required by the workflow specification. Do not edit, write, commit, push, or create a PR. End your response with exactly one of:\nWORKFLOW_STATUS: PLAN_READY\nWORKFLOW_STATUS: BLOCKED`;
    case "implementation":
      return `${common}${plan}\n\nImplement the approved plan. Add or update tests and documentation when required. Run focused validation as you work. Do not commit, push, or create a PR; the extension handles Git delivery. Report changed files, tests, commands, and unresolved issues. End your response with WORKFLOW_STATUS: IMPLEMENTATION_COMPLETE and, on its own line, WORKFLOW_COMMIT: <project-appropriate commit message>. If an approval is required, end with WORKFLOW_STATUS: BLOCKED.`;
    case "review":
      return `${common}${plan}\n\nPerform a technical-only review of the actual diff against the approved plan and acceptance criteria. Do not use write or edit and do not modify files through shell commands. Run safe, relevant validation if useful. Report findings using BLOCKER, HIGH, MEDIUM, LOW, or OPTIONAL severity with path, impact, evidence, and recommended fix. End with exactly one marker:\nWORKFLOW_STATUS: REVIEW_NO_FINDINGS\nWORKFLOW_STATUS: REVIEW_FINDINGS`;
    case "fixes":
      return `${common}${plan}\n\nApply only clearly in-scope technical fixes from the preceding review. Do not expand product scope or make unapproved architecture decisions. Run focused validation after fixing. Report every applied and deferred finding. End with WORKFLOW_STATUS: FIXES_COMPLETE or WORKFLOW_STATUS: BLOCKED.`;
    case "final_validation":
      return `${common}${plan}\n\nPerform final validation using the project's documented test, lint, typecheck, format, and build commands. Do not edit source files in this phase. Report each command and exit code, and do not claim success without evidence. End with WORKFLOW_STATUS: VALIDATION_PASSED or WORKFLOW_STATUS: VALIDATION_FAILED.`;
    default:
      return `${common}\n\nResume the current workflow phase and report a precise status. ${extra}`;
  }
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
  ctx.ui.notify(`[dev-workflow] ${message}`, type);
}

export default function softwareDevelopmentWorkflow(pi: ExtensionAPI) {
  let state: WorkflowState = createInitialState();
  let pending: PendingAction;
  let pendingCommitMessage = "";
  let currentContext: ExtensionContext | undefined;

  const setState = (next: WorkflowState) => {
    state = next;
    pi.appendEntry(STATE_ENTRY_TYPE, state);
    currentContext?.ui.setStatus("dev-workflow", state.phase === "idle" ? undefined : `workflow: ${state.phase}`);
  };

  const runGit = (args: string[], cwd: string, timeout = 15_000) =>
    pi.exec("git", args, { cwd, timeout });

  const sendPrompt = (content: string, ctx: ExtensionContext) => {
    if (!ctx.isIdle()) {
      pending = { kind: "prompt", content };
      return;
    }
    pi.sendUserMessage(content);
  };

  const queuePrompt = (content: string) => {
    pending = { kind: "prompt", content };
  };

  const block = (ctx: ExtensionContext, message: string) => {
    setState({
      ...state,
      phase: "blocked",
      blockedFromPhase: state.phase,
      lastError: message,
      updatedAt: new Date().toISOString(),
    });
    notify(ctx, message, "error");
  };

  const preflight = async (ctx: ExtensionCommandContext): Promise<boolean> => {
    setState(transition(state, "preflight", { lastError: undefined }));
    const inspection = await inspectGitRepository((args, cwd) => runGit(args, cwd), ctx.cwd);
    if (!inspection.ok) {
      block(ctx, inspection.message);
      return false;
    }

    const ghResult = await pi.exec("gh", ["--version"], { cwd: inspection.repositoryRoot, timeout: 5_000 });
    const next = transition(state, "analysis", {
      repositoryRoot: inspection.repositoryRoot,
      baseBranch: inspection.baseBranch,
      baseCommit: inspection.baseCommit,
      requestSummary: state.requestSummary,
      blockedFromPhase: undefined,
      lastError: undefined,
    });
    setState(next);
    notify(
      ctx,
      `Pre-flight passed on ${next.baseBranch} @ ${next.baseCommit.slice(0, 12)}. Remote: ${inspection.hasOrigin ? "available" : "not configured"}; gh: ${ghResult.code === 0 ? "available" : "not available"}.`,
    );
    return true;
  };

  const createWorkingBranch = async (ctx: ExtensionCommandContext): Promise<boolean> => {
    const statusResult = await runGit(["status", "--porcelain=v1"], state.repositoryRoot);
    const headResult = await runGit(["rev-parse", "HEAD"], state.repositoryRoot);
    if (statusResult.code !== 0 || statusResult.stdout.trim() || headResult.stdout.trim() !== state.baseCommit) {
      block(ctx, "The repository changed before branch creation. The workflow stopped without modifying it.");
      return false;
    }

    const candidate = branchNameFromRequest(state.requestSummary || "software change");
    const result = await runGit(["switch", "-c", candidate], state.repositoryRoot);
    if (result.code !== 0) {
      block(ctx, `Unable to create branch ${candidate}: ${result.stderr.trim() || "the branch may already exist"}`);
      return false;
    }

    const next = transition(state, "implementation", {
      workingBranch: candidate,
      planApproved: true,
      blockedFromPhase: undefined,
      lastError: undefined,
    });
    setState(next);
    notify(ctx, `Created branch ${candidate}. Implementation may begin.`);
    return true;
  };

  const commitChanges = async (ctx: ExtensionContext) => {
    const message = pendingCommitMessage || `feat: implement ${state.requestSummary || "approved software change"}`;
    const result = await commitRepositoryChanges((args, cwd) => runGit(args, cwd), state.repositoryRoot, {
      expectedBranch: state.workingBranch,
      message,
    });
    if (!result.ok) {
      block(ctx, result.message);
      return;
    }

    setState(transition(state, "awaiting_push_confirmation", {
      finalValidationPassed: true,
      commit: { hash: result.hash, message },
      blockedFromPhase: undefined,
      lastError: undefined,
    }));
    notify(ctx, `Created commit ${result.hash.slice(0, 12)}: ${message}`);
    notify(ctx, "Use /dev-workflow push to request push confirmation.");
  };

  const handleSignal = (event: AgentEndEvent, ctx: ExtensionContext) => {
    if (!["analysis", "implementation", "review", "fixes", "final_validation"].includes(state.phase)) return;
    const signal = extractWorkflowSignal(event.messages);
    if (!signal) return;
    const text = assistantText(event);

    switch (signal) {
      case "PLAN_READY":
        if (state.phase === "analysis") {
          setState(transition(state, "awaiting_plan_approval", {
            planSummary: compactPlan(text),
            planRevision: state.planRevision + 1,
            lastError: undefined,
          }));
          notify(ctx, "Plan ready. Review it and use /dev-workflow approve to continue.");
        }
        break;
      case "BLOCKED":
        setState({
          ...state,
          phase: "blocked",
          blockedFromPhase: state.phase,
          lastError: "The agent reported a blocking question or decision.",
          updatedAt: new Date().toISOString(),
        });
        notify(ctx, "The workflow is blocked. Resolve the question, then use /dev-workflow resume.", "warning");
        break;
      case "IMPLEMENTATION_COMPLETE":
        if (state.phase === "implementation") {
          pendingCommitMessage = extractCommitMessage(event.messages) || pendingCommitMessage;
          setState(transition(state, "review", { reviewRound: state.reviewRound + 1, lastError: undefined }));
          queuePrompt(phasePrompt(state, "review"));
        }
        break;
      case "REVIEW_NO_FINDINGS":
        if (state.phase === "review") {
          setState(transition(state, "final_validation", { openFindings: 0, lastError: undefined }));
          queuePrompt(phasePrompt(state, "final_validation"));
        }
        break;
      case "REVIEW_FINDINGS":
        if (state.phase === "review") {
          setState(transition(state, "fixes", { openFindings: Math.max(1, state.openFindings), lastError: undefined }));
          queuePrompt(phasePrompt(state, "fixes"));
        }
        break;
      case "FIXES_COMPLETE":
        if (state.phase === "fixes") {
          if (state.reviewRound < MAX_REVIEW_ROUNDS) {
            setState(transition(state, "review", { reviewRound: state.reviewRound + 1, lastError: undefined }));
            queuePrompt(phasePrompt(state, "review"));
          } else {
            setState(transition(state, "final_validation", { openFindings: 0, lastError: undefined }));
            queuePrompt(phasePrompt(state, "final_validation"));
          }
        }
        break;
      case "VALIDATION_PASSED":
        if (state.phase === "final_validation") {
          setState({ ...state, finalValidationPassed: true, updatedAt: new Date().toISOString() });
          pending = { kind: "commit" };
        }
        break;
      case "VALIDATION_FAILED":
        if (state.phase === "final_validation") {
          setState({
            ...state,
            phase: "blocked",
            blockedFromPhase: "final_validation",
            finalValidationPassed: false,
            lastError: "Required final validation failed.",
            updatedAt: new Date().toISOString(),
          });
          notify(ctx, "Final validation failed. Resolve the failure and use /dev-workflow resume.", "error");
        }
        break;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    state = latestPersistedState(ctx) || createInitialState(ctx.sessionManager.getSessionId());
    ctx.ui.setStatus("dev-workflow", state.phase === "idle" ? undefined : `workflow: ${state.phase}`);
    if (state.phase !== "idle" && state.phase !== "completed" && state.phase !== "aborted") {
      notify(ctx, `Restored active workflow in phase ${state.phase}. Use /dev-workflow status or /dev-workflow resume.`);
    }
  });

  pi.on("before_agent_start", (event, _ctx) => {
    if (["idle", "completed", "aborted"].includes(state.phase)) return;
    const guard = `\n\n## Software Development Workflow\nCurrent phase: ${state.phase}\nRepository writes are ${["implementation", "fixes"].includes(state.phase) ? "allowed only within the approved scope" : "blocked by the extension"}.\nDo not commit, push, create a PR, or bypass these phase restrictions.\n`;
    return { systemPrompt: `${event.systemPrompt}${guard}` };
  });

  pi.on("tool_call", (event) => {
    const reason = shouldBlockTool(state.phase, event.toolName, event.input);
    if (reason) return { block: true, reason };
    return undefined;
  });

  pi.on("user_bash", (event) => {
    const reason = shouldBlockTool(state.phase, "bash", { command: event.command });
    if (!reason) return undefined;
    return {
      result: {
        output: `[dev-workflow] ${reason}`,
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    currentContext = ctx;
    handleSignal(event, ctx);
    ctx.ui.setStatus("dev-workflow", state.phase === "idle" ? undefined : `workflow: ${state.phase}`);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!pending || !ctx.isIdle()) return;
    const action = pending;
    pending = undefined;
    if (action.kind === "prompt") {
      pi.sendUserMessage(action.content);
    } else if (action.kind === "commit" && state.phase === "final_validation" && state.finalValidationPassed) {
      await commitChanges(ctx as ExtensionCommandContext);
    }
  });

  pi.registerCommand("dev-workflow", {
    description: "Run the Software Development Workflow: /dev-workflow start|status|approve|resume|review|push|pr|abort",
    getArgumentCompletions: (prefix) => {
      const actions = ["start", "status", "approve", "resume", "review", "push", "pr", "abort"];
      const filtered = actions.filter((action) => action.startsWith(prefix.trim()));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      currentContext = ctx;
      const { action, value } = parseWorkflowCommand(args);

      if (action === "status") {
        notify(ctx, formatStatus(state));
        return;
      }

      if (action === "start") {
        if (!["idle", "completed", "aborted"].includes(state.phase)) {
          notify(ctx, `A workflow is already active in phase ${state.phase}.`, "warning");
          return;
        }
        if (!ctx.isIdle()) {
          notify(ctx, "Wait until the current agent turn is idle before starting a workflow.", "warning");
          return;
        }

        const request = value || (ctx.hasUI ? await ctx.ui.input("Development request", "Describe the change to implement") : undefined);
        if (!request?.trim()) {
          notify(ctx, "A development request is required.", "warning");
          return;
        }
        state = createInitialState(ctx.sessionManager.getSessionId());
        pending = undefined;
        pendingCommitMessage = "";
        setState({ ...state, requestSummary: compactPlan(request, 1200) });
        pi.setSessionName(`Software development: ${request.trim().slice(0, 72)}`);
        if (await preflight(ctx)) sendPrompt(phasePrompt(state, "analysis"), ctx);
        return;
      }

      if (action === "approve") {
        if (state.phase !== "awaiting_plan_approval") {
          notify(ctx, `Plan approval is not available in phase ${state.phase}.`, "warning");
          return;
        }
        if (await createWorkingBranch(ctx)) sendPrompt(phasePrompt(state, "implementation"), ctx);
        return;
      }

      if (action === "review") {
        if (!["implementation", "review", "fixes"].includes(state.phase)) {
          notify(ctx, `Review cannot start in phase ${state.phase}.`, "warning");
          return;
        }
        if (state.phase !== "review") {
          setState(transition(state, "review", { reviewRound: state.reviewRound + 1, lastError: undefined }));
        }
        sendPrompt(phasePrompt(state, "review"), ctx);
        return;
      }

      if (action === "resume") {
        if (state.phase === "blocked") {
          const target = state.blockedFromPhase || (state.planApproved ? "implementation" : "analysis");
          if (target === "preflight") {
            if (await preflight(ctx)) sendPrompt(phasePrompt(state, "analysis"), ctx);
            return;
          }
          if (!["analysis", "implementation", "review", "fixes", "final_validation", "awaiting_plan_approval", "awaiting_push_confirmation", "awaiting_pr_confirmation"].includes(target)) {
            notify(ctx, `This workflow cannot be resumed from phase ${target}.`, "warning");
            return;
          }
          setState(transition(state, target, { blockedFromPhase: undefined, lastError: undefined }));
        }
        if (["analysis", "implementation", "review", "fixes", "final_validation"].includes(state.phase)) {
          sendPrompt(phasePrompt(state, state.phase), ctx);
        } else if (state.phase === "awaiting_plan_approval") {
          notify(ctx, "The plan is ready for approval. Review it and use /dev-workflow approve.");
        } else if (state.phase === "awaiting_push_confirmation") {
          notify(ctx, "The commit is ready. Use /dev-workflow push to request confirmation.");
        } else if (state.phase === "awaiting_pr_confirmation") {
          notify(ctx, "The branch is pushed. Use /dev-workflow pr to request confirmation.");
        } else {
          notify(ctx, `This workflow cannot be resumed from phase ${state.phase}.`, "warning");
        }
        return;
      }

      if (action === "push") {
        if (state.phase !== "awaiting_push_confirmation" || !state.commit) {
          notify(ctx, `Push confirmation is not available in phase ${state.phase}.`, "warning");
          return;
        }
        if (!ctx.hasUI) {
          notify(ctx, "Push is refused in non-interactive mode.", "warning");
          return;
        }
        const confirmed = await ctx.ui.confirm("Push branch", `Push ${state.workingBranch} (${state.commit.hash.slice(0, 12)}) to origin?`);
        if (!confirmed) {
          setState(transition(state, "completed", { push: { attempted: false, completed: false } }));
          notify(ctx, "Push declined. The workflow is complete with the commit kept locally.");
          return;
        }
        setState({ ...state, push: { attempted: true, completed: false }, updatedAt: new Date().toISOString() });
        const pushResult = await runGit(["push", "-u", "origin", state.workingBranch || "HEAD"], state.repositoryRoot);
        if (pushResult.code !== 0) {
          block(ctx, `Push failed: ${pushResult.stderr.trim() || pushResult.stdout.trim()}`);
          return;
        }
        setState(transition(state, "awaiting_pr_confirmation", { push: { attempted: true, completed: true }, lastError: undefined }));
        notify(ctx, "Push completed. Use /dev-workflow pr to request PR confirmation.");
        return;
      }

      if (action === "pr") {
        if (state.phase !== "awaiting_pr_confirmation" || !state.commit) {
          notify(ctx, `Pull request confirmation is not available in phase ${state.phase}.`, "warning");
          return;
        }
        if (!ctx.hasUI) {
          notify(ctx, "Pull request creation is refused in non-interactive mode.", "warning");
          return;
        }
        const title = state.commit.message;
        const body = buildPullRequestBody({
          requestSummary: state.requestSummary,
          commitHash: state.commit.hash,
        });
        const confirmed = await ctx.ui.confirm("Create pull request", `Create a PR from ${state.workingBranch} to ${state.baseBranch}?\n\nTitle: ${title}`);
        if (!confirmed) {
          setState(transition(state, "completed", { pullRequest: { attempted: false, completed: false } }));
          notify(ctx, "Pull request creation declined. The pushed branch remains available.");
          return;
        }
        const ghCheck = await pi.exec("gh", ["--version"], { cwd: state.repositoryRoot, timeout: 5_000 });
        if (ghCheck.code !== 0) {
          setState(transition(state, "completed", { pullRequest: { attempted: true, completed: false } }));
          notify(ctx, "The gh CLI is not available. Create the pull request manually from the pushed branch.", "warning");
          return;
        }
        setState({ ...state, pullRequest: { attempted: true, completed: false }, updatedAt: new Date().toISOString() });
        const prResult = await pi.exec("gh", [
          "pr",
          "create",
          "--base",
          state.baseBranch,
          "--head",
          state.workingBranch || "HEAD",
          "--title",
          title,
          "--body",
          body,
        ], { cwd: state.repositoryRoot, timeout: 30_000 });
        if (prResult.code !== 0) {
          block(ctx, `Pull request creation failed: ${prResult.stderr.trim() || prResult.stdout.trim()}`);
          return;
        }
        const url = prResult.stdout.trim().split(/\s+/).find((part) => part.startsWith("http"));
        setState(transition(state, "completed", { pullRequest: { attempted: true, completed: true, url }, lastError: undefined }));
        notify(ctx, `Pull request created${url ? `: ${url}` : "."}`);
        return;
      }

      if (action === "abort") {
        if (["idle", "completed", "aborted"].includes(state.phase)) {
          notify(ctx, "No active workflow to abort.", "warning");
          return;
        }
        setState({ ...state, phase: "aborted", lastError: undefined, updatedAt: new Date().toISOString() });
        notify(ctx, "Workflow aborted. Existing branch and changes were left untouched.", "warning");
        return;
      }

      notify(ctx, "Usage: /dev-workflow start|status|approve|resume|review|push|pr|abort", "warning");
    },
  });
}
