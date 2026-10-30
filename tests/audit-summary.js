'use strict';
// Meringkas keluaran `npm audit --json` menjadi satu baris dan anotasi GitHub Actions (terbaca lewat API tanpa mengunduh log).
// HANYA melaporkan. Tidak pernah menggagalkan atau meloloskan CI: gerbang audit tetap langkah `npm audit` di workflow.
// Pemakaian: node tests/audit-summary.js <label> <berkas.json>
const fs = require('fs');

function summarize(raw, label) {
  let j; try { j = JSON.parse(raw); } catch (_) { return { level: 'warning', text: 'npm audit [' + label + ']: keluaran bukan JSON valid (audit tidak berjalan atau terpotong)' }; }
  if (j && j.error) return { level: 'warning', text: 'npm audit [' + label + ']: audit TIDAK selesai: ' + String(j.error.code || '') + ' ' + String(j.error.summary || '').slice(0, 160) };
  const v = j && j.metadata && j.metadata.vulnerabilities, d = (j && j.metadata && j.metadata.dependencies) || {};
  if (!v) return { level: 'warning', text: 'npm audit [' + label + ']: format laporan tidak dikenali' };
  const dep = 'dependensi total=' + (d.total ?? '?') + ' (prod=' + (d.prod ?? '?') + ', dev=' + (d.dev ?? '?') + ')';
  const text = 'npm audit [' + label + ']: kerentanan total=' + v.total + ' critical=' + v.critical + ' high=' + v.high + ' moderate=' + v.moderate + ' low=' + v.low + ' info=' + v.info + '; ' + dep;
  return { level: v.total > 0 ? 'warning' : 'notice', text };
}

module.exports = { summarize };

if (require.main === module) {
  const [label, file] = process.argv.slice(2);
  let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch (_) {}
  const r = summarize(raw, label || 'npm');
  console.log(r.text);
  console.log('::' + r.level + ' title=npm audit ' + (label || '') + '::' + r.text.replace(/[\r\n%]/g, ' '));
  if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '- ' + r.text + '\n'); } catch (_) {} }
}
