---
alwaysApply: true
---

# Functional ADT programming preference

在语言、框架和项目惯例允许时采用 functional、type-driven、ADT 风格；项目一致性优先，除非用户明确要求重构，不把 TS 模式强加给其他语言或单为本规则改写架构。

## 类型与 ADT

- 先建模有效状态再实现行为；有限选项用 enum、tagged/discriminated union、sealed class、sum type，必须同时存在的字段用 record/struct/dataclass 等 product type，避免裸 string/number、boolean flag 组合和仅在部分状态有效的 optional-field soup。
- 正常实现禁止 `any`、`Object`、`{}`、raw `object`、raw map/dict 和 untyped JSON。外部不可信输入可用 `unknown`，但必须立即解析为精确类型；值跨 function/module/API/component/persistence 边界后优先使用命名 domain type。
- 在语言允许时让非法状态不可表示，并让类型贯穿 DB、API/RPC、validation、routing、UI、job 和 error。模型变化后以 compiler error 生成工作清单，不用 grep/猜测，也不得用 `as`/cast 绕过断裂的类型链。
- 对 variant 做 exhaustive pattern matching/switch/handler；新增 variant 后穷尽更新所有转换，禁止 catch-all `default` 隐藏漏处理。
- TS 用 discriminated unions 与 `never`/`assertNever`；有原生 ADT/sealed type 的语言使用其原生能力；Python/Ruby/Go/JS 等弱类型环境以集中 tag、边界验证、variant-specific structure 维持同样形状，禁止隐式 dict 和 flag soup。

## 边界、错误与副作用

- 在 user/network/file、DB JSON、env、CLI 和第三方响应边界解析输入，构造 refined domain type 后信任 schema/constructor/ORM/RPC 或已经穷尽处理的值，不在内部重复防御检查；优先返回精确类型的 parser/constructor，而非丢失证据的 boolean validator。
- Expected/domain failure 使用 `Result`、`Either`、显式 error variant 或 sealed error，并穷尽处理；exception/throw 留给 programmer error、真正意外失败或以 exception 为惯例的生态边界，不把下游可用的结构化错误压成字符串。
- 确定性转换用 pure function，IO、持久化、网络、日志、timer、UI 等副作用留在边界；在惯用时使用 immutable update 和能保留类型或表达领域含义的小型命名转换。

## 不过度抽象

不因 2–3 行相似就引入 generic framework、helper layer、base class、factory 或 type-level machinery；优先直接转换、明确 variant handler 和局部代码。除非任务确实需要，不引入 point-free/monadic 风格、重型 FP 库、type-erasing registry、compat shim、feature flag 或 fallback layer。

Owned TS 可贯通 schema-as-type、typed RPC/routing、ORM inference、discriminated union、exhaustive rendering 和 typed error；非 owned/non-TS 项目先遵循现有约定，只在局部以清晰 constructor、集中 parser、显式 variant 和边界测试增加精度。
