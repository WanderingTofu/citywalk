import { defaultQuality, QUALITY, type QualityLevel } from './config/quality';
import { Engine } from './core/Engine';
import type { TimeOfDay } from './districts/StyleConfig';
import { Controls } from './ui/Controls';

function fatal(message: string): void {
  const box = document.getElementById('fatal')!;
  box.style.display = 'grid';
  box.textContent = message;
}

function boot(): void {
  const container = document.getElementById('app')!;
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) {
    fatal('CITYWALK needs WebGL 2. Please try a current version of Chrome, Edge, Firefox or Safari.');
    return;
  }

  const q = new URLSearchParams(location.search);
  const quality = q.get('quality');
  const time = q.get('time');
  const hour = Number(q.get('hour'));
  const engine = new Engine(container, {
    city: q.get('city') ?? undefined,
    district: q.get('district') ?? undefined,
    time: time === 'day' || time === 'golden' || time === 'night' ? (time as TimeOfDay) : undefined,
    hour: q.has('hour') && hour >= 0 && hour <= 24 ? hour : undefined,
    quality: quality && quality in QUALITY ? (quality as QualityLevel) : defaultQuality(),
    mode: q.has('demo') ? 'demo' : 'live',
  });
  // ?res=fixed pins the render resolution, for benchmarks and screenshots.
  if (q.get('res') === 'fixed') engine.renderer.adaptive = false;
  new Controls(engine);
  engine.start();

  // Handle for the console and for automated walkthroughs.
  (window as unknown as { citywalk: Engine }).citywalk = engine;
}

try {
  boot();
} catch (err) {
  console.error(err);
  fatal('CITYWALK failed to start: ' + (err instanceof Error ? err.message : String(err)));
}
