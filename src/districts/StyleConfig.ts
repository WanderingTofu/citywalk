/**
 * Structured district style. This is what the generators and shaders consume;
 * the human-readable prompt is kept alongside it as the source description.
 * No LLM runs at play time: prompts are compiled ahead of time (see
 * StyleCompiler) into this plain data.
 */

/** Shared material library ids. The numeric values are used directly by the shaders. */
export const Mat = {
  concrete: 0,
  brick: 1,
  plaster: 2,
  wood: 3,
  stone: 4,
  asphalt: 5,
  metal: 6,
  glass: 7,
  rooftile: 8,
  pavement: 9,
  grass: 10,
  water: 11,
  gravel: 12,
} as const;

export type MaterialName = keyof typeof Mat;
export type WallMaterial = 'concrete' | 'brick' | 'plaster' | 'wood' | 'stone' | 'metal' | 'glass';

/** Window layouts. Numeric values are used by the facade shader. */
export const WindowPattern = {
  grid: 0,
  ribbon: 1,
  curtain: 2,
  french: 3,
  lattice: 4,
  none: 5,
} as const;
export type WindowPatternName = keyof typeof WindowPattern;

export type RoofStyle = 'flat' | 'gable' | 'mansard';
export type TimeOfDay = 'day' | 'golden' | 'night';

export interface StyleConfig {
  district: string;
  /** Human-readable description this configuration was derived from. */
  prompt: string;
  architecture: {
    primary: string;
    windowPattern: WindowPatternName;
    /** Pattern used for towers (taller than towerHeight). */
    towerPattern: WindowPatternName;
    towerHeight: number;
    roofStyle: RoofStyle;
    roofMaterial: MaterialName;
    /** Pitched roofs are only generated for footprints up to this area (m^2) and height (m). */
    pitchedMaxArea: number;
    pitchedMaxHeight: number;
    /** Roof rise as a fraction of the half-span (gable) or absolute meters cap (mansard). */
    roofPitch: number;
    floorHeight: number;
    groundFloorHeight: number;
    /** Probability that a building gets a ground-floor storefront. */
    storefronts: number;
    /** Target facade bay width in meters. */
    bayWidth: number;
    /** Window size as a fraction of a bay [width, height]. */
    windowFill: [number, number];
    /** Probability that a tower gets an upper setback tier. */
    setbacks: number;
  };
  /** Rules used only when OSM has no height / level tags. */
  heights: {
    minLevels: number;
    maxLevels: number;
    /** > 1 skews toward low buildings, < 1 toward tall ones. */
    bias: number;
    /** Footprint area (m^2) at which a building reaches its nominal height. */
    areaRef: number;
  };
  /** Wall material mix (weights need not sum to 1). */
  materials: Partial<Record<WallMaterial, number>>;
  /** Tint choices per wall material, as 0xRRGGBB. */
  palette: Partial<Record<WallMaterial, number[]>>;
  /** Roof tint choices. */
  roofPalette: number[];
  ground: {
    /** Tint of the generic ground between features. */
    base: number;
    pavement: number;
    asphalt: number;
    /** Sidewalk surface: small stone setts or large concrete slabs. */
    paving: 'setts' | 'slabs';
    /** 0..1, how much standing water and damp the streets hold. */
    wetness: number;
  };
  atmosphere: {
    time: TimeOfDay;
    /** 0..1, fog thickness multiplier. */
    fog: number;
    /** 0..1, cloud cover. */
    clouds: number;
    /** 0..1, how enclosed the streets are by buildings: blocks low sky in lighting and reflections. */
    enclosure: number;
    /** 0..1, how much the district lights its own night sky (washes out stars). */
    skyGlow: number;
    /** 0..1, how much illuminated signage and storefront color. */
    signageDensity: number;
    /** 0..1, reserved for the Milestone 5 crowd system. */
    pedestrianDensity: number;
    /** 0..1, fraction of windows lit at night. */
    litWindows: number;
    /** 0 = cool office light, 1 = warm lantern light. */
    lightWarmth: number;
    /** 0..1, dirt and streaking on facades. */
    weathering: number;
    /** Street lamp spacing in meters. */
    lampSpacing: number;
    /** 0..1, street tree frequency along roads. */
    streetTrees: number;
    /** 0..1, how full the kerbside parking is. */
    parking: number;
    /** Which tree species grow here and how often: [broadleaf, plane, conifer, palm] weights. */
    vegetation: [number, number, number, number];
  };
}
