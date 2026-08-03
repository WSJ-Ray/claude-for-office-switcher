import importlib
import os
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.office_integration import OfficeIntegrationError
from app.routes import admin, office, proxy


PIVOT_ORIGIN = "https://pivot.claude.ai"
AUTH_HEADERS = {"Authorization": "Bearer configured-token"}


class OfficeApiTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.original_db_path = db.DB_PATH
        db.DB_PATH = os.path.join(self.tempdir.name, "gateway.db")
        db.init_db()

        self.integration_factory = office.get_office_integration
        self.integration_factory.cache_clear()
        self.service = Mock()
        self.service.gateway_url = "http://127.0.0.1:4312"
        self.status_payload = {
            "platform": "win32",
            "supported": True,
            "office": {"installed": True, "running": False},
            "apps": {
                "excel": {
                    "application_installed": True,
                    "official_installed": False,
                    "managed_installed": True,
                    "running": False,
                    "conflict": False,
                }
            },
        }
        self.status_payload["excel"] = self.status_payload["apps"]["excel"]
        self.service.status.return_value = self.status_payload
        self.service.setup.return_value = {"changed": True, "restart_required": False}
        self.repair_payload = {
            "changed": True,
            "repaired_apps": ["word", "excel"],
            "restart_required": True,
            "status": self.status_payload,
        }
        self.service.repair_conflicts.return_value = self.repair_payload
        self.service.remove.return_value = {"changed": True, "restart_required": True}
        self.integration_patch = patch.object(
            office, "get_office_integration", return_value=self.service
        )
        self.integration_patch.start()

        self.app = FastAPI()
        self.app.include_router(proxy.router)
        self.app.include_router(office.router)
        self.app.include_router(admin.router)
        self.client = TestClient(self.app, client=("127.0.0.1", 51000))

    def tearDown(self):
        self.client.close()
        self.integration_patch.stop()
        self.integration_factory.cache_clear()
        db.DB_PATH = self.original_db_path
        self.tempdir.cleanup()

    @staticmethod
    def _local_access_detail():
        return {
            "code": "local_access_required",
            "message": "Office integration changes require a loopback connection.",
        }

    @staticmethod
    def _gateway_token_detail():
        return {
            "code": "gateway_token_missing",
            "message": "Configure a gateway token before setting up Office integration.",
        }

    def _set_gateway_token(self, value="configured-token"):
        db.set_setting(db.SETTING_GATEWAY_TOKEN, value)

    def _assert_bootstrap_cache_headers(self, response):
        self.assertEqual(
            response.headers.get("cache-control"), "no-store, max-age=0"
        )
        self.assertEqual(response.headers.get("pragma"), "no-cache")
        self.assertEqual(response.headers.get("vary"), "Origin")

    def test_status_returns_service_shape_with_local_and_gateway_state(self):
        response = self.client.get("/admin/office/status")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                **self.status_payload,
                "local_access": True,
                "gateway_ready": False,
            },
        )
        self.service.status.assert_called_once_with()

    def test_local_status_does_not_require_auth_when_gateway_token_exists(self):
        self._set_gateway_token()

        response = self.client.get("/admin/office/status")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["local_access"])
        self.assertTrue(response.json()["gateway_ready"])
        self.service.status.assert_called_once_with()

    def test_remote_status_requires_auth_when_gateway_token_exists(self):
        self._set_gateway_token()

        with TestClient(self.app, client=("192.0.2.10", 51001)) as remote_client:
            unauthenticated = remote_client.get("/admin/office/status")
            authenticated = remote_client.get(
                "/admin/office/status", headers=AUTH_HEADERS
            )

        self.assertEqual(unauthenticated.status_code, 401)
        self.assertEqual(unauthenticated.json(), {"detail": "Invalid token"})
        self.assertEqual(authenticated.status_code, 200)
        self.assertFalse(authenticated.json()["local_access"])

    def test_gateway_api_still_requires_token_from_loopback(self):
        self._set_gateway_token()

        unauthenticated = self.client.get("/v1/models")
        authenticated = self.client.get("/v1/models", headers=AUTH_HEADERS)

        self.assertEqual(unauthenticated.status_code, 401)
        self.assertEqual(unauthenticated.json(), {"detail": "Invalid token"})
        self.assertEqual(authenticated.status_code, 200)

    def test_status_marks_remote_clients_as_non_local(self):
        with TestClient(
            self.app, client=("192.0.2.10", 51001)
        ) as remote_client:
            response = remote_client.get("/admin/office/status")

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["local_access"])

    def test_remote_mutations_are_rejected_without_service_calls(self):
        self._set_gateway_token()
        with TestClient(
            self.app, client=("192.0.2.10", 51002)
        ) as remote_client:
            setup_response = remote_client.post(
                "/admin/office/setup", headers=AUTH_HEADERS
            )
            repair_response = remote_client.post(
                "/admin/office/conflicts/repair", headers=AUTH_HEADERS
            )
            remove_response = remote_client.delete(
                "/admin/office/setup", headers=AUTH_HEADERS
            )

        expected = {"detail": self._local_access_detail()}
        self.assertEqual(setup_response.status_code, 409)
        self.assertEqual(setup_response.json(), expected)
        self.assertEqual(repair_response.status_code, 409)
        self.assertEqual(repair_response.json(), expected)
        self.assertEqual(remove_response.status_code, 409)
        self.assertEqual(remove_response.json(), expected)
        self.service.setup.assert_not_called()
        self.service.repair_conflicts.assert_not_called()
        self.service.remove.assert_not_called()

    def test_setup_requires_gateway_token_before_creating_secret(self):
        response = self.client.post("/admin/office/setup")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": self._gateway_token_detail()})
        self.assertIsNone(
            db.get_setting(db.SETTING_OFFICE_BOOTSTRAP_SECRET)
        )
        self.service.setup.assert_not_called()

    def test_repair_requires_gateway_token_before_creating_secret(self):
        response = self.client.post("/admin/office/conflicts/repair")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": self._gateway_token_detail()})
        self.assertIsNone(
            db.get_setting(db.SETTING_OFFICE_BOOTSTRAP_SECRET)
        )
        self.service.repair_conflicts.assert_not_called()

    def test_local_repair_does_not_require_auth_when_gateway_token_exists(self):
        self._set_gateway_token()

        response = self.client.post("/admin/office/conflicts/repair")

        self.assertEqual(response.status_code, 200)
        secret = db.get_setting(db.SETTING_OFFICE_BOOTSTRAP_SECRET)
        self.assertTrue(secret)
        self.service.repair_conflicts.assert_called_once_with(secret)

    def test_bootstrap_secret_is_stable_under_concurrent_creation(self):
        with ThreadPoolExecutor(max_workers=8) as executor:
            values = list(
                executor.map(
                    lambda _: db.get_or_create_office_bootstrap_secret(),
                    range(24),
                )
            )

        self.assertEqual(len(set(values)), 1)
        self.assertGreaterEqual(len(values[0]), 32)
        self.assertEqual(
            db.get_or_create_office_bootstrap_secret(), values[0]
        )
        self.assertEqual(
            db.get_setting(db.SETTING_OFFICE_BOOTSTRAP_SECRET), values[0]
        )

    def test_bootstrap_secret_is_not_exposed_by_settings_api(self):
        secret = db.get_or_create_office_bootstrap_secret()

        response = self.client.get("/admin/settings")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(), {"gateway_token": "", "has_token": False}
        )
        self.assertNotIn(secret, response.text)
        self.assertNotIn("office_bootstrap_secret", response.text)

    def test_setup_creates_secret_and_returns_service_result(self):
        self._set_gateway_token()

        response = self.client.post(
            "/admin/office/setup", headers=AUTH_HEADERS
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(), {"changed": True, "restart_required": False}
        )
        secret = db.get_setting(db.SETTING_OFFICE_BOOTSTRAP_SECRET)
        self.assertTrue(secret)
        self.service.setup.assert_called_once_with(secret)

    def test_setup_accepts_a_selective_application_list(self):
        self._set_gateway_token()

        response = self.client.post(
            "/admin/office/setup",
            json={"apps": ["word", "excel"]},
            headers=AUTH_HEADERS,
        )

        self.assertEqual(response.status_code, 200)
        secret = db.get_setting(db.SETTING_OFFICE_BOOTSTRAP_SECRET)
        self.service.setup.assert_called_once_with(secret, ["word", "excel"])

    def test_setup_rejects_empty_or_unknown_application_lists(self):
        self._set_gateway_token()

        for apps in ([], ["outlook"], ["word", "word"]):
            with self.subTest(apps=apps):
                self.service.setup.reset_mock()
                response = self.client.post(
                    "/admin/office/setup",
                    json={"apps": apps},
                    headers=AUTH_HEADERS,
                )

                self.assertEqual(response.status_code, 422)
                self.service.setup.assert_not_called()

    def test_repair_creates_secret_and_returns_service_result(self):
        self._set_gateway_token()

        response = self.client.post(
            "/admin/office/conflicts/repair", headers=AUTH_HEADERS
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), self.repair_payload)
        secret = db.get_setting(db.SETTING_OFFICE_BOOTSTRAP_SECRET)
        self.assertTrue(secret)
        self.service.repair_conflicts.assert_called_once_with(secret)

    def test_repair_accepts_a_selective_application_list(self):
        self._set_gateway_token()

        response = self.client.post(
            "/admin/office/conflicts/repair",
            json={"apps": ["excel"]},
            headers=AUTH_HEADERS,
        )

        self.assertEqual(response.status_code, 200)
        secret = db.get_setting(db.SETTING_OFFICE_BOOTSTRAP_SECRET)
        self.service.repair_conflicts.assert_called_once_with(secret, ["excel"])

    def test_remove_returns_service_result_without_requiring_gateway_token(self):
        response = self.client.delete("/admin/office/setup")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(), {"changed": True, "restart_required": True}
        )
        self.service.remove.assert_called_once_with()

    def test_remove_accepts_a_selective_application_list(self):
        response = self.client.request(
            "DELETE",
            "/admin/office/setup",
            json={"apps": ["excel"]},
        )

        self.assertEqual(response.status_code, 200)
        self.service.remove.assert_called_once_with(["excel"])

    def test_remove_rejects_empty_or_duplicate_application_lists(self):
        for apps in ([], ["word", "word"], ["outlook"]):
            with self.subTest(apps=apps):
                self.service.remove.reset_mock()
                response = self.client.request(
                    "DELETE",
                    "/admin/office/setup",
                    json={"apps": apps},
                )

                self.assertEqual(response.status_code, 422)
                self.service.remove.assert_not_called()

    def test_domain_errors_map_to_stable_conflict_and_server_details(self):
        cases = (
            (
                "unsupported_platform",
                409,
                "Office integration is only supported on Windows.",
            ),
            (
                "manifest_template_invalid",
                409,
                "An Office manifest template is invalid.",
            ),
            (
                "registry_read_failed",
                500,
                "The Windows registry could not be read.",
            ),
        )
        for code, expected_status, expected_message in cases:
            with self.subTest(code=code):
                self.service.status.reset_mock()
                self.service.status.side_effect = OfficeIntegrationError(code)

                response = self.client.get("/admin/office/status")

                self.assertEqual(response.status_code, expected_status)
                self.assertEqual(
                    response.json(),
                    {
                        "detail": {
                            "code": code,
                            "message": expected_message,
                        }
                    },
                )
                self.service.status.side_effect = None

    def test_admin_errors_do_not_inherit_bootstrap_cache_headers(self):
        self.service.status.side_effect = OfficeIntegrationError(
            "unsupported_platform"
        )

        response = self.client.get("/admin/office/status")

        self.assertEqual(response.status_code, 409)
        self.assertNotIn("cache-control", response.headers)
        self.assertNotIn("pragma", response.headers)
        self.assertNotIn("vary", response.headers)

    def test_setup_and_remove_failures_map_to_server_errors(self):
        self._set_gateway_token()
        bootstrap_secret = "already-created-secret"
        db.set_setting(db.SETTING_OFFICE_BOOTSTRAP_SECRET, bootstrap_secret)
        self.service.setup.side_effect = OfficeIntegrationError("setup_failed")
        self.service.remove.side_effect = OfficeIntegrationError("remove_failed")

        setup_response = self.client.post(
            "/admin/office/setup", headers=AUTH_HEADERS
        )
        remove_response = self.client.delete(
            "/admin/office/setup", headers=AUTH_HEADERS
        )

        self.assertEqual(setup_response.status_code, 500)
        self.assertEqual(
            setup_response.json(),
            {
                "detail": {
                    "code": "setup_failed",
                    "message": "Office add-in setup failed.",
                }
            },
        )
        self.assertEqual(remove_response.status_code, 500)
        self.assertEqual(
            remove_response.json(),
            {
                "detail": {
                    "code": "remove_failed",
                    "message": "Office add-in removal failed.",
                }
            },
        )
        self.service.setup.assert_called_once_with(bootstrap_secret)
        self.service.remove.assert_called_once_with()

    def test_repair_domain_failures_map_to_stable_server_errors(self):
        self._set_gateway_token()
        cases = (
            (
                "repair_failed",
                "Office developer override repair failed.",
            ),
            (
                "repair_rollback_failed",
                (
                    "Office developer override repair failed and could not be "
                    "fully restored."
                ),
            ),
        )

        for code, expected_message in cases:
            with self.subTest(code=code):
                self.service.repair_conflicts.reset_mock()
                self.service.repair_conflicts.side_effect = OfficeIntegrationError(
                    code
                )

                response = self.client.post(
                    "/admin/office/conflicts/repair", headers=AUTH_HEADERS
                )

                self.assertEqual(response.status_code, 500)
                self.assertEqual(
                    response.json(),
                    {
                        "detail": {
                            "code": code,
                            "message": expected_message,
                        }
                    },
                )

        self.service.repair_conflicts.side_effect = None

    def test_repair_unexpected_errors_do_not_leak_exception_text(self):
        self._set_gateway_token()
        self.service.repair_conflicts.side_effect = RuntimeError(
            "registry-path=C:\\sensitive"
        )

        response = self.client.post(
            "/admin/office/conflicts/repair", headers=AUTH_HEADERS
        )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(
            response.json(),
            {
                "detail": {
                    "code": "office_integration_failed",
                    "message": "The Office integration operation failed.",
                }
            },
        )
        self.assertNotIn("sensitive", response.text)

    def test_unexpected_errors_do_not_leak_exception_text(self):
        self.service.status.side_effect = RuntimeError("credential=sk-sensitive")

        response = self.client.get("/admin/office/status")

        self.assertEqual(response.status_code, 500)
        self.assertEqual(
            response.json(),
            {
                "detail": {
                    "code": "office_integration_failed",
                    "message": "The Office integration operation failed.",
                }
            },
        )
        self.assertNotIn("sk-sensitive", response.text)

    def test_bootstrap_rejects_wrong_origin_before_reading_credentials(self):
        response = self.client.get(
            "/office/bootstrap/anything",
            headers={"Origin": "https://pivot.claude.ai.evil.example"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(
            response.json(),
            {
                "detail": {
                    "code": "invalid_origin",
                    "message": (
                        "Bootstrap requests must originate from "
                        "https://pivot.claude.ai."
                    ),
                }
            },
        )
        self.service.status.assert_not_called()
        self._assert_bootstrap_cache_headers(response)

    def test_bootstrap_hides_missing_and_incorrect_secrets_behind_same_404(self):
        expected = {
            "detail": {
                "code": "invalid_bootstrap_secret",
                "message": "The bootstrap secret is invalid.",
            }
        }

        missing_response = self.client.get(
            "/office/bootstrap/guessed-secret",
            headers={"Origin": PIVOT_ORIGIN},
        )
        db.set_setting(
            db.SETTING_OFFICE_BOOTSTRAP_SECRET, "actual-bootstrap-secret"
        )
        incorrect_response = self.client.get(
            "/office/bootstrap/guessed-secret",
            headers={"Origin": PIVOT_ORIGIN},
        )

        self.assertEqual(missing_response.status_code, 404)
        self.assertEqual(missing_response.json(), expected)
        self.assertEqual(incorrect_response.status_code, 404)
        self.assertEqual(incorrect_response.json(), expected)
        self.service.status.assert_not_called()
        self._assert_bootstrap_cache_headers(missing_response)
        self._assert_bootstrap_cache_headers(incorrect_response)

    def test_bootstrap_requires_gateway_token_after_secret_validation(self):
        db.set_setting(
            db.SETTING_OFFICE_BOOTSTRAP_SECRET, "actual-bootstrap-secret"
        )

        response = self.client.get(
            "/office/bootstrap/actual-bootstrap-secret",
            headers={"Origin": PIVOT_ORIGIN},
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"detail": self._gateway_token_detail()})
        self.service.status.assert_not_called()
        self._assert_bootstrap_cache_headers(response)

    def test_bootstrap_gateway_url_errors_disable_caching(self):
        secret = "actual-bootstrap-secret"
        db.set_setting(db.SETTING_OFFICE_BOOTSTRAP_SECRET, secret)
        self._set_gateway_token()
        cases = (
            (
                OfficeIntegrationError("invalid_gateway_url"),
                409,
                {
                    "code": "invalid_gateway_url",
                    "message": "The Office gateway URL is invalid.",
                },
            ),
            (
                RuntimeError("credential=sk-sensitive"),
                500,
                {
                    "code": "office_integration_failed",
                    "message": "The Office integration operation failed.",
                },
            ),
        )

        class FailingGatewayUrl:
            def __init__(self, error):
                self.error = error

            @property
            def gateway_url(self):
                raise self.error

        for error, expected_status, expected_detail in cases:
            with self.subTest(status=expected_status):
                office.get_office_integration.return_value = FailingGatewayUrl(
                    error
                )

                response = self.client.get(
                    f"/office/bootstrap/{secret}",
                    headers={"Origin": PIVOT_ORIGIN},
                )

                self.assertEqual(response.status_code, expected_status)
                self.assertEqual(response.json(), {"detail": expected_detail})
                self.assertNotIn("sk-sensitive", response.text)
                self._assert_bootstrap_cache_headers(response)

    def test_bootstrap_returns_current_token_and_no_cache_headers(self):
        secret = "actual-bootstrap-secret"
        db.set_setting(db.SETTING_OFFICE_BOOTSTRAP_SECRET, secret)
        self._set_gateway_token("first-token")

        first_response = self.client.get(
            f"/office/bootstrap/{secret}", headers={"Origin": PIVOT_ORIGIN}
        )
        self._set_gateway_token("rotated-token")
        second_response = self.client.get(
            f"/office/bootstrap/{secret}", headers={"Origin": PIVOT_ORIGIN}
        )

        self.assertEqual(first_response.status_code, 200)
        self.assertEqual(
            first_response.json(),
            {
                "gateway_url": "http://127.0.0.1:4312",
                "gateway_token": "first-token",
                "gateway_api_format": "anthropic",
                "auto_connect": "1",
            },
        )
        self.assertEqual(
            second_response.json()["gateway_token"], "rotated-token"
        )
        self.assertEqual(
            db.get_setting(db.SETTING_OFFICE_BOOTSTRAP_SECRET), secret
        )
        for response in (first_response, second_response):
            self._assert_bootstrap_cache_headers(response)

    def test_gateway_app_includes_office_routes(self):
        db.set_setting(
            db.SETTING_OFFICE_BOOTSTRAP_SECRET, "gateway-app-secret"
        )
        self._set_gateway_token("gateway-app-token")
        sys.modules.pop("gateway", None)
        try:
            gateway = importlib.import_module("gateway")
            route_paths = {route.path for route in gateway.app.routes}
            with TestClient(
                gateway.app, client=("127.0.0.1", 51003)
            ) as gateway_client:
                bootstrap_response = gateway_client.get(
                    "/office/bootstrap/gateway-app-secret",
                    headers={"Origin": PIVOT_ORIGIN},
                )
        finally:
            sys.modules.pop("gateway", None)

        self.assertIn("/admin/office/status", route_paths)
        self.assertIn("/admin/office/setup", route_paths)
        self.assertIn("/admin/office/conflicts/repair", route_paths)
        self.assertIn("/office/bootstrap/{secret}", route_paths)
        self.assertEqual(bootstrap_response.status_code, 200)
        self.assertEqual(bootstrap_response.headers["vary"], "Origin")
        self.assertEqual(
            bootstrap_response.headers["access-control-allow-origin"],
            PIVOT_ORIGIN,
        )


if __name__ == "__main__":
    unittest.main()
