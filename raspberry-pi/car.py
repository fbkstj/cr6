import serial, time

class Car:
    def __init__(self, port='/dev/ttyACM0'):
        self.ser = serial.Serial(port, 115200, timeout=0.02)
        self.dist = (400, 400, 400)      # 左、中、右（公分）
        time.sleep(2)                    # 開啟序列埠會讓 Arduino 重開機，要等它

    def send(self, cmd):
        self.ser.write(cmd.encode())

    def update(self):
        """讀取序列埠、更新最新距離，回傳 (左, 中, 右)"""
        while self.ser.in_waiting:
            line = self.ser.readline().decode(errors='ignore').strip()
            if line.startswith('D,'):
                try:
                    l, c, r = (int(v) for v in line[2:].split(','))
                    self.dist = (l, c, r)
                except ValueError:
                    pass                 # 收到壞資料就略過
        return self.dist

    def stop(self):
        self.send('S')
