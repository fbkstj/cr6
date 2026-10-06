// 階段 2：馬達測試
// 接線：ENA=D5, IN1=D7, IN2=D8, IN3=D9, IN4=D10, ENB=D6
// 測試前請先把車子架空，輪子不要碰地。
const int ENA = 5, IN1 = 7, IN2 = 8;
const int IN3 = 9, IN4 = 10, ENB = 6;

void setup() {
  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT); pinMode(ENB, OUTPUT);
}

// left、right：-255（全速後退）～ 255（全速前進）
void motor(int left, int right) {
  digitalWrite(IN1, left > 0);
  digitalWrite(IN2, left < 0);
  analogWrite(ENA, abs(left));
  digitalWrite(IN3, right > 0);
  digitalWrite(IN4, right < 0);
  analogWrite(ENB, abs(right));
}

void loop() {
  motor(150, 150);   delay(1000);   // 前進
  motor(0, 0);       delay(500);
  motor(-150, -150); delay(1000);   // 後退
  motor(0, 0);       delay(500);
  motor(-150, 150);  delay(800);    // 原地左轉
  motor(0, 0);       delay(500);
  motor(150, -150);  delay(800);    // 原地右轉
  motor(0, 0);       delay(1500);
}
