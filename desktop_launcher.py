"""Windows desktop entry point for the packaged Office Gateway."""
import ctypes
import os
import threading
import time
from typing import Protocol

import httpx
from PIL import Image, ImageDraw
import pystray
import uvicorn
import webview

from gateway import app


WINDOW_TITLE = "Office Gateway"


class TrayIcon(Protocol):
    """The subset of the pystray icon API used by the launcher."""

    def stop(self) -> None: ...


class DesktopGatewayApp:
    """Coordinate the local gateway, its WebView window, and tray controls."""

    def __init__(
        self,
        host: str | None = None,
        port: int | None = None,
        readiness_timeout: int = 30,
    ) -> None:
        self.host = host or os.getenv("HOST", "127.0.0.1")
        self.port = port if port is not None else int(os.getenv("PORT", "4000"))
        self.base_url = f"http://{self.host}:{self.port}"
        self.readiness_timeout = readiness_timeout
        self.server: uvicorn.Server | None = None
        self.server_thread: threading.Thread | None = None
        self.window = None
        self.tray: TrayIcon | None = None
        self.tray_thread: threading.Thread | None = None
        self.is_exiting = False

    def _serve(self) -> None:
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
        self.server_thread = threading.Thread(target=self._serve, daemon=True)
        self.server_thread.start()

    def _wait_until_ready(self) -> bool:
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
        image = Image.new("RGBA", (64, 64), (15, 23, 42, 255))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((10, 10, 54, 54), radius=8, fill=(8, 145, 178, 255))
        draw.rectangle((22, 19, 42, 45), fill=(255, 255, 255, 255))
        draw.rectangle((26, 23, 38, 27), fill=(8, 145, 178, 255))
        draw.rectangle((26, 31, 38, 35), fill=(8, 145, 178, 255))
        draw.rectangle((26, 39, 34, 43), fill=(8, 145, 178, 255))
        return image

    def _start_tray(self) -> None:
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
        if self.is_exiting:
            return True
        if self.window is not None:
            self.window.hide()
        return False

    def _show_window(self) -> None:
        if self.window is None:
            return
        self.window.show()
        self.window.restore()

    def _exit_application(self) -> None:
        if self.is_exiting:
            return
        self.is_exiting = True
        if self.server is not None:
            self.server.should_exit = True
        if self.tray is not None:
            self.tray.stop()
        if self.window is not None:
            self.window.destroy()

    def _stop_server(self) -> None:
        if self.server is not None:
            self.server.should_exit = True
        if self.server_thread is not None:
            self.server_thread.join(timeout=5)

    @staticmethod
    def _show_startup_error(message: str) -> None:
        print(message, flush=True)
        try:
            ctypes.windll.user32.MessageBoxW(None, message, WINDOW_TITLE, 0x10)
        except (AttributeError, OSError):
            pass

    def run(self) -> int:
        try:
            self._start_server()
            if not self._wait_until_ready():
                raise RuntimeError(f"Office Gateway did not become ready at {self.base_url}.")

            self.window = webview.create_window(
                WINDOW_TITLE,
                self.base_url,
                width=1280,
                height=840,
                min_size=(960, 640),
            )
            self.window.events.closing += self._hide_window
            self._start_tray()
            webview.start(gui="edgechromium")
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
    return DesktopGatewayApp().run()


if __name__ == "__main__":
    raise SystemExit(main())
