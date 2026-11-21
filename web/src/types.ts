/** Shapes of what the Python side exports. Mirrors cardiovis/frames.py. */

export type TierNumber = 1 | 2 | 3;

export interface BinaryDescriptor {
  file: string;
  shape: number[];
  dtype: "float32";
  order: string;
  leads?: string[];
  axes?: string[];
  regions?: string[];
  units?: string;
  sampleRateHz?: number;
  tier?: TierNumber;
  method?: string;
  citation?: string;
  layout?: string;
  note?: string;
}

export interface BeatJson {
  index: number;
  rSample: number;
  samples: {
    pOn: number | null; pPeak: number | null; pOff: number | null;
    qrsOn: number | null; qrsOff: number | null;
    tPeak: number | null; tOff: number | null;
  };
  ms: Record<string, number | null>;
  rrMs: number | null;
  confidence: number;
  flags: string[];
}

export interface WarningJson {
  code: string;
  severity: "info" | "warning" | "critical";
  message: string;
  detail: Record<string, unknown>;
}

export interface LeadVectorJson {
  unitVector: [number, number, number];
  plane: "frontal" | "transverse";
  angleDeg: number | null;
  tier: TierNumber;
}

export interface RegionJson {
  key: string;
  label: string;
  chamber: "atria" | "ventricles" | "conduction";
  direction: [number, number, number];
  weight: number;
  silent: boolean;
  note: string;
}

export interface Manifest {
  cardiovisVersion: string;
  disclaimer: string;
  recordId: string;
  title: string;
  description: string | null;
  teaching: { synthetic?: boolean; point?: string; warning?: string } | null;
  sourceFormat: string;
  subject: { ageBand: string | null; sex: string | null; acquisitionYear: number | null };
  device: Record<string, unknown>;
  signal: {
    sampleRateHz: number;
    nSamples: number;
    durationS: number;
    leads: string[];
    independentLeads: string[];
    filter: { description: string; notchHz: number | null; enabled: boolean };
    deviceFilters: Record<string, unknown>;
    invalidSampleFraction: Record<string, number>;
    leadConsistency: {
      maxAbsErrorMv: Record<string, number>;
      recomputed: string[];
      flatLeads: string[];
      toleranceMv: number;
    };
  };
  leadVectors: Record<string, LeadVectorJson>;
  delineation: {
    detector: string;
    beats: BeatJson[];
    summary: Record<string, number | null>;
    warnings: WarningJson[];
    usable: boolean;
    modelApplicable: boolean;
  };
  metrics: {
    intervals: Record<string, any>;
    axes: Record<string, any>;
    loops: Record<string, any>;
    vectors: Record<string, any>;
    provenance: Record<string, any>;
  };
  vcg: {
    primary: { method: string; citation: string; units: string; frame: string };
    alternate: { method: string; citation: string } | null;
    comparison: Record<string, number | string> | null;
    methodNotes: Record<string, string>;
    citations: Record<string, string>;
  };
  conduction: {
    tier: 3;
    regions: RegionJson[];
    referenceQrsMs: number;
    agreement: {
      qrs: Record<string, number | null>;
      wholeBeat: Record<string, number | null>;
      verdict: string;
      note: string;
    };
    applicable: boolean;
    caveats: string[];
    badge: string;
  } | null;
  conductionSchedule: Array<{ beatIndex: number; regions: Record<string, any> }> | null;
  tiers: Record<string, { name: string; label: string; dismissible: boolean }>;
  binaries: Record<string, BinaryDescriptor>;
  notes: string[];
}

export interface CaseIndexEntry {
  recordId: string;
  path: string;
  title: string;
  description: string | null;
  ageBand: string | null;
  sex: string | null;
  heartRateBpm: number | null;
  qrsMs: number | null;
  durationS: number;
  warnings: string[];
}

export interface CaseData {
  manifest: Manifest;
  fs: number;
  n: number;
  leadNames: string[];
  leads: Float32Array;        // 12 x n, lead-major
  leadsRaw: Float32Array;     // 12 x n
  vcg: Float32Array;          // 3 x n
  vcgAlt: Float32Array | null;
  modelVcg: Float32Array | null;
  conduction: Float32Array | null;   // 2R x n
  regionKeys: string[];
}
