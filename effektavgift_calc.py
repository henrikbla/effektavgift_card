#!/usr/bin/env python3
"""
Effektavgift peak calculator for Home Assistant.
Uses recorder.get_statistics service via REST API (return_response=true).
Place at: /config/scripts/effektavgift_calc.py
Token at: /config/scripts/effektavgift_token.txt
History: /config/scripts/effektavgift_history.json
"""

import json, math, os, sys, urllib.request
from datetime import datetime, timezone

ENTITY        = "sensor.slimmelezer_power_consumed"
PRICE_PER_KW  = 81.25
NIGHT_START   = 22
NIGHT_END     = 6
TOKEN_FILE    = "/config/scripts/effektavgift_token.txt"
HISTORY_FILE  = "/config/scripts/effektavgift_history.json"
LOG_FILE      = "/config/scripts/effektavgift_calc.log"

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

def set_number(eid, val):
    ha_post("/api/services/input_number/set_value", {"entity_id": eid, "value": round(val, 3)})

def set_text(eid, val):
    ha_post("/api/services/input_text/set_value", {"entity_id": eid, "value": str(val)[:255]})

def load_history():
    if os.path.exists(HISTORY_FILE):
        try:
            return json.loads(open(HISTORY_FILE).read())
        except Exception:
            pass
    return {}

def save_history(history):
    with open(HISTORY_FILE, "w") as f:
        json.dump(history, f, indent=2)

def clear_current_helpers():
    set_number("input_number.effektavgift_peak_avg_kw", 0)
    set_number("input_number.effektavgift_est_cost", 0)
    set_text("input_text.effektavgift_peak_1", "")
    set_text("input_text.effektavgift_peak_2", "")
    set_text("input_text.effektavgift_peak_3", "")

WWW_HISTORY = "/config/www/effektavgift_history.json"

def publish_history(history):
    """Copy history JSON to www so the card can fetch it via /local/."""
    import shutil
    with open(WWW_HISTORY, "w") as f:
        json.dump(history, f, indent=2)
    print(f"History published: {len(history)} months → {WWW_HISTORY}")

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

    local_now = datetime.now().astimezone()
    current_month = local_now.strftime("%Y-%m")
    start = local_now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    start_utc = start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    end_utc   = local_now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")

    print(f"Month: {current_month}, fetching {start_utc} -> {end_utc}")

    history = load_history()

    resp = ha_post("/api/services/recorder/get_statistics", {
        "statistic_ids": [ENTITY],
        "start_time": start_utc,
        "end_time": end_utc,
        "period": "hour",
        "types": ["mean"],
    }, return_response=True)

    sr = resp.get("service_response", resp)
    stats = sr.get("statistics", sr)
    rows = stats.get(ENTITY, [])
    print(f"Got {len(rows)} hourly rows")

    if not rows:
        print("No rows — clearing helpers", file=sys.stderr)
        clear_current_helpers()
        publish_history(history)
        sys.exit(0)

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
        print("No valid rows — clearing helpers", file=sys.stderr)
        clear_current_helpers()
        publish_history(history)
        sys.exit(0)

    avg  = sum(p["effective_kw"] for p in top3) / len(top3)
    cost = avg * PRICE_PER_KW

    print("Top 3:")
    for i, p in enumerate(top3, 1):
        print(f"  {i}. {p['date']} {p['hour']:02d}:00  raw={p['raw_kw']:.3f}  eff={p['effective_kw']:.3f} kW{'  (night)' if p['is_night'] else ''}")
    print(f"Avg={avg:.3f} kW  Cost={cost:.2f} kr/month")

    # Save current month to history
    history[current_month] = {
        "avg": avg,
        "cost": cost,
        "peaks": [
            {"date": p["date"], "hour": p["hour"],
             "raw_kw": round(p["raw_kw"], 3), "eff_kw": round(p["effective_kw"], 3),
             "is_night": p["is_night"]}
            for p in top3
        ]
    }
    save_history(history)
    print(f"History saved: {sorted(history.keys())}")

    # Update current helpers
    set_number("input_number.effektavgift_peak_avg_kw", avg)
    set_number("input_number.effektavgift_est_cost", cost)
    for i, p in enumerate(top3, 1):
        night = " (night)" if p["is_night"] else ""
        set_text(f"input_text.effektavgift_peak_{i}",
                 f"{p['date']} {p['hour']:02d}:00 | {p['raw_kw']:.2f} kW{night} | eff {p['effective_kw']:.2f} kW")
    for i in range(len(top3)+1, 4):
        set_text(f"input_text.effektavgift_peak_{i}", "")

    # Update history helper
    publish_history(history)

    print("Done ✓")

if __name__ == "__main__":
    main()
