# Software Development Workflow Specification

**Status:** Draft — specification to be completed before implementation.

## Purpose

Define a lightweight, project-aware software development workflow for Pi that works with Pi alone and can later support optional integrations.

## Scope

The workflow covers:

- request and repository analysis;
- blocking clarification questions;
- implementation planning and approval;
- implementation;
- technical review;
- in-scope fixes;
- final validation and delivery preparation.

## Non-goals

The first version does not require:

- Pi sub-agents;
- RPC or SDK integration;
- CI/CD orchestration;
- specialized workflows per programming language;
- mandatory project files for storing task plans;
- automatic push or pull request creation.

## Design principles

- Keep the workflow small and understandable.
- Require explicit plan approval before implementation.
- Refuse to start when the target Git repository is not clean.
- Keep task-specific state in the current Pi session.
- Apply technical fixes automatically when they remain within the approved scope.
- Require confirmation before pushing or creating a pull request.
- Follow project conventions before applying generic conventions.
- Optimize token usage through progressive disclosure and focused phase prompts.

## Detailed specification

To be written and reviewed before implementation.
