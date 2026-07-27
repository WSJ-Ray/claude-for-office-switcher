import json
import os
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from app.office_integration import (
    CLICK_TO_RUN_REGISTRY_PATH,
    CLICK_TO_RUN_WOW64_REGISTRY_PATH,
    DEVELOPER_REGISTRY_PATH,
    EXCEL_MANIFEST_ID,
    EXCEL_STORE_ID,
    POWERPOINT_MANIFEST_ID,
    POWERPOINT_STORE_ID,
    WORD_MANIFEST_ID,
    WORD_STORE_ID,
    OfficeIntegration,
    OfficeIntegrationError,
)


class FakeRegistry:
    def __init__(self):
        self.values = {}
        self.keys = set()
        self.queries = []
        self.writes = []
        self.deletes = []
        self.fail_set_name = None
        self.fail_set_after_name = None
        self.fail_delete_name = None
        self.fail_delete_after_name = None
        self.query_errors = {}
        self.failure_message = "simulated registry failure"
        self.mutation_observer = None
        self.query_hook = None
        self.after_set_hook = None
        self.after_delete_hook = None

    def query_value(self, hive, path, name):
        self.queries.append((hive, path, name))
        if self.query_hook:
            self.query_hook(self, hive, path, name)
        key = (hive, path, name)
        if key in self.query_errors:
            raise self.query_errors[key]
        if key not in self.values:
            raise FileNotFoundError(name)
        return self.values[key]

    def key_exists(self, hive, path):
        return (hive, path) in self.keys or any(
            key_hive == hive and key_path == path
            for key_hive, key_path, _ in self.values
        )

    def set_value(self, hive, path, name, value):
        if self.mutation_observer:
            self.mutation_observer("set", name)
        if name == self.fail_set_name:
            raise OSError(self.failure_message)
        self.writes.append((hive, path, name, value))
        self.values[(hive, path, name)] = value
        if self.after_set_hook:
            self.after_set_hook(self, hive, path, name, value)
        if name == self.fail_set_after_name:
            raise OSError(self.failure_message)

    def delete_value(self, hive, path, name):
        if self.mutation_observer:
            self.mutation_observer("delete", name)
        if name == self.fail_delete_name:
            raise PermissionError(self.failure_message)
        key = (hive, path, name)
        if key not in self.values:
            raise FileNotFoundError(name)
        self.deletes.append((hive, path, name))
        del self.values[key]
        if self.after_delete_hook:
            self.after_delete_hook(self, hive, path, name)
        if name == self.fail_delete_after_name:
            raise OSError(self.failure_message)


class FakeRunner:
    def __init__(self, stdout="", returncode=0):
        self.stdout = stdout
        self.returncode = returncode
        self.calls = []

    def __call__(self, command, **kwargs):
        self.calls.append((command, kwargs))
        return SimpleNamespace(stdout=self.stdout, stderr="", returncode=self.returncode)


class FakeWinregKey:
    def __init__(self, hive, path):
        self.hive = hive
        self.path = path

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False


class FakeWinregModule:
    HKEY_CURRENT_USER = object()
    HKEY_LOCAL_MACHINE = object()
    KEY_READ = 0x01
    KEY_WOW64_64KEY = 0x02
    KEY_SET_VALUE = 0x04
    REG_SZ = 1

    def __init__(self):
        self.open_calls = []
        self.create_calls = []
        self.query_calls = []
        self.set_calls = []
        self.delete_calls = []
        self.open_error = None
        self.create_error = None
        self.query_error = None
        self.set_error = None
        self.delete_error = None

    def OpenKey(self, hive, path, reserved, access):
        self.open_calls.append((hive, path, reserved, access))
        if self.open_error:
            raise self.open_error
        return FakeWinregKey(hive, path)

    def CreateKeyEx(self, hive, path, reserved, access):
        self.create_calls.append((hive, path, reserved, access))
        if self.create_error:
            raise self.create_error
        return FakeWinregKey(hive, path)

    def QueryValueEx(self, key, name):
        self.query_calls.append((key.hive, key.path, name))
        if self.query_error:
            raise self.query_error
        return "16.0.18129.20158", self.REG_SZ

    def SetValueEx(self, key, name, reserved, value_type, value):
        if self.set_error:
            raise self.set_error
        self.set_calls.append(
            (key.hive, key.path, name, reserved, value_type, value)
        )

    def DeleteValue(self, key, name):
        self.delete_calls.append((key.hive, key.path, name))
        if self.delete_error:
            raise self.delete_error


class FakeWinError(OSError):
    def __init__(self, winerror, message="simulated Windows error"):
        super().__init__(message)
        self.winerror = winerror


class RecordingLock:
    def __init__(self):
        self.events = []
        self.depth = 0

    def __enter__(self):
        self.events.append("enter")
        self.depth += 1
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.depth -= 1
        self.events.append("exit")
        return False


def _local_name(tag):
    return tag.rsplit("}", 1)[-1]


class OfficeIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.data_dir = self.root / "data"
        self.bundle_dir = self.root / "bundle"
        self.local_app_data = self.root / "local-app-data"
        self.registry = FakeRegistry()
        self.runner = FakeRunner()
        self.env = {
            "PORT": "4312",
            "GATEWAY_TOKEN": "gateway-token-must-not-leak",
        }
        self.install_path = self.root / "Microsoft Office" / "root" / "Office16"

    def tearDown(self):
        self.tempdir.cleanup()

    def write_templates(self):
        template_dir = self.bundle_dir / "app" / "assets" / "office"
        template_dir.mkdir(parents=True)
        (template_dir / "claude-word.xml").write_text(
            f"""<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0">
  <Id>{WORD_MANIFEST_ID}</Id>
  <DefaultSettings>
    <SourceLocation DefaultValue="https://old.example/taskpane?m=old-word&amp;keep=source" />
  </DefaultSettings>
  <Resources>
    <bt:Urls>
      <bt:Url id="Taskpane.Url" DefaultValue="https://old.example/commands?m=old-word&amp;keep=taskpane" />
    </bt:Urls>
  </Resources>
</OfficeApp>
""",
            encoding="utf-8",
        )
        (template_dir / "claude-powerpoint.xml").write_text(
            f"""<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0">
  <Id>{POWERPOINT_MANIFEST_ID}</Id>
  <DefaultSettings>
    <SourceLocation DefaultValue="https://old.example/slides?m=powerpoint-1.0.0.1" />
  </DefaultSettings>
  <Resources>
    <bt:Urls>
      <bt:Url id="Taskpane.Url" DefaultValue="https://old.example/slides/commands?m=powerpoint-1.0.0.1" />
    </bt:Urls>
  </Resources>
</OfficeApp>
""",
            encoding="utf-8",
        )
        (template_dir / "claude-excel.xml").write_text(
            f"""<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0">
  <Id>{EXCEL_MANIFEST_ID}</Id>
  <DefaultSettings>
    <SourceLocation DefaultValue="https://old.example/workbook?keep=source" />
  </DefaultSettings>
  <SourceLocation resid="Taskpane.Url" />
  <Resources>
    <bt:Urls>
      <bt:Url id="Taskpane.Url" DefaultValue="https://old.example/workbook/commands?keep=taskpane" />
    </bt:Urls>
  </Resources>
</OfficeApp>
""",
            encoding="utf-8",
        )

    def install_office(self, *, word=True, powerpoint=True, excel=True):
        self.install_path.mkdir(parents=True)
        if word:
            (self.install_path / "WINWORD.EXE").touch()
        if powerpoint:
            (self.install_path / "POWERPNT.EXE").touch()
        if excel:
            (self.install_path / "EXCEL.EXE").touch()
        for name, value in {
            "VersionToReport": "16.0.18129.20158",
            "Platform": "x64",
            "InstallationPath": str(self.install_path),
        }.items():
            self.registry.values[("HKLM", CLICK_TO_RUN_REGISTRY_PATH, name)] = value

    def make_service(self, **overrides):
        options = {
            "platform": "win32",
            "data_dir": self.data_dir,
            "bundle_dir": self.bundle_dir,
            "env": self.env,
            "registry": self.registry,
            "process_runner": self.runner,
            "local_app_data": self.local_app_data,
        }
        options.update(overrides)
        return OfficeIntegration(**options)

    def assert_safe_error(self, error, expected_code, *sensitive_values):
        self.assertIsInstance(error, OfficeIntegrationError)
        self.assertEqual(error.code, expected_code)
        serialized = json.dumps(error.to_dict())
        for sensitive in sensitive_values:
            self.assertNotIn(str(sensitive), serialized)

    def test_official_store_and_manifest_ids_are_exact_literals(self):
        self.assertEqual(WORD_STORE_ID, "wa200010453")
        self.assertEqual(WORD_MANIFEST_ID, "d51ccb01-85e7-42ab-885b-de05c07799f3")
        self.assertEqual(POWERPOINT_STORE_ID, "wa200010001")
        self.assertEqual(
            POWERPOINT_MANIFEST_ID, "f5f369e5-aa35-49d7-ad7b-638152ddb008"
        )
        self.assertEqual(EXCEL_STORE_ID, "wa200009404")
        self.assertEqual(EXCEL_MANIFEST_ID, "8ac3747c-fc92-4350-aaad-92159ff6f64a")

    def test_gateway_url_defaults_allows_loopback_and_requires_https_remotely(self):
        no_port_service = self.make_service(env={})
        self.assertEqual(no_port_service.gateway_url, "http://127.0.0.1:4000")

        default_service = self.make_service(env={"PORT": "4999"})
        self.assertEqual(default_service.gateway_url, "http://127.0.0.1:4999")

        valid_urls = {
            "http://LOCALHOST:4000/": "http://localhost:4000",
            "http://127.0.0.1:4000///": "http://127.0.0.1:4000",
            "http://127.0.0.2:4000/": "http://127.0.0.2:4000",
            "http://[0:0:0:0:0:0:0:1]:4000/": "http://[::1]:4000",
            "HTTPS://Gateway.Example.COM:8443/base///": (
                "https://gateway.example.com:8443/base"
            ),
        }
        for url, expected in valid_urls.items():
            with self.subTest(url=url):
                service = self.make_service(env={"OFFICE_GATEWAY_BASE_URL": url})
                self.assertEqual(service.gateway_url, expected)

        for url in (
            "http://gateway.example.com",
            "http://localhost.example.com",
            "ftp://gateway.example.com",
            "not-a-url",
            "https://gateway.example.com?",
            "https://gateway.example.com#",
            " https://gateway.example.com",
            "https://gateway.example.com ",
            "https://gate way.example.com",
            "https://gateway.example.com/\tpath",
            "https://gateway.example.com/\npath",
            "https:\\gateway.example.com",
            "https://gateway.example.com\\path",
            "https://user:password@gateway.example.com",
            "https://",
            "https://.",
            "https://bad..example.com",
            "https://-bad.example.com",
            "https://bad-.example.com",
            "https://bad_label.example.com",
            "https://gateway.example.com:0",
            "https://gateway.example.com:65536",
        ):
            with self.subTest(url=url):
                with self.assertRaises(OfficeIntegrationError) as context:
                    self.make_service(env={"OFFICE_GATEWAY_BASE_URL": url})
                self.assertEqual(context.exception.code, "invalid_gateway_url")

        for port in ("0", "65536", "not-a-port", "4000/evil", " 4000"):
            with self.subTest(port=port):
                with self.assertRaises(OfficeIntegrationError) as context:
                    self.make_service(env={"PORT": port})
                self.assertEqual(context.exception.code, "invalid_gateway_url")

    def test_status_detects_official_store_and_manifest_cache_without_managed_install(self):
        self.install_office()
        wef_dir = self.local_app_data / "Microsoft" / "Office" / "16.0" / "Wef"
        wef_dir.mkdir(parents=True)
        (wef_dir / "boot.json").write_text(
            json.dumps(
                {
                    "extensions": [
                        {"storeId": WORD_STORE_ID},
                        {"storeId": EXCEL_STORE_ID.upper()},
                    ]
                }
            ),
            encoding="utf-8",
        )
        (wef_dir / "cache" / POWERPOINT_MANIFEST_ID / "content").mkdir(parents=True)

        status = self.make_service().status()

        self.assertTrue(status["office"]["click_to_run"]["installed"])
        self.assertEqual(status["office"]["version"], "16.0.18129.20158")
        self.assertEqual(status["office"]["architecture"], "x64")
        self.assertTrue(status["apps"]["word"]["application_installed"])
        self.assertTrue(status["apps"]["powerpoint"]["application_installed"])
        self.assertTrue(status["apps"]["excel"]["application_installed"])
        self.assertTrue(status["apps"]["word"]["official_installed"])
        self.assertTrue(status["apps"]["powerpoint"]["official_installed"])
        self.assertTrue(status["apps"]["excel"]["official_installed"])
        self.assertFalse(status["apps"]["word"]["managed_installed"])
        self.assertFalse(status["apps"]["powerpoint"]["managed_installed"])
        self.assertFalse(status["apps"]["excel"]["managed_installed"])
        self.assertIs(status["excel"], status["apps"]["excel"])

    def test_click_to_run_prefers_populated_wow64_key_over_empty_native_key(self):
        self.registry.keys.add(("HKLM", CLICK_TO_RUN_REGISTRY_PATH))
        wow_install_path = self.root / "Office32" / "Office16"
        wow_install_path.mkdir(parents=True)
        (wow_install_path / "WINWORD.EXE").touch()
        for name, value in {
            "VersionToReport": "16.0.17000.10000",
            "Platform": "x86",
            "InstallationPath": str(wow_install_path),
        }.items():
            self.registry.values[("HKLM", CLICK_TO_RUN_WOW64_REGISTRY_PATH, name)] = value

        status = self.make_service().status()

        self.assertTrue(status["office"]["installed"])
        self.assertEqual(status["office"]["version"], "16.0.17000.10000")
        self.assertEqual(status["office"]["architecture"], "x86")
        self.assertTrue(status["apps"]["word"]["application_installed"])

    def test_first_setup_writes_manifests_registers_hkcu_and_reports_running_office(self):
        self.install_office()
        self.write_templates()
        self.runner.stdout = (
            '"EXCEL.EXE","1052","Console","1","22,000 K"\r\n'
            '"explorer.exe","2020","Console","1","90,000 K"\r\n'
        )

        result = self.make_service().setup("bootstrap-secret")

        word_path = self.data_dir / "office_addins" / "claude-word.xml"
        powerpoint_path = self.data_dir / "office_addins" / "claude-powerpoint.xml"
        excel_path = self.data_dir / "office_addins" / "claude-excel.xml"
        self.assertTrue(result["changed"])
        self.assertTrue(result["restart_required"])
        self.assertTrue(word_path.is_file())
        self.assertTrue(powerpoint_path.is_file())
        self.assertTrue(excel_path.is_file())
        self.assertEqual(
            self.registry.values[("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)],
            str(word_path),
        )
        self.assertEqual(
            self.registry.values[("HKCU", DEVELOPER_REGISTRY_PATH, POWERPOINT_MANIFEST_ID)],
            str(powerpoint_path),
        )
        self.assertEqual(
            self.registry.values[("HKCU", DEVELOPER_REGISTRY_PATH, EXCEL_MANIFEST_ID)],
            str(excel_path),
        )
        self.assertTrue(result["status"]["apps"]["word"]["managed_installed"])
        self.assertTrue(result["status"]["apps"]["powerpoint"]["managed_installed"])
        self.assertTrue(result["status"]["apps"]["excel"]["managed_installed"])
        self.assertTrue(result["status"]["apps"]["excel"]["running"])

    def test_setup_reports_no_restart_when_office_processes_are_not_running(self):
        self.install_office()
        self.write_templates()

        result = self.make_service().setup("bootstrap-secret")

        self.assertFalse(result["restart_required"])

    def test_constructor_accepts_process_alias_and_rejects_two_process_injections(self):
        self.install_office()
        alias_runner = FakeRunner(
            stdout='"WINWORD.EXE","1052","Console","1","22,000 K"\r\n'
        )
        options = {
            "platform": "win32",
            "data_dir": self.data_dir,
            "bundle_dir": self.bundle_dir,
            "env": self.env,
            "registry": self.registry,
            "local_app_data": self.local_app_data,
        }

        service = OfficeIntegration(process=alias_runner, **options)

        self.assertTrue(service.status()["apps"]["word"]["running"])
        self.assertTrue(alias_runner.calls)
        with self.assertRaises(ValueError):
            OfficeIntegration(
                process=alias_runner,
                process_runner=self.runner,
                **options,
            )

    def test_default_registry_adapter_is_lazy_and_uses_hklm_read_hkcu_write(self):
        fake_winreg = FakeWinregModule()
        with patch(
            "app.office_integration.importlib.import_module",
            return_value=fake_winreg,
        ) as import_module:
            service = OfficeIntegration(
                platform="win32",
                data_dir=self.data_dir,
                bundle_dir=self.bundle_dir,
                env=self.env,
                process_runner=self.runner,
                local_app_data=self.local_app_data,
            )
            import_module.assert_not_called()

            adapter = service._registry()
            version = adapter.query_value(
                "HKLM", CLICK_TO_RUN_REGISTRY_PATH, "VersionToReport"
            )
            adapter.set_value(
                "HKCU",
                DEVELOPER_REGISTRY_PATH,
                "d51ccb01-85e7-42ab-885b-de05c07799f3",
                r"C:\gateway\claude-word.xml",
            )

        import_module.assert_called_once_with("winreg")
        self.assertEqual(version, "16.0.18129.20158")
        self.assertEqual(
            fake_winreg.open_calls,
            [
                (
                    fake_winreg.HKEY_LOCAL_MACHINE,
                    CLICK_TO_RUN_REGISTRY_PATH,
                    0,
                    fake_winreg.KEY_READ | fake_winreg.KEY_WOW64_64KEY,
                )
            ],
        )
        self.assertEqual(
            fake_winreg.create_calls,
            [
                (
                    fake_winreg.HKEY_CURRENT_USER,
                    DEVELOPER_REGISTRY_PATH,
                    0,
                    fake_winreg.KEY_SET_VALUE,
                )
            ],
        )
        self.assertEqual(
            fake_winreg.set_calls,
            [
                (
                    fake_winreg.HKEY_CURRENT_USER,
                    DEVELOPER_REGISTRY_PATH,
                    "d51ccb01-85e7-42ab-885b-de05c07799f3",
                    0,
                    fake_winreg.REG_SZ,
                    r"C:\gateway\claude-word.xml",
                )
            ],
        )

    def test_default_registry_adapter_distinguishes_missing_from_access_errors(self):
        missing_winreg = FakeWinregModule()
        missing_winreg.open_error = FakeWinError(3)
        with patch(
            "app.office_integration.importlib.import_module",
            return_value=missing_winreg,
        ):
            missing_adapter = self.make_service(registry=None)._registry()
        self.assertFalse(
            missing_adapter.key_exists("HKLM", CLICK_TO_RUN_REGISTRY_PATH)
        )

        sensitive = r"SECRET_TOKEN C:\Users\alice\private-registry-path"
        read_winreg = FakeWinregModule()
        read_winreg.open_error = PermissionError(sensitive)
        with patch(
            "app.office_integration.importlib.import_module",
            return_value=read_winreg,
        ):
            read_adapter = self.make_service(registry=None)._registry()
        with self.assertRaises(OfficeIntegrationError) as context:
            read_adapter.query_value(
                "HKLM", CLICK_TO_RUN_REGISTRY_PATH, "VersionToReport"
            )
        self.assert_safe_error(context.exception, "registry_read_failed", sensitive)

        write_winreg = FakeWinregModule()
        write_winreg.set_error = PermissionError(sensitive)
        with patch(
            "app.office_integration.importlib.import_module",
            return_value=write_winreg,
        ):
            write_adapter = self.make_service(registry=None)._registry()
        with self.assertRaises(OfficeIntegrationError) as context:
            write_adapter.set_value(
                "HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID, "managed.xml"
            )
        self.assert_safe_error(context.exception, "registry_write_failed", sensitive)

        delete_winreg = FakeWinregModule()
        delete_winreg.delete_error = PermissionError(sensitive)
        with patch(
            "app.office_integration.importlib.import_module",
            return_value=delete_winreg,
        ):
            delete_adapter = self.make_service(registry=None)._registry()
        with self.assertRaises(OfficeIntegrationError) as context:
            delete_adapter.delete_value(
                "HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID
            )
        self.assert_safe_error(context.exception, "registry_delete_failed", sensitive)

    def test_service_registry_errors_are_stable_and_missing_ok_is_narrow(self):
        target = ("HKLM", CLICK_TO_RUN_REGISTRY_PATH, "VersionToReport")
        self.registry.query_errors[target] = FakeWinError(2)
        self.make_service().status()

        sensitive = r"SECRET_TOKEN C:\Users\alice\registry-value"
        self.registry.query_errors[target] = PermissionError(sensitive)
        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().status()
        self.assert_safe_error(context.exception, "registry_read_failed", sensitive)

        self.registry.fail_delete_name = WORD_MANIFEST_ID
        self.registry.failure_message = sensitive
        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service()._registry_delete(
                "HKCU",
                DEVELOPER_REGISTRY_PATH,
                WORD_MANIFEST_ID,
                missing_ok=True,
            )
        self.assert_safe_error(context.exception, "registry_delete_failed", sensitive)

    def test_generated_xml_has_encoded_bootstrap_url_and_never_contains_gateway_token(self):
        self.install_office()
        self.write_templates()

        self.make_service().setup("bootstrap-secret")

        for app_name in ("word", "powerpoint", "excel"):
            manifest_path = self.data_dir / "office_addins" / f"claude-{app_name}.xml"
            manifest_text = manifest_path.read_text(encoding="utf-8")
            self.assertNotIn(self.env["GATEWAY_TOKEN"], manifest_text)
            self.assertIn(
                "bootstrap_url=http%3A%2F%2F127.0.0.1%3A4312%2Foffice%2Fbootstrap%2Fbootstrap-secret",
                manifest_text,
            )

            root = ET.parse(manifest_path).getroot()
            self.assertEqual(
                root.tag.split("}", 1)[0].lstrip("{"),
                "http://schemas.microsoft.com/office/appforoffice/1.1",
            )
            url_elements = [
                element
                for element in root.iter()
                if (
                    _local_name(element.tag) == "SourceLocation"
                    and "DefaultValue" in element.attrib
                )
                or (
                    _local_name(element.tag) == "Url"
                    and element.attrib.get("id") == "Taskpane.Url"
                )
            ]
            self.assertEqual(len(url_elements), 2)
            for element in url_elements:
                parsed = urlsplit(element.attrib["DefaultValue"])
                query = parse_qs(parsed.query)
                self.assertEqual(parsed.scheme, "https")
                self.assertEqual(parsed.hostname, "pivot.claude.ai")
                self.assertEqual(query["gateway"], ["1"])
                self.assertEqual(query["auto_connect"], ["1"])
                self.assertEqual(
                    query["bootstrap_url"],
                    ["http://127.0.0.1:4312/office/bootstrap/bootstrap-secret"],
                )
                if app_name == "word":
                    self.assertEqual(query["m"], ["word-1.0.0.1"])
                elif app_name == "excel":
                    self.assertNotIn("m", query)
            if app_name == "excel":
                taskpane_references = [
                    element
                    for element in root.iter()
                    if _local_name(element.tag) == "SourceLocation"
                    and element.attrib.get("resid") == "Taskpane.Url"
                ]
                self.assertEqual(len(taskpane_references), 1)
                self.assertNotIn("DefaultValue", taskpane_references[0].attrib)

    def test_setup_is_idempotent_and_does_not_rewrite_or_reregister(self):
        self.install_office()
        self.write_templates()
        service = self.make_service()

        first = service.setup("bootstrap-secret")
        word_path = self.data_dir / "office_addins" / "claude-word.xml"
        original_bytes = word_path.read_bytes()
        original_write_count = len(self.registry.writes)
        second = service.setup("bootstrap-secret")

        self.assertTrue(first["changed"])
        self.assertFalse(second["changed"])
        self.assertEqual(word_path.read_bytes(), original_bytes)
        self.assertEqual(len(self.registry.writes), original_write_count)

    def test_setup_snapshot_read_error_is_a_safe_domain_error(self):
        self.install_office()
        self.write_templates()
        word_path = self.data_dir / "office_addins" / "claude-word.xml"
        sensitive = r"SECRET_TOKEN C:\Users\alice\snapshot-word.xml"
        original_read_bytes = Path.read_bytes

        def deny_managed_snapshot(path):
            if path == word_path:
                raise PermissionError(sensitive)
            return original_read_bytes(path)

        with patch.object(Path, "read_bytes", deny_managed_snapshot):
            with self.assertRaises(OfficeIntegrationError) as context:
                self.make_service().setup("bootstrap-secret")

        self.assert_safe_error(context.exception, "setup_failed", sensitive, word_path)
        self.assertEqual(self.registry.writes, [])
        self.assertFalse((self.data_dir / "office_addins").exists())

    def test_same_path_normalizes_windows_forms_and_detects_samefile_alias(self):
        expected = self.data_dir / "office_addins" / "claude-word.xml"
        expected.parent.mkdir(parents=True)
        expected.write_text("manifest", encoding="utf-8")
        extended_path = "\\\\?\\" + str(expected)
        case_and_separator_variant = str(expected).upper().replace("\\", "/")

        self.assertTrue(OfficeIntegration._same_path(extended_path, expected))
        self.assertTrue(
            OfficeIntegration._same_path(case_and_separator_variant, expected)
        )

        alias = self.root / "word-manifest-alias.xml"
        try:
            os.link(expected, alias)
        except OSError as exc:
            self.skipTest(f"Hard links are unavailable in this test environment: {exc}")
        self.assertTrue(OfficeIntegration._same_path(str(alias), expected))
        self.assertFalse(
            OfficeIntegration._same_path(str(self.root / "external.xml"), expected)
        )

    def test_setup_rejects_external_developer_override_before_writing(self):
        self.install_office()
        self.write_templates()
        external_path = self.root / "external" / "word.xml"
        external_path.parent.mkdir()
        external_path.touch()
        self.registry.values[("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)] = str(
            external_path
        )

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().setup("bootstrap-secret")

        self.assertEqual(context.exception.code, "developer_override_conflict")
        self.assertEqual(self.registry.writes, [])
        self.assertFalse((self.data_dir / "office_addins").exists())

    def test_setup_rolls_back_files_and_registry_when_second_registration_fails(self):
        self.install_office()
        self.write_templates()
        output_dir = self.data_dir / "office_addins"
        output_dir.mkdir(parents=True)
        word_path = output_dir / "claude-word.xml"
        powerpoint_path = output_dir / "claude-powerpoint.xml"
        word_path.write_bytes(b"previous word manifest")
        powerpoint_path.write_bytes(b"previous powerpoint manifest")
        self.registry.fail_set_name = POWERPOINT_MANIFEST_ID

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().setup("bootstrap-secret")

        self.assertEqual(context.exception.code, "registry_write_failed")
        self.assertEqual(word_path.read_bytes(), b"previous word manifest")
        self.assertEqual(powerpoint_path.read_bytes(), b"previous powerpoint manifest")
        self.assertNotIn(("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID), self.registry.values)
        self.assertNotIn(
            ("HKCU", DEVELOPER_REGISTRY_PATH, POWERPOINT_MANIFEST_ID),
            self.registry.values,
        )

    def test_setup_rolls_back_a_registry_write_that_mutates_then_raises(self):
        self.install_office()
        self.write_templates()
        sensitive = r"SECRET_TOKEN C:\Users\alice\provider-key.txt"
        self.registry.fail_set_after_name = POWERPOINT_MANIFEST_ID
        self.registry.failure_message = sensitive

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().setup("bootstrap-secret")

        self.assert_safe_error(context.exception, "registry_write_failed", sensitive)
        self.assertNotIn(
            ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID),
            self.registry.values,
        )
        self.assertNotIn(
            ("HKCU", DEVELOPER_REGISTRY_PATH, POWERPOINT_MANIFEST_ID),
            self.registry.values,
        )
        self.assertFalse((self.data_dir / "office_addins").exists())

    def test_setup_rolls_back_all_apps_when_excel_registration_fails(self):
        self.install_office()
        self.write_templates()
        output_dir = self.data_dir / "office_addins"
        output_dir.mkdir(parents=True)
        previous = {
            "word": b"previous word manifest",
            "powerpoint": b"previous powerpoint manifest",
            "excel": b"previous excel manifest",
        }
        paths = {
            key: output_dir / f"claude-{key}.xml"
            for key in previous
        }
        for key, path in paths.items():
            path.write_bytes(previous[key])
        self.registry.fail_set_name = EXCEL_MANIFEST_ID

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().setup("bootstrap-secret")

        self.assertEqual(context.exception.code, "registry_write_failed")
        for key, path in paths.items():
            self.assertEqual(path.read_bytes(), previous[key])
        for manifest_id in (
            WORD_MANIFEST_ID,
            POWERPOINT_MANIFEST_ID,
            EXCEL_MANIFEST_ID,
        ):
            self.assertNotIn(
                ("HKCU", DEVELOPER_REGISTRY_PATH, manifest_id),
                self.registry.values,
            )

    def test_setup_does_not_overwrite_external_value_added_after_manifest_write(self):
        self.install_office()
        self.write_templates()
        service = self.make_service()
        external_path = self.root / "external.xml"
        external_path.write_text("external", encoding="utf-8")
        original_atomic_write = service._atomic_write
        injected = False

        def write_then_inject_external(path, content):
            nonlocal injected
            original_atomic_write(path, content)
            if not injected:
                injected = True
                self.registry.values[
                    ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
                ] = str(external_path)

        service._atomic_write = write_then_inject_external

        with self.assertRaises(OfficeIntegrationError) as context:
            service.setup("bootstrap-secret")

        self.assertEqual(context.exception.code, "developer_override_conflict")
        self.assertEqual(
            self.registry.values[
                ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
            ],
            str(external_path),
        )
        self.assertFalse((self.data_dir / "office_addins").exists())

    def test_setup_rejects_external_takeover_during_final_status(self):
        self.install_office()
        self.write_templates()
        service = self.make_service()
        target = ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
        external_path = str(self.root / "external-final-status.xml")
        original_status = service.status
        status_calls = 0

        def inject_takeover_on_final_status():
            nonlocal status_calls
            status_calls += 1
            if status_calls == 2:
                self.registry.values[target] = external_path
            return original_status()

        service.status = inject_takeover_on_final_status

        with self.assertRaises(OfficeIntegrationError) as context:
            service.setup("bootstrap-secret")

        self.assertEqual(
            context.exception.code, "developer_override_conflict"
        )
        self.assertEqual(self.registry.values[target], external_path)
        self.assertFalse((self.data_dir / "office_addins").exists())

    def test_setup_rollback_preserves_registry_value_taken_over_externally(self):
        self.install_office()
        self.write_templates()
        external_path = self.root / "external-during-rollback.xml"
        external_path.write_text("external", encoding="utf-8")

        def take_over_word(registry, hive, path, name, value):
            if name == POWERPOINT_MANIFEST_ID:
                registry.values[
                    ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
                ] = str(external_path)

        self.registry.after_set_hook = take_over_word
        self.registry.fail_set_after_name = POWERPOINT_MANIFEST_ID

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().setup("bootstrap-secret")

        self.assertEqual(context.exception.code, "registry_write_failed")
        self.assertEqual(
            self.registry.values[
                ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
            ],
            str(external_path),
        )
        self.assertNotIn(
            ("HKCU", DEVELOPER_REGISTRY_PATH, POWERPOINT_MANIFEST_ID),
            self.registry.values,
        )

    def test_setup_reports_stable_error_when_rollback_itself_fails(self):
        self.install_office()
        self.write_templates()
        sensitive = r"SECRET_TOKEN C:\Users\alice\rollback-key.txt"
        self.registry.fail_set_after_name = POWERPOINT_MANIFEST_ID
        self.registry.fail_delete_name = WORD_MANIFEST_ID
        self.registry.failure_message = sensitive

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().setup("bootstrap-secret")

        self.assert_safe_error(
            context.exception, "setup_rollback_failed", sensitive, self.data_dir
        )

    def test_conflict_status_does_not_expose_external_registry_path(self):
        self.install_office()
        sensitive_path = self.root / "private" / "external-word.xml"
        self.registry.values[
            ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
        ] = str(sensitive_path)

        status = self.make_service().status()

        self.assertTrue(status["apps"]["word"]["conflict"])
        self.assertNotIn("registered_path", status["apps"]["word"])
        self.assertNotIn(str(sensitive_path), json.dumps(status))

    def test_repair_single_conflict_installs_all_apps_and_reports_running_office(self):
        self.install_office()
        self.write_templates()
        self.runner.stdout = (
            '"WINWORD.EXE","1052","Console","1","22,000 K"\r\n'
        )
        external_path = self.root / "external-word.xml"
        self.registry.values[
            ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
        ] = str(external_path)

        result = self.make_service().repair_conflicts("bootstrap-secret")

        self.assertTrue(result["changed"])
        self.assertTrue(result["restart_required"])
        self.assertEqual(result["repaired_apps"], ["word"])
        self.assertFalse(result["status"]["conflict"])
        self.assertTrue(result["status"]["managed_installed"])
        self.assertEqual(
            self.registry.values[
                ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
            ],
            str(self.data_dir / "office_addins" / "claude-word.xml"),
        )
        self.assertNotIn(str(external_path), json.dumps(result))

    def test_repair_multiple_conflicts_reports_apps_in_spec_order(self):
        self.install_office()
        self.write_templates()
        external_values = {
            EXCEL_MANIFEST_ID: str(self.root / "external-excel.xml"),
            WORD_MANIFEST_ID: str(self.root / "external-word.xml"),
        }
        for manifest_id, value in external_values.items():
            self.registry.values[
                ("HKCU", DEVELOPER_REGISTRY_PATH, manifest_id)
            ] = value

        result = self.make_service().repair_conflicts("bootstrap-secret")

        self.assertEqual(result["repaired_apps"], ["word", "excel"])
        self.assertEqual(
            [name for _, _, name in self.registry.deletes[:2]],
            [WORD_MANIFEST_ID, EXCEL_MANIFEST_ID],
        )
        for value in external_values.values():
            self.assertNotIn(value, self.registry.values.values())

    def test_repair_without_conflicts_is_an_idempotent_setup(self):
        self.install_office()
        self.write_templates()
        service = self.make_service()

        first = service.repair_conflicts("bootstrap-secret")
        delete_count = len(self.registry.deletes)
        write_count = len(self.registry.writes)
        second = service.repair_conflicts("bootstrap-secret")

        self.assertTrue(first["changed"])
        self.assertEqual(first["repaired_apps"], [])
        self.assertFalse(second["changed"])
        self.assertEqual(second["repaired_apps"], [])
        self.assertEqual(len(self.registry.deletes), delete_count)
        self.assertEqual(len(self.registry.writes), write_count)

    def test_repair_prevalidates_manifest_before_removing_conflict(self):
        self.install_office()
        self.write_templates()
        word_template = (
            self.bundle_dir / "app" / "assets" / "office" / "claude-word.xml"
        )
        word_template.unlink()
        external_path = str(self.root / "external-word.xml")
        target = ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
        self.registry.values[target] = external_path

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().repair_conflicts("bootstrap-secret")

        self.assertEqual(context.exception.code, "manifest_template_missing")
        self.assertEqual(self.registry.values[target], external_path)
        self.assertEqual(self.registry.deletes, [])

    def test_repair_aborts_without_deleting_value_changed_after_snapshot(self):
        self.install_office()
        self.write_templates()
        target = ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
        original_path = str(self.root / "external-original.xml")
        replacement_path = str(self.root / "external-replacement.xml")
        self.registry.values[target] = original_path
        query_count = 0

        def replace_before_predelete_check(registry, hive, path, name):
            nonlocal query_count
            if (hive, path, name) != target:
                return
            query_count += 1
            if query_count == 3:
                registry.values[target] = replacement_path

        self.registry.query_hook = replace_before_predelete_check

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().repair_conflicts("bootstrap-secret")

        self.assert_safe_error(
            context.exception,
            "repair_failed",
            original_path,
            replacement_path,
        )
        self.assertEqual(self.registry.values[target], replacement_path)
        self.assertEqual(self.registry.deletes, [])

    def test_repair_treats_conflict_cleared_after_snapshot_as_idempotent_setup(self):
        self.install_office()
        self.write_templates()
        target = ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
        self.registry.values[target] = str(self.root / "external-word.xml")
        query_count = 0

        def clear_before_predelete_check(registry, hive, path, name):
            nonlocal query_count
            if (hive, path, name) != target:
                return
            query_count += 1
            if query_count == 3:
                registry.values.pop(target, None)

        self.registry.query_hook = clear_before_predelete_check

        result = self.make_service().repair_conflicts("bootstrap-secret")

        self.assertTrue(result["changed"])
        self.assertEqual(result["repaired_apps"], [])
        self.assertEqual(self.registry.deletes, [])
        self.assertEqual(
            self.registry.values[target],
            str(self.data_dir / "office_addins" / "claude-word.xml"),
        )

    def test_repair_restores_all_deleted_values_when_a_later_delete_fails(self):
        self.install_office()
        self.write_templates()
        word_target = ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
        powerpoint_target = (
            "HKCU",
            DEVELOPER_REGISTRY_PATH,
            POWERPOINT_MANIFEST_ID,
        )
        word_external = str(self.root / "external-word.xml")
        powerpoint_external = str(self.root / "external-powerpoint.xml")
        self.registry.values[word_target] = word_external
        self.registry.values[powerpoint_target] = powerpoint_external
        self.registry.fail_delete_name = POWERPOINT_MANIFEST_ID

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().repair_conflicts("bootstrap-secret")

        self.assertEqual(context.exception.code, "repair_failed")
        self.assertEqual(self.registry.values[word_target], word_external)
        self.assertEqual(
            self.registry.values[powerpoint_target], powerpoint_external
        )
        self.assertFalse((self.data_dir / "office_addins").exists())

    def test_repair_restores_value_when_delete_mutates_then_raises(self):
        self.install_office()
        self.write_templates()
        target = ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
        external_path = str(self.root / "external-word.xml")
        self.registry.values[target] = external_path
        self.registry.fail_delete_after_name = WORD_MANIFEST_ID

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().repair_conflicts("bootstrap-secret")

        self.assertEqual(context.exception.code, "repair_failed")
        self.assertEqual(self.registry.values[target], external_path)

    def test_repair_restores_deleted_values_when_setup_fails(self):
        self.install_office()
        self.write_templates()
        targets = {
            WORD_MANIFEST_ID: str(self.root / "external-word.xml"),
            EXCEL_MANIFEST_ID: str(self.root / "external-excel.xml"),
        }
        for manifest_id, value in targets.items():
            self.registry.values[
                ("HKCU", DEVELOPER_REGISTRY_PATH, manifest_id)
            ] = value
        self.registry.fail_set_name = POWERPOINT_MANIFEST_ID

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().repair_conflicts("bootstrap-secret")

        self.assertEqual(context.exception.code, "repair_failed")
        for manifest_id, value in targets.items():
            self.assertEqual(
                self.registry.values[
                    ("HKCU", DEVELOPER_REGISTRY_PATH, manifest_id)
                ],
                value,
            )
        self.assertFalse((self.data_dir / "office_addins").exists())

    def test_repair_reports_stable_error_when_external_value_restore_fails(self):
        self.install_office()
        self.write_templates()
        sensitive = r"SECRET_TOKEN C:\Users\alice\external-word.xml"
        target = ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
        self.registry.values[target] = sensitive
        self.registry.fail_set_name = WORD_MANIFEST_ID
        self.registry.failure_message = sensitive

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().repair_conflicts("bootstrap-secret")

        self.assert_safe_error(
            context.exception,
            "repair_rollback_failed",
            sensitive,
            self.data_dir,
        )
        self.assertNotIn(target, self.registry.values)

    def test_repair_does_not_overwrite_value_added_during_delete_verification(self):
        self.install_office()
        self.write_templates()
        target = ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
        original_path = str(self.root / "external-original.xml")
        replacement_path = str(self.root / "external-replacement.xml")
        self.registry.values[target] = original_path

        def replace_after_delete(registry, hive, path, name):
            if (hive, path, name) == target:
                registry.values[target] = replacement_path

        self.registry.after_delete_hook = replace_after_delete

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().repair_conflicts("bootstrap-secret")

        self.assertEqual(context.exception.code, "repair_rollback_failed")
        self.assertEqual(self.registry.values[target], replacement_path)

    def test_repair_rejects_external_takeover_during_final_status(self):
        self.install_office()
        self.write_templates()
        service = self.make_service()
        target = ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
        original_path = str(self.root / "external-original.xml")
        replacement_path = str(self.root / "external-final-status.xml")
        self.registry.values[target] = original_path
        original_status = service.status
        status_calls = 0

        def inject_takeover_on_final_status():
            nonlocal status_calls
            status_calls += 1
            if status_calls == 3:
                self.registry.values[target] = replacement_path
            return original_status()

        service.status = inject_takeover_on_final_status

        with self.assertRaises(OfficeIntegrationError) as context:
            service.repair_conflicts("bootstrap-secret")

        self.assertEqual(context.exception.code, "repair_rollback_failed")
        self.assertEqual(self.registry.values[target], replacement_path)
        self.assertFalse((self.data_dir / "office_addins").exists())

    def test_repair_holds_the_shared_mutation_lock(self):
        self.install_office()
        self.write_templates()
        target = ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
        self.registry.values[target] = str(self.root / "external-word.xml")
        service = self.make_service()
        lock = RecordingLock()
        service._mutation_lock = lock
        observed_depths = []
        self.registry.mutation_observer = (
            lambda operation, name: observed_depths.append(lock.depth)
        )

        service.repair_conflicts("bootstrap-secret")

        self.assertEqual(lock.events, ["enter", "exit"])
        self.assertTrue(observed_depths)
        self.assertTrue(all(depth == 1 for depth in observed_depths))

    def test_setup_and_remove_hold_the_shared_mutation_lock(self):
        self.install_office()
        self.write_templates()
        service = self.make_service()
        other_service = self.make_service()
        self.assertIs(service._mutation_lock, other_service._mutation_lock)
        lock = RecordingLock()
        service._mutation_lock = lock
        observed_depths = []
        self.registry.mutation_observer = (
            lambda operation, name: observed_depths.append(lock.depth)
        )

        service.setup("bootstrap-secret")
        service.remove()

        self.assertEqual(lock.events, ["enter", "exit", "enter", "exit"])
        self.assertTrue(observed_depths)
        self.assertTrue(all(depth == 1 for depth in observed_depths))

    def test_remove_preserves_external_registry_and_unrelated_wef_data(self):
        self.install_office()
        self.write_templates()
        service = self.make_service()
        service.setup("bootstrap-secret")
        external_path = self.root / "external-excel.xml"
        external_path.touch()
        self.registry.values[("HKCU", DEVELOPER_REGISTRY_PATH, EXCEL_MANIFEST_ID)] = str(
            external_path
        )
        wef_sentinel = (
            self.local_app_data
            / "Microsoft"
            / "Office"
            / "16.0"
            / "Wef"
            / "cache"
            / "keep.txt"
        )
        indexed_db_sentinel = self.local_app_data / "IndexedDB" / "keep.txt"
        wef_sentinel.parent.mkdir(parents=True)
        indexed_db_sentinel.parent.mkdir(parents=True)
        wef_sentinel.write_text("keep", encoding="utf-8")
        indexed_db_sentinel.write_text("keep", encoding="utf-8")

        first = service.remove()
        second = service.remove()

        self.assertTrue(first["changed"])
        self.assertFalse(second["changed"])
        self.assertNotIn(("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID), self.registry.values)
        self.assertNotIn(
            ("HKCU", DEVELOPER_REGISTRY_PATH, POWERPOINT_MANIFEST_ID),
            self.registry.values,
        )
        self.assertEqual(
            self.registry.values[("HKCU", DEVELOPER_REGISTRY_PATH, EXCEL_MANIFEST_ID)],
            str(external_path),
        )
        self.assertFalse((self.data_dir / "office_addins" / "claude-word.xml").exists())
        self.assertFalse((self.data_dir / "office_addins" / "claude-powerpoint.xml").exists())
        self.assertTrue((self.data_dir / "office_addins" / "claude-excel.xml").exists())
        self.assertTrue(wef_sentinel.is_file())
        self.assertTrue(indexed_db_sentinel.is_file())

    def test_remove_rolls_back_when_excel_registry_delete_fails(self):
        self.install_office()
        self.write_templates()
        service = self.make_service()
        service.setup("bootstrap-secret")
        word_path = self.data_dir / "office_addins" / "claude-word.xml"
        powerpoint_path = self.data_dir / "office_addins" / "claude-powerpoint.xml"
        excel_path = self.data_dir / "office_addins" / "claude-excel.xml"
        word_before = word_path.read_bytes()
        powerpoint_before = powerpoint_path.read_bytes()
        excel_before = excel_path.read_bytes()
        sensitive = r"SECRET_TOKEN C:\Users\alice\delete-key.txt"
        self.registry.fail_delete_name = EXCEL_MANIFEST_ID
        self.registry.failure_message = sensitive

        with self.assertRaises(OfficeIntegrationError) as context:
            service.remove()

        self.assert_safe_error(context.exception, "registry_delete_failed", sensitive)
        self.assertEqual(
            self.registry.values[("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)],
            str(word_path),
        )
        self.assertEqual(
            self.registry.values[
                ("HKCU", DEVELOPER_REGISTRY_PATH, POWERPOINT_MANIFEST_ID)
            ],
            str(powerpoint_path),
        )
        self.assertEqual(
            self.registry.values[("HKCU", DEVELOPER_REGISTRY_PATH, EXCEL_MANIFEST_ID)],
            str(excel_path),
        )
        self.assertEqual(word_path.read_bytes(), word_before)
        self.assertEqual(powerpoint_path.read_bytes(), powerpoint_before)
        self.assertEqual(excel_path.read_bytes(), excel_before)

    def test_remove_read_failure_preserves_registry_and_files(self):
        self.install_office()
        self.write_templates()
        service = self.make_service()
        service.setup("bootstrap-secret")
        word_path = self.data_dir / "office_addins" / "claude-word.xml"
        powerpoint_path = self.data_dir / "office_addins" / "claude-powerpoint.xml"
        sensitive = r"SECRET_TOKEN C:\Users\alice\read-key.txt"
        target = ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
        self.registry.query_errors[target] = PermissionError(sensitive)

        with self.assertRaises(OfficeIntegrationError) as context:
            service.remove()

        self.assert_safe_error(context.exception, "registry_read_failed", sensitive)
        self.assertIn(target, self.registry.values)
        self.assertTrue(word_path.is_file())
        self.assertTrue(powerpoint_path.is_file())

    def test_remove_snapshot_read_error_is_a_safe_domain_error(self):
        self.install_office()
        self.write_templates()
        service = self.make_service()
        service.setup("bootstrap-secret")
        word_path = self.data_dir / "office_addins" / "claude-word.xml"
        powerpoint_path = self.data_dir / "office_addins" / "claude-powerpoint.xml"
        sensitive = r"SECRET_TOKEN C:\Users\alice\remove-snapshot.xml"
        original_read_bytes = Path.read_bytes

        def deny_managed_snapshot(path):
            if path == word_path:
                raise PermissionError(sensitive)
            return original_read_bytes(path)

        with patch.object(Path, "read_bytes", deny_managed_snapshot):
            with self.assertRaises(OfficeIntegrationError) as context:
                service.remove()

        self.assert_safe_error(context.exception, "remove_failed", sensitive, word_path)
        self.assertIn(
            ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID),
            self.registry.values,
        )
        self.assertTrue(word_path.is_file())
        self.assertTrue(powerpoint_path.is_file())

    def test_remove_rechecks_registry_immediately_before_delete(self):
        self.install_office()
        self.write_templates()
        service = self.make_service()
        service.setup("bootstrap-secret")
        word_path = self.data_dir / "office_addins" / "claude-word.xml"
        external_path = self.root / "external-before-delete.xml"
        external_path.write_text("external", encoding="utf-8")
        target = ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID)
        query_count = 0

        def inject_on_predelete_query(registry, hive, path, name):
            nonlocal query_count
            if (hive, path, name) != target:
                return
            query_count += 1
            if query_count == 3:
                registry.values[target] = str(external_path)

        self.registry.query_hook = inject_on_predelete_query

        service.remove()

        self.assertEqual(self.registry.values[target], str(external_path))
        self.assertTrue(word_path.is_file())

    def test_setup_rejects_non_windows_and_missing_office(self):
        self.write_templates()
        non_windows_registry = FakeRegistry()
        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service(platform="linux", registry=non_windows_registry).setup(
                "bootstrap-secret"
            )
        self.assertEqual(context.exception.code, "unsupported_platform")
        self.assertEqual(non_windows_registry.queries, [])

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().setup("bootstrap-secret")
        self.assertEqual(context.exception.code, "office_not_found")
        self.assertFalse((self.data_dir / "office_addins").exists())

    def test_status_parses_tasklist_csv_without_using_a_shell(self):
        self.install_office()
        self.runner.stdout = (
            '"WINWORD.EXE","1052","Console","1","22,000 K"\r\n'
            '"POWERPNT.EXE","2096","Console","1","31,000 K"\r\n'
            '"EXCEL.EXE","2097","Console","1","28,000 K"\r\n'
            'INFO: No tasks are running which match the specified criteria.\r\n'
        )

        status = self.make_service().detect()

        self.assertTrue(status["apps"]["word"]["running"])
        self.assertTrue(status["apps"]["powerpoint"]["running"])
        self.assertTrue(status["apps"]["excel"]["running"])
        self.assertTrue(status["office"]["running"])
        command, kwargs = self.runner.calls[-1]
        self.assertIsInstance(command, list)
        self.assertEqual(command, ["tasklist", "/FO", "CSV", "/NH"])
        self.assertIs(kwargs["shell"], False)
        self.assertTrue(kwargs["capture_output"])
        self.assertTrue(kwargs["text"])

    def test_status_ignores_tasklist_stdout_when_command_fails(self):
        self.install_office()
        self.runner.stdout = '"WINWORD.EXE","1052","Console","1","22,000 K"\r\n'
        self.runner.returncode = 1

        status = self.make_service().status()

        self.assertFalse(status["apps"]["word"]["running"])
        command, _ = self.runner.calls[-1]
        self.assertEqual(command, ["tasklist", "/FO", "CSV", "/NH"])

    def test_missing_manifest_template_is_a_domain_error_without_partial_writes(self):
        self.install_office()
        self.write_templates()
        (self.bundle_dir / "app" / "assets" / "office" / "claude-powerpoint.xml").unlink()

        with self.assertRaises(OfficeIntegrationError) as context:
            self.make_service().setup("bootstrap-secret")

        self.assertEqual(context.exception.code, "manifest_template_missing")
        self.assertNotIn(str(self.bundle_dir), json.dumps(context.exception.to_dict()))
        self.assertEqual(self.registry.writes, [])
        self.assertFalse((self.data_dir / "office_addins").exists())

    def test_setup_corrects_a_template_with_the_wrong_manifest_id(self):
        self.install_office()
        self.write_templates()
        word_template = (
            self.bundle_dir / "app" / "assets" / "office" / "claude-word.xml"
        )
        invalid_template = word_template.read_text(encoding="utf-8").replace(
            WORD_MANIFEST_ID, POWERPOINT_MANIFEST_ID
        )
        word_template.write_text(invalid_template, encoding="utf-8")

        result = self.make_service().setup("bootstrap-secret")

        generated_manifest = ET.parse(
            self.data_dir / "office_addins" / "claude-word.xml"
        ).getroot()
        generated_id = next(
            (element.text or "").strip()
            for element in generated_manifest
            if _local_name(element.tag) == "Id"
        )

        self.assertTrue(result["changed"])
        self.assertEqual(generated_id, "d51ccb01-85e7-42ab-885b-de05c07799f3")

    def test_replace_failure_keeps_previous_file_and_leaves_no_partial_install(self):
        self.install_office()
        self.write_templates()
        output_dir = self.data_dir / "office_addins"
        output_dir.mkdir(parents=True)
        word_path = output_dir / "claude-word.xml"
        word_path.write_bytes(b"previous word manifest")
        sensitive = r"SECRET_TOKEN C:\Users\alice\atomic-file.xml"

        with patch(
            "app.office_integration.os.replace",
            side_effect=OSError(sensitive),
        ):
            with self.assertRaises(OfficeIntegrationError) as context:
                self.make_service().setup("bootstrap-secret")

        self.assertEqual(context.exception.code, "setup_failed")
        self.assert_safe_error(
            context.exception, "setup_failed", sensitive, self.data_dir
        )
        self.assertEqual(word_path.read_bytes(), b"previous word manifest")
        self.assertEqual(self.registry.writes, [])
        self.assertFalse((output_dir / "claude-powerpoint.xml").exists())
        self.assertEqual(list(output_dir.glob("*.tmp")), [])

    def test_setup_rolls_back_file_writer_that_mutates_then_raises(self):
        self.install_office()
        self.write_templates()
        sensitive = r"SECRET_TOKEN C:\Users\alice\write-after-replace.xml"

        def write_then_raise(path, content):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            raise OSError(sensitive)

        with patch.object(
            OfficeIntegration,
            "_atomic_write",
            side_effect=write_then_raise,
        ):
            with self.assertRaises(OfficeIntegrationError) as context:
                self.make_service().setup("bootstrap-secret")

        self.assert_safe_error(context.exception, "setup_failed", sensitive)
        self.assertFalse((self.data_dir / "office_addins").exists())
        self.assertEqual(self.registry.writes, [])

    def test_setup_rollback_preserves_external_unattempted_manifest(self):
        self.install_office()
        self.write_templates()
        word_path = self.data_dir / "office_addins" / "claude-word.xml"
        powerpoint_path = self.data_dir / "office_addins" / "claude-powerpoint.xml"
        external_content = b"external powerpoint takeover"
        sensitive = r"SECRET_TOKEN C:\Users\alice\word-write.xml"

        def write_word_take_over_powerpoint_then_raise(path, content):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            if path == word_path:
                powerpoint_path.write_bytes(external_content)
                raise OSError(sensitive)

        with patch.object(
            OfficeIntegration,
            "_atomic_write",
            side_effect=write_word_take_over_powerpoint_then_raise,
        ):
            with self.assertRaises(OfficeIntegrationError) as context:
                self.make_service().setup("bootstrap-secret")

        self.assert_safe_error(context.exception, "setup_failed", sensitive)
        self.assertFalse(word_path.exists())
        self.assertEqual(powerpoint_path.read_bytes(), external_content)
        self.assertEqual(self.registry.writes, [])

    def test_remove_rollback_preserves_external_unattempted_manifest(self):
        self.install_office()
        self.write_templates()
        service = self.make_service()
        service.setup("bootstrap-secret")
        word_path = self.data_dir / "office_addins" / "claude-word.xml"
        powerpoint_path = self.data_dir / "office_addins" / "claude-powerpoint.xml"
        word_before = word_path.read_bytes()
        external_content = b"external powerpoint takeover"
        sensitive = r"SECRET_TOKEN C:\Users\alice\word-unlink.xml"
        original_unlink = Path.unlink

        def unlink_word_take_over_powerpoint_then_raise(path, *args, **kwargs):
            original_unlink(path, *args, **kwargs)
            if path == word_path:
                powerpoint_path.write_bytes(external_content)
                raise OSError(sensitive)

        with patch.object(
            Path,
            "unlink",
            unlink_word_take_over_powerpoint_then_raise,
        ):
            with self.assertRaises(OfficeIntegrationError) as context:
                service.remove()

        self.assert_safe_error(context.exception, "remove_failed", sensitive)
        self.assertEqual(word_path.read_bytes(), word_before)
        self.assertEqual(powerpoint_path.read_bytes(), external_content)
        self.assertIn(
            ("HKCU", DEVELOPER_REGISTRY_PATH, WORD_MANIFEST_ID),
            self.registry.values,
        )
        self.assertIn(
            ("HKCU", DEVELOPER_REGISTRY_PATH, POWERPOINT_MANIFEST_ID),
            self.registry.values,
        )


if __name__ == "__main__":
    unittest.main()
