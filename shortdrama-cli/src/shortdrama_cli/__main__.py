"""Executable module entrypoint for binary packaging."""

from shortdrama_cli.main import app


def main() -> None:
    """Run the Typer app when packaged as a binary or module."""

    app()


if __name__ == "__main__":
    main()
