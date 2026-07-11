import unittest
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
