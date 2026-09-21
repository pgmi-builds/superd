# JS/TS 语言基础答疑（Cordis 研究伴生讲义）

> 起因：`cordis-research.md` §3.2/§6 的讨论暴露了一批 JS/TS 语言层困惑（类 vs struct、
> extends 的"链"、构造函数参数、Proxy 的身份、内建服务实例化时序）。本文只讲**与 Cordis
> 直接相关**的语言基础；每个结论尽量带"实测"（node 22 一手运行，`node -e` 可原样复跑）
> 或 Cordis 源码锚点。
> 姊妹篇：`cordis-research.md`（框架研究）、`cordis-engineering-feasibility.md`（工程旁支）。
> 2026-09-07 第二轮答疑追加 §6–§13：机器层与原型链的真实位置、.d.ts 与 declare、泛型与
> constructor、继承 vs 组合 vs 投影、原型链运行时语义、同类型对象链、Proxy 陷阱术语、Service 归属。

---

## 1. 类 vs struct：JS/TS 与 Go/Rust 的思维差异

### 你的理解校验

- "struct = 底层类型的组合蓝本（一个 int + 一个 float 的 list）" ✅ —— 精确说是**数据布局
  蓝本**：只有字段，没有方法。
- "Rust 通过 impl 挂载方法" ✅ —— `impl Foo { fn bar(&self) {...} }`，方法在 impl 块里、
  不在 struct 体里。
- ⚠️ 补充：Go 没有 impl 块——方法是**带 receiver 的顶层函数** `func (f Foo) Bar() {}`，
  挂在类型名上。
- ⚠️ 修正"加上函数作用域就有类似继承"：替代继承的不是作用域，是**接口/trait + 组合**——
  Go 的 struct 嵌入（embedding，编译出委托方法）、Rust 的 trait（trait 可继承 trait）。
  两门语言都**刻意砍掉实现继承**："is-a"退化成"实现某接口"（能力声明），复用靠组合不靠继承。

### 对 JS 的三问

**1. JS 有类吗？**——分两半答：

- ES2015 之前：**没有 class 关键字**。JS 是原型式语言：对象直接从对象继承
  （`Object.create(某对象)`），"构造函数 + prototype"模拟类。
- ES2015 起：有了 `class` 语法，但**它是原型机制的语法糖**——class 底下仍然是
  prototype + 构造函数。JS 的类从来不是 Java 式的全新实体，是原型链的声明式写法。

**2. TS 类与 JS 类的区别？**——TS 类 = JS 类 + 一层**纯编译期**的类型设施：

| 特性 | JS | TS | 编译后 |
|---|---|---|---|
| class 语法 | ✅（ES2015+） | ✅ | 保留（现代 target） |
| 字段/参数类型标注 | ❌ | ✅ | 擦除 |
| public/protected/private 修饰符 | ❌（仅 `#x` 硬私有，ES2022） | ✅ | 擦除（运行时不隔离） |
| abstract 抽象类 | ❌ | ✅ | 擦除（编译期禁止 new） |
| implements 接口实现 | ❌ | ✅ | 擦除 |
| 参数属性 `constructor(protected ctx)` | ❌ | ✅ | 展开为字段赋值 |
| declare 字段（仅类型占位） | ❌ | ✅ | 完全消失 |
| 泛型类 | ❌ | ✅ | 擦除 |

一句话：**TS 类多出来的部分全是"给编译器看的"，运行时它就是一个 JS 类。**
（Cordis 实例：`Service` 的构造函数签名 `constructor(protected ctx: Context, name: string)`
里的 `protected` 就是 TS 参数属性——编译成 `this.ctx = ctx` 两行事。）

**3. 为什么 TS 编译后类还在？类是不是纯参考？**——这个理解反了，要分清两种东西：

- **interface / type / declare / 修饰符**：纯类型，编译后**一个字节不留**——这些才是"纯参考"。
- **class 的实现**（构造函数体、方法体）：是**可执行代码**，本来就要跑，当然保留。TS 的工作
  只是"擦掉类型"，不是"擦掉实现"。
- "down-level compile（降级编译）"说的是另一回事：target 设成 ES5 这类老标准时，TS 会把
  class **翻译**成 `function + prototype 赋值` 的等价老写法；target 现代（ES2015+，cordis 的
  tsdown 构建即如此）就原样透传。两种情况下"类"都活着，只是写法新旧之分。

---

## 2. new / extends / instanceof 与那条"链"

### new 做的四件事（+ 一个后门）

1. 开一个新对象，其原型指向 `Class.prototype`；
2. 把构造函数的 `this` 绑定到这个新对象；
3. 执行构造函数体；
4. 返回这个对象——**除非构造函数自己 return 了一个对象，那就返回那个对象**
   （后门；Cordis 靠它塞 Proxy，见 §4。实测 3：`class P { constructor(){ return {replaced:true} } }`
   → `new P()` 拿到 `{replaced:true}`）。

### extends 加长的"链" = 原型链（prototype chain）

```ts
class Animal { move() {} }
class Dog extends Animal { bark() {} }
const d = new Dog()
// d ──proto──> Dog.prototype ──proto──> Animal.prototype ──proto──> Object.prototype ──> null
```

`Dog extends Animal` 做的事：把 `Dog.prototype` 的原型接到 `Animal.prototype` 后面——
所谓"加长的链"就是这条**查找链**。`d.bark()` 在 Dog.prototype 找到；`d.move()` 没找到就沿链
上溯到 Animal.prototype 找到；一路到 null 还没有就报错。**JS 继承的本质 = 沿链委托查找。**

### 你的关键问题：先 new 的 ctx，会被后来的 extends 影响吗？

**不会——链的结构在实例出生那一刻冻结；但链上对象的内容是活的。**（实测 1、2）

- 实测 2：`old = new Base()` **之后**才定义 `class Sub extends Base {...}` → `old.who()`
  仍是基类行为、`old.extra` 为 undefined、`old instanceof Sub` 为 false。
  **旧实例的原型链结构不会被改写**；新子类只对**以后 new 出来的实例**生效。
- 实测 1：但给 `Base.prototype` **后补方法**，`old` **立刻能看见**——因为方法查找是动态的，
  链上的对象（prototype）本身可变。

所以对 ctx 的准确回答：

- ctx 的原型链（ctx → Context.prototype → Object.prototype）在 `new Context()` 那一刻定死；
- Cordis 后续**既不改这条链、也不重开类体**（JS 没有"重开类定义"的语法，只能后补 prototype）；
- ctx 的"能力增长"走的是另外两条**活通道**：(a) Proxy 陷阱——读不存在的属性名时动态查
  服务登记表；(b) mixin accessor——四服务的方法投影为 ctx 的 accessor 属性。
  （cordis-research.md §3.2a/§3.2"合起来的图景"）
- 对照：TS 的 `declare module` 增强**只改类型、不改运行时**——类型层的开放与运行时层的
  开放（Proxy/mixin）各走各路。

### instanceof

✅ 你的理解对：沿对象的原型链查找 `Class.prototype`，找到即 true。（实测 2b）

两个进阶（Cordis 都用上了）：

- `Symbol.hasInstance` 可以**自定义** instanceof 的判定——`Service` 类就改写了它
  （service.ts 末尾的 `static [Symbol.hasInstance]`，为的是构造器可能是 proxy 时判定仍准）。
- `Context.is(value)` 干脆不用 instanceof，改查**品牌符号**：static 块里
  `Context.prototype[Context.is] = true`（键是全局符号 `Symbol.for('cordis.is')`）——
  原因：跨 realm / 多副本 cordis 时 prototype 身份会失配，全局符号不会。

### Cordis 的 extend()/isolate()/intercept()：普通方法，但"作用对象"要说准

⚠️ 措辞修正：它们是**定义在 Context 类上的普通实例方法**，不是"操作 Context 类"——你在
**实例**上调用它们（`ctx.extend(...)`），它们返回**新的 context 对象**（不是新类）。
另外最容易混淆的一点：**Cordis 的 `extend()` 方法与 JS 的 `extends` 关键字零关系，纯撞名。**

| | `class Sub extends Base`（关键字） | `ctx.extend(meta)`（Cordis 方法） |
|---|---|---|
| 层面 | 类层，**定义期**静态发生 | 对象层，**运行期**动态发生 |
| 加长的链 | 类原型链（Sub.prototype→Base.prototype） | context 对象的原型链（`Object.create(ctx)`） |
| 产物 | 新类（还要 new 才有实例） | 立即可用的子 context 对象 |
| Cordis 用途 | 基本不用（核心近乎零类继承；主要继承场景是插件作者 `extends Service`） | 造作用域子 context（isolate/intercept/每个 fiber 的子 ctx 全经它） |

底层其实是**同一个机制（原型委托）**——一个在类定义时用，一个在运行时手搓。JS 的类本来就是
原型的糖，所以"运行时手搓原型链"完全合法；Cordis 的分形作用域就是手搓原型链的工厂。

---

## 3. `constructor(ctx, name)`：普通参数表，不是特殊语法

你的困惑："Service 的构造函数是 (ctx, name)，是不是不用 new、挂到 ctx 下面创建实例？"

拆开纠三点：

1. **`(ctx, name)` 就是普通的构造函数参数表**，与 `constructor(width, height)` 无任何语法
   区别。这是 TS 原生语法——Cordis 没有发明任何语法，只是**约定了参数含义**
   （第一个传 context、第二个传服务名）。
2. **实例化照样用 new**：`new MyService(ctx, 'tools')`。Cordis 源码里到处是证据——
   `new Context()` 的构造函数体内 `new ReflectService(self)`、`new RegistryService(self)`、
   registry 里 `new Fiber(...)`（registry.ts L296）。
3. **"挂在 ctx 下面"不是语法效果，是构造函数体的行为**：`this.ctx = ctx`（存引用）+
   `ctx.reflect.provide(name, this)`（登记服务）——两行普通代码干的活。换句话说，
   **"挂载"是 Cordis 在构造函数里手写的业务逻辑**；语言层面只是"传了个参数、存了个字段、
   调了个方法"。

所以你的预设"Service 可以用 new 创建、也可以用这种构造函数语法挂在 ctx 下"要收敛成一句：
**只有一种创建方式（new + 传参）；"挂上去"是 new 完之后构造函数体顺手做的事。**

---

## 4. Proxy：不是关键字，是 JS 标准内建类

三问连答：

1. **它不是关键字**。`Proxy` 是 **JS 语言标准库的内建类**（ES2015 起，ECMAScript 规范定义、
   引擎/V8 直接提供），与 `Map`/`Set`/`Promise` 同一地位——全局可 `new` 的运行时类。
   大写只是 JS 内建类的命名惯例（内建构造器都大写：Object/Array/Map/Proxy）。
2. **TS 没有定义它，只是给它写了类型**（`lib.es2015.proxy.d.ts`，随 TS 发布的标准库类型
   描述——性质同 `.d.ts` 是"给编译器的合同"）。所以你在 Cordis 源码里找不到 Proxy 的
   定义——它在引擎里。
3. **用法**：`new Proxy(target, handler)` 返回一个**包装对象**；`handler` 是带陷阱方法
   （get/set/has/deleteProperty…）的普通对象；此后对包装对象的一切属性读写先走陷阱，由
   陷阱决定转发、改写还是现算。（实测 4：包装对象读 `b` 得到陷阱现算的值，raw 上没有 `b`。）

### Cordis 的用法逐行解（context.ts 构造函数）

```ts
constructor() {
  ...
  const self = new Proxy<this>(this, ReflectService.handler)  // ① raw 实例 + 静态 handler → 包装
  ...
  this.reflect = new ReflectService(self)   // ② 四服务拿到的都是包装后的 self
  ...
  return self                               // ③ new 的后门：构造函数返回对象 ⇒ 外界拿到 Proxy
}
```

- ① `ReflectService.handler` 是 ReflectService 类上的一个 **static 属性**（get/set/has 三个
  陷阱函数的对象，reflect.ts）——仍是普通 static 属性，不是语言设施；
- ③ 正是 §2 说的 new 第四步后门：**类没有"变成 Proxy 类"**——Context 类自始至终是普通类；
  是**每个实例在出生那一刻被包了一层**，你手里的 ctx 永远是包装对象（raw 实例被藏在后面，
  只有框架自己碰）。
- 因此你的表述"把 Context 关联到内建 Proxy / 赋予它 Proxy 性质"应改成：
  **"Context 类不变；它的构造函数把每个新实例包进 Proxy 再交出去。"**

---

## 5. 四个内建服务：定义时序与实例化时序（纠一处关键误解）

你的模型分两步，第一步对、第二步错：

✅ **第一步（对）**：Cordis 源码先定义了 Events/Registry/Reflect/Logger 四个**普通类**
（各自独立文件，模块级 top-level，与 Context 平级）。"Context 类内部包含了这四个类"的
准确说法是"context.ts **import** 了它们"——类定义跨文件、顺序无关，Context 的**构造函数体**
引用它们。

❌ **第二步（错）**："刚 new 出 ctx 时四者还只是类、没实例，要等 loader/plugin 等方法来创建
实例。"——**恰恰相反：四个实例是在 `new Context()` 的构造函数体里同步、立刻 new 出来的**：

```ts
constructor() {
  ...
  this.fiber = new Fiber(self, {}, Object.create(null), null, () => [])  // 根 fiber（uid=0）
  this.reflect = new ReflectService(self)
  this.registry = new RegistryService(self)
  this.events = new EventsService(self)
  this.logger = new LoggerService(self)
  ...
}
```

**`new Context()` 返回的那一刻，ctx.reflect/registry/events/logger 已是四个活实例 + 一条根
fiber。**不存在"稍后实例化"阶段。

你混了两个东西：**"Registry 这个服务对象"** 与 **"Registry 里面登记的插件条目"**：

| 时点 | 发生什么 |
|---|---|
| t0 进程加载模块 | 四服务类 + Context 类 + Fiber 类**定义**就位（纯定义，无实例） |
| t1 `new Context()` | 四服务实例 + 根 fiber **同步造出**；ReflectService 顺手把各服务方法 mixin 投影到 ctx |
| t2 app-boot 挂 Loader | `ctx.plugin(Loader)` → Registry 实例的 Map 里**登记**第一个插件 Runtime |
| t3 配置树逐行挂载 | 每行 `ctx.plugin(...)` → Map 继续填条目 + 每插件 new 一个 Fiber |

loader/plugin 从头到尾**没有创建过 RegistryService**——它们只是往那个 t1 就存在的实例的
Map 里**填内容**。"类→实例"在 t1 一次完成；t2/t3 做的是"给已存在的实例填业务数据"。
（与 cordis-research.md §2"框架基底不是 plugin、由 `new Context()` 造出"是同一件事的两面。）

---

## 6. 机器层、编译/解释模型与原型链的真实位置

### 你的模型校验

- "class 最终翻译成机器级类型（整数/浮点/指针）" ✅ —— 对象在机器层就是堆块 + 基本类型
  字段（V8 里还配一个 map/隐藏类描述布局）。
- ❌ **原型链 ≠ 分解链**。原型链与"翻译到机器类型"毫无关系：它是**运行时对象之间的委托
  查找路径**（这个对象没有的属性，沿链向别的对象借）。"因为层层嵌套所以有链"不成立——
  类的字段分解在机器层是平的布局，没有链。
- 你的编译/解释二分 ✅（在我们需要的精度上）：Go/Rust 开发期 AOT 编译成 binary；JS 把
  一切推迟到执行时。补一点：现代 JS 引擎不是纯解释器——V8 先走 Ignition 字节码解释，
  热点代码再 JIT 成机器码，"解释型"说的是**部署模型**（ship 源码不 ship binary），不是
  执行方式。对后续讨论真正重要的差异是：**绑定与检查发生在何时**——AOT 语言编译期定死；
  JS 全部推迟到运行时；TS 在两者之间加了一个 AOT **类型检查**相位（tsc），但不改运行时。
- 命名陷阱：V8 的"隐藏类（hidden class / map）"是布局优化概念，与 JS 的 prototype 是
  **两回事**，只是中文名字容易撞。

## 7. `.d.ts` 与 `declare`：给谁用、何时生成

你的问题："JS 已 self-contained，旁边多出的 .d.ts 有什么用？"（注：没有 `.d.js` 这种东西，
只有 `.d.ts`。）

- **不是每次编译都生成**。应用工程默认不生成；**发布库**时才开 `declaration`（tsc）或
  bundler 的 dts 能力（tsdown）。Cordis 的 `lib/types/*.d.ts` 就是发布产物的一部分。
- **用途**：库的消费者拿到你的 JS（引擎的食物），但他们写"用你这个库的代码"时，他们的
  tsc/IDE 需要类型信息来检查与补全——你的源 .ts 不随包走（或不必走），.d.ts 就是
  **打包好的类型表面**。类比 C/C++ 的头文件：`.h` 给编译器，`.c/.so` 给链接器和运行时。
- **declare 的意思**："这个名字运行时已存在；此文件只描述它的类型形状，实现在旁边的
  `.js` 里"。所以 `export declare class Context` = "Context 类在 JS 产物里，这里只是合同"。
- 引擎**永远不读** .d.ts；`package.json` 的 `types` 字段把 tsc/IDE 引到它。JS self-contained
  是**对执行而言**；.d.ts 服务于**跨包边界的编译期检查**——TS 的类型是结构化的，跨了包
  就必须随包携带类型描述，否则消费者侧一切退化成 any。

## 8. 泛型与 constructor

**泛型（generics）= 类型层面的参数化**。`Array<T>`、`class Box<T> { value: T }`——把"类型"
  当参数传，同一份定义适配多种具体类型，检查期保证装进/取出类型一致。纯编译期，擦除后
  消失（运行时没有 `Box<Dog>` 这种东西，只有 `Box`）。Cordis 实例：`Service<out T = never>`
  的 `T` 是"幻影配置类型"——只参与类型检查（intercept config 的类型推导），运行时不存在。

**constructor 构造的是什么？**——四个选项里最接近的是"构造一个变量（的值）"，准确说法：
**构造（初始化）一个该类型的实例对象**。

- 不是构造函数（构造函数本身是个函数，但它产出的是对象）；
- 不是构造类型（类型在类定义时就存在了，constructor 一行没跑类型就已就位）；
- 也不是构造引用配对（引用是实现的细节：对象在堆上，变量/字段持有指向它的引用）。
- 机器视角：`new` 按类布局分配一块堆内存 → constructor 体给字段赋初值 → 返回该块的
  引用。另外注意类本身**也是值**（构造函数是一等公民，可以传来传去——registry 的 Map
  就是拿"插件回调函数"当键的）。

## 9. "子类"正名：继承（is-a）vs 组合（has-a）vs 投影（forwards）

你的"子类 = Context 内嵌 Events，实例化外层时内层也实例化"——**描述的现象真实存在，但
名字叫错了**：那是**组合（composition）+ 构造期急切实例化**，不是子类/继承。

| | 继承 `class Sub extends Base` | 组合：字段持有另一类的实例 |
|---|---|---|
| 关系语义 | Sub **是一个** Base（is-a） | 外层**持有一个**内层（has-a） |
| 实例化产物 | **一个对象**、一次分配 | **两个（多个）对象**，外层字段持引用指向内层 |
| 父类/内层参与 | 不创建 Base 实例；方法经查找链共享 | Base 类的实例真实存在、被外层引用 |
| Cordis 中的使用 | 几乎不用（插件作者 `extends Service` 是主场景） | 四服务：Context 字段持四实例 |

所以你的两问：

1. **构建期让 Context 内含 Events（字段/内嵌）** = 组合：每个 ctx 一份独立的 EventsService
   实例，`ctx.events` 是指向它的引用。Cordis 实际做法。
2. **先建 Context 再 `class X extends Context`** = 继承：X 的实例"就是一个 context"，没有
   `ctx.events` 字段、EventsService 不会为它单独实例化（方法经链共享自 Context.prototype
   一路查到）。Cordis 没这么做。

Cordis 其实三种复用都用了：对四服务用**组合**；把服务方法暴露到 ctx 表面用**投影**
（mixin accessor，`ctx.on` 转发到 `ctx.events.on`）；**继承**只留给插件作者 `extends
Service`。选择组合+投影而非继承的原因：服务可替换（换实现不动类）、可多实例并存、
避免"上帝子类"。

## 10. 原型链的运行时语义（纠三处）

1. ❌ **"类型链在编译期起作用"**：原型链是**纯运行时**结构——属性查找的当下才沿它走。
   TS 编译期检查用的是**声明类型层**（`extends` 声明的类型关系），那个东西擦除后消失，
   与运行时原型链是**平行而不同**的两套机制（设计上对齐，机制上独立）。
2. ❌ **"对象链 = dog1 与 animal1 的父子关系"**：**不存在 animal1**。标准链是
   `dog1 → Dog.prototype → Animal.prototype → Object.prototype → null`——链上放的是各类的
   **原型对象**（`.prototype`），不含任何 Animal 实例。实例之间默认没有原型链关系。
3. **何时向上走** ✅ 你的直觉对：自身属性命中就不走链（实测 5：`child.own` 直取；`child.x`
   未命中才沿链借）。典型分工：数据字段在实例自身，方法在原型对象上。

### "先 extends 后建实例会不会带上 Dog 子对象"——方向反了

`class Dog extends Animal` 做的唯一一件事：把 **Dog.prototype** 的原型指向 Animal.prototype。
**Animal 类、Animal.prototype、既有/未来的 Animal 实例全部毫发无损**。受益者是 Dog 的
实例（已建的 + 未来的）——它们的查找链路过 Animal.prototype。不存在"新 Animal 实例里
带一个空的 Dog 子对象"：继承**不嵌套、不实例化任何东西**，只是给 Dog 的实例多了一条
查找回落路径。（实测 6：后补 `Animal.prototype.walk`，Dog 实例 d1 与 Animal 实例 a1 都
看得见；`Dog.prototype.bark` 只有 Dog 实例看得见，a1 永远 `undefined`、`a1 instanceof
Dog` 为 false。）

**冻结/活的最终表述**：**链接（链的形状）在对象出生时定死；链上对象的内容永远活**。
后补 prototype 方法，所有途经该原型的实例（无论新旧）立刻可见。

## 11. 同类型对象链："手搓原型链"的辩护与数组类比之辨

你的质疑有一半完全正确：**原型链是对象链，不是类链**——"每一层求值类型都返回同一个
prototype 名"当然不构成类的嵌套，这个反驳成立。

但"同类型对象之间就无链可谈"不成立：`Object.create(parent)` 会把 parent——一个普通
**实例对象**——放进 child 的 [[Prototype]] 槽。（实测 5：`Object.getPrototypeOf(child)
=== parent` 为 true；child 没有的属性 `x` 沿链借到了。）链的意义与类型无关，在于
**查找回落**：child 没有的，向上借。

**数组嵌套类比为何不成立**：`[[1,[2]]]` 的外层与内层之间**没有 [[Prototype]] 链接**——
内层数组只是外层的一个元素值，存的是引用，查外层属性不会回落到内层。**嵌套 ≠ 委托**。
原型链是"查不到就上溯"的委托链接，不是数据的包含结构。

Cordis 里这个机制的两个真实用例（这才是"手搓原型链"的确切含义——不是造新类型，是把
**作用域继承**实现为对象级原型回落）：

- `isolate()`：`shadow = Object.create(父 isolate 映射)`——子作用域查不到的服务名回落到
  父作用域的条目（实测 7：child 未覆盖的 `color` 读到父的 "red"，覆盖后读自己的 "blue"）。
- `extend()`：子 context = `Object.create(父 context)`——子 ctx 未定义的属性读取沿链
  回落到父 ctx，一路到根。**链上放的是父 context 实例（对象），不是 Context.prototype**——
  这正是"对象链"的活用：Cordis 把"instance→instance 的父子关系"真的造出来了，你的
  "对象链"直觉在这里落地，只是它是框架手搓的，不是语言默认给的。

## 12. Proxy 与"陷阱（trap）"术语

- ⚠️ "Proxy ≈ alias/别名"不准确。别名 = 透明转发一切；Proxy = **带拦截逻辑的新对象**，
  每个操作可以先被捕获、再决定转发/改写/现算/拒绝。`ctx.llm` 不是读到某个预存属性，是
  get 陷阱**现场计算**（查 reflect store 的当前条目）。比喻：别名是"同一个房的另一个门牌"；
  Proxy 是"房前加了一个门卫，每个访客先过门卫的手"。
- ⚠️ 方向修正：handler 不是"reflect service 返回出来的"——`ReflectService.handler` 是
  ReflectService 类上的一个 **static 属性**（get/set/has 三个函数的普通对象），在类定义时
  就写好了；Proxy 拿它包 raw 实例。
- **"陷阱"是 ECMAScript 标准术语**（trap），无贬义：代理在操作到达 target 之前把它
  "捕获"住。中文也叫捕获器。
- **解析顺序**：不是"先解析 Proxy 层、最后解析外层 Context"——**Proxy 就是最外层**，
  你手里的 ctx 只有这个包装对象。一切属性读取**先进陷阱**；陷阱内部分流：特殊属性 →
  直通 raw；自有属性（`reflect/registry/events/fiber/root`…）→ 直接返回；accessor →
  调用其 get（mixin 投影的 `ctx.on` 走这支）；其余名字 → 当服务名解析（fiber 链查 store，
  查不到抛 cannot get without inject）。

## 13. Service 到底特别在哪（归属再纠一次）

❌ 两处归属都不成立："Context 内含 Service 这个类"——Context 构造函数只 new 四服务 +
根 fiber，**没有 Service 字段、不实例化 Service**（它是 abstract，本来就禁止直接 new）；
"Service 自己嵌套包含 reflect/events/registry"——Service 类体里没有它们，它只是在构造时
**持有 ctx 引用**（`this.ctx`），经这个引用**可达** `ctx.reflect` / `ctx.events`…

Service 的特别之处不在结构、在**模式**（生命周期契约）：

1. **构造即登记**：`super(ctx, name)` 的函数体调 `ctx.reflect.provide(name, this)`——
   new 出来的那一刻自己挂上服务表；
2. **随宿主撤销**：登记本身是所属 fiber 的 effect，fiber 卸载自动注销；
3. **可选可调用**：定义了 `[Service.invoke]` 的子类实例会被包成可调用对象（ctx.logger）。

关系总图：四服务实例 ⊂ ctx 的字段；Service 子类实例 --this.ctx 引用--> ctx --> 四服务。

---

## 14. 第三轮答疑：严格分层（L1/L2/L3）与"语言级还原"

**分层纪律（应你的要求确立，此后遵守）**：L1 = 机器码/用 C 替代表述；L2 = JS/TS 语言本身；
L3 = Cordis 业务代码。讨论语言机制只允许 L1/L2 词汇；L3 名词一旦出现，必须当场还原成
L2 清单。

先立一个关键命题：**Cordis 没有语言特权。L3 的全部机制都是用 L2 的普通设施写的普通
代码**——没有保留字是 Cordis 定义的，没有语法是 Cordis 发明的；所谓"框架机制"只是
"普通函数 + 普通对象 + 普通字典 + Proxy 这个内建类"的组合。下面逐个还原。

## 15. 类是运行时实体："语法糖"的准确边界

你的修正 ✅，收敛成一句：**"语法糖"说的是 class 关键字/语法可以脱糖为"构造函数对象 +
原型对象"的等价老写法；脱糖后的产物是真实实体。**

- L2 证据：类本身是**值**——`typeof Svc === 'function'`（实测 8a）；可以赋值、传参、
  当 Map 的键（Registry 就拿类/构造器当键）。
- L1 证据：引擎为类与原型链配了专用机器码（内联缓存 IC、隐藏类/map、原型有效性单元格）
  ——有类与无类的 JS 编译出的机器码确实不同。**"有一段机器码在动态为类实例服务 ⇒
  实体"——接受这个判据。**
- 完整表述："class 语法是糖；类是实体；引擎为它配了专用机器码。"三层都对。

## 16. abstract class ≠ 泛型（两个不同的编译期设施）

你把抽象类与泛型划了等号，要拆开。两者都是 TS 编译期设施、都被擦除、都可称"模板"，
但是**两个机制**：

- **abstract class**：不可直接 `new` 的半成品类模板——约束"必须子类化补全后才能实例化"
  （Service 是它）。
- **泛型（generics）**：类型层面的参数化——`Box<T>`；实例化发生在**编译期**，产物是**类型**。

你的泛型产物清单 ✅ 全对（标量类型 / 具象化的类类型 / 函数类型 / 结构体形状——统称
"类型"；泛型操作永远产出类型，不产出运行时值）。

关键区分（§19 要用）：**泛型实例化 ≠ 子类化**。前者编译期、产出类型、运行时零痕迹；
后者运行时、产出一个真实的新类对象。

## 17. 集合论理解继承 ✅ + "委托"的准确含义

- 你的集合论表述**完全成立**，且正是 TS 类型系统的实际语义：结构化类型 = 集合包含。
  `Dog ⊆ Animal ⊆ Object` 指值域（每个 Dog 值都是 Animal 值、也是 Object 值）；结构上
  Dog ⊇ Animal（更多成员、更多约束）。"特异化 = 加约束"✅。
- 分层补充：这是**类型层（编译期）**的语义；**运行时**实现方法继承靠原型链（查找回落）
  ——两套机制、设计上对齐、各归各层。
- "委托是指调用吗？"——**不是函数调用。委托 = 查询的转交**：`obj.x` 是一次查询；引擎先查
  obj 自身属性，未命中就把**这次查询**转交（delegate）给 obj 的 [[Prototype]] 指向的对象，
  逐级上行直至命中或到 null。"委托查找路径" = 查询被转交的路线。L1 视角：沿指针逐跳做
  键匹配。
- 你这轮自己说对的：events 是组合（has-a）✅；"一个对象一次分配"的"一个对象" =
  **Sub 类型的一个实例** ✅（就是那个 new 出来的、类型为 Sub 的堆对象）。

## 18. Object.create(ctx)：duplicate / 弟弟 / 儿子之辨

- 先纠一个：`Object` **不是关键字**，是**内建类**（与 Proxy 同族）；`Object.create` 是它的
  static 方法（引擎实现，语言标准库的一部分）。
- 语义（L2 规范）：`Object.create(x)` = 造一个**全新空对象**（零自有属性），把它的
  [[Prototype]] 槽填成 **x 本身**——不是 x 的原型，不是 x 的拷贝。（实测 8c：子对象自有属性
  `[]` 为空，但 `child.a` 借到 1；`getPrototypeOf(child) === ctx` 为 true。）
- 你给的两个选项都不对：
  - ❌ duplicate：**没有任何属性被复制**（实测 8c 自有属性为零），更不是冻结快照；
  - ❌ 同模板弟弟：**模板（类）根本不参与**——参数是一个实例，不是类；
  - ✅ 正确意象：**以 ctx 为原型造一个空对象**。所谓"父子"来自查询方向：新对象答不上来
    的查询由 ctx 代答（回落的上一步 = "父"）。JS 社区把原型链上游叫 parent 就是此意——
    **父 = 查询回落的上一步**，不是生育关系，也不是兄弟。
- L1 视角：新堆对象只有三个要点——指向自身 map（布局描述）的指针、指向 [[Prototype]]
  （即 ctx 的堆地址）的指针、空属性存储。属性读取 = 沿 proto 指针逐跳找键。

## 19. "Cordis 机制"的语言级（L2）完整还原

### 19.1 三件套的身份

- `ctx.reflect`：context 对象上的一个**属性**；值是类 `ReflectService` 的**实例**（普通对象）。
- `ReflectService.handler`：类上的 **static 属性**——static 属性就是"类对象这个普通对象的
  普通属性"（实测 8a；类本身 `typeof === 'function'`，是个值）；值是一个普通对象，内含
  get/set/has 三个**普通 JS 函数**。名字 handler 是 Cordis 作者起的（你写作 handle 是笔误）；
  点语法（读属性）是 L2 原生。
- `ReflectService` 实例上的 `store`：一个 **null-prototype 普通对象**当字典用
  （`Object.create(null)`；键 = 符号，值 = 普通记录对象 `{name, fiber, value, check}`）。
  **不是 Map**——Map 用在别处（RegistryService 的 `_internal = new Map()`）。

### 19.2 `ctx.llm` 读取全过程（纯 L2 逐步）

```
表达式：ctx.llm                ← 一条属性读取
1. 引擎发现 ctx 是 Proxy（其 handler 槽非空）
2. 引擎调用 handler.get 这个函数（Proxy 的全部语言语义就是：读取必先过它）
3. handler.get 是一段普通 JS 函数（Cordis 作者写的），依次：
   a. 'llm' 是特殊属性？否
   b. raw context 对象自身有 'llm' 属性？否（自有属性就那几个）
   c. props 字典里有没有 'llm' 的 accessor 定义？mixin 投影走这支
   d. 否则：算出作用域键 → 在 store 字典里查 → 取出记录的 value 字段
4. 引擎把返回值当作表达式 ctx.llm 的值
```

"现场计算"的全部含义 = **每次读取都重新执行这段普通函数、做一次普通字典查询**。
唯一的地层设施是 Proxy 的"读取必过陷阱"；其余全是普通代码。

### 19.3 "提供者 / 登记"的还原

- **登记（provide）**：执行一个普通函数，往 store 字典**存一条引用**（键=服务名，记录的
  value 字段=某对象）；**注销**：删该条目。
- **"提供者"** = 那个字典槽里**当前装的**那个对象。不是方法、不是清单、不是语言概念——
  就是"这一格现在装着谁"的业务称呼。
- **读取返回单个对象**（当前槽里的那个），**不是实例清单**。
- 两层字典别混：store（服务名 → 服务实例）是第一层；`ctx.agents` 拿到的 AgentRegistry
  实例**内部还有一个 Map**（agent 名 → 各 agent 实例）是第二层。"提供者"只指第一层的槽主。

### 19.4 泛型实例化 / 子类化 / 实例化：三个"化"的对照

| 操作 | 发生阶段 | 产物 | 运行时痕迹 |
|---|---|---|---|
| 泛型实例化 `Service<Foo>` | 编译期 | 一个**类型** | 无（擦除；运行时只有一个 Service 类） |
| 子类化 `class A extends B` | 模块加载（运行时） | 一个**真实的新类**（对象） | 有：`A` 这个值存在 |
| 实例化 `new A(...)` | 运行时 | 一个**实例对象** | 有：堆上一个对象 |

- 你的推理链校验："`AgentRegistry extends Service` 能跑 ⇒ AgentRegistry 必是类/构造器" ✅
  （实测 8b：`extends 5` 直接 TypeError "not a constructor or null"）。
- **AgentRegistry 正名**（此前我引入得突兀）：链条是**服务名 ↔ 类 ↔ 实例**三层——
  服务名 `agents`（store 字典的键）↔ 类 `AgentRegistry extends Service`（模板）↔ 实例
  （`ctx.agents` 读到的那个对象）。llm 同构：`llm` ↔ `LlmRuntime`（类链：extends
  TypertRemoteService extends Service）↔ 实例（`ctx.llm` 读到的对象）。
- "llm 是 Service 泛型的具象化" ⚠️ 半对：准确说是**子类化的后代**——让 llm 存在的是
  `extends` 链（运行时真实的类），不是 `<T>`（编译期类型参数，擦除后无痕）。
- "读取 llm 时它作为类被调用、可以返回清单或不返回任何东西" ⚠️：**读取与调用是两个
  操作**。读取 `ctx.llm` 返回**实例对象**（不是类、不是清单）；若再 `ctx.llm(...)` 去调它，
  仅当该对象是可调用对象（如 logger 服务）才行——能不能调、返回什么，取决于那个对象
  本身是不是函数状。

---

## 20. 第四轮：外部分析校验 + 五个新语言点（Symbol.for / unique symbol / static block / toPrimitive / 多态 this）

你贴的那份 context.ts 分析（另一来源）总体质量高。逐条判定（对照 vendored 源码）：

### 20.1 判定总表

| 断言 | 判定 |
|---|---|
| 声明合并；static block（ES2022/TS 4.4）；构造函数 return Proxy；extend/isolate/intercept 机制；条件类型 + `infer`；计算属性名；Object.create 语义；原型链查找规则；"symbols 缺字段编译报错" | ✅ 全部正确（与本文 §2/§4/§6/§18 结论一致） |
| "symbols 大概率是 `const symbols = { effect: Symbol('effect'), ... }`" | ❌ **猜错**：实为全部 `Symbol.for('cordis.*')`（全局注册表符号，utils.ts L50–73）——见 20.2，这是跨副本互操作的根基 |
| "`Dict<T>` 是 Cordis 自己写的 `Record<string,T>` 封装" | ⚠️ 半对：出自 **cosmokit**（同作者工具库，cordis import 而来）；且是 `Dict<T, K extends string | symbol>`——键可为 symbol（reflect store 的符号键就是它） |
| "原型链查找直到 Object.prototype 为止" | ⚠️ 终点是 **null**（Object.prototype 是最后一站，其 [[Prototype]] 为 null） |
| 用 `__proto__` 讲解原型 | ⚠️ 教学可用、非规范：规范概念是 [[Prototype]] 内部槽，标准访问器是 `Object.getPrototypeOf`（见 20.6） |
| 速查表"Object.create 零开销" | ⚠️ 低开销 ≠ 零开销：属性未命中要沿链上行，且链顶还有 Proxy 陷阱在跑 |
| extend 简化为 `Object.create(this)` | ⚠️ 教学简化：真实源码是 `Object.create(getTraceable(this, this))`（追踪包装）+ shadow 处理 + `meta` 的 own-key 拷贝循环（fiber 就是靠这个把 `{fiber}` 挂上子 ctx 的） |
| 多态 `this` 返回类型（该分析有提且说对了） | ✅ 值得收录——见 20.5 |

### 20.2 `Symbol` vs `Symbol.for`：全局注册表是关键差别（实测 9）

- `Symbol('k') === Symbol('k')` **永远 false**（每次全新）；`Symbol.for('k') === Symbol.for('k')`
  **永远 true**——**全局符号注册表**按键复用，同进程内跨 realm、跨模块副本共享（实测 9a/9b/9c）。
- **Cordis 的选择**：框架内部符号（shadow/receiver/effect/filter/isolate/intercept/init/check/
  config/invoke/extend/tracker/resolveConfig…）**全部** `Symbol.for('cordis.*')`。意义：同一进程
  装两份 cordis 副本（vendored 一份 + npm 一份）时，两份的 `symbols.effect` **相等**，互操作
  不碎；若用 `Symbol()`，多副本之间互不相认。
- 类型侧配套：`effect: Symbol.for('cordis.effect') as typeof Context.effect`——用
  `as typeof` 把运行时值**拴到**类静态上声明的 `unique symbol` 类型。

### 20.3 `unique symbol` 的真正动机：让 symbol 能当 interface 的计算键

- TS 规定：**interface/类型里的计算属性键，键的类型必须是 `unique symbol`**——普通
  `symbol` 类型不行（编译器无法保证两个 `symbol` 类型的值是同一个）。这正是这个类型存在的
  核心用途，此前文档没讲透。
- 所以 `[symbols.isolate]: Dict<symbol>` 这行 interface 写得出来，前提是 `Context.isolate`
  声明为 `unique symbol`；类静态声明 + symbols 对象的 `as typeof` 拴定共同满足它。
- "万一 symbols 里没有 effect"：**编译期就报类型错** ✅（该分析此条正确）。

### 20.4 `Symbol.toPrimitive` 双重身份（`Context.is` 的黑科技补全）

- `Context.is` 是一个**静态方法**（值是函数）；同时挂了 `Symbol.toPrimitive`（返回
  `Symbol.for('cordis.is')`）。
- JS 规则：对象被用作**属性键**时先做 ToPropertyKey 转换 → 优先调它的 @@toPrimitive →
  得到那个全局符号。
- 于是 `value?.[Context.is]` 实际查的是 `value[Symbol.for('cordis.is')]`；
  `Context.prototype[Context.is] = true` 实际写的也是同一全局键。**一个函数身兼两职：
  判定方法 + 属性键**。跨副本成立的根源同 20.2：全局注册表。

### 20.5 多态 `this` 返回类型

- `extend(meta = {}): this` 的返回类型不是写死的类名，而是 **`this` 类型**（"调用者的
  具体类型"）。
- 效果：在更具体的类型上调用 extend，返回值类型自动是那个更具体的类型——链式派生
  不丢类型信息。纯编译期，擦除。

### 20.6 `prototype` / `__proto__` / `[[Prototype]]` 三兄弟辨析

- **[[Prototype]]**：规范级概念——每个对象都有的**内部槽**，指向查询回落对象。**这才是
  "原型"本体**，L1 对应堆对象里的一个指针字段。
- **`prototype`**：函数/类才有的**普通自有属性**，值是个对象；`new C()` 实例的 [[Prototype]]
  就指向它（类语法自动配好）。
- **`__proto__`**：Object.prototype 上的 getter/setter（历史遗留访问器），读写
  [[Prototype]] 的非正式通道；标准写法 `Object.getPrototypeOf / setPrototypeOf`。
- 原型链的终点：**null**。

---

## 附：一页速查

| 你问过的 | 一句话答案 |
|---|---|
| JS 有类吗 | ES2015 起有 class 语法，底下仍是原型链（class 是糖） |
| TS 类与 JS 类的区别 | TS 类 = JS 类 + 纯编译期类型设施（修饰符/abstract/implements…全擦除） |
| 编译后类为何还在 | TS 只擦类型不擦实现；类是运行时代码。interface 才是"纯参考" |
| extends 加长什么链 | 原型链：Sub.prototype → Base.prototype → … → null；查找即委托 |
| 先 new 后 extends 影响旧实例吗 | 不影响（链结构出生即冻结）；prototype 后补方法旧实例能看见（内容活） |
| instanceof | 沿原型链找 Class.prototype；可被 `Symbol.hasInstance` 定制（Service 就干了） |
| extend/isolate/intercept | 普通实例方法，在 ctx 上调用、产出子 context 对象；与 extends 关键字纯撞名 |
| constructor(ctx, name) | 普通参数表；new 照用；"挂载"是函数体行为不是语法 |
| Proxy 是什么 | JS 标准内建类（非关键字、非 TS 发明）；new 返回包装对象；Context 构造函数 return 它 |
| 四服务何时实例化 | 就在 `new Context()` 构造函数体内同步完成；loader 只往实例里填条目 |

| 后补 prototype 方法谁看得见 | 所有途经该原型的实例（新旧都算）；父类实例永远看不见子类原型的东西 |
| 同类型对象间有原型链吗 | 有——Object.create(parent) 把实例放进 [[Prototype]]；链的意义是查找回落，与类型无关 |
| 数组嵌套是原型链吗 | 不是——嵌套只是包含（元素引用），没有 [[Prototype]] 委托链接 |
| .d.ts 给谁用 | 库消费者的 tsc/IDE（跨包类型检查）；引擎永不读；类比 C 的 .h |
| declare 什么意思 | "此名运行时已存在，此处仅类型"；实现在旁边的 .js |
| 泛型是什么 | 类型层面的参数化（Array<T>），纯编译期、擦除 |
| constructor 构造什么 | 该类型的实例对象（值）——不是函数、不是类型；类型在类定义时就存在 |
| "Context 内嵌 Events" 是子类吗 | 不是，是组合（has-a）+构造期实例化；继承是 is-a、不创建父实例 |
| Proxy 是别名吗 | 不是——带拦截逻辑的新对象；ctx.llm 是陷阱现场计算，不是预存属性 |
| Service 特别在哪 | 模式不在结构：构造即登记、随宿主 fiber 撤销、可选可调用；不包含四服务，经 this.ctx 可达 |

| Symbol 与 Symbol.for | Symbol() 每次全新；Symbol.for() 全局注册表按键复用——Cordis 全用后者，多副本互认 |
| unique symbol 干嘛用 | 让 symbol 能做 interface 计算键（普通 symbol 不行）；身份可被类型系统追踪 |
| Context.is 的黑科技 | 静态方法 + Symbol.toPrimitive ⇒ 兼任全局符号键；跨副本品牌判定 |
| 多态 this 类型 | extend(): this——返回"调用者的类型"，链式派生不丢类型；编译期 |
| __proto__/[[Prototype]]/prototype | 内部槽（本体）/ 函数与类的普通属性（实例原型的落点）/ 废弃访问器（读写通道） |
| 原型链终点 | null（Object.prototype 是最后一站，不是终点） |
| Dict 出自哪 | cosmokit（非 cordis 本体）；Dict<T, K extends string\|symbol>，键可 symbol |
| symbols 出自哪 | cordis utils.ts；全部 Symbol.for('cordis.*')——跨副本互操作根基 |

实测环境：node 22（实验 1–9 均为本文写作时一手运行，`node -e` 可复跑）。
