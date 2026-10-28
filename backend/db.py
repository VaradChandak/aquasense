import os
import sqlite3
from contextlib import closing

DB_PATH = os.getenv("DB_PATH", "aquasense.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
  ts INTEGER PRIMARY KEY, soil REAL, temp_dht REAL, temp_lm35 REAL, hum REAL,
  pressure REAL, pdrop3h REAL, uv REAL, light REAL, water REAL, ius REAL,
  pump_s INTEGER, fan INTEGER, mode INTEGER);
CREATE TABLE IF NOT EXISTS predictions (
  ts INTEGER PRIMARY KEY, rain_prob REAL, temp_6h REAL, soil_rate REAL,
  soil_24h REAL, hours_to_dry REAL, outlook TEXT, stress TEXT, method TEXT);
"""
COLS = ["ts", "soil", "temp_dht", "temp_lm35", "hum", "pressure", "pdrop3h",
        "uv", "light", "water", "ius", "pump_s", "fan", "mode"]


def _conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    with closing(_conn()) as c:
        c.executescript(SCHEMA)
        c.commit()


def query(sql, params=()):
    with closing(_conn()) as c:
        return [dict(r) for r in c.execute(sql, params).fetchall()]


def execute(sql, params=()):
    with closing(_conn()) as c:
        c.execute(sql, params)
        c.commit()


def insert_readings(rows):
    q = f"INSERT OR REPLACE INTO readings ({','.join(COLS)}) VALUES ({','.join('?' * len(COLS))})"
    with closing(_conn()) as c:
        c.executemany(q, [[r.get(k) for k in COLS] for r in rows])
        c.commit()
