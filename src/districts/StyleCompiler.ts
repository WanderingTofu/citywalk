import type { StyleConfig, WallMaterial } from './StyleConfig';
import { SHIBUYA } from './presets';

/**
 * Prompt -> StyleConfig.
 *
 * Version 1 is a deterministic keyword compiler: it starts from a neutral
 * base and nudges fields according to words found in the prompt. It exists so
 * that (a) every district can be described in plain language today and (b) the
 * seam where an AI compiler plugs in later is already in place: anything that
 * returns a StyleConfig can replace `compileStyle`.
 *
 * The shipped districts use hand-tuned presets (see presets.ts); this compiler
 * is the fallback for prompts without a preset.
 */

interface Rule {
  match: RegExp;
  apply: (s: StyleConfig) => void;
}

const addMaterial = (s: StyleConfig, m: WallMaterial, w: number) => {
  s.materials[m] = (s.materials[m] ?? 0) + w;
};

const RULES: Rule[] = [
  { match: /\bglass\b|curtain[- ]wall|mirrored/, apply: (s) => addMaterial(s, 'glass', 0.35) },
  { match: /\bconcrete\b/, apply: (s) => addMaterial(s, 'concrete', 0.4) },
  { match: /\bbrick\b|terracotta/, apply: (s) => addMaterial(s, 'brick', 0.4) },
  { match: /limestone|\bstone\b|sandstone/, apply: (s) => addMaterial(s, 'stone', 0.5) },
  { match: /wood|timber|machiya/, apply: (s) => addMaterial(s, 'wood', 0.6) },
  { match: /plaster|stucco|whitewash/, apply: (s) => addMaterial(s, 'plaster', 0.4) },
  { match: /\bmetal\b|steel|aluminium|aluminum/, apply: (s) => addMaterial(s, 'metal', 0.25) },
  {
    match: /mansard/,
    apply: (s) => {
      s.architecture.roofStyle = 'mansard';
      s.architecture.roofMaterial = 'metal';
      s.architecture.pitchedMaxArea = 2600;
      s.architecture.pitchedMaxHeight = 34;
      s.architecture.roofPitch = 3.4;
    },
  },
  {
    match: /tiled roof|roof tile|pitched|gabled?/,
    apply: (s) => {
      s.architecture.roofStyle = 'gable';
      s.architecture.roofMaterial = 'rooftile';
      s.architecture.pitchedMaxArea = 900;
      s.architecture.pitchedMaxHeight = 14;
      s.architecture.roofPitch = 0.45;
    },
  },
  {
    match: /lattice|machiya/,
    apply: (s) => {
      s.architecture.windowPattern = 'lattice';
      s.architecture.groundFloorHeight = 0;
    },
  },
  { match: /balcon|wrought[- ]iron|french window/, apply: (s) => (s.architecture.windowPattern = 'french') },
  { match: /ribbon window|office/, apply: (s) => (s.architecture.towerPattern = 'ribbon') },
  {
    match: /high[- ]rise|tower|skyscraper/,
    apply: (s) => {
      s.heights.maxLevels = Math.max(s.heights.maxLevels, 30);
      s.heights.bias = 2.2;
      s.architecture.setbacks = Math.max(s.architecture.setbacks, 0.4);
    },
  },
  {
    match: /traditional|historic|low[- ]rise|village/,
    apply: (s) => {
      s.heights.maxLevels = Math.min(s.heights.maxLevels, 6);
      s.atmosphere.signageDensity = Math.min(s.atmosphere.signageDensity, 0.3);
      s.atmosphere.skyGlow = Math.min(s.atmosphere.skyGlow, 0.45);
    },
  },
  { match: /storefront|retail|shop|caf[eé]/, apply: (s) => (s.architecture.storefronts = Math.max(s.architecture.storefronts, 0.7)) },
  { match: /signage|neon|billboard|illuminated/, apply: (s) => (s.atmosphere.signageDensity = Math.max(s.atmosphere.signageDensity, 0.8)) },
  { match: /understated|quiet|subtle/, apply: (s) => (s.atmosphere.signageDensity = Math.min(s.atmosphere.signageDensity, 0.15)) },
  { match: /lantern|warm/, apply: (s) => (s.atmosphere.lightWarmth = 0.9) },
  { match: /night/, apply: (s) => (s.atmosphere.time = 'night') },
  { match: /sunlight|sunny|daytime/, apply: (s) => (s.atmosphere.time = 'day') },
  { match: /golden|sunset|dusk/, apply: (s) => (s.atmosphere.time = 'golden') },
  { match: /haz[ey]|humid|fog|mist/, apply: (s) => (s.atmosphere.fog = 0.8) },
  { match: /humid|tropical|rain|wet/, apply: (s) => (s.ground.wetness = 0.6) },
  { match: /stone sidewalk|cobble|setts|historic|traditional/, apply: (s) => (s.ground.paving = 'setts') },
  { match: /pedestrian lane|narrow pedestrian|car-free/, apply: (s) => (s.atmosphere.parking = 0.05) },
  { match: /overcast|cloudy|grey sk|gray sk/, apply: (s) => (s.atmosphere.clouds = 0.75) },
  { match: /clear sk|cloudless|strong clear/, apply: (s) => (s.atmosphere.clouds = 0.15) },
  { match: /dense|canyon|narrow/, apply: (s) => (s.atmosphere.enclosure = Math.max(s.atmosphere.enclosure, 0.75)) },
  { match: /weathered|worn|aged|gritty/, apply: (s) => (s.atmosphere.weathering = 0.85) },
  { match: /tree|leafy|palm|garden/, apply: (s) => (s.atmosphere.streetTrees = 0.5) },
  { match: /palm|tropical/, apply: (s) => (s.atmosphere.vegetation = [3, 1, 0, 6]) },
  { match: /pine|cedar|cypress|conifer/, apply: (s) => (s.atmosphere.vegetation = [3, 1, 5, 0]) },
];

/** Compile a free-text district description into a structured style. Pure and deterministic. */
export function compileStyle(district: string, prompt: string): StyleConfig {
  const s: StyleConfig = structuredClone(SHIBUYA);
  s.district = district;
  s.prompt = prompt;
  s.materials = {};
  s.atmosphere.time = 'day';
  s.atmosphere.signageDensity = 0.4;
  s.atmosphere.clouds = 0.35;
  s.atmosphere.parking = 0.35;
  s.atmosphere.vegetation = [4, 4, 1, 0];
  s.ground.paving = 'slabs';
  s.ground.wetness = 0.25;
  s.atmosphere.enclosure = 0.5;
  s.atmosphere.skyGlow = 0.6;
  s.architecture.setbacks = 0.1;
  s.heights = { minLevels: 2, maxLevels: 8, bias: 1.6, areaRef: 300 };

  const text = prompt.toLowerCase();
  for (const rule of RULES) if (rule.match.test(text)) rule.apply(s);

  if (Object.keys(s.materials).length === 0) s.materials = { concrete: 0.6, plaster: 0.4 };
  // Every material in the mix needs tint choices; borrow neutral ones where the base has none.
  for (const m of Object.keys(s.materials) as WallMaterial[]) {
    if (!s.palette[m]) s.palette[m] = FALLBACK_PALETTE[m];
  }
  return s;
}

const FALLBACK_PALETTE: Record<WallMaterial, number[]> = {
  concrete: [0xb9b7b2, 0xa3a29e],
  brick: [0x8d5a47, 0x9b6a55],
  plaster: [0xe3ddd0, 0xd6d0c8],
  wood: [0x4a3528, 0x5a4030],
  stone: [0xd9cfb8, 0xcfc4ab],
  metal: [0xa9adb1, 0x7d8388],
  glass: [0x6f8796, 0x58707e],
};
