"""Office Gateway 入口：创建 FastAPI 应用、挂载路由、托管前端、首次启动 seed 配置。"""
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.datastructures import MutableHeaders

from app import db
from app.config import STATIC_DIR
from app.routes.proxy import router as proxy_router
from app.routes.admin import router as admin_router
from app.routes.office import router as office_router

DEFAULT_MAPPINGS = [
    ("claude-sonnet-4-5-20250929", "deepseek-chat"),
    ("claude-opus-4-5-20250929", "deepseek-reasoner"),
    ("claude-haiku-4-5-20251001", "deepseek-chat"),
]


class _StableVaryCORSMiddleware(CORSMiddleware):
    """Avoid duplicating Origin when an endpoint already declares it in Vary."""

    @staticmethod
    def allow_explicit_origin(headers: MutableHeaders, origin: str) -> None:
        """写入显式跨域源，并确保 Vary 仅包含一个 Origin。"""
        headers["Access-Control-Allow-Origin"] = origin
        vary_values = {
            value.strip().lower()
            for value in headers.get("Vary", "").split(",")
            if value.strip()
        }
        if "origin" not in vary_values:
            headers.add_vary_header("Origin")


def _seed_defaults() -> None:
    """首次启动时写入默认 DeepSeek 提供商与三条模型映射。已禁用,不再自动写入。"""
    return


def create_app() -> FastAPI:
    """初始化数据库、路由和静态资源并创建 FastAPI 应用。"""
    db.init_db()
    db._migrate_total_input_tokens()
    _seed_defaults()

    if not db.has_gateway_token():
        print("=" * 60, flush=True)
        print("  [首次启动] GATEWAY_TOKEN 未配置。", flush=True)
        print("  请访问管理面板 → 系统设置 完成配置。", flush=True)
        print("=" * 60, flush=True)

    app = FastAPI(title="Office Gateway")
    app.add_middleware(
        _StableVaryCORSMiddleware,
        allow_origins=["https://pivot.claude.ai", "http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(proxy_router)
    app.include_router(admin_router)
    app.include_router(office_router)

    @app.get("/health")
    async def health():
        """返回网关存活状态和版本。"""
        return {"ok": True, "version": "1.1.0"}

    if STATIC_DIR.exists():
        assets = STATIC_DIR / "assets"
        if assets.exists():
            app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

        @app.get("/")
        async def spa_root():
            """返回管理端单页应用入口。"""
            return FileResponse(str(STATIC_DIR / "index.html"))

        @app.get("/{full_path:path}")
        async def spa_fallback(full_path: str):
            """优先返回静态文件，否则回退到单页应用入口。"""
            candidate = STATIC_DIR / full_path
            if candidate.is_file():
                return FileResponse(str(candidate))
            return FileResponse(str(STATIC_DIR / "index.html"))
    else:
        @app.get("/")
        async def root_only():
            """在前端尚未构建时返回基础服务状态。"""
            return {"ok": True, "message": "Frontend not built. Visit /admin for API."}

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "4000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
