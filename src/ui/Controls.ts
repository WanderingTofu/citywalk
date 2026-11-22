import { CITIES } from '../config/cities';
import type { QualityLevel } from '../config/quality';
import type { DataMode, Engine, TimeSetting } from '../core/Engine';
import type { TimeOfDay } from '../districts/StyleConfig';

/**
 * Minimal HUD in plain DOM: world selectors, the clock, performance overlay,
 * status line, controls guide and data attribution. No framework.
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

function clock(hour: number): string {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour - Math.floor(hour)) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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
  private hourSlider!: HTMLInputElement;
  private hourLabel!: HTMLSpanElement;
  private cycleButton!: HTMLButtonElement;
  private flyButton!: HTMLButtonElement;
  private sliding = false;
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
    engine.player.onModeChange = () => this.syncButtons();
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
    this.timeSelect = select<TimeSetting>(
      [
        { value: 'day', label: 'Day' },
        { value: 'golden', label: 'Golden hour' },
        { value: 'night', label: 'Night' },
        { value: 'custom', label: 'Custom' },
      ],
      e.state.time,
      (t) => {
        if (t !== 'custom') {
          e.setCycle(false);
          e.setTime(t as TimeOfDay);
        }
        this.syncButtons();
        this.syncUrl();
      },
    );

    // The clock: drag to put the sun or moon where you want it.
    this.hourSlider = el('input', { type: 'range', min: '0', max: '24', step: '0.05', value: String(e.lighting.hour) });
    this.hourSlider.setAttribute('aria-label', 'Time of day');
    this.hourLabel = el('span', { className: 'clock', textContent: clock(e.lighting.hour) });
    this.hourSlider.addEventListener('input', () => {
      this.sliding = true;
      e.setCycle(false);
      e.setHour(Number(this.hourSlider.value));
      this.timeSelect.value = 'custom';
      this.hourLabel.textContent = clock(Number(this.hourSlider.value));
      this.syncButtons();
    });
    this.hourSlider.addEventListener('change', () => {
      this.sliding = false;
      this.hourSlider.blur();
      this.syncUrl();
    });
    this.cycleButton = el('button', { type: 'button', textContent: 'Run day' });
    this.cycleButton.addEventListener('click', () => {
      e.setCycle(!e.state.cycle);
      this.timeSelect.value = e.state.time;
      this.syncButtons();
      this.cycleButton.blur();
    });
    this.flyButton = el('button', { type: 'button', textContent: 'Fly' });
    this.flyButton.addEventListener('click', () => {
      e.player.setFlying(!e.player.flying);
      this.flyButton.blur();
    });

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
        el('div', { className: 'timeline' }, [this.hourSlider, this.hourLabel]),
        el('div', { className: 'buttons' }, [this.cycleButton, this.flyButton]),
        row('Graphics', quality),
        row('Data', mode),
      ]),
    );
    this.syncLocation();
    this.syncButtons();
  }

  /** Refill the district list and time selector after a location change. */
  private syncLocation(): void {
    const { city, district, time } = this.engine.state;
    this.districtSelect.replaceChildren(...city.districts.map((d) => el('option', { value: d.id, textContent: d.name })));
    this.districtSelect.value = district.id;
    this.timeSelect.value = time;
    this.syncUrl();
  }

  private syncButtons(): void {
    const e = this.engine;
    this.cycleButton.textContent = e.state.cycle ? 'Stop day' : 'Run day';
    this.cycleButton.classList.toggle('on', e.state.cycle);
    this.flyButton.textContent = e.player.flying ? 'Walk' : 'Fly';
    this.flyButton.classList.toggle('on', e.player.flying);
  }

  /** Keep the address bar shareable. */
  private syncUrl(): void {
    const s = this.engine.state;
    const q = new URLSearchParams({ city: s.city.id, district: s.district.id, quality: s.quality });
    if (s.time === 'custom') q.set('hour', this.engine.lighting.hour.toFixed(2));
    else q.set('time', s.time);
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
      [keys('W', 'A', 'S', 'D'), 'Move'],
      ['Mouse', 'Look around'],
      [keys('Shift'), 'Sprint / fly fast'],
      [keys('Space'), 'Jump'],
      [keys('F'), 'Fly as a drone'],
      [keys('E') + ' / ' + keys('Q'), 'Up / down while flying'],
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

    // The clock follows the engine while a preset is being approached or the day is running.
    if (!this.sliding) {
      this.hourSlider.value = String(s.hour);
      this.hourLabel.textContent = clock(s.hour);
    }

    const { city, district } = e.state;
    this.place.textContent = `${city.name} — ${district.name}`;
    this.coord.textContent =
      `${s.position.lat.toFixed(5)}, ${s.position.lon.toFixed(5)}` + (s.flying ? ` · ${s.position.altitude.toFixed(0)} m up` : '');

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
