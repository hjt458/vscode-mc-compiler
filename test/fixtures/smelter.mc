MODULE("冶炼")
// 测试用最小脚本：一个模块、两个 helper、一个 RunLoop 入口。
// 只用到语言本身的语法，不依赖任何游戏内对象，所以不需要模组工程也能编译。
void refillFuel() {
    int 空间 = 64;
    if (空间 <= 0) return;
}

int countItems(Container 容器) {
    return 容器.getCount();
}

void RunLoop(int tick) {
    refillFuel();
    countItems(furnace.input[0]);
}
