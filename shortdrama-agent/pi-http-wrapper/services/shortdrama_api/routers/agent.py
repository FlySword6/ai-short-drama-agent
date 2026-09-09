import os
import json
import uuid
from fastapi import APIRouter, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from ..agent_runner import call_agent, call_agent_stream
from ..config import settings

router = APIRouter()

class AgentRequest(BaseModel):
    message: str
    project_id: str | None = None
    scene_id: str | None = None
    extra: dict | None = None

@router.post("/chat")
async def agent_chat(body: AgentRequest):
    context = {}
    if body.project_id:
        context["project_id"] = body.project_id
    if body.scene_id:
        context["scene_id"] = body.scene_id
    if body.extra:
        context.update(body.extra)
    return await call_agent(body.message, context=context)

@router.post("/chat/stream")
async def agent_chat_stream(body: AgentRequest):
    context = {}
    if body.project_id:
        context["project_id"] = body.project_id
    if body.scene_id:
        context["scene_id"] = body.scene_id
    if body.extra:
        context.update(body.extra)
    async def generate():
        try:
            async for chunk in call_agent_stream(body.message, context=context):
                yield f"data: {chunk}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'status': 'failed', 'error': str(e)})}\n\n"
    return StreamingResponse(generate(), media_type="text/event-stream")

@router.post("/chat/script")
async def agent_chat_with_script(
    message: str = Form("请导入并拆解以下剧本"),
    project_id: str = Form(...),
    file: UploadFile = File(...),
):
    content = await file.read()
    # 文件名安全化：用 uuid 重命名，避免 ../ 路径穿越逃出 RUNS_DIR
    safe_name = f"upload_{uuid.uuid4().hex}{os.path.splitext(file.filename or '')[1]}"
    tmp_path = os.path.join(settings.RUNS_DIR, safe_name)
    with open(tmp_path, "wb") as f:
        f.write(content)
    full_message = f"{message}\n\n--- 剧本内容 ---\n剧本文件已保存到：{tmp_path}\n文件名：{safe_name}\n项目 ID：{project_id}\n请使用 shortdrama-cli 的 script analyze 命令导入并拆解这个剧本。"
    result = await call_agent(full_message, context={"project_id": project_id, "script_file": tmp_path})
    try:
        os.remove(tmp_path)
    except OSError:
        pass
    return result

class TaskQueryRequest(BaseModel):
    task_id: str
    wait: bool = False

@router.post("/task")
async def agent_query_task(body: TaskQueryRequest):
    message = f"查询任务 {body.task_id} 的状态"
    if body.wait:
        message += "，请等待任务完成"
    return await call_agent(message, context={"task_id": body.task_id})
