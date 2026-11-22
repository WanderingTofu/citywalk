import { Rng, foldId } from '../core/rng';
import { Mat, WindowPattern, type StyleConfig, type WallMaterial } from '../districts/StyleConfig';
import { longestEdgeDirection } from '../geo/polygon';
import type { BuildingFeature } from './types';

/**
 * Every per-building decision, derived deterministically from the footprint,
 * its OSM tags and the district style. The same plan drives geometry at every
 * LOD and the collision volume, so they always agree.
 */
export interface BuildingPlan {
  /** Height of the ground under the building (minHeight tag), meters. */
  baseY: number;
  /** Top of the walls, meters above ground. */
  wallTop: number;
  /** Extra height of a pitched roof above the walls. */
  roofRise: number;
  /** True when the height came from district rules, not from OSM tags. */
  estimated: boolean;
  floors: number;
  floorH: number;
  /** Ground-floor storefront height; 0 = no storefront. */
  groundH: number;
  wallMat: number;
  tint: [number, number, number];
  pattern: number;
  bay: number;
  fill: [number, number];
  roof: 'flat' | 'gable' | 'mansard';
  roofMat: number;
  roofTint: [number, number, number];
  /** 0..1 value fed to the shader for per-building variation. */
  seed: number;
  tower: boolean;
  /** Fraction of the height where an upper tier steps in; 0 = none. */
  setbackAt: number;
  /** Unit vector along the footprint's main facade. */
  axis: [number, number];
  /** Half extent of the footprint across `axis`. */
  halfSpan: number;
  /** Center of the footprint across `axis` (projected coordinate). */
  midSpan: number;
  sign: boolean;
}

const MINOR_KINDS = new Set([
  'garage', 'garages', 'shed', 'hut', 'roof', 'kiosk', 'carport', 'toilets', 'greenhouse', 'cabin',
  'bicycle_parking', 'service', 'container', 'tent',
]);

export function srgbToLinear(hex: number): [number, number, number] {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
}

function vary(c: [number, number, number], k: number): [number, number, number] {
  return [c[0] * k, c[1] * k, c[2] * k];
}

export function planBuilding(b: BuildingFeature, style: StyleConfig): BuildingPlan {
  const rng = new Rng(foldId(b.id));
  const arch = style.architecture;
  const minor = MINOR_KINDS.has(b.kind) || b.area < 22;

  // --- height -------------------------------------------------------------
  let total: number;
  let estimated = false;
  const rHeight = rng.next(); // always drawn so later draws do not depend on the tags
  if (b.height > 0) {
    total = Math.min(Math.max(b.height, 2.4), 900);
  } else if (b.levels > 0) {
    total = Math.min(b.levels, 250) * arch.floorHeight + (arch.groundFloorHeight > arch.floorHeight ? 0.6 : 0);
  } else {
    estimated = true;
    if (minor) {
      total = 2.8 + rHeight * 0.6;
    } else {
      const h = style.heights;
      const areaF = Math.min(Math.max(Math.sqrt(b.area / h.areaRef), 0.35), 1.6);
      const t = Math.pow(rHeight, h.bias);
      const levels = Math.max(1, Math.round(h.minLevels + (h.maxLevels - h.minLevels) * t * areaF));
      total = levels * arch.floorHeight;
    }
  }
  const baseY = b.minHeight > 0 && b.minHeight < total - 2 ? b.minHeight : 0;
  const tower = total > arch.towerHeight;

  // --- footprint frame ----------------------------------------------------
  const outer = b.rings[0];
  const axis = longestEdgeDirection(outer);
  let sMin = Infinity;
  let sMax = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    const s = -axis[1] * outer[i] + axis[0] * outer[i + 1];
    if (s < sMin) sMin = s;
    if (s > sMax) sMax = s;
  }
  const halfSpan = (sMax - sMin) / 2;
  const midSpan = (sMax + sMin) / 2;

  // --- roof ---------------------------------------------------------------
  let roof: BuildingPlan['roof'] = 'flat';
  let roofRise = 0;
  const rRoof = rng.next();
  if (
    arch.roofStyle !== 'flat' && !tower && b.rings.length === 1 && halfSpan > 1.2 &&
    b.area <= arch.pitchedMaxArea && total - baseY <= arch.pitchedMaxHeight && (minor ? rRoof < 0.5 : rRoof < 0.94)
  ) {
    roof = arch.roofStyle;
    roofRise = roof === 'gable' ? Math.min(4.8, arch.roofPitch * halfSpan) : Math.min(arch.roofPitch, halfSpan * 0.9);
  }
  // A tagged height is the top of the roof; an estimated one is the top of the walls.
  let wallTop = total;
  if (roofRise > 0 && b.height > 0) wallTop = Math.max(2.4 + baseY, total - roofRise);

  // --- materials ----------------------------------------------------------
  let matName: WallMaterial = rng.weighted(style.materials);
  if (tower) {
    const rTower = rng.next();
    if (rTower < 0.6 && style.palette.glass) matName = 'glass';
    else if (rTower < 0.8 && style.palette.metal) matName = 'metal';
  } else {
    rng.next();
  }
  const palette = style.palette[matName] ?? [0xb0b0b0];
  const tint = vary(srgbToLinear(rng.pick(palette)), rng.range(0.9, 1.08));

  // --- facade layout ------------------------------------------------------
  let pattern: number = WindowPattern[tower ? arch.towerPattern : arch.windowPattern];
  if (matName === 'glass') pattern = WindowPattern.curtain;
  if (pattern === WindowPattern.lattice && matName !== 'wood' && matName !== 'plaster') pattern = WindowPattern.grid;
  if (pattern === WindowPattern.french && (matName === 'metal' || matName === 'concrete')) pattern = WindowPattern.grid;
  if (minor) pattern = WindowPattern.none;

  const wallH = wallTop - baseY;
  let groundH = 0;
  const rStore = rng.next();
  if (!minor && arch.groundFloorHeight > 0 && baseY === 0 && rStore < arch.storefronts && wallH >= arch.groundFloorHeight + arch.floorHeight * 0.8) {
    groundH = arch.groundFloorHeight;
  }
  const floors = Math.max(1, Math.round((wallH - groundH) / arch.floorHeight));
  const floorH = (wallH - groundH) / floors;

  const rSet = rng.next();
  const setbackAt = tower && b.rings.length === 1 && b.area > 260 && rSet < arch.setbacks ? 0.5 + rng.next() * 0.25 : 0;

  const rSign = rng.next();
  const sign = groundH > 0 && wallH > 9 && rSign < style.atmosphere.signageDensity * 0.55;

  return {
    baseY,
    wallTop,
    roofRise,
    estimated,
    floors,
    floorH,
    groundH,
    wallMat: Mat[matName],
    tint,
    pattern,
    bay: arch.bayWidth * rng.range(0.9, 1.15),
    fill: [arch.windowFill[0] * rng.range(0.9, 1.08), arch.windowFill[1] * rng.range(0.92, 1.06)],
    roof,
    roofMat: roof === 'flat' ? Mat.concrete : Mat[arch.roofMaterial],
    roofTint: vary(srgbToLinear(rng.pick(style.roofPalette)), rng.range(0.9, 1.1)),
    seed: rng.next(),
    tower,
    setbackAt,
    axis,
    halfSpan,
    midSpan,
    sign,
  };
}

/** Highest point of the building, used for collision and LOD decisions. */
export function buildingTop(plan: BuildingPlan): number {
  return plan.wallTop + plan.roofRise;
}
