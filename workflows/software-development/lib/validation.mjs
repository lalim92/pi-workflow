import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT_ORDER = ["test", "lint", "typecheck", "type-check", "format:check", "format-check", "build"];

function detectPackageManager(root) {
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

export function discoverValidationCommands(root) {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) return { commands: [], warnings: [] };

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    return {
      commands: [],
      warnings: [`Unable to parse ${packagePath}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const scripts = packageJson?.scripts;
  if (!scripts || typeof scripts !== "object") return { commands: [], warnings: [] };

  const manager = detectPackageManager(root);
  const commands = [];
  for (const script of SCRIPT_ORDER) {
    if (typeof scripts[script] !== "string") continue;
    const args = script === "test" && manager === "npm" ? ["test"] : ["run", script];
    commands.push({
      label: `${manager} ${args.join(" ")}`,
      args,
      script,
    });
  }

  return { commands, warnings: [] };
}

export async function runValidationCommands(run, cwd, commands, options = {}) {
  const timeout = options.timeout ?? 120_000;
  const stopOnFailure = options.stopOnFailure ?? true;
  const results = [];

  for (const command of commands) {
    const result = await run(command.args, cwd, timeout);
    const entry = {
      ...command,
      code: result.code,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      killed: Boolean(result.killed),
    };
    results.push(entry);
    if (result.code !== 0 && stopOnFailure) break;
  }

  return {
    ok: results.length === commands.length && results.every((result) => result.code === 0),
    results,
  };
}

export function formatValidationSummary(validation) {
  if (!validation?.results?.length) return "No validation commands were discovered.";
  return validation.results
    .map((result) => `${result.label}: ${result.code === 0 ? "passed" : `failed (${result.code})`}`)
    .join("\n");
}
