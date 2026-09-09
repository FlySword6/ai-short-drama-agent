# 参考控制包

先 `reference lanes` 读取服务端的参考栏词表，再 `reference get --shot-id ID` 回读这一镜的参考控制包。编导决定要带什么；CLI 只搬运：`reference add` 加一件，`reference remove` 移一件，人工核对后 `reference ready` 标记就位。

**备戏清单**是场级备料，记录这一场按参考栏备齐了哪些资产；**参考控制包**是镜级绑定，一镜一份，记录该镜提交生成时打算带的参考。把场级备戏清单铺下去后，每镜都有自己的控制包，之后各改各的，互不影响。

`reference missing --shot-id ID` 只做纯比对：服务端参考栏词表减去控制包中已有参考的栏。它不判断该不该补——那由编导决定。
