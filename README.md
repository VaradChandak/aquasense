# AquaSense — 5V Arduino Smart Irrigation & Climate Control

```
Sensors (Soil, UV, LDR, Water, DHT11) ─► Arduino Uno/Nano (5V)
                                                │
                                    (Direct USB Serial @ 9600 Baud / Web Serial API)
                                                ▼
                                    React Dashboard & Control Center
                                    - Real-time Telemetry & Rolling Graphs
                                    - User-Configurable Thresholds
                                    - Fallback Safe Values
                                    - Actuator States (LED 8, LED 9, Cooling Fan)
```

AquaSense runs directly on a 5V **Arduino Uno / Nano** connected via USB Serial (9600 baud) to the modern React frontend. **Blynk has been completely removed**, enabling 100% offline, cloud-free, zero-subscription real-time monitoring and control with direct browser-to-hardware communication via the Web Serial API.

---

## Hardware Pinout (Arduino Uno / Nano - 5V)

| Component | Pin | Function / Type | Notes |
|---|---|---|---|
| **Buzzer** | Digital Pin 3 | Low Tank Alarm | Goes HIGH when tank water drops below threshold (`waterValue < waterThreshold`) |
| **DHT11** | Digital Pin 4 | Temperature & Humidity | Uses `<DHT.h>` |
| **UV Sensor** | Analog Pin A0 | GUVA-S12SD UV Index | 0–1023 ADC |
| **Soil Moisture** | Analog Pin A1 | Soil Moisture Sensor | High ADC = Dry soil, Low ADC = Wet soil |
| **Water Level** | Analog Pin A2 | Tank Reservoir Level | High ADC = Full tank, Low ADC = Empty tank |
| **LDR Sensor** | Analog Pin A3 | Ambient Daylight | 0–1023 ADC |
| **BMP280 (SDA)** | Analog Pin A4 | Barometric Pressure I2C | Hardware I2C SDA (0x76 / 0x77); automatic fallback if missing |
| **BMP280 (SCL)** | Analog Pin A5 | Barometric Pressure I2C | Hardware I2C SCL |
| **LED 1 (Watering)** | Digital Pin 9 | Soil Watering Indicator | Glows during watering plants when IUS reaches threshold |
| **LED 2 (Low Light)** | Digital Pin 8 | Low-Light Indicator (LDR) | Glows when low intensity of light is detected (LDR < threshold) |
| **Motor Enable (EN)** | Digital Pin 5 | PWM Fan Speed (0–255) | Connected to L293D / L298N motor driver EN |
| **Motor IN1 / IN2** | Digital Pins 6 & 7 | Fan Direction Controls | Logic directional pins for motor driver |

---

## Irrigation Decision Logic: Irrigation Urgency Score (IUS)

A weighted Irrigation Urgency Score (**IUS**) is computed as follows:

$$\text{IUS} = w_1 \cdot (1 - \text{soil\_moisture\_norm}) + w_2 \cdot (\text{temperature\_norm}) - w_3 \cdot (\text{humidity\_norm}) - w_4 \cdot (\text{pressure\_drop\_rate}) + w_5 \cdot (\text{UV\_index\_norm}) \cdot \text{daylight\_penalty\_factor}$$

### Assigned Weights
- **$w_1 = 0.50$ (50%)**: Soil moisture deficit — the primary indicator of plant water needs.
- **$w_2 = 0.20$ (20%)**: Ambient temperature — higher temperatures accelerate evapotranspiration.
- **$w_3 = 0.10$ (10%)**: Relative humidity — higher humidity lowers transpiration urgency.
- **$w_4 = 0.10$ (10%)**: Barometric pressure drop rate — indicates oncoming rain (default `0.0` when no barometer connected).
- **$w_5 = 0.10$ (10%)**: UV radiation index — strong UV radiation increases plant water demands.
- **$\text{daylight\_penalty\_factor} = 0.65$ (midday) or $1.0$ (morning/evening/night)**: Prevents wasteful evaporation during harsh direct sunlight.

### Actuator Operation
- **LED 1 (Pin 9)**: **GLOWS during watering plants** when $\text{IUS} \ge \text{iusThreshold}$ (default fallback: `0.45`).
- **LED 2 (Pin 8)**: **GLOWS when low intensity of light is detected** by LDR ($\text{ldrValue} < \text{ldrThreshold}$, default fallback: `400`).
- **Cooling Fan (Pins 5, 6, 7)**: Runs when $\text{temperature} > \text{tempThreshold}$ (default fallback: `30.0 °C`).

---

## Dynamic Thresholds & Robust Fallback Values

Thresholds can be adjusted dynamically in real time from the React frontend or via Serial commands. If no thresholds are received or if a reset occurs, the system automatically uses safe fallback defaults:

| Parameter | Fallback Default | Unit / Range | Logic Condition |
|---|---|---|---|
| **Soil Watering Threshold** | `550` | Raw ADC (0–1023) | When `soilValue > soilThreshold`, **LED 9** turns ON (soil needs watering). |
| **Fan Temp Threshold** | `30.0` | °C | When `temp > tempThreshold`, **Cooling Fan** runs at PWM speed with 1.0°C hysteresis. |
| **Water Tank Low Alert** | `150` | Raw ADC (0–1023) | When `waterValue < waterThreshold`, **LED 8** blinks as a refill warning. |
| **Ambient Light (LDR)** | `400` | Raw ADC (0–1023) | When `ldrValue < ldrThreshold`, indicates darkness / night. |
| **DHT11 Sensor Fallback** | `25.0 °C / 50.0 %` | Safe defaults | Used if DHT11 reading glitches/fails (NaN prevention). |

---

## 1. Arduino Firmware Setup

1. Open `firmware/aquasense_arduino/aquasense_arduino.ino` in the **Arduino IDE**.
2. Go to **Sketch** ➔ **Include Library** ➔ **Manage Libraries...** and ensure the **DHT sensor library** (by Adafruit) is installed.
3. Select board: **Arduino Uno** (or **Arduino Nano**).
4. Select the matching COM port and click **Upload**.

---

## 2. Frontend Dashboard Setup

The frontend connects directly to the Arduino via the **Web Serial API** (available in Chrome, Edge, and Opera). It also provides an interactive **Simulate Demo Mode** for testing without physical hardware.

```bash
cd frontend
npm install
npm run dev
```

1. Open the frontend in Google Chrome or Microsoft Edge (`http://localhost:5173`).
2. Click **Connect Arduino (USB)**.
3. Select your Arduino's COM port in the browser popup.
4. The dashboard will instantly start streaming live telemetry at 9600 baud, rendering real-time graphs, and enabling threshold adjustments!

---

## 3. Serial Communication Protocol

Arduino sends a compact, single-line JSON packet every 1000ms:
```json
{"uv":12,"ldr":450,"soil":580,"water":310,"temp":28.5,"hum":55.0,"dht_ok":1,"fan":1,"fan_pwm":210,"led_water":1,"led_light":0,"th_temp":30.0,"th_soil":550,"th_water":150,"th_ldr":400}
```

The frontend can send commands directly to Arduino:
- `SET_ALL:<temp>,<soil>,<water>,<ldr>`: Sets all 4 thresholds simultaneously.
- `SET:TEMP=31.5`: Updates fan temperature trigger.
- `SET:SOIL=600`: Updates soil watering trigger.
- `RESET`: Restores fallback defaults.
- `FAN:ON` / `FAN:OFF` / `FAN:AUTO`: Manual fan override.
- `LED_WATER:ON` / `LED_WATER:OFF` / `LED_WATER:AUTO`: Manual watering LED override.
- `LED_LIGHT:ON` / `LED_LIGHT:OFF` / `LED_LIGHT:AUTO`: Manual alert LED override.
