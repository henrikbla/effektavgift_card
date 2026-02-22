#!/usr/bin/env python3
"""
Effektavgift peak calculator for Home Assistant.
Uses recorder.get_statistics service via REST API (return_response=true).
Place at: /config/scripts/effektavgift_calc.py
Token at: /config/scripts/effektavgift_token.txt
"""

import json, math, os, sys, urllib.request
from datetime import datetime, timezone

ENTITY       = "sensor.slimmelezer_power_consumed"
PRICE_PER_KW = 81.25
NIGHT_START  = 22
NIGHT_END    = 6
TOKEN_FILE   = "/config/scripts/effektavgift_token.txt"

def get_token():
    t = os.environ.get("SUPERVISOR_TOKEN")
    if t:
        return t, "http://supervisor/core"
    if os.path.exists(TOKEN_FILE):
        return open(TOKEN_FILE).read().strip(), "http://localhost:8123"
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

def set_number(eid, val):
    ha_post("/api/services/input_number/set_value", {"entity_id": eid, "value": round(val, 3)})

def set_text(eid, val):
    ha_post("/api/services/input_text/set_value", {"entity_id": eid, "value": str(val)[:100]})

def main():
    local_now = datetime.now().astimezone()
    start = local_now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    start_utc = start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    end_utc   = local_now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")

    print(f"Fetching statistics {start_utc} → {end_utc}")

    resp = ha_post("/api/services/recorder/get_statistics", {
        "statistic_ids": [ENTITY],
        "start_time": start_utc,
        "end_time": end_utc,
        "period": "hour",
        "types": ["mean"],
    }, return_response=True)

    # Response shape (REST API): {"service_response": {"statistics": {"sensor.xxx": [...]}}}
    # Response shape (SUPERVISOR): {"statistics": {"sensor.xxx": [...]}}
    sr = resp.get("service_response", resp)
    stats = sr.get("statistics", sr)
    rows = stats.get(ENTITY, [])
    print(f"Got {len(rows)} hourly rows")

    if not rows:
        print("No statistics data returned", file=sys.stderr)
        sys.exit(1)

    by_day = {}
    for row in rows:
        mean = row.get("mean")
        if mean is None or not math.isfinite(float(mean)) or float(mean) < 0:
            continue
        mean = float(mean)
        ts = datetime.fromisoformat(str(row["start"]).replace("Z", "+00:00")).astimezone()
        date, hour = ts.strftime("%Y-%m-%d"), ts.hour
        is_night = hour >= NIGHT_START or hour < NIGHT_END
        eff = mean * 0.5 if is_night else mean
        if date not in by_day or eff > by_day[date]["effective_kw"]:
            by_day[date] = {"date": date, "hour": hour, "raw_kw": mean, "effective_kw": eff, "is_night": is_night}

    top3 = sorted(by_day.values(), key=lambda x: x["effective_kw"], reverse=True)[:3]
    if not top3:
        print("No valid data rows after filtering", file=sys.stderr)
        sys.exit(1)
    avg  = sum(p["effective_kw"] for p in top3) / len(top3)
    cost = avg * PRICE_PER_KW

    print("Top 3:")
    for i, p in enumerate(top3, 1):
        print(f"  {i}. {p['date']} {p['hour']:02d}:00  raw={p['raw_kw']:.3f}  eff={p['effective_kw']:.3f} kW{'  (night)' if p['is_night'] else ''}")
    print(f"Avg={avg:.3f} kW  Cost={cost:.2f} kr/month")

    set_number("input_number.effektavgift_peak_avg_kw", avg)
    set_number("input_number.effektavgift_est_cost", cost)
    for i, p in enumerate(top3, 1):
        night = " (night)" if p["is_night"] else ""
        set_text(f"input_text.effektavgift_peak_{i}",
                 f"{p['date']} {p['hour']:02d}:00 | {p['raw_kw']:.2f} kW{night} | eff {p['effective_kw']:.2f} kW")
    for i in range(len(top3)+1, 4):
        set_text(f"input_text.effektavgift_peak_{i}", "")

    print("Done ✓")

if __name__ == "__main__":
    main()