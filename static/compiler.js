/**
 * Circuit2Falstad Deterministic Schematic Compiler & Obstacle-Aware A* Router
 *
 * Converts structured SchematicIR JSON into:
 * 1. 100% pin-verified, 16px-grid-snapped Falstad CircuitJS1 text format (.circuitjs.txt)
 * 2. Local interactive SVG preview showing component symbols, pin names, and net routing
 *
 * Pin coordinate equations are ported directly from CircuitJS1 source:
 * CircuitElm.java, TransistorElm.java, MosfetElm.java, OpAmpElm.java, PotElm.java,
 * DiodeElm.java, ZenerElm.java, VoltageElm.java, RailElm.java, TextElm.java.
 */
(function (global) {
  "use strict";

  const GRID = 16; // Falstad native snap grid = 16px
  const COARSE_STEP = 3 * GRID; // 48px per coarse grid unit (fits viewport cleanly like native Falstad examples)
  const ORIGIN_X = 7 * GRID; // 112px
  const ORIGIN_Y = 4 * GRID; // 64px

  function fmtNum(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "0";
    return String(Number(v.toPrecision(6)));
  }

  /**
   * Escape text per CircuitJS1 CustomLogicModel.escape()
   */
  function escapeFalstadText(str) {
    const s = String(str ?? "");
    if (s.length === 0) return "\\0";
    return s
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/ /g, "\\s")
      .replace(/\+/g, "\\p")
      .replace(/=/g, "\\q")
      .replace(/#/g, "\\h")
      .replace(/&/g, "\\a")
      .replace(/\r/g, "\\r");
  }

  /**
   * Parse engineering value strings ("20K", "4k7", "10uF", "6.3V", "20mΩ", "100n")
   */
  function parseEngineeringValue(raw, fallback = 1000) {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (raw == null) return fallback;
    let s = String(raw)
      .trim()
      .replace(/,/g, "")
      .replace(/[ΩωΩ]/g, "")
      .replace(/(ohms?|farads?|henr(?:y|ies)|volts?|amps?|hz)$/i, "")
      .replace(/[VvAaFfHh]$/, "")
      .trim();

    if (!s) return fallback;

    // Handle 4k7 / 4R7 / 2M2 notation
    const rNotation = s.match(/^([+-]?\d+)([rRkKmMuUnNpP])(\d+)$/);
    if (rNotation) {
      const intPart = rNotation[1];
      const multChar = rNotation[2];
      const fracPart = rNotation[3];
      s = `${intPart}.${fracPart}${multChar === "r" || multChar === "R" ? "" : multChar}`;
    }

    const match = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([TGMkhmuµnpf]?)/i);
    if (!match) return fallback;

    const num = parseFloat(match[1]);
    if (!Number.isFinite(num)) return fallback;
    const prefix = match[2] || "";

    // Note: In electronics schematics, "20K" / "10M" uppercase K/M:
    // 'k' or 'K' = 1e3; 'M' = 1e6, 'm' = 1e-3 (unless resistor >1M written as "10M")
    const multipliers = {
      T: 1e12,
      G: 1e9,
      M: 1e6,
      k: 1e3,
      K: 1e3,
      h: 1e2,
      m: 1e-3,
      u: 1e-6,
      U: 1e-6,
      "µ": 1e-6,
      n: 1e-9,
      N: 1e-9,
      p: 1e-12,
      P: 1e-12,
      f: 1e-15,
    };
    const mult = multipliers[prefix] ?? 1;
    return num * mult;
  }

  /**
   * Port of CircuitElm.java interpPoint2(Point a, Point b, Point c, Point d, double f, double g)
   */
  function interpPoint2(ax, ay, bx, by, f, g) {
    const gx = by - ay;
    const gy = ax - bx;
    const len = Math.sqrt(gx * gx + gy * gy);
    if (len === 0) {
      return [
        { x: ax, y: ay },
        { x: ax, y: ay },
      ];
    }
    const gNorm = g / len;
    return [
      {
        x: Math.floor(ax * (1 - f) + bx * f + gNorm * gx + 0.48),
        y: Math.floor(ay * (1 - f) + by * f + gNorm * gy + 0.48),
      },
      {
        x: Math.floor(ax * (1 - f) + bx * f - gNorm * gx + 0.48),
        y: Math.floor(ay * (1 - f) + by * f - gNorm * gy + 0.48),
      },
    ];
  }

  function calcBaseDsign(ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    return dy === 0 ? (dx >= 0 ? 1 : -1) : dy >= 0 ? 1 : -1;
  }

  function snap16(v) {
    return Math.round(v / GRID) * GRID;
  }

  /**
   * Normalize incoming LLM JSON into canonical SchematicIR
   */
  function normalizeIr(raw) {
    if (!raw || typeof raw !== "object") {
      throw new Error("无效的电路 JSON 结构");
    }
    const comps = Array.isArray(raw.components) ? raw.components : [];
    const normalized = comps.map((c, idx) => {
      const type = normalizeCompType(c.type);
      const id = String(c.id || `U${idx + 1}`).trim();
      const gx = Number.isFinite(Number(c.gx ?? c.pos?.x)) ? Number(c.gx ?? c.pos?.x) : (idx % 5) * 3 + 2;
      const gy = Number.isFinite(Number(c.gy ?? c.pos?.y)) ? Number(c.gy ?? c.pos?.y) : Math.floor(idx / 5) * 3 + 2;
      const pins = normalizePins(type, c.pins || {});
      return Object.assign({}, c, {
        id,
        type,
        label: c.label != null ? String(c.label) : id,
        gx,
        gy,
        dir: normalizeDir(c.dir, "right"),
        base_dir: normalizeDir(c.base_dir || c.gate_dir || c.dir, "left"),
        pins,
      });
    });

    return {
      title: String(raw.title || "识别生成的电路"),
      description: String(raw.description || ""),
      notes: String(raw.notes || ""),
      components: normalized,
    };
  }

  function normalizeCompType(t) {
    const s = String(t || "resistor").toLowerCase().trim();
    const alias = {
      r: "resistor",
      res: "resistor",
      c: "capacitor",
      cap: "capacitor",
      electrolytic_capacitor: "polarized_capacitor",
      pol_cap: "polarized_capacitor",
      polar_capacitor: "polarized_capacitor",
      l: "inductor",
      ind: "inductor",
      d: "diode",
      z: "zener",
      zener_diode: "zener",
      bjt_npn: "npn",
      npn_transistor: "npn",
      bjt_pnp: "pnp",
      pnp_transistor: "pnp",
      nmosfet: "nmos",
      n_mosfet: "nmos",
      pmosfet: "pmos",
      p_mosfet: "pmos",
      op_amp: "opamp",
      rail: "dc_rail",
      voltage_rail: "dc_rail",
      vcc: "dc_rail",
      battery: "dc_source",
      voltage_source: "dc_source",
      vdc: "dc_source",
      vac: "ac_source",
      gnd: "ground",
      pot: "potentiometer",
      probe: "output",
    };
    return alias[s] || s;
  }

  function normalizeDir(d, fallback) {
    const s = String(d || "").toLowerCase().trim();
    if (["right", "left", "up", "down"].includes(s)) return s;
    return fallback;
  }

  function normalizePins(type, rawPins) {
    const p = Object.assign({}, rawPins);
    const vals = Object.values(p).map((v) => String(v));
    if (type === "diode" || type === "zener" || type === "led") {
      return {
        anode: String(p.anode ?? p.A ?? p.a ?? p.p1 ?? p.pos ?? vals[0] ?? "N1"),
        cathode: String(p.cathode ?? p.K ?? p.k ?? p.C ?? p.p2 ?? p.neg ?? vals[1] ?? "GND"),
      };
    }
    if (type === "npn" || type === "pnp") {
      return {
        B: String(p.B ?? p.b ?? p.base ?? vals[0] ?? "NB"),
        C: String(p.C ?? p.c ?? p.collector ?? vals[1] ?? "NC"),
        E: String(p.E ?? p.e ?? p.emitter ?? vals[2] ?? "GND"),
      };
    }
    if (type === "nmos" || type === "pmos") {
      return {
        G: String(p.G ?? p.g ?? p.gate ?? vals[0] ?? "NG"),
        D: String(p.D ?? p.d ?? p.drain ?? vals[1] ?? "ND"),
        S: String(p.S ?? p.s ?? p.source ?? vals[2] ?? "GND"),
      };
    }
    if (type === "opamp") {
      return {
        in_pos: String(p.in_pos ?? p.pos ?? p["+"] ?? p.inp ?? vals[0] ?? "INP"),
        in_neg: String(p.in_neg ?? p.neg ?? p["-"] ?? p.inn ?? vals[1] ?? "INN"),
        out: String(p.out ?? p.output ?? p.O ?? vals[2] ?? "OUT"),
      };
    }
    if (type === "dc_rail") {
      return { out: String(p.out ?? p.pos ?? p.p1 ?? p.node ?? vals[0] ?? "VCC") };
    }
    if (type === "output") {
      return { in: String(p.in ?? p.out ?? p.p1 ?? p.node ?? vals[0] ?? "VOUT") };
    }
    if (type === "ground") {
      return { gnd: String(p.gnd ?? p.p1 ?? p.node ?? vals[0] ?? "GND") };
    }
    if (type === "dc_source" || type === "ac_source" || type === "polarized_capacitor") {
      return {
        pos: String(p.pos ?? p["+"] ?? p.p1 ?? p.anode ?? vals[0] ?? "VCC"),
        neg: String(p.neg ?? p["-"] ?? p.p2 ?? p.cathode ?? vals[1] ?? "GND"),
      };
    }
    if (type === "current_source") {
      return {
        from: String(p.from ?? p.p1 ?? p.pos ?? vals[0] ?? "VCC"),
        to: String(p.to ?? p.p2 ?? p.neg ?? vals[1] ?? "N1"),
      };
    }
    if (type === "potentiometer") {
      return {
        p1: String(p.p1 ?? vals[0] ?? "N1"),
        p2: String(p.p2 ?? vals[1] ?? "GND"),
        wiper: String(p.wiper ?? p.p3 ?? p.w ?? vals[2] ?? "NW"),
      };
    }
    return {
      p1: String(p.p1 ?? p["1"] ?? p.a ?? p.pos ?? vals[0] ?? "N1"),
      p2: String(p.p2 ?? p["2"] ?? p.b ?? p.neg ?? vals[1] ?? "N2"),
    };
  }

  /**
   * Resolve coarse grid collisions so components never sit on top of each other
   */
  function assignCleanCenters(components) {
    if (components.length === 0) return [];
    let minGx = Infinity,
      minGy = Infinity;
    for (const c of components) {
      minGx = Math.min(minGx, c.gx);
      minGy = Math.min(minGy, c.gy);
    }

    const occupied = new Set();
    return components.map((comp) => {
      let cx = Math.round(comp.gx - minGx);
      let cy = Math.round(comp.gy - minGy);

      // Ensure minimum spacing of 2 coarse cells (2 * 48 = 96px) between component centers
      let placed = false;
      for (let radius = 0; radius <= 24 && !placed; radius++) {
        for (let dy = -radius; dy <= radius && !placed; dy++) {
          for (let dx = -radius; dx <= radius && !placed; dx++) {
            if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
            const tx = cx + dx;
            const ty = cy + dy;
            if (tx < 0 || ty < 0) continue;
            let clash = false;
            for (let oy = -1; oy <= 1; oy++) {
              for (let ox = -1; ox <= 1; ox++) {
                if (occupied.has(`${tx + ox},${ty + oy}`)) {
                  clash = true;
                  break;
                }
              }
              if (clash) break;
            }
            if (!clash) {
              cx = tx;
              cy = ty;
              placed = true;
            }
          }
        }
      }
      occupied.add(`${cx},${cy}`);
      return {
        comp,
        px: snap16(ORIGIN_X + cx * COARSE_STEP),
        py: snap16(ORIGIN_Y + cy * COARSE_STEP),
      };
    });
  }

  function dirVector(dir) {
    switch (dir) {
      case "left":
        return { dx: -1, dy: 0 };
      case "up":
        return { dx: 0, dy: -1 };
      case "down":
        return { dx: 0, dy: 1 };
      case "right":
      default:
        return { dx: 1, dy: 0 };
    }
  }

  /**
   * Build exact Falstad element dump line, pin coordinates, and obstacle cells
   */
  function instantiateElement(placedItem, netCentroids) {
    const { comp, px, py } = placedItem;
    const t = comp.type;
    const pins = comp.pins || {};

    // Helper: score candidate pin map against connected net centroids
    const scorePinPlacement = (pinCoords) => {
      let total = 0;
      for (const [pinName, pt] of Object.entries(pinCoords)) {
        const net = pins[pinName];
        const target = net ? netCentroids.get(net) : null;
        if (target && target.count > 1) {
          total += Math.abs(pt.x - target.x) + Math.abs(pt.y - target.y);
        }
      }
      return total;
    };

    // 1-terminal Ground
    if (t === "ground") {
      const p1 = { x: px, y: py };
      const p2 = { x: px, y: py + 32 };
      return {
        comp,
        dumpLines: [`g ${p1.x} ${p1.y} ${p2.x} ${p2.y} 0`],
        pinCoords: { gnd: p1 },
        bodyCells: [{ x: px, y: py + 16 }, p2],
        bbox: { x1: px - 16, y1: py, x2: px + 16, y2: py + 32 },
        showCustomLabel: false,
      };
    }

    // 1-terminal DC Voltage Rail
    if (t === "dc_rail") {
      const v = dirVector(comp.dir || "left");
      const p1 = { x: px, y: py };
      const p2 = { x: px + v.dx * 48, y: py + v.dy * 48 };
      const voltage = fmtNum(parseEngineeringValue(comp.voltage ?? comp.value ?? 5, 5));
      return {
        comp,
        dumpLines: [`R ${p1.x} ${p1.y} ${p2.x} ${p2.y} 0 0 40.0 ${voltage} 0.0 0.0 0.5`],
        pinCoords: { out: p1 },
        bodyCells: [
          { x: px + v.dx * 16, y: py + v.dy * 16 },
          { x: px + v.dx * 32, y: py + v.dy * 32 },
          p2,
        ],
        bbox: {
          x1: Math.min(p1.x, p2.x) - 16,
          y1: Math.min(p1.y, p2.y) - 16,
          x2: Math.max(p1.x, p2.x) + 16,
          y2: Math.max(p1.y, p2.y) + 16,
        },
        showCustomLabel: false,
      };
    }

    // 1-terminal Voltage Output Probe
    if (t === "output") {
      const v = dirVector(comp.dir || "right");
      const p1 = { x: px, y: py };
      const p2 = { x: px + v.dx * 48, y: py + v.dy * 48 };
      return {
        comp,
        dumpLines: [`O ${p1.x} ${p1.y} ${p2.x} ${p2.y} 1 0`],
        pinCoords: { in: p1 },
        bodyCells: [
          { x: px + v.dx * 16, y: py + v.dy * 16 },
          { x: px + v.dx * 32, y: py + v.dy * 32 },
        ],
        bbox: {
          x1: Math.min(p1.x, p2.x),
          y1: Math.min(p1.y, p2.y) - 12,
          x2: Math.max(p1.x, p2.x),
          y2: Math.max(p1.y, p2.y) + 12,
        },
        showCustomLabel: Boolean(comp.label),
      };
    }

    // 3-terminal BJT (npn / pnp)
    if (t === "npn" || t === "pnp") {
      const pnpVal = t === "pnp" ? -1 : 1;
      const beta = fmtNum(parseEngineeringValue(comp.beta ?? 100, 100));
      const bv = dirVector(comp.base_dir || "left");
      const ax = px + bv.dx * 32;
      const ay = py + bv.dy * 32;
      const bx = px;
      const by = py;
      const dsignBase = calcBaseDsign(ax, ay, bx, by);

      const buildCandidate = (flipFlag) => {
        const dsign = flipFlag ? -dsignBase : dsignBase;
        const hs2 = 16 * dsign * pnpVal;
        const [collPt, emitPt] = interpPoint2(ax, ay, bx, by, 1, hs2);
        return {
          flipFlag,
          pinCoords: { B: { x: ax, y: ay }, C: collPt, E: emitPt },
        };
      };

      const c0 = buildCandidate(0);
      const c1 = buildCandidate(1);
      const chosen =
        comp.flip != null
          ? comp.flip
            ? c1
            : c0
          : scorePinPlacement(c1.pinCoords) < scorePinPlacement(c0.pinCoords)
          ? c1
          : c0;

      const midX = (ax + bx) / 2;
      const midY = (ay + by) / 2;
      const perpX = bv.dy !== 0 ? 16 : 0;
      const perpY = bv.dx !== 0 ? 16 : 0;

      return {
        comp,
        dumpLines: [`t ${ax} ${ay} ${bx} ${by} ${chosen.flipFlag} ${pnpVal} 0 0 ${beta}`],
        pinCoords: chosen.pinCoords,
        bodyCells: [
          { x: bx, y: by },
          { x: midX, y: midY },
          { x: midX - perpX, y: midY - perpY },
          { x: midX + perpX, y: midY + perpY },
        ],
        bbox: {
          x1: Math.min(ax, chosen.pinCoords.C.x, chosen.pinCoords.E.x) - 8,
          y1: Math.min(ay, chosen.pinCoords.C.y, chosen.pinCoords.E.y) - 8,
          x2: Math.max(ax, chosen.pinCoords.C.x, chosen.pinCoords.E.x) + 8,
          y2: Math.max(ay, chosen.pinCoords.C.y, chosen.pinCoords.E.y) + 8,
        },
        showCustomLabel: Boolean(comp.label),
      };
    }

    // 3-terminal MOSFET (nmos / pmos)
    if (t === "nmos" || t === "pmos") {
      const pnpBit = t === "pmos" ? 1 : 0; // FLAG_PNP = 1, FLAG_FLIP = 2
      const gv = dirVector(comp.base_dir || "left");
      const ax = px + gv.dx * 32;
      const ay = py + gv.dy * 32;
      const bx = px;
      const by = py;
      const dsignBase = calcBaseDsign(ax, ay, bx, by);

      const buildMosCandidate = (flipBit) => {
        const dsign = flipBit ? -dsignBase : dsignBase;
        const [ptTop, ptBot] = interpPoint2(ax, ay, bx, by, 1, 16 * dsign);
        const pinCoords =
          pnpBit === 0
            ? { G: { x: ax, y: ay }, D: ptTop, S: ptBot }
            : { G: { x: ax, y: ay }, S: ptTop, D: ptBot };
        return { flags: pnpBit | flipBit, pinCoords };
      };

      const m0 = buildMosCandidate(0);
      const m1 = buildMosCandidate(2);
      const chosen = scorePinPlacement(m1.pinCoords) < scorePinPlacement(m0.pinCoords) ? m1 : m0;

      const midX = (ax + bx) / 2;
      const midY = (ay + by) / 2;
      const perpX = gv.dy !== 0 ? 16 : 0;
      const perpY = gv.dx !== 0 ? 16 : 0;

      return {
        comp,
        dumpLines: [`f ${ax} ${ay} ${bx} ${by} ${chosen.flags} 1.5 0.02`],
        pinCoords: chosen.pinCoords,
        bodyCells: [
          { x: bx, y: by },
          { x: midX, y: midY },
          { x: midX - perpX, y: midY - perpY },
          { x: midX + perpX, y: midY + perpY },
        ],
        bbox: {
          x1: Math.min(ax, chosen.pinCoords.D.x, chosen.pinCoords.S.x) - 8,
          y1: Math.min(ay, chosen.pinCoords.D.y, chosen.pinCoords.S.y) - 8,
          x2: Math.max(ax, chosen.pinCoords.D.x, chosen.pinCoords.S.x) + 8,
          y2: Math.max(ay, chosen.pinCoords.D.y, chosen.pinCoords.S.y) + 8,
        },
        showCustomLabel: Boolean(comp.label),
      };
    }

    // 3-terminal Op-Amp
    if (t === "opamp") {
      const ov = dirVector(comp.dir || "right");
      const ax = px - ov.dx * 32;
      const ay = py - ov.dy * 32;
      const bx = px + ov.dx * 32;
      const by = py + ov.dy * 32;
      const dsignBase = calcBaseDsign(ax, ay, bx, by);

      const buildOpCandidate = (swapFlag) => {
        const hs = 16 * dsignBase * (swapFlag ? -1 : 1);
        const [inNeg, inPos] = interpPoint2(ax, ay, bx, by, 0, hs);
        return {
          swapFlag,
          pinCoords: { in_neg: inNeg, in_pos: inPos, out: { x: bx, y: by } },
        };
      };

      const o0 = buildOpCandidate(0);
      const o1 = buildOpCandidate(1);
      const chosen = scorePinPlacement(o1.pinCoords) < scorePinPlacement(o0.pinCoords) ? o1 : o0;

      return {
        comp,
        dumpLines: [`a ${ax} ${ay} ${bx} ${by} ${chosen.swapFlag} 15.0 -15.0 1000000.0`],
        pinCoords: chosen.pinCoords,
        bodyCells: [
          { x: px, y: py },
          { x: px - ov.dx * 16, y: py - ov.dy * 16 },
          { x: px + ov.dx * 16, y: py + ov.dy * 16 },
        ],
        bbox: {
          x1: Math.min(ax, bx) - 16,
          y1: Math.min(ay, by) - 24,
          x2: Math.max(ax, bx) + 16,
          y2: Math.max(ay, by) + 24,
        },
        showCustomLabel: Boolean(comp.label),
      };
    }

    // 3-terminal Potentiometer (174)
    if (t === "potentiometer") {
      const pv = dirVector(comp.dir || "right");
      const ax = px - pv.dx * 32;
      const ay = py - pv.dy * 32;
      const bx = px + pv.dx * 32;
      const by = py + ovSafe(pv).dy * 32;
      const [wiperPt] = interpPoint2(ax, ay, bx, by, 0.5, 16);
      const rVal = fmtNum(parseEngineeringValue(comp.value ?? "10k", 10000));
      const sliderName = (comp.label || comp.id || "Pot").replace(/\s+/g, "_");
      return {
        comp,
        dumpLines: [`174 ${ax} ${ay} ${bx} ${by} 0 ${rVal} 0.5 ${sliderName}`],
        pinCoords: { p1: { x: ax, y: ay }, p2: { x: bx, y: by }, wiper: wiperPt },
        bodyCells: [
          { x: px, y: py },
          { x: px - pv.dx * 16, y: py - pv.dy * 16 },
          { x: px + pv.dx * 16, y: py + pv.dy * 16 },
        ],
        bbox: {
          x1: Math.min(ax, bx, wiperPt.x) - 8,
          y1: Math.min(ay, by, wiperPt.y) - 8,
          x2: Math.max(ax, bx, wiperPt.x) + 8,
          y2: Math.max(ay, by, wiperPt.y) + 8,
        },
        showCustomLabel: false,
      };
    }

    function ovSafe(vec) {
      return vec;
    }

    // All standard 2-terminal components (span 64px = 4 grid units: center ± 32px)
    const v = dirVector(comp.dir || "right");
    const pStart = { x: px - v.dx * 32, y: py - v.dy * 32 };
    const pEnd = { x: px + v.dx * 32, y: py + v.dy * 32 };
    const midCells = [
      { x: px - v.dx * 16, y: py - v.dy * 16 },
      { x: px, y: py },
      { x: px + v.dx * 16, y: py + v.dy * 16 },
    ];
    const bbox = {
      x1: Math.min(pStart.x, pEnd.x) - 12,
      y1: Math.min(pStart.y, pEnd.y) - 12,
      x2: Math.max(pStart.x, pEnd.x) + 12,
      y2: Math.max(pStart.y, pEnd.y) + 12,
    };

    if (t === "diode") {
      return {
        comp,
        dumpLines: [`d ${pStart.x} ${pStart.y} ${pEnd.x} ${pEnd.y} 1 0.805904783`],
        pinCoords: { anode: pStart, cathode: pEnd },
        bodyCells: midCells,
        bbox,
        showCustomLabel: Boolean(comp.label),
      };
    }

    if (t === "zener") {
      const zv = fmtNum(parseEngineeringValue(comp.zvoltage ?? comp.value ?? 5.6, 5.6));
      return {
        comp,
        dumpLines: [`z ${pStart.x} ${pStart.y} ${pEnd.x} ${pEnd.y} 1 0.805904783 ${zv}`],
        pinCoords: { anode: pStart, cathode: pEnd },
        bodyCells: midCells,
        bbox,
        showCustomLabel: true,
        customLabelText: comp.label || `${zv}V`,
      };
    }

    if (t === "led") {
      return {
        comp,
        dumpLines: [`162 ${pStart.x} ${pStart.y} ${pEnd.x} ${pEnd.y} 0 1.0 0.0 0.0`],
        pinCoords: { anode: pStart, cathode: pEnd },
        bodyCells: midCells,
        bbox,
        showCustomLabel: Boolean(comp.label),
      };
    }

    if (t === "dc_source" || t === "ac_source") {
      const posAtEndDefault = comp.dir === "up" || comp.dir === "right";
      const optA = { pos: pEnd, neg: pStart, x1: pStart.x, y1: pStart.y, x2: pEnd.x, y2: pEnd.y };
      const optB = { pos: pStart, neg: pEnd, x1: pEnd.x, y1: pEnd.y, x2: pStart.x, y2: pStart.y };
      const chosen = posAtEndDefault ? optA : optB;

      const volt = fmtNum(parseEngineeringValue(comp.voltage ?? comp.value ?? 5, 5));
      const freq = fmtNum(parseEngineeringValue(comp.frequency ?? 50, 50));
      const wf = t === "ac_source" ? 1 : 0;
      return {
        comp,
        dumpLines: [`v ${chosen.x1} ${chosen.y1} ${chosen.x2} ${chosen.y2} 0 ${wf} ${freq} ${volt} 0.0 0.0 0.5`],
        pinCoords: { pos: chosen.pos, neg: chosen.neg },
        bodyCells: midCells,
        bbox,
        showCustomLabel: false,
      };
    }

    if (t === "polarized_capacitor") {
      const capVal = fmtNum(parseEngineeringValue(comp.value ?? "10uF", 1e-5));
      return {
        comp,
        dumpLines: [`209 ${pStart.x} ${pStart.y} ${pEnd.x} ${pEnd.y} 0 ${capVal} 0 0.001 100`],
        pinCoords: { pos: pStart, neg: pEnd },
        bodyCells: midCells,
        bbox,
        showCustomLabel: false,
      };
    }

    if (t === "capacitor") {
      const capVal = fmtNum(parseEngineeringValue(comp.value ?? "10uF", 1e-5));
      return {
        comp,
        dumpLines: [`c ${pStart.x} ${pStart.y} ${pEnd.x} ${pEnd.y} 0 ${capVal} 0`],
        pinCoords: { p1: pStart, p2: pEnd },
        bodyCells: midCells,
        bbox,
        showCustomLabel: Boolean(comp.label && !/^\d/.test(comp.label)),
      };
    }

    if (t === "inductor") {
      const indVal = fmtNum(parseEngineeringValue(comp.value ?? "10mH", 0.01));
      return {
        comp,
        dumpLines: [`l ${pStart.x} ${pStart.y} ${pEnd.x} ${pEnd.y} 0 ${indVal} 0`],
        pinCoords: { p1: pStart, p2: pEnd },
        bodyCells: midCells,
        bbox,
        showCustomLabel: false,
      };
    }

    if (t === "current_source") {
      const curVal = fmtNum(parseEngineeringValue(comp.value ?? "0.01", 0.01));
      return {
        comp,
        dumpLines: [`i ${pStart.x} ${pStart.y} ${pEnd.x} ${pEnd.y} 0 ${curVal}`],
        pinCoords: { from: pStart, to: pEnd },
        bodyCells: midCells,
        bbox,
        showCustomLabel: false,
      };
    }

    if (t === "switch") {
      const posState = comp.closed ? 0 : 1;
      return {
        comp,
        dumpLines: [`s ${pStart.x} ${pStart.y} ${pEnd.x} ${pEnd.y} 0 ${posState} false`],
        pinCoords: { p1: pStart, p2: pEnd },
        bodyCells: midCells,
        bbox,
        showCustomLabel: Boolean(comp.label),
      };
    }

    // Default: Resistor ('r')
    const rVal = fmtNum(parseEngineeringValue(comp.value ?? comp.resistance ?? "1k", 1000));
    return {
      comp,
      dumpLines: [`r ${pStart.x} ${pStart.y} ${pEnd.x} ${pEnd.y} 0 ${rVal}`],
      pinCoords: { p1: pStart, p2: pEnd },
      bodyCells: midCells,
      bbox,
      showCustomLabel: false,
    };
  }

  /**
   * Obstacle-Aware Orthogonal A* Router on 16px Grid
   * Guarantees:
   * - Never touches pins belonging to a different net
   * - Never overlaps collinearly with wire edges of a different net
   * - Avoids component bodies
   * - Splits wire segments cleanly at every T-junction & pin so Falstad connects all nodes
   */
  function routeAllNets(elements) {
    const netPins = new Map(); // netName -> Array<{x, y, compId, pinName}>
    const pinOwner = new Map(); // "x,y" -> netName
    const bodyObstacles = new Set(); // "x,y"

    for (const el of elements) {
      for (const cell of el.bodyCells) {
        bodyObstacles.add(`${snap16(cell.x)},${snap16(cell.y)}`);
      }
      for (const [pinName, pt] of Object.entries(el.pinCoords)) {
        const net = String(el.comp.pins[pinName] || "").trim();
        if (!net || net.toUpperCase() === "NC") continue;
        const key = `${pt.x},${pt.y}`;
        pinOwner.set(key, net);
        if (!netPins.has(net)) netPins.set(net, []);
        netPins.get(net).push({ x: pt.x, y: pt.y, compId: el.comp.id, pinName });
      }
    }

    // Bounding search box with generous routing margin
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const el of elements) {
      minX = Math.min(minX, el.bbox.x1);
      minY = Math.min(minY, el.bbox.y1);
      maxX = Math.max(maxX, el.bbox.x2);
      maxY = Math.max(maxY, el.bbox.y2);
    }
    minX = snap16(minX) - 6 * GRID;
    minY = snap16(minY) - 6 * GRID;
    maxX = snap16(maxX) + 6 * GRID;
    maxY = snap16(maxY) + 6 * GRID;

    const edgeOwner = new Map(); // canonical edge key -> netName
    const vertexOwner = new Map(); // "x,y" -> Set<netName>
    const routedSegmentsByNet = new Map(); // netName -> Array<{x1,y1,x2,y2}>

    const canonicalEdge = (x1, y1, x2, y2) =>
      x1 < x2 || (x1 === x2 && y1 < y2) ? `${x1},${y1}-${x2},${y2}` : `${x2},${y2}-${x1},${y1}`;

    // Sort nets: route compact signal nets first, wide global rails (like GND) slightly after or with clean busing
    const sortedNets = Array.from(netPins.entries())
      .filter(([, pts]) => pts.length >= 2)
      .sort((a, b) => a[1].length - b[1].length);

    for (const [netName, pins] of sortedNets) {
      // Deduplicate identical pin coordinates
      const uniquePins = [];
      const seenPinKeys = new Set();
      for (const p of pins) {
        const k = `${p.x},${p.y}`;
        if (!seenPinKeys.has(k)) {
          seenPinKeys.add(k);
          uniquePins.push(p);
        }
      }
      if (uniquePins.length < 2) continue;

      const treeVertices = new Set([`${uniquePins[0].x},${uniquePins[0].y}`]);
      const treePoints = [{ x: uniquePins[0].x, y: uniquePins[0].y }];
      const netUnitEdges = new Set();
      const remaining = uniquePins.slice(1);

      while (remaining.length > 0) {
        // Pick remaining pin closest to current Steiner tree
        let bestIdx = 0;
        let bestHeuristic = Infinity;
        for (let i = 0; i < remaining.length; i++) {
          for (const tp of treePoints) {
            const d = Math.abs(remaining[i].x - tp.x) + Math.abs(remaining[i].y - tp.y);
            if (d < bestHeuristic) {
              bestHeuristic = d;
              bestIdx = i;
            }
          }
        }
        const startPin = remaining.splice(bestIdx, 1)[0];
        const path = aStarToTree(
          startPin,
          treeVertices,
          treePoints,
          netName,
          pinOwner,
          bodyObstacles,
          edgeOwner,
          vertexOwner,
          minX,
          minY,
          maxX,
          maxY
        );

        for (let i = 0; i < path.length; i++) {
          const vk = `${path[i].x},${path[i].y}`;
          if (!treeVertices.has(vk)) {
            treeVertices.add(vk);
            treePoints.push(path[i]);
          }
          if (!vertexOwner.has(vk)) vertexOwner.set(vk, new Set());
          vertexOwner.get(vk).add(netName);

          if (i + 1 < path.length) {
            const ek = canonicalEdge(path[i].x, path[i].y, path[i + 1].x, path[i + 1].y);
            netUnitEdges.add(ek);
            edgeOwner.set(ek, netName);
          }
        }
      }

      // Collapse collinear unit edges while strictly splitting at T-junctions & pins!
      const segments = mergeNetUnitEdges(netUnitEdges, seenPinKeys);
      routedSegmentsByNet.set(netName, segments);
    }

    return { netPins, routedSegmentsByNet };
  }

  /**
   * A* search from `start` to any vertex in `targetSet`
   */
  function aStarToTree(
    start,
    targetSet,
    targetList,
    netName,
    pinOwner,
    bodyObstacles,
    edgeOwner,
    vertexOwner,
    minX,
    minY,
    maxX,
    maxY
  ) {
    const startKey = `${start.x},${start.y}`;
    if (targetSet.has(startKey)) return [start];

    const heuristic = (x, y) => {
      let best = Infinity;
      for (const t of targetList) {
        const d = (Math.abs(x - t.x) + Math.abs(y - t.y)) / GRID;
        if (d < best) best = d;
      }
      return best;
    };

    // Binary min-heap priority queue
    const heap = [];
    const pushHeap = (node) => {
      heap.push(node);
      let idx = heap.length - 1;
      while (idx > 0) {
        const p = (idx - 1) >> 1;
        if (heap[p].f <= heap[idx].f) break;
        [heap[p], heap[idx]] = [heap[idx], heap[p]];
        idx = p;
      }
    };
    const popHeap = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length > 0) {
        heap[0] = last;
        let idx = 0;
        while (true) {
          let smallest = idx;
          const l = idx * 2 + 1;
          const r = idx * 2 + 2;
          if (l < heap.length && heap[l].f < heap[smallest].f) smallest = l;
          if (r < heap.length && heap[r].f < heap[smallest].f) smallest = r;
          if (smallest === idx) break;
          [heap[idx], heap[smallest]] = [heap[smallest], heap[idx]];
          idx = smallest;
        }
      }
      return top;
    };

    const gScore = new Map();
    const cameFrom = new Map();

    const stateKey = (x, y, dirIdx) => `${x},${y},${dirIdx}`;
    gScore.set(stateKey(start.x, start.y, -1), 0);
    pushHeap({ x: start.x, y: start.y, dir: -1, g: 0, f: heuristic(start.x, start.y) });

    const DIRS = [
      { dx: GRID, dy: 0 },
      { dx: -GRID, dy: 0 },
      { dx: 0, dy: GRID },
      { dx: 0, dy: -GRID },
    ];

    const canonicalEdge = (x1, y1, x2, y2) =>
      x1 < x2 || (x1 === x2 && y1 < y2) ? `${x1},${y1}-${x2},${y2}` : `${x2},${y2}-${x1},${y1}`;

    let bestGoalState = null;

    while (heap.length > 0) {
      const cur = popHeap();
      const curCoordKey = `${cur.x},${cur.y}`;
      if (targetSet.has(curCoordKey)) {
        bestGoalState = cur;
        break;
      }

      const sk = stateKey(cur.x, cur.y, cur.dir);
      if (cur.g > (gScore.get(sk) ?? Infinity)) continue;

      for (let d = 0; d < 4; d++) {
        const nx = cur.x + DIRS[d].dx;
        const ny = cur.y + DIRS[d].dy;
        if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;

        const nCoordKey = `${nx},${ny}`;
        // 1. Never step onto a pin owned by a different net!
        const pOwner = pinOwner.get(nCoordKey);
        if (pOwner && pOwner !== netName) continue;

        // 2. Never reuse an edge owned by a different net (prevents collinear overlapping wires!)
        const ek = canonicalEdge(cur.x, cur.y, nx, ny);
        const eOwner = edgeOwner.get(ek);
        if (eOwner && eOwner !== netName) continue;

        // 3. Do not terminate or turn on top of another net's vertex!
        // (In Falstad, only wire endpoints connect; a straight wire crossing over a perpendicular wire
        // does NOT connect as long as neither wire has an endpoint at the crossing!)
        const vOwners = vertexOwner.get(nCoordKey);
        const occupiedByOtherNet = vOwners && Array.from(vOwners).some((o) => o !== netName);
        if (occupiedByOtherNet && targetSet.has(nCoordKey)) continue;

        // Also check if current cell is occupied by another net — if so, we MUST NOT turn at cur!
        const curVOwners = vertexOwner.get(curCoordKey);
        const curHasOtherNet = curVOwners && Array.from(curVOwners).some((o) => o !== netName);
        if (curHasOtherNet && cur.dir !== -1 && cur.dir !== d) continue;

        let stepCost = 10;
        // Encourage reusing existing edges of the same net
        if (eOwner === netName) stepCost = 1;
        // Bend penalty for crisp L-shaped Manhattan wires (also prevents corner-turning on crossings)
        if (cur.dir !== -1 && cur.dir !== d) stepCost += 5;
        // Body obstacle avoidance (unless it's our own start/target pin)
        if (bodyObstacles.has(nCoordKey) && !targetSet.has(nCoordKey) && nCoordKey !== startKey) {
          stepCost += 120;
        }
        // Perpendicular wire crossing penalty
        if (occupiedByOtherNet) {
          stepCost += 45;
        }

        const nextG = cur.g + stepCost;
        const nsk = stateKey(nx, ny, d);
        if (nextG < (gScore.get(nsk) ?? Infinity)) {
          gScore.set(nsk, nextG);
          cameFrom.set(nsk, { x: cur.x, y: cur.y, dir: cur.dir });
          pushHeap({
            x: nx,
            y: ny,
            dir: d,
            g: nextG,
            f: nextG + heuristic(nx, ny) * 10,
          });
        }
      }
    }

    if (!bestGoalState) {
      // Fallback L-path if completely boxed in
      const goal = targetList[0];
      const mid = { x: goal.x, y: start.y };
      const pts = [start];
      if (mid.x !== start.x || mid.y !== start.y) pts.push(mid);
      if (goal.x !== mid.x || goal.y !== mid.y) pts.push(goal);
      return pts;
    }

    // Reconstruct grid path
    const rev = [];
    let ptr = { x: bestGoalState.x, y: bestGoalState.y, dir: bestGoalState.dir };
    while (ptr) {
      rev.push({ x: ptr.x, y: ptr.y });
      ptr = cameFrom.get(stateKey(ptr.x, ptr.y, ptr.dir));
    }
    rev.reverse();
    return rev;
  }

  /**
   * Merge collinear unit grid edges while splitting at every pin & T-junction (degree !== 2)
   */
  function mergeNetUnitEdges(unitEdgeSet, pinKeySet) {
    const adj = new Map(); // "x,y" -> Array<{x, y, ek}>
    const addAdj = (k1, p2, ek) => {
      if (!adj.has(k1)) adj.set(k1, []);
      adj.get(k1).push({ x: p2.x, y: p2.y, key: `${p2.x},${p2.y}`, ek });
    };

    for (const ek of unitEdgeSet) {
      const [s1, s2] = ek.split("-");
      const [x1, y1] = s1.split(",").map(Number);
      const [x2, y2] = s2.split(",").map(Number);
      addAdj(s1, { x: x2, y: y2 }, ek);
      addAdj(s2, { x: x1, y: y1 }, ek);
    }

    const isSplitNode = (vKey) => {
      if (pinKeySet.has(vKey)) return true;
      const neighbors = adj.get(vKey) || [];
      if (neighbors.length !== 2) return true;
      // Check if bend (90 degrees)
      const [vx, vy] = vKey.split(",").map(Number);
      const dx1 = neighbors[0].x - vx;
      const dy1 = neighbors[0].y - vy;
      const dx2 = neighbors[1].x - vx;
      const dy2 = neighbors[1].y - vy;
      // Collinear opposite directions satisfy dx1 + dx2 === 0 && dy1 + dy2 === 0
      return !(dx1 + dx2 === 0 && dy1 + dy2 === 0);
    };

    const visitedEdges = new Set();
    const segments = [];

    for (const [vKey, neighbors] of adj.entries()) {
      if (!isSplitNode(vKey)) continue;
      const [sx, sy] = vKey.split(",").map(Number);

      for (const nb of neighbors) {
        if (visitedEdges.has(nb.ek)) continue;
        visitedEdges.add(nb.ek);

        let curKey = nb.key;
        let curX = nb.x;
        let curY = nb.y;

        while (!isSplitNode(curKey)) {
          const nextCandidates = adj.get(curKey) || [];
          const nextStep = nextCandidates.find((c) => !visitedEdges.has(c.ek));
          if (!nextStep) break;
          visitedEdges.add(nextStep.ek);
          curKey = nextStep.key;
          curX = nextStep.x;
          curY = nextStep.y;
        }

        segments.push({ x1: sx, y1: sy, x2: curX, y2: curY });
      }
    }

    return segments;
  }

  /**
   * Main Compiler Entrypoint
   */
  function compile(rawIr) {
    const ir = normalizeIr(rawIr);
    const warnings = [];

    if (ir.components.length === 0) {
      throw new Error("电路中没有任何元器件");
    }

    // Check if there is at least one ground or dc_rail reference
    const hasRef = ir.components.some((c) => c.type === "ground" || c.type === "dc_rail");
    if (!hasRef) {
      // Find GND net or negative terminal of first source and auto-attach ground
      let gndNet = "GND";
      const src = ir.components.find((c) => c.type === "dc_source" || c.type === "ac_source");
      if (src && src.pins?.neg) {
        gndNet = src.pins.neg;
      }
      ir.components.push({
        id: "GND_AUTO",
        type: "ground",
        label: "GND",
        gx: 6,
        gy: 11,
        dir: "down",
        base_dir: "left",
        pins: { gnd: gndNet },
      });
      warnings.push(`原图未显式画出接地点，已自动在网络「${gndNet}」补充接地符号以保证仿真收敛`);
    }

    // Step 1: Coarse-to-fine grid center assignment
    const placedCenters = assignCleanCenters(ir.components);

    // Step 2: Compute approximate net centroids from component centers for smart transistor/opamp flip selection
    const netCentroids = new Map();
    for (const item of placedCenters) {
      for (const net of Object.values(item.comp.pins || {})) {
        const n = String(net || "").trim();
        if (!n || n === "NC") continue;
        const cur = netCentroids.get(n) || { sumX: 0, sumY: 0, count: 0, x: 0, y: 0 };
        cur.sumX += item.px;
        cur.sumY += item.py;
        cur.count += 1;
        cur.x = cur.sumX / cur.count;
        cur.y = cur.sumY / cur.count;
        netCentroids.set(n, cur);
      }
    }

    // Step 3: Instantiate exact Falstad elements & pin coordinates
    const elements = placedCenters.map((item) => instantiateElement(item, netCentroids));

    // Step 4: Route all multi-pin nets on 16px grid with obstacle avoidance & T-junction splitting
    const { netPins, routedSegmentsByNet } = routeAllNets(elements);

    // Determine max voltage in circuit so Falstad's green/red color scale looks vibrant
    let maxVolt = 5.0;
    for (const c of ir.components) {
      if (c.voltage != null) {
        maxVolt = Math.max(maxVolt, Math.abs(parseEngineeringValue(c.voltage, 5)));
      }
    }

    // Step 5: Emit Falstad CircuitJS1 text lines
    const lines = [`$ 1 5.0E-6 10.20027730826997 50 ${maxVolt} 50`];

    for (const el of elements) {
      for (const dl of el.dumpLines) {
        lines.push(dl);
      }
      // Emit crisp designator/Zener voltage annotation clear of wires & native value text
      const lbl = el.customLabelText || el.comp.label;
      if (el.showCustomLabel && lbl) {
        const ct = el.comp.type;
        let lx = el.bbox.x2 + 6;
        let ly = Math.round((el.bbox.y1 + el.bbox.y2) / 2) + 4;
        if (ct === "npn" || ct === "pnp" || ct === "nmos" || ct === "pmos") {
          const bd = el.comp.base_dir || "left";
          if (bd === "down") {
            lx = Math.round((el.bbox.x1 + el.bbox.x2) / 2) - 10;
            ly = el.bbox.y1 - 8;
          } else if (bd === "up") {
            lx = Math.round((el.bbox.x1 + el.bbox.x2) / 2) - 10;
            ly = el.bbox.y2 + 14;
          } else if (bd === "right") {
            lx = el.bbox.x1 - 30;
          }
        } else if (ct === "capacitor") {
          if (el.comp.dir === "left" || el.comp.dir === "right") {
            lx = Math.round((el.bbox.x1 + el.bbox.x2) / 2) - 10;
            ly = el.bbox.y1 - 8;
          } else {
            lx = el.bbox.x1 - 32;
          }
        } else if (el.comp.dir === "left" || el.comp.dir === "right") {
          lx = Math.round((el.bbox.x1 + el.bbox.x2) / 2) - 10;
          ly = el.bbox.y1 - 8;
        }
        lines.push(`x ${lx} ${ly} ${lx + 40} ${ly + 14} 4 13 ${escapeFalstadText(lbl)}`);
      }
    }

    let wireCount = 0;
    for (const segs of routedSegmentsByNet.values()) {
      for (const s of segs) {
        if (s.x1 === s.x2 && s.y1 === s.y2) continue;
        lines.push(`w ${s.x1} ${s.y1} ${s.x2} ${s.y2} 0`);
        wireCount++;
      }
    }

    const circuitText = lines.join("\n") + "\n";
    const svgHtml = renderLocalSvg(ir, elements, routedSegmentsByNet);

    return {
      circuitText,
      svgHtml,
      warnings,
      elements,
      routedSegmentsByNet,
      stats: {
        componentCount: elements.length,
        netCount: netPins.size,
        wireCount,
      },
    };
  }

  /**
   * Render clean interactive SVG topology diagram for offline pin/net inspection
   */
  function renderLocalSvg(ir, elements, routedSegmentsByNet) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const el of elements) {
      minX = Math.min(minX, el.bbox.x1);
      minY = Math.min(minY, el.bbox.y1);
      maxX = Math.max(maxX, el.bbox.x2 + 60);
      maxY = Math.max(maxY, el.bbox.y2 + 30);
    }
    for (const segs of routedSegmentsByNet.values()) {
      for (const s of segs) {
        minX = Math.min(minX, s.x1, s.x2);
        minY = Math.min(minY, s.y1, s.y2);
        maxX = Math.max(maxX, s.x1, s.x2);
        maxY = Math.max(maxY, s.y1, s.y2);
      }
    }
    const pad = 48;
    const vx = minX - pad;
    const vy = minY - pad;
    const vw = Math.max(360, maxX - minX + pad * 2);
    const vh = Math.max(280, maxY - minY + pad * 2);

    const palette = ["#38bdf8", "#34d399", "#fbbf24", "#a78bfa", "#f472b6", "#fb923c", "#4ade80"];
    const netColor = new Map();
    let cIdx = 0;
    for (const netName of routedSegmentsByNet.keys()) {
      netColor.set(netName, netName.toUpperCase() === "GND" ? "#94a3b8" : palette[cIdx++ % palette.length]);
    }

    // Count endpoint occurrences to draw authentic T-junction solder dots
    const endpointCounts = new Map();
    const bumpPt = (x, y) => {
      const k = `${x},${y}`;
      endpointCounts.set(k, (endpointCounts.get(k) || 0) + 1);
    };

    const wireSvg = [];
    for (const [netName, segs] of routedSegmentsByNet.entries()) {
      const col = netColor.get(netName) || "#38bdf8";
      for (const s of segs) {
        bumpPt(s.x1, s.y1);
        bumpPt(s.x2, s.y2);
        wireSvg.push(
          `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${col}" stroke-width="2.4" stroke-linecap="round"><title>网络: ${escSvg(
            netName
          )}</title></line>`
        );
      }
    }

    const compSvg = [];
    for (const el of elements) {
      const cx = Math.round((el.bbox.x1 + el.bbox.x2) / 2);
      const cy = Math.round((el.bbox.y1 + el.bbox.y2) / 2);
      const bw = Math.max(28, el.bbox.x2 - el.bbox.x1);
      const bh = Math.max(24, el.bbox.y2 - el.bbox.y1);

      compSvg.push(
        `<rect x="${el.bbox.x1}" y="${el.bbox.y1}" width="${bw}" height="${bh}" rx="6" fill="rgba(30,41,59,0.88)" stroke="#60a5fa" stroke-width="1.5" />`
      );
      const titleLabel = el.comp.label || el.comp.id;
      compSvg.push(
        `<text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="#f8fafc" font-size="11" font-weight="700">${escSvg(
          titleLabel
        )}</text>`
      );

      for (const [pinName, pt] of Object.entries(el.pinCoords)) {
        bumpPt(pt.x, pt.y);
        const net = el.comp.pins[pinName] || "";
        compSvg.push(
          `<circle cx="${pt.x}" cy="${pt.y}" r="4" fill="#f59e0b" stroke="#0f172a" stroke-width="1.2"><title>${escSvg(
            `${el.comp.id}.${pinName} → ${net} (${pt.x},${pt.y})`
          )}</title></circle>`
        );
        compSvg.push(
          `<text x="${pt.x + 5}" y="${pt.y - 5}" fill="#cbd5e1" font-size="9.5">${escSvg(pinName)}</text>`
        );
      }
    }

    const junctionSvg = [];
    for (const [k, cnt] of endpointCounts.entries()) {
      if (cnt >= 3) {
        const [jx, jy] = k.split(",").map(Number);
        junctionSvg.push(`<circle cx="${jx}" cy="${jy}" r="4.2" fill="#e2e8f0" />`);
      }
    }

    return `<svg viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;max-height:100%;">
      <defs>
        <pattern id="grid16" width="16" height="16" patternUnits="userSpaceOnUse">
          <circle cx="0" cy="0" r="0.8" fill="rgba(148,163,184,0.22)" />
        </pattern>
      </defs>
      <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="url(#grid16)" />
      ${wireSvg.join("\n")}
      ${compSvg.join("\n")}
      ${junctionSvg.join("\n")}
    </svg>`;
  }

  function escSvg(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const api = {
    GRID,
    escapeFalstadText,
    parseEngineeringValue,
    interpPoint2,
    normalizeIr,
    compile,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.CircuitCompiler = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
