"""AquaSense API.  Run:  uvicorn main:app --host 0.0.0.0 --port 8000"""
from dotenv import load_dotenv

load_dotenv()  # must run before db/predict read their environment variables

import hmac
import json
import os
import time
from contextlib import asynccontextmanager
from typing import List, Optional

import pandas as pd
import requests
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import db
import predict

API_KEY = os.getenv("API_KEY", "change-me")
RETENTION_DAYS = int(os.getenv("RETENTION_DAYS", "30"))
TZ_OFFSET_MIN = int(os.getenv("TZ_OFFSET_MIN", "330"))
PUMP_FLOW_LPM = float(os.getenv("PUMP_FLOW_LPM", "1.0"))
BASELINE_S = float(os.getenv("BASELINE_PUMP_S_PER_DAY", "180"))
MODEL_DIR = os.getenv("MODEL_DIR", "models")


class Reading(BaseModel):
    ts: int = 0
    soil: Optional[float] = None
    temp_dht: Optional[float] = None
    temp_lm35: Optional[float] = None
    hum: Optional[float] = None
    pressure: Optional[float] = None
    pdrop3h: Optional[float] = None
    uv: Optional[float] = None
    light: Optional[float] = None
    water: Optional[float] = None
    ius: Optional[float] = None
    pump_s: Optional[int] = 0
    fan: Optional[int] = 0
    mode: Optional[int] = 0


class Ingest(BaseModel):
    readings: List[Reading]


def clean(r: Reading) -> dict:
    d = r.model_dump()
    for k, v in d.items():
        if isinstance(v, (int, float)) and v <= -900:      # firmware sends -999 for "sensor unavailable"
            d[k] = None
    if not d["ts"] or d["ts"] < 1_600_000_000:             # device clock not synced: stamp on arrival
        d["ts"] = int(time.time())
    return d


def refresh():
    predict.run_predictions()


def prune():
    db.execute("DELETE FROM readings WHERE ts < ?", (int(time.time()) - RETENTION_DAYS * 86400,))


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    predict.reload_models()
    sched = BackgroundScheduler()
    sched.add_job(prune, "interval", hours=6)
    sched.start()
    yield
    sched.shutdown()


app = FastAPI(title="AquaSense API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
                   allow_methods=["GET", "POST"], allow_headers=["*"])


def daily_summary(rows):
    if not rows:
        return []
    df = pd.DataFrame(rows)
    df["day"] = pd.to_datetime(df["ts"] + TZ_OFFSET_MIN * 60, unit="s").dt.strftime("%Y-%m-%d")
    out = df.groupby("day").agg(soil_min=("soil", "min"), soil_avg=("soil", "mean"), soil_max=("soil", "max"),
                                temp_avg=("temp_dht", "mean"), hum_avg=("hum", "mean"), uv_max=("uv", "max"),
                                pump_s=("pump_s", "sum"), samples=("ts", "count")).reset_index()
    out["water_l"] = out["pump_s"] / 60.0 * PUMP_FLOW_LPM
    if BASELINE_S > 0:
        out["saved_pct"] = (1 - out["pump_s"] / BASELINE_S) * 100
    return json.loads(out.round(2).to_json(orient="records"))


def model_info():
    path = os.path.join(MODEL_DIR, "metrics.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return None


@app.get("/api/health")
def health():
    return {"status": "ok", "time": int(time.time())}


@app.post("/api/ingest")
def ingest(body: Ingest, bg: BackgroundTasks, x_api_key: str = Header(default="")):
    if not hmac.compare_digest(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="Invalid API key")
    rows = [clean(r) for r in body.readings]
    db.insert_readings(rows)
    bg.add_task(refresh)                                   # new data -> new prediction
    return {"stored": len(rows)}


@app.get("/api/dashboard")
def dashboard(days: int = Query(7, ge=1, le=30)):
    since = int(time.time()) - days * 86400
    rows = db.query("SELECT * FROM readings WHERE ts>=? ORDER BY ts", (since,))
    pred = db.query("SELECT * FROM predictions ORDER BY ts DESC LIMIT 1")
    return {"latest": rows[-1] if rows else None, "series": rows, "daily": daily_summary(rows),
            "prediction": pred[0] if pred else None, "model_info": model_info(),
            "server_time": int(time.time())}


class ScenarioInput(BaseModel):
    temp: Optional[float] = 28.0
    hum: Optional[float] = 60.0
    pressure: Optional[float] = 1013.25
    dp3: Optional[float] = 0.0
    soil: Optional[float] = 45.0
    uv: Optional[float] = 5.0
    light: Optional[float] = 50.0
    hour: Optional[float] = None


@app.post("/api/predict")
def predict_endpoint(body: ScenarioInput):
    """Run ML prediction on either live sensor values or user-input scenario."""
    return predict.predict_scenario(
        temp=body.temp,
        hum=body.hum,
        pressure=body.pressure,
        dp3=body.dp3,
        soil=body.soil,
        uv=body.uv,
        light=body.light,
        hour=body.hour
    )
