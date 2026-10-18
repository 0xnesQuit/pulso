"""Reads Claude usage on this PC and publishes it for Pulso to forward to the band.

What it reads:
  - Subscription limits (5-hour, weekly, Fable weekly) from the endpoint Claude Code's
    /usage screen uses. It is NOT a documented API: it may change or break without notice.
    It signs in with the Claude Code login on this PC (~/.claude/.credentials.json); the
    token never leaves this machine except in the request to api.anthropic.com.
  - API spend from Anthropic's Admin API cost report (needs an Admin API key, sk-ant-admin...).
    There is no API for the prepaid balance, so you enter it once and the script subtracts
    what was spent since.

Where it writes: a secret GitHub gist (via `gh auth token`), as claude.json in the band
app's message format (see ../src/pages/index/index.ux). Pulso reads the gist and sends it on.

Usage (PowerShell, from band-app\\pc):
  python claude_usage.py --setup                 # create config.json and the gist
  python claude_usage.py --once                  # read and publish once
  python claude_usage.py --loop                  # every 2 minutes until Ctrl+C
  python claude_usage.py --show-keys             # print the usage endpoint's field names only
"""

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
CREDENTIALS = Path.home() / ".claude" / ".credentials.json"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
COST_URL = "https://api.anthropic.com/v1/organizations/cost_report"
GIST_FILE = "claude.json"
LOOP_SECONDS = 120


# ---------- helpers ----------

def load_config():
    if CONFIG.exists():
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    return {}


def save_config(cfg):
    CONFIG.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def http_json(method, url, headers, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def epoch(value):
    """ISO-8601 string or number -> Unix seconds (int), None if missing."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return int(dt.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp())


# ---------- subscription limits (undocumented endpoint) ----------

def oauth_token():
    creds = json.loads(CREDENTIALS.read_text(encoding="utf-8"))
    return creds["claudeAiOauth"]["accessToken"]


def fetch_usage():
    return http_json("GET", USAGE_URL, {
        "Authorization": f"Bearer {oauth_token()}",
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
    })


def window(entry):
    """{utilization, resets_at} -> {p, r} in the band's format."""
    if not isinstance(entry, dict):
        return None
    p = entry.get("utilization", entry.get("used_percentage"))
    if p is None:
        return None
    return {"p": round(float(p), 1), "r": epoch(entry.get("resets_at"))}


def limits(usage):
    out = {}
    if w := window(usage.get("five_hour")):
        out["h5"] = w
    if w := window(usage.get("seven_day")):
        out["wk"] = w
    # The Fable window's key isn't documented; take the first weekly key naming Fable.
    for key, value in usage.items():
        if "fable" in key.lower() and (w := window(value)):
            out["fb"] = w
            break
    return out


def key_tree(obj, prefix=""):
    """Field names and value types only, never values."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from key_tree(v, f"{prefix}.{k}" if prefix else k)
    else:
        yield f"{prefix}: {type(obj).__name__}"


# ---------- API spend (Admin API) ----------

def cost_usd(admin_key, start):
    """Total USD spent from `start` (UTC date) until now, plus per-day totals."""
    headers = {"x-api-key": admin_key, "anthropic-version": "2023-06-01"}
    params = f"starting_at={start.strftime('%Y-%m-%dT00:00:00Z')}&bucket_width=1d&limit=31"
    per_day, page = {}, None
    while True:
        url = f"{COST_URL}?{params}" + (f"&page={page}" if page else "")
        report = http_json("GET", url, headers)
        for bucket in report.get("data", []):
            day = bucket["starting_at"][:10]
            cents = sum(float(r.get("amount", 0)) for r in bucket.get("results", []))
            per_day[day] = per_day.get(day, 0.0) + cents / 100
        if not report.get("has_more"):
            break
        page = report.get("next_page")
    return per_day


def api_credit(cfg):
    admin_key = cfg.get("admin_key") or os.environ.get("ANTHROPIC_ADMIN_KEY")
    if not admin_key:
        return None
    today = dt.datetime.now(dt.timezone.utc).date()
    month_start = today.replace(day=1)
    since = dt.date.fromisoformat(cfg["balance_set_on"]) if cfg.get("balance_set_on") else month_start
    per_day = cost_usd(admin_key, min(since, month_start))
    day = per_day.get(today.isoformat(), 0.0)
    month = sum(v for d, v in per_day.items() if d >= month_start.isoformat())
    out = {"day": round(day, 2), "mon": round(month, 2)}
    if cfg.get("balance_usd") is not None:
        spent = sum(v for d, v in per_day.items() if d >= since.isoformat())
        out["bal"] = round(cfg["balance_usd"] - spent, 2)
    return out


# ---------- publishing ----------

def gh_token():
    return subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, check=True).stdout.strip()


def gist_headers():
    return {
        "Authorization": f"Bearer {gh_token()}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def publish(cfg, payload):
    body = {"files": {GIST_FILE: {"content": json.dumps(payload)}}}
    http_json("PATCH", f"https://api.github.com/gists/{cfg['gist_id']}", gist_headers(), body)


def collect(cfg):
    payload = {"t": int(time.time())}
    try:
        payload.update(limits(fetch_usage()))
    except (urllib.error.URLError, KeyError, OSError, ValueError) as e:
        print(f"limits: {e}", file=sys.stderr)
    try:
        if (api := api_credit(cfg)) is not None:
            payload["api"] = api
    except (urllib.error.URLError, KeyError, ValueError) as e:
        print(f"api spend: {e}", file=sys.stderr)
    return payload


# ---------- commands ----------

def setup():
    cfg = load_config()
    if not cfg.get("gist_id"):
        gist = http_json("POST", "https://api.github.com/gists", gist_headers(), {
            "description": "Pulso: Claude usage for the band",
            "public": False,
            "files": {GIST_FILE: {"content": "{}"}},
        })
        cfg["gist_id"] = gist["id"]
        print(f"Created secret gist {gist['id']}")
    balance = input("Current API credit balance in USD (blank to skip): ").strip()
    if balance:
        cfg["balance_usd"] = float(balance.replace(",", "."))
        cfg["balance_set_on"] = dt.date.today().isoformat()
    cfg.setdefault("admin_key", "")
    save_config(cfg)
    print(f"Saved {CONFIG}. Put your Admin API key in it as admin_key (or set ANTHROPIC_ADMIN_KEY).")
    print(f"Gist id for Pulso: {cfg['gist_id']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--setup", action="store_true")
    group.add_argument("--once", action="store_true")
    group.add_argument("--loop", action="store_true")
    group.add_argument("--show-keys", action="store_true")
    args = parser.parse_args()

    if args.setup:
        return setup()
    if args.show_keys:
        for line in key_tree(fetch_usage()):
            print(line)
        return

    cfg = load_config()
    if not cfg.get("gist_id"):
        sys.exit("Run --setup first.")
    while True:
        payload = collect(cfg)
        publish(cfg, payload)
        print(time.strftime("%H:%M:%S"), json.dumps(payload))
        if args.once:
            return
        time.sleep(LOOP_SECONDS)


if __name__ == "__main__":
    main()
