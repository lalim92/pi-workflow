import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { inspectGitRepository } from "../lib/git-preflight.mjs";
import {
  branchName,
  canTransition,
  compactPlan,
  createInitialState,
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
});

test("allows the planned phase transitions and rejects invalid ones", () => {
  assert.equal(canTransition("idle", "preflight"), true);
  assert.equal(canTransition("awaiting_plan_approval", "implementation"), true);
  assert.equal(canTransition("review", "implementation"), false);
  assert.throws(() => transition(createInitialState(), "implementation"), /Invalid workflow transition/);
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
  assert.equal(shouldBlockTool("implementation", "bash", { command: "npm test" }), undefined);
  assert.equal(shouldBlockTool("idle", "write", { path: "x" }), undefined);
});

test("extracts workflow signals from assistant content", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "Plan complete.\nWORKFLOW_STATUS: PLAN_READY" }] },
  ];
  assert.equal(extractWorkflowSignal(messages), "PLAN_READY");
  assert.equal(extractWorkflowSignal([{ role: "assistant", content: "WORKFLOW_STATUS: VALIDATION_FAILED" }]), "VALIDATION_FAILED");
  assert.equal(extractWorkflowSignal([{ role: "assistant", content: "No marker" }]), undefined);
});

test("compacts long plans without changing short plans", () => {
  assert.equal(compactPlan("  short plan  "), "short plan");
  const compacted = compactPlan("x".repeat(100), 30);
  assert.ok(compacted.length <= 100);
  assert.match(compacted, /truncated/);
});
