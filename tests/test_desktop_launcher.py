import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import desktop_launcher


class ClosingEvent:
    def __init__(self):
        self.handler = None

    def __iadd__(self, handler):
        self.handler = handler
        return self


class DesktopGatewayAppTests(unittest.TestCase):
    def setUp(self):
        self.launcher = desktop_launcher.DesktopGatewayApp(
            host="127.0.0.1",
            port=4123,
            readiness_timeout=0,
        )
        self.window = Mock()
        self.window.events = SimpleNamespace(closing=ClosingEvent())
        self.tray = Mock()

    def test_window_close_hides_window_and_keeps_gateway_running(self):
        self.launcher.window = self.window

        should_close = self.launcher._hide_window()

        self.assertFalse(should_close)
        self.window.hide.assert_called_once_with()
        self.assertFalse(self.launcher.is_exiting)

    @patch.object(desktop_launcher, "TRAY_ICON_PATH", Path("assets/favicon.ico"))
    @patch.object(desktop_launcher.Image, "open")
    def test_tray_icon_uses_packaged_favicon(self, image_open):
        icon_file = Mock()
        icon_file.__enter__ = Mock(return_value=icon_file)
        icon_file.__exit__ = Mock(return_value=False)
        loaded_image = Mock()
        icon_file.convert.return_value = loaded_image
        image_open.return_value = icon_file

        image = self.launcher._create_tray_image()

        self.assertIs(loaded_image, image)
        image_open.assert_called_once_with(Path("assets/favicon.ico"))
        icon_file.convert.assert_called_once_with("RGBA")

    @patch.object(desktop_launcher, "TRAY_ICON_PATH", Path("assets/favicon.ico"))
    @patch.object(desktop_launcher.Image, "open", side_effect=OSError("unreadable icon"))
    @patch.object(desktop_launcher.DesktopGatewayApp, "_create_fallback_tray_image")
    def test_tray_icon_falls_back_when_packaged_favicon_cannot_load(self, fallback, _image_open):
        fallback_image = Mock()
        fallback.return_value = fallback_image

        image = self.launcher._create_tray_image()

        self.assertIs(fallback_image, image)
        fallback.assert_called_once_with()

    def test_generated_favicon_is_loadable_for_the_tray(self):
        with patch.object(self.launcher, "_create_fallback_tray_image") as fallback:
            image = self.launcher._create_tray_image()

        self.assertEqual((256, 256), image.size)
        fallback.assert_not_called()

    def test_show_window_restores_hidden_window_without_calling_unsupported_focus(self):
        self.launcher.window = self.window

        self.launcher._show_window()

        self.window.show.assert_called_once_with()
        self.window.restore.assert_called_once_with()
        self.assertFalse(self.window.focus.called)

    def test_exit_stops_tray_and_requests_uvicorn_shutdown(self):
        server = Mock()
        server.started = True
        self.launcher.server = server
        self.launcher.tray = self.tray

        self.launcher._exit_application()

        self.assertTrue(self.launcher.is_exiting)
        self.assertTrue(server.should_exit)
        self.tray.stop.assert_called_once_with()

    @patch.object(desktop_launcher, "webview")
    def test_run_opens_local_gateway_in_webview_after_readiness(self, webview):
        self.launcher._start_server = Mock()
        self.launcher._wait_until_ready = Mock(return_value=True)
        self.launcher._start_tray = Mock()
        window = Mock()
        window.events = SimpleNamespace(closing=ClosingEvent())
        webview.create_window.return_value = window

        exit_code = self.launcher.run()

        self.assertEqual(0, exit_code)
        webview.create_window.assert_called_once_with(
            "Office Gateway",
            "http://127.0.0.1:4123",
            width=1280,
            height=840,
            min_size=(960, 640),
        )
        webview.start.assert_called_once_with(gui="edgechromium")
        self.launcher._start_tray.assert_called_once_with()

    @patch.object(desktop_launcher, "webview")
    def test_run_reports_webview2_requirement_when_webview_cannot_start(self, webview):
        self.launcher._start_server = Mock()
        self.launcher._wait_until_ready = Mock(return_value=True)
        self.launcher._start_tray = Mock()
        window = Mock()
        window.events = SimpleNamespace(closing=ClosingEvent())
        webview.create_window.return_value = window
        webview.start.side_effect = RuntimeError("Edge Chromium unavailable")

        with patch.object(self.launcher, "_show_startup_error") as show_error:
            exit_code = self.launcher.run()

        self.assertEqual(1, exit_code)
        self.assertIn("WebView2", show_error.call_args.args[0])

    def test_run_reports_readiness_timeout_without_creating_window(self):
        self.launcher._start_server = Mock()
        self.launcher._wait_until_ready = Mock(return_value=False)

        with patch.object(self.launcher, "_show_startup_error") as show_error:
            exit_code = self.launcher.run()

        self.assertEqual(1, exit_code)
        self.assertIn("did not become ready", show_error.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
