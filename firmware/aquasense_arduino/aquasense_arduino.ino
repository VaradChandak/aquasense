/*
  AquaSense - Arduino Uno / Nano Firmware (5V)
  Direct Frontend Serial Interface (9600 baud) - No Blynk required

  Sensors:
    - DHT11 (Temperature & Humidity) : Digital Pin 4
    - UV Sensor (GUVA-S12SD)         : Analog Pin A0
    - Soil Moisture Sensor           : Analog Pin A1 (Moved to A1 to allow I2C on A4/A5)
    - Water Level Sensor             : Analog Pin A2 (Moved to A2 to allow I2C on A4/A5)
    - LDR (Light Sensor)             : Analog Pin A3
    - BMP280 (Barometric Pressure)   : I2C (SDA -> Pin A4, SCL -> Pin A5)
      * If BMP280 is not detected, automatic safe fallback (1013.25 hPa) is used.

  Actuators:
    - LED 1 (LED_WATER): Digital Pin 9 -> Glows during watering plants (triggered by IUS)
    - LED 2 (LED_LIGHT): Digital Pin 8 -> Glows when low intensity of light (LDR) is detected
    - BUZZER (ALARM)   : Digital Pin 3 -> Goes HIGH when water tank level is low (waterValue < waterThreshold)
    - DC Motor (Fan / Cooling)       : Enable Pin 5 (PWM), IN1 Pin 6, IN2 Pin 7 via L293D/L298N

  Irrigation Decision Logic:
    Weighted Irrigation Urgency Score (IUS):
    IUS = w1 * (1 - soil_moisture_norm) + w2 * (temperature_norm) - w3 * (humidity_norm)
          - w4 * (pressure_drop_rate) + w5 * (UV_index_norm) * daylight_penalty_factor

    Weights:
      w1 = 0.50  (Soil moisture urgency - 50%)
      w2 = 0.20  (Temperature evapotranspiration impact - 20%)
      w3 = 0.10  (Humidity dampening - 10%)
      w4 = 0.10  (Barometric pressure drop / rain indicator - 10%)
      w5 = 0.10  (UV radiation index - 10%)
*/

#include <Wire.h>
#include <Adafruit_BMP280.h>
#include <DHT.h>

// ======================= PIN CONFIGURATION =======================
#define BUZZER_PIN 3      // Buzzer: Goes HIGH when water tank is low
#define DHTPIN 4          // DHT11 Data Pin
#define DHTTYPE DHT11

#define UV_PIN A0
#define SOIL_PIN A1       // Analog Pin A1
#define WATER_PIN A2      // Analog Pin A2
#define LDR_PIN A3        // Analog Pin A3
// BMP280 uses hardware I2C: SDA is on A4, SCL is on A5

#define LED_LIGHT 8       // LED 2: Low-light / Ambient indicator (Pin 8)
#define LED_WATER 9       // LED 1: Soil Watering indicator (Pin 9)

#define MOTOR_EN 5        // PWM pin (0-255)
#define MOTOR_IN1 6       // Motor Driver Direction Pin 1
#define MOTOR_IN2 7       // Motor Driver Direction Pin 2

// ======================= IUS WEIGHTS =======================
const float W1_SOIL  = 0.50f; // Soil moisture weight
const float W2_TEMP  = 0.20f; // Temperature weight
const float W3_HUM   = 0.10f; // Humidity weight
const float W4_PRESS = 0.10f; // Pressure drop rate weight
const float W5_UV    = 0.10f; // UV index weight

// ======================= FALLBACK DEFAULTS =======================
const float FALLBACK_TEMP_THRESHOLD  = 30.0f;   // °C -> Fan starts above this
const int   FALLBACK_SOIL_THRESHOLD  = 550;     // Raw ADC -> Reference dry point
const int   FALLBACK_WATER_THRESHOLD = 150;     // Raw ADC -> Tank low alert threshold (Buzzer triggers below this)
const int   FALLBACK_LDR_THRESHOLD   = 400;     // Raw ADC -> Low intensity light threshold (LED 2 glows below this)
const float FALLBACK_IUS_THRESHOLD   = 0.45f;   // IUS score (0.0 - 1.0) -> Plants watered above this (LED 1 glows)
const float FALLBACK_SAFE_TEMP       = 25.0f;   // Safe fallback if DHT11 glitches
const float FALLBACK_SAFE_HUM        = 50.0f;   // Safe fallback if DHT11 glitches
const float FALLBACK_PRESSURE        = 1013.25f;// Standard atmospheric pressure (hPa) fallback if BMP280 not detected

// ======================= ACTIVE THRESHOLDS =======================
float tempThreshold  = FALLBACK_TEMP_THRESHOLD;
int   soilThreshold  = FALLBACK_SOIL_THRESHOLD;
int   waterThreshold = FALLBACK_WATER_THRESHOLD;
int   ldrThreshold   = FALLBACK_LDR_THRESHOLD;
float iusThreshold   = FALLBACK_IUS_THRESHOLD;

// ======================= STATE & TIMERS =======================
DHT dht(DHTPIN, DHTTYPE);
Adafruit_BMP280 bmp; // I2C BMP280

unsigned long previousReadMillis = 0;
const unsigned long READ_INTERVAL = 1000; // 1 second telemetry interval

int ldrValue   = 0;
int waterValue = 0;
int soilValue  = 0;
int uvValue    = 0;

float temperature = FALLBACK_SAFE_TEMP;
float humidity    = FALLBACK_SAFE_HUM;
bool  dhtSuccess  = false;

bool  bmpDetected     = false;
float pressureHpa     = FALLBACK_PRESSURE;
float prevPressureHpa = FALLBACK_PRESSURE;
float pressureDrop    = 0.0f;

float currentIus  = 0.0f;
bool  isWatering  = false;

bool ledWaterState = false;
bool ledLightState = false;
bool buzzerState   = false;
bool fanState      = false;
int  fanPwm        = 0;
const int FAN_RUN_SPEED = 210; // PWM speed (0-255)

// Manual overrides (-1: Auto/Normal, 0: Force OFF, 1: Force ON)
int manualFan      = -1;
int manualLedWater = -1;
int manualLedLight = -1;
int manualBuzzer   = -1;

// ======================= MOTOR CONTROL =======================
void setMotor(bool run, int speed = FAN_RUN_SPEED) {
  if (run && speed > 0) {
    digitalWrite(MOTOR_IN1, HIGH);
    digitalWrite(MOTOR_IN2, LOW);
    analogWrite(MOTOR_EN, constrain(speed, 0, 255));
    fanState = true;
    fanPwm = speed;
  } else {
    analogWrite(MOTOR_EN, 0);
    digitalWrite(MOTOR_IN1, LOW);
    digitalWrite(MOTOR_IN2, LOW);
    fanState = false;
    fanPwm = 0;
  }
}

// ======================= SERIAL COMMAND PARSER =======================
void handleSerialCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd.equalsIgnoreCase("RESET")) {
    tempThreshold  = FALLBACK_TEMP_THRESHOLD;
    soilThreshold  = FALLBACK_SOIL_THRESHOLD;
    waterThreshold = FALLBACK_WATER_THRESHOLD;
    ldrThreshold   = FALLBACK_LDR_THRESHOLD;
    iusThreshold   = FALLBACK_IUS_THRESHOLD;
    manualFan      = -1;
    manualLedWater = -1;
    manualLedLight = -1;
    manualBuzzer   = -1;
    Serial.println(F("{\"ack\":\"RESET_OK\",\"msg\":\"Restored fallback thresholds\"}"));
    return;
  }

  // Accepts: SET_ALL:<temp>,<soil>,<water>,<ldr>,<ius>
  if (cmd.startsWith("SET_ALL:")) {
    String params = cmd.substring(8);
    int c1 = params.indexOf(',');
    int c2 = params.indexOf(',', c1 + 1);
    int c3 = params.indexOf(',', c2 + 1);
    int c4 = params.indexOf(',', c3 + 1);

    if (c1 > 0 && c2 > c1 && c3 > c2) {
      tempThreshold  = params.substring(0, c1).toFloat();
      soilThreshold  = params.substring(c1 + 1, c2).toInt();
      waterThreshold = params.substring(c2 + 1, c3).toInt();

      if (c4 > c3) {
        ldrThreshold = params.substring(c3 + 1, c4).toInt();
        iusThreshold = params.substring(c4 + 1).toFloat();
      } else {
        ldrThreshold = params.substring(c3 + 1).toInt();
      }

      Serial.println(F("{\"ack\":\"SET_ALL_OK\"}"));
      return;
    }
  }

  // Individual parameter sets
  if (cmd.indexOf("IUS=") >= 0 || cmd.indexOf("\"ius\":") >= 0 || cmd.indexOf("\"th_ius\":") >= 0) {
    int idx = cmd.indexOf("IUS=");
    if (idx >= 0) iusThreshold = cmd.substring(idx + 4).toFloat();
    else {
      int cIdx = cmd.indexOf("\"ius\":");
      if (cIdx < 0) cIdx = cmd.indexOf("\"th_ius\":");
      if (cIdx >= 0) {
        int start = cmd.indexOf(':', cIdx) + 1;
        iusThreshold = cmd.substring(start).toFloat();
      }
    }
  }

  if (cmd.indexOf("TEMP=") >= 0 || cmd.indexOf("\"temp\":") >= 0 || cmd.indexOf("\"th_temp\":") >= 0) {
    int idx = cmd.indexOf("TEMP=");
    if (idx >= 0) tempThreshold = cmd.substring(idx + 5).toFloat();
    else {
      int cIdx = cmd.indexOf("\"temp\":");
      if (cIdx < 0) cIdx = cmd.indexOf("\"th_temp\":");
      if (cIdx >= 0) {
        int start = cmd.indexOf(':', cIdx) + 1;
        tempThreshold = cmd.substring(start).toFloat();
      }
    }
  }

  if (cmd.indexOf("SOIL=") >= 0 || cmd.indexOf("\"soil\":") >= 0 || cmd.indexOf("\"th_soil\":") >= 0) {
    int idx = cmd.indexOf("SOIL=");
    if (idx >= 0) soilThreshold = cmd.substring(idx + 5).toInt();
    else {
      int cIdx = cmd.indexOf("\"soil\":");
      if (cIdx < 0) cIdx = cmd.indexOf("\"th_soil\":");
      if (cIdx >= 0) {
        int start = cmd.indexOf(':', cIdx) + 1;
        soilThreshold = cmd.substring(start).toInt();
      }
    }
  }

  if (cmd.indexOf("WATER=") >= 0 || cmd.indexOf("\"water\":") >= 0 || cmd.indexOf("\"th_water\":") >= 0) {
    int idx = cmd.indexOf("WATER=");
    if (idx >= 0) waterThreshold = cmd.substring(idx + 6).toInt();
    else {
      int cIdx = cmd.indexOf("\"water\":");
      if (cIdx < 0) cIdx = cmd.indexOf("\"th_water\":");
      if (cIdx >= 0) {
        int start = cmd.indexOf(':', cIdx) + 1;
        waterThreshold = cmd.substring(start).toInt();
      }
    }
  }

  if (cmd.indexOf("LDR=") >= 0 || cmd.indexOf("\"ldr\":") >= 0 || cmd.indexOf("\"th_ldr\":") >= 0) {
    int idx = cmd.indexOf("LDR=");
    if (idx >= 0) ldrThreshold = cmd.substring(idx + 4).toInt();
    else {
      int cIdx = cmd.indexOf("\"ldr\":");
      if (cIdx < 0) cIdx = cmd.indexOf("\"th_ldr\":");
      if (cIdx >= 0) {
        int start = cmd.indexOf(':', cIdx) + 1;
        ldrThreshold = cmd.substring(start).toInt();
      }
    }
  }

  // Manual Overrides
  if (cmd.equalsIgnoreCase("FAN:ON"))   manualFan = 1;
  else if (cmd.equalsIgnoreCase("FAN:OFF"))  manualFan = 0;
  else if (cmd.equalsIgnoreCase("FAN:AUTO")) manualFan = -1;

  if (cmd.equalsIgnoreCase("LED_WATER:ON"))   manualLedWater = 1;
  else if (cmd.equalsIgnoreCase("LED_WATER:OFF"))  manualLedWater = 0;
  else if (cmd.equalsIgnoreCase("LED_WATER:AUTO")) manualLedWater = -1;

  if (cmd.equalsIgnoreCase("LED_LIGHT:ON"))   manualLedLight = 1;
  else if (cmd.equalsIgnoreCase("LED_LIGHT:OFF"))  manualLedLight = 0;
  else if (cmd.equalsIgnoreCase("LED_LIGHT:AUTO")) manualLedLight = -1;

  if (cmd.equalsIgnoreCase("BUZZER:ON"))   manualBuzzer = 1;
  else if (cmd.equalsIgnoreCase("BUZZER:OFF"))  manualBuzzer = 0;
  else if (cmd.equalsIgnoreCase("BUZZER:AUTO")) manualBuzzer = -1;

  Serial.println(F("{\"ack\":\"CMD_OK\"}"));
}

// ======================= SETUP =======================
void setup() {
  Serial.begin(9600);
  dht.begin();
  Wire.begin();

  // Try initializing BMP280 on common I2C addresses 0x76 and 0x77
  if (bmp.begin(0x76) || bmp.begin(0x77)) {
    bmpDetected = true;
    bmp.setSampling(Adafruit_BMP280::MODE_NORMAL,
                    Adafruit_BMP280::SAMPLING_X2,
                    Adafruit_BMP280::SAMPLING_X16,
                    Adafruit_BMP280::FILTER_X16,
                    Adafruit_BMP280::STANDBY_MS_500);
    pressureHpa = bmp.readPressure() / 100.0f;
    prevPressureHpa = pressureHpa;
  } else {
    bmpDetected = false;
    pressureHpa = FALLBACK_PRESSURE;
    prevPressureHpa = FALLBACK_PRESSURE;
  }

  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_LIGHT, OUTPUT);
  pinMode(LED_WATER, OUTPUT);

  pinMode(MOTOR_EN, OUTPUT);
  pinMode(MOTOR_IN1, OUTPUT);
  pinMode(MOTOR_IN2, OUTPUT);

  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(LED_LIGHT, LOW);
  digitalWrite(LED_WATER, LOW);

  setMotor(false, 0);

  Serial.print(F("{\"status\":\"boot\",\"device\":\"AquaSense Arduino 5V\",\"baud\":9600,\"buzzer\":\"pin3\",\"bmp280\":"));
  Serial.print(bmpDetected ? F("\"detected\"") : F("\"fallback\""));
  Serial.println(F("}"));
}

// ======================= MAIN LOOP =======================
void loop() {
  unsigned long currentMillis = millis();

  // 1. Process any incoming Serial command from Frontend
  if (Serial.available() > 0) {
    String incoming = Serial.readStringUntil('\n');
    handleSerialCommand(incoming);
  }

  // 2. Periodic Sensor Acquisition & Actuator Logic
  if (currentMillis - previousReadMillis >= READ_INTERVAL) {
    previousReadMillis = currentMillis;

    // Read analog sensors (0 - 1023)
    uvValue    = analogRead(UV_PIN);
    soilValue  = analogRead(SOIL_PIN);
    waterValue = analogRead(WATER_PIN);
    ldrValue   = analogRead(LDR_PIN);

    // Read digital DHT11
    float t = dht.readTemperature();
    float h = dht.readHumidity();

    if (!isnan(t) && !isnan(h) && t > -20.0 && t < 80.0) {
      temperature = t;
      humidity    = h;
      dhtSuccess  = true;
    } else {
      dhtSuccess = false;
      if (isnan(temperature)) temperature = FALLBACK_SAFE_TEMP;
      if (isnan(humidity))    humidity    = FALLBACK_SAFE_HUM;
    }

    // Read BMP280 Barometric Pressure (or use safe fallback if not detected)
    if (bmpDetected) {
      float p = bmp.readPressure() / 100.0f; // Pa to hPa
      if (p > 300.0f && p < 1250.0f) {
        pressureHpa = p;
        pressureDrop = prevPressureHpa - pressureHpa;
        prevPressureHpa = pressureHpa;
      }
    } else {
      pressureHpa = FALLBACK_PRESSURE;
      pressureDrop = 0.0f;
    }

    // ================= IRRIGATION DECISION LOGIC (IUS) =================
    // 1. Soil moisture normalized (0.0 = completely dry, 1.0 = completely wet)
    float soil_moisture_norm = constrain((1023.0f - (float)soilValue) / 750.0f, 0.0f, 1.0f);

    // 2. Temperature normalized (0.0 at 15°C, 1.0 at 40°C)
    float temperature_norm = constrain((temperature - 15.0f) / 25.0f, 0.0f, 1.0f);

    // 3. Humidity normalized (0.0 to 1.0)
    float humidity_norm = constrain(humidity / 100.0f, 0.0f, 1.0f);

    // 4. Pressure drop rate normalized (scaled so a 5 hPa drop gives 1.0)
    float pressure_drop_rate = constrain(pressureDrop / 5.0f, 0.0f, 1.0f);

    // 5. UV index normalized (0.0 to 1.0 for UV index 0 to 10)
    float uvVoltage = (uvValue * 5.0f) / 1023.0f;
    float uvIndex = uvVoltage / 0.1f;
    float UV_index_norm = constrain(uvIndex / 10.0f, 0.0f, 1.0f);

    // 6. Daylight penalty factor:
    // Evaporation penalty in high daylight (midday sun reduces irrigation efficiency)
    float daylight_penalty_factor = (ldrValue > 650) ? 0.65f : 1.0f;

    // Weighted Irrigation Urgency Score:
    currentIus = W1_SOIL  * (1.0f - soil_moisture_norm)
               + W2_TEMP  * (temperature_norm)
               - W3_HUM   * (humidity_norm)
               - W4_PRESS * (pressure_drop_rate)
               + W5_UV    * (UV_index_norm) * daylight_penalty_factor;

    currentIus = constrain(currentIus, 0.0f, 1.0f);

    // Decision: Irrigate plants if IUS reaches or exceeds threshold
    isWatering = (currentIus >= iusThreshold);

    // ================= ACTUATOR CONTROL =================

    // A. LED 1 (Pin 9, LED_WATER): Glows DURING WATERING PLANTS
    if (manualLedWater != -1) {
      ledWaterState = (manualLedWater == 1);
    } else {
      ledWaterState = isWatering;
    }
    digitalWrite(LED_WATER, ledWaterState ? HIGH : LOW);

    // B. LED 2 (Pin 8, LED_LIGHT): Glows when there is LOW INTENSITY OF LIGHT (LDR)
    if (manualLedLight != -1) {
      ledLightState = (manualLedLight == 1);
    } else {
      bool isLowLight = (ldrValue < ldrThreshold);
      ledLightState = isLowLight;
    }
    digitalWrite(LED_LIGHT, ledLightState ? HIGH : LOW);

    // C. BUZZER (Pin 3): Goes HIGH when tank level gets below / low tank
    bool isLowTank = (waterValue < waterThreshold);
    if (manualBuzzer != -1) {
      buzzerState = (manualBuzzer == 1);
    } else {
      buzzerState = isLowTank;
    }
    digitalWrite(BUZZER_PIN, buzzerState ? HIGH : LOW);

    // D. MOTOR / FAN (Pins 5, 6, 7): Cooling Fan
    // Turns ON when temperature > tempThreshold; Turns OFF when temperature <= (tempThreshold - 1.0)
    if (manualFan != -1) {
      setMotor(manualFan == 1, FAN_RUN_SPEED);
    } else {
      if (temperature > tempThreshold) {
        setMotor(true, FAN_RUN_SPEED);
      } else if (temperature <= (tempThreshold - 1.0f)) {
        setMotor(false, 0);
      }
    }

    // ================= OUTPUT CLEAN JSON TELEMETRY =================
    Serial.print(F("{\"uv\":"));
    Serial.print(uvValue);
    Serial.print(F(",\"ldr\":"));
    Serial.print(ldrValue);
    Serial.print(F(",\"soil\":"));
    Serial.print(soilValue);
    Serial.print(F(",\"water\":"));
    Serial.print(waterValue);
    Serial.print(F(",\"temp\":"));
    Serial.print(temperature, 1);
    Serial.print(F(",\"hum\":"));
    Serial.print(humidity, 1);
    Serial.print(F(",\"pressure\":"));
    Serial.print(pressureHpa, 1);
    Serial.print(F(",\"bmp_ok\":"));
    Serial.print(bmpDetected ? 1 : 0);
    Serial.print(F(",\"pdrop\":"));
    Serial.print(pressureDrop, 2);
    Serial.print(F(",\"dht_ok\":"));
    Serial.print(dhtSuccess ? 1 : 0);
    Serial.print(F(",\"ius\":"));
    Serial.print(currentIus, 3);
    Serial.print(F(",\"th_ius\":"));
    Serial.print(iusThreshold, 2);
    Serial.print(F(",\"fan\":"));
    Serial.print(fanState ? 1 : 0);
    Serial.print(F(",\"fan_pwm\":"));
    Serial.print(fanPwm);
    Serial.print(F(",\"led_water\":"));
    Serial.print(ledWaterState ? 1 : 0);
    Serial.print(F(",\"led_light\":"));
    Serial.print(ledLightState ? 1 : 0);
    Serial.print(F(",\"buzzer\":"));
    Serial.print(buzzerState ? 1 : 0);
    Serial.print(F(",\"th_temp\":"));
    Serial.print(tempThreshold, 1);
    Serial.print(F(",\"th_soil\":"));
    Serial.print(soilThreshold);
    Serial.print(F(",\"th_water\":"));
    Serial.print(waterThreshold);
    Serial.print(F(",\"th_ldr\":"));
    Serial.print(ldrThreshold);
    Serial.println(F("}"));
  }
}
