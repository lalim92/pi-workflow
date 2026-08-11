# Tests

Tests for the Software Development Workflow and its Pi extensions live here.

The current suite covers the dependency-free workflow core: phase transitions, the complete deterministic signal sequence, command parsing, branch type and issue inference, shell mutation classification, tool protections, workflow signals, plan compaction, Git pre-flight, and guarded commit delivery. Pi RPC smoke tests verify extension loading, dirty-repository refusal, clean-repository entry into analysis, and restoration from a persisted session file. The scripted end-to-end test runs the complete lifecycle with a deterministic provider and real Pi tools in a temporary Git repository.

Run the tests from the repository root with:

```bash
npm test
```
