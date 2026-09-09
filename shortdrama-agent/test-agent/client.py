import asyncio
from pathlib import Path
import uuid

import httpx
import requests
from google.adk.cli.adk_web_server import CreateSessionRequest, RunAgentRequest
from google.genai.types import Content, Part
import yaml


def load_runtime_config():
    config_path = Path(__file__).with_name("agentkit.yaml")
    if not config_path.exists():
        return None, None

    with config_path.open("r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}

    cloud_config = config.get("launch_types", {}).get("cloud", {})
    return cloud_config.get("runtime_endpoint"), cloud_config.get("runtime_apikey")

if __name__ == "__main__":
    # Step 0: setup running configs
    app_name = "short_drama_asset_agent"
    user_id = "agentkit_user"
    session_id = f"agentkit_session_{uuid.uuid4().hex[:8]}"
    runtime_endpoint, runtime_apikey = load_runtime_config()
    base_url = runtime_endpoint or "http://127.0.0.1:8000"
    api_key = runtime_apikey or "agentkit test key"

    # Step 1: create a session
    def create_session():
        create_session_request = CreateSessionRequest(
            session_id=session_id,
        )

        response = requests.post(
            url=f"{base_url}/apps/{app_name}/users/{user_id}/sessions/{create_session_request.session_id}",
            headers={"Authorization": f"Bearer {api_key}"},
            json=create_session_request.model_dump(exclude_none=True),
        )
        if response.status_code == 409:
            print(
                f"[create session] Session already exists, reuse: {create_session_request.session_id}"
            )
            return create_session_request.session_id

        response.raise_for_status()
        try:
            payload = response.json()
        except requests.exceptions.JSONDecodeError:
            payload = response.text
        print(f"[create session] Response from server: {payload}")

        return create_session_request.session_id

    # Step 2: run agent with SSE

    print("[run agent] Event from server:")

    # 3. Handle streaming events
    async def send_request(message: str):
        run_agent_request = RunAgentRequest(
            app_name=app_name,
            user_id=user_id,
            session_id=create_session(),
            new_message=Content(parts=[Part(text=message)], role="user"),
            streaming=True,
        )

        with httpx.stream(
            "POST",
            f"{base_url}/run_sse",
            json=run_agent_request.model_dump(exclude_none=True),
            timeout=120,
            headers={"Authorization": f"Bearer {api_key}"},
        ) as r:
            for line in r.iter_lines():
                print(line)

    async def send_request_parallel():
        await send_request("叶逍遥有哪些相关照片？请返回图片URL")

    asyncio.run(send_request_parallel())
