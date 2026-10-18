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
  python claude_usage.py --statusline            # Claude Code status line command (official fallback)
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

class LoginProblem(Exception):
    pass


RELOGIN_HINT = ("Terminalde `claude` acip bir mesaj gonder (oturum yenilenir), sonra tekrar dene. "
                "Olmazsa `claude` icinde /login yap.")


def oauth_token():
    if not CREDENTIALS.exists():
        raise LoginProblem(f"{CREDENTIALS} yok: bu bilgisayarda terminal Claude Code'a giris yapilmamis. " + RELOGIN_HINT)
    oauth = json.loads(CREDENTIALS.read_text(encoding="utf-8")).get("claudeAiOauth") or {}
    if not oauth.get("accessToken"):
        raise LoginProblem("Claude Code oturumunda Pro/Max girisi yok. " + RELOGIN_HINT)
    expires = oauth.get("expiresAt")
    if expires and expires / 1000 < time.time():
        ago = int((time.time() - expires / 1000) / 60)
        raise LoginProblem(f"Claude oturum anahtarinin suresi {ago} dk once dolmus. " + RELOGIN_HINT)
    return oauth["accessToken"]


def fetch_usage():
    try:
        return http_json("GET", USAGE_URL, {
            "Authorization": f"Bearer {oauth_token()}",
            "anthropic-beta": "oauth-2025-04-20",
            "Content-Type": "application/json",
        })
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise LoginProblem(f"Claude kullanim adresi {e.code} dondu (oturum gecersiz). " + RELOGIN_HINT) from None
        raise


# ---------- official fallback: the Claude Code status line ----------
# Claude Code passes `rate_limits.five_hour` / `seven_day` (used_percentage, resets_at) to the
# status line command. `--statusline` caches them here; collect() uses the cache when the
# usage endpoint fails. It has no Fable window.

STATUS_CACHE = HERE / "statusline_cache.json"


def statusline():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        data = {}
    rate = data.get("rate_limits") or {}
    out = {}
    if w := window(rate.get("five_hour")):
        out["h5"] = w
    if w := window(rate.get("seven_day")):
        out["wk"] = w
    if out:
        out["at"] = int(time.time())
        STATUS_CACHE.write_text(json.dumps(out), encoding="utf-8")
    parts = [f"5s %{round(out['h5']['p'])}" if "h5" in out else None,
             f"hafta %{round(out['wk']['p'])}" if "wk" in out else None]
    print(" | ".join(p for p in parts if p) or "Claude")


def cached_limits(max_age=6 * 3600):
    if not STATUS_CACHE.exists():
        return {}
    cache = json.loads(STATUS_CACHE.read_text(encoding="utf-8"))
    if time.time() - cache.pop("at", 0) > max_age:
        return {}
    return cache


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
    # Model-scoped weekly limit (Fable): `limits[]` entry of kind "weekly_scoped", whose percent
    # is its own allowance (used_percent_of_weekly / allowance_percent_of_weekly). A key naming
    # Fable wins if one ever appears.
    for item in usage.get("limits") or []:
        if isinstance(item, dict) and item.get("kind") == "weekly_scoped" and item.get("percent") is not None:
            out["fb"] = {"p": round(float(item["percent"]), 1), "r": epoch(item.get("resets_at"))}
            break
    for key, value in usage.items():
        if "fable" in key.lower() and (w := window(value)):
            out["fb"] = w
            break
    # A dollar allowance window (e.g. the monthly $250 credit, codenamed in the response).
    for key, value in usage.items():
        if isinstance(value, dict) and value.get("limit_dollars"):
            out["cr"] = {"used": round(float(value.get("used_dollars") or 0), 2),
                         "lim": round(float(value["limit_dollars"]), 2),
                         "r": epoch(value.get("resets_at"))}
            break
    return out


LABEL_KEYS = {"name", "label", "title", "model", "model_name", "display_name", "scope", "kind", "type", "id"}


def windows_report(usage):
    """Every window with a percentage (when it resets, in local time), and the labels inside
    the `limits` / `weekly_scoped_shares` lists. Numbers and names only."""
    def when(value):
        ts = epoch(value)
        return dt.datetime.fromtimestamp(ts).strftime("%a %d %b %H:%M") if ts else "-"

    for key, value in usage.items():
        if isinstance(value, dict) and value.get("utilization") is not None:
            dollars = ""
            if value.get("limit_dollars") is not None:
                dollars = f"  (${value.get('used_dollars')} / ${value.get('limit_dollars')})"
            print(f"{key:22} %{value['utilization']:<6} resets {when(value.get('resets_at'))}{dollars}")
    for list_key in ("limits", "weekly_scoped_shares"):
        for i, item in enumerate(usage.get(list_key) or []):
            if not isinstance(item, dict):
                continue
            labels = {k: v for k, v in item.items() if k in LABEL_KEYS | {"scope", "group"}}
            numbers = {k: v for k, v in item.items() if isinstance(v, (int, float)) and k not in labels}
            print(f"{list_key}[{i}] {labels} {numbers} keys={sorted(item)}")


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

_GH_TOKEN = None


def gh_token():
    """`gh auth token`, asked once per run. CREATE_NO_WINDOW keeps Windows from flashing a
    console window when this runs under pythonw."""
    global _GH_TOKEN
    if _GH_TOKEN is None:
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        _GH_TOKEN = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True,
                                   check=True, creationflags=flags).stdout.strip()
    return _GH_TOKEN


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
    except (LoginProblem, urllib.error.URLError, KeyError, OSError, ValueError) as e:
        print(f"limits: {e}", file=sys.stderr)
        if cached := cached_limits():
            print("limits: status line cache used (no Fable)", file=sys.stderr)
            payload.update(cached)
    try:
        if (api := api_credit(cfg)) is not None:
            payload["api"] = api
    except urllib.error.HTTPError as e:
        # Anthropic's error body says why (missing permission, wrong key type); never the key.
        try:
            detail = json.loads(e.read().decode()).get("error", {}).get("message", "")
        except ValueError:
            detail = ""
        print(f"api spend: HTTP {e.code} {detail}", file=sys.stderr)
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
    group.add_argument("--statusline", action="store_true", help="status line command for Claude Code")
    group.add_argument("--show-windows", action="store_true", help="every limit window, numbers and labels only")
    args = parser.parse_args()

    if args.setup:
        return setup()
    if args.statusline:
        return statusline()
    if args.show_windows:
        try:
            windows_report(fetch_usage())
        except LoginProblem as e:
            sys.exit(str(e))
        return
    if args.show_keys:
        try:
            usage = fetch_usage()
        except LoginProblem as e:
            sys.exit(str(e))
        for line in key_tree(usage):
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
