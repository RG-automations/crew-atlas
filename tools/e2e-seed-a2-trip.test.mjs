// node tools/e2e-seed-a2-trip.test.mjs : atrapa Firebase (odwzorowanie reguł dla podróży i zaproszeń), bez sieci
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const script = fileURLToPath(new URL('./e2e-seed-a2-trip.mjs', import.meta.url));
const PW = { ADA: 'pw-ada-VALUE1', BEN: 'pw-ben-VALUE2', CLEO: 'pw-cleo-VALUE3', DAN: 'pw-dan-VALUE4' }, KEY = 'fb-key-VALUE', PROJ = 'crewatlas-test';
const UID = { 'ada@x.test': 'uAda', 'ben@x.test': 'uBen', 'cleo@x.test': 'uCleo', 'dan@x.test': 'uDan' };

if (process.argv[2] === 'child') {
  const db = { 'trips/EXISTING': { fields: {} }, 'invites/EXIST1': { fields: {} } };
  const writes = [];
  const uidOf = (h) => h.authorization.split(' ')[1];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), method = init.method ?? 'GET';
    if (u.startsWith('https://identitytoolkit.googleapis.com/')) {
      const { email, password } = JSON.parse(init.body);
      const k = Object.keys(PW).find((x) => `${x.toLowerCase()}@x.test` === email);
      if (!k || PW[k] !== password || !u.includes(`key=${KEY}`)) return Response.json({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }, { status: 400 });
      return Response.json({ idToken: UID[email], localId: UID[email] });
    }
    assert.ok(u.startsWith(`https://firestore.googleapis.com/v1/projects/${PROJ}/`), 'tylko Firestore testowego projektu');
    const caller = uidOf(init.headers), p = u.split('/documents/')[1] ?? '';
    if (u.endsWith('/documents:commit')) {
      const body = JSON.parse(init.body);
      for (const w of body.writes) {
        const path = w.update.name.split('/documents/')[1];
        assert.ok(w.currentDocument?.exists === false, 'tylko nowe dokumenty');
        if (path in db) return new Response('{}', { status: 409 });
      }
      const [t, inv] = body.writes, tf = t.update.fields;
      const okRules = tf.createdBy.stringValue === caller && tf.memberIds.arrayValue.values.length === 1 && tf.memberIds.arrayValue.values[0].stringValue === caller
        && tf.inviteCode.stringValue.length === 6 && inv.update.name.endsWith(`/invites/${tf.inviteCode.stringValue}`) && inv.update.fields.tripId.stringValue === t.update.name.split('/').pop();
      if (!okRules) return new Response('{}', { status: 403 });
      for (const w of body.writes) { const path = w.update.name.split('/documents/')[1]; db[path] = w.update; writes.push(`${caller} ${path}`); }
      return Response.json({});
    }
    if (p.startsWith('users/')) {
      if (p.split('?')[0] !== `users/${caller}`) return new Response('{}', { status: 403 });
      writes.push(`${caller} ${p.split('?')[0]}`); return Response.json({});
    }
    const [path, qs] = p.split('?');
    const trip = db[path];
    if (method === 'GET') return trip && trip.fields.memberIds?.arrayValue.values.some((v) => v.stringValue === caller) ? Response.json(trip) : new Response('{}', { status: 403 });
    if (method === 'PATCH') {
      const f = JSON.parse(init.body).fields, mine = f.memberIds.arrayValue.values.map((v) => v.stringValue);
      const old = trip.fields.memberIds.arrayValue.values.map((v) => v.stringValue);
      const ok = !old.includes(caller) && f.joinCode.stringValue === trip.fields.inviteCode.stringValue && mine.length === old.length + 1 && old.every((x) => mine.includes(x)) && mine.includes(caller)
        && decodeURIComponent(qs).includes(`memberNames.${caller}`);
      if (!ok) return new Response('{}', { status: 403 });
      trip.fields.memberIds = f.memberIds; trip.fields.memberNames.mapValue.fields[caller] = f.memberNames.mapValue.fields[caller]; writes.push(`${caller} join`); return Response.json({});
    }
    throw new Error(`nieoczekiwane żądanie ${method} ${u}`);
  };
  process.on('exit', () => process.stderr.write(`WORLD ${JSON.stringify({ writes, docs: Object.keys(db) })}\n`));
  process.argv.splice(2, 1);
  await import(script);
} else {
  const base = { FIREBASE_API_KEY: KEY, FIREBASE_PROJECT_ID: PROJ, ...Object.fromEntries(Object.keys(PW).flatMap((k) => [[`A2_${k}_EMAIL`, `${k.toLowerCase()}@x.test`], [`A2_${k}_PASSWORD`, PW[k]]])) };
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, [here, 'child', ...args], { env: { PATH: process.env.PATH, ...base, ...env }, encoding: 'utf8' });
    const w = /^WORLD (.*)$/m.exec(r.stderr);
    return { code: r.status, out: r.stdout + r.stderr.replace(/^WORLD .*$/m, ''), world: w ? JSON.parse(w[1]) : null };
  };
  const noLeak = (o) => { for (const s of [...Object.values(PW), KEY]) assert.ok(!o.includes(s), 'sekret w wyjściu'); assert.ok(!/https?:\/\//.test(o)); };
  const GO = ['--expect-project', PROJ, '--i-am-using-test-services'];

  let r = run(['--expect-project', PROJ]);
  assert.equal(r.code, 0); assert.match(r.out, /Próba na sucho/); assert.match(r.out, /Dan A2: bez zapisów/); assert.deepEqual(r.world.writes, []);
  r = run(['--i-am-using-test-services']); assert.equal(r.code, 2, 'bez --expect-project odmowa');
  r = run(['--expect-project', 'inny-projekt', '--i-am-using-test-services']); assert.equal(r.code, 2, 'niezgodny projekt');
  r = run(GO, { PROD_FIREBASE_PROJECT_ID: PROJ }); assert.equal(r.code, 2); assert.deepEqual(r.world.writes, []);
  r = run(GO, { A2_DAN_PASSWORD: '' }); assert.equal(r.code, 2);
  r = run(GO, { A2_BEN_PASSWORD: 'zle-haslo' }); assert.equal(r.code, 1); assert.deepEqual(r.world.writes, [], 'zły login: nic nie zapisano'); noLeak(r.out);
  r = run(GO, { A2_DAN_EMAIL: 'ada@x.test', A2_DAN_PASSWORD: PW.ADA }); assert.equal(r.code, 1, 'dwa razy to samo konto'); assert.deepEqual(r.world.writes, []);

  r = run(GO);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /RESULT: PASS/); noLeak(r.out);
  const id = /E2E_TRIP_ID=([A-Za-z0-9]{20})/.exec(r.out)?.[1]; assert.ok(id, 'wypisuje id podróży');
  assert.deepEqual(r.world.docs.filter((d) => d.startsWith('trips/')).sort(), ['trips/EXISTING', `trips/${id}`].sort(), 'istniejące dokumenty nietknięte, jedna nowa podróż');
  assert.ok(r.world.writes.every((w) => !w.startsWith('uDan')), 'Dan niczego nie zapisuje');
  assert.deepEqual(r.world.writes.filter((w) => w.endsWith('join')).sort(), ['uBen join', 'uCleo join']);
  assert.ok(r.world.writes.includes('uAda users/uAda') && r.world.writes.includes('uBen users/uBen') && r.world.writes.includes('uCleo users/uCleo'));
  assert.match(r.out, /PASS  Dan A2 nie ma dostępu do podróży/);
  console.log('e2e-seed-a2-trip: wszystkie testy na atrapach przeszły');
}
