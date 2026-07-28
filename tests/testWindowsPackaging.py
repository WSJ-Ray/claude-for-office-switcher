import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = REPOSITORY_ROOT / "assets" / "OfficeGateway.manifest"

ASM_V1 = "urn:schemas-microsoft-com:asm.v1"
ASM_V3 = "urn:schemas-microsoft-com:asm.v3"
COMPATIBILITY_V1 = "urn:schemas-microsoft-com:compatibility.v1"
WINDOWS_SETTINGS_2005 = "http://schemas.microsoft.com/SMI/2005/WindowsSettings"
WINDOWS_SETTINGS_2016 = "http://schemas.microsoft.com/SMI/2016/WindowsSettings"
EXPECTED_SUPPORTED_OS_IDS = {
    "{e2011457-1546-43c5-a5fe-008deee3d3f0}",
    "{35138b9a-5d96-4fbd-8e2d-a2440225f93a}",
    "{4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38}",
    "{1f676c76-80e1-4239-95bb-83d0f6d0da78}",
    "{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}",
}


class WindowsPackagingTests(unittest.TestCase):
    def test_manifest_preserves_execution_and_compatibility_metadata(self):
        root = ET.parse(MANIFEST_PATH).getroot()

        self.assertEqual(root.tag, f"{{{ASM_V1}}}assembly")
        self.assertEqual(root.attrib.get("manifestVersion"), "1.0")

        execution_level = root.find(
            f"{{{ASM_V3}}}trustInfo/{{{ASM_V3}}}security/"
            f"{{{ASM_V3}}}requestedPrivileges/"
            f"{{{ASM_V3}}}requestedExecutionLevel"
        )
        self.assertIsNotNone(execution_level)
        self.assertEqual(execution_level.attrib.get("level"), "asInvoker")
        self.assertEqual(execution_level.attrib.get("uiAccess"), "false")

        supported_os_ids = {
            element.attrib["Id"]
            for element in root.findall(
                f"{{{COMPATIBILITY_V1}}}compatibility/"
                f"{{{COMPATIBILITY_V1}}}application/"
                f"{{{COMPATIBILITY_V1}}}supportedOS"
            )
        }
        self.assertEqual(supported_os_ids, EXPECTED_SUPPORTED_OS_IDS)

    def test_manifest_declares_per_monitor_v2_with_legacy_fallback(self):
        root = ET.parse(MANIFEST_PATH).getroot()

        dpi_aware = root.find(f".//{{{WINDOWS_SETTINGS_2005}}}dpiAware")
        dpi_awareness = root.find(f".//{{{WINDOWS_SETTINGS_2016}}}dpiAwareness")

        self.assertIsNotNone(dpi_aware)
        self.assertEqual(dpi_aware.text, "true/pm")
        self.assertIsNotNone(dpi_awareness)
        self.assertEqual(dpi_awareness.text, "PerMonitorV2,PerMonitor")

    def test_cli_and_spec_reference_the_repository_manifest(self):
        build_script = (REPOSITORY_ROOT / "build_exe.ps1").read_text(
            encoding="utf-8"
        )
        spec = (REPOSITORY_ROOT / "OfficeGateway.spec").read_text(encoding="utf-8")

        self.assertIn(
            '"$PSScriptRoot\\OfficeGateway.spec"',
            build_script,
        )
        self.assertNotIn('"$PSScriptRoot\\desktop_launcher.py"', build_script)
        self.assertIn(
            "Path(SPECPATH) / 'assets' / 'OfficeGateway.manifest'",
            spec,
        )
        self.assertIn("manifest=manifest_path", spec)
        self.assertNotIn("C:\\\\Users\\\\", spec)


if __name__ == "__main__":
    unittest.main()
