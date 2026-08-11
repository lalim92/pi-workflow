export async function commitRepositoryChanges(run, cwd, { expectedBranch, message }) {
  const branchResult = await run(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
  const currentBranch = branchResult.stdout.trim();
  if (branchResult.code !== 0 || !currentBranch) {
    return { ok: false, reason: "detached_head", message: "Cannot commit from a detached HEAD." };
  }
  if (expectedBranch && currentBranch !== expectedBranch) {
    return {
      ok: false,
      reason: "branch_mismatch",
      message: `Refusing to commit on ${currentBranch}; expected ${expectedBranch}.`,
    };
  }

  const statusResult = await run(["status", "--porcelain=v1"], cwd);
  if (statusResult.code !== 0) {
    return { ok: false, reason: "status_failed", message: statusResult.stderr.trim() || "Unable to inspect final changes." };
  }
  if (!statusResult.stdout.trim()) {
    return { ok: false, reason: "no_changes", message: "Final validation passed but there are no changes to commit." };
  }

  const diffCheck = await run(["diff", "--check"], cwd);
  if (diffCheck.code !== 0) {
    return {
      ok: false,
      reason: "diff_check_failed",
      message: diffCheck.stderr.trim() || diffCheck.stdout.trim() || "Final diff check failed.",
    };
  }

  const addResult = await run(["add", "-A"], cwd);
  if (addResult.code !== 0) {
    return { ok: false, reason: "stage_failed", message: addResult.stderr.trim() || "Unable to stage final changes." };
  }

  const commitResult = await run(["commit", "-m", message], cwd);
  if (commitResult.code !== 0) {
    return { ok: false, reason: "commit_failed", message: commitResult.stderr.trim() || "Unable to create the commit." };
  }

  const hashResult = await run(["rev-parse", "HEAD"], cwd);
  if (hashResult.code !== 0 || !hashResult.stdout.trim()) {
    return { ok: false, reason: "hash_failed", message: "Commit succeeded but its hash could not be determined." };
  }

  return {
    ok: true,
    hash: hashResult.stdout.trim(),
    message,
    changedFiles: statusResult.stdout.trim().split("\n"),
  };
}

export function buildPullRequestBody({ requestSummary = "", validationSummary = "", commitHash = "" } = {}) {
  return `## Summary\n\n${requestSummary || "Implemented the approved software development plan."}\n\n## Validation\n\n${validationSummary || "Final validation passed in the Pi Software Development Workflow."}\n\n## Commit\n\n${commitHash || "Not available"}`;
}
