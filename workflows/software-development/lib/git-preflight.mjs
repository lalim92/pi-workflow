export async function inspectGitRepository(run, cwd) {
  const rootResult = await run(["rev-parse", "--show-toplevel"], cwd);
  if (rootResult.code !== 0) {
    return { ok: false, reason: "not_git", message: "The current directory is not inside a Git repository." };
  }

  const repositoryRoot = rootResult.stdout.trim();
  const statusResult = await run(["status", "--porcelain=v1"], repositoryRoot);
  if (statusResult.code !== 0) {
    return {
      ok: false,
      reason: "status_failed",
      message: `Unable to inspect Git status: ${statusResult.stderr.trim() || "unknown error"}`,
    };
  }
  if (statusResult.stdout.trim()) {
    return {
      ok: false,
      reason: "dirty",
      message: "The repository is not clean. Commit, stash, or remove existing changes before starting the workflow.",
    };
  }

  const branchResult = await run(["symbolic-ref", "--quiet", "--short", "HEAD"], repositoryRoot);
  if (branchResult.code !== 0 || !branchResult.stdout.trim()) {
    return {
      ok: false,
      reason: "detached_head",
      message: "The workflow does not support a detached HEAD. Switch to a named branch first.",
    };
  }

  const commitResult = await run(["rev-parse", "HEAD"], repositoryRoot);
  if (commitResult.code !== 0 || !commitResult.stdout.trim()) {
    return {
      ok: false,
      reason: "commit_failed",
      message: "Unable to determine the repository base commit.",
    };
  }

  const remoteResult = await run(["remote", "get-url", "origin"], repositoryRoot);
  return {
    ok: true,
    repositoryRoot,
    baseBranch: branchResult.stdout.trim(),
    baseCommit: commitResult.stdout.trim(),
    hasOrigin: remoteResult.code === 0 && Boolean(remoteResult.stdout.trim()),
  };
}
