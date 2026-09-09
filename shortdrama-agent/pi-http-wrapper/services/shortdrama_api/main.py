import logging
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from .config import settings
from .routers import agent

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger("shortdrama_api")

app = FastAPI(title="Shortdrama Agent API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    open_paths = {"/health", "/docs", "/openapi.json", "/redoc"}
    if request.url.path in open_paths:
        return await call_next(request)
    # HTTP_API_KEY 启动时已强制非空（见 config.py feel-fast 检查），这里恒校验。
    provided = request.headers.get("X-API-Key", "")
    if provided != settings.HTTP_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return await call_next(request)

app.include_router(agent.router, prefix="/api/agent", tags=["Agent对话"])

@app.get("/health")
async def health():
    return {"status": "ok", "agent_url": settings.PI_AGENT_URL}
