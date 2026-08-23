'use strict';

const QUALIFIERS = new Set(['very', 'really', 'just', 'actually', 'basically', 'literally', 'simply', 'quite']);
const MIN_WORDS = 20;

module.exports = function writingGrader(tenote) {
  let strictness = tenote.settings.get('strictness', 'standard');
  let timer = null;
  let lastKey = '';

  const chip = tenote.ui.chips.add({
    label: '',
    variant: 'default',
    onHover() { return lastTip; },
    onClick() { tenote.ui.toast(lastTip, 5000); },
  });
  chip.hide();
  let lastTip = '';

  tenote.ui.settings.declare([
    { key: 'strictness', type: 'select', label: 'Grading strictness', options: ['lenient', 'standard', 'strict'], default: 'standard',
      onChange(v) { strictness = v; schedule(); } },
  ]);

  function thresholds() {
    if (strictness === 'lenient') return { longRatio: 0.22, passiveRate: 0.066, adverbRate: 1 / 75, qualifierRate: 1 / 150 };
    if (strictness === 'strict') return { longRatio: 0.10, passiveRate: 0.033, adverbRate: 1 / 66, qualifierRate: 1 / 133 };
    return { longRatio: 0.15, passiveRate: 0.05, adverbRate: 1 / 50, qualifierRate: 1 / 100 };
  }

  function analyze(text) {
    const plain = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/[#*`>\[\]]/g, '');
    const sentenceList = plain.split(/[.!?]+\s/).map((s) => s.trim()).filter(Boolean);
    const words = plain.split(/\s+/).filter(Boolean);
    if (words.length < MIN_WORDS || !sentenceList.length) return null;

    const syl = words.reduce((s, w) => s + syllables(w), 0);
    const grade = Math.max(1, Math.min(18,
      Math.round(0.39 * (words.length / sentenceList.length) + 11.8 * (syl / words.length) - 15.59)));

    const t = thresholds();
    const offenses = [];
    const longOnes = sentenceList.filter((s) => wordCount(s) > 30);
    const longish = sentenceList.filter((s) => { const n = wordCount(s); return n > 20 && n <= 30; });
    if (longOnes.length) push(offenses, 3, `${longOnes.length} very long sentence${longOnes.length > 1 ? 's' : ''} (30+ words)`, `Longest starts “${clip(longOnes[0])}” — split it`);
    else if (longish.length > sentenceList.length * t.longRatio) push(offenses, 2, `${longish.length} long sentences (20+ words)`, `Try splitting the one that starts “${clip(longish[0])}”`);

    const passives = countPassive(plain);
    if (passives > sentenceList.length * t.passiveRate) {
      push(offenses, 2, 'passive voice detected', 'Name who does the thing — “we shipped it”, not “it was shipped”');
    }

    const adverbs = words.filter((w) => /^\w{4,}ly[.,!?]?$/i.test(w)).length;
    if (adverbs && adverbs / words.length > t.adverbRate) {
      push(offenses, 1, `${adverbs} adverbs in -ly`, 'Cut them; use a stronger verb instead');
    }

    const quals = words.filter((w) => QUALIFIERS.has(w.toLowerCase().replace(/\W/g, ''))).length;
    if (quals && quals / words.length > t.qualifierRate) {
      push(offenses, 1, `${quals} filler qualifiers`, 'Delete “very/really/just/actually” — the sentence survives');
    }

    return { grade, offenses };
  }

  function push(list, rank, what, tip) { list.push({ rank, what, tip }); }

  function wordCount(s) { return s.split(/\s+/).filter(Boolean).length; }
  function clip(s, n = 48) { return s.length > n ? s.slice(0, n).trim() + '…' : s; }

  function countPassive(text) {
    const m = text.match(/\b(am|is|are|was|were|be|been|being)\b\s+(\w+(?:ed|en))\b/gi);
    return m ? m.length : 0;
  }

  function syllables(word) {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return 0;
    if (w.length <= 3) return 1;
    const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
    return groups ? groups.length : 1;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, 500);
  }

  function run() {
    if (!window.__tenoteComposer) return;
    const r = analyze(window.__tenoteComposer.getText());
    if (!r) { chip.hide(); lastTip = ''; return; }
    const good = r.grade <= 8;
    chip.update(`Grade ${r.grade}`, good ? 'default' : 'accent');
    chip.show();
    if (!r.offenses.length) lastTip = `Grade ${r.grade} — clean. Nothing to fix.`;
    else {
      const worst = r.offenses.sort((a, b) => b.rank - a.rank)[0];
      lastTip = `Worst offense: ${worst.what}. ${worst.tip}`;
    }
  }

  tenote.events.on('composer:input', schedule);
  tenote.events.on('note:opened', schedule);
};
