"""Train the AquaSense models.

  python train_model.py weather   # rain classifier + 6-hour temperature regressor (Open-Meteo history)
  python train_model.py soil      # soil-moisture depletion model (needs ~5+ days of your own data)
  python train_model.py all
"""
from dotenv import load_dotenv

load_dotenv()

import datetime as dt
import json
import os
import sys

import joblib
import numpy as np
import pandas as pd
import requests
from sklearn.ensemble import GradientBoostingRegressor, RandomForestClassifier, RandomForestRegressor
from sklearn.metrics import accuracy_score, mean_absolute_error, precision_score, recall_score, roc_auc_score

import predict as P

LAT = float(os.getenv("LAT", "12.97"))
LON = float(os.getenv("LON", "79.16"))
MODEL_DIR = P.MODEL_DIR
os.makedirs(MODEL_DIR, exist_ok=True)


def save_metrics(key, values):
    path = os.path.join(MODEL_DIR, "metrics.json")
    data = json.load(open(path)) if os.path.exists(path) else {}
    data[key] = values
    json.dump(data, open(path, "w"), indent=2)


def fetch_history(years=2):
    end = dt.date.today() - dt.timedelta(days=7)           # archive data lags a few days
    start = end - dt.timedelta(days=365 * years)
    r = requests.get("https://archive-api.open-meteo.com/v1/archive", timeout=180, params={
        "latitude": LAT, "longitude": LON, "start_date": str(start), "end_date": str(end),
        "hourly": "temperature_2m,relative_humidity_2m,surface_pressure,precipitation", "timezone": "auto"})
    r.raise_for_status()
    h = r.json()["hourly"]
    return pd.DataFrame({"temp": h["temperature_2m"], "hum": h["relative_humidity_2m"],
                         "pressure": h["surface_pressure"], "precip": h["precipitation"]},
                        index=pd.to_datetime(h["time"]))


def train_weather(df=None):
    df = fetch_history() if df is None else df
    X = P.make_weather_features(df)
    roll = df["precip"].rolling(6).sum().shift(-6)          # rain in the next 6 hours (t+1 .. t+6)
    data = X.copy()
    data["rain"] = (roll >= 0.5).astype(float).where(roll.notna())
    data["temp6"] = df["temp"].shift(-6)
    data = data.dropna()
    split = int(len(data) * 0.8)                            # time-ordered split: no peeking into the future
    tr, te = data.iloc[:split], data.iloc[split:]
    F = P.WEATHER_FEATURES
    if tr["rain"].nunique() < 2 or te["rain"].nunique() < 2:
        raise SystemExit("Not enough rain events in the downloaded history to train/evaluate - "
                         "check LAT/LON in .env or use a longer period.")

    clf = RandomForestClassifier(n_estimators=250, max_depth=12, min_samples_leaf=5,
                                 class_weight="balanced_subsample", n_jobs=-1, random_state=42)
    clf.fit(tr[F], tr["rain"])
    proba = clf.predict_proba(te[F])[:, 1]
    pred = proba >= 0.5
    rain_metrics = {
        "accuracy": round(float(accuracy_score(te["rain"], pred)), 3),
        "precision": round(float(precision_score(te["rain"], pred, zero_division=0)), 3),
        "recall": round(float(recall_score(te["rain"], pred, zero_division=0)), 3),
        "roc_auc": round(float(roc_auc_score(te["rain"], proba)), 3),
        "rain_base_rate": round(float(te["rain"].mean()), 3),
        "train_rows": int(len(tr)), "test_rows": int(len(te)),
        "note": "Held-out last 20% of history. Predicts rain >= 0.5 mm in the next 6 h."}
    joblib.dump(clf, os.path.join(MODEL_DIR, "rain_clf.joblib"))
    save_metrics("rain", rain_metrics)
    print("Rain classifier:", rain_metrics)

    reg = RandomForestRegressor(n_estimators=200, max_depth=14, min_samples_leaf=5, n_jobs=-1, random_state=42)
    reg.fit(tr[F], tr["temp6"])
    mae = mean_absolute_error(te["temp6"], reg.predict(te[F]))
    base = mean_absolute_error(te["temp6"], te["temp"])    # baseline: "temperature stays the same"
    temp_metrics = {"mae_c": round(float(mae), 2), "persistence_baseline_mae_c": round(float(base), 2)}
    joblib.dump(reg, os.path.join(MODEL_DIR, "temp_reg.joblib"))
    save_metrics("temp_6h", temp_metrics)
    print("Temperature regressor:", temp_metrics)


def train_soil():
    df = P.raw_frame(days=365)
    if len(df) < 500:
        print(f"Only {len(df)} readings - collect at least ~5 days (about 500 rows) first.")
        return
    h = P.hourly(df)
    X = P.make_soil_features(h)
    y = (h["soil"].shift(-6) - h["soil"]) / 6.0             # % per hour over the next 6 h
    irrigated = h["pump_s"].fillna(0)[::-1].rolling(7, min_periods=1).sum()[::-1]
    data = X.copy()
    data["y"], data["irr"] = y, irrigated
    data = data[data["irr"] == 0].dropna(subset=P.SOIL_FEATURES + ["y"])   # clean "no irrigation" windows only
    data = data[(data["y"] > -5) & (data["y"] < 2)]
    if len(data) < 100:
        print(f"Only {len(data)} usable no-irrigation windows - collect more data.")
        return
    split = int(len(data) * 0.8)
    tr, te = data.iloc[:split], data.iloc[split:]
    m = GradientBoostingRegressor(n_estimators=200, max_depth=3, learning_rate=0.05, subsample=0.8, random_state=42)
    m.fit(tr[P.SOIL_FEATURES], tr["y"])
    mae = mean_absolute_error(te["y"], m.predict(te[P.SOIL_FEATURES]))
    base = mean_absolute_error(te["y"], np.full(len(te), tr["y"].mean()))
    metrics = {"mae_pct_per_hour": round(float(mae), 3), "mean_baseline_mae": round(float(base), 3),
               "train_rows": int(len(tr)), "test_rows": int(len(te))}
    joblib.dump(m, os.path.join(MODEL_DIR, "soil_reg.joblib"))
    save_metrics("soil_depletion", metrics)
    print("Soil depletion model:", metrics)


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("weather", "all"):
        train_weather()
    if what in ("soil", "all"):
        train_soil()
