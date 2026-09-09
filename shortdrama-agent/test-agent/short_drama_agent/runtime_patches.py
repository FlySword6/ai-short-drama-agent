import inspect
import json
from functools import wraps
from typing import Any

import veadk.runner as veadk_runner
from google.genai import types
from veadk.utils.logger import get_logger

logger = get_logger(__name__)


def _merge_agent_output_text_parts(parts: list[Any], *, structured_output: bool) -> str:
    """Merge ADK text Parts without corrupting structured JSON payloads."""
    text_parts = [
        part.text
        for part in (parts or [])
        if getattr(part, "text", None) and not getattr(part, "thought", False)
    ]
    if structured_output:
        return _extract_first_json_value("".join(text_parts))
    return "\n".join(text_parts)


def _safe_validate_agent_tool_output(output_schema: Any, json_text: str) -> Any:
    """Validate structured AgentTool output without crashing the parent ADK stream."""
    import google.adk.tools.agent_tool as _adk_agent_tool

    try:
        return _adk_agent_tool.validate_schema(output_schema, json_text)
    except Exception as exc:
        preview = (json_text or "").strip()
        if len(preview) > 1000:
            preview = f"{preview[:1000]}..."
        logger.warning(
            "Structured AgentTool output failed schema validation; returning "
            f"a tool error instead of raising: {exc}"
        )
        return {
            "error": "structured_output_validation_failed",
            "message": (
                "子任务输出不是完整有效 JSON，可能是模型输出被截断。"
                "请缩短输入、拆分剧本，或改用 execute_skills / MCP 入库流程重试。"
            ),
            "detail": str(exc),
            "raw_output_preview": preview,
        }


def _extract_first_json_value(text: str) -> str:
    """Return the first complete JSON value, ignoring trailing streamed fragments."""
    candidate = (text or "").strip()
    if not candidate:
        return candidate

    try:
        json.loads(candidate)
        return candidate
    except json.JSONDecodeError:
        pass

    start = -1
    for marker in ("{", "["):
        marker_index = candidate.find(marker)
        if marker_index != -1 and (start == -1 or marker_index < start):
            start = marker_index
    if start == -1:
        return candidate

    stack: list[str] = []
    in_string = False
    escape = False
    pairs = {"{": "}", "[": "]"}

    for index in range(start, len(candidate)):
        char = candidate[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
            continue

        if char in pairs:
            stack.append(pairs[char])
            continue

        if char in ("}", "]"):
            if not stack or char != stack.pop():
                return candidate
            if not stack:
                extracted = candidate[start : index + 1]
                try:
                    json.loads(extracted)
                    if candidate[index + 1 :].strip():
                        logger.warning(
                            "Structured AgentTool output contained trailing "
                            "characters; using the first complete JSON value."
                        )
                    return extracted
                except json.JSONDecodeError:
                    return candidate

    return candidate


def downgrade_json_schema_response_format(
    messages: list[dict[str, Any]],
    response_format: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Downgrade ADK json_schema output to JSON object mode for Ark models."""
    if not response_format or response_format.get("type") != "json_schema":
        return response_format

    schema_payload = response_format.get("json_schema") or {}
    schema_text = json.dumps(schema_payload, ensure_ascii=False)
    schema_instruction = (
        "当前模型不支持 response_format.type=json_schema。"
        "请严格输出一个合法 JSON object，不要添加 Markdown 或解释文字。"
        f"JSON 结构约束如下：{schema_text}"
    )

    for message in messages:
        if message.get("role") == "system":
            message["content"] = (
                f"{message.get('content') or ''}\n\n{schema_instruction}"
            )
            break
    else:
        messages.insert(0, {"role": "system", "content": schema_instruction})

    logger.info(
        "Downgraded json_schema response_format to json_object for model compatibility."
    )
    return {"type": "json_object"}


def patch_litellm_json_schema_response_format() -> None:
    """Patch LiteLLM client calls so unsupported json_schema never reaches Ark."""
    import google.adk.models.lite_llm as _adk_lite_llm

    if getattr(
        _adk_lite_llm.LiteLLMClient,
        "_agentkit_demo_response_format_patched",
        False,
    ):
        return

    original_acompletion = _adk_lite_llm.LiteLLMClient.acompletion
    original_completion = _adk_lite_llm.LiteLLMClient.completion

    @wraps(original_acompletion)
    async def acompletion_with_response_format_guard(
        self,
        model,
        messages,
        tools,
        **kwargs,
    ):
        kwargs["response_format"] = downgrade_json_schema_response_format(
            messages,
            kwargs.get("response_format"),
        )
        return await original_acompletion(
            self,
            model=model,
            messages=messages,
            tools=tools,
            **kwargs,
        )

    @wraps(original_completion)
    def completion_with_response_format_guard(
        self,
        model,
        messages,
        tools,
        stream=False,
        **kwargs,
    ):
        kwargs["response_format"] = downgrade_json_schema_response_format(
            messages,
            kwargs.get("response_format"),
        )
        return original_completion(
            self,
            model=model,
            messages=messages,
            tools=tools,
            stream=stream,
            **kwargs,
        )

    _adk_lite_llm.LiteLLMClient.acompletion = acompletion_with_response_format_guard
    _adk_lite_llm.LiteLLMClient.completion = completion_with_response_format_guard
    _adk_lite_llm.LiteLLMClient._agentkit_demo_response_format_patched = True
    logger.info("Patched ADK LiteLLMClient to downgrade json_schema response_format.")


def safe_model_json_for_log(
    value: Any,
    *,
    exclude_none: bool = True,
    exclude: Any | None = None,
) -> str:
    """Serialize a debug-log payload without failing on cycles or runtime objects."""

    try:
        return value.model_dump_json(exclude_none=exclude_none, exclude=exclude)
    except Exception as exc:
        logger.warning(f"Debug log serialization failed; using safe fallback: {exc}")
        return json.dumps(
            safe_model_python_for_trace(
                value,
                exclude_none=exclude_none,
                exclude=exclude,
            ),
            ensure_ascii=False,
            default=repr,
        )


def safe_model_python_for_trace(
    value: Any,
    *,
    exclude_none: bool = True,
    exclude: Any | None = None,
    mode: str = "json",
) -> Any:
    """Return a JSON-compatible Python object without failing on cycles."""

    def _json_safe(item, seen: set[int], root: bool = False):
        if item is None or isinstance(item, (str, int, float, bool)):
            return item

        if isinstance(item, bytes):
            return item.decode("utf-8", errors="replace")

        item_id = id(item)
        tracks_identity = isinstance(item, (dict, list, tuple, set)) or hasattr(
            item, "__dict__"
        )
        if tracks_identity:
            if item_id in seen:
                return "[CircularReference]"
            seen.add(item_id)

        try:
            if hasattr(item, "model_dump"):
                try:
                    dumped = item.model_dump(
                        mode=mode,
                        exclude_none=exclude_none,
                        exclude=exclude if root else None,
                    )
                except Exception:
                    dumped = _model_fields_to_dict(item, exclude_none=exclude_none)
                return _json_safe(dumped, seen)

            if isinstance(item, dict):
                return {
                    str(key): _json_safe(child, seen)
                    for key, child in item.items()
                    if not (exclude_none and child is None)
                }

            if isinstance(item, (list, tuple, set)):
                return [
                    _json_safe(child, seen)
                    for child in item
                    if not (exclude_none and child is None)
                ]

            json.dumps(item)
            return item
        except Exception:
            return repr(item)
        finally:
            if tracks_identity:
                seen.discard(item_id)

    return _json_safe(value, set(), root=True)


def _model_fields_to_dict(value: Any, *, exclude_none: bool) -> dict[str, Any]:
    fields = getattr(value.__class__, "model_fields", {})
    if not fields:
        return {
            key: item
            for key, item in getattr(value, "__dict__", {}).items()
            if not (exclude_none and item is None)
        }

    output = {}
    for field_name in fields:
        field_value = getattr(value, field_name, None)
        if exclude_none and field_value is None:
            continue
        output[field_name] = field_value
    return output


def patch_litellm_request_log_safe_serialization() -> None:
    """Keep LiteLLM request debug logging from crashing on cyclic Content."""
    import google.adk.models.lite_llm as _adk_lite_llm

    if getattr(_adk_lite_llm, "_agentkit_demo_request_log_patched", False):
        return

    original_build_function_declaration_log = (
        _adk_lite_llm._build_function_declaration_log
    )

    def build_request_log_with_safe_content(req):
        function_decls = (
            req.config.tools[0].function_declarations if req.config.tools else []
        )
        function_logs = (
            [
                original_build_function_declaration_log(func_decl)
                for func_decl in function_decls
            ]
            if function_decls
            else []
        )
        contents_logs = [
            safe_model_json_for_log(
                content,
                exclude_none=True,
                exclude={
                    "parts": {
                        i: _adk_lite_llm._EXCLUDED_PART_FIELD
                        for i in range(len(content.parts or []))
                    }
                },
            )
            for content in req.contents
        ]

        new_line = getattr(_adk_lite_llm, "_NEW_LINE", "\n")
        return f"""
LLM Request:
-----------------------------------------------------------
System Instruction:
{req.config.system_instruction}
-----------------------------------------------------------
Contents:
{new_line.join(contents_logs)}
-----------------------------------------------------------
Functions:
{new_line.join(function_logs)}
-----------------------------------------------------------
"""

    _adk_lite_llm._build_request_log = build_request_log_with_safe_content
    _adk_lite_llm._agentkit_demo_request_log_patched = True
    logger.info("Patched ADK LiteLLM request logging with safe serialization.")


def patch_adk_trace_safe_serialization() -> None:
    """Keep ADK telemetry tracing from crashing on cyclic Content payloads."""
    import google.adk.telemetry.tracing as _adk_tracing

    if getattr(_adk_tracing, "_agentkit_demo_trace_serialization_patched", False):
        return

    original_trace_send_data = _adk_tracing.trace_send_data

    def build_llm_request_for_trace_safe(llm_request):
        result = {
            "model": llm_request.model,
            "config": safe_model_python_for_trace(
                llm_request.config,
                exclude_none=True,
                exclude="response_schema",
            ),
            "contents": [],
        }

        for content in llm_request.contents:
            parts = [part for part in (content.parts or []) if not part.inline_data]
            safe_content = types.Content(role=content.role, parts=parts)
            result["contents"].append(
                safe_model_python_for_trace(
                    safe_content,
                    exclude_none=True,
                    mode="json",
                )
            )
        return result

    @wraps(original_trace_send_data)
    def trace_send_data_safe(invocation_context, event_id, data):
        span = _adk_tracing.trace.get_current_span()
        span.set_attribute(
            "gcp.vertex.agent.invocation_id", invocation_context.invocation_id
        )
        span.set_attribute("gcp.vertex.agent.event_id", event_id)
        if _adk_tracing._should_add_request_response_to_spans():
            payload = [
                safe_model_python_for_trace(
                    types.Content(role=content.role, parts=content.parts),
                    exclude_none=True,
                    mode="json",
                )
                for content in data
            ]
            span.set_attribute(
                "gcp.vertex.agent.data",
                _adk_tracing._safe_json_serialize(payload),
            )
        else:
            span.set_attribute("gcp.vertex.agent.data", "{}")

    _adk_tracing._build_llm_request_for_trace = build_llm_request_for_trace_safe
    _adk_tracing.trace_send_data = trace_send_data_safe
    _adk_tracing._agentkit_demo_trace_serialization_patched = True
    logger.info("Patched ADK telemetry tracing with safe serialization.")


def patch_runner_empty_event_guard() -> None:
    """Patch VeADK runner to ignore empty events yielded by the runtime."""
    original_interceptor = veadk_runner.intercept_new_message

    def safe_intercept_new_message(process_func):
        decorator = original_interceptor(process_func)

        def wrapped_decorator(func):
            wrapped = decorator(func)

            @wraps(wrapped)
            async def safe_wrapper(
                self,
                *,
                user_id: str,
                session_id: str,
                new_message,
                **kwargs,
            ):
                async for event in wrapped(
                    self,
                    user_id=user_id,
                    session_id=session_id,
                    new_message=new_message,
                    **kwargs,
                ):
                    if event is None:
                        logger.warning(
                            "Received empty event from underlying runner; skipping it."
                        )
                        continue
                    yield event

            return safe_wrapper

        return wrapped_decorator

    veadk_runner.intercept_new_message = safe_intercept_new_message


def patch_adk_reasoning_content() -> None:
    """Patch ADK LiteLlm to surface model reasoning_content as thought=True Parts."""
    import google.adk.models.lite_llm as _adk_lite_llm
    from google.adk.models.lite_llm import (
        FunctionChunk,
        TextChunk,
        UsageMetadataChunk,
    )
    from google.adk.models.llm_response import LlmResponse
    from litellm import ChatCompletionMessageToolCall, Function

    native_message_converter = getattr(
        _adk_lite_llm, "_message_to_generate_content_response", None
    )
    native_chunk_converter = getattr(_adk_lite_llm, "_model_response_to_chunk", None)
    if (
        hasattr(_adk_lite_llm, "ReasoningChunk")
        and native_message_converter
        and native_chunk_converter
        and "thought_parts" in inspect.signature(native_message_converter).parameters
        and "reasoning_content" in inspect.getsource(native_chunk_converter)
    ):
        logger.info(
            "ADK LiteLlm already supports reasoning_content as thought=True Parts; "
            "skipping local compatibility patch."
        )
        return

    class _ThoughtAwareTextChunk(TextChunk):
        thought: bool = False

    def _patched_message_to_generate_content_response(
        message, *, is_partial=False, model_version=None
    ):
        parts = []
        reasoning = message.get("reasoning_content") if message else None
        if reasoning:
            parts.append(types.Part(text=reasoning, thought=True))
        if message.get("content", None):
            parts.append(types.Part.from_text(text=message.get("content")))
        if message.get("tool_calls", None):
            for tool_call in message.get("tool_calls"):
                if tool_call.type == "function":
                    part = types.Part.from_function_call(
                        name=tool_call.function.name,
                        args=json.loads(tool_call.function.arguments or "{}"),
                    )
                    part.function_call.id = tool_call.id
                    parts.append(part)
        return LlmResponse(
            content=types.Content(role="model", parts=parts),
            partial=is_partial,
            model_version=model_version,
        )

    def _patched_model_response_to_chunk(response):
        message = None
        if response.get("choices", None):
            message = response["choices"][0].get("message", None)
            finish_reason = response["choices"][0].get("finish_reason", None)
            if message is None and response["choices"][0].get("delta", None):
                message = response["choices"][0]["delta"]

            if message.get("reasoning_content", None):
                yield (
                    _ThoughtAwareTextChunk(
                        text=message.get("reasoning_content"), thought=True
                    ),
                    finish_reason,
                )

            if message.get("content", None):
                yield TextChunk(text=message.get("content")), finish_reason

            if message.get("tool_calls", None):
                for tool_call in message.get("tool_calls"):
                    if tool_call.type == "function":
                        func_name = tool_call.function.name
                        func_args = tool_call.function.arguments
                        if not func_name and not func_args:
                            continue
                        yield (
                            FunctionChunk(
                                id=tool_call.id,
                                name=func_name,
                                args=func_args,
                                index=tool_call.index,
                            ),
                            finish_reason,
                        )

            if finish_reason and not (
                message.get("content", None)
                or message.get("tool_calls", None)
                or message.get("reasoning_content", None)
            ):
                yield None, finish_reason

        if not message:
            yield None, None

        if response.get("usage", None):
            yield (
                UsageMetadataChunk(
                    prompt_tokens=response["usage"].get("prompt_tokens", 0),
                    completion_tokens=response["usage"].get("completion_tokens", 0),
                    total_tokens=response["usage"].get("total_tokens", 0),
                    cached_prompt_tokens=_adk_lite_llm._extract_cached_prompt_tokens(
                        response["usage"]
                    ),
                ),
                None,
            )

    async def _patched_generate_content_async(self, llm_request, stream=False):
        self._maybe_append_user_content(llm_request)
        _adk_lite_llm._append_fallback_user_content_if_missing(llm_request)

        effective_model = llm_request.model or self.model
        get_completion_inputs_signature = inspect.signature(
            _adk_lite_llm._get_completion_inputs
        )
        if "model" in get_completion_inputs_signature.parameters:
            (
                messages,
                tools,
                response_format,
                generation_params,
            ) = await _adk_lite_llm._get_completion_inputs(llm_request, effective_model)
        else:
            completion_inputs = _adk_lite_llm._get_completion_inputs(llm_request)
            if inspect.isawaitable(completion_inputs):
                completion_inputs = await completion_inputs
            messages, tools, response_format, generation_params = completion_inputs
        response_format = downgrade_json_schema_response_format(
            messages, response_format
        )

        if "functions" in self._additional_args:
            tools = None

        completion_args = {
            "model": effective_model,
            "messages": messages,
            "tools": tools,
            "response_format": response_format,
        }
        completion_args.update(self._additional_args)

        if generation_params:
            completion_args.update(generation_params)

        if stream:
            text = ""
            reasoning_text = ""
            function_calls = {}
            completion_args["stream"] = True
            completion_args["stream_options"] = {"include_usage": True}
            aggregated_llm_response = None
            aggregated_llm_response_with_tool_call = None
            usage_metadata = None
            fallback_index = 0
            async for part in await self.llm_client.acompletion(**completion_args):
                for chunk, finish_reason in _patched_model_response_to_chunk(part):
                    if isinstance(chunk, FunctionChunk):
                        index = chunk.index or fallback_index
                        if index not in function_calls:
                            function_calls[index] = {"name": "", "args": "", "id": None}

                        if chunk.name:
                            function_calls[index]["name"] += chunk.name
                        if chunk.args:
                            function_calls[index]["args"] += chunk.args
                            try:
                                json.loads(function_calls[index]["args"])
                                fallback_index += 1
                            except json.JSONDecodeError:
                                pass

                        function_calls[index]["id"] = (
                            chunk.id or function_calls[index]["id"] or str(index)
                        )
                    elif isinstance(chunk, TextChunk):
                        if getattr(chunk, "thought", False):
                            reasoning_text += chunk.text
                            yield _patched_message_to_generate_content_response(
                                {"role": "assistant", "reasoning_content": chunk.text},
                                is_partial=True,
                                model_version=part.model,
                            )
                        else:
                            text += chunk.text
                            yield _patched_message_to_generate_content_response(
                                {"role": "assistant", "content": chunk.text},
                                is_partial=True,
                                model_version=part.model,
                            )
                    elif isinstance(chunk, UsageMetadataChunk):
                        usage_metadata = types.GenerateContentResponseUsageMetadata(
                            prompt_token_count=chunk.prompt_tokens,
                            candidates_token_count=chunk.completion_tokens,
                            total_token_count=chunk.total_tokens,
                            cached_content_token_count=chunk.cached_prompt_tokens,
                        )

                    if (
                        finish_reason == "tool_calls" or finish_reason == "stop"
                    ) and function_calls:
                        tool_calls = []
                        for index, func_data in function_calls.items():
                            if func_data["id"]:
                                tool_calls.append(
                                    ChatCompletionMessageToolCall(
                                        type="function",
                                        id=func_data["id"],
                                        function=Function(
                                            name=func_data["name"],
                                            arguments=func_data["args"],
                                            index=index,
                                        ),
                                    )
                                )
                        aggregated_llm_response_with_tool_call = (
                            _patched_message_to_generate_content_response(
                                {
                                    "role": "assistant",
                                    "content": text,
                                    "reasoning_content": reasoning_text,
                                    "tool_calls": tool_calls,
                                },
                                model_version=part.model,
                            )
                        )
                        text = ""
                        reasoning_text = ""
                        function_calls.clear()
                    elif finish_reason == "stop" and (text or reasoning_text):
                        aggregated_llm_response = (
                            _patched_message_to_generate_content_response(
                                {
                                    "role": "assistant",
                                    "content": text,
                                    "reasoning_content": reasoning_text,
                                },
                                model_version=part.model,
                            )
                        )
                        text = ""
                        reasoning_text = ""

            if text or reasoning_text:
                aggregated_llm_response = _patched_message_to_generate_content_response(
                    {
                        "role": "assistant",
                        "content": text,
                        "reasoning_content": reasoning_text,
                    },
                    model_version=part.model if "part" in dir() else None,
                )
                text = ""
                reasoning_text = ""

            if aggregated_llm_response:
                if usage_metadata:
                    aggregated_llm_response.usage_metadata = usage_metadata
                    usage_metadata = None
                yield aggregated_llm_response

            if aggregated_llm_response_with_tool_call:
                if usage_metadata:
                    aggregated_llm_response_with_tool_call.usage_metadata = (
                        usage_metadata
                    )
                yield aggregated_llm_response_with_tool_call
        else:
            response = await self.llm_client.acompletion(**completion_args)
            yield _adk_lite_llm._model_response_to_generate_content_response(response)

    _adk_lite_llm._message_to_generate_content_response = (
        _patched_message_to_generate_content_response
    )
    _adk_lite_llm._model_response_to_chunk = _patched_model_response_to_chunk
    _adk_lite_llm.LiteLlm.generate_content_async = _patched_generate_content_async
    logger.info(
        "Patched ADK LiteLlm to extract reasoning_content as thought=True Parts "
        "(streaming + non-streaming)."
    )


def patch_litellm_client_serialization() -> None:
    """Keep ADK dev metadata endpoints from serializing runtime LLM clients."""
    from google.adk.models.lite_llm import LiteLlm

    if not LiteLlm.model_fields.get("llm_client"):
        return

    if getattr(LiteLlm, "_agentkit_demo_serialization_patched", False):
        return

    original_model_dump = LiteLlm.model_dump
    original_model_dump_json = LiteLlm.model_dump_json

    def _exclude_llm_client(exclude):
        if exclude is None:
            return {"llm_client"}
        if isinstance(exclude, set):
            return exclude | {"llm_client"}
        if isinstance(exclude, dict):
            merged_exclude = dict(exclude)
            merged_exclude["llm_client"] = True
            return merged_exclude
        return exclude

    @wraps(original_model_dump)
    def model_dump_without_client(self, *args, **kwargs):
        kwargs["exclude"] = _exclude_llm_client(kwargs.get("exclude"))
        return original_model_dump(self, *args, **kwargs)

    @wraps(original_model_dump_json)
    def model_dump_json_without_client(self, *args, **kwargs):
        kwargs["exclude"] = _exclude_llm_client(kwargs.get("exclude"))
        return original_model_dump_json(self, *args, **kwargs)

    LiteLlm.model_dump = model_dump_without_client
    LiteLlm.model_dump_json = model_dump_json_without_client
    LiteLlm._agentkit_demo_serialization_patched = True
    logger.info("Patched ADK LiteLlm serialization to exclude llm_client.")


def patch_sqlite_session_stale_retry() -> None:
    """Retry ADK Web SQLite event writes once when the session object is stale."""
    from google.adk.sessions.sqlite_session_service import SqliteSessionService

    if getattr(SqliteSessionService, "_agentkit_demo_stale_retry_patched", False):
        return

    original_append_event = SqliteSessionService.append_event

    @wraps(original_append_event)
    async def append_event_with_stale_retry(self, session, event):
        try:
            return await original_append_event(self, session, event)
        except ValueError as exc:
            if "stale session" not in str(exc):
                raise

            latest_session = await self.get_session(
                app_name=session.app_name,
                user_id=session.user_id,
                session_id=session.id,
            )
            if latest_session is None:
                raise

            # ADK Web can reuse a Session object after another request has
            # advanced storage. Refresh the mutable fields used by the stale
            # check, then give the same event one deterministic retry.
            session.last_update_time = latest_session.last_update_time
            session.state = latest_session.state
            logger.warning(
                f"Detected stale ADK SQLite session {session.id}; refreshed "
                "timestamp and retried append_event once."
            )
            return await original_append_event(self, session, event)

    SqliteSessionService.append_event = append_event_with_stale_retry
    SqliteSessionService._agentkit_demo_stale_retry_patched = True
    logger.info("Patched ADK SQLite session service to retry stale event writes.")


def patch_adk_save_input_blobs_as_artifacts_default() -> None:
    """Persist ADK Web uploaded files as artifacts unless explicitly disabled."""
    from google.adk.runners import Runner as AdkRunner

    if getattr(AdkRunner, "_agentkit_demo_artifact_save_patched", False):
        return

    original_handle_new_message = AdkRunner._handle_new_message

    @wraps(original_handle_new_message)
    async def handle_new_message_with_artifact_save_default(
        self,
        *,
        session,
        new_message,
        invocation_context,
        run_config=None,
        state_delta=None,
    ):
        effective_run_config = run_config or invocation_context.run_config
        if (
            effective_run_config
            and "save_input_blobs_as_artifacts"
            not in effective_run_config.model_fields_set
        ):
            effective_run_config.save_input_blobs_as_artifacts = True
            effective_run_config.model_fields_set.add("save_input_blobs_as_artifacts")

        return await original_handle_new_message(
            self,
            session=session,
            new_message=new_message,
            invocation_context=invocation_context,
            run_config=effective_run_config,
            state_delta=state_delta,
        )

    AdkRunner._handle_new_message = handle_new_message_with_artifact_save_default
    AdkRunner._agentkit_demo_artifact_save_patched = True
    logger.info("Patched ADK Runner to save uploaded input blobs as artifacts.")


def patch_adk_event_safe_json_serialization() -> None:
    """Fall back to cycle-safe Event JSON for ADK Web streaming responses."""
    from google.adk.events.event import Event
    from pydantic import BaseModel
    from pydantic_core import PydanticSerializationError

    if getattr(Event, "_agentkit_demo_safe_json_patched", False):
        return

    original_model_dump_json = Event.model_dump_json

    def _json_safe(value, *, by_alias: bool, exclude_none: bool, seen: set[int]):
        if value is None or isinstance(value, (str, int, float, bool)):
            return value

        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")

        value_id = id(value)
        if isinstance(value, (dict, list, tuple, set, BaseModel)) or hasattr(
            value, "__dict__"
        ):
            if value_id in seen:
                return "[CircularReference]"
            seen.add(value_id)

        try:
            if isinstance(value, BaseModel):
                output = {}
                for field_name, field_info in value.__class__.model_fields.items():
                    field_value = getattr(value, field_name, None)
                    if exclude_none and field_value is None:
                        continue
                    key = (
                        field_info.alias
                        if by_alias and field_info.alias
                        else field_name
                    )
                    output[key] = _json_safe(
                        field_value,
                        by_alias=by_alias,
                        exclude_none=exclude_none,
                        seen=seen,
                    )
                return output

            if isinstance(value, dict):
                output = {}
                for key, item in value.items():
                    if exclude_none and item is None:
                        continue
                    output[str(key)] = _json_safe(
                        item,
                        by_alias=by_alias,
                        exclude_none=exclude_none,
                        seen=seen,
                    )
                return output

            if isinstance(value, (list, tuple, set)):
                return [
                    _json_safe(
                        item,
                        by_alias=by_alias,
                        exclude_none=exclude_none,
                        seen=seen,
                    )
                    for item in value
                    if not (exclude_none and item is None)
                ]

            if hasattr(value, "model_dump"):
                return _json_safe(
                    value.model_dump(mode="python", by_alias=by_alias),
                    by_alias=by_alias,
                    exclude_none=exclude_none,
                    seen=seen,
                )

            json.dumps(value)
            return value
        except Exception:
            return repr(value)
        finally:
            if value_id in seen:
                seen.discard(value_id)

    @wraps(original_model_dump_json)
    def model_dump_json_with_safe_fallback(self, *args, **kwargs):
        try:
            return original_model_dump_json(self, *args, **kwargs)
        except (PydanticSerializationError, ValueError) as exc:
            if "Circular reference" not in str(
                exc
            ) and "Unable to serialize" not in str(exc):
                raise

            logger.warning(
                f"Event JSON serialization failed; using cycle-safe fallback: {exc}"
            )
            by_alias = bool(kwargs.get("by_alias", False))
            exclude_none = bool(kwargs.get("exclude_none", False))
            safe_payload = _json_safe(
                self,
                by_alias=by_alias,
                exclude_none=exclude_none,
                seen=set(),
            )
            return json.dumps(safe_payload, ensure_ascii=False, default=repr)

    Event.model_dump_json = model_dump_json_with_safe_fallback
    Event._agentkit_demo_safe_json_patched = True
    logger.info("Patched ADK Event JSON serialization with cycle-safe fallback.")


def patch_mcp_artifact_upload_filename_repair() -> None:
    """Repair generated ADK artifact names before MCP upload tools run."""
    from google.adk.tools.mcp_tool.mcp_tool import McpTool

    if getattr(McpTool, "_agentkit_demo_artifact_filename_repair_patched", False):
        return

    original_run_async = McpTool.run_async

    @wraps(original_run_async)
    async def run_async_with_artifact_filename_repair(self, *, args, tool_context):
        from short_drama_agent.mcp_safety import (
            has_ingest_target_id,
            is_ingest_tool_name,
            missing_ingest_target_response,
            rewrite_mcp_tool_args,
        )

        tool_name = getattr(self, "name", "")
        safe_args = await rewrite_mcp_tool_args(
            tool_name,
            args,
            tool_context,
        )
        if is_ingest_tool_name(tool_name) and not has_ingest_target_id(safe_args):
            return missing_ingest_target_response(tool_name, safe_args)
        return await original_run_async(
            self,
            args=safe_args,
            tool_context=tool_context,
        )

    McpTool.run_async = run_async_with_artifact_filename_repair
    McpTool._agentkit_demo_artifact_filename_repair_patched = True
    logger.info("Patched ADK MCP tools to repair generated artifact upload filenames.")


def _json_schema_with_nullable_types(schema: Any) -> Any:
    """Convert OpenAPI-style nullable schemas to JSON Schema union types."""
    if isinstance(schema, list):
        return [_json_schema_with_nullable_types(item) for item in schema]
    if not isinstance(schema, dict):
        return schema

    converted = {
        key: _json_schema_with_nullable_types(value) for key, value in schema.items()
    }
    if converted.get("nullable") is True:
        schema_type = converted.get("type")
        if isinstance(schema_type, str):
            converted["type"] = (
                schema_type if schema_type == "null" else [schema_type, "null"]
            )
        elif isinstance(schema_type, list) and "null" not in schema_type:
            converted["type"] = [*schema_type, "null"]
    return converted


def patch_agent_tool_structured_output_text_merge() -> None:
    """Keep multipart structured output JSON valid when AgentTool merges text Parts."""
    import google.adk.tools.agent_tool as _adk_agent_tool
    from google.genai import types as genai_types

    if getattr(_adk_agent_tool.AgentTool, "_agentkit_demo_output_merge_patched", False):
        return

    original_run_async = _adk_agent_tool.AgentTool.run_async

    @wraps(original_run_async)
    async def run_async_with_safe_structured_output_merge(
        self,
        *,
        args: dict[str, Any],
        tool_context,
    ) -> Any:
        from google.adk.memory.in_memory_memory_service import InMemoryMemoryService
        from google.adk.runners import Runner
        from google.adk.sessions.in_memory_session_service import (
            InMemorySessionService,
        )
        from google.adk.tools._forwarding_artifact_service import (
            ForwardingArtifactService,
        )
        from google.adk.utils.context_utils import Aclosing

        if self.skip_summarization:
            tool_context.actions.skip_summarization = True

        input_schema = _adk_agent_tool._get_input_schema(self.agent)
        if input_schema:
            input_value = input_schema.model_validate(args)
            content = genai_types.Content(
                role="user",
                parts=[
                    genai_types.Part.from_text(
                        text=input_value.model_dump_json(exclude_none=True)
                    )
                ],
            )
        else:
            content = genai_types.Content(
                role="user",
                parts=[genai_types.Part.from_text(text=args["request"])],
            )

        invocation_context = tool_context._invocation_context
        parent_app_name = invocation_context.app_name if invocation_context else None
        child_app_name = parent_app_name or self.agent.name
        plugins = (
            tool_context._invocation_context.plugin_manager.plugins
            if self.include_plugins
            else None
        )
        runner = Runner(
            app_name=child_app_name,
            agent=self.agent,
            artifact_service=ForwardingArtifactService(tool_context),
            session_service=InMemorySessionService(),
            memory_service=InMemoryMemoryService(),
            credential_service=tool_context._invocation_context.credential_service,
            plugins=plugins,
        )

        state_dict = {
            key: value
            for key, value in tool_context.state.to_dict().items()
            if not key.startswith("_adk")
        }
        session = await runner.session_service.create_session(
            app_name=child_app_name,
            user_id=tool_context._invocation_context.user_id,
            state=state_dict,
        )

        last_content = None
        last_grounding_metadata = None
        async with Aclosing(
            runner.run_async(
                user_id=session.user_id,
                session_id=session.id,
                new_message=content,
            )
        ) as agen:
            async for event in agen:
                if event.actions.state_delta:
                    tool_context.state.update(event.actions.state_delta)
                if event.content:
                    last_content = event.content
                    last_grounding_metadata = event.grounding_metadata

        await runner.close()

        if last_content is None or last_content.parts is None:
            return ""

        output_schema = _adk_agent_tool._get_output_schema(self.agent)
        merged_text = _merge_agent_output_text_parts(
            last_content.parts,
            structured_output=bool(output_schema),
        )
        if output_schema:
            tool_result = _safe_validate_agent_tool_output(output_schema, merged_text)
        else:
            tool_result = merged_text

        if self.propagate_grounding_metadata and last_grounding_metadata:
            tool_context.state["temp:_adk_grounding_metadata"] = last_grounding_metadata

        return tool_result

    _adk_agent_tool.AgentTool.run_async = run_async_with_safe_structured_output_merge
    _adk_agent_tool.AgentTool._agentkit_demo_output_merge_patched = True
    logger.info(
        "Patched ADK AgentTool to merge structured output text parts without "
        "newline separators."
    )


def patch_mcp_nullable_output_schema_validation() -> None:
    """Let MCP output schemas using nullable=true validate null values."""
    from mcp.client.session import ClientSession

    if getattr(ClientSession, "_agentkit_demo_nullable_schema_patched", False):
        return

    async def validate_tool_result_with_nullable_schema(self, name, result) -> None:
        if name not in self._tool_output_schemas:
            await self.list_tools()

        output_schema = self._tool_output_schemas.get(name)
        if output_schema is None:
            logger.warning(
                f"Tool {name} not listed by server, cannot validate any structured content"
            )
            return

        from jsonschema import SchemaError, ValidationError, validate

        if result.structuredContent is None:
            raise RuntimeError(
                f"Tool {name} has an output schema but did not return structured content"
            )

        try:
            validate(
                result.structuredContent,
                _json_schema_with_nullable_types(output_schema),
            )
        except ValidationError as exc:
            raise RuntimeError(
                f"Invalid structured content returned by tool {name}: {exc}"
            ) from exc
        except SchemaError as exc:
            raise RuntimeError(f"Invalid schema for tool {name}: {exc}") from exc

    ClientSession._validate_tool_result = validate_tool_result_with_nullable_schema
    ClientSession._agentkit_demo_nullable_schema_patched = True
    logger.info("Patched MCP output schema validation to honor nullable=true.")


def apply_runtime_patches() -> None:
    patch_runner_empty_event_guard()
    patch_litellm_json_schema_response_format()
    patch_agent_tool_structured_output_text_merge()
    patch_litellm_request_log_safe_serialization()
    patch_adk_trace_safe_serialization()
    patch_adk_reasoning_content()
    patch_litellm_client_serialization()
    patch_sqlite_session_stale_retry()
    patch_adk_save_input_blobs_as_artifacts_default()
    patch_adk_event_safe_json_serialization()
    patch_mcp_nullable_output_schema_validation()
    patch_mcp_artifact_upload_filename_repair()
