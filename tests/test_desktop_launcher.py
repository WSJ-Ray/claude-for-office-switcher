import ctypes
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import desktop_launcher


class ClosingEvent:
    def __init__(self):
        self.handler = None
        self.handlers = []

    def __iadd__(self, handler):
        self.handler = handler
        self.handlers.append(handler)
        return self

    def fire(self, *args):
        for handler in tuple(self.handlers):
            handler(*args)


class DesktopGatewayAppTests(unittest.TestCase):
    def setUp(self):
        self.launcher = desktop_launcher.DesktopGatewayApp(
            host="127.0.0.1",
            port=4123,
            readiness_timeout=0,
            webview2_runtime_probe=lambda: True,
        )
        self.window = Mock()
        self.window.events = SimpleNamespace(
            closing=ClosingEvent(),
            shown=ClosingEvent(),
        )
        self.tray = Mock()

    @patch.object(desktop_launcher.webbrowser, "open", return_value=True)
    def test_desktop_bridge_opens_only_marketplace_https_urls(self, open_browser):
        url = "https://marketplace.microsoft.com/en-us/product/office/WA200010453"

        self.assertTrue(desktop_launcher.DesktopBridge.open_external_url(url))
        open_browser.assert_called_once_with(url, new=2)

    @patch.object(desktop_launcher.webbrowser, "open")
    def test_desktop_bridge_rejects_untrusted_external_urls(self, open_browser):
        for url in (
            "http://marketplace.microsoft.com/en-us/product/office/WA200010453",
            "https://evil.example/en-us/product/office/WA200010453",
            "https://marketplace.microsoft.com:8443/en-us/product/office/WA200010453",
            "https://user:password@marketplace.microsoft.com/en-us/product/office/WA200010453",
        ):
            with self.subTest(url=url):
                self.assertFalse(desktop_launcher.DesktopBridge.open_external_url(url))

        open_browser.assert_not_called()

    @staticmethod
    def _window_with_native_handle(handle=0x1234):
        shown = ClosingEvent()
        activated = ClosingEvent()
        native = SimpleNamespace(
            Handle=SimpleNamespace(ToInt64=Mock(return_value=handle)),
            Activated=activated,
        )
        window = SimpleNamespace(
            native=native,
            events=SimpleNamespace(shown=shown),
        )
        return window, shown, activated

    def test_title_bar_applies_light_dwm_attributes_after_window_is_shown(self):
        calls = []
        system_events = SimpleNamespace(UserPreferenceChanged=ClosingEvent())

        def set_attribute(hwnd, attribute, value_pointer, value_size):
            value = ctypes.cast(
                value_pointer,
                ctypes.POINTER(ctypes.c_uint32),
            ).contents.value
            calls.append((hwnd, attribute, value, value_size))
            return 0

        window, shown, _activated = self._window_with_native_handle()
        adapter = desktop_launcher.WindowsTitleBarAdapter(
            set_attribute,
            system_events=system_events,
        )

        adapter.attach(window)
        shown.fire()

        self.assertEqual(
            [
                (desktop_launcher.DWMWA_USE_IMMERSIVE_DARK_MODE, 0),
                (desktop_launcher.DWMWA_SYSTEMBACKDROP_TYPE, 1),
                (desktop_launcher.DWMWA_MICA_EFFECT, 0),
                (desktop_launcher.DWMWA_CAPTION_COLOR, 0x00FFFFFF),
                (desktop_launcher.DWMWA_TEXT_COLOR, 0x002A170F),
                (desktop_launcher.DWMWA_BORDER_COLOR, 0x00F0E8E2),
            ],
            [(attribute, value) for _, attribute, value, _ in calls],
        )
        self.assertTrue(all(hwnd == 0x1234 for hwnd, *_ in calls))
        self.assertTrue(all(size == 4 for *_, size in calls))

    def test_primary_work_area_converts_physical_pixels_using_system_dpi(self):
        user32 = SimpleNamespace(
            SystemParametersInfoW=Mock(return_value=True),
            GetDpiForSystem=Mock(return_value=144),
        )

        def set_work_area(_action, _param, rect_pointer, _flags):
            rect = rect_pointer._obj
            rect.left = 0
            rect.top = 0
            rect.right = 2560
            rect.bottom = 1368
            return True

        user32.SystemParametersInfoW.side_effect = set_work_area

        work_area = desktop_launcher._primary_work_area_logical(user32)

        self.assertEqual((0, 0, 1707, 912), work_area)

    def test_window_geometry_centers_in_primary_work_area(self):
        geometry = desktop_launcher.resolve_initial_window_geometry(
            (0, 0, 1707, 912)
        )

        self.assertEqual((1296, 880, 205, 16), geometry)

    def test_window_geometry_fits_smaller_work_area(self):
        geometry = desktop_launcher.resolve_initial_window_geometry(
            (0, 0, 1100, 720)
        )

        self.assertEqual((1100, 720, 0, 0), geometry)

    def test_window_geometry_falls_back_when_screens_are_unavailable(self):
        with patch.object(
            desktop_launcher,
            "_primary_work_area_logical",
            return_value=None,
        ):
            geometry = desktop_launcher.resolve_initial_window_geometry()

        self.assertEqual(
            (desktop_launcher.WINDOW_WIDTH, desktop_launcher.WINDOW_HEIGHT, None, None),
            geometry,
        )

    def test_title_bar_reapplies_on_activation_without_duplicate_bindings(self):
        set_attribute = Mock(return_value=0)
        window, shown, activated = self._window_with_native_handle()
        system_events = SimpleNamespace(UserPreferenceChanged=ClosingEvent())
        adapter = desktop_launcher.WindowsTitleBarAdapter(
            set_attribute,
            system_events=system_events,
        )

        adapter.attach(window)
        adapter.attach(window)
        shown.fire()
        shown.fire()
        activated.fire()
        system_events.UserPreferenceChanged.fire()

        self.assertEqual(1, len(shown.handlers))
        self.assertEqual(1, len(activated.handlers))
        self.assertEqual(1, len(system_events.UserPreferenceChanged.handlers))
        self.assertEqual(24, set_attribute.call_count)

    def test_title_bar_missing_native_handle_falls_back_without_dwm_calls(self):
        set_attribute = Mock(return_value=0)
        adapter = desktop_launcher.WindowsTitleBarAdapter(set_attribute)
        adapter.attach(SimpleNamespace(native=None, events=SimpleNamespace(shown=ClosingEvent())))

        self.assertFalse(adapter.apply())
        set_attribute.assert_not_called()

    def test_title_bar_api_errors_and_nonzero_hresults_do_not_escape(self):
        window, _shown, _activated = self._window_with_native_handle()
        nonzero_adapter = desktop_launcher.WindowsTitleBarAdapter(Mock(return_value=-1))
        nonzero_adapter.attach(window)
        throwing_adapter = desktop_launcher.WindowsTitleBarAdapter(
            Mock(side_effect=RuntimeError("unsupported DWM attribute"))
        )
        throwing_adapter.attach(window)

        self.assertFalse(nonzero_adapter.apply())
        self.assertFalse(throwing_adapter.apply())

    @patch.object(desktop_launcher.ctypes, "WinDLL")
    def test_dpi_awareness_uses_per_monitor_v2_context(self, win_dll):
        set_awareness = Mock(return_value=True)
        win_dll.return_value = SimpleNamespace(
            SetProcessDpiAwarenessContext=set_awareness
        )

        enabled = desktop_launcher.enable_per_monitor_v2_dpi_awareness()

        self.assertTrue(enabled)
        context = set_awareness.call_args.args[0]
        self.assertEqual(ctypes.c_void_p(-4).value, context.value)

    @patch.object(desktop_launcher.ctypes, "get_last_error", return_value=5)
    @patch.object(desktop_launcher.ctypes, "WinDLL")
    def test_dpi_awareness_ignores_access_denied_when_manifest_was_first(
        self,
        win_dll,
        _get_last_error,
    ):
        set_awareness = Mock(return_value=False)
        win_dll.return_value = SimpleNamespace(
            SetProcessDpiAwarenessContext=set_awareness
        )

        enabled = desktop_launcher.enable_per_monitor_v2_dpi_awareness()

        self.assertFalse(enabled)
        set_awareness.assert_called_once()

    @patch.object(
        desktop_launcher.ctypes,
        "WinDLL",
        side_effect=OSError("SetProcessDpiAwarenessContext is unavailable"),
    )
    def test_dpi_awareness_falls_back_on_older_windows(self, _win_dll):
        self.assertFalse(desktop_launcher.enable_per_monitor_v2_dpi_awareness())

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

    @patch.object(
        desktop_launcher,
        "resolve_initial_window_geometry",
        return_value=(1296, 880, 205, 16),
    )
    @patch.object(desktop_launcher, "webview")
    def test_run_opens_local_gateway_in_webview_after_readiness(
        self,
        webview,
        _resolve_geometry,
    ):
        self.launcher._start_server = Mock()
        self.launcher._wait_until_ready = Mock(return_value=True)
        self.launcher._start_tray = Mock()
        window = Mock()
        window.events = SimpleNamespace(
            closing=ClosingEvent(),
            shown=ClosingEvent(),
        )
        window.native = None
        webview.create_window.return_value = window

        exit_code = self.launcher.run()

        self.assertEqual(0, exit_code)
        webview.create_window.assert_called_once()
        create_args, create_kwargs = webview.create_window.call_args
        self.assertEqual(
            create_args,
            ("Office Gateway", "http://127.0.0.1:4123/?desktop=1"),
        )
        self.assertIsInstance(create_kwargs.pop("js_api"), desktop_launcher.DesktopBridge)
        self.assertEqual(
            create_kwargs,
            {
                "width": desktop_launcher.WINDOW_WIDTH,
                "height": desktop_launcher.WINDOW_HEIGHT,
                "x": 205,
                "y": 16,
                "resizable": True,
                "min_size": desktop_launcher.WINDOW_MIN_SIZE,
                "frameless": False,
                "easy_drag": False,
                "shadow": True,
                "background_color": "#FFFFFF",
            },
        )
        webview.start.assert_called_once_with(
            gui="edgechromium",
            icon=str(desktop_launcher.TRAY_ICON_PATH),
        )
        self.assertEqual(1, len(window.events.shown.handlers))
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

    def test_run_rejects_missing_webview2_before_starting_server(self):
        self.launcher.webview2_runtime_probe = Mock(return_value=False)
        self.launcher._start_server = Mock()

        with patch.object(self.launcher, "_show_startup_error") as show_error:
            exit_code = self.launcher.run()

        self.assertEqual(1, exit_code)
        self.launcher._start_server.assert_not_called()
        self.assertIn("WebView2", show_error.call_args.args[0])

    @patch.object(desktop_launcher, "webview")
    def test_run_preserves_startup_error_when_unshown_window_cleanup_fails(
        self,
        webview,
    ):
        self.launcher._start_server = Mock()
        self.launcher._wait_until_ready = Mock(return_value=True)
        self.launcher._start_tray = Mock()
        self.launcher._stop_server = Mock()
        window = Mock()
        window.events = SimpleNamespace(
            closing=ClosingEvent(),
            shown=ClosingEvent(),
        )
        window.destroy.side_effect = RuntimeError("Main window failed to start")
        webview.create_window.return_value = window
        webview.start.side_effect = RuntimeError("Edge Chromium unavailable")

        with patch.object(self.launcher, "_show_startup_error") as show_error:
            exit_code = self.launcher.run()

        self.assertEqual(1, exit_code)
        self.assertIn("Edge Chromium unavailable", show_error.call_args.args[0])
        window.destroy.assert_called_once_with()
        self.launcher._stop_server.assert_called_once_with()

    def test_run_reports_readiness_timeout_without_creating_window(self):
        self.launcher._start_server = Mock()
        self.launcher._wait_until_ready = Mock(return_value=False)

        with patch.object(self.launcher, "_show_startup_error") as show_error:
            exit_code = self.launcher.run()

        self.assertEqual(1, exit_code)
        self.assertIn("did not become ready", show_error.call_args.args[0])

    @patch.object(desktop_launcher, "DesktopGatewayApp")
    @patch.object(desktop_launcher, "enable_per_monitor_v2_dpi_awareness")
    def test_main_initializes_dpi_before_running_desktop_app(
        self,
        enable_dpi,
        desktop_app,
    ):
        desktop_app.return_value.run.return_value = 7

        exit_code = desktop_launcher.main()

        self.assertEqual(7, exit_code)
        enable_dpi.assert_called_once_with()
        desktop_app.assert_called_once_with()
        desktop_app.return_value.run.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
