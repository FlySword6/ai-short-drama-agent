

FROM shortdrama-prod-cn-beijing.cr.volces.com/shortdrama/uv:0.7.13 AS uv

FROM shortdrama-prod-cn-beijing.cr.volces.com/shortdrama/python:3.11-slim-bookworm AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

COPY --from=uv /uv /usr/local/bin/uv

WORKDIR /opt/shortdrama

COPY pyproject.toml uv.lock README.md ./
COPY src ./src

RUN uv sync --frozen --no-dev --no-editable

FROM shortdrama-prod-cn-beijing.cr.volces.com/shortdrama/python:3.11-slim-bookworm AS runtime

ENV PATH="/opt/shortdrama/.venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN groupadd --system shortdrama \
    && useradd --system --gid shortdrama --create-home shortdrama \
    && mkdir -p /workspace \
    && chown shortdrama:shortdrama /workspace

COPY --from=builder --chown=shortdrama:shortdrama \
    /opt/shortdrama/.venv /opt/shortdrama/.venv

WORKDIR /workspace
USER shortdrama

ENTRYPOINT ["shortdrama"]
CMD ["--help"]
