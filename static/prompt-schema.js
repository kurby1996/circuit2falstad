/**
 * Vision AI Prompt Templates & Built-in Verified Demo Schematics
 * Generates structured SchematicIR JSON that our deterministic CircuitJS1 Compiler
 * converts into 100% grid-aligned, pin-verified Falstad (.circuitjs.txt & ?ctz= URL) format.
 */
(function (global) {
  "use strict";

  const SYSTEM_PROMPT = `你是一位资深硬件电路工程师与原理图拓扑解析专家。
你的任务是将用户提供的电路原理图照片（包括黑板粉笔手绘图、教材插图、白板草图、EDA软件截图）精准解析为结构化 JSON 电路拓扑描述（SchematicIR），供下游确定性编译器转换为 Falstad CircuitJS1 仿真文件。

请严格遵守以下工程识别规范：
1. 【元件类型 type 枚举（必须精确使用以下名称）】：
   - "dc_rail"     : 单端直流电源输入节点（如图中标有 "24V"、"VCC"、"+5V"、"+12V" 的单点电源端），引脚为 {"out": "网络名"}，参数 "voltage" (数字，单位V)
   - "dc_source"   : 双端直流电压源/电池，引脚为 {"pos": "正极网络", "neg": "负极网络"}，参数 "voltage" (V)
   - "ac_source"   : 双端交流电压源，引脚为 {"pos": "端1网络", "neg": "端2网络"}，参数 "voltage" (峰值V), "frequency" (Hz，默认50)
   - "ground"      : 接地符号（GND），引脚为 {"gnd": "GND"}
   - "resistor"    : 电阻（矩形框或锯齿线），引脚为 {"p1": "端1网络", "p2": "端2网络"}，参数 "value" (如 "20k", "2k", "100", "4.7k")
   - "capacitor"   : 无极性电容，引脚为 {"p1": "端1网络", "p2": "端2网络"}，参数 "value" (若图中未标容值只写了C1/C2，默认给 "10uF" 并在notes说明)
   - "polarized_capacitor": 电解/有极性电容，引脚为 {"pos": "正极网络", "neg": "负极网络"}，参数 "value" (如 "100uF")
   - "inductor"    : 电感，引脚为 {"p1": "端1网络", "p2": "端2网络"}，参数 "value" (如 "10mH")
   - "diode"       : 普通二极管，引脚为 {"anode": "阳极(三角形底边)", "cathode": "阴极(竖线端)"}
   - "zener"       : 稳压二极管(齐纳管)，引脚为 {"anode": "阳极(三角形底边)", "cathode": "阴极(带折弯翼的横/竖线端)"}，参数 "zvoltage" (数字，单位V，如 6.3, 10, 5.1)
                     ⚠️ 极性特别注意：稳压管通常工作在反向击穿区！若稳压管竖直放置且三角形尖端朝上顶住折弯横杠，则【上方是 cathode(阴极)，下方是 anode(阳极)】！务必仔细核对三角形指向！
   - "led"         : 发光二极管，引脚为 {"anode": "阳极", "cathode": "阴极"}
   - "npn"         : NPN三极管（发射极箭头【朝外】背离基极横杠），引脚为 {"B": "基极网络", "C": "集电极网络", "E": "发射极(带箭头脚)网络"}
   - "pnp"         : PNP三极管（发射极箭头【朝内】指向基极横杠），引脚为 {"B": "基极网络", "C": "集电极网络", "E": "发射极(带箭头脚)网络"}
                     ⚠️ 三极管特别注意：务必看清箭头在左边脚还是右边脚、朝内还是朝外！带箭头的引脚永远是 E（发射极），不带箭头的斜脚永远是 C（集电极），中间垂直于横杠引出的是 B（基极）！
   - "nmos"        : N沟道MOS管，引脚为 {"G": "栅极", "D": "漏极", "S": "源极"}
   - "pmos"        : P沟道MOS管，引脚为 {"G": "栅极", "D": "漏极", "S": "源极"}
   - "opamp"       : 运算放大器，引脚为 {"in_pos": "同相输入(+)", "in_neg": "反相输入(-)", "out": "输出端"}
   - "switch"      : 开关，引脚为 {"p1": "端1", "p2": "端2"}，参数 "closed" (布尔值)
   - "potentiometer": 电位器，引脚为 {"p1": "端1", "p2": "端2", "wiper": "滑动端"}，参数 "value" (如 "10k")
   - "output"      : 电压探针/输出观测点，引脚为 {"in": "被观测网络"}

2. 【布局坐标 gx, gy 与朝向 dir 规范】：
   - 将原图映射到一个左上角为 (0,0)、向右 gx 递增(范围 0~16)、向下 gy 递增(范围 0~12) 的整数网格中，尽量忠实还原原图的相对方位（左中右、上中下），相邻元件之间至少留出 2~3 个单位间距。
   - 双端元件的 "dir" 表示从第一个引脚（p1 / anode / pos）指向第二个引脚（p2 / cathode / neg）的视觉方向：可选 "right" | "left" | "down" | "up"。
   - 三极管(npn/pnp)与MOS管(nmos/pmos)请提供 "base_dir"（基极B或栅极G从管体引出的朝向）：可选 "left" | "right" | "up" | "down"。例如基极在下方朝下引出则填 "down"，基极在左侧朝左引出则填 "left"。

3. 【网络连通性校验】：
   - 所有导线直接相连的引脚必须使用【完全相同的网络名称字符串】（例如统一用 "GND" 表示地网络）。
   - 如果电路中没有接地点但属于独立回路，在负端补一个 "ground" 元件以确保仿真矩阵可解。
   - 只输出合法 JSON 对象，不要附加任何多余解释文字。`;

  const USER_PROMPT = `请仔细识别这张电路图中的所有元器件、参数数值、极性方向（特别是二极管/稳压管阴阳极、NPN/PNP箭头方向与C/B/E脚位）以及导线连接关系，并严格按以下 JSON 结构输出：

{
  "title": "电路名称（如图中标题或功能概括）",
  "description": "一句话说明该电路的工作原理或拓扑结构",
  "notes": "如果有未标注参数的元件（如电容未标容值），在此说明所赋予的合理默认值",
  "components": [
    {
      "id": "D1",
      "type": "diode",
      "label": "D1",
      "gx": 4,
      "gy": 1,
      "dir": "right",
      "pins": { "anode": "VIN", "cathode": "N1" }
    },
    {
      "id": "Q1",
      "type": "pnp",
      "label": "Q1",
      "gx": 8,
      "gy": 4,
      "base_dir": "down",
      "beta": 100,
      "pins": { "E": "VOUT_NODE", "B": "Q1_B", "C": "Q1_C" }
    }
  ]
}`;

  /**
   * Built-in verified demo circuits:
   * Demo 1 is the EXACT circuit from the user's uploaded blackboard image ("防反接电路")!
   */
  const BUILTIN_DEMOS = [
    {
      key: "blackboard_reverse_prot",
      name: "示例1：黑板手绘图（防反接与稳压保护电路）",
      imageUrl: "/examples/blackboard-reverse-protection.png",
      ir: {
        title: "防反接与过压钳位保护电路（黑板原图）",
        description:
          "输入24V经D1防反接与20K电阻给C2充电；PNP管Q1(发射极接右端节点、基极经2K与10V稳压管接地)配合6.3V稳压管、2K电阻及NPN管Q2构成电压检测与钳位回路。",
        notes: "原图中 C2 未标注具体容值，默认设为 10uF 以便直观观察上电充电与稳压钳位动态过程。",
        components: [
          {
            id: "V1",
            type: "dc_rail",
            label: "24V",
            voltage: 24,
            gx: 1,
            gy: 1,
            dir: "left",
            pins: { out: "VIN_24V" },
          },
          {
            id: "D1",
            type: "diode",
            label: "D1",
            gx: 4,
            gy: 1,
            dir: "right",
            pins: { anode: "VIN_24V", cathode: "N_D1_R1" },
          },
          {
            id: "R1",
            type: "resistor",
            label: "20K",
            value: "20k",
            gx: 8,
            gy: 1,
            dir: "right",
            pins: { p1: "N_D1_R1", p2: "N_TOP_RIGHT" },
          },
          {
            id: "Q1",
            type: "pnp",
            label: "Q1",
            gx: 8,
            gy: 4,
            base_dir: "down",
            beta: 100,
            pins: {
              E: "N_TOP_RIGHT",
              B: "N_Q1B",
              C: "N_Q1C",
            },
          },
          {
            id: "C2",
            type: "capacitor",
            label: "C2",
            value: "10uF",
            gx: 12,
            gy: 6,
            dir: "down",
            pins: { p1: "N_TOP_RIGHT", p2: "GND" },
          },
          {
            id: "Z1",
            type: "zener",
            label: "6.3V",
            zvoltage: 6.3,
            gx: 2,
            gy: 5,
            dir: "up",
            pins: { anode: "N_Z1A", cathode: "N_Q1C" },
          },
          {
            id: "R2",
            type: "resistor",
            label: "2K",
            value: "2k",
            gx: 2,
            gy: 8,
            dir: "down",
            pins: { p1: "N_Z1A", p2: "N_Q2B" },
          },
          {
            id: "R3",
            type: "resistor",
            label: "2K",
            value: "2k",
            gx: 8,
            gy: 6,
            dir: "down",
            pins: { p1: "N_Q1B", p2: "N_Q2C_Z2K" },
          },
          {
            id: "Q2",
            type: "npn",
            label: "Q2",
            gx: 5,
            gy: 9,
            base_dir: "left",
            beta: 100,
            pins: {
              B: "N_Q2B",
              C: "N_Q2C_Z2K",
              E: "GND",
            },
          },
          {
            id: "Z2",
            type: "zener",
            label: "10V",
            zvoltage: 10,
            gx: 8,
            gy: 9,
            dir: "up",
            pins: { anode: "GND", cathode: "N_Q2C_Z2K" },
          },
          {
            id: "GND1",
            type: "ground",
            label: "GND",
            gx: 12,
            gy: 11,
            pins: { gnd: "GND" },
          },
        ],
      },
    },
    {
      key: "zener_follower_reg",
      name: "示例2：串联型稳压管射极跟随稳压电路",
      imageUrl: "",
      ir: {
        title: "串联稳压管射极跟随器电路",
        description: "12V 输入经 1k 限流电阻与 5.6V 稳压管建立基准电压，NPN 射极跟随器驱动 470Ω 负载与 10uF 滤波电容。",
        notes: "经典线性稳压拓扑，输出电压约为 5.6V - 0.65V ≈ 4.95V。",
        components: [
          {
            id: "VIN",
            type: "dc_rail",
            label: "12V",
            voltage: 12,
            gx: 1,
            gy: 1,
            dir: "left",
            pins: { out: "VIN" },
          },
          {
            id: "R_BIAS",
            type: "resistor",
            label: "1k",
            value: "1k",
            gx: 4,
            gy: 3,
            dir: "down",
            pins: { p1: "VIN", p2: "VREF" },
          },
          {
            id: "DZ1",
            type: "zener",
            label: "5.6V",
            zvoltage: 5.6,
            gx: 4,
            gy: 7,
            dir: "up",
            pins: { anode: "GND", cathode: "VREF" },
          },
          {
            id: "Q_PASS",
            type: "npn",
            label: "Q1",
            gx: 8,
            gy: 4,
            base_dir: "left",
            beta: 100,
            pins: { B: "VREF", C: "VIN", E: "VOUT" },
          },
          {
            id: "C_OUT",
            type: "capacitor",
            label: "10uF",
            value: "10uF",
            gx: 10,
            gy: 7,
            dir: "down",
            pins: { p1: "VOUT", p2: "GND" },
          },
          {
            id: "R_LOAD",
            type: "resistor",
            label: "470Ω",
            value: "470",
            gx: 13,
            gy: 7,
            dir: "down",
            pins: { p1: "VOUT", p2: "GND" },
          },
          {
            id: "VO_PROBE",
            type: "output",
            label: "VOUT",
            gx: 15,
            gy: 5,
            dir: "right",
            pins: { in: "VOUT" },
          },
          {
            id: "GND1",
            type: "ground",
            label: "GND",
            gx: 8,
            gy: 10,
            pins: { gnd: "GND" },
          },
        ],
      },
    },
    {
      key: "rectifier_rc",
      name: "示例3：桥式整流滤波电路（AC 转 DC）",
      imageUrl: "",
      ir: {
        title: "全波桥式整流与 RC 滤波电路",
        description: "交流 10V(50Hz) 经四只二极管组成的整流桥转变为脉动直流，并由 100uF 电容平滑滤波后供给 1kΩ 负载。",
        notes: "",
        components: [
          {
            id: "VAC",
            type: "ac_source",
            label: "AC 10V",
            voltage: 10,
            frequency: 50,
            gx: 1,
            gy: 5,
            dir: "up",
            pins: { pos: "AC_TOP", neg: "AC_BOT" },
          },
          {
            id: "D1",
            type: "diode",
            label: "D1",
            gx: 6,
            gy: 2,
            dir: "right",
            pins: { anode: "AC_TOP", cathode: "DC_POS" },
          },
          {
            id: "D2",
            type: "diode",
            label: "D2",
            gx: 6,
            gy: 4,
            dir: "right",
            pins: { anode: "AC_BOT", cathode: "DC_POS" },
          },
          {
            id: "D3",
            type: "diode",
            label: "D3",
            gx: 4,
            gy: 6,
            dir: "right",
            pins: { anode: "GND", cathode: "AC_TOP" },
          },
          {
            id: "D4",
            type: "diode",
            label: "D4",
            gx: 4,
            gy: 8,
            dir: "right",
            pins: { anode: "GND", cathode: "AC_BOT" },
          },
          {
            id: "C1",
            type: "capacitor",
            label: "100uF",
            value: "100uF",
            gx: 10,
            gy: 5,
            dir: "down",
            pins: { p1: "DC_POS", p2: "GND" },
          },
          {
            id: "RL",
            type: "resistor",
            label: "1k",
            value: "1k",
            gx: 13,
            gy: 5,
            dir: "down",
            pins: { p1: "DC_POS", p2: "GND" },
          },
          {
            id: "GND1",
            type: "ground",
            label: "GND",
            gx: 10,
            gy: 9,
            pins: { gnd: "GND" },
          },
        ],
      },
    },
  ];

  const PROVIDER_PRESETS = {
    notion_local: {
      name: "本地 Notion 编程助手网关 (127.0.0.1:18081)",
      baseUrl: "http://127.0.0.1:18081/v1",
      defaultModel: "gemini-3.1-pro",
      models: ["gemini-3.1-pro", "sonnet-4.6", "gpt-5.2"],
      placeholderKey: "sk-...",
    },
    siliconflow: {
      name: "硅基流动 SiliconFlow (推荐国内直连)",
      baseUrl: "https://api.siliconflow.cn/v1",
      defaultModel: "Qwen/Qwen2.5-VL-72B-Instruct",
      models: ["Qwen/Qwen2.5-VL-72B-Instruct", "Qwen/Qwen2.5-VL-32B-Instruct", "Pro/Qwen/Qwen2.5-VL-7B-Instruct"],
      placeholderKey: "sk-...",
    },
    dashscope: {
      name: "阿里云百炼 / 通义千问 Qwen-VL",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      defaultModel: "qwen-vl-max",
      models: ["qwen-vl-max", "qwen-vl-plus", "qwen2.5-vl-72b-instruct"],
      placeholderKey: "sk-...",
    },
    doubao: {
      name: "火山引擎 / 豆包视觉大模型 (Ark)",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      defaultModel: "doubao-1-5-vision-pro-32k-250115",
      models: ["doubao-1-5-vision-pro-32k-250115"],
      placeholderKey: "填写火山方舟 API Key",
    },
    gemini_native: {
      name: "Google Gemini 官方 API",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultModel: "gemini-2.5-flash",
      models: ["gemini-2.5-pro", "gemini-2.5-flash"],
      placeholderKey: "AIzaSy...",
    },
    openai: {
      name: "OpenAI / OpenRouter 兼容接口",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o",
      models: ["gpt-4o", "gpt-4.1", "claude-3-7-sonnet-latest"],
      placeholderKey: "sk-...",
    },
    zhipu: {
      name: "智谱清言 GLM-4V",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      defaultModel: "glm-4v-plus",
      models: ["glm-4v-plus", "glm-4v-flash"],
      placeholderKey: "填写智谱 API Key",
    },
    ollama: {
      name: "本地 Ollama 视觉模型 (免 Key)",
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "qwen2.5vl:7b",
      models: ["qwen2.5vl:7b", "llama3.2-vision:11b", "minicpm-v:latest"],
      placeholderKey: "本地 Ollama 无需填写 Key",
    },
    custom: {
      name: "自定义 OpenAI 兼容接口",
      baseUrl: "",
      defaultModel: "",
      models: ["gemini-3.1-pro", "sonnet-4.6", "gpt-5.2", "gpt-4o", "qwen-vl-max"],
      placeholderKey: "Bearer API Key",
    },
  };

  const exported = {
    SYSTEM_PROMPT,
    USER_PROMPT,
    BUILTIN_DEMOS,
    PROVIDER_PRESETS,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
  global.PromptSchema = exported;
})(typeof globalThis !== "undefined" ? globalThis : window);
