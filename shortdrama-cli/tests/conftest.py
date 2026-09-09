import pytest


@pytest.fixture(autouse=True)
def isolate_cli_config(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """Keep tests away from the user's real CLI session."""

    monkeypatch.setenv("SHORTDRAMA_CONFIG_HOME", str(tmp_path / "config"))


@pytest.fixture(autouse=True)
def reset_display_language() -> None:
    """Keep CLI text language deterministic across in-process invocations."""

    from shortdrama_cli.i18n import set_language

    set_language("zh")
