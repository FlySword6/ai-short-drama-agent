import base64
import json
import mimetypes
import os
import re
from pathlib import Path
from posixpath import normpath
from typing import Any
from urllib.parse import unquote
from uuid import uuid4

import requests
import yaml
from veadk.auth.veauth.utils import get_credential_from_vefaas_iam
from veadk.knowledgebase.backends.vikingdb_knowledge_backend import (
    VikingDBKnowledgeBackend,
)
from veadk.knowledgebase.entry import KnowledgebaseEntry
from veadk.knowledgebase.knowledgebase import KnowledgeBase
from veadk.tools.builtin_tools.load_knowledgebase import (
    LoadKnowledgebaseResponse,
    LoadKnowledgebaseTool,
)
from veadk.utils.logger import get_logger
from volcengine.auth.SignerV4 import SignerV4
from volcengine.base.Request import Request
from volcengine.Credentials import Credentials

from short_drama_agent.config import (
    IMAGE_EXT_TO_MIME,
    IMAGE_URL_FIELDS,
    KNOWLEDGEBASE_API_BASE_URL,
    KNOWLEDGEBASE_API_DOMAIN,
    METADATA_PRIORITY_FIELDS,
)

logger = get_logger(__name__)

IMAGE_EXT_TO_MIME_REVERSE = {
    mime_type: ext for ext, mime_type in IMAGE_EXT_TO_MIME.items()
}
IMAGE_EXT_TO_MIME_REVERSE["image/jpeg"] = ".jpg"

ASSET_REFERENCE_QUERY_KEYWORDS = (
    "资产",
    "图片",
    "照片",
    "图像",
    "剧照",
    "海报",
    "立绘",
    "素材",
    "分镜图",
    "场景图",
    "角色图",
    "道具图",
    "视觉参考",
)

GENERIC_METADATA_VALUES = {
    "asset",
    "image",
    "photo",
    "poster",
    "图片",
    "照片",
    "资产",
    "素材",
    "角色资产",
    "场景资产",
    "道具资产",
}

ASSET_INGEST_ROUTING_INSTRUCTION = (
    "\n\n【资产入知识库工具规则】\n"
    "- 当用户要求把本地资产文件、图片、角色图、场景图、道具图、分镜图或其他资产入知识库时，"
    "优先调用 `execute_skills`，让 Skills Sandbox 中的知识入库 skill 编排完成处理。\n"
    "- 调用 skill 时，应明确传递用户提供的文件名/附件名，以及作品、角色、标签、资产类型等 metadata。\n"
    "- 若 `execute_skills` 不可用或无法满足任务，再使用 `mcp_router` 作为外部 MCP 兜底。\n"
    "- 若当前运行时没有可用的入库工具或路由失败，请明确告知用户当前无法执行知识入库，不要编造入库结果。"
)


class ExistingCollectionFriendlyVikingDBKnowledgeBackend(VikingDBKnowledgeBackend):
    """Tolerate VikingDB duplicated-create responses for existing collections."""

    def model_post_init(self, __context):
        if not self.region:
            if self.cloud_provider.lower() == "byteplus":
                self.region = os.getenv("DATABASE_VIKING_REGION", "cn-hongkong")
            else:
                self.region = os.getenv("DATABASE_VIKING_REGION", "cn-beijing")

        if not self.base_url or not self.host:
            if self.cloud_provider.lower() == "byteplus":
                self.host = f"api-knowledgebase.mlp.{self.region}.bytepluses.com"
            else:
                self.host = f"api-knowledgebase.mlp.{self.region}.volces.com"
            self.base_url = f"https://{self.host}"

        self.precheck_index_naming()

        if not self.collection_status()["existed"]:
            try:
                self.create_collection()
            except ValueError as exc:
                if "1000003" not in str(exc):
                    raise


def create_knowledge_base() -> KnowledgeBase:
    return KnowledgeBase(
        backend=ExistingCollectionFriendlyVikingDBKnowledgeBackend(
            index=os.getenv("DATABASE_VIKING_COLLECTION", "role"),
            volcengine_project=os.getenv("DATABASE_VIKING_PROJECT", "shortdrama"),
            region=os.getenv("DATABASE_VIKING_REGION", "cn-beijing"),
        ),
    )


def stringify_metadata_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple, set)):
        return " ".join(str(item) for item in value)
    return str(value)


def is_asset_reference_query(query: str) -> bool:
    query_lower = query.strip().lower()
    return any(keyword.lower() in query_lower for keyword in ASSET_REFERENCE_QUERY_KEYWORDS)


def extract_asset_subject_query(query: str) -> str:
    subject = re.split(
        r"有哪些|有什么|相关|资产|图片|照片|图像|剧照|海报|立绘|素材|请返回|请列出",
        query,
        maxsplit=1,
    )[0]
    subject = re.sub(r"[，。！？?、：:\s]+", " ", subject).strip()
    subject = subject.replace("这部", "").replace("这个", "").replace("的", "")
    return re.sub(r"\s+", " ", subject).strip()


def _is_specific_metadata_value(value: str) -> bool:
    normalized = value.strip().lower()
    return len(normalized) >= 2 and normalized not in GENERIC_METADATA_VALUES


def metadata_match_score(metadata: dict[str, Any] | None, query: str) -> int:
    if not metadata:
        return 0

    query_lower = query.strip().lower()
    if not query_lower:
        return 0

    score = 0
    for field in METADATA_PRIORITY_FIELDS:
        value = stringify_metadata_value(metadata.get(field))
        if not value:
            continue
        value_lower = value.lower()
        if query_lower == value_lower:
            score += 100
        elif query_lower in value_lower:
            score += 40
        elif _is_specific_metadata_value(value) and value_lower in query_lower:
            score += 35

    for key, value in metadata.items():
        if key in METADATA_PRIORITY_FIELDS:
            continue
        value_lower = stringify_metadata_value(value).lower()
        if query_lower and query_lower in value_lower:
            score += 10
        elif _is_specific_metadata_value(value_lower) and value_lower in query_lower:
            score += 8

    return score


def extract_image_urls(metadata: dict[str, Any] | None) -> list[str]:
    if not metadata:
        return []

    urls: list[str] = []
    for field in IMAGE_URL_FIELDS:
        value = metadata.get(field)
        if not value:
            continue
        if isinstance(value, (list, tuple, set)):
            urls.extend(str(item) for item in value if item)
        else:
            urls.append(str(value))

    deduped_urls: list[str] = []
    for url in urls:
        if url not in deduped_urls:
            deduped_urls.append(url)
    return deduped_urls


def build_asset_friendly_entry(entry: KnowledgebaseEntry) -> KnowledgebaseEntry:
    metadata = entry.metadata or {}
    image_urls = extract_image_urls(metadata)

    summary_parts: list[str] = []
    for field in ("character_name", "role_name", "title", "tag", "tags", "alias"):
        value = stringify_metadata_value(metadata.get(field))
        if value:
            summary_parts.append(f"{field}: {value}")

    if image_urls:
        summary_parts.append(
            "image_markdown:\n" + "\n".join(f"![]({url})" for url in image_urls)
        )

    content = entry.content.strip()
    if not content and summary_parts:
        content = " | ".join(summary_parts)
    elif summary_parts:
        content = f"{content}\n" + " | ".join(summary_parts)

    return KnowledgebaseEntry(content=content, metadata=metadata)


def _get_volcengine_credentials() -> tuple[str, str, str]:
    access_key = os.getenv("VOLCENGINE_ACCESS_KEY")
    secret_key = os.getenv("VOLCENGINE_SECRET_KEY")
    session_token = ""
    if access_key and secret_key:
        return access_key, secret_key, session_token

    cred = get_credential_from_vefaas_iam()
    return cred.access_key_id, cred.secret_access_key, cred.session_token


def _prepare_knowledgebase_request(method: str, path: str, data: dict) -> Request:
    access_key, secret_key, session_token = _get_volcengine_credentials()
    request = Request()
    request.set_shema("http")
    request.set_method(method)
    request.set_connection_timeout(10)
    request.set_socket_timeout(30)
    request.set_headers(
        {
            "Accept": "application/json",
            "Content-Type": "application/json; charset=utf-8",
            "Host": KNOWLEDGEBASE_API_DOMAIN,
        }
    )
    request.set_host(KNOWLEDGEBASE_API_DOMAIN)
    request.set_path(path)
    request.set_body(json.dumps(data))
    SignerV4.sign(
        request,
        Credentials(access_key, secret_key, "air", "cn-north-1", session_token),
    )
    return request


def _parse_metadata(metadata: dict[str, Any] | str | None) -> dict[str, str]:
    if not metadata:
        return {}
    if isinstance(metadata, str):
        metadata = json.loads(metadata)
    if not isinstance(metadata, dict):
        raise ValueError("metadata must be a JSON object or dict")
    return {
        str(key): stringify_metadata_value(value) for key, value in metadata.items()
    }


def _resolve_agentkit_account_id() -> str:
    for env_name in ("AGENTKIT_ACCOUNT_ID", "VOLCENGINE_ACCOUNT_ID", "ACCOUNT_ID"):
        value = os.getenv(env_name, "").strip()
        if value:
            return value

    try:
        from veadk.tools.builtin_tools._agentkit import get_agentkit_account_id

        return str(get_agentkit_account_id({}) or "").strip()
    except Exception as exc:
        logger.warning(f"Unable to resolve AgentKit account id for TOS bucket: {exc}")
        return ""


def _render_agentkit_template(value: str) -> str:
    account_id = _resolve_agentkit_account_id()
    if account_id:
        value = value.replace("{{account_id}}", account_id)
    return value.strip()


def _load_agentkit_yaml_tos_config() -> dict[str, str]:
    config_path = Path("agentkit.yaml")
    if not config_path.is_file():
        return {}

    try:
        data = yaml.safe_load(config_path.read_text()) or {}
    except Exception as exc:
        logger.warning(f"Unable to read agentkit.yaml TOS config: {exc}")
        return {}

    launch_type = (
        data.get("common", {}).get("launch_type")
        or os.getenv("AGENTKIT_LAUNCH_TYPE")
        or "cloud"
    )
    launch_config = data.get("launch_types", {}).get(launch_type, {}) or {}
    return {
        key: _render_agentkit_template(str(launch_config.get(key) or ""))
        for key in ("tos_bucket", "tos_prefix", "tos_region")
        if launch_config.get(key)
    }


def _resolve_tos_bucket(explicit_bucket: str | None = None) -> str:
    agentkit_tos_config = _load_agentkit_yaml_tos_config()
    bucket = (
        explicit_bucket
        or os.getenv("KNOWLEDGE_ASSET_TOS_BUCKET")
        or os.getenv("DATABASE_TOS_BUCKET")
        or os.getenv("TOS_BUCKET")
        or os.getenv("TOS_BUCKET_NAME")
        or os.getenv("VEADK_TOS_BUCKET")
        or agentkit_tos_config.get("tos_bucket")
    )
    if bucket and "{{account_id}}" in bucket:
        account_id = _resolve_agentkit_account_id()
        if account_id:
            bucket = bucket.replace("{{account_id}}", account_id)

    if not bucket:
        account_id = _resolve_agentkit_account_id()
        if account_id:
            bucket = f"agentkit-platform-{account_id}"

    if not bucket:
        raise ValueError(
            "Missing TOS bucket. Set KNOWLEDGE_ASSET_TOS_BUCKET, "
            "DATABASE_TOS_BUCKET, TOS_BUCKET_NAME, or configure "
            "launch_types.<launch_type>.tos_bucket in agentkit.yaml."
        )
    return bucket


def _resolve_tos_prefix(explicit_prefix: str | None = None) -> str:
    agentkit_tos_config = _load_agentkit_yaml_tos_config()
    return (
        explicit_prefix
        or os.getenv("KNOWLEDGE_ASSET_TOS_PREFIX")
        or os.getenv("DATABASE_TOS_PREFIX")
        or os.getenv("TOS_PREFIX")
        or agentkit_tos_config.get("tos_prefix")
        or "knowledgebase/assets"
    ).strip("/")


def _sanitize_tos_object_key(value: str) -> str:
    key = re.sub(r"[^A-Za-z0-9._/\-=]+", "-", value.strip().replace("\\", "/"))
    key = normpath(key).lstrip("/")
    if key in ("", ".") or key.startswith("../") or "/../" in key:
        raise ValueError("Invalid TOS object key")
    return key


def _build_asset_object_key(file_name: str, prefix: str, object_key: str | None) -> str:
    if object_key:
        return _sanitize_tos_object_key(object_key)
    safe_name = _sanitize_tos_object_key(Path(file_name).name)
    unique_name = f"{uuid4().hex}-{safe_name}"
    return _sanitize_tos_object_key(
        f"{prefix}/{unique_name}" if prefix else unique_name
    )


def _build_public_tos_url(bucket: str, key: str, region: str) -> str:
    provider = (os.getenv("CLOUD_PROVIDER") or "").lower()
    sld = "bytepluses" if provider == "byteplus" else "volces"
    return f"https://{bucket}.tos-{region}.{sld}.com/{key}"


def _resolve_tos_region() -> str:
    agentkit_tos_config = _load_agentkit_yaml_tos_config()
    return (
        os.getenv("KNOWLEDGE_ASSET_TOS_REGION")
        or os.getenv("DATABASE_TOS_REGION")
        or os.getenv("TOS_REGION")
        or os.getenv("REGION")
        or os.getenv("DATABASE_VIKING_REGION")
        or agentkit_tos_config.get("tos_region")
        or "cn-beijing"
    )


def _create_tos_client():
    access_key, secret_key, session_token = _get_volcengine_credentials()
    region = _resolve_tos_region()
    try:
        import tos
    except ImportError as exc:
        raise ImportError(
            "Missing 'tos' module. Please install the tos package."
        ) from exc

    provider = (os.getenv("CLOUD_PROVIDER") or "").lower()
    sld = "bytepluses" if provider == "byteplus" else "volces"
    return tos.TosClientV2(
        ak=access_key,
        sk=secret_key,
        security_token=session_token,
        endpoint=f"tos-{region}.{sld}.com",
        region=region,
    )


def upload_asset_bytes_to_tos(
    *,
    file_name: str,
    content: bytes,
    content_type: str | None = None,
    tos_bucket: str | None = None,
    tos_prefix: str | None = None,
    tos_object_key: str | None = None,
    metadata: dict[str, Any] | str | None = None,
) -> dict[str, str]:
    """Upload asset bytes to TOS and return addresses usable by KB ingest."""
    bucket = _resolve_tos_bucket(tos_bucket)
    region = _resolve_tos_region()
    object_key = _build_asset_object_key(
        file_name, _resolve_tos_prefix(tos_prefix), tos_object_key
    )
    resolved_content_type = (
        content_type or mimetypes.guess_type(file_name)[0] or "application/octet-stream"
    )

    client = _create_tos_client()
    try:
        # TOS object metadata lets the knowledge service carry asset labels
        # without adding a second metadata side channel to the doc/add call.
        client.put_object(
            bucket=bucket,
            key=object_key,
            content=content,
            content_type=resolved_content_type,
            meta=_parse_metadata(metadata),
        )
    finally:
        client.close()

    tos_path = f"{bucket}/{object_key}"
    return {
        "bucket": bucket,
        "object_key": object_key,
        "tos_path": tos_path,
        "tos_url": f"tos://{tos_path}",
        "public_url": _build_public_tos_url(bucket, object_key, region),
        "content_type": resolved_content_type,
    }


def upload_asset_file_to_tos(
    file_path: str,
    *,
    tos_bucket: str | None = None,
    tos_prefix: str | None = None,
    tos_object_key: str | None = None,
    metadata: dict[str, Any] | str | None = None,
) -> dict[str, str]:
    """Upload an asset file to TOS and return addresses usable by KB ingest."""
    path = Path(file_path).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"Asset file does not exist: {file_path}")

    return upload_asset_bytes_to_tos(
        file_name=path.name,
        content=path.read_bytes(),
        content_type=mimetypes.guess_type(path.name)[0],
        tos_bucket=tos_bucket,
        tos_prefix=tos_prefix,
        tos_object_key=tos_object_key,
        metadata=metadata,
    )


def _bytes_from_artifact_part(part: Any) -> tuple[bytes, str | None]:
    inline_data = getattr(part, "inline_data", None)
    if inline_data:
        data = inline_data.data
        if isinstance(data, str):
            data = base64.b64decode(data)
        return data, inline_data.mime_type

    text = getattr(part, "text", None)
    if text is not None:
        return text.encode("utf-8"), "text/plain"

    raise ValueError("Matched artifact has no inline_data or text content.")


def _artifact_lookup_key(value: str) -> str:
    name = unquote(Path(value.strip()).name)
    return re.sub(r"[\s_\-./]+", "", name).lower()


def _artifact_match_score(artifact_name: str, requested: str) -> int:
    requested_name = Path(requested).name
    artifact_basename = Path(artifact_name).name
    if artifact_name == requested:
        return 100
    if artifact_basename == requested_name:
        return 90

    requested_key = _artifact_lookup_key(requested_name)
    artifact_key = _artifact_lookup_key(artifact_basename)
    if not requested_key or not artifact_key:
        return 0
    if artifact_key == requested_key:
        return 80

    requested_stem = _artifact_lookup_key(Path(requested_name).stem)
    artifact_stem = _artifact_lookup_key(Path(artifact_basename).stem)
    if requested_stem and requested_stem in artifact_stem:
        return 60
    if artifact_stem and artifact_stem in requested_stem:
        return 50
    return 0


def _artifact_part_file_name(part: Any) -> str:
    inline_data = getattr(part, "inline_data", None)
    if inline_data and getattr(inline_data, "display_name", None):
        return str(inline_data.display_name)

    file_data = getattr(part, "file_data", None) or getattr(part, "fileData", None)
    if file_data and getattr(file_data, "file_uri", None):
        return str(file_data.file_uri)

    return ""


def _guess_extension_from_content_type(content_type: str | None) -> str:
    """Map artifact MIME types to stable upload filename extensions."""
    if not content_type:
        return ""

    normalized = content_type.split(";", 1)[0].strip().lower()
    guessed = IMAGE_EXT_TO_MIME_REVERSE.get(normalized) or mimetypes.guess_extension(
        normalized, strict=False
    )
    if guessed == ".jpe":
        return ".jpg"
    return guessed or ""


def _resolve_artifact_upload_name(
    requested: str, artifact_name: str, part: Any, content_type: str | None
) -> str:
    """Prefer user-visible artifact names and ensure uploads keep a suffix."""
    requested_name = Path(requested).name
    part_name = Path(_artifact_part_file_name(part)).name
    artifact_basename = Path(artifact_name).name

    upload_name = requested_name or part_name or artifact_basename or "asset"
    if Path(upload_name).suffix:
        return upload_name

    if part_name and Path(part_name).suffix:
        return part_name

    extension = _guess_extension_from_content_type(content_type)
    if extension:
        return f"{upload_name}{extension}"
    return upload_name


async def _list_artifact_names(tool_context: Any | None) -> list[str]:
    if tool_context is None:
        return []

    try:
        return await tool_context.list_artifacts()
    except Exception as exc:
        logger.warning(f"Unable to list ADK artifacts for asset ingest: {exc}")
        return []


async def _load_asset_from_artifacts(
    file_path: str,
    tool_context: Any | None,
    artifact_names: list[str] | None = None,
) -> dict[str, Any] | None:
    if tool_context is None:
        return None
    if not hasattr(tool_context, "load_artifact"):
        return None

    if artifact_names is None:
        artifact_names = await _list_artifact_names(tool_context)

    requested = file_path.strip()
    scored_candidates = [
        (_artifact_match_score(name, requested), name) for name in artifact_names
    ]
    candidates = [
        name
        for score, name in sorted(
            scored_candidates, key=lambda item: item[0], reverse=True
        )
        if score > 0
    ]
    matched_part = None
    if not candidates and len(artifact_names) == 1:
        candidates = artifact_names
    elif not candidates:
        best_score = 0
        best_artifact_name = ""
        for artifact_name in artifact_names:
            part = await tool_context.load_artifact(artifact_name)
            if part is None:
                continue
            score = _artifact_match_score(_artifact_part_file_name(part), requested)
            if score > best_score:
                best_score = score
                best_artifact_name = artifact_name
                matched_part = part
        if best_artifact_name:
            candidates = [best_artifact_name]

    if not candidates:
        return None

    artifact_name = candidates[0]
    part = matched_part or await tool_context.load_artifact(artifact_name)
    if part is None:
        return None

    content, content_type = _bytes_from_artifact_part(part)
    upload_name = _resolve_artifact_upload_name(
        requested, artifact_name, part, content_type
    )
    return {
        "file_name": upload_name,
        "artifact_name": artifact_name,
        "content": content,
        "content_type": content_type,
    }


def _parse_knowledgebase_response(response: requests.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError:
        payload = {"raw_text": response.text}

    if response.ok:
        return payload

    return {
        "code": payload.get("code", -1) if isinstance(payload, dict) else -1,
        "message": payload.get("message", "") if isinstance(payload, dict) else "",
        "http_status": response.status_code,
        "http_reason": response.reason,
        "response": payload,
    }


def add_tos_asset_to_knowledgebase(tos_path: str) -> dict[str, Any]:
    request_payload = {
        "collection_name": os.getenv("DATABASE_VIKING_COLLECTION", "role"),
        "project": os.getenv("DATABASE_VIKING_PROJECT", "shortdrama"),
        "add_type": "tos",
        "tos_path": tos_path,
    }
    request = _prepare_knowledgebase_request(
        method="POST",
        path="/api/knowledge/doc/add",
        data=request_payload,
    )
    response = requests.request(
        method=request.method,
        url=f"{KNOWLEDGEBASE_API_BASE_URL}{request.path}",
        headers=request.headers,
        data=request.body,
        timeout=30,
    )
    parsed_response = _parse_knowledgebase_response(response)
    if response.ok:
        return parsed_response

    parsed_response["request_payload"] = request_payload
    return parsed_response


def _knowledgebase_tos_path_candidates(upload_result: dict[str, str]) -> list[str]:
    candidates = [
        upload_result.get("tos_path", ""),
        upload_result.get("tos_url", ""),
        upload_result.get("public_url", ""),
    ]

    deduped_candidates: list[str] = []
    for candidate in candidates:
        if candidate and candidate not in deduped_candidates:
            deduped_candidates.append(candidate)
    return deduped_candidates


def add_uploaded_asset_to_knowledgebase(
    upload_result: dict[str, str],
) -> dict[str, Any]:
    attempts: list[dict[str, Any]] = []
    last_response: dict[str, Any] = {}

    for tos_path in _knowledgebase_tos_path_candidates(upload_result):
        response = add_tos_asset_to_knowledgebase(tos_path)
        if response.get("code") == 0:
            response["used_tos_path"] = tos_path
            if attempts:
                response["attempts"] = attempts
            return response

        attempts.append({"tos_path": tos_path, "response": response})
        last_response = response

    if last_response:
        last_response["attempts"] = attempts
    return last_response or {
        "code": -1,
        "message": "No TOS path candidate is available for knowledgebase ingest.",
    }


async def ingest_asset_to_knowledgebase(
    file_path: str,
    title: str = "",
    metadata: dict[str, Any] | str | None = None,
    tos_bucket: str = "",
    tos_prefix: str = "",
    tos_object_key: str = "",
    tool_context: Any | None = None,
) -> dict[str, Any]:
    """将资产文件入知识库：先上传到 TOS，再用 TOS 地址写入 VikingDB 知识库。

    Args:
        file_path: 本地资产文件路径或 ADK Web 附件/artifact 文件名。
        title: 资产标题，可用于知识库检索展示。
        metadata: 资产元数据，支持 dict 或 JSON 字符串。
        tos_bucket: 可选 TOS bucket；为空时读取环境变量。
        tos_prefix: 可选 TOS 目录前缀；为空时读取环境变量或使用默认前缀。
        tos_object_key: 可选完整 TOS object key；用于需要固定路径的入库。

    Returns:
        包含上传后的 TOS 地址和知识库入库接口返回值。
    """
    asset_metadata = _parse_metadata(metadata)
    if title:
        asset_metadata.setdefault("title", title)

    local_path = Path(file_path).expanduser().resolve()
    source = "local_file"
    file_name = Path(file_path).name
    if local_path.is_file():
        upload_result = upload_asset_file_to_tos(
            str(local_path),
            tos_bucket=tos_bucket or None,
            tos_prefix=tos_prefix or None,
            tos_object_key=tos_object_key or None,
            metadata=asset_metadata,
        )
        file_name = local_path.name
    else:
        available_artifacts = await _list_artifact_names(tool_context)
        artifact_asset = await _load_asset_from_artifacts(
            file_path, tool_context, available_artifacts
        )
        if artifact_asset is None:
            return {
                "success": False,
                "error": (
                    f"Asset file does not exist and no matching ADK artifact "
                    f"was found: {file_path}"
                ),
                "file_path": file_path,
                "available_artifacts": available_artifacts,
                "hint": (
                    "请确认已在 ADK Web 添加附件，或把工具参数 file_path 改成 "
                    "list_artifacts 中存在的附件名。"
                ),
            }
        source = "adk_artifact"
        file_name = artifact_asset["file_name"]
        upload_result = upload_asset_bytes_to_tos(
            file_name=file_name,
            content=artifact_asset["content"],
            content_type=artifact_asset["content_type"],
            tos_bucket=tos_bucket or None,
            tos_prefix=tos_prefix or None,
            tos_object_key=tos_object_key or None,
            metadata=asset_metadata,
        )
        upload_result["artifact_name"] = artifact_asset["artifact_name"]

    kb_response = add_uploaded_asset_to_knowledgebase(upload_result)
    if kb_response.get("code") != 0:
        return {
            "success": False,
            "error": f"Knowledgebase ingest failed: {kb_response}",
            "file_name": file_name,
            "tos": upload_result,
            "knowledgebase": kb_response,
        }

    return {
        "success": True,
        "source": source,
        "file_name": file_name,
        "title": title,
        "tos": upload_result,
        "knowledgebase": kb_response,
    }


def _extract_point_metadata(point: dict[str, Any]) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    doc_info = point.get("doc_info", {}) or {}
    for field in ("doc_name", "title", "chunk_title", "doc_id"):
        if doc_info.get(field):
            metadata[field] = doc_info[field]

    doc_meta_raw_str = doc_info.get("doc_meta")
    doc_meta_list = json.loads(doc_meta_raw_str) if doc_meta_raw_str else []
    for meta in doc_meta_list:
        field_name = meta.get("field_name")
        field_value = meta.get("field_value")
        if field_name and field_value not in (None, ""):
            metadata[field_name] = field_value

    attachments = point.get("chunk_attachment") or []
    image_urls = [
        attachment.get("link") for attachment in attachments if attachment.get("link")
    ]
    if image_urls:
        metadata["image_url"] = image_urls[0]
        metadata["image_urls"] = image_urls

    return metadata


def _build_content_from_search_point(point: dict[str, Any]) -> str:
    doc_info = point.get("doc_info", {}) or {}
    content_parts: list[str] = []
    for field in ("doc_name", "title", "chunk_title"):
        if doc_info.get(field):
            content_parts.append(f"{field}: {doc_info[field]}")
    if point.get("content"):
        content_parts.append(f"content: {point['content']}")
    return "\n".join(content_parts).strip()


def extract_search_query(user_query: str) -> str:
    """Extract core search terms from verbose user questions."""
    stop_patterns = (
        "这部",
        "这个",
        "那个",
        "请问",
        "告诉我",
        "是什么",
        "是谁",
        "有哪些",
        "有多少",
        "怎么样",
        "介绍一下",
        "简单介绍",
        "详细说明",
        "主角是",
        "主角是谁",
        "主要角色",
        "小说",
        "漫剧",
        "作品",
        "漫画",
        "的",
        "吗",
        "呢",
        "啊",
        "吧",
    )
    cleaned = user_query.strip()
    for pattern in stop_patterns:
        cleaned = cleaned.replace(pattern, " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    if len(cleaned) < 2:
        return user_query
    if len(cleaned) >= len(user_query) * 0.7:
        return user_query
    return cleaned


def entry_relevance_score(entry: KnowledgebaseEntry, query: str) -> int:
    """Score explicit entity overlap to suppress unrelated asset recalls."""
    score = metadata_match_score(entry.metadata, query)
    content = (entry.content or "").lower()
    query_lower = query.strip().lower()
    extracted_query = extract_search_query(query).strip().lower()
    asset_subject = extract_asset_subject_query(query).lower()

    if query_lower and query_lower in content:
        score += 20
    if (
        extracted_query
        and extracted_query != query_lower
        and len(extracted_query) >= 2
        and extracted_query in content
    ):
        score += 15
    if asset_subject and len(asset_subject) >= 2 and asset_subject in content:
        score += 25

    return score


def filter_asset_reference_entries(
    entries: list[KnowledgebaseEntry], query: str
) -> list[KnowledgebaseEntry]:
    if not is_asset_reference_query(query):
        return entries
    return [entry for entry in entries if entry_relevance_score(entry, query) > 0]


def _search_knowledge_points(query: str, limit: int = 10) -> list[dict[str, Any]]:
    queries_to_try = [query]
    extracted = extract_search_query(query)
    if extracted and extracted != query:
        queries_to_try.insert(0, extracted)

    all_results: dict[str, Any] = {}
    seen_keys: set[str] = set()

    for q in queries_to_try:
        request = _prepare_knowledgebase_request(
            method="POST",
            path="/api/knowledge/collection/search_knowledge",
            data={
                "project": os.getenv("DATABASE_VIKING_PROJECT", "shortdrama"),
                "name": os.getenv("DATABASE_VIKING_COLLECTION", "role"),
                "query": q,
                "limit": limit,
                "post_processing": {
                    "get_attachment_link": True,
                    "rerank_only_chunk": False,
                    "rerank_switch": True,
                    "chunk_group": True,
                    "chunk_diffusion_count": 3,
                },
            },
        )
        response = requests.request(
            method=request.method,
            url=f"{KNOWLEDGEBASE_API_BASE_URL}{request.path}",
            headers=request.headers,
            data=request.body,
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("code") != 0:
            logger.warning(f"KB search failed for q={q}: {payload.get('message')}")
            continue
        for point in payload.get("data", {}).get("result_list", []):
            doc_info = point.get("doc_info", {}) or {}
            dedup_key = (
                f"{doc_info.get('doc_id', '')}|{doc_info.get('chunk_title', '')}"
            )
            if dedup_key not in seen_keys:
                seen_keys.add(dedup_key)
                all_results[dedup_key] = point

    return list(all_results.values())


def search_knowledge_entries(query: str, limit: int = 10) -> list[KnowledgebaseEntry]:
    points = _search_knowledge_points(query=query, limit=limit)
    entries: list[KnowledgebaseEntry] = []
    for point in points:
        entries.append(
            KnowledgebaseEntry(
                content=_build_content_from_search_point(point),
                metadata=_extract_point_metadata(point),
            )
        )
    return entries


def guess_image_mime_type(url: str) -> str:
    lower_url = url.lower()
    for ext, mime_type in IMAGE_EXT_TO_MIME.items():
        if ext in lower_url:
            return mime_type
    return "image/jpeg"


def markdownify_image_urls(text: str, image_urls: list[str]) -> str:
    """Convert bare image URLs in model output to markdown image syntax."""
    if not text or not image_urls:
        return text
    for url in image_urls:
        if not url or url not in text:
            continue
        pattern = r"(?<!\]\()(?<!\!\[)" + re.escape(url)
        text = re.sub(pattern, f"![]({url})", text)
    return text


def build_reference_text(entries: list[KnowledgebaseEntry]) -> str:
    lines: list[str] = []
    for idx, entry in enumerate(entries, start=1):
        content = (entry.content or "").strip()
        if content:
            lines.append(f"{idx}. {content}")
    if not lines:
        return ""
    return (
        "以下是知识库中命中的角色/标签相关参考资料，请优先结合这些资料回答：\n"
        + "\n".join(lines)
    )


class AssetMetadataFirstLoadKnowledgebaseTool(LoadKnowledgebaseTool):
    """Prefer metadata matches and surface image URLs for asset-oriented Q&A."""

    def __init__(self, knowledgebase: KnowledgeBase):
        super().__init__(knowledgebase=knowledgebase)
        if not self.custom_metadata:
            self.custom_metadata = {}
        self.custom_metadata["backend"] = "viking"

    async def load_knowledgebase(
        self, query: str, tool_context
    ) -> LoadKnowledgebaseResponse:
        logger.info(f"Search knowledgebase with metadata-first strategy: {query}")
        response = search_knowledge_entries(query, limit=20)

        ranked_entries = sorted(
            filter_asset_reference_entries(response, query),
            key=lambda entry: (
                entry_relevance_score(entry, query),
                1 if extract_image_urls(entry.metadata) else 0,
                1 if (entry.content or "").strip() else 0,
            ),
            reverse=True,
        )

        normalized_entries = [
            build_asset_friendly_entry(entry) for entry in ranked_entries[:10]
        ]
        logger.info(
            f"Loaded {len(normalized_entries)} metadata-first knowledge entries for query: {query}"
        )
        return LoadKnowledgebaseResponse(knowledges=normalized_entries)
