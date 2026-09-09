"""Frozen v0.3 command surface.  It intentionally has no legacy aliases.

Every command lives in a domain module; this package only re-exports them so
`from shortdrama_cli.cli.v030 import auth_app, project_app, ...` keeps working.
`build_business_client`/`build_login_client` are re-exported because they are
the seam the contract tests replace — see `_helpers._business_client`.
"""

from __future__ import annotations

from shortdrama_cli.cli.common import build_business_client, build_login_client
from shortdrama_cli.cli.v030.asset import asset_app
from shortdrama_cli.cli.v030.auth import auth_app
from shortdrama_cli.cli.v030.delivery import delivery_app
from shortdrama_cli.cli.v030.generation import generation_app
from shortdrama_cli.cli.v030.prep import prep_app
from shortdrama_cli.cli.v030.project import project_app
from shortdrama_cli.cli.v030.queue import queue_app
from shortdrama_cli.cli.v030.review import review_app
from shortdrama_cli.cli.v030.reference import reference_app
from shortdrama_cli.cli.v030.reference_test import reference_test_app
from shortdrama_cli.cli.v030.script import script_app

__all__ = [
    "asset_app",
    "auth_app",
    "build_business_client",
    "build_login_client",
    "delivery_app",
    "generation_app",
    "prep_app",
    "project_app",
    "queue_app",
    "reference_app",
    "review_app",
    "reference_test_app",
    "script_app",
]
