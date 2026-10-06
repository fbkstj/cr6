from car import Car

car = Car()
while True:
    cmd = input("指令 F/B/L/R/S/1~5，q 離開：").strip().upper()
    if cmd == 'Q':
        car.stop()
        break
    if cmd:
        car.send(cmd[0])
    print("距離 左/中/右：", car.update())
