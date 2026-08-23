'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  meeting: `## Attendees\n- \n\n## Agenda\n- \n\n## Notes\n\n\n## Action items\n- [ ] \n`,
  todo: `- [ ] \n- [ ] \n- [ ] \n`,
};

module.exports = function templates(tenote) {
  const dir = path.join(tenote.dataDir(), 'templates');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  for (const [name, body] of Object.entries(DEFAULTS)) {
    const f = path.join(dir, `${name}.md`);
    if (!fs.existsSync(f)) { try { fs.writeFileSync(f, body); } catch (e) { /* ignore */ } }
  }

  tenote.registerCommand('templates', () => {
    try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).join(' '); }
    catch (e) { return ''; }
  });

  tenote.on('note:before-save', (note) => {
    if (!note || typeof note.text !== 'string') return;
    const m = /^!([a-z][\w-]{0,31})[ \t]*\n?/i.exec(note.text);
    if (!m) return;
    const file = path.join(dir, `${m[1]}.md`);
    let body;
    try { body = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    const rest = note.text.slice(m[0].length);
    note.text = body.replace(/\s+$/, '') + '\n\n' + rest;
    return note;
  });

  tenote.log.info(`ready — templates in ${dir}`);
};
