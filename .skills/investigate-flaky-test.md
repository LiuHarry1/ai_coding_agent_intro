---
name: investigate-flaky-test
description: Dispatch a fork agent to find the root cause of a flaky test. Use when the test passes locally but fails in CI, or vice versa.
context: fork
agent: general_purpose
arguments: "test_path"
---

You are investigating a flaky test. Don't fix it yet — diagnose first.

Test under investigation: **$test_path**

Procedure:

1. Read the test and the code under test. Note any time / random / network / filesystem / global-state interactions.
2. Run the test in isolation 10 times: `npm test -- $test_path` (or equivalent). Note pass/fail ratio.
3. If it always passes alone, run the WHOLE test file 10 times. If it now flakes, the bug is test-order dependence — find the polluting test.
4. If it flakes alone, instrument with extra `console.log` of the suspect values, run again, narrow.
5. Stop once you have a confident root-cause hypothesis. Do NOT attempt a fix — write a report.

Report:
- **Root cause**: one sentence.
- **Evidence**: minimum repro command + the specific values / order that triggers the bug.
- **Suggested fix**: 1-3 sentences, no code.
- **Confidence**: high / medium / low + why.
