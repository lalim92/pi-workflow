import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workflowExtension = resolve(testDirectory, "../extensions/software-development.ts");
const scriptedProvider = resolve(testDirectory, "fixtures/scripted-provider.ts");
const piAvailable = spawnSync("pi", ["--version"], { encoding: "utf8" }).status === 0;

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-scripted-e2e-"));
  runGit(["init", "-b", "main"], directory);
  runGit(["config", "user.email", "test@example.com"], directory);
  runGit(["config", "user.name", "Pi Workflow E2E Test"], directory);
  writeFileSync(join(directory, "README.md"), "# Scripted workflow fixture\n");
  runGit(["add", "README.md"], directory);
  runGit(["commit", "-m", "chore: initialize scripted fixture"], directory);
  return directory;
}

function runScriptedWorkflow(cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("pi", [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "-e",
      workflowExtension,
      "-e",
      scriptedProvider,
      "--model",
      "scripted-workflow/workflow-scripted",
    ], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const phases = [];
    let stdout = "";
    let stderr = "";
    let buffered = "";
    let approved = false;
    let settled = false;
    let finishTimer;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        child.kill("SIGTERM");
        reject(error);
        return;
      }

      let completed = false;
      const complete = () => {
        if (completed) return;
        completed = true;
        clearTimeout(finishTimer);
        resolvePromise({ phases, stdout, stderr });
      };
      child.once("exit", complete);
      child.stdin.end();
      finishTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
        setTimeout(complete, 1_000);
      }, 2_000);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out during scripted workflow.\nPhases: ${phases.join(", ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);

    const handleEvent = (event) => {
      if (event.type === "entry_appended"
        && event.entry?.customType === "software-development-workflow-state") {
        const phase = event.entry.data?.phase;
        if (phase && phases.at(-1) !== phase) phases.push(phase);

        if (phase === "blocked") {
          finish(new Error(`Scripted workflow became blocked: ${event.entry.data?.lastError || "unknown error"}`));
          return;
        }
        if (phase === "awaiting_plan_approval" && !approved) {
          approved = true;
          child.stdin.write(`${JSON.stringify({
            id: "approve",
            type: "prompt",
            message: "/dev-workflow approve",
          })}\n`);
        }
        if (phase === "awaiting_push_confirmation") {
          finish();
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        stdout += `${line}\n`;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // Ignore non-JSON diagnostics while preserving them in stdout.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(error));

    child.stdin.write(`${JSON.stringify({
      id: "start",
      type: "prompt",
      message: "/dev-workflow start Add the scripted output file",
    })}\n`);
  });
}

test("runs the full workflow with a deterministic provider and real Pi tools", { skip: !piAvailable }, async () => {
  const directory = createFixture();
  try {
    const result = await runScriptedWorkflow(directory);
    assert.deepEqual(result.phases, [
      "idle",
      "preflight",
      "analysis",
      "awaiting_plan_approval",
      "implementation",
      "review",
      "fixes",
      "review",
      "final_validation",
      "awaiting_push_confirmation",
    ]);
    assert.equal(readFileSync(join(directory, "scripted-output.txt"), "utf8"), "corrected scripted content\n");
    assert.match(runGit(["branch", "--show-current"], directory), /^feature\//);
    assert.match(runGit(["log", "-1", "--format=%s"], directory), /^feat: add scripted output$/);
    assert.equal(runGit(["status", "--porcelain=v1"], directory), "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
