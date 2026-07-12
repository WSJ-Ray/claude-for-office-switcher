import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from app import office_integration


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_DIR = REPOSITORY_ROOT / "app" / "assets" / "office"
XSI_TYPE = "{http://www.w3.org/2001/XMLSchema-instance}type"

EXPECTED_APPS = {
    "word": {
        "filename": "claude-word.xml",
        "manifest_id": office_integration.WORD_MANIFEST_ID,
        "host": "Document",
        "display_name": "Claude",
    },
    "powerpoint": {
        "filename": "claude-powerpoint.xml",
        "manifest_id": office_integration.POWERPOINT_MANIFEST_ID,
        "host": "Presentation",
        "display_name": "Claude",
    },
    "excel": {
        "filename": "claude-excel.xml",
        "manifest_id": getattr(office_integration, "EXCEL_MANIFEST_ID", None),
        "host": "Workbook",
        "display_name": "Claude Gateway",
    },
}

def _local_name(tag):
    return tag.rsplit("}", 1)[-1]


class OfficeManifestAssetTests(unittest.TestCase):
    def test_excel_identifiers_are_stable(self):
        self.assertEqual(
            getattr(office_integration, "EXCEL_STORE_ID", None),
            "wa200009404",
        )
        self.assertEqual(
            getattr(office_integration, "EXCEL_MANIFEST_ID", None),
            "8ac3747c-fc92-4350-aaad-92159ff6f64a",
        )

    def test_repository_manifest_templates_are_complete_and_unsigned(self):
        self.assertEqual(
            {spec.key for spec in office_integration._APP_SPECS},
            set(EXPECTED_APPS),
        )
        for expected in EXPECTED_APPS.values():
            filename = expected["filename"]
            with self.subTest(filename=filename):
                template_path = TEMPLATE_DIR / filename
                self.assertTrue(template_path.is_file(), str(template_path))

                root = ET.parse(template_path).getroot()
                child_values = {
                    _local_name(element.tag): (element.text or "").strip()
                    for element in root
                }
                self.assertEqual(child_values["Id"], expected["manifest_id"])
                display_name = next(
                    element
                    for element in root
                    if _local_name(element.tag) == "DisplayName"
                )
                self.assertEqual(
                    display_name.attrib.get("DefaultValue"),
                    expected["display_name"],
                )
                self.assertTrue(
                    any(
                        _local_name(element.tag) == "Host"
                        and (
                            element.attrib.get("Name") == expected["host"]
                            or element.attrib.get(XSI_TYPE) == expected["host"]
                        )
                        for element in root.iter()
                    )
                )
                self.assertTrue(
                    any(
                        _local_name(element.tag) == "SourceLocation"
                        and "DefaultValue" in element.attrib
                        for element in root.iter()
                    )
                )
                self.assertTrue(
                    any(
                        _local_name(element.tag) == "Url"
                        and element.attrib.get("id") == "Taskpane.Url"
                        for element in root.iter()
                    )
                )
                self.assertFalse(
                    any(_local_name(element.tag) == "Signature" for element in root.iter())
                )

    def test_repository_templates_render_only_gateway_entry_urls(self):
        bootstrap_url = (
            "http://127.0.0.1:4312/office/bootstrap/bootstrap-secret"
        )
        with tempfile.TemporaryDirectory() as data_dir:
            service = office_integration.OfficeIntegration(
                platform="win32",
                data_dir=data_dir,
                bundle_dir=REPOSITORY_ROOT,
                env={"PORT": "4312"},
            )

            for spec in office_integration._APP_SPECS:
                with self.subTest(app_name=spec.key):
                    root = ET.fromstring(service._render_manifest(spec, bootstrap_url))
                    source_locations = [
                        element
                        for element in root.iter()
                        if _local_name(element.tag) == "SourceLocation"
                    ]
                    taskpane_urls = [
                        element
                        for element in root.iter()
                        if _local_name(element.tag) == "Url"
                        and element.attrib.get("id") == "Taskpane.Url"
                    ]
                    entry_locations = [
                        element
                        for element in source_locations
                        if "DefaultValue" in element.attrib
                    ]
                    resource_references = [
                        element
                        for element in source_locations
                        if element.attrib.get("resid") == "Taskpane.Url"
                    ]

                    self.assertEqual(len(entry_locations), 1)
                    self.assertEqual(len(resource_references), 1)
                    self.assertNotIn("DefaultValue", resource_references[0].attrib)
                    self.assertEqual(len(taskpane_urls), 1)

                    for element in (*entry_locations, *taskpane_urls):
                        parsed = urlsplit(element.attrib["DefaultValue"])
                        query = parse_qs(parsed.query)
                        self.assertEqual(parsed.scheme, "https")
                        self.assertEqual(parsed.hostname, "pivot.claude.ai")
                        self.assertEqual(query["gateway"], ["1"])
                        self.assertEqual(query["auto_connect"], ["1"])
                        self.assertEqual(query["bootstrap_url"], [bootstrap_url])
                        if spec.key == "word":
                            self.assertEqual(query["m"], ["word-1.0.0.1"])
                        else:
                            self.assertNotIn("m", query)


if __name__ == "__main__":
    unittest.main()
