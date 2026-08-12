# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- Add the initial `software-development` workflow scaffolding.
- Add the proposed functional specification for the `software-development` workflow.
- Add the first functional Pi extension, phase prompts, skill guidance, and workflow-core tests.
- Add Pi RPC smoke tests and harden signal parsing, blocked-phase recovery, and session status updates.
- Add branch-type and issue-number inference plus guarded commit delivery helpers.
- Add persisted-session restoration coverage through a synthetic Pi session file.
- Extract deterministic phase-signal orchestration and cover the complete review/fix/validation path.
- Add a scripted-provider end-to-end test covering real Pi tool calls, branch creation, review fixes, validation, and commit creation.
- Execute discovered project validation commands before commit, reject obvious generated artifacts, and add GitHub Actions CI.
- Validate local package installation and declare the Pi runtime as a peer dependency.
- License the project under the BSD Zero Clause License (0BSD).
