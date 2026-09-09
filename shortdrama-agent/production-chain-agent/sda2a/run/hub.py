"""Start the A2A Hub server standalone.

Usage::

    python -m sda2a.run.hub --host 0.0.0.0 --port 9000
"""

from __future__ import annotations

from dotenv import load_dotenv
load_dotenv()

import argparse
import os
import time

from sda2a.hub import HubManager


if __name__ == "__main__":
    if os.getenv("SHORTDRAMA_RESEARCH_RUNTIME") != "DEV" or os.getenv("SHORTDRAMA_RESEARCH_OPT_IN") != "1":
        raise SystemExit("A2A research runtime is disabled; set SHORTDRAMA_RESEARCH_RUNTIME=DEV and SHORTDRAMA_RESEARCH_OPT_IN=1")
    parser = argparse.ArgumentParser(description="Start A2A Hub server")
    parser.add_argument("--host", default="0.0.0.0", help="bind host")
    parser.add_argument("--port", type=int, default=9000, help="bind port")
    args = parser.parse_args()

    hub = HubManager(host=args.host, port=args.port)
    url = hub.start()
    print(f"A2A Hub running at {url}")
    print(f"Group: {hub.group_id}")
    print("Press Ctrl+C to stop.")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping Hub...")
        hub.stop()
        print("Hub stopped.")
