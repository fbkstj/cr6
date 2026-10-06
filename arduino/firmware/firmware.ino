// 階段 4：完整韌體
// 指令：F 前進  B 後退  L 左轉  R 右轉  S 停止  + - 調速
//       1 紅燈亮  2 紅燈滅  3 綠燈亮  4 綠燈滅  5 嗶一聲
const int ENA = 5, IN1 = 7, IN2 = 8, IN3 = 9, IN4 = 10, ENB = 6;
const int TRIG[3] = {2, 4, 11};
const int ECHO[3] = {3, 12, 13};
const int BUZZER = A1, LED_RED = A2, LED_GREEN = A3;

int speedPwm = 150;
int curL = 0, curR = 0;               // 目前馬達狀態
unsigned long lastCmd = 0, lastReport = 0;

void motor(int left, int right) {
  curL = left; curR = right;
  digitalWrite(IN1, left > 0);  digitalWrite(IN2, left < 0);  analogWrite(ENA, abs(left));
  digitalWrite(IN3, right > 0); digitalWrite(IN4, right < 0); analogWrite(ENB, abs(right));
}

int readCm(int i) {
  digitalWrite(TRIG[i], LOW);  delayMicroseconds(2);
  digitalWrite(TRIG[i], HIGH); delayMicroseconds(10);
  digitalWrite(TRIG[i], LOW);
  unsigned long t = pulseIn(ECHO[i], HIGH, 25000);
  if (t == 0) return 400;
  return t * 0.034 / 2;
}

void handle(char c) {
  switch (c) {
    case 'F': motor(speedPwm, speedPwm); break;
    case 'B': motor(-speedPwm, -speedPwm); break;
    case 'L': motor(-speedPwm, speedPwm); break;
    case 'R': motor(speedPwm, -speedPwm); break;
    case 'S': motor(0, 0); break;
    case '+': speedPwm = min(255, speedPwm + 20); break;
    case '-': speedPwm = max(80, speedPwm - 20); break;
    case '1': digitalWrite(LED_RED, HIGH); break;
    case '2': digitalWrite(LED_RED, LOW); break;
    case '3': digitalWrite(LED_GREEN, HIGH); break;
    case '4': digitalWrite(LED_GREEN, LOW); break;
    case '5': digitalWrite(BUZZER, HIGH); delay(200); digitalWrite(BUZZER, LOW); break;
  }
}

void setup() {
  Serial.begin(115200);
  int outs[] = {ENA, IN1, IN2, IN3, IN4, ENB, BUZZER, LED_RED, LED_GREEN};
  for (int p : outs) pinMode(p, OUTPUT);
  for (int i = 0; i < 3; i++) { pinMode(TRIG[i], OUTPUT); pinMode(ECHO[i], INPUT); }
  lastCmd = millis();
}

void loop() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') continue;
    handle(ch);
    lastCmd = millis();
  }
  // 安全 1：超過 1 秒沒收到指令 → 停車
  if (millis() - lastCmd > 1000) motor(0, 0);

  // 每 100 毫秒量一次距離並回報
  if (millis() - lastReport >= 100) {
    lastReport = millis();
    int l = readCm(0), c = readCm(1), r = readCm(2);
    // 安全 2：前進時前方小於 12 公分 → 直接停
    if (curL > 0 && curR > 0 && c < 12) motor(0, 0);
    Serial.print("D,"); Serial.print(l); Serial.print(",");
    Serial.print(c);    Serial.print(","); Serial.println(r);
  }
}
