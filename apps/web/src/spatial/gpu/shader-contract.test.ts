/**
 * The WGSL and the TypeScript describe the same GPU memory in two languages,
 * and nothing between them checks that they agree. This file is that check.
 *
 * It is deliberately the largest test in `spatial/` because it is the only one
 * that can catch the failure mode this design is most exposed to: a struct field
 * reordered in `common.wgsl` and not in `bindings.ts` does not fail to compile,
 * does not throw at pipeline creation, and does not error at draw time. It
 * renders velocity where it meant to render position — at full frame rate, with
 * no message anywhere — and the only symptom is a fluid that looks wrong.
 *
 * ## What this does not test
 *
 * It does not run the shaders. There is no WebGPU in the vitest environment and
 * no software adapter available here, so nothing below establishes that the SPH
 * kernel is correct, that the prefix sum sums, or that the MLS-MPM transfer
 * conserves anything. Those remain **unverified** rather than passing. What is
 * verified is structural: bindings, entry points, workgroup sizes, and byte
 * offsets computed from the WGSL source under the spec's own layout rules.
 *
 * The offsets are recomputed here rather than compared to a second hard-coded
 * list. A test that restates the constants it is checking passes when both are
 * wrong in the same way, which is exactly how a layout constant drifts.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MPM_BINDINGS,
  PARTICLE_FIELD_OFFSETS,
  PARTICLE_STRIDE_BYTES,
  CAMERA_UNIFORM_SIZE_BYTES,
  SCAN_BINDINGS,
  SCAN_BLOCK_SIZE,
  SIMULATION_BINDINGS,
  SIM_PARAMS_FIELD_OFFSETS,
  SIM_PARAMS_SIZE_BYTES,
  WORKGROUP_SIZE,
} from './bindings.js';
import {
  SHADER_ENTRY_POINTS,
  SHADER_SOURCES,
  type ShaderName,
} from './shaders.js';

const wgslDir = fileURLToPath(new URL('../wgsl/', import.meta.url));
const readWgsl = (name: string) => readFileSync(`${wgslDir}${name}`, 'utf8');

// ---------------------------------------------------------------------------
// A WGSL layout calculator, per the spec's alignment and size rules
// ---------------------------------------------------------------------------

interface TypeLayout {
  align: number;
  size: number;
}

/**
 * The rules that matter for the types this engine uses. `vec3` is the one that
 * catches people out and the one every struct here depends on: it is 12 bytes
 * of data with a 16-byte alignment, so a scalar declared immediately after a
 * `vec3` occupies padding that would otherwise be dead, and the same scalar
 * declared before it wastes twelve bytes.
 */
const TYPE_LAYOUTS: Record<string, TypeLayout> = {
  f32: { align: 4, size: 4 },
  u32: { align: 4, size: 4 },
  i32: { align: 4, size: 4 },
  'vec2<f32>': { align: 8, size: 8 },
  'vec3<f32>': { align: 16, size: 12 },
  'vec3<u32>': { align: 16, size: 12 },
  'vec3<i32>': { align: 16, size: 12 },
  'vec4<f32>': { align: 16, size: 16 },
  'mat3x3<f32>': { align: 16, size: 48 },
  'mat4x4<f32>': { align: 16, size: 64 },
};

const roundUp = (value: number, multiple: number) =>
  Math.ceil(value / multiple) * multiple;

interface StructLayout {
  offsets: Record<string, number>;
  size: number;
  align: number;
}

function parseStructFields(
  source: string,
  name: string
): Array<{ field: string; type: string }> {
  const match = source.match(
    new RegExp(`struct\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm')
  );
  if (!match) throw new Error(`struct ${name} not found in the source`);

  return match[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const field = line.match(/^(?:@[\w()\s]+\s+)?(\w+)\s*:\s*([^,]+),?$/);
      if (!field) throw new Error(`unparsed field in ${name}: ${line}`);
      return { field: field[1], type: field[2].trim() };
    });
}

function layoutOf(source: string, name: string): StructLayout {
  const fields = parseStructFields(source, name);
  const offsets: Record<string, number> = {};
  let cursor = 0;
  let structAlign = 1;

  for (const { field, type } of fields) {
    const layout = TYPE_LAYOUTS[type];
    if (!layout) throw new Error(`no layout rule for WGSL type '${type}'`);
    cursor = roundUp(cursor, layout.align);
    offsets[field] = cursor;
    cursor += layout.size;
    structAlign = Math.max(structAlign, layout.align);
  }

  return { offsets, size: roundUp(cursor, structAlign), align: structAlign };
}

// The calculator is checked against a case whose answer is known independently,
// so a bug in the calculator cannot quietly agree with a bug in the shaders.
describe('the layout calculator itself', () => {
  it('places a scalar in the padding after a vec3', () => {
    const layout = layoutOf(
      'struct T {\n  a: vec3<f32>,\n  b: f32,\n  c: vec3<f32>,\n}',
      'T'
    );
    expect(layout.offsets).toEqual({ a: 0, b: 12, c: 16 });
    expect(layout.size).toBe(32);
  });

  it('rounds a struct up to its own alignment', () => {
    const layout = layoutOf('struct T {\n  a: vec3<f32>,\n}', 'T');
    expect(layout.size).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// Struct layouts
// ---------------------------------------------------------------------------

describe('Particle', () => {
  const layout = layoutOf(readWgsl('common.wgsl'), 'Particle');

  it('matches PARTICLE_FIELD_OFFSETS computed from the WGSL', () => {
    expect(layout.offsets).toEqual(PARTICLE_FIELD_OFFSETS);
  });

  it('matches PARTICLE_STRIDE_BYTES', () => {
    expect(layout.size).toBe(PARTICLE_STRIDE_BYTES);
  });

  it('is also the vertex layout the billboard shader declares', () => {
    // Same 32 bytes, described a third time in `render-billboard.wgsl` as
    // per-instance vertex attributes. The buffer is STORAGE | VERTEX and is
    // never read back, so this is the only place the two descriptions meet.
    const source = readWgsl('render-billboard.wgsl');
    const locationNames = new Set(
      [...source.matchAll(/@location\((\d+)\)\s+(\w+)\s*:/g)].map(
        ([, , f]) => f
      )
    );
    const attributes = parseStructFields(source, 'VertexIn').filter((f) =>
      locationNames.has(f.field)
    );

    const particleFields = parseStructFields(
      readWgsl('common.wgsl'),
      'Particle'
    );
    expect(attributes).toEqual(particleFields);
  });

  it('declares the locations in field order, starting at 0', () => {
    const locations = [
      ...readWgsl('render-billboard.wgsl').matchAll(
        /@location\((\d+)\)\s+(\w+)\s*:/g
      ),
    ]
      .filter(([, , field]) => field in PARTICLE_FIELD_OFFSETS)
      .map(([, index, field]) => ({ index: Number(index), field }));

    const byOffset = Object.entries(PARTICLE_FIELD_OFFSETS)
      .sort(([, a], [, b]) => a - b)
      .map(([field], index) => ({ index, field }));

    expect(locations).toEqual(byOffset);
  });
});

describe('SimParams', () => {
  const layout = layoutOf(readWgsl('common.wgsl'), 'SimParams');

  it('matches SIM_PARAMS_FIELD_OFFSETS for every non-padding field', () => {
    const withoutPadding = Object.fromEntries(
      Object.entries(layout.offsets).filter(([field]) => !field.startsWith('_'))
    );
    expect(withoutPadding).toEqual(SIM_PARAMS_FIELD_OFFSETS);
  });

  it('matches SIM_PARAMS_SIZE_BYTES', () => {
    expect(layout.size).toBe(SIM_PARAMS_SIZE_BYTES);
  });

  it('is a whole number of 16-byte rows, as a uniform buffer must be', () => {
    expect(layout.size % 16).toBe(0);
  });
});

describe('Camera', () => {
  const layout = layoutOf(readWgsl('render-billboard.wgsl'), 'Camera');

  it('matches CAMERA_UNIFORM_SIZE_BYTES', () => {
    expect(layout.size).toBe(CAMERA_UNIFORM_SIZE_BYTES);
  });

  it('is a whole number of 16-byte rows', () => {
    expect(layout.size % 16).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

function parseBindings(source: string, group: number): Record<string, number> {
  const found: Record<string, number> = {};
  for (const [, g, binding, name] of source.matchAll(
    /@group\((\d+)\)\s*@binding\((\d+)\)\s*var<[^>]*>\s*(\w+)\s*:/g
  )) {
    if (Number(g) !== group) continue;
    found[name] = Number(binding);
  }
  return found;
}

describe('bind group layouts', () => {
  it('group 0 in common.wgsl matches SIMULATION_BINDINGS', () => {
    expect(parseBindings(readWgsl('common.wgsl'), 0)).toEqual(
      SIMULATION_BINDINGS
    );
  });

  it('group 1 in prefix-sum.wgsl matches SCAN_BINDINGS', () => {
    expect(parseBindings(readWgsl('prefix-sum.wgsl'), 1)).toEqual(
      SCAN_BINDINGS
    );
  });

  it('group 1 in mlsmpm-common.wgsl matches MPM_BINDINGS', () => {
    expect(parseBindings(readWgsl('mlsmpm-common.wgsl'), 1)).toEqual(
      MPM_BINDINGS
    );
  });

  it('no pass declares a binding outside its own prelude', () => {
    // A pass that declares its own binding gets a layout the shared explicit
    // GPUBindGroupLayout does not describe, and the bind group is rejected at
    // `setBindGroup` — a runtime failure that only reaches the founder whose
    // hardware happens to take that path.
    const preludes = new Set([
      'common.wgsl',
      'mlsmpm-common.wgsl',
      'prefix-sum.wgsl',
      'render-billboard.wgsl',
    ]);
    const passes = [
      'spatial-hash.wgsl',
      'sph-density.wgsl',
      'sph-force.wgsl',
      'integrate.wgsl',
      'mlsmpm-p2g.wgsl',
      'mlsmpm-grid.wgsl',
      'mlsmpm-g2p.wgsl',
    ];
    for (const file of passes) {
      expect(preludes.has(file)).toBe(false);
      expect(readWgsl(file)).not.toMatch(/@group\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// Entry points and dispatch geometry
// ---------------------------------------------------------------------------

const shaderNames = Object.keys(SHADER_SOURCES) as ShaderName[];

describe('entry points', () => {
  it.each(shaderNames)(
    '%s declares exactly the entry points the pipelines request',
    (name) => {
      const source = SHADER_SOURCES[name];
      const declared = [
        ...source.matchAll(
          /@(?:compute|vertex|fragment)[\s\S]{0,80}?\bfn\s+(\w+)\s*\(/g
        ),
      ].map(([, fn]) => fn);

      expect([...declared].sort()).toEqual(
        [...SHADER_ENTRY_POINTS[name]].sort()
      );
    }
  );

  it('gives every shader at least one entry point', () => {
    for (const name of shaderNames) {
      expect(SHADER_ENTRY_POINTS[name].length).toBeGreaterThan(0);
    }
  });
});

describe('workgroup sizes', () => {
  it('every compute pass dispatches at WORKGROUP_SIZE', () => {
    for (const name of shaderNames) {
      for (const [, size] of SHADER_SOURCES[name].matchAll(
        /@workgroup_size\((\d+)\)/g
      )) {
        expect(Number(size)).toBe(WORKGROUP_SIZE);
      }
    }
  });

  it('the scan block constant matches SCAN_BLOCK_SIZE', () => {
    // `prefix-sum.wgsl` sizes its workgroup scratch array from SCAN_BLOCK. If
    // that diverges from the TypeScript, the CPU dispatches the wrong number of
    // blocks and the scan silently drops the tail of the grid.
    const source = readWgsl('prefix-sum.wgsl');
    const declared = source.match(/const\s+SCAN_BLOCK\s*:\s*u32\s*=\s*(\d+)u/);
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(SCAN_BLOCK_SIZE);
  });
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe('shader composition', () => {
  it('gives every simulation shader the common prelude exactly once', () => {
    for (const name of shaderNames) {
      if (name === 'renderBillboard') continue;
      const declarations = [
        ...SHADER_SOURCES[name].matchAll(/struct\s+SimParams\s*\{/g),
      ];
      expect(declarations).toHaveLength(1);
    }
  });

  it('gives the MPM passes the fixed-point prelude exactly once', () => {
    for (const name of ['mpmP2g', 'mpmGrid', 'mpmG2p'] as const) {
      const declarations = [
        ...SHADER_SOURCES[name].matchAll(/const\s+MPM_FIXED_SCALE/g),
      ];
      expect(declarations).toHaveLength(1);
    }
  });

  it('keeps the compute prelude out of the render shader', () => {
    // Both declare a uniform at group 0 binding 0 — `SimParams` and `Camera`.
    // A render and a compute pipeline have separate layouts, so that is legal,
    // but composing them into one module is a duplicate binding, not a shared
    // one.
    expect(SHADER_SOURCES.renderBillboard).not.toMatch(/struct\s+SimParams/);
  });

  it('leaves no shader empty', () => {
    for (const name of shaderNames) {
      expect(SHADER_SOURCES[name].trim().length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// G5: the clamps that replace the readback
// ---------------------------------------------------------------------------

describe('GPU-side sanitisation (G5)', () => {
  it('routes every particle velocity write through sanitizeVec3', () => {
    // The CPU never reads this buffer back, so a NaN written here is a NaN that
    // spreads through the neighbour search with nothing in the loop able to
    // notice. These are the only writes to `.velocity` in the engine.
    const writers = ['integrate.wgsl', 'sph-force.wgsl', 'mlsmpm-g2p.wgsl'];
    for (const file of writers) {
      const source = readWgsl(file);
      for (const line of source.split('\n')) {
        if (!/particles\[\w+\]\.velocity\s*=/.test(line)) continue;
        expect(line).toMatch(/sanitizeVec3\(/);
      }
    }
  });

  it('routes every particle position write through sanitizeVec3', () => {
    const source = readWgsl('integrate.wgsl');
    for (const line of source.split('\n')) {
      if (!/particles\[\w+\]\.position\s*=/.test(line)) continue;
      expect(line).toMatch(/sanitizeVec3\(/);
    }
  });

  it('tests NaN by inequality, the only comparison that catches it', () => {
    // `value == value` inverted, or a `clamp` without the NaN branch, both
    // compile and both let NaN through. Pinned as source text because there is
    // no runtime here that can execute the function.
    expect(readWgsl('common.wgsl')).toMatch(
      /if \(value != value\) \{ return fallback; \}/
    );
  });
});

// ---------------------------------------------------------------------------
// Palette (Appendix B.2)
// ---------------------------------------------------------------------------

describe('render palette', () => {
  it('spends no magenta on the simulation surface', () => {
    // Magenta belongs to the human review gate and the highlighted pricing
    // tier, and nowhere else. A simulation readout borrowing it would mean "a
    // person is being asked to decide" in a place where nobody is.
    const source = readWgsl('render-billboard.wgsl');
    for (const [, r, g, b] of source.matchAll(
      /vec3<f32>\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/g
    )) {
      const [red, green, blue] = [r, g, b].map(Number);
      const magentaish = red > 0.4 && blue > 0.4 && green < red * 0.6;
      expect(magentaish).toBe(false);
    }
  });
});
