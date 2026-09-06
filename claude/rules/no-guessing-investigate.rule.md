---
alwaysApply: true
---

# No guessing — investigate before answering or acting

事实陈述、建议和修改必须基于系统当前真实状态，不能依赖记忆、训练数据、经验推断或“我想/可能/通常/应该”等保留语气。涉及用户实际 repo、文件、服务、API 版本、schema 或 config 时，先读文件、查询服务、运行命令并检查版本；函数、flag、路径、endpoint、option、参数、ID、主机、端口和凭据必须确认存在且适用于当前版本，跨语言、框架或大版本也不得类推。

- prior-session 和 memory 中的事实必须在用户据此行动前重新验证。
- 读取状态仍不能确定行为时，运行能解决问题的最小实验。
- 对系统作出事实陈述时，引用 `path:line`、命令输出、API 响应或版本字符串。
- 没有访问权、clone 或在线资源而无法核实时，明确说不知道并停止，不得猜测或用合理值填空。

一次核实或小实验比基于错误事实造成的返工更便宜。
