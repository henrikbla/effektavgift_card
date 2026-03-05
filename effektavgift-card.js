/**
 * Effektavgift Card v31 - Home Assistant
 * Reads pre-computed peaks from helpers (set by effektavgift_calc.py).
 * Supports month navigation via history stored in input_text.effektavgift_history.
 *
 * INSTALLATION:
 *   1. Copy to /config/www/effektavgift-card.js
 *   2. Resource URL: /local/effektavgift-card.js?v=31   Type: JavaScript Module
 *   3. Card config:
 *        type: custom:effektavgift-card
 *        entity: sensor.slimmelezer_power_consumed
 *        title: Effektavgift
 */

const NIGHT_START = 22;
const NIGHT_END = 6;

class EffektavgiftCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass = null;
    this._config = {};
    this._chartData = [];
    this._loading = false;
    this._lastFetch = 0;
    this._viewingMonth = null; // null = current month
    this._history = null;      // cached after first fetch
    this._historyFetching = false;
    this._handleNav = this._handleNav.bind(this);
  }

  setConfig(config) {
    this._config = {
      entity: config.entity || 'sensor.slimmelezer_power_consumed',
      title: config.title || 'Effektavgift',
    };
  }

  set hass(hass) {
    const firstLoad = !this._hass;
    this._hass = hass;
    this._render().catch(e => console.error('Effektavgift render:', e));
    if (!this._loading && Date.now() - this._lastFetch > 15 * 60 * 1000) {
      this._fetchChart();
    }
    // On first load, fetch history then re-render so nav buttons appear
    if (firstLoad && !this._history) {
      this._loadHistory(true).then(() => {
        this._render().catch(e => console.error('Effektavgift render:', e));
      });
    }
  }

  _parsePeak(entityId) {
    const s = this._hass && this._hass.states[entityId];
    if (!s || !s.state || s.state === 'unknown' || s.state === '') return null;
    const parts = s.state.split('|').map(x => x.trim());
    if (parts.length < 3) return null;
    const datehour = parts[0];
    const [date, timeStr] = datehour.split(' ');
    const hour = parseInt((timeStr || '0').split(':')[0], 10);
    const rawKw = parseFloat(parts[1]);
    const effKw = parseFloat(parts[2].replace(/[^\d.]/g, ''));
    if (!date || !isFinite(hour) || !isFinite(rawKw) || !isFinite(effKw)) return null;
    const isNight = hour >= NIGHT_START || hour < NIGHT_END;
    return { date, hour, rawKw, effKw, isNight };
  }

  async _loadHistory(force = false) {
    if (this._history && !force) return this._history;
    if (this._historyFetching) return this._history || {};
    this._historyFetching = true;
    try {
      const resp = await fetch('/local/effektavgift_history.json?_=' + Date.now());
      if (resp.ok) {
        this._history = await resp.json();
      }
    } catch (e) {}
    this._historyFetching = false;
    return this._history || {};
  }

  async _handleNav(e) {
    const dir = e.target.dataset.dir;
    const history = await this._loadHistory();
    const months = Object.keys(history).sort();
    const now = new Date();
    const currentMonth = now.toISOString().slice(0, 7);
    const allMonths = [...new Set([...months, currentMonth])].sort();

    const cur = this._viewingMonth || currentMonth;
    const idx = allMonths.indexOf(cur);
    if (dir === 'prev' && idx > 0) this._viewingMonth = allMonths[idx - 1];
    else if (dir === 'next' && idx < allMonths.length - 1) this._viewingMonth = allMonths[idx + 1];
    if (this._viewingMonth === currentMonth) this._viewingMonth = null;
    this._render();
  }

  async _fetchChart() {
    if (!this._hass) return;
    this._loading = true;
    this._lastFetch = Date.now();
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 25 * 3600 * 1000).toISOString();
      const end = now.toISOString();
      const result = await this._hass.callWS({
        type: 'recorder/statistics_during_period',
        start_time: start,
        end_time: end,
        statistic_ids: [this._config.entity],
        period: 'hour',
        types: ['mean'],
        units: {},
      });
      const rows = (result && result[this._config.entity]) ? result[this._config.entity] : [];
      this._chartData = rows.map(r => {
        const startMs = typeof r.start === 'string' ? Date.parse(r.start)
                      : r.start > 1e11 ? r.start : r.start * 1000;
        const ts = new Date(startMs);
        const hour = ts.getHours();
        const isNight = hour >= NIGHT_START || hour < NIGHT_END;
        return {
          ts, hour, mean: r.mean, isNight,
          label: ts.toLocaleDateString('en-GB', {month:'short',day:'numeric'}) + ' ' + String(hour).padStart(2,'0') + ':00',
        };
      });
    } catch (err) {
      console.error('Effektavgift chart fetch:', err);
    }
    this._loading = false;
    this._render();
  }

  async _render() {
    if (!this._config.entity || !this._hass) return;

    const now = new Date();
    const currentMonth = now.toISOString().slice(0, 7);
    const isCurrentMonth = !this._viewingMonth || this._viewingMonth === currentMonth;

    const history = await this._loadHistory();
    const allMonths = [...new Set([...Object.keys(history), currentMonth])].sort();
    const viewMonth = this._viewingMonth || currentMonth;
    const viewIdx = allMonths.indexOf(viewMonth);
    const hasPrev = viewIdx > 0;
    const hasNext = viewIdx < allMonths.length - 1;

    // Format month display name
    const [yr, mo] = viewMonth.split('-');
    const monthName = new Date(parseInt(yr), parseInt(mo) - 1, 1)
      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    // Get data for viewed month
    let top3, avg, cost, pricePerKw;

    if (isCurrentMonth) {
      const avgState  = this._hass.states['input_number.effektavgift_peak_avg_kw'];
      const costState = this._hass.states['input_number.effektavgift_est_cost'];
      avg  = avgState  ? (parseFloat(avgState.state)  || 0) : 0;
      cost = costState ? (parseFloat(costState.state) || 0) : 0;
      pricePerKw = avg > 0 ? cost / avg : 0;
      top3 = [
        this._parsePeak('input_text.effektavgift_peak_1'),
        this._parsePeak('input_text.effektavgift_peak_2'),
        this._parsePeak('input_text.effektavgift_peak_3'),
      ].filter(Boolean);
    } else {
      const hd = history[viewMonth];
      if (hd) {
        avg  = hd.avg  || 0;
        cost = hd.cost || 0;
        pricePerKw = avg > 0 ? cost / avg : 0;
        top3 = (hd.peaks || []).map(p => ({
          date: p.date, hour: p.hour,
          rawKw: p.raw_kw, effKw: p.eff_kw,
          isNight: p.is_night,
        }));
      } else {
        avg = 0; cost = 0; pricePerKw = 0; top3 = [];
      }
    }

    // Current live power (only relevant for current month)
    const stateObj = this._hass.states[this._config.entity];
    const currentKw = stateObj ? (parseFloat(stateObj.state) || 0) : 0;
    const isNightNow = now.getHours() >= NIGHT_START || now.getHours() < NIGHT_END;
    const effectiveNow = isNightNow ? currentKw * 0.5 : currentKw;
    const wouldBeNewPeak = isCurrentMonth && top3.length >= 3 && effectiveNow > top3[2].effKw;
    const projectedCost = wouldBeNewPeak
      ? ((top3[0].effKw + top3[1].effKw + effectiveNow) / 3) * pricePerKw
      : null;

    const peakKeys = new Set(top3.map(p => `${p.date} ${String(p.hour).padStart(2,'0')}`));

    // Last computed time
    const autoState = this._hass.states['automation.effektavgift_calculate_hourly_peaks'];
    const avgState  = this._hass.states['input_number.effektavgift_peak_avg_kw'];
    const lastUpdatedRaw = (autoState && autoState.attributes && autoState.attributes.last_triggered)
      || (autoState && autoState.last_updated)
      || (avgState && avgState.last_updated);
    const lastUpdated = lastUpdatedRaw
      ? new Date(lastUpdatedRaw).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'})
      : '—';

    // Top 3 table rows
    const top3Rows = top3.map((p, i) => {
      const nightTag = p.isNight
        ? `<span style="background:#818cf8;color:#fff;border-radius:3px;padding:1px 5px;font-size:0.72em;margin-left:4px;">night ×0.5</span>`
        : '';
      return `<tr>
        <td style="color:var(--secondary-text-color)">${i+1}</td>
        <td>${p.date}</td>
        <td>${p.hour}:00</td>
        <td>${p.rawKw.toFixed(2)} kW${nightTag}</td>
        <td><strong>${p.effKw.toFixed(2)} kW</strong></td>
      </tr>`;
    }).join('');

    const formulaStr = top3.length > 0
      ? `(${top3.map(p => p.effKw.toFixed(2)).join(' + ')}) / ${top3.length} × ${pricePerKw.toFixed(2)} = ${cost.toFixed(0)} kr/month`
        + (top3.length < 3 ? ` &mdash; based on ${top3.length} peak${top3.length > 1 ? 's' : ''} so far` : '')
      : '';

    // Alert (current month only)
    const green = '#22c55e', red = '#ef4444';
    const alertColor = wouldBeNewPeak ? red : green;
    const alertText = isCurrentMonth
      ? (wouldBeNewPeak
          ? `Warning: current draw may become a new monthly peak! Projected cost: <strong>${projectedCost.toFixed(0)} kr</strong>`
          : top3.length === 0
            ? `No peak data yet this month &mdash; waiting for first full hour`
            : top3.length < 3
              ? `${top3.length} of 3 peaks recorded so far &mdash; current draw does not affect ranking`
              : `OK &mdash; current draw does not affect this month's top&nbsp;3`)
      : null;

    // Chart (current month only)
    const chartH = 100;
    let chartSvg = '', chartLegend = '';
    if (isCurrentMonth && this._chartData.length > 0) {
      const peak24 = this._chartData.reduce((best, r) => (!best || r.mean > best.mean) ? r : best, null);
      const maxMean = Math.max(...this._chartData.map(r => r.mean), effectiveNow, 0.5);
      const n = this._chartData.length;
      const bw = Math.max(4, Math.min(16, Math.floor(600 / n)));
      const gap = 1;
      const svgW = n * (bw + gap);
      const labelH = 62;

      const bars = this._chartData.map((r, i) => {
        const key = r.ts.toISOString().slice(0,10) + ' ' + String(r.hour).padStart(2,'0');
        const isPeak = peakKeys.has(key);
        const effMean = r.isNight ? r.mean * 0.5 : r.mean;
        const barH = Math.max(2, Math.round((r.mean / maxMean) * chartH));
        const color = isPeak ? '#ef4444' : r.isNight ? '#818cf8' : '#34d399';
        const x = i * (bw + gap);
        const tip = `${r.label}  ${r.mean.toFixed(2)} kW${r.isNight ? ' (night ×0.5 → ' + effMean.toFixed(2) + ' kW eff)' : ''}${isPeak ? ' ★ peak' : ''}`;
        return `<rect x="${x}" y="${chartH - barH}" width="${bw}" height="${barH}" fill="${color}" opacity="0.9" rx="1"><title>${tip}</title></rect>`;
      }).join('');

      const axis = `<line x1="0" y1="${chartH}" x2="${svgW}" y2="${chartH}" stroke="var(--divider-color,rgba(255,255,255,.12))" stroke-width="1"/>`;
      let dayLabels = '';
      this._chartData.forEach((r, i) => {
        if (r.hour % 2 === 0) {
          const cx = i * (bw + gap) + bw / 2;
          const timeLabel = String(r.hour).padStart(2,'0') + ':00';
          dayLabels += `<text transform="translate(${cx},${chartH + 4}) rotate(90)" text-anchor="start" font-size="9" fill="var(--secondary-text-color)" opacity="0.8">${timeLabel}</text>`;
        }
      });

      chartSvg = `
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px;flex-wrap:wrap">
          <span style="font-size:0.76em;color:var(--secondary-text-color)">Hourly power draw &mdash; last 24 hours</span>
          ${peak24 ? `<span style="font-size:0.72em;background:rgba(239,68,68,.15);color:#ef4444;border-radius:4px;padding:1px 7px">peak ${String(peak24.hour).padStart(2,"0")}:00 &mdash; ${peak24.mean.toFixed(2)} kW</span>` : ''}
        </div>
        <div style="display:flex;justify-content:center">
          <svg viewBox="0 0 ${svgW} ${chartH + labelH}" width="100%" height="${chartH + labelH}" style="display:block;max-width:${svgW}px">
            ${bars}${axis}${dayLabels}
          </svg>
        </div>`;

      chartLegend = `
        <div style="display:flex;gap:12px;margin:6px 0 14px;font-size:0.7em;color:var(--secondary-text-color);flex-wrap:wrap">
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#ef4444;margin-right:3px;vertical-align:middle"></span>Peak hour</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#34d399;margin-right:3px;vertical-align:middle"></span>Day (06:00–22:00)</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#818cf8;margin-right:3px;vertical-align:middle"></span>Night (22:00–06:00, ×0.5)</span>
        </div>`;
    }

    // Month nav buttons
    const navBar = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <button data-dir="prev" style="background:none;border:none;color:${hasPrev ? 'var(--primary-text-color)' : 'var(--disabled-text-color,#555)'};cursor:${hasPrev ? 'pointer' : 'default'};font-size:1.2em;padding:2px 8px;border-radius:6px;${hasPrev ? 'background:var(--secondary-background-color)' : ''}">‹</button>
        <span style="font-size:0.85em;font-weight:500;color:var(--primary-text-color)">${monthName}${isCurrentMonth ? ' <span style="font-size:0.75em;color:var(--accent-color,#22c55e)">●</span>' : ''}</span>
        <button data-dir="next" style="background:none;border:none;color:${hasNext ? 'var(--primary-text-color)' : 'var(--disabled-text-color,#555)'};cursor:${hasNext ? 'pointer' : 'default'};font-size:1.2em;padding:2px 8px;border-radius:6px;${hasNext ? 'background:var(--secondary-background-color)' : ''}">›</button>
      </div>`;

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif) }
        ha-card { padding: 16px 16px 14px }
        h2 { margin: 0 0 12px; font-size: 1.1em; color: var(--primary-text-color) }
        .kpi-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; margin-bottom: 12px }
        .kpi { background: var(--secondary-background-color, rgba(0,0,0,.08)); border-radius: 10px; padding: 10px 8px; text-align: center }
        .kv { font-size: 1.5em; font-weight: 700; color: var(--primary-text-color) }
        .ku { font-size: 0.62em; color: var(--secondary-text-color); margin-top: 1px }
        .kl { font-size: 0.7em; color: var(--secondary-text-color); margin-top: 3px }
        .alert { padding: 8px 12px; border-radius: 8px; font-size: 0.8em; margin-bottom: 14px; line-height: 1.4 }
        table { width: 100%; border-collapse: collapse; font-size: 0.8em; margin: 8px 0 4px }
        th { text-align: left; padding: 3px 6px; color: var(--secondary-text-color); font-weight: 500;
             border-bottom: 1px solid var(--divider-color, rgba(255,255,255,.12)) }
        td { padding: 4px 6px; color: var(--primary-text-color) }
        .formula { font-size: 0.73em; color: var(--secondary-text-color); margin: 2px 0 14px }
        .footer { font-size: 0.68em; color: var(--secondary-text-color); opacity: 0.6; margin-top: 10px }
        .nodata { text-align: center; padding: 20px; color: var(--secondary-text-color); font-size: 0.82em }
        hr { border: none; border-top: 1px solid var(--divider-color, rgba(255,255,255,.08)); margin: 12px 0 }
        button:hover { opacity: 0.8 }
      </style>
      <ha-card>
        <h2>${this._config.title}</h2>

        ${navBar}

        <div class="kpi-grid">
          ${isCurrentMonth ? `
          <div class="kpi">
            <div class="kv">${currentKw.toFixed(2)}</div>
            <div class="ku">kW</div>
            <div class="kl">Right now${isNightNow ? ' 🌙' : ''}</div>
          </div>` : `
          <div class="kpi">
            <div class="kv" style="font-size:1em;padding-top:6px">—</div>
            <div class="ku">kW</div>
            <div class="kl">Historical</div>
          </div>`}
          <div class="kpi">
            <div class="kv">${avg.toFixed(2)}</div>
            <div class="ku">kW avg (top 3)</div>
            <div class="kl">Peak value</div>
          </div>
          <div class="kpi" style="background:${cost > 400 ? 'rgba(239,68,68,.15)' : 'rgba(34,197,94,.15)'}">
            <div class="kv" style="color:${cost > 400 ? red : green}">${cost.toFixed(0)}</div>
            <div class="ku">kr/month</div>
            <div class="kl">Est. charge</div>
          </div>
        </div>

        ${alertText ? `
        <div class="alert" style="background:${alertColor}22;border-left:3px solid ${alertColor}">
          ${alertText}
        </div>` : ''}

        ${top3.length > 0 ? `
          <div style="font-size:0.76em;color:var(--secondary-text-color);margin-bottom:4px">Top 3 peak hours</div>
          <table>
            <tr><th>#</th><th>Date</th><th>Hour</th><th>Raw value</th><th>Effective</th></tr>
            ${top3Rows}
          </table>
          <div class="formula">${formulaStr}</div>
          ${isCurrentMonth ? '<hr>' : ''}
        ` : `<div class="nodata">No data for this month</div>`}

        ${isCurrentMonth ? chartSvg : ''}
        ${isCurrentMonth ? chartLegend : ''}

        <div class="footer">${isCurrentMonth ? `Last computed: ${lastUpdated} &bull; updates every hour` : `Final data for ${monthName}`}</div>
      </ha-card>`;

    // Attach nav listeners after render
    this.shadowRoot.querySelectorAll('button[data-dir]').forEach(btn => {
      btn.addEventListener('click', this._handleNav);
    });
  }

  getCardSize() { return 5; }
  static getStubConfig() { return {}; }
}

customElements.define('effektavgift-card', EffektavgiftCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'effektavgift-card',
  name: 'Effektavgift Card',
  description: 'Ellevio power peak charge from Slimmelezer data (backend-computed)',
  preview: false,
});