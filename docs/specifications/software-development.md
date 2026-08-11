# Software Development Workflow Specification

- **Workflow identifier:** `software-development`
- **Human name:** Software Development Workflow
- **Specification version:** `0.1.0-draft`
- **Status:** Proposed — ready for implementation review
- **Target runtime:** Pi interactive terminal mode
- **Required dependencies:** Pi alone
- **Optional future integrations:** Pi sub-agents, RPC, SDK, CI, IDE clients

## 1. Purpose

The Software Development Workflow provides a lightweight, project-aware lifecycle for implementing software changes with Pi.

It is designed for a single user working in a terminal session. It must support common development tasks without imposing a complex project-management system, external service, or mandatory project files.

The workflow is responsible for coordinating the interaction between the user, Pi, the target Git repository, and the phase-specific prompts. It is not intended to replace the project's own architecture, testing, release, or contribution guidelines.

## 2. Goals

The first functional version must:

1. analyze a development request and the target repository;
2. ask only questions that block a safe or correct implementation;
3. produce a complete implementation plan;
4. wait for explicit user approval before modifying the repository;
5. refuse to start when the repository is not clean;
6. create a dedicated branch after plan approval;
7. implement the approved plan while following project guidelines;
8. perform a purely technical review of the resulting changes;
9. apply in-scope technical review fixes automatically;
10. validate the final result;
11. create a commit automatically when final validation succeeds;
12. ask for confirmation before pushing the branch;
13. ask separately for confirmation before creating a pull request;
14. keep task-specific state in the current Pi session;
15. remain usable without Pi sub-agents or other external services.

## 3. Non-goals for version 0.1

The first version does not require:

- Pi sub-agents;
- multiple independent reviewers;
- parallel execution;
- RPC or SDK support;
- CI/CD orchestration;
- IDE-specific integration;
- a web interface;
- task plans written into the target repository;
- automatic push;
- automatic pull request creation without confirmation;
- automatic merge or issue closure;
- specialized workflows for individual languages or frameworks;
- a complete operating-system sandbox;
- a general-purpose task or TODO manager;
- arbitrary project management features.

The workflow may be extended later, but version 0.1 must remain small enough to understand and test as a whole.

## 4. Design principles

### 4.1 User remains the authority

The workflow may make routine engineering decisions, but the user owns decisions involving:

- product behavior;
- scope;
- public APIs;
- architecture changes with broad impact;
- security posture;
- release, push, or publication;
- destructive actions.

The workflow must stop and ask when one of these decisions is not covered by the approved plan.

### 4.2 One active workflow and one writer

Only one `software-development` workflow may be active in a session.

The main Pi agent is the only implementation writer in version 0.1. The review phase is a separate technical pass performed by the same Pi agent, with modifications blocked during the review.

Future sub-agent support must preserve one writer per worktree.

### 4.3 Project conventions take precedence

The workflow must inspect and follow, in order of relevance:

1. explicit user instructions;
2. project `AGENTS.md`, `CLAUDE.md`, or equivalent instructions;
3. project contribution and development documentation;
4. existing source and test conventions;
5. generic development conventions.

The workflow must not impose a generic convention when the project already defines a different one.

### 4.4 Progressive disclosure

Stable project rules belong in the target project's context files. Phase-specific workflow guidance belongs in prompt templates or an on-demand skill. The extension should inject only the state and information required for the current phase.

### 4.5 No destructive recovery by default

The workflow must never silently run commands such as:

- `git reset --hard`;
- `git clean`;
- destructive file removal;
- forced branch replacement;
- forced push;
- merge or release operations.

If recovery is needed, the workflow must stop and explain the situation.

## 5. User-facing workflow

The normal user journey is:

```text
start request
  ↓
pre-flight
  ↓
analysis and clarification
  ↓
plan displayed
  ↓
explicit user approval
  ↓
branch creation
  ↓
implementation
  ↓
technical review
  ↓
automatic in-scope fixes when needed
  ↓
final validation
  ↓
automatic commit
  ↓
confirmation before push
  ↓
confirmation before pull request
  ↓
final summary
```

The workflow must remain resumable after a failed command, interrupted model turn, refused confirmation, or temporary provider error.

## 6. Lifecycle state machine

### 6.1 States

| State | Meaning | Repository writes allowed | Automatic transition |
|---|---|---:|---|
| `idle` | No active workflow | No | On `start` |
| `preflight` | Repository and project checks are running | No | On successful checks |
| `analysis` | Request and repository are being analyzed | No | When analysis is complete |
| `awaiting_plan_approval` | Plan is displayed and awaiting user decision | No | On approval or rejection |
| `implementation` | Approved changes are being implemented | Yes | When implementation settles |
| `review` | Technical-only review is running | No | On review completion |
| `fixes` | In-scope review findings are being fixed | Yes | On fixes completion |
| `final_validation` | Final checks and delivery preparation are running | No source edits by default | On successful validation |
| `awaiting_push_confirmation` | Commit exists and push confirmation is required | No | On confirmation or refusal |
| `awaiting_pr_confirmation` | Push is complete or intentionally skipped and PR confirmation is required | No | On confirmation or refusal |
| `completed` | Workflow finished | No automatic writes | Never |
| `blocked` | User decision or external problem blocks progress | No | Explicit user action |
| `aborted` | User intentionally stopped the workflow | No | Never |

### 6.2 Valid transitions

```text
idle → preflight
preflight → analysis
preflight → blocked
analysis → awaiting_plan_approval
analysis → blocked
awaiting_plan_approval → implementation
awaiting_plan_approval → analysis
awaiting_plan_approval → aborted
implementation → review
implementation → blocked
review → fixes
review → final_validation
review → blocked
fixes → review
fixes → final_validation
fixes → blocked
final_validation → awaiting_push_confirmation
final_validation → blocked
awaiting_push_confirmation → awaiting_pr_confirmation
awaiting_push_confirmation → completed
awaiting_pr_confirmation → completed
```

A rejected or modified plan returns to `analysis`. A rejected push or pull request does not constitute a workflow failure; the final summary must record the refusal and provide the manual command when appropriate.

### 6.3 State persistence

The extension must persist state using Pi session custom entries through `pi.appendEntry()`.

State entries must not be sent to the model by default. They must be reconstructable during `session_start` by scanning the current session entries and using the latest workflow state entry.

The persisted state must include at least:

```ts
interface WorkflowState {
  workflow: "software-development";
  version: 1;
  phase: WorkflowPhase;
  sessionId: string;
  repositoryRoot: string;
  baseBranch: string;
  baseCommit: string;
  workingBranch?: string;
  requestSummary?: string;
  planApproved: boolean;
  planRevision: number;
  reviewRound: number;
  openFindings: number;
  finalValidationPassed: boolean;
  commit?: {
    hash: string;
    message: string;
  };
  push?: {
    attempted: boolean;
    completed: boolean;
  };
  pullRequest?: {
    attempted: boolean;
    completed: boolean;
    url?: string;
  };
  blockedFromPhase?: WorkflowPhase;
  lastError?: string;
  updatedAt: string;
}
```

The exact TypeScript shape may evolve during implementation, but persisted entries must be versioned so future versions can migrate them safely.

## 7. Starting a workflow

The package must not hijack every normal Pi conversation. A workflow must be started explicitly.

The first implementation should expose one extension command with a stable namespace:

```text
/dev-workflow <action> [arguments]
```

The initial actions are:

| Command | Purpose |
|---|---|
| `/dev-workflow start [request]` | Start a workflow. If no request is supplied, the next user input becomes the request. |
| `/dev-workflow status` | Display the current phase, branch, validation state, and blocking reason. |
| `/dev-workflow approve` | Approve the current plan. |
| `/dev-workflow review` | Explicitly start or repeat the technical review when automatic transition is not possible. |
| `/dev-workflow resume` | Resume a blocked workflow after the user has resolved the blocker. |
| `/dev-workflow abort` | Stop the active workflow without deleting or reverting changes. |
| `/dev-workflow push` | Request the push confirmation explicitly. |
| `/dev-workflow pr` | Request the pull request confirmation explicitly. |

The implementation may add command completion and concise aliases later. It must not create a large command surface for version 0.1.

After a successful phase, the extension should automatically queue the next phase prompt when safe. Explicit commands remain available for recovery and manual resumption.

## 8. Pre-flight requirements

The pre-flight phase must run before analysis and before any branch creation.

### 8.1 Repository checks

The workflow must:

1. resolve the current working directory;
2. resolve the Git repository root;
3. reject non-Git directories;
4. reject detached `HEAD` unless explicitly supported later;
5. capture the current branch;
6. capture the current `HEAD` commit;
7. inspect the working tree;
8. reject tracked and untracked changes;
9. detect whether a remote is available for later publication;
10. detect whether `gh` is available before offering PR creation.

The initial cleanliness check should use Git's machine-readable output, such as:

```bash
git status --porcelain=v1
```

Any output must block the workflow.

The workflow must not automatically clean, stash, reset, or commit pre-existing changes.

### 8.2 Project context checks

The agent must inspect or use the context loaded by Pi, including:

- `AGENTS.md`;
- `CLAUDE.md`;
- project README;
- contribution guidelines;
- build and test configuration;
- package manager scripts;
- repository-specific automation.

The workflow must avoid re-injecting complete context files when Pi has already loaded them.

### 8.3 Pre-flight result

A successful pre-flight records:

- repository root;
- base branch;
- base commit;
- detected project language;
- available validation commands;
- publication capabilities;
- session identifier.

## 9. Analysis and clarification

The analysis phase is read-only from the workflow's perspective.

### 9.1 Allowed behavior

The agent may:

- read files;
- search the repository;
- inspect Git history and status;
- inspect project configuration;
- inspect issue or specification content;
- run safe read-only discovery commands;
- ask the user blocking questions.

### 9.2 Required output

The analysis must produce a plan containing:

```md
# Implementation Plan

## Goal

## Understanding

## Scope

## Non-goals

## Constraints and project guidelines

## Assumptions

## Blocking questions

## Current project state

## Proposed design

## Files and components

## Implementation sequence

## Test strategy

## Validation commands

## Risks and mitigations

## Acceptance criteria

## Decisions requiring user approval
```

The plan must be sufficiently detailed for another capable agent to implement it without repeating the repository reconnaissance.

### 9.3 Questions

Questions are allowed only when the answer affects correctness, scope, architecture, security, or delivery.

The agent should group questions into a single concise message. It should not ask for confirmation on routine local implementation choices that can be inferred from the project.

## 10. Plan approval

The plan must be shown to the user before the repository can be modified.

Approval must be explicit. The first implementation may use `/dev-workflow approve` as the canonical approval command.

Approval must record:

- the approved plan revision;
- the approval timestamp;
- the user approval event identifier;
- the plan summary used for subsequent phases.

If the user asks for changes, the workflow returns to `analysis` and increments `planRevision`.

If approval is refused, the workflow enters `aborted` unless the user requests a revision.

## 11. Branch creation

Branch creation occurs only after plan approval and before the first source modification.

### 11.1 Branch naming

The default prefix is inferred from the request when possible and selected from:

```text
feature/
fix/
refactor/
chore/
docs/
test/
ci/
perf/
```

The inference is conservative and keyword-based. If no clear category is detected, `feature/` is used. References such as `#123`, `issue 123`, or `ticket #123` are moved into the branch prefix without being duplicated in the slug.

The suffix must be lowercase kebab-case and derived from the approved request. If an issue number is available, it should appear first in the suffix:

```text
feature/123-add-oauth-login
```

If a project has a documented branch convention, it takes precedence.

### 11.2 Branch safety

The workflow must:

- create the branch from the recorded base commit;
- refuse to overwrite an existing branch;
- refuse to continue if the working tree became dirty before branch creation;
- record the resulting branch name;
- report branch creation before starting implementation.

No force switch or force branch replacement is allowed.

## 12. Implementation

The implementation phase uses the normal Pi editing tools and follows the approved plan.

The implementation prompt must include or make available:

- the approved plan summary;
- acceptance criteria;
- detected project guidelines;
- validation commands;
- non-goals;
- the current branch;
- the rule to escalate unapproved decisions.

The agent may:

- create and edit source files;
- add or update tests;
- update documentation required by the plan;
- run project validation commands;
- inspect the resulting diff.

The agent must not:

- change product scope without approval;
- publish or push changes;
- create a pull request;
- remove unrelated user data;
- hide validation failures;
- claim success without evidence.

At the end of implementation, the agent must report:

- changed files;
- implemented behavior;
- tests added or changed;
- commands run and exit codes;
- unresolved issues;
- decisions made within the approved scope;
- decisions requiring the user.

## 13. Technical review

The review phase is read-only with respect to source files.

### 13.1 Review scope

The review must inspect the actual Git diff and compare it with:

- the approved plan;
- the acceptance criteria;
- project conventions;
- the test strategy.

It must cover, when relevant:

- correctness;
- regressions;
- error handling;
- edge cases;
- state and concurrency;
- security;
- performance;
- tests and validation;
- compatibility;
- documentation and public contracts.

### 13.2 Review restrictions

During review, the agent must not:

- use `write` or `edit`;
- modify source files through `bash`;
- commit;
- push;
- create a PR;
- silently fix findings.

Tests and read-only inspection commands are allowed. Test commands that modify generated artifacts must be tolerated if they do not modify tracked source or configuration files.

### 13.3 Finding format

Each finding must contain:

```md
## [SEVERITY] path/to/file:line

### Problem

### Impact

### Evidence

### Recommended fix

### Scope
```

Allowed severities:

- `BLOCKER` — must be fixed before delivery;
- `HIGH` — significant bug, regression, or risk;
- `MEDIUM` — should be fixed before delivery;
- `LOW` — non-blocking technical issue;
- `OPTIONAL` — useful but intentionally deferred.

A purely stylistic preference without technical impact should not be reported as a required finding.

## 14. Automatic fixes

After review, the workflow must distinguish:

1. in-scope technical fixes;
2. invalid or unsupported findings;
3. optional improvements;
4. out-of-scope findings;
5. findings requiring user decisions.

In-scope technical fixes are applied automatically.

A finding requires user input when applying it would change:

- product behavior;
- scope;
- public API;
- architecture materially;
- security assumptions;
- dependencies or deployment;
- acceptance criteria.

After fixes, the workflow must run focused validation.

The default maximum is one correction pass. A second review pass is required when the fixes are substantial, touch critical code, or resolve `BLOCKER` or `HIGH` findings. The workflow must stop rather than enter an unbounded review loop.

Out-of-scope findings must be included in the final summary as deferred work.

## 15. Final validation

Final validation must be based on project guidelines and the approved plan.

The workflow should run, when available:

- unit tests;
- integration tests;
- lint;
- formatting checks;
- type checking;
- build;
- project-specific validation.

Validation commands must be reported with:

- command;
- exit code;
- relevant output or failure summary;
- whether the command directly exercised the changed code.

A failed required validation blocks automatic commit.

If no automated tests exist, the workflow must state that fact and use the best available validation, such as build, typecheck, targeted execution, or documented manual verification.

## 16. Commit

The commit is created automatically only after:

- implementation is complete;
- review findings are resolved or explicitly deferred;
- required validation passes;
- the final diff contains only expected files;
- no unresolved blocker remains.

The project convention takes precedence. Otherwise, the default format is Conventional Commits:

```text
type(scope): imperative summary
```

The commit body should be added when it improves traceability, especially for non-trivial changes.

The workflow must record:

- commit hash;
- commit message;
- changed-file summary;
- validation evidence.

No automatic commit is created when validation fails or when unexpected changes are detected.

## 17. Push and pull request

Push and pull request creation require separate user confirmations.

### 17.1 Push

The workflow must display:

- branch name;
- remote name;
- commit hash;
- destination ref;
- concise validation result.

It then asks for confirmation before running the push.

Force push is never allowed automatically.

### 17.2 Pull request

The workflow must display or prepare:

- title;
- body;
- base branch;
- head branch;
- summary of changes;
- validation results;
- deferred findings or risks.

It then asks for separate confirmation before creating the PR.

If `gh` is unavailable, the workflow must not fail the completed implementation. It must provide the appropriate manual command or URL when possible.

Push and PR actions must be refused in non-interactive modes unless a future explicit automation policy is implemented.

## 18. Final summary

The final response must include:

- original objective;
- implemented changes;
- files changed;
- tests and validation commands;
- review result;
- fixes applied;
- deferred findings;
- branch name;
- commit hash and message;
- push status;
- PR status;
- residual risks;
- recommended next action.

The summary must clearly distinguish:

- completed work;
- work intentionally deferred;
- actions refused by the user;
- validations that were not available.

## 19. Protection model

Version 0.1 uses pragmatic Pi extension protections, not an operating-system sandbox.

### 19.1 Tool-call protection

The extension must inspect `tool_call` events and block or modify calls according to the current phase.

At minimum:

- `write` and `edit` are blocked before plan approval;
- `write` and `edit` are blocked during review;
- Git publication commands are blocked until their confirmation phase;
- destructive commands are blocked or require explicit confirmation;
- blocked calls return a clear reason to the model and user.

### 19.2 User shell protection

The extension should inspect `user_bash` events for commands entered through `!` and `!!` when they would bypass workflow protections.

The implementation must document that command inspection is not a perfect security boundary. Arbitrary scripts and indirect commands cannot be fully classified without a sandbox or dedicated command execution layer.

### 19.3 Non-interactive behavior

When `ctx.hasUI` is false:

- analysis may proceed only when no interaction is required;
- plan approval must fail safely rather than be assumed;
- push and PR must be refused by default;
- the workflow must return a machine-readable error or clear textual explanation.

## 20. Language behavior

The extension and prompts must not force a single natural language.

The workflow should infer:

- user language from the current interaction;
- project language from documentation, source conventions, and existing messages;
- commit and PR language from the project convention.

User instructions have priority for the interaction language. Project conventions have priority for code, comments, documentation, commits, and PR content.

## 21. Token and context policy

The workflow must optimize for low token usage.

Rules:

- keep phase prompts concise;
- do not duplicate `AGENTS.md` or `CLAUDE.md` content;
- do not inject the complete session history into phase prompts;
- store technical state in custom session entries;
- inject only a compact approved-plan summary when needed;
- use one reviewer by default;
- do not perform external research unless needed;
- use read-only discovery before broad file reads;
- preserve Pi auto-compaction;
- use focused validation instead of repeatedly running every possible check.

The workflow must not replace Pi's entire system prompt.

## 22. Pi resources

The package manifest exposes the workflow resources from:

```text
workflows/software-development/extensions/
workflows/software-development/prompts/
workflows/software-development/skills/
```

Planned resources:

```text
extensions/software-development.ts
prompts/analysis.md
prompts/implementation.md
prompts/review.md
prompts/fixes.md
prompts/finalization.md
skills/software-development/SKILL.md
```

The initial implementation should prefer one extension file and a small number of prompt templates. Pure Git, state, and orchestration helpers may live under `lib/` so they can be tested without starting Pi. Files should be split only when that improves testing or comprehension.

The package must not depend on `pi-subagents` for version 0.1.

## 23. Testing requirements

The second implementation pass adds Pi RPC smoke tests in addition to the dependency-free unit tests. These tests use temporary Git repositories and verify extension loading, dirty-repository refusal, and clean-repository entry into analysis.

### 23.1 Unit tests

Tests must cover:

- state transitions;
- invalid transitions;
- state serialization and restoration;
- repository cleanliness detection;
- branch slug generation;
- issue-number handling;
- commit message generation;
- finding classification;
- confirmation decisions;
- non-interactive refusal behavior.

### 23.2 Extension tests

Tests must cover:

- session startup restoration;
- state persistence through `pi.appendEntry()`;
- tool-call blocking;
- user shell interception;
- automatic phase follow-up;
- blocked-phase recovery;
- push confirmation;
- PR confirmation.

### 23.3 Git integration tests

Tests must use temporary Git repositories and must cover:

1. clean repository acceptance;
2. tracked modification refusal;
3. untracked file refusal;
4. branch creation;
5. implementation-to-review transition;
6. review-to-fixes transition;
7. final validation failure;
8. successful commit;
9. push refusal;
10. PR refusal;
11. missing remote;
12. missing `gh` executable.

No test may modify the user's development repositories.

## 24. Future extensions

The following are explicitly deferred:

- independent reviewer process;
- Pi sub-agent integration;
- multi-reviewer fanout;
- worktree orchestration;
- RPC client support;
- SDK embedding;
- IDE integration;
- CI/CD mode;
- stronger sandboxing;
- additional workflow types.

Future integrations must preserve the version 0.1 invariants: explicit plan approval, clean repository pre-flight, one writer per worktree, no silent push or PR, and clear final evidence.

## 25. Acceptance criteria for version 0.1

The implementation is acceptable when the following scenario works in a temporary clean Git repository:

1. `/dev-workflow start` starts the workflow.
2. The repository and project context are analyzed.
3. Blocking questions are asked only when necessary.
4. A complete plan is displayed.
5. Source modification is blocked before approval.
6. `/dev-workflow approve` records approval.
7. A dedicated branch is created.
8. The approved implementation can modify files.
9. The implementation is followed by a technical-only review.
10. Review fixes are applied automatically when in scope.
11. Required validations run and are reported.
12. A successful run creates one commit.
13. Push requires explicit confirmation.
14. PR creation requires a separate explicit confirmation.
15. A dirty repository is refused before any workflow changes.
16. Aborted or blocked workflows do not delete or revert user work.
17. Session reload reconstructs the current workflow state.
18. The package can be loaded by Pi without `pi-subagents`.
