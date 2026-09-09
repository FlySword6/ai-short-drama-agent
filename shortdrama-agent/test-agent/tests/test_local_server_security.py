import os
import unittest
from unittest.mock import patch

from short_drama_agent.local_server_security import (
    DEFAULT_LOCAL_ORIGINS,
    local_cors_origins,
    loopback_bind_host,
)


class LocalServerSecurityTest(unittest.TestCase):
    def test_cors_defaults_to_explicit_loopback_origins(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                local_cors_origins("TEST_CORS_ORIGINS"),
                list(DEFAULT_LOCAL_ORIGINS),
            )

    def test_cors_accepts_explicit_loopback_origins(self):
        with patch.dict(
            os.environ,
            {"TEST_CORS_ORIGINS": "http://localhost:3000,https://127.0.0.1:8443"},
            clear=True,
        ):
            self.assertEqual(
                local_cors_origins("TEST_CORS_ORIGINS"),
                ["http://localhost:3000", "https://127.0.0.1:8443"],
            )

    def test_cors_rejects_wildcard_and_non_loopback_origins(self):
        for value in ("*", "regex:https://.*", "https://example.com"):
            with self.subTest(value=value), patch.dict(
                os.environ,
                {"TEST_CORS_ORIGINS": value},
                clear=True,
            ):
                with self.assertRaises(ValueError):
                    local_cors_origins("TEST_CORS_ORIGINS")

    def test_bind_host_defaults_to_loopback_and_rejects_public_hosts(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(loopback_bind_host("TEST_HOST"), "127.0.0.1")
        for value in ("0.0.0.0", "10.0.0.8", "example.com"):
            with self.subTest(value=value), patch.dict(
                os.environ,
                {"TEST_HOST": value},
                clear=True,
            ):
                with self.assertRaises(ValueError):
                    loopback_bind_host("TEST_HOST")
