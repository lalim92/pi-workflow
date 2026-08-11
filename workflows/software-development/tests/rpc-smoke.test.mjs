import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../extensions/software-development.ts");
const piAvailable = spawnSync("pi", ["--version"], { encoding: "utf8" }).status === 0;

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-rpc-"));
  runGit(["init", "-b", "main"], directory);
  runGit(["config", "user.email", "test@example.com"], directory);
  runGit(["config", "user.name", "Pi Workflow RPC Test"], directory);
  writeFileSync(join(directory, "README.md"), "fixture\n");
  runGit(["add", "README.md"], directory);
  runGit(["commit", "-m", "initial"], directory);
  return directory;
}

function runRpc(cwd, command, predicate, timeoutMs = 12_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("pi", [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "-e",
      extensionPath,
    ], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const events = [];
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolvePromise({ events, stdout, stderr });
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for Pi RPC event.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          events.push(event);
          if (predicate(event, events)) finish();
        } catch {
          // Keep non-JSON diagnostic output in the captured stream.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled && code !== 0 && signal !== "SIGTERM") {
        finish(new Error(`Pi RPC exited unexpectedly: code=${code}, signal=${signal}\nstderr:\n${stderr}`));
      }
    });

    child.stdin.write(`${JSON.stringify(command)}\n`);
  });
}

function isStateEvent(event, phase) {
  return event.type === "entry_appended"
    && event.entry?.customType === "software-development-workflow-state"
    && event.entry.data?.phase === phase;
}

function hasState(events, phase) {
  return events.some((event) => isStateEvent(event, phase));
}

test("loads the extension command through Pi RPC", { skip: !piAvailable }, async () => {
  const result = await runRpc(process.cwd(), { id: "commands", type: "get_commands" }, (event) => event.id === "commands" && event.success);
  const commands = result.events.find((event) => event.id === "commands")?.data?.commands || [];
  assert.ok(commands.some((command) => command.name === "dev-workflow"));
});

test("blocks a dirty repository before analysis", { skip: !piAvailable }, async () => {
  const directory = createFixture();
  try {
    writeFileSync(join(directory, "untracked.txt"), "dirty\n");
    const result = await runRpc(directory, {
      id: "start",
      type: "prompt",
      message: "/dev-workflow start smoke test",
    }, (event) => isStateEvent(event, "blocked") || (
      event.type === "extension_ui_request"
      && event.method === "notify"
      && String(event.message).toLowerCase().includes("repository is not clean")
    ));
    assert.ok(hasState(result.events, "blocked"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("passes pre-flight on a clean repository and enters analysis", { skip: !piAvailable }, async () => {
  const directory = createFixture();
  try {
    const result = await runRpc(directory, {
      id: "start",
      type: "prompt",
      message: "/dev-workflow start clean smoke test",
    }, (event) => isStateEvent(event, "analysis"));
    assert.ok(hasState(result.events, "preflight"));
    assert.ok(hasState(result.events, "analysis"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
