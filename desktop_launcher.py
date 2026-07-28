"""Windows desktop entry point for the packaged Office Gateway."""
import ctypes
import os
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Protocol

import httpx
from PIL import Image, ImageDraw
import pystray
import uvicorn
import webview

from gateway import app


WINDOW_TITLE = "Office Gateway"
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
TRAY_ICON_PATH = RESOURCE_DIR / "assets" / "favicon.ico"

ERROR_ACCESS_DENIED = 5
DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4

DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_BORDER_COLOR = 34
DWMWA_CAPTION_COLOR = 35
DWMWA_TEXT_COLOR = 36
DWMWA_SYSTEMBACKDROP_TYPE = 38
DWMWA_MICA_EFFECT = 1029

DWMSBT_NONE = 1

# pywebview sizes the outer WinForms window, so reserve room for the native
# caption and resize border while keeping the intended WebView viewport.
WINDOW_WIDTH = 1296
WINDOW_HEIGHT = 880
WINDOW_MIN_SIZE = (976, 680)


class _Rect(ctypes.Structure):
    _fields_ = (
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    )


def _primary_work_area_logical(user32=None) -> tuple[int, int, int, int] | None:
    """Return the primary work area in 96-DPI logical pixels."""
    try:
        if user32 is None:
            win_dll = getattr(ctypes, "WinDLL", None)
            if win_dll is None:
                return None
            user32 = win_dll("user32")

        get_work_area = user32.SystemParametersInfoW
        get_work_area.argtypes = [
            ctypes.c_uint,
            ctypes.c_uint,
            ctypes.c_void_p,
            ctypes.c_uint,
        ]
        get_work_area.restype = ctypes.c_bool
        work_area = _Rect()
        if not get_work_area(0x0030, 0, ctypes.byref(work_area), 0):
            return None

        try:
            get_dpi = user32.GetDpiForSystem
            get_dpi.argtypes = []
            get_dpi.restype = ctypes.c_uint
            dpi = max(96, int(get_dpi()))
        except Exception:
            dpi = 96

        scale = dpi / 96
        left = round(work_area.left / scale)
        top = round(work_area.top / scale)
        right = round(work_area.right / scale)
        bottom = round(work_area.bottom / scale)
        return left, top, right - left, bottom - top
    except Exception:
        return None


def resolve_initial_window_geometry(
    work_area: tuple[int, int, int, int] | None = None,
) -> tuple[int, int, int | None, int | None]:
    """Fit and center the outer window within the primary screen work area."""
    work_area = work_area or _primary_work_area_logical()
    if work_area is None:
        return WINDOW_WIDTH, WINDOW_HEIGHT, None, None

    work_x, work_y, work_width, work_height = work_area
    width = max(WINDOW_MIN_SIZE[0], min(WINDOW_WIDTH, work_width))
    height = max(WINDOW_MIN_SIZE[1], min(WINDOW_HEIGHT, work_height))
    x = work_x + max(0, (work_width - width) // 2)
    y = work_y + max(0, (work_height - height) // 2)
    return width, height, x, y


def is_webview2_runtime_available() -> bool:
    """Use pywebview's pinned WinForms probe before it can fall back to MSHTML."""
    try:
        from webview.platforms import winforms

        return bool(winforms._is_chromium())
    except Exception:
        return False


def enable_per_monitor_v2_dpi_awareness() -> bool:
    """Enable crisp per-monitor rendering when no manifest has done so already."""
    try:
        win_dll = getattr(ctypes, "WinDLL", None)
        if win_dll is None:
            return False

        user32 = win_dll("user32", use_last_error=True)
        set_awareness = user32.SetProcessDpiAwarenessContext
        set_awareness.argtypes = [ctypes.c_void_p]
        set_awareness.restype = ctypes.c_bool

        set_last_error = getattr(ctypes, "set_last_error", None)
        if set_last_error is not None:
            set_last_error(0)

        enabled = bool(
            set_awareness(
                ctypes.c_void_p(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
            )
        )
        if enabled:
            return True

        # A manifest or another host may have configured DPI awareness first.
        error_code = getattr(ctypes, "get_last_error", lambda: 0)()
        if error_code == ERROR_ACCESS_DENIED:
            return False
    except Exception:
        pass

    return False


class WindowsTitleBarAdapter:
    """Apply a light DWM caption without replacing the native window frame."""

    _ATTRIBUTES = (
        (DWMWA_USE_IMMERSIVE_DARK_MODE, ctypes.c_int, 0),
        (DWMWA_SYSTEMBACKDROP_TYPE, ctypes.c_int, DWMSBT_NONE),
        (DWMWA_MICA_EFFECT, ctypes.c_int, 0),
        (DWMWA_CAPTION_COLOR, ctypes.c_uint32, 0x00FFFFFF),
        (DWMWA_TEXT_COLOR, ctypes.c_uint32, 0x002A170F),
        (DWMWA_BORDER_COLOR, ctypes.c_uint32, 0x00F0E8E2),
    )

    def __init__(
        self,
        dwm_set_window_attribute: Callable[..., int] | None = None,
        system_events=None,
    ) -> None:
        self._dwm_set_window_attribute = dwm_set_window_attribute
        self._system_events = system_events
        self._window = None
        self._attached_window = None
        self._activation_source = None
        self._theme_source = None

    @staticmethod
    def _native_handle(window) -> int | None:
        """Extract a Win32 HWND from pywebview's WinForms wrapper."""
        try:
            native = getattr(window, "native", None)
            handle = getattr(native, "Handle", None)
        except Exception:
            return None
        if handle is None:
            return None

        if isinstance(handle, int):
            return handle or None

        for conversion in ("ToInt64", "ToInt32"):
            convert = getattr(handle, conversion, None)
            if callable(convert):
                try:
                    value = int(convert())
                    return value or None
                except Exception:
                    continue

        try:
            value = int(handle)
            return value or None
        except Exception:
            return None

    def _resolve_dwm_setter(self) -> Callable[..., int] | None:
        if self._dwm_set_window_attribute is not None:
            return self._dwm_set_window_attribute

        try:
            win_dll = getattr(ctypes, "WinDLL", None)
            if win_dll is None:
                return None

            setter = win_dll("dwmapi").DwmSetWindowAttribute
            setter.argtypes = [
                ctypes.c_void_p,
                ctypes.c_uint32,
                ctypes.c_void_p,
                ctypes.c_uint32,
            ]
            setter.restype = ctypes.c_long
            self._dwm_set_window_attribute = setter
            return setter
        except Exception:
            return None

    def attach(self, window) -> None:
        """Apply after first render and reapply whenever Windows activates it."""
        self._window = window
        if self._attached_window is window:
            return

        try:
            window.events.shown += self._on_shown
        except Exception:
            return

        self._attached_window = window

    def apply(self) -> bool:
        """Best-effort DWM styling; unsupported attributes never block startup."""
        if self._window is None:
            return False

        hwnd = self._native_handle(self._window)
        setter = self._resolve_dwm_setter()
        if hwnd is None or setter is None:
            return False

        applied_all = True
        for attribute, value_type, raw_value in self._ATTRIBUTES:
            value = value_type(raw_value)
            try:
                result = setter(
                    hwnd,
                    attribute,
                    ctypes.byref(value),
                    ctypes.sizeof(value),
                )
                result_code = getattr(result, "value", result)
                if result_code != 0:
                    applied_all = False
            except Exception:
                applied_all = False

        return applied_all

    def _bind_activation(self) -> None:
        try:
            native = getattr(self._window, "native", None)
        except Exception:
            return
        if native is None or self._activation_source is native:
            return

        try:
            native.Activated += self._on_activated
        except Exception:
            return

        self._activation_source = native

    def _resolve_system_events(self):
        if self._system_events is not None:
            return self._system_events

        try:
            from webview.platforms import winforms

            self._system_events = winforms.SystemEvents
            return self._system_events
        except Exception:
            return None

    def _bind_theme_change(self) -> None:
        system_events = self._resolve_system_events()
        if system_events is None or self._theme_source is system_events:
            return

        try:
            system_events.UserPreferenceChanged += self._on_system_theme_changed
        except Exception:
            return

        self._theme_source = system_events

    def _on_shown(self, *_args) -> None:
        self.apply()
        self._bind_activation()
        self._bind_theme_change()

    def _on_activated(self, *_args) -> None:
        self.apply()

    def _on_system_theme_changed(self, *_args) -> None:
        self.apply()


class TrayIcon(Protocol):
    """The subset of the pystray icon API used by the launcher."""

    def stop(self) -> None:
        """停止托盘图标事件循环。"""
        ...


class DesktopGatewayApp:
    """Coordinate the local gateway, its WebView window, and tray controls."""

    def __init__(
        self,
        host: str | None = None,
        port: int | None = None,
        readiness_timeout: int = 30,
        webview2_runtime_probe: Callable[[], bool] | None = None,
    ) -> None:
        """初始化本地服务、窗口和托盘组件的运行状态。"""
        self.host = host or os.getenv("HOST", "127.0.0.1")
        self.port = port if port is not None else int(os.getenv("PORT", "4000"))
        self.base_url = f"http://{self.host}:{self.port}"
        self.readiness_timeout = readiness_timeout
        self.webview2_runtime_probe = (
            webview2_runtime_probe or is_webview2_runtime_available
        )
        self.server: uvicorn.Server | None = None
        self.server_thread: threading.Thread | None = None
        self.window = None
        self.tray: TrayIcon | None = None
        self.tray_thread: threading.Thread | None = None
        self.is_exiting = False
        self.title_bar = WindowsTitleBarAdapter()

    def _serve(self) -> None:
        """在当前后台线程中运行 Uvicorn 服务。"""
        config = uvicorn.Config(
            app,
            host=self.host,
            port=self.port,
            log_level=os.getenv("LOG_LEVEL", "info"),
            access_log=False,
        )
        self.server = uvicorn.Server(config)
        self.server.run()

    def _start_server(self) -> None:
        """创建守护线程并启动网关服务。"""
        self.server_thread = threading.Thread(target=self._serve, daemon=True)
        self.server_thread.start()

    def _wait_until_ready(self) -> bool:
        """轮询健康检查，直至服务就绪或等待超时。"""
        deadline = time.monotonic() + self.readiness_timeout
        while time.monotonic() < deadline:
            try:
                response = httpx.get(f"{self.base_url}/health", timeout=1)
                if response.status_code == 200:
                    return True
            except httpx.HTTPError:
                pass
            time.sleep(0.3)
        return False

    @staticmethod
    def _create_tray_image() -> Image.Image:
        """读取打包托盘图标，读取失败时生成备用图标。"""
        try:
            with Image.open(TRAY_ICON_PATH) as icon:
                return icon.convert("RGBA")
        except (OSError, ValueError):
            return DesktopGatewayApp._create_fallback_tray_image()

    @staticmethod
    def _create_fallback_tray_image() -> Image.Image:
        """绘制不依赖外部资源的备用托盘图标。"""
        image = Image.new("RGBA", (64, 64), (15, 23, 42, 255))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((10, 10, 54, 54), radius=8, fill=(8, 145, 178, 255))
        draw.rectangle((22, 19, 42, 45), fill=(255, 255, 255, 255))
        draw.rectangle((26, 23, 38, 27), fill=(8, 145, 178, 255))
        draw.rectangle((26, 31, 38, 35), fill=(8, 145, 178, 255))
        draw.rectangle((26, 39, 34, 43), fill=(8, 145, 178, 255))
        return image

    def _start_tray(self) -> None:
        """创建托盘菜单并在守护线程中启动图标事件循环。"""
        menu = pystray.Menu(
            pystray.MenuItem("Show Office Gateway", lambda _icon, _item: self._show_window()),
            pystray.MenuItem("Exit", lambda _icon, _item: self._exit_application()),
        )
        self.tray = pystray.Icon(
            "OfficeGateway",
            self._create_tray_image(),
            WINDOW_TITLE,
            menu,
        )
        self.tray_thread = threading.Thread(target=self.tray.run, daemon=True)
        self.tray_thread.start()

    def _hide_window(self) -> bool:
        """拦截窗口关闭操作并隐藏窗口，退出过程中则允许关闭。"""
        if self.is_exiting:
            return True
        if self.window is not None:
            self.window.hide()
        return False

    def _show_window(self) -> None:
        """显示并恢复已创建的桌面窗口。"""
        if self.window is None:
            return
        self.window.show()
        self.window.restore()

    def _exit_application(self) -> None:
        """以幂等方式请求停止服务、托盘和桌面窗口。"""
        if self.is_exiting:
            return
        self.is_exiting = True
        if self.server is not None:
            try:
                self.server.should_exit = True
            except Exception:
                pass
        if self.tray is not None:
            try:
                self.tray.stop()
            except Exception:
                pass
        if self.window is not None:
            try:
                self.window.destroy()
            except Exception:
                pass

    def _stop_server(self) -> None:
        """请求 Uvicorn 退出并等待服务线程结束。"""
        if self.server is not None:
            try:
                self.server.should_exit = True
            except Exception:
                pass
        if self.server_thread is not None:
            try:
                self.server_thread.join(timeout=5)
            except Exception:
                pass

    @staticmethod
    def _show_startup_error(message: str) -> None:
        """记录启动错误，并尽可能显示 Windows 错误对话框。"""
        print(message, flush=True)
        try:
            ctypes.windll.user32.MessageBoxW(None, message, WINDOW_TITLE, 0x10)
        except (AttributeError, OSError):
            pass

    def run(self) -> int:
        """启动网关、WebView 和托盘，并返回桌面进程退出码。"""
        try:
            if not self.webview2_runtime_probe():
                raise RuntimeError("Microsoft Edge WebView2 Runtime is unavailable.")

            self._start_server()
            if not self._wait_until_ready():
                raise RuntimeError(f"Office Gateway did not become ready at {self.base_url}.")

            width, height, x, y = resolve_initial_window_geometry()
            position = {"x": x, "y": y} if x is not None and y is not None else {}
            self.window = webview.create_window(
                WINDOW_TITLE,
                f"{self.base_url}/?desktop=1",
                width=width,
                height=height,
                resizable=True,
                min_size=WINDOW_MIN_SIZE,
                frameless=False,
                easy_drag=False,
                shadow=True,
                background_color="#FFFFFF",
                **position,
            )
            self.window.events.closing += self._hide_window
            self.title_bar.attach(self.window)
            self._start_tray()
            webview.start(gui="edgechromium", icon=str(TRAY_ICON_PATH))
            return 0
        except Exception as exc:
            self._show_startup_error(
                "Office Gateway could not start its desktop window. "
                "Ensure Microsoft Edge WebView2 Runtime is installed.\n\n"
                f"Details: {exc}"
            )
            return 1
        finally:
            self._exit_application()
            self._stop_server()


def main() -> int:
    """创建桌面应用并运行主生命周期。"""
    enable_per_monitor_v2_dpi_awareness()
    return DesktopGatewayApp().run()


if __name__ == "__main__":
    raise SystemExit(main())
