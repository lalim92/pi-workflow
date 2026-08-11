# Tests

Tests for the Software Development Workflow and its Pi extensions live here.

The current suite covers the dependency-free workflow core: phase transitions, command parsing, branch naming, shell mutation classification, tool protections, workflow signals, plan compaction, and Git pre-flight. Pi RPC smoke tests also verify extension loading, dirty-repository refusal, and clean-repository entry into analysis.

Run the tests from the repository root with:

```bash
npm test
```
