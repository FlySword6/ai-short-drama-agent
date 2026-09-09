import os

class Settings:
    PI_AGENT_URL = os.getenv("PI_AGENT_URL", "http://127.0.0.1:8080")
    PI_AGENT_API_KEY = os.getenv("PI_AGENT_API_KEY", "")
    HOST = os.getenv("API_HOST", "127.0.0.1")
    PORT = int(os.getenv("API_PORT", "8000"))
    RUNS_DIR = os.getenv("RUNS_DIR", "/opt/shortdrama/runs")
    CORS_ORIGINS = [o for o in os.getenv("CORS_ORIGINS", "").split(",") if o]
    HTTP_API_KEY = os.getenv("HTTP_API_KEY", "")
    AGENT_TIMEOUT = int(os.getenv("AGENT_TIMEOUT", "60"))

    @property
    def cors_allow_origins(self):
        """CORS 允许来源：仅在显式配置时开放，绝不 fallback 到 *（带 credentials 会沦为安全反模式）。"""
        return self.CORS_ORIGINS  # 未配置时为空列表，等同不开放跨域

settings = Settings()

# fail-fast：无 HTTP_API_KEY 时拒绝启动，杜绝鉴权被静默关闭。
if not settings.HTTP_API_KEY:
    raise RuntimeError(
        "HTTP_API_KEY is required. Set it in environment before starting "
        "shortdrama-api; refusing to run without authentication."
    )
