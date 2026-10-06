// 階段 3：超音波測距（三顆 HC-SR04）
// 接線：左 TRIG=D2 ECHO=D3；中 TRIG=D4 ECHO=D12；右 TRIG=D11 ECHO=D13
// Serial Monitor 速率請選 115200。
const int TRIG[3] = {2, 4, 11};   // 左、中、右
const int ECHO[3] = {3, 12, 13};

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 3; i++) {
    pinMode(TRIG[i], OUTPUT);
    pinMode(ECHO[i], INPUT);
  }
}

int readCm(int i) {
  digitalWrite(TRIG[i], LOW);  delayMicroseconds(2);
  digitalWrite(TRIG[i], HIGH); delayMicroseconds(10);   // 發出 10 微秒的觸發訊號
  digitalWrite(TRIG[i], LOW);
  unsigned long t = pulseIn(ECHO[i], HIGH, 25000);      // 量回波時間，最多等 25 毫秒
  if (t == 0) return 400;                               // 沒收到回波 → 視為很遠
  return t * 0.034 / 2;                                 // 聲速約 0.034 公分/微秒，去回要除以 2
}

void loop() {
  Serial.print("L="); Serial.print(readCm(0));
  Serial.print("  C="); Serial.print(readCm(1));
  Serial.print("  R="); Serial.println(readCm(2));
  delay(100);
}
