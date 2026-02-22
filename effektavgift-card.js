/**
 * Effektavgift Card v7 - Home Assistant
 * Reads pre-computed peaks from helpers (set by effektavgift_calc.py).
 * Fetches last 24h hourly statistics via WebSocket for the bar chart.
 *
 * INSTALLATION:
 *   1. Copy to /config/www/effektavgift-card.js
 *   2. Resource URL: /local/effektavgift-card.js?v=28   Type: JavaScript Module
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
    this._chartData = [];   // [{hour, mean, isNight, isTop}]
    this._loading = false;
    this._lastFetch = 0;
  }

  setConfig(config) {
    this._config = {
      entity: config.entity || 'sensor.slimmelezer_power_consumed',

      title: config.title || 'Effektavgift',
    };
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
    if (!this._loading && Date.now() - this._lastFetch > 15 * 60 * 1000) {
      this._fetchChart();
    }
  }

  // Parse "YYYY-MM-DD HH:MM | 3.15 kW | eff 3.15 kW" from input_text helper
  _parsePeak(entityId) {
    const s = this._hass && this._hass.states[entityId];
    if (!s || !s.state || s.state === 'unknown' || s.state === '') return null;
    const parts = s.state.split('|').map(x => x.trim());
    if (parts.length < 3) return null;
    // parts[0]: "2026-02-14 13:00"  parts[1]: "3.15 kW"  parts[2]: "eff 3.15 kW"
    const datehour = parts[0];  // "2026-02-14 13:00"
    const [date, timeStr] = datehour.split(' ');
    const hour = parseInt((timeStr || '0').split(':')[0], 10);
    const rawKw = parseFloat(parts[1]);
    const effKw = parseFloat(parts[2].replace(/[^\d.]/g, ''));
    if (!date || !isFinite(hour) || !isFinite(rawKw) || !isFinite(effKw)) return null;
    const isNight = hour >= NIGHT_START || hour < NIGHT_END;
    return { date, hour, rawKw, effKw, isNight };
  }

  async _fetchChart() {
    if (!this._hass) return;
    this._loading = true;
    this._lastFetch = Date.now();

    try {
      const now = new Date();
      // Go back 25h to make sure we capture the last 24 complete hours
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

      // r.start is a millisecond Unix timestamp
      const cutoff = now.getTime() - 48 * 3600 * 1000;
      this._chartData = rows
        .filter(r => {
            const ms = typeof r.start === 'string' ? Date.parse(r.start)
                     : r.start > 1e11 ? r.start : r.start * 1000;
            return ms >= cutoff;
          })
        .map(r => {
          // r.start may be ms timestamp, s timestamp, or ISO string depending on HA version
          const startMs = typeof r.start === 'string' ? Date.parse(r.start)
                        : r.start > 1e11 ? r.start   // already ms
                        : r.start * 1000;             // seconds → ms
          const ts = new Date(startMs);
          const hour = ts.getHours();
          const isNight = hour >= NIGHT_START || hour < NIGHT_END;
          return {
            ts,
            hour,
            mean: r.mean,
            isNight,
            label: ts.toLocaleDateString('en-GB', {month:'short',day:'numeric'}) + ' ' + String(hour).padStart(2,'0') + ':00',
          };
        });
    } catch (err) {
      console.error('Effektavgift chart fetch:', err);
    }

    this._loading = false;
    this._render();
  }

  _render() {
    if (!this._config.entity || !this._hass) return;

    // Current live power reading
    const stateObj = this._hass.states[this._config.entity];
    const currentKw = stateObj ? (parseFloat(stateObj.state) || 0) : 0;

    // Read pre-computed helpers
    const avgState  = this._hass.states['input_number.effektavgift_peak_avg_kw'];
    const costState = this._hass.states['input_number.effektavgift_est_cost'];
    const avg  = avgState  ? (parseFloat(avgState.state)  || 0) : 0;
    const cost = costState ? (parseFloat(costState.state) || 0) : 0;
    // Derive price from helpers so card needs no hardcoded value
    const pricePerKw = avg > 0 ? cost / avg : 0;

    const top3 = [
      this._parsePeak('input_text.effektavgift_peak_1'),
      this._parsePeak('input_text.effektavgift_peak_2'),
      this._parsePeak('input_text.effektavgift_peak_3'),
    ].filter(Boolean);

    // Peak keys for chart highlighting — match format used in chart loop: "YYYY-MM-DD HH"
    const peakKeys = new Set(top3.map(p => `${p.date} ${String(p.hour).padStart(2,'0')}`));

    // Would current draw displace the 3rd peak?
    const now = new Date();
    const isNightNow = now.getHours() >= NIGHT_START || now.getHours() < NIGHT_END;
    const effectiveNow = isNightNow ? currentKw * 0.5 : currentKw;
    const wouldBeNewPeak = top3.length >= 3 && effectiveNow > top3[2].effKw;
    const projectedCost = wouldBeNewPeak
      ? ((top3[0].effKw + top3[1].effKw + effectiveNow) / 3) * pricePerKw
      : null;

    const autoState = this._hass.states['automation.effektavgift_calculate_hourly_peaks'];
    const lastUpdatedRaw = (autoState && autoState.attributes && autoState.attributes.last_triggered)
      || (autoState && autoState.last_updated)
      || (avgState && avgState.last_updated);
    const lastUpdated = lastUpdatedRaw
      ? new Date(lastUpdatedRaw).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'})
      : '—';
    const monthName = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

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

    const green = '#22c55e', red = '#ef4444';
    const alertColor = wouldBeNewPeak ? red : green;
    const alertText  = wouldBeNewPeak
      ? `Warning: current draw may become a new monthly peak! Projected cost: <strong>${projectedCost.toFixed(0)} kr</strong>`
      : top3.length === 0
        ? `No peak data yet this month &mdash; waiting for first full hour`
        : top3.length < 3
          ? `${top3.length} of 3 peaks recorded so far &mdash; current draw does not affect ranking`
          : `OK &mdash; current draw does not affect this month's top&nbsp;3`;

    // ---- Build 48h bar chart ----
    const chartH = 100;
    let chartSvg = '';
    let chartLegend = '';

    if (this._chartData.length > 0) {
      // Find peak hour in the displayed window
      const peak24 = this._chartData.reduce((best, r) => (!best || r.mean > best.mean) ? r : best, null);
      const maxMean = Math.max(...this._chartData.map(r => r.mean), effectiveNow, 0.5);
      const n = this._chartData.length;
      const bw = Math.max(4, Math.min(16, Math.floor(600 / n)));
      const gap = 1;
      const svgW = n * (bw + gap);

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

      // Axis line
      const axis = `<line x1="0" y1="${chartH}" x2="${svgW}" y2="${chartH}" stroke="var(--divider-color,rgba(255,255,255,.12))" stroke-width="1"/>`;

      // X-axis labels every 6 hours, rotated vertically so nothing overlaps
      const labelH = 62;
      let dayLabels = '';
      this._chartData.forEach((r, i) => {
        if (r.hour % 2 === 0) {
          const cx = i * (bw + gap) + bw / 2;
          const timeLabel = String(r.hour).padStart(2,'0') + ':00';
          const label = r.ts.toLocaleDateString('en-GB', {month:'short', day:'numeric'}) + ' ' + timeLabel;
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
    } else {
      chartSvg = `
        <div style="font-size:0.76em;color:var(--secondary-text-color);margin-bottom:4px">Hourly power draw &mdash; last 24 hours</div>
        <div style="text-align:center;padding:14px;color:var(--secondary-text-color);font-size:0.82em">
          ${this._loading ? 'Loading chart…' : 'No data yet'}
        </div>`;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif) }
        ha-card { padding: 16px 16px 14px }
        h2 { margin: 0 0 1px; font-size: 1.1em; color: var(--primary-text-color) }
        .sub { font-size: 0.75em; color: var(--secondary-text-color); margin-bottom: 14px }
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
      </style>
      <ha-card>
        <h2>${this._config.title}</h2>
        <div class="sub">Ellevio power peak charge &mdash; ${monthName}</div>

        <div class="kpi-grid">
          <div class="kpi">
            <div class="kv">${currentKw.toFixed(2)}</div>
            <div class="ku">kW</div>
            <div class="kl">Right now${isNightNow ? ' 🌙' : ''}</div>
          </div>
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

        <div class="alert" style="background:${alertColor}22;border-left:3px solid ${alertColor}">
          ${alertText}
        </div>

        ${top3.length > 0 ? `
          <div style="font-size:0.76em;color:var(--secondary-text-color);margin-bottom:4px">Top 3 peak hours this month</div>
          <table>
            <tr><th>#</th><th>Date</th><th>Hour</th><th>Raw value</th><th>Effective</th></tr>
            ${top3Rows}
          </table>
          <div class="formula">${formulaStr}</div>
          <hr>
        ` : `<div class="nodata">Waiting for computed data&hellip;<br><small>Automation runs every hour</small></div>`}

        ${chartSvg}
        ${chartLegend}

        <div class="footer">Last computed: ${lastUpdated} &bull; updates every hour</div>
      </ha-card>`;
  }

  getCardSize() { return 5; }
  static getStubConfig() {

  }
}

customElements.define('effektavgift-card', EffektavgiftCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'effektavgift-card',
  name: 'Effektavgift Card',
  description: 'Ellevio power peak charge from Slimmelezer data (backend-computed)',
  preview: false,
});