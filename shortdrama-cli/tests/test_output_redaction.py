import json

from shortdrama_cli.output.formatter import redact_output


def test_output_projection_redacts_nested_sensitive_payloads() -> None:
    value = {
        "status": "succeeded",
        "data": {
            "task_id": "task-1",
            "prompt": "private prompt",
            "tool_result": {"raw": "provider body"},
            "nested": [{"token": "test-token", "title": "safe title"}],
        },
    }

    rendered = json.dumps(redact_output(value), ensure_ascii=False)

    assert "task-1" in rendered
    assert "safe title" in rendered
    for private_value in ("private prompt", "provider body", "test-token"):
        assert private_value not in rendered
    assert rendered.count("[redacted]") == 3


def test_output_projection_keeps_non_sensitive_identifiers_and_status() -> None:
    assert redact_output({"status": "failed", "error": {"code": "not_authorized"}, "request_id": "req-1"}) == {
        "status": "failed",
        "error": {"code": "not_authorized"},
        "request_id": "req-1",
    }
