## ---------------------------------------------------------------------------
## 漫剧资产管理 Agent — Makefile
## ---------------------------------------------------------------------------

.ONESHELL:
.SILENT:

# ---- 环境初始化 ----

## 创建虚拟环境并安装全部依赖（首次使用请先执行此步骤）
install:
	@echo "==> 创建 Python 3.12 虚拟环境 ..."
	uv venv --python 3.12
	@echo "==> 安装 Python 依赖 ..."
	uv sync
	@echo "==> 环境初始化完成。请将 .env 文件中的 VOLCENGINE_ACCESS_KEY / VOLCENGINE_SECRET_KEY 填入正确的值。"

## 仅安装 Python 依赖
install-py:
	uv venv --python 3.12
	uv sync

# ---- 本地运行 ----

## 以 AgentServer / run_sse 协议运行 Agent 服务（端口 8000）
run:
	uv run agent.py

## 启动 VeADK Web 调试界面（http://127.0.0.1:8000）
web:
	uv run veadk web

# ---- 测试 ----

## 运行全量 Python 单元测试
test:
	uv run python -m unittest discover -s tests -v

## 运行全部测试
test-all: test

## 查看记忆库 collection 信息
memory-info:
	uv run check_memory.py

## 搜索记忆库内容（用法: make memory-search Q="关键词"）
memory-search:
	uv run check_memory.py --search "$(Q)"

# ---- 云端部署 ----

## AgentKit 配置仅允许由受控环境生成；不能提交生成的 agentkit.yaml
config:
	@echo "==> 已阻止：test-agent 不能直接生成或部署云端运行时。"
	@echo "==> 先完成平台后端/受控 Worker 迁移、凭据轮换和 staging 验收。"
	@false

## 直接部署到火山云已关闭，避免 test-agent 绕过平台授权链路
deploy:
	@echo "==> 已阻止：请通过认证后的平台后端和受控 Worker 部署。"
	@false

## 查看当前云端 runtime 信息
status:
	uv run agentkit status

# ---- 代码质量 ----

## 运行 Python 代码检查（ruff）
lint:
	uv run ruff check .

## 自动修复 Python 代码风格问题
format:
	uv run ruff check --fix .

# ---- 清理 ----

## 清理 Python 缓存和构建产物
clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null; true
	find . -type f -name '*.pyc' -delete 2>/dev/null; true
	find . -type f -name '.DS_Store' -delete 2>/dev/null; true

## 深度清理（含虚拟环境）
clean-all: clean
	rm -rf .venv

# ---- 帮助 ----

.PHONY: help install install-py run web \
        test test-all memory-info memory-search config deploy status \
        lint format clean clean-all

## 显示帮助信息（默认目标）
help:
	@echo "漫剧资产管理 Agent — 可用命令："
	@echo ""
	@grep -E '^##[^#]' $(MAKEFILE_LIST) | sed -e 's/^## /  make /' -e 's/  */  /g' | sort
	@echo ""
	@echo "示例："
	@echo "  make install       首次环境初始化"
	@echo "  make run           启动 AgentServer 服务"
	@echo "  make test          运行 Python 测试"
	@echo "  make deploy        部署到火山云"

.DEFAULT_GOAL := help
