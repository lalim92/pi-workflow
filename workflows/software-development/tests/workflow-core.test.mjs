import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { inspectGitRepository } from "../lib/git-preflight.mjs";
import {
  buildPullRequestBody,
  commitRepositoryChanges,
  findSuspiciousFiles,
  parseChangedFiles,
} from "../lib/git-delivery.mjs";
import { applyWorkflowSignal } from "../lib/workflow-engine.mjs";
import { discoverValidationCommands, formatValidationSummary, runValidationCommands } from "../lib/validation.mjs";
import {
  branchName,
  branchNameFromRequest,
  canTransition,
  compactPlan,
  createInitialState,
  extractCommitMessage,
  extractWorkflowSignal,
  isMutatingShellCommand,
  normalizeBranchSlug,
  parseWorkflowCommand,
  shouldBlockTool,
  transition,
} from "../lib/workflow-core.mjs";

function gitRunner(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    code: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function createGitFixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-test-"));
  gitRunner(["init", "-b", "main"], directory);
  gitRunner(["config", "user.email", "test@example.com"], directory);
  gitRunner(["config", "user.name", "Pi Workflow Test"], directory);
  writeFileSync(join(directory, "README.md"), "fixture\n");
  gitRunner(["add", "README.md"], directory);
  gitRunner(["commit", "-m", "initial"], directory);
  return directory;
}

test("creates an idle session state", () => {
  const state = createInitialState("session-1");
  assert.equal(state.workflow, "software-development");
  assert.equal(state.version, 1);
  assert.equal(state.phase, "idle");
  assert.equal(state.sessionId, "session-1");
  assert.equal(state.planApproved, false);
  assert.equal(state.blockedFromPhase, undefined);
});

test("allows the planned phase transitions and rejects invalid ones", () => {
  assert.equal(canTransition("idle", "preflight"), true);
  assert.equal(canTransition("awaiting_plan_approval", "implementation"), true);
  assert.equal(canTransition("blocked", "preflight"), true);
  assert.equal(canTransition("blocked", "awaiting_push_confirmation"), true);
  assert.equal(canTransition("review", "implementation"), false);
  assert.throws(() => transition(createInitialState(), "implementation"), /Invalid workflow transition/);
});

test("runs the complete deterministic workflow signal sequence", () => {
  let state = createInitialState("session-flow");
  state = transition(state, "preflight");
  state = transition(state, "analysis");

  let result = applyWorkflowSignal(state, "PLAN_READY", { planSummary: "Add the feature" });
  assert.equal(result.state.phase, "awaiting_plan_approval");
  assert.equal(result.state.planRevision, 1);

  state = transition(result.state, "implementation", { planApproved: true, workingBranch: "feature/add-the-feature" });
  result = applyWorkflowSignal(state, "IMPLEMENTATION_COMPLETE");
  assert.equal(result.state.phase, "review");
  assert.deepEqual(result.action, { kind: "prompt", phase: "review" });

  state = result.state;
  result = applyWorkflowSignal(state, "REVIEW_FINDINGS");
  assert.equal(result.state.phase, "fixes");
  assert.deepEqual(result.action, { kind: "prompt", phase: "fixes" });

  state = result.state;
  result = applyWorkflowSignal(state, "FIXES_COMPLETE");
  assert.equal(result.state.phase, "review");
  assert.equal(result.state.reviewRound, 2);

  state = result.state;
  result = applyWorkflowSignal(state, "REVIEW_NO_FINDINGS");
  assert.equal(result.state.phase, "final_validation");

  result = applyWorkflowSignal(result.state, "VALIDATION_PASSED");
  assert.equal(result.state.phase, "final_validation");
  assert.equal(result.state.finalValidationPassed, true);
  assert.deepEqual(result.action, { kind: "commit" });
});

test("returns to the exact blocked phase after validation failure", () => {
  let state = createInitialState("session-blocked");
  state = transition(state, "preflight");
  state = transition(state, "analysis");
  state = transition(state, "awaiting_plan_approval");
  state = transition(state, "implementation", { planApproved: true });
  state = transition(state, "review", { reviewRound: 1 });
  state = transition(state, "final_validation");

  const result = applyWorkflowSignal(state, "VALIDATION_FAILED");
  assert.equal(result.state.phase, "blocked");
  assert.equal(result.state.blockedFromPhase, "final_validation");
  assert.equal(result.handled, true);
});

test("preserves state while transitioning", () => {
  const state = transition(createInitialState(), "preflight", { repositoryRoot: "/tmp/project" });
  assert.equal(state.phase, "preflight");
  assert.equal(state.repositoryRoot, "/tmp/project");
  assert.notEqual(state.updatedAt, undefined);
});

test("parses workflow commands", () => {
  assert.deepEqual(parseWorkflowCommand("approve"), { action: "approve", value: "" });
  assert.deepEqual(parseWorkflowCommand("start add OAuth login"), { action: "start", value: "add OAuth login" });
  assert.deepEqual(parseWorkflowCommand(""), { action: "status", value: "" });
});

test("accepts a clean Git repository during pre-flight", async () => {
  const directory = createGitFixture();
  try {
    const result = await inspectGitRepository(gitRunner, directory);
    assert.equal(result.ok, true);
    assert.equal(result.baseBranch, "main");
    assert.equal(result.hasOrigin, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("parses changed paths and rejects obvious generated files", () => {
  assert.deepEqual(parseChangedFiles(" M src/app.ts\n?? .DS_Store\nR  old.ts -> new.ts\n"), ["src/app.ts", ".DS_Store", "new.ts"]);
  assert.deepEqual(findSuspiciousFiles(["src/app.ts", ".DS_Store", "coverage/summary.json", "notes.md"]), [
    ".DS_Store",
    "coverage/summary.json",
  ]);
});

test("commits only on the expected branch", async () => {
  const directory = createGitFixture();
  try {
    writeFileSync(join(directory, "change.txt"), "change\n");
    const result = await commitRepositoryChanges(gitRunner, directory, {
      expectedBranch: "main",
      message: "feat: add fixture change",
    });
    assert.equal(result.ok, true);
    assert.equal(result.message, "feat: add fixture change");
    assert.match(result.hash, /^[0-9a-f]{40}$/);

    const clean = gitRunner(["status", "--porcelain=v1"], directory);
    assert.equal(clean.stdout, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses to commit suspicious generated files", async () => {
  const directory = createGitFixture();
  try {
    writeFileSync(join(directory, ".DS_Store"), "generated\n");
    const result = await commitRepositoryChanges(gitRunner, directory, {
      expectedBranch: "main",
      message: "feat: should not include artifacts",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "suspicious_files");
    assert.match(result.message, /\.DS_Store/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses to commit when the branch changed", async () => {
  const directory = createGitFixture();
  try {
    gitRunner(["switch", "-c", "other"], directory);
    writeFileSync(join(directory, "change.txt"), "change\n");
    const result = await commitRepositoryChanges(gitRunner, directory, {
      expectedBranch: "main",
      message: "feat: should not commit",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "branch_mismatch");
    assert.match(result.message, /expected main/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("discovers validation scripts from a project package", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-validation-"));
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({
      scripts: { test: "node --test", lint: "eslint .", build: "tsc" },
    }));
    const validation = discoverValidationCommands(directory);
    assert.deepEqual(validation.commands.map((command) => command.args), [
      ["test"],
      ["run", "lint"],
      ["run", "build"],
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs validation commands and formats their evidence", async () => {
  const calls = [];
  const validation = await runValidationCommands(async (args) => {
    calls.push(args);
    return { code: args[0] === "fail" ? 1 : 0, stdout: "ok", stderr: "", killed: false };
  }, "/tmp/project", [
    { label: "first", args: ["first"] },
    { label: "second", args: ["fail"] },
    { label: "third", args: ["third"] },
  ]);
  assert.equal(validation.ok, false);
  assert.deepEqual(calls, [["first"], ["fail"]]);
  assert.match(formatValidationSummary(validation), /second: failed \(1\)/);
});

test("builds a pull request body with the delivery context", () => {
  const body = buildPullRequestBody({ requestSummary: "Add login", commitHash: "abc123" });
  assert.match(body, /Add login/);
  assert.match(body, /abc123/);
  assert.match(body, /Final validation passed/);
});

test("refuses tracked and untracked Git changes during pre-flight", async () => {
  const directory = createGitFixture();
  try {
    writeFileSync(join(directory, "README.md"), "changed\n");
    let result = await inspectGitRepository(gitRunner, directory);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "dirty");

    gitRunner(["checkout", "--", "README.md"], directory);
    writeFileSync(join(directory, "untracked.txt"), "untracked\n");
    result = await inspectGitRepository(gitRunner, directory);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "dirty");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normalizes branch slugs", () => {
  assert.equal(normalizeBranchSlug("Add OAuth login!"), "add-oauth-login");
  assert.equal(normalizeBranchSlug("Éviter les doubles espaces"), "eviter-les-doubles-espaces");
  assert.equal(branchName("Add OAuth login", "feature", "42"), "feature/42-add-oauth-login");
});

test("uses a safe fallback for empty branch requests", () => {
  assert.equal(branchName("!!!", "unknown"), "feature/software-change");
});

test("infers branch type and issue number from a request", () => {
  assert.equal(branchNameFromRequest("Fix timeout handling #42"), "fix/42-timeout-handling");
  assert.equal(branchNameFromRequest("Update the README"), "docs/update-the-readme");
  assert.equal(branchNameFromRequest("Add OAuth login"), "feature/add-oauth-login");
});

test("classifies mutating shell commands", () => {
  assert.equal(isMutatingShellCommand("git status --porcelain"), false);
  assert.equal(isMutatingShellCommand("git commit -m test"), true);
  assert.equal(isMutatingShellCommand("git push -u origin feature/test"), true);
  assert.equal(isMutatingShellCommand("npm test"), false);
  assert.equal(isMutatingShellCommand("printf x > output.txt"), true);
});

test("blocks writes and publication during protected phases", () => {
  assert.match(shouldBlockTool("analysis", "write", { path: "x" }), /blocked/);
  assert.match(shouldBlockTool("review", "edit", { path: "x" }), /blocked/);
  assert.match(shouldBlockTool("implementation", "bash", { command: "git commit -m test" }), /blocked/);
  assert.match(shouldBlockTool("awaiting_push_confirmation", "bash", { command: "git push origin feature/test" }), /blocked/);
  assert.equal(shouldBlockTool("implementation", "bash", { command: "npm test" }), undefined);
  assert.equal(shouldBlockTool("idle", "write", { path: "x" }), undefined);
});

test("extracts only the last workflow signal from assistant content", () => {
  const messages = [
    { role: "user", content: "WORKFLOW_STATUS: PLAN_READY" },
    { role: "assistant", content: [{ type: "text", text: "I am still working.\nWORKFLOW_STATUS: VALIDATION_FAILED" }] },
    { role: "assistant", content: "Validation is now complete. WORKFLOW_STATUS: VALIDATION_PASSED" },
  ];
  assert.equal(extractWorkflowSignal(messages), "VALIDATION_PASSED");
  assert.equal(extractWorkflowSignal([{ role: "assistant", content: "No marker" }]), undefined);
});

test("extracts commit messages only from assistant content", () => {
  assert.equal(extractCommitMessage([
    { role: "user", content: "WORKFLOW_COMMIT: should-not-be-used" },
    { role: "assistant", content: "WORKFLOW_COMMIT: feat(auth): add login" },
  ]), "feat(auth): add login");
});

test("compacts long plans within the requested limit", () => {
  assert.equal(compactPlan("  short plan  "), "short plan");
  const compacted = compactPlan("x".repeat(200), 100);
  assert.ok(compacted.length <= 100);
  assert.match(compacted, /truncated/);
});
