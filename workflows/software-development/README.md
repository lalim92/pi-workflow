# Software Development Workflow

This workflow provides a lightweight development lifecycle for Pi.

## Planned phases

1. Pre-flight repository and project-context checks.
2. Request analysis and clarification.
3. Detailed plan and explicit user approval.
4. Branch creation and implementation.
5. Technical-only code review.
6. Automatic in-scope fixes.
7. Final validation, commit, and optional push or pull request.

## Package resources

- `extensions/` will contain the Pi extension responsible for phase state, transitions, and protections.
- `prompts/` will contain concise prompts for the individual phases.
- `skills/` will contain on-demand guidance that should not be loaded on every turn.
- `tests/` will contain tests for the workflow behavior and extension logic.

The workflow is not implemented yet. The specification is maintained in `docs/specifications/software-development.md`.
