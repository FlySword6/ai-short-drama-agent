"""Trusted-environment resolution: the CLI endpoint catalogue is the only source."""

import io
import unittest
from contextlib import redirect_stderr
from unittest import mock

from shortdrama_cli.api.errors import ApiConfigurationError
from shortdrama_cli.i18n import t as cli_translate
from shortdrama_cli.server_api import endpoints as cli_endpoints

from pi_http_wrapper import trusted_endpoint
from pi_http_wrapper.config import ConfigurationError, Settings
from pi_http_wrapper.main_chain import MainChainAdapter, build_main_chain_adapter


class FakeClient:
    def request(self, method, path, body=None):
        return {}

    def upload(self, path, filename, content, content_type, fields):
        raise AssertionError("upload was not expected")


def _base_environ(**overrides):
    environ = {
        "PI_WRAPPER_BEARER_TOKENS": "token-a",
        "PI_WRAPPER_INTERNAL_TOKEN": "internal-token",
    }
    environ.update(overrides)
    return environ


class TrustedEndpointReuseTests(unittest.TestCase):
    """The wrapper must consume the CLI catalogue, never copy it."""

    def test_catalogue_object_is_the_cli_object_not_a_copy(self) -> None:
        self.assertIs(trusted_endpoint.TRUSTED_ENDPOINTS, cli_endpoints.TRUSTED_ENDPOINTS)

    def test_known_environments_resolve_to_the_cli_entries(self) -> None:
        for name, cli_entry in cli_endpoints.TRUSTED_ENDPOINTS.items():
            self.assertIs(trusted_endpoint.resolve_trusted_environment(name), cli_entry)

    def test_unset_environment_uses_the_cli_default(self) -> None:
        resolved = trusted_endpoint.resolve_trusted_environment(None)
        self.assertIs(resolved, cli_endpoints.resolve_endpoint(cli_endpoints.DEFAULT_ENVIRONMENT))

    def test_wrapper_module_contains_no_hardcoded_backend_url(self) -> None:
        import inspect

        source = inspect.getsource(trusted_endpoint)
        self.assertNotIn("http://", source)
        self.assertNotIn("https://", source)


class TrustedEndpointFailClosedTests(unittest.TestCase):
    def test_unknown_environment_is_rejected_with_actionable_chinese(self) -> None:
        with self.assertRaises(ApiConfigurationError) as caught:
            trusted_endpoint.resolve_trusted_environment("staging")
        message = str(caught.exception)
        self.assertIn("staging", message)
        self.assertIn("SHORTDRAMA_ENV", message)
        for name in cli_endpoints.TRUSTED_ENDPOINTS:
            self.assertIn(name, message)

    def test_url_shaped_inputs_are_rejected_with_actionable_chinese(self) -> None:
        for value in (
            "http://127.0.0.1:8000",
            "https://shortdrama.example",
            "127.0.0.1:8000",
            "http://101.126.6.208/",
        ):
            with self.subTest(value=value):
                with self.assertRaises(ApiConfigurationError) as caught:
                    trusted_endpoint.resolve_trusted_environment(value)
                message = str(caught.exception)
                self.assertIn("SHORTDRAMA_ENV", message)
                self.assertIn("URL", message)

    def test_rejection_does_not_depend_on_cli_login_hint_wording(self) -> None:
        # The wrapper must not fall through to the CLI's login-oriented message;
        # operators configure SHORTDRAMA_ENV, they do not re-login.
        with self.assertRaises(ApiConfigurationError) as caught:
            trusted_endpoint.resolve_trusted_environment("staging")
        self.assertNotIn("auth login", str(caught.exception))


class PlaintextWarningTests(unittest.TestCase):
    def test_warning_text_is_the_cli_message_and_is_emitted_once(self) -> None:
        trusted_endpoint._warned_environments.clear()
        plaintext = [
            entry for entry in cli_endpoints.TRUSTED_ENDPOINTS.values() if entry.plaintext_http
        ]
        self.assertTrue(plaintext, "expected the pinned CLI catalogue to contain a plaintext entry")
        entry = plaintext[0]
        buffer = io.StringIO()
        with redirect_stderr(buffer):
            trusted_endpoint.resolve_trusted_environment(entry.name)
            trusted_endpoint.resolve_trusted_environment(entry.name)
        expected = cli_translate(
            "endpoint.plaintext_warning", name=entry.name, api_base=entry.api_base
        )
        self.assertEqual(buffer.getvalue().splitlines(), [expected])

    def test_https_entries_emit_no_warning(self) -> None:
        trusted_endpoint._warned_environments.clear()
        https_entries = [
            entry for entry in cli_endpoints.TRUSTED_ENDPOINTS.values() if not entry.plaintext_http
        ]
        buffer = io.StringIO()
        with redirect_stderr(buffer):
            for entry in https_entries:
                trusted_endpoint.resolve_trusted_environment(entry.name)
        self.assertEqual(buffer.getvalue(), "")


class ConfigEnvironmentTests(unittest.TestCase):
    def settings_with(self, **overrides):
        with mock.patch.dict("os.environ", _base_environ(**overrides), clear=True):
            return Settings.from_environment()

    def test_environment_name_and_token_are_read(self) -> None:
        settings = self.settings_with(SHORTDRAMA_ENV="dev", SHORTDRAMA_AGENT_TOKEN="agent-token")
        self.assertEqual(settings.main_environment, "dev")
        self.assertEqual(settings.main_agent_token, "agent-token")

    def test_unset_environment_keeps_main_chain_disabled(self) -> None:
        settings = self.settings_with()
        self.assertIsNone(settings.main_environment)
        self.assertIsNone(settings.main_agent_token)

    def test_legacy_api_base_url_is_rejected_without_dual_track(self) -> None:
        with mock.patch.dict(
            "os.environ",
            _base_environ(SHORTDRAMA_API_BASE="http://127.0.0.1:8000", SHORTDRAMA_AGENT_TOKEN="agent-token"),
            clear=True,
        ):
            with self.assertRaises(ConfigurationError) as caught:
                Settings.from_environment()
        message = str(caught.exception)
        self.assertIn("SHORTDRAMA_API_BASE", message)
        self.assertIn("SHORTDRAMA_ENV", message)

    def test_unknown_environment_fails_at_startup(self) -> None:
        with mock.patch.dict(
            "os.environ",
            _base_environ(SHORTDRAMA_ENV="staging", SHORTDRAMA_AGENT_TOKEN="agent-token"),
            clear=True,
        ):
            with self.assertRaises(ConfigurationError) as caught:
                Settings.from_environment()
        self.assertIn("staging", str(caught.exception))

    def test_url_environment_fails_at_startup(self) -> None:
        with mock.patch.dict(
            "os.environ",
            _base_environ(SHORTDRAMA_ENV="http://10.0.0.1:8000", SHORTDRAMA_AGENT_TOKEN="agent-token"),
            clear=True,
        ):
            with self.assertRaises(ConfigurationError) as caught:
                Settings.from_environment()
        self.assertIn("URL", str(caught.exception))

    def test_environment_and_token_must_be_configured_together(self) -> None:
        with self.assertRaises(ConfigurationError):
            self.settings_with(SHORTDRAMA_ENV="dev")
        with self.assertRaises(ConfigurationError):
            self.settings_with(SHORTDRAMA_AGENT_TOKEN="agent-token")


class MainChainEnvironmentTests(unittest.TestCase):
    def test_adapter_builds_from_trusted_environment_only(self) -> None:
        entry = cli_endpoints.TRUSTED_ENDPOINTS["dev"]
        with mock.patch(
            "pi_http_wrapper.main_chain.BusinessServerClient", return_value=FakeClient()
        ) as client_cls:
            adapter = MainChainAdapter.for_environment("dev", "agent-token")
        self.assertIsInstance(adapter, MainChainAdapter)
        client_cls.assert_called_once_with(entry.api_base, token="agent-token")

    def test_adapter_rejects_url_input(self) -> None:
        with self.assertRaises(ApiConfigurationError):
            MainChainAdapter.for_environment("http://127.0.0.1:8000", "agent-token")

    def test_build_requires_environment_and_token_together(self) -> None:
        self.assertIsNone(build_main_chain_adapter(None, None))
        with self.assertRaises(ApiConfigurationError):
            build_main_chain_adapter("dev", None)
        with self.assertRaises(ApiConfigurationError):
            build_main_chain_adapter(None, "agent-token")

    def test_no_url_accepting_constructor_remains(self) -> None:
        self.assertFalse(hasattr(MainChainAdapter, "from_credentials"))


if __name__ == "__main__":
    unittest.main()
