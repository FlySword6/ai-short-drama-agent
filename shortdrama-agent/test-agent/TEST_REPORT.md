# Test Report: Script Breakdown Sub-Agent

Date: 2026-07-01

## Summary

The main project now mounts a production `script_breakdown` sub-agent through
`AgentTool`. The sub-agent is responsible for breaking script text into four
asset groups: characters, scenes, props, and storyboards.

All tests pass locally.

```text
Ran 5 tests in 0.154s
OK
```

## Test Environment

- Python: managed by `uv` from the project lockfile
- Test command: `uv run python -m unittest discover -s tests -v`
- SDKs under test:
  - `veadk-python==0.5.40`
  - `google-adk==1.32.0`
  - `a2a-sdk>=0.3.7,<1.0.0`
- External services: not used by tests
- Model calls: replaced with fake LLM implementations
- VikingDB / MCP Router: mocked or bypassed in tests

## Coverage

### Production Integration

- Verifies the root agent factory appends the script breakdown routing
  instruction to the main agent prompt.
- Verifies the `script_breakdown` tool is mounted before the MCP router.
- Verifies the production sub-agent is exposed as an `AgentTool`.

### Structured Output

- Verifies `ScriptBreakdownResult` validates all required output groups:
  - `characters`
  - `scenes`
  - `props`
  - `storyboards`

### Runner Dispatch

- Uses fake LLMs to verify the main agent calls `script_breakdown` for a script
  breakdown prompt.
- Verifies the final user-facing answer includes character, scene, prop, and
  storyboard sections.
- Verifies the answer includes the follow-up prompt for optional storage or
  asset-file generation.

### A2A Protocol

- Verifies the script breakdown flow works through A2A `message/send`.
- Verifies the A2A task completes successfully.
- Verifies the A2A event history contains a `script_breakdown` function call.

### Existing Sub-Agent A2A Regression

- Keeps the existing two-sub-agent A2A workflow test passing.
- Verifies `script_creative` and `project_scheduler` are still dispatched in
  order.

## Test Cases

```text
test_factory_mounts_script_breakdown_tool_before_mcp_router ... ok
test_main_agent_dispatches_script_breakdown_for_breakdown_prompt ... ok
test_schema_validates_characters_scenes_props_storyboards ... ok
test_script_breakdown_works_through_a2a_message_send ... ok
test_subagents_are_dispatched_through_a2a_message_send ... ok
```

## Warnings

The test run emits SDK warnings from ADK and VeADK:

- ADK A2A executor and converters are marked experimental.
- `plugins` argument deprecation warning appears inside ADK runner internals.
- `MCPToolset` deprecation warning appears while importing the MCP router.
- Local environment has no `.env` or `config.yaml`.

These warnings do not fail the test run and are not caused by the script
breakdown implementation.

## Result

Status: PASS

The script breakdown sub-agent is connected to the main project and covered by
unit, runner, and A2A protocol tests.
