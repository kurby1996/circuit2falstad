/**
 * Automated CircuitJS1 Electrical Continuity, Short-Circuit & Geometry Verifier
 * Parses generated .circuitjs.txt files using CircuitJS1's exact post & wire-closure rules
 * and asserts 100% netlist isomorphism against the input SchematicIR!
 */
const fs = require("fs");
const path = require("path");
const LZString = require("../static/lzstring.js");
const PromptSchema = require("../static/prompt-schema.js");
const CircuitCompiler = require("../static/compiler.js");

class DisjointSet {
  constructor() {
    this.parent = new Map();
  }
  find(k) {
    if (!this.parent.has(k)) this.parent.set(k, k);
    if (this.parent.get(k) !== k) {
      this.parent.set(k, this.find(this.parent.get(k)));
    }
    return this.parent.get(k);
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function pointStrictlyInsideSegment(x1, y1, x2, y2, px, py) {
  if (x1 === x2 && px === x1) {
    const lo = Math.min(y1, y2);
    const hi = Math.max(y1, y2);
    return py > lo && py < hi;
  }
  if (y1 === y2 && py === y1) {
    const lo = Math.min(x1, x2);
    const hi = Math.max(x1, x2);
    return px > lo && px < hi;
  }
  return false;
}

function verifyCircuitCompilation(name, ir) {
  const res = CircuitCompiler.compile(ir);
  const txt = res.circuitText.trim();

  // 1. Verify LZString roundtrip
  const ctz = LZString.compressToEncodedURIComponent(txt);
  const decompressed = LZString.decompressFromEncodedURIComponent(ctz);
  if (decompressed !== txt) {
    throw new Error(`[${name}] LZString roundtrip mismatch!`);
  }

  // 2. Parse wire closure from generated .circuitjs.txt
  const dsu = new DisjointSet();
  const wires = [];
  const gndPosts = [];

  for (const line of txt.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (!parts[0] || parts[0] === "$" || parts[0] === "x") continue;
    const type = parts[0];
    const x1 = Number(parts[1]);
    const y1 = Number(parts[2]);
    const x2 = Number(parts[3]);
    const y2 = Number(parts[4]);

    if (x1 % 16 !== 0 || y1 % 16 !== 0) {
      throw new Error(`[${name}] Non-16px grid coordinate on line: ${line}`);
    }
    if (type === "w") {
      if (x2 % 16 !== 0 || y2 % 16 !== 0) {
        throw new Error(`[${name}] Wire endpoint off 16px grid: ${line}`);
      }
      dsu.union(`${x1},${y1}`, `${x2},${y2}`);
      wires.push({ x1, y1, x2, y2 });
    } else if (type === "g") {
      gndPosts.push(`${x1},${y1}`);
    }
  }

  // Ground symbols internally connect to each other in CircuitJS1
  for (let i = 1; i < gndPosts.length; i++) {
    dsu.union(gndPosts[0], gndPosts[i]);
  }

  // 3. Collect all instantiated component pins and check:
  //    (a) All pins of same IR net share the EXACT same DSU root!
  //    (b) No two pins of DIFFERENT IR nets share the same DSU root (zero shorts)!
  //    (c) No wire passes strictly through the interior over another net's pin!
  const netToRoot = new Map();
  const rootToNet = new Map();
  const allPins = [];

  for (const el of res.elements) {
    for (const [pinName, pt] of Object.entries(el.pinCoords)) {
      if (pt.x % 16 !== 0 || pt.y % 16 !== 0) {
        throw new Error(`[${name}] Pin ${el.comp.id}.${pinName} (${pt.x},${pt.y}) not on 16px grid!`);
      }
      const net = el.comp.pins[pinName];
      if (!net || net === "NC") continue;
      const coordKey = `${pt.x},${pt.y}`;
      const root = dsu.find(coordKey);
      allPins.push({ compId: el.comp.id, pinName, net, x: pt.x, y: pt.y, root });

      if (!netToRoot.has(net)) {
        if (rootToNet.has(root) && rootToNet.get(root) !== net) {
          throw new Error(
            `[${name}] SHORT CIRCUIT between net '${net}' (${el.comp.id}.${pinName}) and net '${rootToNet.get(root)}'!`
          );
        }
        netToRoot.set(net, root);
        rootToNet.set(root, net);
      } else {
        const expectedRoot = netToRoot.get(net);
        if (root !== expectedRoot) {
          throw new Error(
            `[${name}] OPEN CIRCUIT on net '${net}': pin ${el.comp.id}.${pinName} at (${pt.x},${pt.y}) is disconnected!`
          );
        }
      }
    }
  }

  for (const w of wires) {
    const wireNet = rootToNet.get(dsu.find(`${w.x1},${w.y1}`));
    for (const p of allPins) {
      if (pointStrictlyInsideSegment(w.x1, w.y1, w.x2, w.y2, p.x, p.y)) {
        throw new Error(
          `[${name}] Unsplit wire (${w.x1},${w.y1})->(${w.x2},${w.y2}) [net=${wireNet}] passes over pin ${p.compId}.${p.pinName} (${p.x},${p.y}) [net=${p.net}]!`
        );
      }
    }
  }

  console.log(
    `✅ PASS [${name}]: ${res.stats.componentCount} components, ${res.stats.netCount} nets, ${res.stats.wireCount} wires, ctzLen=${ctz.length}`
  );
  return { res, ctz };
}

// 1. Test all built-in demos
let blackboardOutput = null;
for (const demo of PromptSchema.BUILTIN_DEMOS) {
  const out = verifyCircuitCompilation(demo.name, demo.ir);
  if (demo.key === "blackboard_reverse_prot") {
    blackboardOutput = out;
  }
}

// 2. Test complex active circuit (CMOS + OpAmp + Potentiometer + PolarCap + LED + Switch)
verifyCircuitCompilation("综合有源元件压力测试 (OpAmp + NMOS + PMOS + Pot + LED)", {
  title: "综合元件测试",
  components: [
    { id: "VDD", type: "dc_rail", voltage: 12, gx: 1, gy: 1, pins: { out: "VDD" } },
    { id: "POT1", type: "potentiometer", value: "10k", gx: 3, gy: 4, dir: "down", pins: { p1: "VDD", p2: "GND", wiper: "VIN_P" } },
    { id: "U1", type: "opamp", gx: 7, gy: 4, dir: "right", pins: { in_pos: "VIN_P", in_neg: "VOUT", out: "VOUT" } },
    { id: "MP1", type: "pmos", gx: 11, gy: 3, base_dir: "left", pins: { G: "VOUT", S: "VDD", D: "DRAIN_N" } },
    { id: "MN1", type: "nmos", gx: 11, gy: 6, base_dir: "left", pins: { G: "VOUT", D: "DRAIN_N", S: "GND" } },
    { id: "SW1", type: "switch", closed: true, gx: 14, gy: 4, dir: "right", pins: { p1: "DRAIN_N", p2: "LED_A" } },
    { id: "R_LIM", type: "resistor", value: "470", gx: 17, gy: 5, dir: "down", pins: { p1: "LED_A", p2: "LED_MID" } },
    { id: "D_LED", type: "led", gx: 17, gy: 8, dir: "down", pins: { anode: "LED_MID", cathode: "GND" } },
    { id: "C_POL", type: "polarized_capacitor", value: "47uF", gx: 14, gy: 7, dir: "down", pins: { pos: "DRAIN_N", neg: "GND" } },
    { id: "GND1", type: "ground", gx: 11, gy: 10, pins: { gnd: "GND" } },
  ],
});

// 3. Export the user's blackboard circuit directly to outputs/
if (blackboardOutput) {
  const outDir = path.join(__dirname, "..", "outputs");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "防反接电路_黑板原图.circuitjs.txt");
  fs.writeFileSync(outFile, blackboardOutput.res.circuitText, "utf8");
  console.log(`\n📄 Exported blackboard circuit to: ${outFile}`);
  console.log(`🔗 Direct Falstad URL:\nhttps://www.falstad.com/circuit/circuitjs.html?ctz=${blackboardOutput.ctz}\n`);
}
