/* ============================================================
   best_plan_finder_addon.js — Best Plan Finder v2
   build tag: bpf2 / intended app build LC-319

   Additive browser-side feature for My Pension Project.
   - Does not replace engine.js or optimiser.js.
   - Does not write directly to Supabase.
   - Finds earliest safe retirement using explicit scenario inputs.
   - Apply updates the current in-browser model; the existing Save Model
     feature can then capture the applied scenario.

   Expected load order in app.html:
     common.js -> engine.js -> optimiser.js -> best_plan_finder_addon.js
   ============================================================ */
(function (global) {
  'use strict';

  const BUILD = 'bpf2';
  const ANN_NAME = 'Best Plan Finder Annuity';
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const state = { lastResult: null, originalAnnuities: null, applied: false };

  function qs(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function gbp(n) { return '£' + Math.round(Number(n) || 0).toLocaleString('en-GB'); }
  function toInputDate(d) {
    if (!d) return '';
    if (typeof App !== 'undefined' && App.toInputDate) return App.toInputDate(d);
    const x = new Date(d);
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }
  function parseDate(v) {
    if (!v) return null;
    if (typeof App !== 'undefined' && App.parseLocalDate) return App.parseLocalDate(v);
    const p = String(v).split('-').map(Number);
    if (p.length === 3 && p[0]) return new Date(p[0], p[1] - 1, p[2]);
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function monthIdx(d) { d = new Date(d); return d.getFullYear() * 12 + d.getMonth(); }
  function idxToDateLocal(idx) { return new Date(Math.floor(idx / 12), ((idx % 12) + 12) % 12, 1); }
  function dateLabel(d) { return d ? MONTHS[d.getMonth()] + ' ' + d.getFullYear() : '—'; }
  function readNum(id, fallback) {
    const el = qs(id);
    const n = el ? Number(String(el.value).replace(/,/g, '')) : NaN;
    return Number.isFinite(n) ? n : fallback;
  }
  function setMsg(text, kind) {
    const el = qs('bpf_msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'bpf-msg ' + (kind || '');
  }
  function getMemberName(slot) {
    try {
      if (slot === 'julie') return (typeof p2Name !== 'undefined' && p2Name) ? p2Name : null;
      return (typeof p1Name !== 'undefined' && p1Name) ? p1Name : 'Graham';
    } catch (e) { return slot === 'julie' ? null : 'Graham'; }
  }
  function ownerKeyToMember(owner) {
    if (owner === 'julie') return getMemberName('julie');
    return getMemberName('graham');
  }
  function closingFor(row, scope) {
    if (!row) return 0;
    if (scope === 'graham') return Number(row.g_closing) || 0;
    if (scope === 'julie') return Number(row.j_closing) || 0;
    return Number(row.combinedClosing != null ? row.combinedClosing : ((Number(row.g_closing) || 0) + (Number(row.j_closing) || 0))) || 0;
  }
  function buyFor(row, owner) {
    if (!row) return 0;
    if (owner === 'graham') return Number(row.g_annuityBuy) || 0;
    if (owner === 'julie') return Number(row.j_annuityBuy) || 0;
    return Number(row.annuityBuy) || 0;
  }
  function cleanExistingAnnuities(src) {
    return (src.annuities || []).filter(a => String(a.annuity_name || a.name || '') !== ANN_NAME);
  }
  function bestPlanAnnuityRow(opts) {
    if (!opts.includeBestPlanAnnuity) return null;
    const ownerMember = ownerKeyToMember(opts.owner);
    return {
      annuity_name: ANN_NAME,
      member_name: ownerMember,
      purchase_date: toInputDate(opts.annuityDate),
      purchase_amount: opts.annuityAmount,
      annuity_rate: opts.annuityRate,
      escalation_pct: opts.escalationPct,
      enabled: true,
      use_whole_pot: false
    };
  }
  function scenarioAnnuities(src, opts) {
    const base = opts.includeExistingAnnuities ? cleanExistingAnnuities(src) : [];
    const bpf = bestPlanAnnuityRow(opts);
    return bpf ? base.concat([bpf]) : base;
  }
  function buildScenarioData(src, opts) {
    const out = Object.assign({}, src || {});
    out.annuities = scenarioAnnuities(src || {}, opts);
    if (!opts.includeCrashes) out.crashes = [];
    return out;
  }
  function applyWithdrawalMode(basePlan, retireDate, opts) {
    const plan = Object.assign({}, basePlan, { retirementDate: retireDate, retireByMember: null });
    const mode = opts.withdrawalMode || 'current';
    if (mode === 'current') return plan;
    if (mode === 'ufpls') {
      plan.withdrawalMethodGraham = 'ufpls';
      plan.withdrawalMethodJulie = 'ufpls';
      plan.crystallisationDateGraham = null;
      plan.crystallisationDateJulie = null;
      return plan;
    }
    plan.withdrawalMethodGraham = 'fad';
    plan.withdrawalMethodJulie = 'fad';
    if (mode === 'tffirst') {
      plan.crystallisationDateGraham = toInputDate(retireDate);
      plan.crystallisationDateJulie = toInputDate(retireDate);
      return plan;
    }
    // flexi: use the current Flexi-Access dates where they exist; otherwise use retirement date.
    plan.crystallisationDateGraham = basePlan.crystallisationDateGraham || toInputDate(retireDate);
    plan.crystallisationDateJulie = basePlan.crystallisationDateJulie || toInputDate(retireDate);
    return plan;
  }
  function withdrawalLabel(mode) {
    return {
      current: 'Current model withdrawal settings',
      ufpls: 'Force blended / UFPLS',
      tffirst: 'Force tax-free first',
      flexi: 'Force flexi-access dates'
    }[mode || 'current'] || 'Current model withdrawal settings';
  }
  function scenarioSummary(opts) {
    const bits = [];
    bits.push(withdrawalLabel(opts.withdrawalMode));
    bits.push(opts.includeExistingAnnuities ? 'existing annuities included' : 'existing annuities excluded');
    bits.push(opts.includeBestPlanAnnuity ? 'Best Plan annuity included' : 'Best Plan annuity excluded');
    bits.push(opts.includeCrashes ? 'crashes included' : 'crashes excluded');
    return bits.join(' · ');
  }
  function evaluateRows(rows, opts) {
    const monthly = rows && rows.monthly ? rows.monthly : [];
    const annIdx = opts.annuityDate ? monthIdx(opts.annuityDate) : null;
    let minPot = Infinity, minIdx = null, anyShortfall = false, annuityBuy = 0, annuityRow = null, lastRow = null;
    for (const r of monthly) {
      const idx = r.year * 12 + r.month;
      const pot = closingFor(r, opts.reserveScope);
      if (pot < minPot) { minPot = pot; minIdx = idx; }
      if (r.shortfall) anyShortfall = true;
      if (annIdx != null && idx === annIdx) { annuityRow = r; annuityBuy += buyFor(r, opts.owner); }
      lastRow = r;
    }
    if (!Number.isFinite(minPot)) { minPot = null; }
    const reserveOK = minPot == null ? true : minPot + 1e-6 >= opts.reserveAmount;
    const shortfallOK = opts.noShortfall ? !anyShortfall : true;
    const mustCheckAnnuity = !!(opts.includeBestPlanAnnuity && opts.mustBuyAnnuity);
    const annuityOK = mustCheckAnnuity ? annuityBuy + 1 >= opts.annuityAmount : true;
    const pass = reserveOK && shortfallOK && annuityOK;
    let reason = 'Pass';
    if (!annuityOK) reason = 'Fixed Best Plan annuity could not be bought at ' + dateLabel(opts.annuityDate) + ' without enough member pot.';
    else if (!reserveOK) reason = 'Pot reserve breached: lowest ' + gbp(minPot) + ' is below ' + gbp(opts.reserveAmount) + '.';
    else if (!shortfallOK) reason = 'Monthly shortfall occurs.';
    return {
      pass, reason,
      minPot, minPotIdx: minIdx, minPotDate: minIdx == null ? null : idxToDateLocal(minIdx),
      anyShortfall, annuityBuy, annuityRow,
      endPot: lastRow ? closingFor(lastRow, opts.reserveScope) : null,
      rows: rows
    };
  }

  function bestPlanFixedAnnuity(srcData, opts) {
    opts = opts || {};
    if (typeof opts.rebuildForDate !== 'function') throw new Error('bestPlanFixedAnnuity requires rebuildForDate(retireDate).');
    const minIdx = monthIdx(opts.minDate), maxIdx = monthIdx(opts.maxDate);
    if (!Number.isFinite(minIdx) || !Number.isFinite(maxIdx) || maxIdx < minIdx) throw new Error('Invalid Best Plan date range.');
    const safeOpts = Object.assign({
      reserveAmount: 100000,
      reserveScope: 'combined',
      annuityAmount: 300000,
      annuityRate: 6,
      escalationPct: 0,
      owner: 'graham',
      includeCrashes: true,
      includeExistingAnnuities: false,
      includeBestPlanAnnuity: true,
      withdrawalMode: 'current',
      noShortfall: true,
      mustBuyAnnuity: true
    }, opts);
    let firstPass = null, firstFail = null, tried = 0;
    for (let idx = minIdx; idx <= maxIdx; idx++) {
      tried++;
      const retireDate = idxToDateLocal(idx);
      const cfg = opts.rebuildForDate(retireDate, safeOpts);
      const runData = buildScenarioData(srcData, safeOpts);
      const rows = global.PensionEngine.drawdown(runData, cfg);
      const ev = evaluateRows(rows, safeOpts);
      const detail = { retireDate, retireIdx: idx, cfg, evaluation: ev, runData };
      if (ev.pass) { firstPass = detail; break; }
      if (!firstFail) firstFail = detail;
    }
    if (!firstPass) {
      return {
        feasible: false,
        reason: firstFail && firstFail.evaluation ? firstFail.evaluation.reason : 'No date in range passed.',
        tried,
        firstFail,
        opts: safeOpts
      };
    }
    return {
      feasible: true,
      earliestDate: firstPass.retireDate,
      earliestIdx: firstPass.retireIdx,
      tried,
      detail: firstPass.evaluation,
      cfg: firstPass.cfg,
      runData: firstPass.runData,
      opts: safeOpts
    };
  }

  // Attach to the existing optimiser namespace without replacing current functions.
  global.PensionOptimiser = global.PensionOptimiser || {};
  global.PensionOptimiser.bestPlanFixedAnnuity = bestPlanFixedAnnuity;
  global.PensionOptimiser._bestPlanEvaluateRows = evaluateRows;
  global.PensionOptimiser._bestPlanBuild = BUILD;

  // ---------- UI injection ----------
  function buildCss() {
    if (qs('bpf_css')) return;
    const st = document.createElement('style'); st.id = 'bpf_css';
    st.textContent = `
      .bpf-panel{margin:14px 0 0;padding:14px;border:1px solid var(--line);border-radius:12px;background:linear-gradient(135deg,rgba(44,122,123,.10),rgba(44,122,123,.03));box-shadow:var(--shadow)}
      .bpf-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:10px}.bpf-title{font-weight:800;color:var(--ink);font-size:15px}.bpf-sub{font-size:12px;color:var(--ink-soft);margin-top:2px;line-height:1.35}.bpf-build{font-size:11px;color:var(--ink-soft)}
      .bpf-section{margin:10px 0 8px;padding:10px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.35)}.bpf-section-title{font-size:12px;font-weight:800;color:var(--accent-dark);text-transform:uppercase;letter-spacing:.04em;margin:0 0 8px}
      .bpf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(176px,1fr));gap:10px}.bpf-field{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px}.bpf-field label{display:block;font-size:12px;font-weight:700;color:var(--ink-soft);margin-bottom:6px}.bpf-field input,.bpf-field select{width:100%;min-height:38px;padding:8px 9px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface-2);color:var(--ink);font-size:14px}.bpf-chiprow{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.bpf-chip{border:1px solid var(--accent-border);background:var(--accent-soft);color:var(--accent-dark);border-radius:999px;padding:6px 10px;font-size:12px;font-weight:700;cursor:pointer;min-height:32px}.bpf-switches{display:flex;flex-wrap:wrap;gap:9px;margin-top:10px}.bpf-tog{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:8px 11px}.bpf-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}.bpf-btn{border:none;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer;min-height:42px}.bpf-run{background:var(--accent);color:white}.bpf-apply{background:#27ae60;color:white}.bpf-apply:disabled{opacity:.45;cursor:default}.bpf-discard{background:var(--surface);color:var(--ink);border:1px solid var(--line-strong)}.bpf-msg{font-size:13px;font-weight:700}.bpf-msg.err{color:#c0392b}.bpf-msg.ok{color:#2f8f5b}.bpf-result{margin-top:12px}.bpf-card{border-radius:12px;border:1px solid var(--line);background:var(--surface);padding:12px}.bpf-card.ok{border-color:#a7f3d0;background:#ecfdf5;color:#065f46}.bpf-card.bad{border-color:#fecaca;background:#fef2f2;color:#991b1b}.bpf-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-top:10px}.bpf-metric{border:1px solid rgba(0,0,0,.08);border-radius:10px;padding:9px;background:rgba(255,255,255,.55)}.bpf-metric b{display:block;font-size:16px}.bpf-metric span{font-size:11px;opacity:.8}.bpf-dialwrap{display:flex;gap:10px;align-items:center}.bpf-dial{width:76px;height:76px;border-radius:50%;border:8px solid var(--accent-soft);background:var(--surface-2);position:relative;box-shadow:inset 0 0 0 1px var(--line);touch-action:none;flex:0 0 auto}.bpf-dial:after{content:'';position:absolute;left:50%;top:12px;width:4px;height:28px;margin-left:-2px;background:var(--accent);border-radius:3px;transform-origin:50% 26px;transform:rotate(var(--bpf-rot,-45deg))}.bpf-dial:before{content:'';position:absolute;left:50%;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;background:var(--accent);border-radius:50%}.bpf-ratebox{flex:1 1 auto}.bpf-note{font-size:11.5px;color:var(--ink-soft);line-height:1.35;margin-top:8px}.bpf-summary{font-size:12px;color:var(--ink-soft);line-height:1.45;margin-top:8px}
      @media (prefers-color-scheme: dark){.bpf-section{background:rgba(255,255,255,.035)}.bpf-card.ok{background:rgba(6,95,70,.22);color:#a7f3d0}.bpf-card.bad{background:rgba(127,29,29,.24);color:#fecaca}.bpf-metric{background:rgba(255,255,255,.04)}}
      @media (max-width:600px){.bpf-panel{padding:12px}.bpf-grid{grid-template-columns:1fr}.bpf-actions .bpf-btn{flex:1 1 100%}.bpf-dialwrap{align-items:flex-start}}
    `;
    document.head.appendChild(st);
  }

  function panelHtml() {
    const gName = esc(getMemberName('graham') || 'Graham');
    const jName = esc(getMemberName('julie') || 'Julie');
    const hasP2 = !!getMemberName('julie');
    return `
      <div class="bpf-panel" id="bpf_panel">
        <div class="bpf-head">
          <div><div class="bpf-title">Best Plan Finder</div><div class="bpf-sub">Find the earliest safe retirement date. Scenario inputs are explicit, so existing annuities, the Best Plan annuity, crashes and withdrawal method are no longer hidden assumptions.</div></div>
          <div class="bpf-build">build ${BUILD}</div>
        </div>
        <div class="bpf-section">
          <div class="bpf-section-title">Scenario inputs</div>
          <div class="bpf-grid">
            <div class="bpf-field"><label>Withdrawal method</label><select id="bpf_withdrawal"><option value="current">Use current model settings</option><option value="ufpls">Force blended / UFPLS</option><option value="tffirst">Force tax-free first</option><option value="flexi">Force flexi-access dates</option></select></div>
            <div class="bpf-field"><label>Existing annuities</label><select id="bpf_existing_annuities"><option value="exclude">Exclude existing annuities</option><option value="include">Include existing annuities</option></select></div>
            <div class="bpf-field"><label>Market crashes</label><select id="bpf_crashes_mode"><option value="include">Include current crash table</option><option value="exclude">Exclude crashes</option></select></div>
            <div class="bpf-field"><label>Best Plan annuity</label><select id="bpf_best_annuity"><option value="include">Include fixed Best Plan annuity</option><option value="exclude">Exclude Best Plan annuity</option></select></div>
          </div>
        </div>
        <div class="bpf-section">
          <div class="bpf-section-title">Rules and annuity</div>
          <div class="bpf-grid">
            <div class="bpf-field"><label>Earliest retirement</label><input type="date" id="bpf_min_date" value="2027-10-01"></div>
            <div class="bpf-field"><label>Latest date to test</label><input type="date" id="bpf_max_date" value="2037-01-01"></div>
            <div class="bpf-field"><label>Minimum pot reserve</label><input type="number" id="bpf_reserve" min="0" step="10000" value="100000"><div class="bpf-chiprow"><button type="button" class="bpf-chip" data-set="bpf_reserve:50000">£50k</button><button type="button" class="bpf-chip" data-set="bpf_reserve:100000">£100k</button><button type="button" class="bpf-chip" data-set="bpf_reserve:150000">£150k</button><button type="button" class="bpf-chip" data-set="bpf_reserve:200000">£200k</button></div></div>
            <div class="bpf-field"><label>Reserve applies to</label><select id="bpf_scope"><option value="combined">Combined household pot</option><option value="graham">${gName} pot only</option>${hasP2 ? `<option value="julie">${jName} pot only</option>` : ''}</select></div>
            <div class="bpf-field"><label>Annuity purchase date</label><input type="date" id="bpf_ann_date" value="2037-01-01"></div>
            <div class="bpf-field"><label>Fixed annuity amount</label><input type="number" id="bpf_ann_amount" min="0" step="10000" value="300000"><div class="bpf-chiprow"><button type="button" class="bpf-chip" data-set="bpf_ann_amount:200000">£200k</button><button type="button" class="bpf-chip" data-set="bpf_ann_amount:250000">£250k</button><button type="button" class="bpf-chip" data-set="bpf_ann_amount:300000">£300k</button><button type="button" class="bpf-chip" data-set="bpf_ann_amount:350000">£350k</button></div></div>
            <div class="bpf-field"><label>Annuity owner</label><select id="bpf_owner"><option value="graham">${gName}</option>${hasP2 ? `<option value="julie">${jName}</option>` : ''}</select></div>
            <div class="bpf-field"><label>Annuity rate</label><div class="bpf-dialwrap"><div class="bpf-dial" id="bpf_rate_dial" role="slider" aria-label="Annuity rate dial"></div><div class="bpf-ratebox"><input type="number" id="bpf_rate" min="0" max="12" step="0.1" value="6.0"><div class="bpf-note">Drag the dial for rough setting, or type exact %.</div></div></div></div>
            <div class="bpf-field"><label>Annuity escalation</label><input type="number" id="bpf_escalation" min="0" max="10" step="0.1" value="0.0"></div>
          </div>
          <div class="bpf-switches"><label class="bpf-tog"><input type="checkbox" id="bpf_shortfall" checked> No shortfall allowed</label><label class="bpf-tog"><input type="checkbox" id="bpf_must_buy" checked> Must buy Best Plan annuity</label></div>
        </div>
        <div class="bpf-actions"><button type="button" class="bpf-btn bpf-run" id="bpf_run">Run Best Plan Finder</button><button type="button" class="bpf-btn bpf-apply" id="bpf_apply" disabled>Apply to current model</button><button type="button" class="bpf-btn bpf-discard" id="bpf_clear">Clear</button><span id="bpf_msg" class="bpf-msg"></span></div>
        <div class="bpf-summary" id="bpf_input_summary"></div>
        <div class="bpf-result" id="bpf_result"></div>
      </div>`;
  }

  function readBpfInputs() {
    const minDate = parseDate(qs('bpf_min_date').value);
    const maxDate = parseDate(qs('bpf_max_date').value);
    const annuityDate = parseDate(qs('bpf_ann_date').value);
    if (!minDate || !maxDate || !annuityDate) throw new Error('Please enter valid dates.');
    const includeBestPlanAnnuity = (qs('bpf_best_annuity').value || 'include') === 'include';
    return {
      minDate, maxDate,
      reserveAmount: Math.max(0, readNum('bpf_reserve', 100000)),
      reserveScope: qs('bpf_scope').value || 'combined',
      annuityDate,
      annuityAmount: Math.max(0, readNum('bpf_ann_amount', 300000)),
      annuityRate: Math.max(0, readNum('bpf_rate', 6)),
      escalationPct: Math.max(0, readNum('bpf_escalation', 0)),
      owner: qs('bpf_owner').value || 'graham',
      includeCrashes: (qs('bpf_crashes_mode').value || 'include') === 'include',
      includeExistingAnnuities: (qs('bpf_existing_annuities').value || 'exclude') === 'include',
      includeBestPlanAnnuity,
      withdrawalMode: qs('bpf_withdrawal').value || 'current',
      noShortfall: !!qs('bpf_shortfall').checked,
      mustBuyAnnuity: includeBestPlanAnnuity && !!qs('bpf_must_buy').checked
    };
  }
  function updateInputSummary() {
    const el = qs('bpf_input_summary');
    if (!el) return;
    try { el.textContent = 'Scenario: ' + scenarioSummary(readBpfInputs()) + '.'; }
    catch (e) { el.textContent = ''; }
  }
  function runBestPlan() {
    const out = qs('bpf_result');
    try {
      setMsg('Running…', ''); out.innerHTML = ''; qs('bpf_apply').disabled = true; state.lastResult = null;
      if (!global.PensionOptimiser || !PensionOptimiser.bestPlanFixedAnnuity) throw new Error('Best Plan optimiser is not loaded.');
      if (typeof readControls !== 'function' || typeof buildDrawdownCfg !== 'function') throw new Error('Modelling helpers not available yet. Open the Modelling page after load and try again.');
      const opts = readBpfInputs();
      const basePlan = readControls();
      const rebuildForDate = function (retireDate, safeOpts) {
        const plan = applyWithdrawalMode(basePlan, retireDate, safeOpts || opts);
        return buildDrawdownCfg(plan);
      };
      const res = PensionOptimiser.bestPlanFixedAnnuity(data, Object.assign({}, opts, { rebuildForDate }));
      state.lastResult = res;
      renderResult(res);
      qs('bpf_apply').disabled = !res.feasible;
      setMsg(res.feasible ? 'Found ✓' : 'No passing date', res.feasible ? 'ok' : 'err');
    } catch (e) { setMsg(e.message || String(e), 'err'); out.innerHTML = '<div class="bpf-card bad"><strong>Error.</strong> ' + esc(e.message || e) + '</div>'; }
  }
  function renderResult(res) {
    const out = qs('bpf_result');
    if (!res || !res.feasible) {
      out.innerHTML = '<div class="bpf-card bad"><strong>No feasible date found.</strong><div style="margin-top:6px;">' + esc(res && res.reason ? res.reason : 'No date in the selected range passed all rules.') + '</div>' + (res && res.opts ? '<div class="bpf-note">Scenario tested: ' + esc(scenarioSummary(res.opts)) + '.</div>' : '') + '</div>';
      return;
    }
    const d = res.detail || {};
    const annIncome = res.opts.includeBestPlanAnnuity ? ((res.opts.annuityAmount || 0) * ((res.opts.annuityRate || 0) / 100)) : 0;
    out.innerHTML = '<div class="bpf-card ok"><strong>Plan passes.</strong> Earliest safe retirement is <strong>' + esc(dateLabel(res.earliestDate)) + '</strong>.' +
      '<div class="bpf-metrics">' +
      '<div class="bpf-metric"><b>' + esc(dateLabel(res.earliestDate)) + '</b><span>Earliest date</span></div>' +
      '<div class="bpf-metric"><b>' + gbp(d.minPot) + '</b><span>Lowest pot (' + esc(dateLabel(d.minPotDate)) + ')</span></div>' +
      '<div class="bpf-metric"><b>' + (res.opts.includeBestPlanAnnuity ? gbp(res.opts.annuityAmount) : 'Excluded') + '</b><span>Best Plan annuity</span></div>' +
      '<div class="bpf-metric"><b>' + (res.opts.includeBestPlanAnnuity ? (gbp(annIncome) + '/yr') : '—') + '</b><span>Estimated gross annuity income</span></div>' +
      '<div class="bpf-metric"><b>' + gbp(d.endPot) + '</b><span>End pot</span></div>' +
      '</div><div class="bpf-note">Scenario tested: ' + esc(scenarioSummary(res.opts)) + '. Apply updates the current in-browser model only; use the existing Save Model feature afterwards if happy.</div></div>';
  }

  function captureOriginalAnnuities() {
    if (state.originalAnnuities !== null) return;
    try { state.originalAnnuities = (typeof data !== 'undefined' && Array.isArray(data.annuities)) ? data.annuities.slice() : []; }
    catch (e) { state.originalAnnuities = []; }
  }
  function clearApplied() {
    try {
      if (state.originalAnnuities !== null && typeof data !== 'undefined') data.annuities = state.originalAnnuities.slice();
    } catch (e) { /* ignore */ }
    state.applied = false;
    global.__bpfAppliedAnnuity = false;
    global.__bpfAppliedScenario = false;
    global.__bpfForceSharedRetirement = false;
  }
  function applyBestPlan() {
    if (!state.lastResult || !state.lastResult.feasible) { setMsg('Run Best Plan Finder first.', 'err'); return; }
    try {
      setMsg('Applying…', '');
      const res = state.lastResult;
      captureOriginalAnnuities();
      // 1) Update the visible retirement slider.
      const retireEl = qs('m_retire');
      if (retireEl) {
        const idx = (typeof dateToIdx === 'function') ? dateToIdx(res.earliestDate) : (monthIdx(res.earliestDate) - monthIdx(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
        retireEl.value = idx;
      }
      // 2) Apply the explicit scenario annuity set in memory only.
      if (typeof data !== 'undefined') {
        data.annuities = scenarioAnnuities(data, res.opts);
      }
      // 3) Force the applied shared retirement date and redraw normal charts.
      global.__bpfForceSharedRetirement = true;
      global.__bpfAppliedAnnuity = true;   // makes the Saved Model snapshot use in-memory annuity rows.
      global.__bpfAppliedScenario = true;
      if (typeof syncLabels === 'function') syncLabels();
      if (typeof recomputeAll === 'function') recomputeAll();
      else if (typeof onParam === 'function') onParam();
      state.applied = true;
      setMsg('Applied to current model ✓. Review charts, then use Save Model if happy.', 'ok');
    } catch (e) { setMsg('Apply failed: ' + (e.message || e), 'err'); }
  }
  function clearResult() { state.lastResult = null; qs('bpf_result').innerHTML = ''; qs('bpf_apply').disabled = true; setMsg('', ''); updateInputSummary(); }

  function initDial() {
    const dial = qs('bpf_rate_dial'), input = qs('bpf_rate'); if (!dial || !input) return;
    function sync() {
      const v = Math.max(0, Math.min(12, Number(input.value) || 0));
      const deg = -135 + (v / 12) * 270;
      dial.style.setProperty('--bpf-rot', deg + 'deg');
      dial.setAttribute('aria-valuemin', '0'); dial.setAttribute('aria-valuemax', '12'); dial.setAttribute('aria-valuenow', v.toFixed(1));
      updateInputSummary();
    }
    function setFromPoint(ev) {
      const r = dial.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let deg = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90;
      if (deg > 180) deg -= 360;
      deg = Math.max(-135, Math.min(135, deg));
      const val = ((deg + 135) / 270) * 12;
      input.value = (Math.round(val * 10) / 10).toFixed(1);
      sync();
    }
    let dragging = false;
    dial.addEventListener('pointerdown', ev => { dragging = true; dial.setPointerCapture(ev.pointerId); setFromPoint(ev); });
    dial.addEventListener('pointermove', ev => { if (dragging) setFromPoint(ev); });
    dial.addEventListener('pointerup', () => { dragging = false; });
    input.addEventListener('input', sync);
    sync();
  }

  function initUi() {
    if (qs('bpf_panel')) return;
    const anchor = qs('modelRail') || document.querySelector('#Modelling .params') || document.querySelector('#Modelling');
    if (!anchor) return;
    buildCss();
    const wrap = document.createElement('div'); wrap.innerHTML = panelHtml();
    const actions = anchor.querySelector('.actions');
    if (actions) anchor.insertBefore(wrap.firstElementChild, actions);
    else anchor.appendChild(wrap.firstElementChild);
    document.querySelectorAll('#bpf_panel .bpf-chip').forEach(btn => btn.addEventListener('click', () => {
      const p = String(btn.dataset.set || '').split(':'); const el = qs(p[0]); if (el) { el.value = p[1]; updateInputSummary(); }
    }));
    qs('bpf_run').addEventListener('click', runBestPlan);
    qs('bpf_apply').addEventListener('click', applyBestPlan);
    qs('bpf_clear').addEventListener('click', clearResult);
    document.querySelectorAll('#bpf_panel input,#bpf_panel select').forEach(el => el.addEventListener('input', updateInputSummary));
    document.querySelectorAll('#bpf_panel select').forEach(el => el.addEventListener('change', updateInputSummary));
    initDial();
    updateInputSummary();
  }

  global.BestPlanFinder = Object.assign(global.BestPlanFinder || {}, {
    build: BUILD,
    clearApplied: clearApplied,
    scenarioAnnuities: scenarioAnnuities,
    buildScenarioData: buildScenarioData,
    applyWithdrawalMode: applyWithdrawalMode
  });

  function boot() {
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      try { initUi(); } catch (e) { console.warn('Best Plan Finder init failed:', e); }
      if (qs('bpf_panel') || tries > 40) clearInterval(t);
    }, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})(typeof window !== 'undefined' ? window : globalThis);
