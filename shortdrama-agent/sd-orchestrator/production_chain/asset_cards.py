"""Conversational draft-and-confirm flow for reusable visual assets."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from threading import Lock
from uuid import uuid4

from .llm import LLMClient, default_llm
from .models import AssetRecord
from .workflow import stable_id


_CARD_SYSTEM_PROMPT = """
你是短剧资产设定师。把用户的自然语言需求整理成一张可供确认的资产卡。
只输出 JSON。kind 只能是 character、scene、prop。角色必须尽量提取 gender、age、
name；用户没提供名称时，生成简短中文暂定名。prompt 必须是可直接用于图像生成的中文
视觉提示词，包含主体、服装/外观、环境或纯色设定、电影感光影，并明确“无文字”。
""".strip()


def _validate_card_payload(payload: dict) -> str | None:
    if payload.get("kind") not in {"character", "scene", "prop"}:
        return "kind 必须为 character、scene 或 prop"
    if not str(payload.get("name", "")).strip():
        return "缺少 name"
    if not str(payload.get("prompt", "")).strip():
        return "缺少 prompt"
    age = payload.get("age")
    if age not in (None, ""):
        try:
            if not 0 <= int(age) <= 120:
                return "age 必须在 0 到 120 之间"
        except (TypeError, ValueError):
            return "age 必须是整数或 null"
    return None


@dataclass(frozen=True)
class AssetCard:
    """A user-reviewable specification; it is not an asset until confirmed."""

    card_id: str
    status: str
    kind: str
    name: str
    gender: str | None
    age: int | None
    visual_attributes: str
    prompt: str
    source_request: str
    output_url: str = ""
    asset_id: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


class AssetCardService:
    """Keeps draft cards in-process and generates only explicitly confirmed cards."""

    def __init__(self, llm: LLMClient | None = None) -> None:
        self._llm = llm or default_llm()
        self._cards: dict[str, AssetCard] = {}
        self._lock = Lock()

    def draft(self, request: str) -> AssetCard:
        """Translate a user request into a reviewable card without generating media."""

        request = request.strip()
        if not request:
            raise ValueError("asset request must not be empty")
        payload = self._llm.chat_json(
            system_prompt=_CARD_SYSTEM_PROMPT,
            user_prompt=(
                f"用户需求：{request}\n\n"
                '输出：{"kind":"character","name":"","gender":null,'
                '"age":null,"visual_attributes":"","prompt":""}'
            ),
            validate=_validate_card_payload,
        )
        raw_age = payload.get("age")
        age = int(raw_age) if raw_age not in (None, "") else None
        card = AssetCard(
            card_id=f"asset_card_{uuid4().hex[:12]}",
            status="awaiting_confirmation",
            kind=payload["kind"],
            name=payload["name"].strip(),
            gender=(str(payload.get("gender", "")).strip() or None),
            age=age,
            visual_attributes=str(payload.get("visual_attributes", "")).strip(),
            prompt=payload["prompt"].strip(),
            source_request=request,
        )
        with self._lock:
            self._cards[card.card_id] = card
        return card

    def confirm(self, card_id: str) -> tuple[AssetCard, AssetRecord]:
        """Generate the confirmed card once and return its reusable asset record."""

        with self._lock:
            card = self._cards.get(card_id)
            if card is None:
                raise ValueError("asset card not found; create a draft card first")
            if card.status == "generated":
                return card, self._to_asset(card)
            if card.status != "awaiting_confirmation":
                raise ValueError(f"asset card cannot be confirmed from {card.status}")

        try:
            output_url = self._llm.generate_image(prompt=card.prompt, size="1024x1024")
        except Exception as exc:
            failed = AssetCard(**{**card.to_dict(), "status": "generation_failed"})
            with self._lock:
                self._cards[card_id] = failed
            raise RuntimeError("asset generation failed") from exc

        generated = AssetCard(**{
            **card.to_dict(),
            "status": "generated",
            "output_url": output_url,
            "asset_id": stable_id("asset", card.card_id, output_url),
        })
        with self._lock:
            self._cards[card_id] = generated
        return generated, self._to_asset(generated)

    @staticmethod
    def _to_asset(card: AssetCard) -> AssetRecord:
        return AssetRecord(
            asset_id=card.asset_id,
            name=card.name,
            kind=card.kind,
            description=card.visual_attributes,
            aliases=[card.name],
            source_url=card.output_url,
        )
