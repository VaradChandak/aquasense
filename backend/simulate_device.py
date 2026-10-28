"""Post fake sensor history to the backend so you can test the dashboard + ML before hardware is wired.

  python simulate_device.py 8        # 8 days of 15-minute readings
Env: BACKEND_URL (default http://localhost:8000/api/ingest), API_KEY (default change-me)
"""
import math
import os
import random
import sys
import time

import requests

URL = os.getenv("BACKEND_URL", "http://localhost:8000/api/ingest")
KEY = os.getenv("API_KEY", "change-me")
TZ = int(os.getenv("TZ_OFFSET_MIN", "330")) * 60
days = int(sys.argv[1]) if len(sys.argv) > 1 else 7

now = int(time.time())
start = now - days * 86400
start -= start % 900
soil, pump_pending, last_irrig, rows = 62.0, 0, 0, []

for ts in range(start, now, 900):
    hour = ((ts + TZ) // 3600) % 24
    day = (ts - start) / 86400
    diurnal = math.sin((hour - 9) / 24 * 2 * math.pi)
    temp = 28 + 6 * diurnal + random.gauss(0, 0.4)
    hum = 66 - 20 * diurnal + random.gauss(0, 2)
    pressure = 995 + 3.5 * math.sin(2 * math.pi * day / 2.7) + 1.0 * math.sin(2 * math.pi * (hour - 4) / 12) + random.gauss(0, 0.15)
    sun = max(0.0, math.sin((hour - 6) / 12 * math.pi)) if 6 <= hour <= 18 else 0.0
    uv, light = 10 * sun + random.gauss(0, 0.2), 95 * sun + random.gauss(0, 2)

    soil -= 0.05 * (temp / 30) * (1 + sun)                 # drying
    pump_s = 0
    if soil < 35 and ts - last_irrig > 1800 and 6 <= hour < 19:
        pump_s, soil, last_irrig = 40, soil + 22, ts       # simulated irrigation
    soil = max(5.0, min(95.0, soil))
    ius = max(0.0, min(1.0, 0.55 * (1 - soil / 100) + 0.15 * (temp - 15) / 25 - 0.1 * hum / 100 + 0.1 * uv / 11))

    rows.append({"ts": ts, "soil": round(soil + random.gauss(0, 0.3), 1), "temp_dht": round(temp, 1),
                 "temp_lm35": round(temp + random.gauss(0.3, 0.5), 1), "hum": round(hum, 1),
                 "pressure": round(pressure, 1), "pdrop3h": 0, "uv": round(max(0, uv), 2),
                 "light": round(max(0, light), 1), "water": 80, "ius": round(ius, 3),
                 "pump_s": pump_s, "fan": int(temp > 32), "mode": 0})

for i in range(0, len(rows), 96):
    r = requests.post(URL, json={"readings": rows[i:i + 96]}, headers={"X-API-Key": KEY}, timeout=30)
    print(f"batch {i // 96 + 1}: {r.status_code} {r.text}")
