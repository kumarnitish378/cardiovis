import type { CaseData, CaseIndexEntry, Manifest } from "../types";

const DATA_ROOT = `${import.meta.env.BASE_URL}data`;

async function fetchF32(dir: string, file: string): Promise<Float32Array> {
  const res = await fetch(`${dir}/${file}`);
  if (!res.ok) throw new Error(`${file}: ${res.status} ${res.statusText}`);
  return new Float32Array(await res.arrayBuffer());
}

export async function loadIndex(): Promise<CaseIndexEntry[]> {
  const res = await fetch(`${DATA_ROOT}/index.json`);
  if (!res.ok) throw new Error(`case index: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { cases: CaseIndexEntry[] };
  return data.cases;
}

/**
 * One case: the JSON manifest plus its binary side-cars, straight into typed
 * arrays. The binaries are fetched in parallel - they are independent, and the
 * largest is a few hundred kB.
 */
export async function loadCase(path: string): Promise<CaseData> {
  const dir = `${DATA_ROOT}/${path}`;
  const res = await fetch(`${dir}/frames.json`);
  if (!res.ok) throw new Error(`frames.json: ${res.status} ${res.statusText}`);
  const manifest = (await res.json()) as Manifest;
  const b = manifest.binaries;

  const [leads, leadsRaw, vcg, vcgAlt, modelVcg, conduction] = await Promise.all([
    fetchF32(dir, b.leads.file),
    fetchF32(dir, b.leadsRaw.file),
    fetchF32(dir, b.vcg.file),
    b.vcgAlt ? fetchF32(dir, b.vcgAlt.file) : Promise.resolve(null),
    b.modelVcg ? fetchF32(dir, b.modelVcg.file) : Promise.resolve(null),
    b.conduction ? fetchF32(dir, b.conduction.file) : Promise.resolve(null),
  ]);

  const n = manifest.signal.nSamples;
  const expected = manifest.signal.leads.length * n;
  if (leads.length !== expected) {
    throw new Error(
      `leads.f32 has ${leads.length} floats, manifest implies ${expected}. ` +
        `Refusing to render a mislabelled signal.`,
    );
  }

  return {
    manifest,
    fs: manifest.signal.sampleRateHz,
    n,
    leadNames: manifest.signal.leads,
    leads,
    leadsRaw,
    vcg,
    vcgAlt,
    modelVcg,
    conduction,
    regionKeys: b.conduction?.regions ?? [],
  };
}

/** Sample i of one lead. Arrays are lead-major: [lead0 samples..., lead1 ...]. */
export function leadSample(data: CaseData, leadIndex: number, i: number, raw = false): number {
  const src = raw ? data.leadsRaw : data.leads;
  return src[leadIndex * data.n + i] ?? 0;
}

export function vcgSample(src: Float32Array, n: number, i: number): [number, number, number] {
  return [src[i] ?? 0, src[n + i] ?? 0, src[2 * n + i] ?? 0];
}

/** Depolarised and repolarised fraction of one region at sample i. */
export function conductionSample(
  data: CaseData,
  regionIndex: number,
  i: number,
): { depolarised: number; repolarised: number } {
  if (!data.conduction) return { depolarised: 0, repolarised: 0 };
  const r = data.regionKeys.length;
  const n = data.n;
  return {
    depolarised: data.conduction[regionIndex * n + i] ?? 0,
    repolarised: data.conduction[(r + regionIndex) * n + i] ?? 0,
  };
}
