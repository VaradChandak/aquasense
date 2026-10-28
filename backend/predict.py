"""Feature building + predictions (rain, temperature, soil-moisture depletion).

Weather models are trained on Open-Meteo history (see train_model.py) using the same
inputs the sensors provide: pressure (BMP180), temperature (DHT11/LM35), humidity (DHT11).
Soil model learns from your own logged data; until it exists a simple heuristic is used.
"""
import os
import time

import joblib
import numpy as np
import pandas as pd

from db import execute, query

MODEL_DIR = os.getenv("MODEL_DIR", "models")
TZ_OFFSET_MIN = int(os.getenv("TZ_OFFSET_MIN", "330"))
SOIL_TRIGGER = float(os.getenv("SOIL_TRIGGER_PCT", "35"))

WEATHER_FEATURES = ["pressure", "dp3", "temp", "dtemp3", "hum", "dhum3", "hsin", "hcos"]
SOIL_FEATURES = ["soil", "dsoil1", "dsoil3", "temp", "hum", "uv", "light", "dp3", "hsin", "hcos"]
MODELS = {"rain": None, "temp": None, "soil": None}


def reload_models():
    for key, name in (("rain", "rain_clf.joblib"), ("temp", "temp_reg.joblib"), ("soil", "soil_reg.joblib")):
        path = os.path.join(MODEL_DIR, name)
        MODELS[key] = joblib.load(path) if os.path.exists(path) else None


reload_models()


# ---------------------------------------------------------------- features
def _time_features(index):
    h = index.hour + index.minute / 60.0
    return np.sin(2 * np.pi * h / 24), np.cos(2 * np.pi * h / 24)


def make_weather_features(df):
    """df: regular hourly DataFrame with columns pressure, temp, hum."""
    f = pd.DataFrame(index=df.index)
    f["pressure"] = df["pressure"]
    f["dp3"] = df["pressure"] - df["pressure"].shift(3)     # negative = falling pressure
    f["temp"] = df["temp"]
    f["dtemp3"] = df["temp"] - df["temp"].shift(3)
    f["hum"] = df["hum"]
    f["dhum3"] = df["hum"] - df["hum"].shift(3)
    f["hsin"], f["hcos"] = _time_features(df.index)
    return f


def make_soil_features(h):
    f = pd.DataFrame(index=h.index)
    f["soil"] = h["soil"]
    f["dsoil1"] = h["soil"] - h["soil"].shift(1)
    f["dsoil3"] = h["soil"] - h["soil"].shift(3)
    f["temp"], f["hum"], f["uv"], f["light"] = h["temp"], h["hum"], h["uv"], h["light"]
    f["dp3"] = h["pressure"] - h["pressure"].shift(3)
    f["hsin"], f["hcos"] = _time_features(h.index)
    return f


def raw_frame(days=14):
    since = int(time.time()) - days * 86400
    rows = query("SELECT * FROM readings WHERE ts>=? ORDER BY ts", (since,))
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    df.index = pd.to_datetime(df["ts"] + TZ_OFFSET_MIN * 60, unit="s")
    df["temp"] = df[["temp_dht", "temp_lm35"]].mean(axis=1)
    return df


def hourly(df):
    return df.resample("1h").agg({"soil": "mean", "temp": "mean", "hum": "mean", "pressure": "mean",
                                  "uv": "mean", "light": "mean", "pump_s": "sum", "ius": "mean"})


# ---------------------------------------------------------------- heuristics / helpers
def heuristic_rain(row):
    p = 25.0
    dp3 = row["dp3"].iloc[0]
    if dp3 < -2.0:
        p += 40
    elif dp3 < -1.0:
        p += 20
    if row["hum"].iloc[0] > 85:
        p += 20
    return float(np.clip(p, 0, 100))


def heuristic_soil_rate(soil_hourly):
    d = soil_hourly.diff().dropna()
    d = d[(d <= 0) & (d > -8)]            # keep drying steps, ignore irrigation jumps / glitches
    return float(d.mean()) if len(d) >= 4 else -0.4


def outlook_text(rain, hum):
    if rain is None:
        return "Collecting data"
    if rain >= 70:
        return "Rain likely"
    if rain >= 40:
        return "Chance of showers"
    return "Humid and overcast" if (hum is not None and hum > 80) else "Mostly dry"


# ---------------------------------------------------------------- main entry
def run_predictions():
    df = raw_frame(14)
    if df.empty:
        return None
    h = hourly(df)
    out = {"ts": int(time.time()), "rain_prob": None, "temp_6h": None, "soil_rate": None,
           "soil_24h": None, "hours_to_dry": None, "outlook": "Collecting data", "stress": "Unknown",
           "method": "none"}
    methods = []

    # ---- weather: needs ~4 h of history for the 3-hour deltas
    wf = make_weather_features(h)
    row = wf.iloc[[-1]]
    hum_now = row["hum"].iloc[0] if not np.isnan(row["hum"].iloc[0]) else None
    if not row[WEATHER_FEATURES].isna().any().any():
        if MODELS["rain"] is not None:
            out["rain_prob"] = float(MODELS["rain"].predict_proba(row[WEATHER_FEATURES])[0][1] * 100)
            methods.append("rain:RF")
        else:
            out["rain_prob"] = heuristic_rain(row)
            methods.append("rain:rules")
        if MODELS["temp"] is not None:
            out["temp_6h"] = float(MODELS["temp"].predict(row[WEATHER_FEATURES])[0])
    out["outlook"] = outlook_text(out["rain_prob"], hum_now)

    # ---- soil moisture depletion (no-irrigation forecast)
    soil_h = h["soil"].dropna()
    if len(soil_h) >= 6:
        soil_now = float(df["soil"].dropna().iloc[-1])
        rate = None
        if MODELS["soil"] is not None:
            sf = make_soil_features(h).iloc[[-1]]
            if not sf[SOIL_FEATURES].isna().any().any():
                rate = float(MODELS["soil"].predict(sf[SOIL_FEATURES])[0])
                methods.append("soil:GBR")
        if rate is None:
            rate = heuristic_soil_rate(soil_h)
            methods.append("soil:trend")
        rate = float(np.clip(rate, -5.0, 1.0))                # % per hour
        out["soil_rate"] = rate
        out["soil_24h"] = float(np.clip(soil_now + 24 * rate, 0, 100))
        if soil_now <= SOIL_TRIGGER:
            out["hours_to_dry"] = 0.0
        elif rate < -0.05:
            out["hours_to_dry"] = float((soil_now - SOIL_TRIGGER) / -rate)

        recent = df[df.index >= df.index.max() - pd.Timedelta(hours=3)]
        ius = float(recent["ius"].mean()) if recent["ius"].notna().any() else 0.0
        out["stress"] = "Stressed" if (soil_now < 20 or ius >= 0.45) else ("Watch" if ius >= 0.30 else "Healthy")

    out["method"] = ",".join(methods) or "none"
    execute("INSERT OR REPLACE INTO predictions (ts,rain_prob,temp_6h,soil_rate,soil_24h,hours_to_dry,outlook,stress,method) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (out["ts"], out["rain_prob"], out["temp_6h"], out["soil_rate"], out["soil_24h"],
              out["hours_to_dry"], out["outlook"], out["stress"], out["method"]))
    return out


def predict_scenario(temp: float = 28.0, hum: float = 60.0, pressure: float = 1013.25,
                     dp3: float = 0.0, soil: float = 45.0, uv: float = 5.0,
                     light: float = 50.0, hour: float = None) -> dict:
    """Predict weather and irrigation metrics for custom inputs or current sensor values."""
    reload_models()
    if hour is None:
        lt = time.localtime()
        hour = lt.tm_hour + lt.tm_min / 60.0

    hsin = float(np.sin(2 * np.pi * hour / 24))
    hcos = float(np.cos(2 * np.pi * hour / 24))

    # Features for Random Forest: ["pressure", "dp3", "temp", "dtemp3", "hum", "dhum3", "hsin", "hcos"]
    dtemp3 = -0.5 if dp3 < -1.0 else 0.2
    dhum3 = 8.0 if dp3 < -1.0 else -2.0
    feat_df = pd.DataFrame([{
        "pressure": float(pressure), "dp3": float(dp3), "temp": float(temp),
        "dtemp3": float(dtemp3), "hum": float(hum), "dhum3": float(dhum3),
        "hsin": hsin, "hcos": hcos
    }])

    rain_prob = None
    temp_6h = None
    methods = []

    # 1. Rain prediction
    if MODELS["rain"] is not None:
        try:
            proba = float(MODELS["rain"].predict_proba(feat_df[WEATHER_FEATURES])[0][1] * 100)
            rain_prob = round(float(np.clip(proba, 0.0, 100.0)), 1)
            methods.append("rain:RandomForest")
        except Exception:
            pass

    if rain_prob is None:
        p = 20.0
        if dp3 < -2.0: p += 45
        elif dp3 < -1.0: p += 25
        elif dp3 > 1.5: p -= 15
        if hum > 80: p += 25
        elif hum < 40: p -= 15
        if pressure < 1005: p += 15
        rain_prob = round(float(np.clip(p, 0.0, 100.0)), 1)
        methods.append("rain:HeuristicRules")

    # 2. 6-Hour Temperature prediction
    if MODELS["temp"] is not None:
        try:
            pred_t = float(MODELS["temp"].predict(feat_df[WEATHER_FEATURES])[0])
            temp_6h = round(pred_t, 1)
            methods.append("temp:RandomForest")
        except Exception:
            pass

    if temp_6h is None:
        diurnal_diff = 4.0 * np.sin(2 * np.pi * (hour + 6 - 9) / 24) - 4.0 * np.sin(2 * np.pi * (hour - 9) / 24)
        temp_6h = round(float(temp + diurnal_diff), 1)
        methods.append("temp:DiurnalModel")

    # 3. Soil Depletion Rate (%/hr)
    temp_factor = 1.0 + (temp - 25.0) / 25.0
    hum_factor = max(0.2, 1.0 - (hum - 40.0) / 100.0)
    sun_factor = 1.0 + (uv / 10.0) * 0.5 + (light / 100.0) * 0.3
    rate = -0.25 * temp_factor * hum_factor * sun_factor
    rate = round(float(np.clip(rate, -3.0, -0.05)), 2)

    soil_now = float(np.clip(soil, 0.0, 100.0))
    soil_24h = round(float(np.clip(soil_now + 24 * rate, 0.0, 100.0)), 1)

    if soil_now <= SOIL_TRIGGER:
        hours_to_dry = 0.0
    else:
        hours_to_dry = round(float((soil_now - SOIL_TRIGGER) / -rate), 1)

    # 4. Irrigation Urgency Score (IUS)
    soil_norm = np.clip(soil_now / 100.0, 0.0, 1.0)
    temp_norm = np.clip((temp - 15.0) / 25.0, 0.0, 1.0)
    hum_norm = np.clip(hum / 100.0, 0.0, 1.0)
    pdrop_norm = np.clip(max(0.0, -dp3) / 5.0, 0.0, 1.0)
    uv_norm = np.clip(uv / 10.0, 0.0, 1.0)
    daylight_penalty = 0.65 if light > 65.0 else 1.0

    ius = 0.50 * (1.0 - soil_norm) + 0.20 * temp_norm - 0.10 * hum_norm - 0.10 * pdrop_norm + 0.10 * uv_norm * daylight_penalty
    ius = round(float(np.clip(ius, 0.0, 1.0)), 2)

    stress = "Stressed" if (soil_now < 20.0 or ius >= 0.45) else ("Watch" if (soil_now < 35.0 or ius >= 0.30) else "Healthy")
    outlook = outlook_text(rain_prob, hum)

    return {
        "rain_prob": rain_prob,
        "temp_6h": temp_6h,
        "soil_rate": rate,
        "soil_24h": soil_24h,
        "hours_to_dry": hours_to_dry,
        "outlook": outlook,
        "stress": stress,
        "ius": ius,
        "methods": methods,
        "ts": int(time.time())
    }
