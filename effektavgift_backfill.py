#!/usr/bin/env python3
"""
Effektavgift historical backfill script.
Queries recorder statistics month by month going back as far as data exists,
and writes results to /config/www/effektavgift_history.json.

Run once via the automation or manually:
  python3 /config/scripts/effektavgift_backfill.py
"""

import json, math, os, sys, urllib.request
from datetime import datetime, timezone
from dateutil.relativedelta import relativedelta

ENTITY        = "sensor.slimmelezer_power_consumed"
PRICE_PER_KW  = 81.25
NIGHT_START   = 22
NIGHT_END     = 6
TOKEN_FILE    = "/config/scripts/effektavgift_token.txt"
HISTORY_FILE  = "/config/scripts/effektavgift_history.json"
WWW_HISTORY   = "/config/www/effektavgift_history.json"
LOG_FILE      = "/config/scripts/effektavgift_backfill.log"

def get_token():
    if os.path.exists(TOKEN_FILE):
        return open(TOKEN_FILE).read().strip(), "http://localhost:8123"
    t = os.environ.get("SUPERVISOR_TOKEN")
    if t:
        return t, "http://supervisor/core"
    print("ERROR: no token", file=sys.stderr); sys.exit(1)

TOKEN, HA_URL = get_token()

def ha_post(path, data, return_response=False):
    url = HA_URL + path
    if return_response:
        url += "?return_response"
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method="POST",
          headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def load_existing_history():
    if os.path.exists(HISTORY_FILE):
        try:
            return json.loads(open(HISTORY_FILE).read())
        except Exception:
            pass
    return {}

def fetch_month(year, month):
    """Fetch top-3 peaks for a given year/month. Returns dict or None if no data."""
    # Build local start/end for the month
    local_tz = datetime.now().astimezone().tzinfo
    start = datetime(year, month, 1, 0, 0, 0, tzinfo=local_tz)
    # End = first moment of next month
    if month == 12:
        end = datetime(year + 1, 1, 1, 0, 0, 0, tzinfo=local_tz)
    else:
        end = datetime(year, month + 1, 1, 0, 0, 0, tzinfo=local_tz)

    start_utc = start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    end_utc   = end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")

    try:
        resp = ha_post("/api/services/recorder/get_statistics", {
            "statistic_ids": [ENTITY],
            "start_time": start_utc,
            "end_time": end_utc,
            "period": "hour",
            "types": ["mean"],
        }, return_response=True)
    except Exception as e:
        print(f"  ERROR fetching: {e}")
        return None

    sr   = resp.get("service_response", resp)
    stats = sr.get("statistics", sr)
    rows  = stats.get(ENTITY, [])

    if not rows:
        return None

    by_day = {}
    for row in rows:
        mean = row.get("mean")
        if mean is None or not math.isfinite(float(mean)) or float(mean) < 0:
            continue
        mean = float(mean)
        ts = datetime.fromisoformat(str(row["start"]).replace("Z", "+00:00")).astimezone()
        # Only include rows that belong to this month in local time
        if ts.year != year or ts.month != month:
            continue
        date, hour = ts.strftime("%Y-%m-%d"), ts.hour
        is_night = hour >= NIGHT_START or hour < NIGHT_END
        eff = mean * 0.5 if is_night else mean
        if date not in by_day or eff > by_day[date]["effective_kw"]:
            by_day[date] = {"date": date, "hour": hour, "raw_kw": mean,
                            "effective_kw": eff, "is_night": is_night}

    if not by_day:
        return None

    top3 = sorted(by_day.values(), key=lambda x: x["effective_kw"], reverse=True)[:3]
    avg  = sum(p["effective_kw"] for p in top3) / len(top3)
    cost = avg * PRICE_PER_KW

    return {
        "avg": round(avg, 3),
        "cost": round(cost, 1),
        "peaks": [
            {"date": p["date"], "hour": p["hour"],
             "raw_kw": round(p["raw_kw"], 3), "eff_kw": round(p["effective_kw"], 3),
             "is_night": p["is_night"]}
            for p in top3
        ]
    }

def publish_history(history):
    with open(HISTORY_FILE, "w") as f:
        json.dump(history, f, indent=2)
    with open(WWW_HISTORY, "w") as f:
        json.dump(history, f, indent=2)
    print(f"History saved: {len(history)} months")

def main():
    class Tee:
        def __init__(self, *files): self.files = files
        def write(self, obj):
            for f in self.files: f.write(obj); f.flush()
        def flush(self):
            for f in self.files: f.flush()
    log = open(LOG_FILE, "w")
    sys.stdout = Tee(sys.__stdout__, log)
    sys.stderr = Tee(sys.__stderr__, log)

    history = load_existing_history()
    print(f"Existing history: {sorted(history.keys())}")

    now = datetime.now().astimezone()
    current_year, current_month = now.year, now.month

    # Walk backwards month by month until we get 3 consecutive empty months
    consecutive_empty = 0
    year, month = current_year, current_month

    while consecutive_empty < 3:
        month_key = f"{year}-{month:02d}"

        if month_key in history:
            print(f"  {month_key}: already in history, skipping")
        else:
            print(f"  {month_key}: fetching...", end=" ")
            result = fetch_month(year, month)
            if result:
                history[month_key] = result
                consecutive_empty = 0
                top = result["peaks"][0]
                print(f"✓  top peak: {top['date']} {top['hour']:02d}:00 {top['eff_kw']:.2f} kW  cost: {result['cost']:.0f} kr")
            else:
                consecutive_empty += 1
                print(f"no data ({consecutive_empty}/3 empty)")

        # Step back one month
        month -= 1
        if month == 0:
            month = 12
            year -= 1

        # Safety: don't go further back than 5 years
        if current_year - year > 5:
            print("Reached 5-year limit, stopping.")
            break

    publish_history(history)
    print(f"\nBackfill complete. Months in history: {sorted(history.keys())}")

if __name__ == "__main__":
    main()