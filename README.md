# pi-workflow

Reusable workflows for [Pi](https://pi.dev).

The repository is intentionally organized as a home for multiple workflows. Each workflow lives under `workflows/<workflow-name>/` and can provide its own prompts, skills, extensions, tests, and documentation.

## Available workflows

### Software Development Workflow

**Identifier:** `software-development`

A lightweight, project-aware workflow for software development:

1. Analyze the request and the repository.
2. Ask only blocking clarification questions.
3. Produce a detailed implementation plan and wait for approval.
4. Implement the approved plan.
5. Perform a purely technical code review.
6. Apply in-scope review fixes when needed.
7. Run final validation and prepare the branch, commit, push, or pull request according to explicit permissions.

The workflow is designed to work with Pi alone. Optional integrations may be added later without making them mandatory for the core workflow.

## Repository structure

```text
workflows/
└── software-development/
    ├── extensions/   # Pi extensions and workflow state management
    ├── prompts/      # Phase-specific prompt templates
    ├── skills/       # On-demand workflow guidance
    └── tests/        # Workflow and extension tests

docs/
└── specifications/  # Versioned workflow specifications
```

## Status

The repository contains the package scaffolding, the detailed specification, the first functional extension, phase prompts, an on-demand skill, and core behavior tests. The implementation is still under active development and has not been released as a stable version.

## Installation

The package can be installed globally once a workflow version is ready:

```bash
pi install git:github.com/lalim92/pi-workflow@<tag-or-commit>
```

During local development, load the package from a local path or use the Pi package mechanisms documented in the official Pi documentation.

## License

This project is released under the [BSD Zero Clause License (0BSD)](LICENSE), a permissive open-source license that allows reuse, modification, and redistribution without requiring attribution.

## Security

Pi extensions execute with the permissions of the current user. Review all extension code before installing or enabling a package, especially when using workflows that can run shell commands or perform Git operations.
