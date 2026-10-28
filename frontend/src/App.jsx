import React, { useEffect, useRef, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Default Fallback Threshold Values
const FALLBACK_THRESHOLDS = {
  temp: 30.0,   // °C: Fan turns ON above this temperature
  soil: 550,    // Raw ADC (0-1023): Reference dry point
  water: 150,   // Raw ADC (0-1023): Tank alert triggered below this
  ldr: 400,     // Raw ADC (0-1023): Low intensity light threshold (LED 2 glows below this)
  ius: 0.45,    // Irrigation Urgency Score (0.00-1.00): LED 1 glows for watering plants above this
};

// Maximum number of data points to keep in memory for the live graphs
const MAX_HISTORY_POINTS = 35;
const API_BASE = "http://localhost:8000";

export default function App() {
  // Web Serial connection state
  const [port, setPort] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [serialLogs, setSerialLogs] = useState([]);
  const [showConsole, setShowConsole] = useState(false);
  const [customCmd, setCustomCmd] = useState("");

  // Refs for managing serial reader cancellation and port writing
  const portRef = useRef(null);
  const readerRef = useRef(null);
  const keepReadingRef = useRef(false);

  // User-configurable thresholds
  const [thresholds, setThresholds] = useState({ ...FALLBACK_THRESHOLDS });
  const [appliedThresholds, setAppliedThresholds] = useState({ ...FALLBACK_THRESHOLDS });

  // Current live sensor readings (including BMP280)
  const [latest, setLatest] = useState({
    uv: 12,
    ldr: 350,
    soil: 620,
    water: 340,
    temp: 29.5,
    hum: 54.0,
    pressure: 1013.2,
    bmp_ok: 1,
    pdrop: 0.0,
    dht_ok: 1,
    ius: 0.52,
    fan: 0,
    fan_pwm: 0,
    led_water: 1,
    led_light: 1,
    buzzer: 0,
    ts: Date.now(),
  });

  // History buffer for Recharts graphs
  const [history, setHistory] = useState([]);

  // -------------------------------------------------------------
  // ML PREDICTION STATE (Option 1: Sensor vs. Option 2: User Input)
  // -------------------------------------------------------------
  const [predictOption, setPredictOption] = useState("sensor"); // "sensor" | "custom"
  const [customInput, setCustomInput] = useState({
    temp: 32.0,
    hum: 65.0,
    pressure: 1008.0,
    dp3: -2.5,
    soil: 38.0,
    uv: 7.0,
    light: 75.0,
  });

  const [prediction, setPrediction] = useState({
    rain_prob: 45.0,
    temp_6h: 31.0,
    soil_rate: -0.35,
    soil_24h: 32.0,
    hours_to_dry: 12.0,
    outlook: "Chance of showers",
    stress: "Healthy",
    ius: 0.46,
    methods: ["rain:RandomForest", "temp:RandomForest"],
    source: "backend",
  });

  // Log message helper
  const addLog = (msg, direction = "in") => {
    const timeStr = new Date().toLocaleTimeString();
    setSerialLogs((prev) => [...prev.slice(-60), { time: timeStr, text: msg, dir: direction }]);
  };

  // -------------------------------------------------------------
  // ML Prediction Evaluator (Queries Backend with Fallback)
  // -------------------------------------------------------------
  const runPredictionEvaluation = async (inputData) => {
    try {
      const res = await fetch(`${API_BASE}/api/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inputData),
      });
      if (res.ok) {
        const data = await res.json();
        setPrediction({ ...data, source: "backend" });
        return;
      }
    } catch (e) {
      // Backend offline: compute client-side fallback
    }

    // Client-side ML logic fallback
    const { temp, hum, pressure, dp3, soil, uv, light } = inputData;
    let rain_prob = 20.0;
    if (dp3 < -2.0) rain_prob += 45;
    else if (dp3 < -1.0) rain_prob += 25;
    else if (dp3 > 1.5) rain_prob -= 15;
    if (hum > 80) rain_prob += 25;
    else if (hum < 40) rain_prob -= 15;
    if (pressure < 1005) rain_prob += 15;
    rain_prob = Math.min(100, Math.max(0, rain_prob));

    const temp_6h = Number((temp + (dp3 < -1.5 ? -2.0 : 1.5)).toFixed(1));
    const rate = Number((-0.24 * (1 + (temp - 25) / 25) * (1 + uv / 12) * (1 - (hum - 40) / 100)).toFixed(2));
    const soil_24h = Math.min(100, Math.max(0, Number((soil + 24 * rate).toFixed(1))));
    const hours_to_dry = soil <= 35 ? 0 : Number(((soil - 35) / -rate).toFixed(1));

    const soil_norm = Math.min(1, Math.max(0, soil / 100));
    const temp_norm = Math.min(1, Math.max(0, (temp - 15) / 25));
    const hum_norm = Math.min(1, Math.max(0, hum / 100));
    const pdrop_norm = Math.min(1, Math.max(0, Math.max(0, -dp3) / 5));
    const uv_norm = Math.min(1, Math.max(0, uv / 10));
    const daylight_penalty = light > 65 ? 0.65 : 1.0;

    let iusVal = 0.50 * (1 - soil_norm) + 0.20 * temp_norm - 0.10 * hum_norm - 0.10 * pdrop_norm + 0.10 * uv_norm * daylight_penalty;
    iusVal = Math.min(1, Math.max(0, Number(iusVal.toFixed(2))));

    const stress = soil < 20 || iusVal >= 0.45 ? "Stressed" : soil < 35 || iusVal >= 0.30 ? "Watch" : "Healthy";
    const outlook = rain_prob >= 70 ? "Rain likely" : rain_prob >= 40 ? "Chance of showers" : hum > 80 ? "Humid and overcast" : "Mostly dry";

    setPrediction({
      rain_prob,
      temp_6h,
      soil_rate: rate,
      soil_24h,
      hours_to_dry,
      outlook,
      stress,
      ius: iusVal,
      methods: ["rain:HeuristicRules", "temp:ClientModel"],
      source: "client",
    });
  };

  // Trigger prediction whenever inputs change
  useEffect(() => {
    if (predictOption === "sensor") {
      const estimatedSoilPct = Math.min(100, Math.max(0, Math.round(((1023 - latest.soil) / 750) * 100)));
      const estimatedLightPct = Math.min(100, Math.max(0, Math.round((latest.ldr / 1023) * 100)));
      const sensorInput = {
        temp: latest.temp,
        hum: latest.hum,
        pressure: latest.pressure || 1013.25,
        dp3: latest.pdrop || 0.0,
        soil: estimatedSoilPct,
        uv: Math.round(latest.uv / 10),
        light: estimatedLightPct,
      };
      runPredictionEvaluation(sensorInput);
    } else {
      runPredictionEvaluation(customInput);
    }
  }, [predictOption, customInput, latest.temp, latest.hum, latest.soil, latest.pressure, latest.pdrop, latest.uv, latest.ldr]);

  // Preset Scenario Handlers
  const loadScenarioPreset = (type) => {
    setPredictOption("custom");
    if (type === "storm") {
      setCustomInput({ temp: 26.5, hum: 88.0, pressure: 996.0, dp3: -4.2, soil: 42.0, uv: 2.0, light: 25.0 });
    } else if (type === "heatwave") {
      setCustomInput({ temp: 39.5, hum: 22.0, pressure: 1012.0, dp3: 0.2, soil: 24.0, uv: 11.5, light: 95.0 });
    } else if (type === "saturated") {
      setCustomInput({ temp: 21.0, hum: 92.0, pressure: 1009.0, dp3: 0.5, soil: 88.0, uv: 2.5, light: 35.0 });
    } else if (type === "drought") {
      setCustomInput({ temp: 36.0, hum: 28.0, pressure: 1018.0, dp3: 0.6, soil: 15.0, uv: 9.5, light: 88.0 });
    }
  };

  // -------------------------------------------------------------
  // Serial Sender Helper
  // -------------------------------------------------------------
  const sendSerialCommand = async (commandStr) => {
    addLog(commandStr, "out");

    if (isDemoMode) {
      handleDemoCommand(commandStr);
      return;
    }

    if (!portRef.current || !portRef.current.writable) {
      alert("Arduino is not connected to serial port.");
      return;
    }

    try {
      const textEncoder = new TextEncoder();
      const writer = portRef.current.writable.getWriter();
      await writer.write(textEncoder.encode(commandStr + "\n"));
      writer.releaseLock();
    } catch (err) {
      console.error("Error writing to Serial port:", err);
      addLog(`Write error: ${err.message}`, "err");
    }
  };

  // -------------------------------------------------------------
  // Web Serial Port Connection Handler
  // -------------------------------------------------------------
  const connectArduino = async () => {
    if (!("serial" in navigator)) {
      alert(
        "Web Serial API is not supported in this browser. Please use Google Chrome, Microsoft Edge, or Opera. Alternatively, click 'Simulate Demo Mode' to test without hardware."
      );
      return;
    }

    try {
      if (isDemoMode) setIsDemoMode(false);

      const requestedPort = await navigator.serial.requestPort();
      await requestedPort.open({ baudRate: 9600 });
      portRef.current = requestedPort;
      setPort(requestedPort);
      setIsConnected(true);
      keepReadingRef.current = true;

      addLog("Connected to Arduino @ 9600 baud", "sys");

      setTimeout(() => {
        applyThresholdsToArduino(thresholds);
      }, 1500);

      readSerialLoop(requestedPort);
    } catch (err) {
      console.error("Failed to connect to Serial Port:", err);
      addLog(`Connection failed: ${err.message}`, "err");
    }
  };

  const disconnectArduino = async () => {
    keepReadingRef.current = false;
    if (readerRef.current) {
      try { await readerRef.current.cancel(); } catch (e) {}
    }
    if (portRef.current) {
      try { await portRef.current.close(); } catch (e) {}
      portRef.current = null;
    }
    setPort(null);
    setIsConnected(false);
    addLog("Disconnected from Arduino", "sys");
  };

  // -------------------------------------------------------------
  // Stream Reader Loop
  // -------------------------------------------------------------
  const readSerialLoop = async (serialPort) => {
    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = serialPort.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable.getReader();
    readerRef.current = reader;

    let lineBuffer = "";

    try {
      while (keepReadingRef.current) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;

        lineBuffer += value;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          addLog(trimmed, "in");

          if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
              const data = JSON.parse(trimmed);
              if (data.temp !== undefined || data.soil !== undefined) {
                processTelemetry(data);
              }
            } catch (jsonErr) {}
          }
        }
      }
    } catch (err) {
      console.warn("Serial read loop terminated:", err);
    } finally {
      reader.releaseLock();
      await readableStreamClosed.catch(() => {});
    }
  };

  const processTelemetry = (data) => {
    const timestamp = Date.now();
    const timeFormatted = new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const newReading = {
      ...data,
      pressure: data.pressure !== undefined ? Number(data.pressure) : 1013.2,
      bmp_ok: data.bmp_ok !== undefined ? data.bmp_ok : 1,
      pdrop: data.pdrop !== undefined ? Number(data.pdrop) : 0.0,
      ius: data.ius !== undefined ? Number(data.ius) : 0,
      buzzer: data.buzzer !== undefined ? data.buzzer : 0,
      ts: timestamp,
      timeStr: timeFormatted,
    };

    setLatest(newReading);

    if (data.th_temp !== undefined) {
      setAppliedThresholds({
        temp: Number(data.th_temp),
        soil: Number(data.th_soil),
        water: Number(data.th_water),
        ldr: Number(data.th_ldr),
        ius: data.th_ius !== undefined ? Number(data.th_ius) : appliedThresholds.ius,
      });
    }

    setHistory((prev) => {
      const updated = [...prev, newReading];
      if (updated.length > MAX_HISTORY_POINTS) {
        return updated.slice(updated.length - MAX_HISTORY_POINTS);
      }
      return updated;
    });
  };

  // -------------------------------------------------------------
  // Demo / Simulation Mode
  // -------------------------------------------------------------
  useEffect(() => {
    if (!isDemoMode) return;

    let soilSim = 580;
    let tempSim = 29.0;
    let humSim = 55.0;
    let waterSim = 320;
    let ldrSim = 380;
    let uvSim = 15;
    let pressureSim = 1012.5;

    const interval = setInterval(() => {
      soilSim += (Math.random() - 0.46) * 16;
      tempSim += (Math.random() - 0.5) * 0.4;
      humSim += (Math.random() - 0.5) * 1.5;
      waterSim -= Math.random() * 2;
      if (waterSim < 80) waterSim = 450;
      ldrSim += (Math.random() - 0.5) * 30;
      pressureSim += (Math.random() - 0.52) * 0.3;

      soilSim = Math.max(120, Math.min(950, Math.round(soilSim)));
      tempSim = Math.max(16, Math.min(42, Number(tempSim.toFixed(1))));
      humSim = Math.max(20, Math.min(95, Math.round(humSim)));
      waterSim = Math.max(20, Math.min(700, Math.round(waterSim)));
      ldrSim = Math.max(50, Math.min(900, Math.round(ldrSim)));
      uvSim = Math.round(Math.random() * 25 + 5);
      pressureSim = Number(pressureSim.toFixed(1));

      const soil_norm = Math.min(1.0, Math.max(0.0, (1023 - soilSim) / 750));
      const temp_norm = Math.min(1.0, Math.max(0.0, (tempSim - 15) / 25));
      const hum_norm = Math.min(1.0, Math.max(0.0, humSim / 100));
      const uv_norm = Math.min(1.0, Math.max(0.0, (uvSim * 5.0 / 102.3) / 10));
      const daylight_penalty = ldrSim > 650 ? 0.65 : 1.0;

      let iusCalc =
        0.50 * (1.0 - soil_norm) +
        0.20 * temp_norm -
        0.10 * hum_norm -
        0.10 * 0.0 +
        0.10 * uv_norm * daylight_penalty;

      iusCalc = Math.min(1.0, Math.max(0.0, Number(iusCalc.toFixed(3))));

      const ledWater = iusCalc >= appliedThresholds.ius ? 1 : 0;
      const ledLight = ldrSim < appliedThresholds.ldr ? 1 : 0;
      const fan = tempSim > appliedThresholds.temp ? 1 : 0;
      const buzzer = waterSim < appliedThresholds.water ? 1 : 0;

      const packet = {
        uv: uvSim,
        ldr: ldrSim,
        soil: soilSim,
        water: waterSim,
        temp: tempSim,
        hum: humSim,
        pressure: pressureSim,
        bmp_ok: 1,
        pdrop: -0.2,
        dht_ok: 1,
        ius: iusCalc,
        fan: fan,
        fan_pwm: fan ? 210 : 0,
        led_water: ledWater,
        led_light: ledLight,
        buzzer: buzzer,
        th_temp: appliedThresholds.temp,
        th_soil: appliedThresholds.soil,
        th_water: appliedThresholds.water,
        th_ldr: appliedThresholds.ldr,
        th_ius: appliedThresholds.ius,
      };

      processTelemetry(packet);
      addLog(JSON.stringify(packet), "in");
    }, 1200);

    return () => clearInterval(interval);
  }, [isDemoMode, appliedThresholds]);

  const handleDemoCommand = (cmd) => {
    if (cmd.startsWith("SET_ALL:")) {
      const parts = cmd.substring(8).split(",");
      if (parts.length >= 4) {
        setAppliedThresholds({
          temp: parseFloat(parts[0]),
          soil: parseInt(parts[1]),
          water: parseInt(parts[2]),
          ldr: parseInt(parts[3]),
          ius: parts[4] !== undefined ? parseFloat(parts[4]) : appliedThresholds.ius,
        });
      }
    } else if (cmd === "RESET") {
      setAppliedThresholds({ ...FALLBACK_THRESHOLDS });
      setThresholds({ ...FALLBACK_THRESHOLDS });
    }
  };

  const applyThresholdsToArduino = (targetThresholds = thresholds) => {
    const cmd = `SET_ALL:${targetThresholds.temp},${targetThresholds.soil},${targetThresholds.water},${targetThresholds.ldr},${targetThresholds.ius}`;
    sendSerialCommand(cmd);
    setAppliedThresholds({ ...targetThresholds });
  };

  const resetToFallbackThresholds = () => {
    setThresholds({ ...FALLBACK_THRESHOLDS });
    setAppliedThresholds({ ...FALLBACK_THRESHOLDS });
    sendSerialCommand("RESET");
  };

  const handleManualOverride = (actuator, mode) => {
    sendSerialCommand(`${actuator}:${mode}`);
  };

  const isWateringPlants = (latest.ius !== undefined ? latest.ius : 0) >= appliedThresholds.ius || latest.led_water === 1;
  const isLowIntensityLight = latest.ldr < appliedThresholds.ldr || latest.led_light === 1;
  const isFanTriggered = latest.temp > appliedThresholds.temp;
  const isTankLowTriggered = latest.water < appliedThresholds.water || latest.buzzer === 1;

  return (
    <div className="app-container">
      {/* Header */}
      <header className="header">
        <div className="header-titles">
          <div className="title-row">
            <h1>AquaSense</h1>
            <span className="badge-chip">Arduino 5V Direct Link</span>
            <span className="badge-ml">ML Enabled</span>
          </div>
          <p className="subtitle">
            Smart irrigation & climate prediction &bull; BMP280 Barometer &bull; USB Serial (9600 Baud)
          </p>
        </div>

        <div className="header-actions">
          {isConnected ? (
            <button className="btn btn-disconnect" onClick={disconnectArduino}>
              <span className="dot dot-live" /> Disconnect Arduino
            </button>
          ) : (
            <button className="btn btn-connect" onClick={connectArduino}>
              <span className="dot dot-off" /> Connect Arduino (USB)
            </button>
          )}

          <button
            className={`btn btn-secondary ${isDemoMode ? "active-demo" : ""}`}
            onClick={() => {
              if (isConnected) disconnectArduino();
              setIsDemoMode(!isDemoMode);
              if (!isDemoMode) addLog("Demo simulation mode started", "sys");
            }}
          >
            {isDemoMode ? "Stop Demo" : "Simulate Demo Mode"}
          </button>
        </div>
      </header>

      {/* Connection Status Banner */}
      <div className={`status-banner ${isConnected ? "banner-online" : isDemoMode ? "banner-demo" : "banner-offline"}`}>
        <div className="banner-content">
          <strong>Connection Status: </strong>
          {isConnected && "Connected to Arduino Uno/Nano via Web Serial (9600 Baud) - Streaming live"}
          {isDemoMode && "Simulated Device Mode Active - Generating live sensor & BMP280 stream"}
          {!isConnected && !isDemoMode && "Disconnected. Plug Arduino into USB and click 'Connect Arduino (USB)' or run 'Simulate Demo Mode'."}
        </div>
        <button className="btn-link" onClick={() => setShowConsole(!showConsole)}>
          {showConsole ? "Hide Serial Console" : "Show Serial Console"}
        </button>
      </div>

      {/* Collapsible Serial Console */}
      {showConsole && (
        <section className="console-panel">
          <div className="console-header">
            <h4>Arduino Serial Monitor (9600 Baud)</h4>
            <button className="btn-small" onClick={() => setSerialLogs([])}>Clear</button>
          </div>
          <div className="console-logs">
            {serialLogs.length === 0 ? (
              <div className="console-empty">No serial traffic yet. Connect to Arduino to monitor.</div>
            ) : (
              serialLogs.map((log, i) => (
                <div key={i} className={`log-entry log-${log.dir}`}>
                  <span className="log-time">[{log.time}]</span>{" "}
                  <span className="log-arrow">{log.dir === "out" ? "▲ TX:" : log.dir === "err" ? "✖ ERR:" : "▼ RX:"}</span>{" "}
                  <span className="log-text">{log.text}</span>
                </div>
              ))
            )}
          </div>
          <form
            className="console-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (customCmd.trim()) {
                sendSerialCommand(customCmd.trim());
                setCustomCmd("");
              }
            }}
          >
            <input
              type="text"
              placeholder="Send Serial command (e.g. RESET, SET:IUS=0.50, FAN:ON)..."
              value={customCmd}
              onChange={(e) => setCustomCmd(e.target.value)}
            />
            <button type="submit" className="btn btn-primary">Send</button>
          </form>
        </section>
      )}

      {/* ------------------------------------------------------------- */}
      {/* ML PREDICTIONS & SCENARIO COMPARATOR PANEL */}
      {/* ------------------------------------------------------------- */}
      <section className="card ml-prediction-section">
        <div className="ml-header-row">
          <div>
            <div className="badge-small">Machine Learning & Forecast Center</div>
            <h3>Environmental & Irrigation Predictions</h3>
            <p className="card-hint">
              Evaluate real-time forecasts using live sensors OR simulate custom environmental conditions.
            </p>
          </div>

          {/* Option Selector: Sensor vs Custom User Input */}
          <div className="mode-toggle-group">
            <button
              className={`mode-btn ${predictOption === "sensor" ? "mode-btn-active" : ""}`}
              onClick={() => setPredictOption("sensor")}
            >
              <span className="mode-dot dot-live" /> Option 1: Using Live Sensors
            </button>
            <button
              className={`mode-btn ${predictOption === "custom" ? "mode-btn-active" : ""}`}
              onClick={() => setPredictOption("custom")}
            >
              ⚙ Option 2: User Input Simulator
            </button>
          </div>
        </div>

        {/* User Input Simulator Controls (Shown when Option 2 is selected) */}
        {predictOption === "custom" && (
          <div className="scenario-builder-box">
            <div className="scenario-presets-row">
              <span className="preset-label">Test Preset Weather Scenarios:</span>
              <button className="btn-preset" onClick={() => loadScenarioPreset("storm")}>⛈ Approaching Storm</button>
              <button className="btn-preset" onClick={() => loadScenarioPreset("heatwave")}>☀️ Scorching Heatwave</button>
              <button className="btn-preset" onClick={() => loadScenarioPreset("saturated")}>🌧 Post-Rain Saturated</button>
              <button className="btn-preset" onClick={() => loadScenarioPreset("drought")}>🌵 Severe Drought</button>
            </div>

            <div className="scenario-inputs-grid">
              <div className="input-group">
                <label>Air Temp: <strong>{customInput.temp} °C</strong></label>
                <input
                  type="range" min="10" max="45" step="0.5" value={customInput.temp}
                  onChange={(e) => setCustomInput({ ...customInput, temp: parseFloat(e.target.value) })}
                />
              </div>

              <div className="input-group">
                <label>Relative Humidity: <strong>{customInput.hum} %</strong></label>
                <input
                  type="range" min="15" max="98" step="1" value={customInput.hum}
                  onChange={(e) => setCustomInput({ ...customInput, hum: parseFloat(e.target.value) })}
                />
              </div>

              <div className="input-group">
                <label>Pressure: <strong>{customInput.pressure} hPa</strong></label>
                <input
                  type="range" min="970" max="1035" step="0.5" value={customInput.pressure}
                  onChange={(e) => setCustomInput({ ...customInput, pressure: parseFloat(e.target.value) })}
                />
              </div>

              <div className="input-group">
                <label>3h Pressure Change (&Delta;P): <strong>{customInput.dp3 > 0 ? `+${customInput.dp3}` : customInput.dp3} hPa</strong></label>
                <input
                  type="range" min="-6.0" max="4.0" step="0.2" value={customInput.dp3}
                  onChange={(e) => setCustomInput({ ...customInput, dp3: parseFloat(e.target.value) })}
                />
              </div>

              <div className="input-group">
                <label>Soil Moisture: <strong>{customInput.soil} %</strong></label>
                <input
                  type="range" min="5" max="95" step="1" value={customInput.soil}
                  onChange={(e) => setCustomInput({ ...customInput, soil: parseFloat(e.target.value) })}
                />
              </div>

              <div className="input-group">
                <label>UV Index: <strong>{customInput.uv}</strong></label>
                <input
                  type="range" min="0" max="12" step="0.5" value={customInput.uv}
                  onChange={(e) => setCustomInput({ ...customInput, uv: parseFloat(e.target.value) })}
                />
              </div>

              <div className="input-group">
                <label>Sunlight (LDR): <strong>{customInput.light} %</strong></label>
                <input
                  type="range" min="0" max="100" step="1" value={customInput.light}
                  onChange={(e) => setCustomInput({ ...customInput, light: parseFloat(e.target.value) })}
                />
              </div>
            </div>
          </div>
        )}

        {/* Prediction Results Cards */}
        <div className="prediction-results-grid">
          {/* 1. Rain Forecast */}
          <div className="pred-card">
            <span className="pred-label">Rain in Next 6 Hours</span>
            <div className="pred-val-row">
              <span className="pred-number">{Math.round(prediction.rain_prob)}%</span>
              <span className={`pred-status-badge ${prediction.rain_prob >= 70 ? "badge-rain-high" : prediction.rain_prob >= 40 ? "badge-rain-mid" : "badge-rain-low"}`}>
                {prediction.outlook}
              </span>
            </div>
            <div className="meter-bar">
              <div className="meter-fill" style={{ width: `${prediction.rain_prob}%`, background: "var(--rain)" }} />
            </div>
            <span className="pred-footer">
              {prediction.rain_prob >= 60 ? "💡 Postponing planned watering (rain expected)" : "✓ Normal irrigation schedule applies"}
            </span>
          </div>

          {/* 2. 6-Hour Temperature Forecast */}
          <div className="pred-card">
            <span className="pred-label">6h Temperature Forecast</span>
            <div className="pred-val-row">
              <span className="pred-number">{prediction.temp_6h} °C</span>
              <span className="pred-tag-neutral">
                {prediction.temp_6h > (predictOption === "sensor" ? latest.temp : customInput.temp) ? "▲ Warming" : "▼ Cooling"}
              </span>
            </div>
            <span className="pred-subtext">RandomForest Regressor (MAE: 1.34 °C)</span>
            <span className="pred-footer">
              {prediction.temp_6h > appliedThresholds.temp ? "⚠ Expected to trigger cooling fan" : "✓ Within safe temperature bounds"}
            </span>
          </div>

          {/* 3. Soil Drying & Time to Critical */}
          <div className="pred-card">
            <span className="pred-label">Soil Moisture Depletion</span>
            <div className="pred-val-row">
              <span className="pred-number">{prediction.soil_rate} <small style={{ fontSize: "0.85rem" }}>%/hr</small></span>
              <span className="pred-tag-neutral">24h Forecast: {prediction.soil_24h}%</span>
            </div>
            <span className="pred-subtext">
              {prediction.hours_to_dry === 0 ? "At or below critical 35% trigger now!" : `Estimated ~${prediction.hours_to_dry} hrs until watering level`}
            </span>
            <span className="pred-footer">
              {prediction.hours_to_dry === 0 ? "💧 Irrigation urgently required" : `Soil depletes at ${Math.abs(prediction.soil_rate)}% per hour`}
            </span>
          </div>

          {/* 4. Crop Stress & IUS Impact */}
          <div className="pred-card">
            <span className="pred-label">Crop Stress & Urgency (IUS)</span>
            <div className="pred-val-row">
              <span className="pred-number">{Number(prediction.ius).toFixed(2)}</span>
              <span className={`pred-status-badge ${prediction.stress === "Stressed" ? "badge-stress-bad" : prediction.stress === "Watch" ? "badge-stress-mid" : "badge-stress-ok"}`}>
                {prediction.stress}
              </span>
            </div>
            <div className="meter-bar">
              <div
                className="meter-fill"
                style={{
                  width: `${Math.min(100, prediction.ius * 100)}%`,
                  background: prediction.ius >= appliedThresholds.ius ? "var(--bad)" : "var(--leaf)",
                }}
              />
            </div>
            <span className="pred-footer">
              {prediction.ius >= appliedThresholds.ius ? "LED 1 activates (Watering Triggered)" : "Soil & atmosphere stable"}
            </span>
          </div>
        </div>

        <div className="model-source-footer">
          <span>
            Mode: <strong>{predictOption === "sensor" ? "Real-time Telemetry Input" : "User Scenario Simulator"}</strong> &bull;
            Models: <code>{prediction.methods?.join(", ") || "Active ML"}</code> &bull;
            Evaluation Source: <strong>{prediction.source === "backend" ? "FastAPI Server ML (.joblib)" : "In-Browser Heuristic Fallback"}</strong>
          </span>
        </div>
      </section>

      {/* IUS Decision Formula Banner */}
      <section className="card ius-formula-banner">
        <div className="ius-banner-header">
          <div>
            <span className="badge-small">Irrigation Decision Logic</span>
            <h3>Weighted Irrigation Urgency Score (IUS)</h3>
            <p className="formula-text">
              <code>IUS = 0.50*(1 - soil_norm) + 0.20*(temp_norm) - 0.10*(hum_norm) - 0.10*(pressure_drop_rate) + 0.10*(uv_norm) * daylight_penalty</code>
            </p>
          </div>
          <div className="ius-score-box">
            <span className="ius-score-label">Active IUS Score</span>
            <span className={`ius-score-number ${isWateringPlants ? "score-watering" : "score-normal"}`}>
              {Number(latest.ius ?? 0).toFixed(2)}
            </span>
            <span className="ius-threshold-sub">Trigger Level: &ge; {appliedThresholds.ius.toFixed(2)}</span>
          </div>
        </div>

        <div className="meter-bar ius-meter-bar">
          <div
            className="meter-fill"
            style={{
              width: `${Math.min(100, (latest.ius ?? 0) * 100)}%`,
              background: isWateringPlants ? "var(--rain)" : "var(--leaf)",
            }}
          />
        </div>
      </section>

      {/* Main Grid: Actuators + Threshold Controls */}
      <div className="control-grid">
        {/* ACTUATOR FEEDBACK PANEL */}
        <section className="card actuator-panel">
          <h3>Actuators & Indicator Status</h3>
          <p className="card-hint">
            Direct feedback from Arduino pins (LED 1 Pin 9, LED 2 Pin 8, Motor Pins 5, 6, 7)
          </p>

          <div className="actuator-cards">
            {/* LED 1: Plant Watering Indicator (Pin 9) */}
            <div className={`actuator-card ${isWateringPlants ? "state-active-water" : "state-idle"}`}>
              <div className="actuator-header">
                <span className="pin-tag">LED 1 &bull; Pin 9</span>
                <span className="actuator-title">Watering Plants Indicator</span>
              </div>
              <div className="indicator-glow">
                <div className={`led-bulb ${isWateringPlants ? "glow-blue" : ""}`} />
                <div>
                  <div className="actuator-status-text">
                    {isWateringPlants ? "GLOWING: WATERING PLANTS" : "OFF: MOISTURE ADEQUATE"}
                  </div>
                  <div className="actuator-subtext">
                    {isWateringPlants
                      ? `IUS Score (${Number(latest.ius).toFixed(2)}) >= Threshold (${appliedThresholds.ius.toFixed(2)})`
                      : `Urgency score is safe (below ${appliedThresholds.ius.toFixed(2)})`}
                  </div>
                </div>
              </div>
              <div className="override-buttons">
                <button className="btn-pill" onClick={() => handleManualOverride("LED_WATER", "ON")}>On</button>
                <button className="btn-pill" onClick={() => handleManualOverride("LED_WATER", "OFF")}>Off</button>
                <button className="btn-pill" onClick={() => handleManualOverride("LED_WATER", "AUTO")}>Auto</button>
              </div>
            </div>

            {/* LED 2: Low-Intensity Light Indicator (Pin 8) */}
            <div className={`actuator-card ${isLowIntensityLight ? "state-active-light" : "state-idle"}`}>
              <div className="actuator-header">
                <span className="pin-tag">LED 2 &bull; Pin 8</span>
                <span className="actuator-title">Low-Light Indicator (LDR)</span>
              </div>
              <div className="indicator-glow">
                <div className={`led-bulb ${isLowIntensityLight ? "glow-amber" : ""}`} />
                <div>
                  <div className="actuator-status-text">
                    {isLowIntensityLight ? "GLOWING: LOW INTENSITY LIGHT" : "OFF: SUFFICIENT DAYLIGHT"}
                  </div>
                  <div className="actuator-subtext">
                    {isLowIntensityLight
                      ? `LDR Reading (${latest.ldr}) < Threshold (${appliedThresholds.ldr})`
                      : `Sufficient ambient light detected by LDR (A3)`}
                  </div>
                </div>
              </div>
              <div className="override-buttons">
                <button className="btn-pill" onClick={() => handleManualOverride("LED_LIGHT", "ON")}>On</button>
                <button className="btn-pill" onClick={() => handleManualOverride("LED_LIGHT", "OFF")}>Off</button>
                <button className="btn-pill" onClick={() => handleManualOverride("LED_LIGHT", "AUTO")}>Auto</button>
              </div>
            </div>

            {/* MOTOR: Ventilation Cooling Fan */}
            <div className={`actuator-card ${latest.fan ? "state-active-fan" : "state-idle"}`}>
              <div className="actuator-header">
                <span className="pin-tag">Motor &bull; Pins 5, 6, 7</span>
                <span className="actuator-title">Cooling Fan</span>
              </div>
              <div className="indicator-glow">
                <div className={`fan-icon-wrapper ${latest.fan ? "fan-spinning" : ""}`}>
                  <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor">
                    <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8zm1-9.5V5h-2v5.5A2.5 2.5 0 0 0 8.5 13H3v2h5.5A2.5 2.5 0 0 0 11 17.5V23h2v-5.5A2.5 2.5 0 0 0 15.5 15H21v-2h-5.5A2.5 2.5 0 0 0 13 10.5z" />
                  </svg>
                </div>
                <div>
                  <div className="actuator-status-text">
                    {latest.fan ? `FAN RUNNING (${latest.fan_pwm ? Math.round((latest.fan_pwm / 255) * 100) : 82}%)` : "FAN OFF"}
                  </div>
                  <div className="actuator-subtext">
                    {isFanTriggered ? `Temp (${latest.temp}°C) > Threshold (${appliedThresholds.temp}°C)` : "Temperature within normal bounds"}
                  </div>
                </div>
              </div>
              <div className="override-buttons">
                <button className="btn-pill" onClick={() => handleManualOverride("FAN", "ON")}>On</button>
                <button className="btn-pill" onClick={() => handleManualOverride("FAN", "OFF")}>Off</button>
                <button className="btn-pill" onClick={() => handleManualOverride("FAN", "AUTO")}>Auto</button>
              </div>
            </div>

            {/* BUZZER: Low Water Tank Alarm */}
            <div className={`actuator-card ${isTankLowTriggered ? "state-active-buzzer" : "state-idle"}`}>
              <div className="actuator-header">
                <span className="pin-tag">Buzzer &bull; Pin 3</span>
                <span className="actuator-title">Tank Low Alarm Buzzer</span>
              </div>
              <div className="indicator-glow">
                <div className={`buzzer-icon-wrapper ${isTankLowTriggered ? "buzzer-alarming" : ""}`}>
                  <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor">
                    <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6zM7.58 4.08L6.15 2.65C3.75 4.48 2.17 7.3 2.03 10.5h2c.15-2.65 1.51-4.97 3.55-6.42zm12.04 6.42h2c-.15-3.2-1.73-6.02-4.12-7.85l-1.42 1.43c2.03 1.45 3.39 3.77 3.54 6.42z" />
                  </svg>
                </div>
                <div>
                  <div className="actuator-status-text">
                    {isTankLowTriggered ? "BUZZER ALARM HIGH (ACTIVE)" : "BUZZER OFF (NORMAL)"}
                  </div>
                  <div className="actuator-subtext">
                    {isTankLowTriggered
                      ? `Tank Level (${latest.water}) < Threshold (${appliedThresholds.water}) &bull; Pin 3 HIGH`
                      : "Water reservoir safe &bull; Buzzer Pin 3 LOW"}
                  </div>
                </div>
              </div>
              <div className="override-buttons">
                <button className="btn-pill" onClick={() => handleManualOverride("BUZZER", "ON")}>On</button>
                <button className="btn-pill" onClick={() => handleManualOverride("BUZZER", "OFF")}>Off</button>
                <button className="btn-pill" onClick={() => handleManualOverride("BUZZER", "AUTO")}>Auto</button>
              </div>
            </div>
          </div>
        </section>

        {/* THRESHOLD CONFIGURATION PANEL */}
        <section className="card threshold-panel">
          <div className="threshold-title-row">
            <div>
              <h3>User-Defined Thresholds</h3>
              <p className="card-hint">
                Configure triggering setpoints live. Safe fallback values are automatically used if unconfigured.
              </p>
            </div>
            <button className="btn btn-small" onClick={resetToFallbackThresholds} title="Reset to default fallback values">
              ↺ Reset to Fallbacks
            </button>
          </div>

          <div className="threshold-inputs">
            {/* IUS Watering Threshold */}
            <div className="threshold-row">
              <div className="threshold-label-wrap">
                <label>
                  Irrigation Urgency Score (IUS) Trigger:
                  <span className="current-badge">Current: <strong>{Number(latest.ius ?? 0).toFixed(2)}</strong></span>
                </label>
                <span className={`trigger-tag ${isWateringPlants ? "tag-rain" : "tag-ok"}`}>
                  {isWateringPlants ? "Watering (LED1 ON)" : "Adequate"}
                </span>
              </div>
              <div className="slider-box">
                <input
                  type="range" min="0.10" max="0.90" step="0.05" value={thresholds.ius}
                  onChange={(e) => setThresholds({ ...thresholds, ius: parseFloat(e.target.value) })}
                />
                <input
                  type="number" step="0.05" className="num-input" value={thresholds.ius}
                  onChange={(e) => setThresholds({ ...thresholds, ius: parseFloat(e.target.value) || 0 })}
                />
              </div>
              <span className="field-hint">
                When IUS &ge; <strong>{thresholds.ius.toFixed(2)}</strong>, LED 1 (Pin 9) glows for watering. Fallback: {FALLBACK_THRESHOLDS.ius}.
              </span>
            </div>

            {/* LDR Low-Light Threshold */}
            <div className="threshold-row">
              <div className="threshold-label-wrap">
                <label>
                  Low-Light Intensity Trigger (LDR Pin A3):
                  <span className="current-badge">Current: <strong>{latest.ldr}</strong></span>
                </label>
                <span className={`trigger-tag ${isLowIntensityLight ? "tag-warn" : "tag-ok"}`}>
                  {isLowIntensityLight ? "Low Light (LED2 ON)" : "Daylight"}
                </span>
              </div>
              <div className="slider-box">
                <input
                  type="range" min="100" max="800" step="10" value={thresholds.ldr}
                  onChange={(e) => setThresholds({ ...thresholds, ldr: parseInt(e.target.value) })}
                />
                <input
                  type="number" className="num-input" value={thresholds.ldr}
                  onChange={(e) => setThresholds({ ...thresholds, ldr: parseInt(e.target.value) || 0 })}
                />
              </div>
              <span className="field-hint">
                LDR reading below <strong>{thresholds.ldr}</strong> triggers LED 2 (Pin 8) to glow. Fallback: {FALLBACK_THRESHOLDS.ldr}.
              </span>
            </div>

            {/* Fan Temperature Threshold */}
            <div className="threshold-row">
              <div className="threshold-label-wrap">
                <label>
                  Cooling Fan Temp Trigger (°C):
                  <span className="current-badge">Current: <strong>{latest.temp} °C</strong></span>
                </label>
                <span className={`trigger-tag ${isFanTriggered ? "tag-warn" : "tag-ok"}`}>
                  {isFanTriggered ? "Fan ON" : "Fan Idle"}
                </span>
              </div>
              <div className="slider-box">
                <input
                  type="range" min="20.0" max="45.0" step="0.5" value={thresholds.temp}
                  onChange={(e) => setThresholds({ ...thresholds, temp: parseFloat(e.target.value) })}
                />
                <input
                  type="number" step="0.5" className="num-input" value={thresholds.temp}
                  onChange={(e) => setThresholds({ ...thresholds, temp: parseFloat(e.target.value) || 0 })}
                />
              </div>
              <span className="field-hint">
                Temperatures above <strong>{thresholds.temp} °C</strong> activate the cooling motor (Pins 5, 6, 7). Fallback: {FALLBACK_THRESHOLDS.temp} °C.
              </span>
            </div>

            {/* Water Tank Low Threshold */}
            <div className="threshold-row">
              <div className="threshold-label-wrap">
                <label>
                  Water Tank Low Trigger (Pin A2):
                  <span className="current-badge">Current: <strong>{latest.water}</strong></span>
                </label>
                <span className={`trigger-tag ${isTankLowTriggered ? "tag-bad" : "tag-ok"}`}>
                  {isTankLowTriggered ? "Tank Low" : "Tank OK"}
                </span>
              </div>
              <div className="slider-box">
                <input
                  type="range" min="50" max="500" step="10" value={thresholds.water}
                  onChange={(e) => setThresholds({ ...thresholds, water: parseInt(e.target.value) })}
                />
                <input
                  type="number" className="num-input" value={thresholds.water}
                  onChange={(e) => setThresholds({ ...thresholds, water: parseInt(e.target.value) || 0 })}
                />
              </div>
              <span className="field-hint">
                Tank level below <strong>{thresholds.water}</strong> indicates low reservoir. Fallback: {FALLBACK_THRESHOLDS.water}.
              </span>
            </div>

            <div className="apply-btn-wrap">
              <button className="btn btn-primary btn-block" onClick={() => applyThresholdsToArduino(thresholds)}>
                ✓ Apply Thresholds to Arduino
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* SENSOR OVERVIEW STATS CARDS */}
      <section className="stats-row">
        <div className="stat-card">
          <span className="stat-label">Barometric Pressure (BMP280)</span>
          <div className="stat-value">{latest.pressure} <span className="stat-unit">hPa</span></div>
          <span className={`stat-footer ${latest.bmp_ok ? "text-ok" : "text-warn"}`}>
            {latest.bmp_ok ? "✓ BMP280 Sensor Online" : "⚠ Fallback (1013.2 hPa)"}
          </span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Irrigation Urgency (IUS)</span>
          <div className="stat-value">{Number(latest.ius ?? 0).toFixed(2)}</div>
          <span className="stat-footer">{isWateringPlants ? "💧 Plants Being Watered" : "✓ Optimal Moisture"}</span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Soil Moisture (A1)</span>
          <div className="stat-value">{latest.soil} <span className="stat-unit">ADC</span></div>
          <span className="stat-footer">Normalized: {(1 - Math.min(1, Math.max(0, (1023 - latest.soil) / 750))).toFixed(2)} Dryness</span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Temperature (DHT11)</span>
          <div className="stat-value">{latest.temp} <span className="stat-unit">°C</span></div>
          <span className="stat-footer">{latest.dht_ok ? (isFanTriggered ? "Cooling Fan Active" : "Normal Temp") : "DHT11 fallback active"}</span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Humidity (DHT11)</span>
          <div className="stat-value">{latest.hum} <span className="stat-unit">%</span></div>
          <span className="stat-footer">Relative air moisture</span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Ambient Light (A3)</span>
          <div className="stat-value">{latest.ldr} <span className="stat-unit">ADC</span></div>
          <span className="stat-footer">{isLowIntensityLight ? "🌙 Low Light (LED 2 Glowing)" : "☀ Daylight"}</span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Water Tank Level (A2)</span>
          <div className="stat-value">{latest.water} <span className="stat-unit">ADC</span></div>
          <span className="stat-footer">{isTankLowTriggered ? "⚠ Level Low - Refill" : "✓ Reservoir Safe"}</span>
        </div>
      </section>

      {/* REAL-TIME CHARTS GRID */}
      <h3 className="section-title">Live Sensor & Urgency Telemetry Graphs</h3>
      <div className="charts-grid">
        {/* IUS Graph */}
        <div className="chart-box">
          <div className="chart-heading">
            <h4>Irrigation Urgency Score (IUS) vs. Watering Level</h4>
            <span className="chart-tag">IUS Decision</span>
          </div>
          <p className="chart-sub">
            Calculated score. LED 1 (Pin 9) glows when curve crosses above the blue dashed watering threshold line.
          </p>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={history} margin={{ top: 10, right: 15, left: -15, bottom: 0 }}>
              <CartesianGrid stroke="var(--rule)" strokeDasharray="3 3" />
              <XAxis dataKey="timeStr" tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 1]} tick={{ fontSize: 11 }} />
              <Tooltip />
              <ReferenceLine
                y={appliedThresholds.ius}
                stroke="var(--rain)"
                strokeDasharray="4 4"
                label={{ value: `Watering Level (${appliedThresholds.ius.toFixed(2)})`, fill: "var(--rain)", fontSize: 11, position: "insideTopRight" }}
              />
              <Line type="monotone" dataKey="ius" name="Irrigation Urgency (IUS)" stroke="var(--rain)" strokeWidth={2.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Barometric Pressure (BMP280) Graph */}
        <div className="chart-box">
          <div className="chart-heading">
            <h4>Atmospheric Pressure (BMP280)</h4>
            <span className="chart-tag">I2C Pin A4/A5</span>
          </div>
          <p className="chart-sub">
            Continuous pressure tracking. Sudden drops indicate oncoming storm/rain front.
          </p>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={history} margin={{ top: 10, right: 15, left: -15, bottom: 0 }}>
              <CartesianGrid stroke="var(--rule)" strokeDasharray="3 3" />
              <XAxis dataKey="timeStr" tick={{ fontSize: 11 }} />
              <YAxis domain={["auto", "auto"]} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="pressure" name="Pressure (hPa)" stroke="var(--leaf)" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Temperature & Humidity Chart */}
        <div className="chart-box">
          <div className="chart-heading">
            <h4>Air Temperature (°C) & Humidity (%)</h4>
            <span className="chart-tag">DHT11 Pin 4</span>
          </div>
          <p className="chart-sub">
            Orange dashed line marks the fan trigger temperature (Pins 5, 6, 7 active above line).
          </p>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={history} margin={{ top: 10, right: 15, left: -15, bottom: 0 }}>
              <CartesianGrid stroke="var(--rule)" strokeDasharray="3 3" />
              <XAxis dataKey="timeStr" tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 60]} tick={{ fontSize: 11 }} />
              <Tooltip />
              <ReferenceLine
                y={appliedThresholds.temp}
                stroke="var(--sun)"
                strokeDasharray="4 4"
                label={{ value: `Fan ON (${appliedThresholds.temp}°C)`, fill: "var(--sun)", fontSize: 11, position: "insideTopRight" }}
              />
              <Line type="monotone" dataKey="temp" name="Temperature (°C)" stroke="var(--sun)" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="hum" name="Humidity (%)" stroke="var(--leaf)" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Ambient Light LDR Chart */}
        <div className="chart-box">
          <div className="chart-heading">
            <h4>Ambient Light Intensity vs. Low-Light Threshold</h4>
            <span className="chart-tag">LDR Pin A3</span>
          </div>
          <p className="chart-sub">
            Amber dashed line marks the low-light threshold. LED 2 (Pin 8) glows when reading drops below this line.
          </p>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={history} margin={{ top: 10, right: 15, left: -15, bottom: 0 }}>
              <CartesianGrid stroke="var(--rule)" strokeDasharray="3 3" />
              <XAxis dataKey="timeStr" tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 1023]} tick={{ fontSize: 11 }} />
              <Tooltip />
              <ReferenceLine
                y={appliedThresholds.ldr}
                stroke="var(--sun)"
                strokeDasharray="4 4"
                label={{ value: `Low Light (${appliedThresholds.ldr})`, fill: "var(--sun)", fontSize: 11, position: "insideTopRight" }}
              />
              <Line type="monotone" dataKey="ldr" name="LDR Light" stroke="var(--sun)" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Footer */}
      <footer className="footer">
        <p>
          AquaSense 5V Arduino Direct Link &bull; BMP280 with automatic fallback &bull; ML predictions with Live Sensor & User Scenario simulator &bull; IUS weighted calculation engine.
        </p>
      </footer>
    </div>
  );
}
