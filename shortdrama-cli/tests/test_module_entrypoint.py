import shortdrama_cli.__main__ as module_entrypoint


def test_module_entrypoint_invokes_typer_app(monkeypatch) -> None:
    called: list[bool] = []

    monkeypatch.setattr(module_entrypoint, "app", lambda: called.append(True))

    module_entrypoint.main()

    assert called == [True]
