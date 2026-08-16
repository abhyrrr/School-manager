/**
 * sync.js — Canvas iCal → index.html ASSIGNMENTS patcher
 * Runs inside GitHub Actions on every scheduled sync.
 * No external npm deps needed (uses built-in https/fs).
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const ICAL_URL = 'https://southlakecarroll.instructure.com/feeds/calendars/user_vGEcs1XlX7Mmpb2SiPLTnyeRPLG2o5Xse1fvSz3K.ics';

const COURSE_MAP = {
  'AP ENGLISH 3/GT':                 'AP English 3/GT',
  'AP ENGLISH 3':                    'AP English 3/GT',
  'AP COMPUTER SCIENCE 1 MATH':      'AP Computer Science 1',
  'AP COMPUTER SCIENCE 1':           'AP Computer Science 1',
  'HONORS ROBOTICS 2':               'Honors Robotics 2',
  'AP CALCULUS AB':                  'AP Calculus AB',
  'AEROSPACE ENGINEERING HONORS':    'Aerospace Engineering Honors',
  'AP PHYSICS C E&M':                'AP Physics C E&M',
  'AP PHYSICS C':                    'AP Physics C E&M',
  'AP STATISTICS':                   'AP Statistics',
  'AP US HISTORY':                   'AP US History',
};

const EXCLUDE_NAMES = [
  'FIRST DAY OF SCHOOL',
  'NO SCHOOL',
  'SCHOOL PICTURES',
  'PEP RALLY',
  'JUNIOR CLASS TALK',
  'MEMOIR PRESENTATIONS',
];

const TYPE_RE = /test|quiz|exam|project|presentation|timed write|ap mc|skills quiz|assessment/i;

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'school-manager-sync/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchUrl(res.headers.location));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function unfold(ics) {
  return ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function parseVEvents(ics) {
  const events = [];
  const lines  = unfold(ics).split(/\r?\n/);
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (line === 'END:VEVENT'  ) { if (ev) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).split(';')[0];
    const val = line.slice(colon + 1).trim();
    ev[key] = val;
  }
  return events;
}

function icalDateToLocal(dtstart, dtparam) {
  if (dtparam && dtparam.includes('VALUE=DATE')) {
    return dtstart.slice(0, 4) + '-' + dtstart.slice(4, 6) + '-' + dtstart.slice(6, 8);
  }
  if (dtstart.endsWith('Z')) {
    const y  = +dtstart.slice(0, 4);
    const mo = +dtstart.slice(4, 6) - 1;
    const d  = +dtstart.slice(6, 8);
    const h  = +dtstart.slice(9, 11);
    const mi = +dtstart.slice(11, 13);
    const s  = +dtstart.slice(13, 15);
    const utc = Date.UTC(y, mo, d, h, mi, s);
    const month = mo + 1;
    const offsetH = (month >= 3 && month <= 11) ? 5 : 6;
    const local = new Date(utc - offsetH * 3600 * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${local.getUTCFullYear()}-${pad(local.getUTCMonth()+1)}-${pad(local.getUTCDate())}`;
  }
  return dtstart.slice(0, 4) + '-' + dtstart.slice(4, 6) + '-' + dtstart.slice(6, 8);
}

function cleanName(raw) {
  return raw.replace(/\s*\(Period\s+\d+[^)]*\)\s*$/, '').trim();
}

function parseCourse(summary) {
  const m = summary.match(/\[([^\]]+)\]\s*$/);
  if (!m) return null;
  const raw = m[1].replace(/\s*-\s*SEMESTER\s+\d+\s*$/i, '').trim().toUpperCase();
  return COURSE_MAP[raw] || null;
}

async function main() {
  console.log('Fetching iCal feed…');
  const ics = await fetchUrl(ICAL_URL);
  console.log(`Fetched ${ics.length} bytes`);

  const vevents = parseVEvents(ics);
  console.log(`Parsed ${vevents.length} VEVENTs`);

  const htmlPath = path.join(__dirname, 'index.html');
  const html     = fs.readFileSync(htmlPath, 'utf8');

  const existingMatch = html.match(/let ASSIGNMENTS\s*=\s*(\[[\s\S]*?\]);/);
  const existing = {};
  if (existingMatch) {
    try {
      const arr = new Function('return ' + existingMatch[1])();
      for (const a of arr) {
        existing[`${a.course}||${a.name}`] = { points: a.points, state: a.state };
      }
    } catch (e) {
      console.warn('Could not parse existing ASSIGNMENTS:', e.message);
    }
  }

  const assignments = [];
  const seenUIDs    = new Set();

  for (const ev of vevents) {
    const uid = ev['UID'] || '';
    if (!uid.includes('assignment_')) continue;
    if (seenUIDs.has(uid)) continue;
    seenUIDs.add(uid);

    const summary = ev['SUMMARY'] || '';
    const course  = parseCourse(summary);
    if (!course) continue;

    const name = cleanName(summary.replace(/\s*\[[^\]]*\]\s*$/, '').trim());
    const nameUpper = name.toUpperCase();
    if (EXCLUDE_NAMES.some(ex => nameUpper.includes(ex))) continue;

    let dtstart = ev['DTSTART'] || '';
    let dtparam = '';
    const rawLines = unfold(ics).split(/\r?\n/);
    for (const l of rawLines) {
      if (l.startsWith('DTSTART')) {
        const c = l.indexOf(':');
        dtparam  = l.slice(0, c);
        dtstart  = l.slice(c + 1).trim();
        break;
      }
    }
    const due = icalDateToLocal(dtstart, dtparam);

    const key   = `${course}||${name}`;
    const prev  = existing[key] || {};
    const type  = TYPE_RE.test(name) ? 'test' : 'daily';

    assignments.push({
      course, name, due,
      points: prev.points ?? 0,
      state:  prev.state  ?? 'unsubmitted',
      type,
    });
  }

  assignments.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  console.log(`Generated ${assignments.length} assignments`);

  const lines  = assignments.map(a => `  ${JSON.stringify(a)}`).join(',\n');
  const block  = `let ASSIGNMENTS = [\n${lines}\n];`;
  const today  = new Date().toISOString().slice(0, 10);

  let updated = html
    .replace(/let ASSIGNMENTS\s*=\s*\[[\s\S]*?\];/, block)
    .replace(/const SYNC_DATE\s*=\s*'[^']*'/, `const SYNC_DATE = '${today}'`);

  fs.writeFileSync(htmlPath, updated, 'utf8');
  console.log('index.html updated ✓');
}

main().catch(err => { console.error(err); process.exit(1); });
