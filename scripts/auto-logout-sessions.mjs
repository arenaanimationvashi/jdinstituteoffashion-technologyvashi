// Auto-logout job — closes every attendance session still open past its 8:00 PM IST cutoff.
//
// Runs on a schedule from .github/workflows/auto-logout-8pm.yml, so it works even when nobody
// opens the student app, admin panel or faculty app. It applies the SAME rule the apps apply:
//   cutoff = 8:00 PM IST on the calendar day the student checked in
//   checkOut is stamped at exactly that cutoff (never "now"), autoLogout: true
//   a check-in at/after 8 PM gets cutoff = its own check-in time (never back-dated before it)
//
// It is safe to run repeatedly: it only touches records with checkOut == null.
//
// It deliberately does NOT auto-tick syllabus sessions (the student app does that when a
// student's own app performs the auto-logout). Ticking a topic on behalf of a student who never
// opened their app would create false "pending approval" items for faculty. This matches what
// the admin panel's own auto-close already does.
//
// Uses the same public Firebase config as the web apps; Firestore rules allow update on
// cadd_attendance, so no service-account secret is needed. If rules are ever tightened to
// require auth for attendance updates, switch this to firebase-admin with a service account.
//
// Usage:  node auto-logout-sessions.mjs            (closes sessions)
//         DRY_RUN=true node auto-logout-sessions.mjs   (prints what it WOULD close, writes nothing)

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // India has no DST — fixed UTC+05:30
const CUTOFF_HOUR_IST = 20;                 // 8:00 PM

// 8:00 PM IST on the IST calendar day of the check-in, as a UTC millisecond timestamp.
// Computed explicitly in IST so it is correct no matter what timezone the runner is in (UTC).
export function cutoffMsFor(checkInMs) {
  const ist = new Date(checkInMs + IST_OFFSET_MS); // shift so UTC getters read as IST wall-clock
  const cutoffMs =
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), CUTOFF_HOUR_IST, 0, 0, 0) - IST_OFFSET_MS;
  return cutoffMs < checkInMs ? checkInMs : cutoffMs;
}

// Pure planning step (no I/O) so the rule is easy to test: given open records and "now",
// returns the ones due to be closed and the exact checkOut time each should get.
export function planClosures(openRecords, nowMs) {
  const due = [];
  for (const r of openRecords) {
    if (!r.checkInMs) continue; // malformed record — leave it alone
    const cutoffMs = cutoffMsFor(r.checkInMs);
    if (nowMs >= cutoffMs) due.push({ ...r, cutoffMs });
  }
  return due;
}

async function main() {
  const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

  const { initializeApp } = await import('firebase/app');
  const { getFirestore, collection, query, where, getDocsFromServer, doc, updateDoc, Timestamp } =
    await import('firebase/firestore');

  const app = initializeApp({
    apiKey: 'AIzaSyAtFCkdHMgWyIuN2NVGhZikbpOJmJjxAe0',
    authDomain: 'jd-sats.firebaseapp.com',
    projectId: 'jd-sats',
    storageBucket: 'jd-sats.firebasestorage.app',
    messagingSenderId: '715184613041',
    appId: '1:715184613041:web:f26135262e45c1aa41e490',
  });
  const db = getFirestore(app);

  // getDocsFromServer (not getDocs): if the backend is unreachable, getDocs silently falls back to an
  // empty offline cache and the job would report "0 open sessions" and go green having done nothing.
  // This variant throws instead, so a connectivity or permission problem shows up as a red run.
  const snap = await getDocsFromServer(query(collection(db, 'cadd_attendance'), where('checkOut', '==', null)));
  const open = snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id,
      name: x.studentName || x.studentId || d.id,
      checkInMs: x.checkIn && typeof x.checkIn.seconds === 'number' ? x.checkIn.seconds * 1000 : null,
    };
  });

  const due = planClosures(open, Date.now());
  const fmt = (ms) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });

  console.log(`Open sessions found: ${open.length} | due to be closed: ${due.length}${dryRun ? ' (DRY RUN — no writes)' : ''}`);

  let closed = 0;
  let failed = 0;
  for (const r of due) {
    const line = `${r.name}: checked in ${fmt(r.checkInMs)} -> checkOut ${fmt(r.cutoffMs)}`;
    if (dryRun) { console.log('WOULD CLOSE  ' + line); continue; }
    try {
      await updateDoc(doc(db, 'cadd_attendance', r.id), {
        checkOut: Timestamp.fromMillis(r.cutoffMs),
        autoLogout: true,
      });
      closed++;
      console.log('CLOSED       ' + line);
    } catch (e) {
      failed++;
      console.error('FAILED       ' + line + ' — ' + (e && e.message ? e.message : e));
    }
  }

  console.log(dryRun ? 'Dry run complete.' : `Done. Closed: ${closed} | Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1; // makes the GitHub run show red so it gets noticed
}

// Only run when executed directly (so the pure functions above can be imported by tests).
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const watchdog = setTimeout(() => { console.error('Timed out after 90s'); process.exit(1); }, 90000);
  main()
    .catch((e) => { console.error('Auto-logout job failed:', e); process.exitCode = 1; })
    .finally(() => { clearTimeout(watchdog); process.exit(process.exitCode || 0); }); // Firestore keeps handles open otherwise
}
