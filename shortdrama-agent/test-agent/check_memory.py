"""验证 VikingDB 记忆库 collection 是否存在、并检索已存入的记忆。

用法:
    # 需要先设置环境变量
    export VOLCENGINE_ACCESS_KEY=xxx
    export VOLCENGINE_SECRET_KEY=xxx
    # 可选：覆盖默认 collection 名
    export DATABASE_VIKINGMEM_COLLECTION=role_mem

    uv run check_memory.py                          # 查看 collection 信息
    uv run check_memory.py --search "漫剧"          # 搜索记忆内容
    uv run check_memory.py --user 83770919          # 按用户过滤
    uv run check_memory.py --search "漫剧" --user 83770919
"""

import json
import os
import sys

from veadk.integrations.ve_viking_db_memory.ve_viking_db_memory import (
    VikingDBMemoryClient,
)

COLLECTION = os.getenv("DATABASE_VIKINGMEM_COLLECTION", "role_mem")
REGION = os.getenv("DATABASE_VIKING_REGION", "cn-beijing")
AK = os.environ.get("VOLCENGINE_ACCESS_KEY", "")
SK = os.environ.get("VOLCENGINE_SECRET_KEY", "")


def get_client() -> VikingDBMemoryClient:
    if not AK or not SK:
        print("[ERROR] 请先设置 VOLCENGINE_ACCESS_KEY / VOLCENGINE_SECRET_KEY")
        sys.exit(1)
    return VikingDBMemoryClient(ak=AK, sk=SK, region=REGION)


def show_collection_info(client: VikingDBMemoryClient):
    print(f"=== GetCollection: {COLLECTION} ===")
    try:
        res = client.get_collection(collection_name=COLLECTION)
        print(json.dumps(res, ensure_ascii=False, indent=2))
    except Exception as e:
        print(f"[ERROR] {e}")


def search_memory(client: VikingDBMemoryClient, query: str, user_id: str):
    print(f"\n=== SearchMemory: collection={COLLECTION}, query='{query}', user='{user_id}' ===")
    filter_ = {"memory_type": ["sys_event_v1"]}
    if user_id:
        filter_["user_id"] = user_id
    try:
        res = client.search_memory(
            collection_name=COLLECTION,
            query=query,
            filter=filter_,
            limit=10,
        )
        print(json.dumps(res, ensure_ascii=False, indent=2))
    except Exception as e:
        print(f"[ERROR] {e}")


def main():
    import argparse

    parser = argparse.ArgumentParser(description="验证 VikingDB 记忆库")
    parser.add_argument("--search", default="", help="搜索关键词")
    parser.add_argument("--user", default="", help="按 user_id 过滤")
    args = parser.parse_args()

    client = get_client()
    show_collection_info(client)

    if args.search:
        search_memory(client, args.search, args.user)
    elif args.user:
        # 无关键词也搜一下，看该用户有多少记忆
        search_memory(client, " ", args.user)
    else:
        print("\n提示: 加 --search '关键词' 可搜索已存入的记忆内容")
        print("     加 --user 83770919  可按用户过滤")


if __name__ == "__main__":
    main()
