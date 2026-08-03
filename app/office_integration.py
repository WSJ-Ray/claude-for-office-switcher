"""Windows Office add-in detection and managed sideloading.

The service keeps all operating-system dependencies injectable so its behavior can
be tested without accessing a real Windows registry or starting processes.
"""

from __future__ import annotations

import csv
import importlib
import io
import ipaddress
import json
import ntpath
import os
import subprocess
import sys
import tempfile
import threading
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit


WORD_STORE_ID = "wa200010453"
WORD_MANIFEST_ID = "d51ccb01-85e7-42ab-885b-de05c07799f3"
POWERPOINT_STORE_ID = "wa200010001"
POWERPOINT_MANIFEST_ID = "f5f369e5-aa35-49d7-ad7b-638152ddb008"
EXCEL_STORE_ID = "wa200009404"
EXCEL_MANIFEST_ID = "8ac3747c-fc92-4350-aaad-92159ff6f64a"

DEVELOPER_REGISTRY_PATH = r"SOFTWARE\Microsoft\Office\16.0\Wef\Developer"
CLICK_TO_RUN_REGISTRY_PATH = (
    r"SOFTWARE\Microsoft\Office\ClickToRun\Configuration"
)
CLICK_TO_RUN_WOW64_REGISTRY_PATH = (
    r"SOFTWARE\WOW6432Node\Microsoft\Office\ClickToRun\Configuration"
)

# Compatibility aliases for callers that use more explicit constant names.
OFFICE_DEVELOPER_REGISTRY_PATH = DEVELOPER_REGISTRY_PATH
OFFICE_CLICK_TO_RUN_REGISTRY_PATH = CLICK_TO_RUN_REGISTRY_PATH

_HKCU = "HKCU"
_HKLM = "HKLM"
_MISSING = object()
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
_OFFICE_MUTATION_LOCK = threading.RLock()

_ERROR_MESSAGES = {
    "invalid_gateway_url": "The Office gateway URL is invalid.",
    "registry_read_failed": "The Windows registry could not be read.",
    "registry_write_failed": "The Windows registry could not be updated.",
    "registry_delete_failed": "The Windows registry value could not be removed.",
    "unsupported_platform": "Office integration is only supported on Windows.",
    "office_not_found": "Microsoft Office Click-to-Run was not detected.",
    "invalid_bootstrap_secret": "A bootstrap secret is required.",
    "invalid_app_selection": "One or more Office applications are invalid.",
    "developer_override_conflict": "An external Office developer override already exists.",
    "manifest_template_missing": "An Office manifest template is missing.",
    "manifest_template_invalid": "An Office manifest template is invalid.",
    "setup_failed": "Office add-in setup failed.",
    "setup_rollback_failed": "Office add-in setup failed and could not be fully restored.",
    "repair_failed": "Office developer override repair failed.",
    "repair_rollback_failed": "Office developer override repair failed and could not be fully restored.",
    "remove_failed": "Office add-in removal failed.",
    "remove_rollback_failed": "Office add-in removal failed and could not be fully restored.",
}


def _is_missing_registry_error(error: BaseException) -> bool:
    """判断异常是否表示注册表项或值不存在。"""
    return isinstance(error, FileNotFoundError) or getattr(
        error, "winerror", None
    ) in {2, 3}


class OfficeIntegrationError(RuntimeError):
    """A stable, JSON-serializable domain error for Office integration actions."""

    def __init__(self, code: str, message: str | None = None):
        """根据稳定错误码创建不泄露内部细节的领域异常。"""
        safe_message = _ERROR_MESSAGES.get(
            code, "The Office integration operation failed."
        )
        super().__init__(safe_message)
        self.code = code
        self.message = safe_message

    def to_dict(self) -> dict[str, str]:
        """将领域异常转换为可安全序列化的响应字典。"""
        return {"code": self.code, "message": self.message}


# A descriptive alias keeps the error easy to discover for API callers.
OfficeIntegrationException = OfficeIntegrationError


@dataclass(frozen=True)
class _AppSpec:
    key: str
    display_name: str
    executable: str
    store_id: str
    manifest_id: str
    template_name: str
    output_name: str

    @property
    def marketplace_url(self) -> str:
        """Return the official Microsoft Marketplace page for this add-in."""
        return (
            "https://marketplace.microsoft.com/en-us/product/office/"
            f"{self.store_id.upper()}"
        )


_APP_SPECS = (
    _AppSpec(
        key="word",
        display_name="Word",
        executable="WINWORD.EXE",
        store_id=WORD_STORE_ID,
        manifest_id=WORD_MANIFEST_ID,
        template_name="claude-word.xml",
        output_name="claude-word.xml",
    ),
    _AppSpec(
        key="powerpoint",
        display_name="PowerPoint",
        executable="POWERPNT.EXE",
        store_id=POWERPOINT_STORE_ID,
        manifest_id=POWERPOINT_MANIFEST_ID,
        template_name="claude-powerpoint.xml",
        output_name="claude-powerpoint.xml",
    ),
    _AppSpec(
        key="excel",
        display_name="Excel",
        executable="EXCEL.EXE",
        store_id=EXCEL_STORE_ID,
        manifest_id=EXCEL_MANIFEST_ID,
        template_name="claude-excel.xml",
        output_name="claude-excel.xml",
    ),
)

_APP_SPEC_BY_KEY = {spec.key: spec for spec in _APP_SPECS}


class WinRegistryAdapter:
    """Small lazy wrapper around winreg, using HKCU for every mutation."""

    def __init__(self):
        """延迟导入仅在 Windows 上可用的 winreg 模块。"""
        # winreg does not exist on non-Windows Python builds, so import it only
        # when a Windows operation actually needs the default adapter.
        self._winreg = importlib.import_module("winreg")

    def _hive(self, hive: str):
        """将内部注册表根键名称映射为 winreg 常量。"""
        if hive == _HKCU:
            return self._winreg.HKEY_CURRENT_USER
        if hive == _HKLM:
            return self._winreg.HKEY_LOCAL_MACHINE
        raise ValueError(f"Unsupported registry hive: {hive}")

    def _read_access(self, hive: str) -> int:
        """构造注册表读取权限，并对 HKLM 使用 64 位视图。"""
        access = self._winreg.KEY_READ
        if hive == _HKLM:
            access |= getattr(self._winreg, "KEY_WOW64_64KEY", 0)
        return access

    def query_value(self, hive: str, path: str, name: str) -> Any:
        """读取注册表值，并将访问错误转换为稳定领域异常。"""
        try:
            with self._winreg.OpenKey(
                self._hive(hive), path, 0, self._read_access(hive)
            ) as key:
                return self._winreg.QueryValueEx(key, name)[0]
        except OSError as exc:
            if _is_missing_registry_error(exc):
                raise
            raise OfficeIntegrationError("registry_read_failed") from exc

    def key_exists(self, hive: str, path: str) -> bool:
        """判断注册表键是否存在，同时区分缺失与访问失败。"""
        try:
            with self._winreg.OpenKey(
                self._hive(hive), path, 0, self._read_access(hive)
            ):
                return True
        except OSError as exc:
            if _is_missing_registry_error(exc):
                return False
            raise OfficeIntegrationError("registry_read_failed") from exc

    def set_value(self, hive: str, path: str, name: str, value: str) -> None:
        """仅在 HKCU 中创建或更新 Office 开发者注册值。"""
        if hive != _HKCU:
            raise ValueError("Office developer overrides may only be written to HKCU")
        try:
            with self._winreg.CreateKeyEx(
                self._winreg.HKEY_CURRENT_USER,
                path,
                0,
                self._winreg.KEY_SET_VALUE,
            ) as key:
                self._winreg.SetValueEx(key, name, 0, self._winreg.REG_SZ, value)
        except OSError as exc:
            raise OfficeIntegrationError("registry_write_failed") from exc

    def delete_value(self, hive: str, path: str, name: str) -> None:
        """仅从 HKCU 删除 Office 开发者注册值。"""
        if hive != _HKCU:
            raise ValueError("Office developer overrides may only be deleted from HKCU")
        try:
            with self._winreg.OpenKey(
                self._winreg.HKEY_CURRENT_USER,
                path,
                0,
                self._winreg.KEY_SET_VALUE,
            ) as key:
                self._winreg.DeleteValue(key, name)
        except OSError as exc:
            if _is_missing_registry_error(exc):
                raise
            raise OfficeIntegrationError("registry_delete_failed") from exc


class OfficeIntegration:
    """Detect, install, and remove the gateway's managed Office add-ins."""

    def __init__(
        self,
        *,
        platform: str | None = None,
        data_dir: str | os.PathLike[str] | None = None,
        bundle_dir: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        registry: Any | None = None,
        process_runner: Any | None = None,
        process: Any | None = None,
        local_app_data: str | os.PathLike[str] | None = None,
    ):
        """初始化可注入的系统依赖、数据路径和网关地址。"""
        if process is not None and process_runner is not None:
            raise ValueError("Provide either process or process_runner, not both")
        self.platform = sys.platform if platform is None else platform
        self.env = dict(os.environ if env is None else env)
        self.data_dir = self._absolute_path(
            data_dir if data_dir is not None else self._default_data_dir()
        )
        self.bundle_dir = self._absolute_path(
            bundle_dir if bundle_dir is not None else self._default_bundle_dir()
        )
        self.local_app_data = self._absolute_path(
            local_app_data
            if local_app_data is not None
            else self.env.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")
        )
        self._registry_adapter = registry
        if process_runner is not None:
            self._process_runner = process_runner
        elif process is not None:
            self._process_runner = process
        else:
            self._process_runner = subprocess.run
        self._mutation_lock = _OFFICE_MUTATION_LOCK
        self.gateway_url = self._resolve_gateway_url()

    @staticmethod
    def _absolute_path(value: str | os.PathLike[str]) -> Path:
        """展开用户目录并返回不依赖文件存在性的绝对路径。"""
        return Path(value).expanduser().absolute()

    def _default_bundle_dir(self) -> Path:
        """解析源码运行或打包运行时的资源根目录。"""
        if getattr(sys, "frozen", False):
            return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        return Path(__file__).resolve().parent.parent

    def _default_data_dir(self) -> Path:
        """按环境变量、打包目录或项目目录解析数据目录。"""
        configured = self.env.get("GATEWAY_DATA_DIR")
        if configured:
            return Path(configured)
        if getattr(sys, "frozen", False):
            return Path(sys.executable).resolve().parent / "data"
        return Path(__file__).resolve().parent.parent / "data"

    @property
    def output_dir(self) -> Path:
        """返回生成 Office 清单的受管输出目录。"""
        return self.data_dir / "office_addins"

    @property
    def manifest_paths(self) -> dict[str, Path]:
        """返回每个 Office 应用对应的受管清单路径。"""
        return {
            spec.key: self.output_dir / spec.output_name for spec in _APP_SPECS
        }

    @staticmethod
    def _valid_dns_hostname(hostname: str) -> bool:
        """按 DNS 标签规则校验不带尾点的主机名。"""
        if not hostname or len(hostname) > 253 or hostname.endswith("."):
            return False
        labels = hostname.split(".")
        for label in labels:
            if not label or len(label) > 63:
                return False
            if not label[0].isalnum() or not label[-1].isalnum():
                return False
            if any(
                not character.isascii()
                or not (character.isalnum() or character == "-")
                for character in label
            ):
                return False
        return True

    def _resolve_gateway_url(self) -> str:
        """解析并校验 Office 可访问的网关基础地址。

        回环地址允许 HTTP，远程主机必须使用 HTTPS；返回值不包含路径、查询或片段。
        """
        configured = self.env.get("OFFICE_GATEWAY_BASE_URL")
        if configured is None:
            configured_port = self.env.get("PORT") or "4000"
            port_text = str(configured_port)
            if not port_text.isascii() or not port_text.isdecimal():
                raise OfficeIntegrationError("invalid_gateway_url")
            port = int(port_text)
            if not 1 <= port <= 65535:
                raise OfficeIntegrationError("invalid_gateway_url")
            configured = f"http://127.0.0.1:{port}"
        candidate = str(configured)
        if (
            not candidate
            or "\\" in candidate
            or "?" in candidate
            or "#" in candidate
            or any(
                character.isspace()
                or ord(character) < 32
                or ord(character) == 127
                for character in candidate
            )
        ):
            raise OfficeIntegrationError("invalid_gateway_url")

        try:
            parsed = urlsplit(candidate)
            port = parsed.port
        except (TypeError, ValueError) as exc:
            raise OfficeIntegrationError("invalid_gateway_url") from exc

        scheme = parsed.scheme.lower()
        hostname = (parsed.hostname or "").lower()
        invalid = (
            scheme not in {"http", "https"}
            or not hostname
            or hostname == "."
            or parsed.username is not None
            or parsed.password is not None
            or bool(parsed.query)
            or bool(parsed.fragment)
            or (port is not None and not 1 <= port <= 65535)
        )
        ip_address = None
        try:
            ip_address = ipaddress.ip_address(hostname)
        except ValueError:
            if not self._valid_dns_hostname(hostname):
                invalid = True
        is_loopback = hostname == "localhost" or bool(
            ip_address and ip_address.is_loopback
        )
        if invalid or (scheme == "http" and not is_loopback):
            raise OfficeIntegrationError("invalid_gateway_url")

        normalized_hostname = (
            ip_address.compressed.lower() if ip_address is not None else hostname
        )
        if ip_address is not None and ip_address.version == 6:
            normalized_hostname = f"[{normalized_hostname}]"
        netloc = normalized_hostname
        if port is not None:
            netloc = f"{netloc}:{port}"
        normalized_path = parsed.path.rstrip("/")
        return urlunsplit((scheme, netloc, normalized_path, "", ""))

    def _is_windows(self) -> bool:
        """判断当前注入的平台标识是否表示 Windows。"""
        return str(self.platform).lower() in {"win32", "windows"}

    @staticmethod
    def _select_specs(app_keys: list[str] | tuple[str, ...] | None) -> list[_AppSpec]:
        """Resolve an optional application selection in stable display order."""
        if app_keys is None:
            return list(_APP_SPECS)
        if not isinstance(app_keys, (list, tuple)) or not app_keys:
            raise OfficeIntegrationError("invalid_app_selection")
        if any(not isinstance(key, str) for key in app_keys):
            raise OfficeIntegrationError("invalid_app_selection")
        selected = set(app_keys)
        if len(selected) != len(app_keys) or not selected.issubset(_APP_SPEC_BY_KEY):
            raise OfficeIntegrationError("invalid_app_selection")
        return [spec for spec in _APP_SPECS if spec.key in selected]

    def _registry(self):
        """延迟创建并返回注册表适配器。"""
        if self._registry_adapter is None:
            self._registry_adapter = WinRegistryAdapter()
        return self._registry_adapter

    def _registry_query(self, hive: str, path: str, name: str):
        """通过兼容适配器读取注册表值，并规范化缺失与读取错误。"""
        adapter = self._registry()
        method = getattr(adapter, "query_value", None) or getattr(
            adapter, "get_value", None
        )
        if method is None:
            raise TypeError("Registry adapter must provide query_value()")
        try:
            value = method(hive, path, name)
        except OfficeIntegrationError:
            raise
        except Exception as exc:
            if _is_missing_registry_error(exc):
                return _MISSING
            raise OfficeIntegrationError("registry_read_failed") from exc
        if isinstance(value, tuple) and len(value) == 2:
            value = value[0]
        return _MISSING if value is None else value

    def _registry_key_exists(self, hive: str, path: str) -> bool | None:
        """通过适配器检查注册表键；不支持该能力时返回 None。"""
        method = getattr(self._registry(), "key_exists", None)
        if method is None:
            return None
        try:
            return bool(method(hive, path))
        except OfficeIntegrationError:
            raise
        except Exception as exc:
            if _is_missing_registry_error(exc):
                return False
            raise OfficeIntegrationError("registry_read_failed") from exc

    def _registry_set(self, hive: str, path: str, name: str, value: str) -> None:
        """限制在 HKCU 中写入注册表，并规范化写入错误。"""
        if hive != _HKCU:
            raise ValueError("Office integration writes are restricted to HKCU")
        adapter = self._registry()
        method = getattr(adapter, "set_value", None)
        if method is None:
            raise TypeError("Registry adapter must provide set_value()")
        try:
            method(hive, path, name, value)
        except OfficeIntegrationError:
            raise
        except Exception as exc:
            raise OfficeIntegrationError("registry_write_failed") from exc

    def _registry_delete(
        self, hive: str, path: str, name: str, *, missing_ok: bool = False
    ) -> None:
        """限制在 HKCU 中删除注册表，并按需忽略值缺失。"""
        if hive != _HKCU:
            raise ValueError("Office integration deletes are restricted to HKCU")
        adapter = self._registry()
        method = getattr(adapter, "delete_value", None)
        if method is None:
            raise TypeError("Registry adapter must provide delete_value()")
        try:
            method(hive, path, name)
        except OfficeIntegrationError:
            raise
        except Exception as exc:
            if missing_ok and _is_missing_registry_error(exc):
                return
            raise OfficeIntegrationError("registry_delete_failed") from exc

    @staticmethod
    def _same_path(actual: Any, expected: Path) -> bool:
        """按 Windows 路径语义和文件系统别名判断两个路径是否相同。"""
        if not isinstance(actual, (str, os.PathLike)):
            return False
        actual_text = os.fspath(actual)
        if not actual_text or actual_text != actual_text.strip():
            return False

        def normalize_windows_path(value: str) -> tuple[str, str]:
            """规范化扩展前缀、分隔符、大小写和 UNC 路径。"""
            filesystem_path = value.replace("/", "\\")
            folded = filesystem_path.casefold()
            if folded.startswith("\\\\?\\unc\\"):
                filesystem_path = "\\\\" + filesystem_path[8:]
            elif folded.startswith("\\\\?\\"):
                filesystem_path = filesystem_path[4:]
            normalized = ntpath.normcase(ntpath.normpath(filesystem_path))
            return filesystem_path, normalized

        actual_filesystem_path, normalized_actual = normalize_windows_path(
            actual_text
        )
        expected_filesystem_path, normalized_expected = normalize_windows_path(
            str(expected)
        )
        actual_path = Path(actual_filesystem_path)
        expected_path = Path(expected_filesystem_path)

        try:
            if actual_path.exists() and expected_path.exists():
                return os.path.samefile(actual_path, expected_path)
        except OSError:
            try:
                resolved_actual = actual_path.resolve(strict=True)
                resolved_expected = expected_path.resolve(strict=True)
                return normalize_windows_path(str(resolved_actual))[1] == (
                    normalize_windows_path(str(resolved_expected))[1]
                )
            except OSError:
                pass
        return normalized_actual == normalized_expected

    def _detect_click_to_run(self) -> dict[str, Any]:
        """从原生和 WOW64 注册表视图检测 Office Click-to-Run 安装。"""
        value_names = (
            "VersionToReport",
            "ClientVersionToReport",
            "Platform",
            "InstallationPath",
        )
        selected_path = CLICK_TO_RUN_REGISTRY_PATH
        values: dict[str, Any] = {}
        key_exists = False
        best_value_count = -1

        for registry_path in (
            CLICK_TO_RUN_REGISTRY_PATH,
            CLICK_TO_RUN_WOW64_REGISTRY_PATH,
        ):
            current = {
                name: self._registry_query(_HKLM, registry_path, name)
                for name in value_names
            }
            current_exists = self._registry_key_exists(_HKLM, registry_path)
            value_count = sum(
                value is not _MISSING for value in current.values()
            )
            if current_exists or value_count:
                key_exists = True
            if value_count > best_value_count and (current_exists or value_count):
                selected_path = registry_path
                values = current
                best_value_count = value_count

        version = values.get("VersionToReport", _MISSING)
        if version is _MISSING:
            version = values.get("ClientVersionToReport", _MISSING)
        architecture = values.get("Platform", _MISSING)
        installation_path = values.get("InstallationPath", _MISSING)
        return {
            "installed": key_exists,
            "version": None if version is _MISSING else str(version),
            "architecture": None
            if architecture is _MISSING
            else str(architecture),
            "installation_path": None
            if installation_path is _MISSING
            else str(installation_path),
            "registry_path": selected_path,
        }

    def _executable_candidates(
        self, executable: str, installation_path: str | None
    ) -> list[Path]:
        """生成 Office 可执行文件的候选安装路径并保持顺序去重。"""
        candidates: list[Path] = []
        if installation_path:
            base = Path(installation_path)
            candidates.append(base / executable)
            if base.name.lower() != "office16":
                candidates.append(base / "root" / "Office16" / executable)
                candidates.append(base / "Office16" / executable)
        for env_name in ("ProgramFiles", "ProgramFiles(x86)"):
            program_files = self.env.get(env_name)
            if program_files:
                candidates.append(
                    Path(program_files)
                    / "Microsoft Office"
                    / "root"
                    / "Office16"
                    / executable
                )

        unique: list[Path] = []
        seen = set()
        for candidate in candidates:
            normalized = ntpath.normcase(ntpath.normpath(str(candidate)))
            if normalized not in seen:
                seen.add(normalized)
                unique.append(candidate)
        return unique

    def _detect_executable(
        self, executable: str, installation_path: str | None
    ) -> tuple[bool, str | None]:
        """检查候选路径并返回可执行文件是否存在及其路径。"""
        candidates = self._executable_candidates(executable, installation_path)
        for candidate in candidates:
            if candidate.is_file():
                return True, str(candidate)
        return False, str(candidates[0]) if candidates else None

    def _running_executables(self) -> set[str]:
        """调用 tasklist 获取当前运行的 Office 可执行文件名称。"""
        if not self._is_windows():
            return set()
        runner = self._process_runner
        if not callable(runner):
            runner = getattr(runner, "run")
        try:
            completed = runner(
                ["tasklist", "/FO", "CSV", "/NH"],
                shell=False,
                capture_output=True,
                text=True,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return set()
        if getattr(completed, "returncode", 0) != 0:
            return set()
        output = getattr(completed, "stdout", "") or ""
        if isinstance(output, bytes):
            output = output.decode(errors="replace")

        running = set()
        for row in csv.reader(io.StringIO(str(output))):
            if not row:
                continue
            image_name = row[0].strip().upper()
            if image_name in {spec.executable for spec in _APP_SPECS}:
                running.add(image_name)
        return running

    @staticmethod
    def _json_contains_string(value: Any, expected: str) -> bool:
        """递归检查 JSON 结构是否包含忽略大小写的目标字符串。"""
        if isinstance(value, str):
            return value.casefold() == expected.casefold()
        if isinstance(value, Mapping):
            return any(
                OfficeIntegration._json_contains_string(item, expected)
                for item in value.values()
            )
        if isinstance(value, (list, tuple)):
            return any(
                OfficeIntegration._json_contains_string(item, expected)
                for item in value
            )
        return False

    def _detect_official_installs(self) -> dict[str, bool]:
        """扫描 Office Wef 缓存以检测各应用的官方商店加载项。"""
        detected = {spec.key: False for spec in _APP_SPECS}
        wef_dir = (
            self.local_app_data / "Microsoft" / "Office" / "16.0" / "Wef"
        )
        if not wef_dir.is_dir():
            return detected

        try:
            entries = list(wef_dir.rglob("*"))
        except OSError:
            return detected

        for entry in entries:
            path_text = str(entry).casefold()
            for spec in _APP_SPECS:
                if spec.manifest_id.casefold() in path_text:
                    detected[spec.key] = True

            if not entry.is_file():
                continue
            if entry.name.casefold() == "boot.json":
                try:
                    boot_data = json.loads(entry.read_text(encoding="utf-8-sig"))
                except (OSError, UnicodeError, json.JSONDecodeError):
                    boot_data = None
                if boot_data is not None:
                    for spec in _APP_SPECS:
                        if self._json_contains_string(boot_data, spec.store_id):
                            detected[spec.key] = True

            try:
                if entry.stat().st_size <= 2 * 1024 * 1024:
                    content = entry.read_bytes().lower()
                    for spec in _APP_SPECS:
                        if spec.manifest_id.encode("ascii") in content:
                            detected[spec.key] = True
            except OSError:
                continue
        return detected

    def status(self) -> dict[str, Any]:
        """汇总平台、Office 安装、进程、官方加载项及受管注册状态。"""
        supported = self._is_windows()
        if supported:
            click_to_run = self._detect_click_to_run()
            running = self._running_executables()
            official = self._detect_official_installs()
        else:
            click_to_run = {
                "installed": False,
                "version": None,
                "architecture": None,
                "installation_path": None,
                "registry_path": CLICK_TO_RUN_REGISTRY_PATH,
            }
            running = set()
            official = {spec.key: False for spec in _APP_SPECS}

        apps: dict[str, dict[str, Any]] = {}
        for spec in _APP_SPECS:
            manifest_path = self.manifest_paths[spec.key]
            if supported:
                registered = self._registry_query(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
            else:
                registered = _MISSING
            points_to_managed = registered is not _MISSING and self._same_path(
                registered, manifest_path
            )
            application_installed, executable_path = self._detect_executable(
                spec.executable, click_to_run["installation_path"]
            )
            managed_installed = points_to_managed and manifest_path.is_file()
            conflict = registered is not _MISSING and not points_to_managed
            app_status = {
                "name": spec.display_name,
                "store_id": spec.store_id,
                "marketplace_url": spec.marketplace_url,
                "manifest_id": spec.manifest_id,
                "manifest_path": str(manifest_path),
                "executable_path": executable_path,
                "application_installed": application_installed,
                "official_installed": official[spec.key],
                "official": official[spec.key],
                "managed_installed": managed_installed,
                "managed": managed_installed,
                "conflict": conflict,
                "running": spec.executable in running,
            }
            apps[spec.key] = app_status

        office_running = any(app["running"] for app in apps.values())
        result = {
            "platform": str(self.platform),
            "supported": supported,
            "gateway_url": self.gateway_url,
            "office": {
                "installed": click_to_run["installed"],
                "version": click_to_run["version"],
                "architecture": click_to_run["architecture"],
                "installation_path": click_to_run["installation_path"],
                "running": office_running,
                "click_to_run": click_to_run,
            },
            "apps": apps,
            "managed_installed": all(
                app["managed_installed"] for app in apps.values()
            ),
            "conflict": any(app["conflict"] for app in apps.values()),
        }
        # Top-level aliases make the stable result convenient for API consumers.
        result["word"] = apps["word"]
        result["powerpoint"] = apps["powerpoint"]
        result["excel"] = apps["excel"]
        return result

    def detect(self) -> dict[str, Any]:
        """以兼容别名返回当前 Office 集成状态。"""
        return self.status()

    def get_status(self) -> dict[str, Any]:
        """以兼容别名返回当前 Office 集成状态。"""
        return self.status()

    def _template_path(self, spec: _AppSpec) -> Path:
        """返回指定 Office 应用的清单模板路径。"""
        return self.bundle_dir / "app" / "assets" / "office" / spec.template_name

    @staticmethod
    def _attribute_by_local_name(element: ET.Element, name: str) -> str | None:
        """忽略 XML 命名空间读取指定本地名称的属性。"""
        for attribute, value in element.attrib.items():
            if attribute.rsplit("}", 1)[-1].casefold() == name.casefold():
                return value
        return None

    def _addin_url(self, existing: str, spec: _AppSpec, bootstrap_url: str) -> str:
        """在保留无关参数的同时为加载项入口注入引导配置。"""
        parsed = urlsplit(existing)
        query = [
            (key, value)
            for key, value in parse_qsl(parsed.query, keep_blank_values=True)
            if key not in {"gateway", "auto_connect", "bootstrap_url"}
            and not (spec.key == "word" and key == "m")
        ]
        if spec.key == "word":
            query.append(("m", "word-1.0.0.1"))
        query.extend(
            (
                ("gateway", "1"),
                ("auto_connect", "1"),
                ("bootstrap_url", bootstrap_url),
            )
        )
        return urlunsplit(
            (
                "https",
                "pivot.claude.ai",
                parsed.path or "/",
                urlencode(query),
                "",
            )
        )

    def _render_manifest(self, spec: _AppSpec, bootstrap_url: str) -> bytes:
        """校验清单模板并渲染仅指向当前网关的应用清单。"""
        template_path = self._template_path(spec)
        if not template_path.is_file():
            raise OfficeIntegrationError(
                "manifest_template_missing",
                f"Office manifest template is missing: {template_path}",
            )

        try:
            namespaces = []
            for _, namespace in ET.iterparse(template_path, events=("start-ns",)):
                if namespace not in namespaces:
                    namespaces.append(namespace)
            for prefix, uri in namespaces:
                if prefix != "xml":
                    ET.register_namespace(prefix or "", uri)
            root = ET.parse(template_path).getroot()
        except (ET.ParseError, OSError, ValueError) as exc:
            raise OfficeIntegrationError(
                "manifest_template_invalid",
                f"Office manifest template is invalid: {template_path}",
            ) from exc

        manifest_id_element = next(
            (
                element
                for element in root
                if element.tag.rsplit("}", 1)[-1] == "Id"
            ),
            None,
        )
        if manifest_id_element is None:
            raise OfficeIntegrationError(
                "manifest_template_invalid",
                f"Office manifest template lacks an add-in ID: {template_path}",
            )
        manifest_id_element.text = spec.manifest_id

        source_locations = 0
        taskpane_urls = 0
        for element in root.iter():
            local_name = element.tag.rsplit("}", 1)[-1]
            is_source_location = (
                local_name == "SourceLocation"
                and self._attribute_by_local_name(element, "DefaultValue") is not None
            )
            is_taskpane_url = (
                local_name == "Url"
                and self._attribute_by_local_name(element, "id") == "Taskpane.Url"
            )
            if not (is_source_location or is_taskpane_url):
                continue
            existing = self._attribute_by_local_name(element, "DefaultValue") or ""
            default_value_attribute = next(
                (
                    name
                    for name in element.attrib
                    if name.rsplit("}", 1)[-1].casefold() == "defaultvalue"
                ),
                "DefaultValue",
            )
            element.set(
                default_value_attribute,
                self._addin_url(existing, spec, bootstrap_url),
            )
            source_locations += int(is_source_location)
            taskpane_urls += int(is_taskpane_url)

        if source_locations == 0 or taskpane_urls == 0:
            raise OfficeIntegrationError(
                "manifest_template_invalid",
                f"Office manifest template lacks required URLs: {template_path}",
            )
        return ET.tostring(root, encoding="utf-8", xml_declaration=True)

    @staticmethod
    def _atomic_write(path: Path, content: bytes) -> None:
        """通过同目录临时文件和原子替换安全写入清单。"""
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as temporary_file:
                temporary_file.write(content)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            os.replace(temporary_path, path)
        finally:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass

    @staticmethod
    def _file_snapshot(path: Path):
        """读取文件快照；文件不存在时返回内部缺失标记。"""
        try:
            return path.read_bytes()
        except FileNotFoundError:
            return _MISSING

    def _restore_registry_snapshot(
        self,
        registry_before: Mapping[str, Any],
        specs: list[_AppSpec],
        expected_current: Mapping[str, Any],
    ) -> bool:
        """仅在当前值仍由本次操作持有时逆序恢复注册表快照。"""
        restored = True
        for spec in reversed(specs):
            previous = registry_before[spec.key]
            try:
                current = self._registry_query(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
                expected = expected_current[spec.key]
                if expected is _MISSING:
                    if current is not _MISSING:
                        continue
                elif current is _MISSING or not self._same_path(
                    current, Path(str(expected))
                ):
                    continue
                if previous is _MISSING:
                    self._registry_delete(
                        _HKCU,
                        DEVELOPER_REGISTRY_PATH,
                        spec.manifest_id,
                        missing_ok=True,
                    )
                else:
                    self._registry_set(
                        _HKCU,
                        DEVELOPER_REGISTRY_PATH,
                        spec.manifest_id,
                        str(previous),
                    )
            except Exception:
                restored = False
        return restored

    def _restore_file_snapshot(
        self,
        files_before: Mapping[str, Any],
        specs: list[_AppSpec],
        expected_current: Mapping[str, Any],
        output_dir_existed: bool,
    ) -> bool:
        """仅在当前内容仍匹配预期时逆序恢复文件和输出目录快照。"""
        restored = True
        for spec in reversed(specs):
            previous = files_before[spec.key]
            path = self.manifest_paths[spec.key]
            try:
                current = self._file_snapshot(path)
                expected = expected_current[spec.key]
                if expected is _MISSING:
                    if current is not _MISSING:
                        continue
                elif current is _MISSING or current != expected:
                    continue
            except OSError:
                restored = False
                continue
            try:
                if previous is _MISSING:
                    path.unlink(missing_ok=True)
                else:
                    self._atomic_write(path, previous)
            except Exception:
                try:
                    current = self._file_snapshot(path)
                    matches_snapshot = (
                        current is _MISSING and previous is _MISSING
                    ) or (
                        current is not _MISSING
                        and previous is not _MISSING
                        and current == previous
                    )
                except OSError:
                    matches_snapshot = False
                if not matches_snapshot:
                    restored = False
        if not output_dir_existed:
            try:
                self.output_dir.rmdir()
            except FileNotFoundError:
                pass
            except OSError:
                try:
                    if not self.output_dir.is_dir() or not any(
                        self.output_dir.iterdir()
                    ):
                        restored = False
                except OSError:
                    restored = False
        return restored

    def setup(
        self,
        secret: str,
        app_keys: list[str] | tuple[str, ...] | None = None,
    ) -> dict[str, Any]:
        """在共享互斥锁内安装或刷新受管 Office 加载项。"""
        with self._mutation_lock:
            return self._setup_locked(secret, app_keys)

    def _validate_setup_preconditions(
        self, secret: str
    ) -> tuple[dict[str, Any], str]:
        """校验平台、Office、冲突和密钥，并返回状态与引导 URL。"""
        if not self._is_windows():
            raise OfficeIntegrationError(
                "unsupported_platform", "Office integration is only supported on Windows"
            )

        before_status = self.status()
        if not before_status["office"]["installed"]:
            raise OfficeIntegrationError(
                "office_not_found", "Microsoft Office Click-to-Run was not detected"
            )
        if not isinstance(secret, str) or not secret:
            raise OfficeIntegrationError(
                "invalid_bootstrap_secret", "A bootstrap secret is required"
            )

        encoded_secret = quote(secret, safe="")
        bootstrap_url = (
            f"{self.gateway_url}/office/bootstrap/{encoded_secret}"
        )
        return before_status, bootstrap_url

    def _setup_locked(
        self,
        secret: str,
        app_keys: list[str] | tuple[str, ...] | None = None,
    ) -> dict[str, Any]:
        """写入受管清单和注册值，失败时恢复操作前快照。"""
        before_status, bootstrap_url = self._validate_setup_preconditions(secret)
        specs = self._select_specs(app_keys)

        registry_before = {}
        files_before = {}
        for spec in specs:
            manifest_path = self.manifest_paths[spec.key]
            registered = self._registry_query(
                _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
            )
            if registered is not _MISSING and not self._same_path(
                registered, manifest_path
            ):
                raise OfficeIntegrationError(
                    "developer_override_conflict",
                    f"{spec.display_name} already has an external developer override",
                )
            registry_before[spec.key] = registered
            try:
                files_before[spec.key] = self._file_snapshot(manifest_path)
            except OSError as exc:
                raise OfficeIntegrationError("setup_failed") from exc

        rendered = {
            spec.key: self._render_manifest(spec, bootstrap_url)
            for spec in specs
        }

        files_to_write = [
            spec
            for spec in specs
            if files_before[spec.key] is _MISSING
            or files_before[spec.key] != rendered[spec.key]
        ]
        registry_to_write = [
            spec
            for spec in specs
            if registry_before[spec.key] is _MISSING
            or not self._same_path(
                registry_before[spec.key], self.manifest_paths[spec.key]
            )
        ]
        changed = bool(files_to_write or registry_to_write)
        output_dir_existed = self.output_dir.exists()
        attempted_files: list[_AppSpec] = []
        expected_files: dict[str, bytes] = {}
        attempted_registry: list[_AppSpec] = []
        expected_registry: dict[str, str] = {}

        try:
            for spec in files_to_write:
                attempted_files.append(spec)
                expected_files[spec.key] = rendered[spec.key]
                self._atomic_write(
                    self.manifest_paths[spec.key], rendered[spec.key]
                )
            # winreg has no compare-and-swap primitive. Re-reading immediately
            # before and after each write, then using conditional compensation,
            # is the strongest boundary available without overwriting external
            # developer overrides.
            for spec in specs:
                expected_path = self.manifest_paths[spec.key]
                current = self._registry_query(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
                if current is not _MISSING:
                    if not self._same_path(current, expected_path):
                        raise OfficeIntegrationError(
                            "developer_override_conflict"
                        )
                    continue
                attempted_registry.append(spec)
                expected_registry[spec.key] = str(expected_path)
                self._registry_set(
                    _HKCU,
                    DEVELOPER_REGISTRY_PATH,
                    spec.manifest_id,
                    str(expected_path),
                )
                changed = True
                verified = self._registry_query(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
                if verified is _MISSING or not self._same_path(
                    verified, expected_path
                ):
                    raise OfficeIntegrationError(
                        "developer_override_conflict"
                    )
            for spec in specs:
                verified = self._registry_query(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
                if verified is _MISSING or not self._same_path(
                    verified, self.manifest_paths[spec.key]
                ):
                    raise OfficeIntegrationError(
                        "developer_override_conflict"
                    )
            current_status = self.status()
            if any(
                current_status["apps"][spec.key]["conflict"]
                or not current_status["apps"][spec.key]["managed_installed"]
                for spec in specs
            ):
                raise OfficeIntegrationError(
                    "developer_override_conflict"
                )
        except Exception as exc:
            registry_restored = self._restore_registry_snapshot(
                registry_before, attempted_registry, expected_registry
            )
            files_restored = self._restore_file_snapshot(
                files_before,
                attempted_files,
                expected_files,
                output_dir_existed,
            )
            if not registry_restored or not files_restored:
                raise OfficeIntegrationError("setup_rollback_failed") from exc
            if isinstance(exc, OfficeIntegrationError):
                raise
            raise OfficeIntegrationError("setup_failed") from exc

        return {
            "changed": changed,
            "configured_apps": [spec.key for spec in specs],
            "restart_required": any(
                current_status["apps"][spec.key]["running"] for spec in specs
            ),
            "status": current_status,
        }

    @staticmethod
    def _same_registry_value(actual: Any, expected: Any) -> bool:
        """比较注册表值，并对路径值使用 Windows 路径等价规则。"""
        if actual is _MISSING or expected is _MISSING:
            return actual is expected
        if actual == expected:
            return True
        if isinstance(actual, (str, os.PathLike)) and isinstance(
            expected, (str, os.PathLike)
        ):
            return OfficeIntegration._same_path(actual, Path(os.fspath(expected)))
        return False

    def _restore_repaired_registry_values(
        self,
        registry_before: Mapping[str, Any],
        specs: list[_AppSpec],
    ) -> bool:
        """恢复修复前的外部注册值，同时避免覆盖并发写入的新值。"""
        restored = True
        for spec in reversed(specs):
            previous = registry_before[spec.key]
            try:
                current = self._registry_query(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
            except Exception:
                restored = False
                continue

            if self._same_registry_value(current, previous):
                continue
            if current is not _MISSING:
                # A new external writer owns this value now. Never overwrite it
                # while compensating for this request.
                restored = False
                continue

            try:
                self._registry_set(
                    _HKCU,
                    DEVELOPER_REGISTRY_PATH,
                    spec.manifest_id,
                    str(previous),
                )
            except Exception:
                try:
                    current = self._registry_query(
                        _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                    )
                except Exception:
                    restored = False
                    continue
                if not self._same_registry_value(current, previous):
                    restored = False
                continue

            try:
                current = self._registry_query(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
            except Exception:
                restored = False
                continue
            if not self._same_registry_value(current, previous):
                restored = False
        return restored

    def repair_conflicts(
        self,
        secret: str,
        app_keys: list[str] | tuple[str, ...] | None = None,
    ) -> dict[str, Any]:
        """在共享互斥锁内修复开发者注册冲突。"""
        with self._mutation_lock:
            return self._repair_conflicts_locked(secret, app_keys)

    def _repair_conflicts_locked(
        self,
        secret: str,
        app_keys: list[str] | tuple[str, ...] | None = None,
    ) -> dict[str, Any]:
        """预校验清单后移除冲突值并安装受管项，失败时补偿恢复。"""
        _, bootstrap_url = self._validate_setup_preconditions(secret)
        specs = self._select_specs(app_keys)

        # Validate every template before removing an external registration.
        for spec in specs:
            self._render_manifest(spec, bootstrap_url)

        registry_before: dict[str, Any] = {}
        conflicts: list[_AppSpec] = []
        for spec in specs:
            current = self._registry_query(
                _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
            )
            if current is not _MISSING and not self._same_path(
                current, self.manifest_paths[spec.key]
            ):
                registry_before[spec.key] = current
                conflicts.append(spec)

        if not conflicts:
            result = dict(self._setup_locked(secret, app_keys))
            result["repaired_apps"] = []
            return result

        attempted_deletions: list[_AppSpec] = []
        deleted_specs: list[_AppSpec] = []
        try:
            # Check the complete snapshot once before the first mutation so a
            # known race does not cause an avoidable partial repair.
            deletions: list[_AppSpec] = []
            for spec in conflicts:
                current = self._registry_query(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
                if current is _MISSING or self._same_path(
                    current, self.manifest_paths[spec.key]
                ):
                    continue
                if not self._same_registry_value(
                    current, registry_before[spec.key]
                ):
                    raise OfficeIntegrationError("repair_failed")
                deletions.append(spec)

            for spec in deletions:
                current = self._registry_query(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
                if current is _MISSING or self._same_path(
                    current, self.manifest_paths[spec.key]
                ):
                    continue
                if not self._same_registry_value(
                    current, registry_before[spec.key]
                ):
                    raise OfficeIntegrationError("repair_failed")

                attempted_deletions.append(spec)
                self._registry_delete(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
                verified = self._registry_query(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
                if verified is not _MISSING:
                    raise OfficeIntegrationError("repair_failed")
                deleted_specs.append(spec)

            setup_result = dict(self._setup_locked(secret, app_keys))
        except Exception as exc:
            registry_restored = self._restore_repaired_registry_values(
                registry_before, attempted_deletions
            )
            nested_rollback_failed = (
                isinstance(exc, OfficeIntegrationError)
                and exc.code.endswith("_rollback_failed")
            )
            if not registry_restored or nested_rollback_failed:
                raise OfficeIntegrationError("repair_rollback_failed") from exc
            raise OfficeIntegrationError("repair_failed") from exc

        setup_result["changed"] = bool(deleted_specs) or setup_result["changed"]
        setup_result["repaired_apps"] = [spec.key for spec in deleted_specs]
        return setup_result

    def remove(self) -> dict[str, Any]:
        """在共享互斥锁内移除受管 Office 加载项。"""
        with self._mutation_lock:
            return self._remove_locked()

    def _remove_locked(self) -> dict[str, Any]:
        """删除自身持有的注册值和清单，失败时恢复操作前快照。"""
        registry_before = {}
        files_before = {}
        for spec in _APP_SPECS:
            if self._is_windows():
                registry_before[spec.key] = self._registry_query(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
            else:
                registry_before[spec.key] = _MISSING
            try:
                files_before[spec.key] = self._file_snapshot(
                    self.manifest_paths[spec.key]
                )
            except OSError as exc:
                raise OfficeIntegrationError("remove_failed") from exc

        files_to_remove: list[_AppSpec] = []
        registry_to_remove: list[_AppSpec] = []
        if self._is_windows():
            # Recheck every potentially-owned value before any mutation. This
            # avoids deleting a file after another in-process operation changed
            # its developer override between snapshot and removal.
            for spec in _APP_SPECS:
                previous = registry_before[spec.key]
                if previous is not _MISSING and not self._same_path(
                    previous, self.manifest_paths[spec.key]
                ):
                    continue
                current = self._registry_query(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
                if current is _MISSING:
                    files_to_remove.append(spec)
                elif self._same_path(current, self.manifest_paths[spec.key]):
                    registry_to_remove.append(spec)
                    files_to_remove.append(spec)
        else:
            files_to_remove.extend(_APP_SPECS)

        changed = False
        output_dir_existed = self.output_dir.exists()
        attempted_registry: list[_AppSpec] = []
        expected_registry: dict[str, Any] = {}
        blocked_files: set[str] = set()
        attempted_files: list[_AppSpec] = []
        expected_files: dict[str, Any] = {}
        try:
            for spec in registry_to_remove:
                current = self._registry_query(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
                if current is _MISSING:
                    continue
                if not self._same_path(
                    current, self.manifest_paths[spec.key]
                ):
                    blocked_files.add(spec.key)
                    continue
                attempted_registry.append(spec)
                expected_registry[spec.key] = _MISSING
                self._registry_delete(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
                changed = True
                verified = self._registry_query(
                    _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                )
                if verified is not _MISSING:
                    blocked_files.add(spec.key)
            for spec in files_to_remove:
                if (
                    files_before[spec.key] is _MISSING
                    or spec.key in blocked_files
                ):
                    continue
                if self._is_windows():
                    current = self._registry_query(
                        _HKCU, DEVELOPER_REGISTRY_PATH, spec.manifest_id
                    )
                    if current is not _MISSING:
                        blocked_files.add(spec.key)
                        continue
                attempted_files.append(spec)
                expected_files[spec.key] = _MISSING
                self.manifest_paths[spec.key].unlink()
                changed = True
            try:
                self.output_dir.rmdir()
            except OSError:
                pass
            current_status = self.status()
        except Exception as exc:
            files_restored = self._restore_file_snapshot(
                files_before,
                attempted_files,
                expected_files,
                output_dir_existed,
            )
            registry_restored = self._restore_registry_snapshot(
                registry_before, attempted_registry, expected_registry
            )
            if not registry_restored or not files_restored:
                raise OfficeIntegrationError("remove_rollback_failed") from exc
            if isinstance(exc, OfficeIntegrationError):
                raise
            raise OfficeIntegrationError("remove_failed") from exc

        return {
            "changed": changed,
            "restart_required": current_status["office"]["running"],
            "status": current_status,
        }


__all__ = [
    "CLICK_TO_RUN_REGISTRY_PATH",
    "CLICK_TO_RUN_WOW64_REGISTRY_PATH",
    "DEVELOPER_REGISTRY_PATH",
    "EXCEL_MANIFEST_ID",
    "EXCEL_STORE_ID",
    "OFFICE_CLICK_TO_RUN_REGISTRY_PATH",
    "OFFICE_DEVELOPER_REGISTRY_PATH",
    "OfficeIntegration",
    "OfficeIntegrationError",
    "OfficeIntegrationException",
    "POWERPOINT_MANIFEST_ID",
    "POWERPOINT_STORE_ID",
    "WORD_MANIFEST_ID",
    "WORD_STORE_ID",
    "WinRegistryAdapter",
]
