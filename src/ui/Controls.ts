import { CITIES } from '../config/cities';
import type { QualityLevel } from '../config/quality';
import type { DataMode, Engine } from '../core/Engine';
import type { TimeOfDay } from '../districts/StyleConfig';

/**
 * Minimal HUD in plain DOM: world selectors, performance overlay, status
 * line, controls guide and data attribution. No framework.
 */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, children: Array<Node | string> = []): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function select<T extends string>(options: Array<{ value: T; label: string }>, value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = el('select');
  for (const o of options) s.append(el('option', { value: o.value, textContent: o.label }));
  s.value = value;
  s.addEventListener('change', () => {
    onChange(s.value as T);
    s.blur(); // give the keyboard back to the walker
  });
  return s;
}

export class Controls {
  private readonly statRows = new Map<string, HTMLSpanElement>();
  private readonly place = el('div', { className: 'place' });
  private readonly coord = el('div', { className: 'coord' });
  private readonly notice = el('div', { className: 'notice' });
  private readonly loading = el('div', { className: 'loading' });
  private readonly help: HTMLDivElement;
  private readonly progress = document.getElementById('progress')!;
  private districtSelect!: HTMLSelectElement;
  private timeSelect!: HTMLSelectElement;
  private peakWork = 1;

  constructor(private readonly engine: Engine) {
    this.buildControls();
    this.buildStats();
    document.body.append(el('div', { id: 'status', className: 'panel' }, [this.place, this.coord, this.notice, this.loading]));
    document.body.append(
      el('div', { id: 'attribution', className: 'panel' }, [
        'Map data © ',
        el('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener', textContent: 'OpenStreetMap contributors' }),
      ]),
    );
    this.help = this.buildHelp();
    document.body.append(this.help);
    engine.player.onLockChange = (locked) => this.help.classList.toggle('hidden', locked);
    setInterval(() => this.refresh(), 250);
    this.refresh();
  }

  private buildControls(): void {
    const e = this.engine;
    const row = (label: string, control: HTMLElement) => el('label', {}, [label, control]);

    const city = select(CITIES.map((c) => ({ value: c.id, label: c.name })), e.state.city.id, (id) => {
      e.setLocation(id);
      this.syncLocation();
    });
    this.districtSelect = select([], '', (id) => {
      e.setLocation(e.state.city.id, id);
      this.syncLocation();
    });
    this.timeSelect = select<TimeOfDay>(
      [{ value: 'day', label: 'Day' }, { value: 'golden', label: 'Golden hour' }, { value: 'night', label: 'Night' }],
      e.state.time,
      (t) => {
        e.setTime(t);
        this.syncUrl();
      },
    );
    const quality = select<QualityLevel>(
      [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'ultra', label: 'Ultra' }],
      e.state.quality,
      (q) => {
        e.setQuality(q);
        this.syncUrl();
      },
    );
    const mode = select<DataMode>(
      [{ value: 'live', label: 'Live OpenStreetMap' }, { value: 'demo', label: 'Offline demo city' }],
      e.state.mode,
      (m) => {
        e.setMode(m);
        this.syncUrl();
      },
    );

    document.body.append(
      el('div', { id: 'controls', className: 'panel' }, [
        el('h1', { innerHTML: 'CITY<span>WALK</span>' }),
        row('City', city),
        row('District', this.districtSelect),
        row('Time', this.timeSelect),
        row('Graphics', quality),
        row('Data', mode),
      ]),
    );
    this.syncLocation();
  }

  /** Refill the district list and time selector after a location change. */
  private syncLocation(): void {
    const { city, district, time } = this.engine.state;
    this.districtSelect.replaceChildren(...city.districts.map((d) => el('option', { value: d.id, textContent: d.name })));
    this.districtSelect.value = district.id;
    this.timeSelect.value = time;
    this.syncUrl();
  }

  /** Keep the address bar shareable. */
  private syncUrl(): void {
    const s = this.engine.state;
    const q = new URLSearchParams({ city: s.city.id, district: s.district.id, time: s.time, quality: s.quality });
    if (s.mode === 'demo') q.set('demo', '1');
    history.replaceState(null, '', `?${q}`);
  }

  private buildStats(): void {
    const panel = el('div', { id: 'stats', className: 'panel' });
    for (const [key, label] of [
      ['fps', 'FPS'], ['frame', 'Frame'], ['calls', 'Draw calls'], ['tris', 'Triangles'],
      ['chunks', 'Chunks'], ['lod', 'LOD 0 / 1 / 2'], ['tiles', 'Map tiles'], ['queue', 'Queue'],
      ['gpu', 'Geometries'], ['heap', 'JS heap'], ['res', 'Render scale'],
    ]) {
      const value = el('span', { textContent: '–' });
      if (key === 'fps') value.className = 'big';
      this.statRows.set(key, value);
      panel.append(el('div', {}, [el('span', { textContent: label }), value]));
    }
    document.body.append(panel);
  }

  private buildHelp(): HTMLDivElement {
    const keys = (...k: string[]) => k.map((x) => `<kbd>${x}</kbd>`).join(' ');
    const rows: Array<[string, string]> = [
      [keys('W', 'A', 'S', 'D'), 'Walk'],
      ['Mouse', 'Look around'],
      [keys('Shift'), 'Sprint'],
      [keys('Space'), 'Jump'],
      [keys('V'), 'First / third person'],
      [keys('Esc'), 'Release the mouse'],
    ];
    return el('div', {
      id: 'help',
      className: 'panel',
      innerHTML:
        '<h2>Click to walk</h2><p>Real streets and footprints. Generated architecture.</p><table>' +
        rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') +
        '</table>',
    });
  }

  private set(key: string, text: string): void {
    const row = this.statRows.get(key)!;
    if (row.textContent !== text) row.textContent = text;
  }

  private refresh(): void {
    const e = this.engine;
    const s = e.stats;
    const w = s.world;
    this.set('fps', s.fps.toFixed(0));
    this.set('frame', `${s.frameMs.toFixed(1)} ms · max ${s.worstMs.toFixed(0)}`);
    this.set('calls', String(s.render.drawCalls));
    this.set('tris', s.render.triangles > 1e6 ? `${(s.render.triangles / 1e6).toFixed(2)} M` : `${(s.render.triangles / 1e3).toFixed(0)} k`);
    this.set('chunks', String(w.chunks));
    this.set('lod', w.chunksByLod.join(' / '));
    this.set('tiles', `${w.tiles}${w.tilesLoading ? ` (+${w.tilesLoading})` : ''}`);
    this.set('queue', String(w.queue + w.buildsPending));
    this.set('gpu', String(s.render.geometries));
    this.set('heap', s.heapMb === null ? 'n/a' : `${s.heapMb.toFixed(0)} MB`);
    this.set('res', `${s.render.pixelRatio.toFixed(2)}×`);

    const { city, district } = e.state;
    this.place.textContent = `${city.name} — ${district.name}`;
    this.coord.textContent = `${s.position.lat.toFixed(5)}, ${s.position.lon.toFixed(5)}`;

    // Be explicit whenever what is on screen is not real geography.
    const synthetic = w.sources.demo + w.sources.fallback;
    this.notice.textContent =
      e.state.mode === 'demo'
        ? 'Offline demo city: procedurally generated, not real geography.'
        : synthetic > 0
          ? `${w.lastError || 'Live map data unavailable.'} (${synthetic} of ${w.tiles} tiles)`
          : '';

    const work = w.tilesLoading + w.queue + w.buildsPending;
    this.peakWork = work === 0 ? 1 : Math.max(this.peakWork, work);
    this.loading.textContent = w.tilesLoading ? `Loading map data… ${w.tilesLoading} tile${w.tilesLoading > 1 ? 's' : ''}` : work ? 'Building city…' : '';
    this.progress.style.opacity = work ? '1' : '0';
    this.progress.style.transform = `scaleX(${work ? 1 - work / (this.peakWork + 1) : 1})`;
  }
}
