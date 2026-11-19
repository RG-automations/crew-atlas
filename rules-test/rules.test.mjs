// Testy reguł Firestore na emulatorze: npm test (w tym folderze). Reguły czytane z ../firestore.rules.
import fs from 'node:fs';
import { before, after, beforeEach, describe, it } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  arrayRemove, arrayUnion, collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc,
  updateDoc, where, writeBatch,
} from 'firebase/firestore';

let env;
const db = (uid) => env.authenticatedContext(uid).firestore();
const T1 = 'trips/T1';

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-crewatlas',
    firestore: { rules: fs.readFileSync('../firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(async () => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, T1), {
      name: 'Wiedeń', inviteCode: 'ABC234', createdBy: 'owner',
      memberIds: ['owner', 'm1', 'm2'], memberNames: { owner: 'O', m1: 'M', m2: 'N' },
    });
    await setDoc(doc(d, 'invites/ABC234'), { tripId: 'T1', createdBy: 'owner' });
    await setDoc(doc(d, 'users/m1'), { name: 'M', fcmToken: 'tok-m1' });
    await setDoc(doc(d, 'users/m2'), { name: 'N', fcmToken: 'tok-m2' });
    await setDoc(doc(d, `${T1}/locations/owner`), { lat: 1, lng: 2 });
    await setDoc(doc(d, `${T1}/places/p-owner`), { title: 'x', createdBy: 'owner' });
    await setDoc(doc(d, `${T1}/places/p-m1`), { title: 'y', createdBy: 'm1' });
    await setDoc(doc(d, `${T1}/memories/mem-m1`), { placeId: 'p-m1', createdBy: 'm1' });
    await setDoc(doc(d, `${T1}/expenses/e-m1`), { amount: 10, createdBy: 'm1' });
    await setDoc(doc(d, `${T1}/legs/l-m1`), { userId: 'm1', from: 'A', to: 'B' });
    await setDoc(doc(d, `${T1}/stays/s-m1`), { title: 'h', createdBy: 'm1' });
    await setDoc(doc(d, `${T1}/sos/sos-m1`), { uid: 'm1', active: true });
  });
});

const join = (uid, code, extra = {}) =>
  updateDoc(doc(db(uid), T1), {
    memberIds: arrayUnion(uid), [`memberNames.${uid}`]: 'S', joinCode: code, ...extra,
  });

describe('profile użytkowników (users/*)', () => {
  it('użytkownik czyta i zapisuje własny profil', async () => {
    await assertSucceeds(getDoc(doc(db('m1'), 'users/m1')));
    await assertSucceeds(setDoc(doc(db('m1'), 'users/m1'), { name: 'Nowa', fcmToken: 't' }, { merge: true }));
    await assertSucceeds(setDoc(doc(db('fresh'), 'users/fresh'), { name: 'Nowy' }));
  });

  it('nie czyta cudzego profilu ani nie listuje profili', async () => {
    await assertFails(getDoc(doc(db('m1'), 'users/m2')));
    await assertFails(getDocs(collection(db('m1'), 'users')));
    await assertFails(getDoc(doc(db('stranger'), 'users/m1')));
  });

  it('nie zmienia ani nie usuwa cudzego profilu', async () => {
    await assertFails(setDoc(doc(db('m1'), 'users/m2'), { name: 'HACK' }, { merge: true }));
    await assertFails(deleteDoc(doc(db('m1'), 'users/m2')));
  });

  it('własny profil nie przyjmuje obcych pól', async () => {
    await assertFails(setDoc(doc(db('m1'), 'users/m1'), { name: 'x', isAdmin: true }, { merge: true }));
  });
});

describe('obcy (nie członek)', () => {
  it('nie czyta dokumentu podróży ani jej podkolekcji, nie listuje podróży', async () => {
    await assertFails(getDoc(doc(db('stranger'), T1)));
    await assertFails(getDoc(doc(db('stranger'), `${T1}/locations/owner`)));
    await assertFails(getDocs(collection(db('stranger'), `${T1}/memories`)));
    await assertFails(getDocs(collection(db('stranger'), 'trips')));
  });

  it('własne zapytanie o podróże (arrayContains) jest dozwolone i puste', async () => {
    const snap = await assertSucceeds(
      getDocs(query(collection(db('stranger'), 'trips'), where('memberIds', 'array-contains', 'stranger'))));
    if (snap.size !== 0) throw new Error('obcy zobaczył cudzą podróż');
  });

  it('nie zapisuje danych podróży ani nie zmienia jej dokumentu', async () => {
    await assertFails(setDoc(doc(db('stranger'), `${T1}/places/x`), { title: 'x', createdBy: 'stranger' }));
    await assertFails(setDoc(doc(db('stranger'), `${T1}/sos/x`), { uid: 'stranger', active: true, createdAt: serverTimestamp() }));
    await assertFails(setDoc(doc(db('stranger'), `${T1}/locations/stranger`), { lat: 0, lng: 0, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db('stranger'), T1), { memberIds: ['stranger'] }));
    await assertFails(updateDoc(doc(db('stranger'), T1), { name: 'x' }));
    await assertFails(deleteDoc(doc(db('stranger'), T1)));
  });

  it('dołączenie z błędnym kodem jest odrzucone, z poprawnym przechodzi', async () => {
    await assertFails(join('stranger', 'WRONG1'));
    await assertSucceeds(join('stranger', 'ABC234'));
    await assertSucceeds(getDoc(doc(db('stranger'), T1)));
    await assertSucceeds(getDoc(doc(db('stranger'), `${T1}/locations/owner`)));
  });

  it('dołączając nie zmieni cudzych nazw, kodu ani listy członków', async () => {
    await assertFails(join('stranger', 'ABC234', { 'memberNames.owner': 'HACK' }));
    await assertFails(join('stranger', 'ABC234', { inviteCode: 'NEW999' }));
    await assertFails(join('stranger', 'ABC234', { createdBy: 'stranger' }));
    await assertFails(updateDoc(doc(db('stranger'), T1), {
      memberIds: arrayUnion('stranger', 'friend'), 'memberNames.stranger': 'S', joinCode: 'ABC234',
    }));
    await assertFails(updateDoc(doc(db('stranger'), T1), {
      memberIds: arrayRemove('owner'), joinCode: 'ABC234',
    }));
  });

  it('pusty lub krótki kod nie otwiera podróży', async () => {
    await assertFails(join('stranger', ''));
    await assertFails(join('stranger', 'ABC'));
  });
});

describe('członek', () => {
  it('może wyjść sam, ale nie usunie innych ani nikogo nie doda', async () => {
    await assertFails(updateDoc(doc(db('m1'), T1), { memberIds: arrayRemove('owner') }));
    await assertFails(updateDoc(doc(db('m1'), T1), { memberIds: arrayUnion('x') }));
    await assertSucceeds(updateDoc(doc(db('m1'), T1), { memberIds: arrayRemove('m1') }));
  });

  it('nie zmienia createdBy, inviteCode, nazw ani nazwy podróży', async () => {
    await assertFails(updateDoc(doc(db('m1'), T1), { createdBy: 'm1' }));
    await assertFails(updateDoc(doc(db('m1'), T1), { inviteCode: 'HACK22' }));
    await assertFails(updateDoc(doc(db('m1'), T1), { 'memberNames.owner': 'HACK' }));
    await assertFails(updateDoc(doc(db('m1'), T1), { name: 'x' }));
    await assertFails(updateDoc(doc(db('m1'), T1), { memberIds: arrayRemove('m1'), createdBy: 'm1' }));
  });

  it('po wyjściu traci dostęp do danych podróży', async () => {
    await assertSucceeds(updateDoc(doc(db('m1'), T1), { memberIds: arrayRemove('m1') }));
    await assertFails(getDoc(doc(db('m1'), T1)));
    await assertFails(getDoc(doc(db('m1'), `${T1}/locations/owner`)));
    await assertFails(getDocs(collection(db('m1'), `${T1}/memories`)));
    await assertFails(setDoc(doc(db('m1'), `${T1}/places/z`), { title: 'z', createdBy: 'm1' }));
  });

  it('własne zapytanie o podróże zwraca jego podróż', async () => {
    const snap = await assertSucceeds(
      getDocs(query(collection(db('m1'), 'trips'), where('memberIds', 'array-contains', 'm1'))));
    if (snap.size !== 1) throw new Error('członek nie widzi swojej podróży');
  });

  it('tylko twórca usuwa podróż', async () => {
    await assertFails(deleteDoc(doc(db('m1'), T1)));
    await assertSucceeds(deleteDoc(doc(db('owner'), T1)));
  });
});

// Nowe wspomnienie: prywatny plik (publicId w folderze tej podróży), bez adresu URL.
const mem = (uid, over = {}) => ({
  placeId: 'p1', type: 'photo', publicId: 'wycieczka/T1/abcdefgh12', resourceType: 'image', format: 'jpg',
  description: 'x', createdBy: uid, ...over,
});

describe('wspomnienia: tylko prywatne pliki tej podróży', () => {
  it('poprawny wpis przechodzi', async () => {
    await assertSucceeds(setDoc(doc(db('m2'), `${T1}/memories/ok1`), mem('m2')));
    await assertSucceeds(setDoc(doc(db('m2'), `${T1}/memories/ok2`), mem('m2', { resourceType: 'video', publicId: 'wycieczka/T1/0123-4567-89ab' })));
  });

  it('wpis bez publicId albo ze starym polem url jest odrzucony', async () => {
    const { publicId, ...noId } = mem('m2');
    await assertFails(setDoc(doc(db('m2'), `${T1}/memories/bad1`), noId));
    await assertFails(setDoc(doc(db('m2'), `${T1}/memories/bad2`), { placeId: 'p1', createdBy: 'm2', url: 'https://res.cloudinary.com/x/image/upload/v1/a.jpg' }));
    await assertFails(setDoc(doc(db('m2'), `${T1}/memories/bad3`), mem('m2', { url: 'https://example.invalid/a.jpg' })));
  });

  it('publicId musi wskazywać folder tej podróży i mieć bezpieczne znaki', async () => {
    for (const publicId of ['wycieczka/T2/abcdefgh12', 'wycieczka/T1/../T2/abcdefgh12', 'wycieczka/T1/ab', 'inny/T1/abcdefgh12',
      'wycieczka/T1/abcdefgh12/extra', 'wycieczka/T1/abc defgh12', 'wycieczka/T1/', 'wycieczka/T1x/abcdefgh12']) {
      await assertFails(setDoc(doc(db('m2'), `${T1}/memories/bad`), mem('m2', { publicId })));
    }
  });

  it('resourceType tylko image albo video; nie w cudzym imieniu', async () => {
    await assertFails(setDoc(doc(db('m2'), `${T1}/memories/bad`), mem('m2', { resourceType: 'raw' })));
    await assertFails(setDoc(doc(db('m2'), `${T1}/memories/bad`), mem('m1')));
  });

  it('stare wpisy z url nadal da się usunąć (migracja i sprzątanie)', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `${T1}/memories/legacy`), { placeId: 'p1', url: 'https://example.invalid/x.jpg', createdBy: 'm2' });
    });
    await assertSucceeds(getDoc(doc(db('m1'), `${T1}/memories/legacy`)));
    await assertSucceeds(deleteDoc(doc(db('m2'), `${T1}/memories/legacy`)));
  });
});

describe('współpraca w podróży', () => {
  it('członek czyta wszystkie podkolekcje, w tym zapytania aplikacji', async () => {
    await assertSucceeds(getDoc(doc(db('m2'), `${T1}/locations/owner`)));
    await assertSucceeds(getDocs(collection(db('m2'), `${T1}/places`)));
    await assertSucceeds(getDocs(query(collection(db('m2'), `${T1}/memories`), where('placeId', '==', 'p-m1'))));
    await assertSucceeds(getDocs(query(collection(db('m2'), `${T1}/sos`), where('active', '==', true))));
    await assertSucceeds(getDocs(collection(db('m2'), `${T1}/expenses`)));
  });

  it('członek dodaje własne wpisy, ale nie w cudzym imieniu', async () => {
    const m2 = db('m2');
    await assertSucceeds(setDoc(doc(m2, `${T1}/places/n1`), { title: 't', createdBy: 'm2', createdAt: serverTimestamp() }));
    await assertSucceeds(setDoc(doc(m2, `${T1}/memories/n1`), mem('m2')));
    await assertSucceeds(setDoc(doc(m2, `${T1}/expenses/n1`), { amount: 5, createdBy: 'm2' }));
    await assertSucceeds(setDoc(doc(m2, `${T1}/stays/n1`), { title: 'h', createdBy: 'm2' }));
    await assertSucceeds(setDoc(doc(m2, `${T1}/legs/n1`), { userId: 'm2', from: 'A', to: 'B' }));
    await assertFails(setDoc(doc(m2, `${T1}/places/n2`), { title: 't', createdBy: 'm1' }));
    await assertFails(setDoc(doc(m2, `${T1}/memories/n2`), mem('m1')));
    await assertFails(setDoc(doc(m2, `${T1}/expenses/n2`), { amount: 5, createdBy: 'm1' }));
    await assertFails(setDoc(doc(m2, `${T1}/legs/n2`), { userId: 'm1', from: 'A', to: 'B' }));
  });

  it('usuwa własne wpisy; cudze usuwa tylko ich autor albo założyciel podróży', async () => {
    for (const c of ['places/p-m1', 'memories/mem-m1', 'expenses/e-m1', 'legs/l-m1', 'stays/s-m1']) {
      await assertFails(deleteDoc(doc(db('m2'), `${T1}/${c}`)));
    }
    for (const c of ['places/p-m1', 'memories/mem-m1', 'expenses/e-m1', 'legs/l-m1']) {
      await assertSucceeds(deleteDoc(doc(db('m1'), `${T1}/${c}`)));
    }
    await assertSucceeds(deleteDoc(doc(db('owner'), `${T1}/stays/s-m1`)));
  });

  it('nie edytuje cudzych wpisów', async () => {
    await assertFails(updateDoc(doc(db('m2'), `${T1}/expenses/e-m1`), { amount: 9999 }));
    await assertFails(updateDoc(doc(db('m2'), `${T1}/memories/mem-m1`), { description: 'x' }));
  });

  it('niewymienione podkolekcje są zamknięte', async () => {
    await assertFails(setDoc(doc(db('m2'), `${T1}/inne/x`), { a: 1 }));
    await assertFails(getDoc(doc(db('m2'), `${T1}/inne/x`)));
  });
});

describe('lokalizacja na żywo', () => {
  it('członek zapisuje i usuwa tylko własną pozycję, z czasem serwera', async () => {
    const m2 = db('m2');
    await assertSucceeds(setDoc(doc(m2, `${T1}/locations/m2`), { name: 'N', lat: 1, lng: 2, updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(m2, `${T1}/locations/m1`), { name: 'N', lat: 1, lng: 2, updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(m2, `${T1}/locations/m2`), { name: 'N', lat: 1, lng: 2, updatedAt: new Date('2020-01-01') }));
    await assertFails(deleteDoc(doc(m2, `${T1}/locations/owner`)));
    await assertSucceeds(deleteDoc(doc(m2, `${T1}/locations/m2`)));
  });

  it('założyciel może posprzątać cudzą pozycję', async () => {
    await assertSucceeds(deleteDoc(doc(db('owner'), `${T1}/locations/owner`)));
  });
});

describe('SOS', () => {
  const sos = (uid, extra = {}) => ({ uid, name: 'N', lat: 1, lng: 2, active: true, createdAt: serverTimestamp(), ...extra });

  it('członek wysyła SOS tylko we własnym imieniu i z czasem serwera', async () => {
    await assertSucceeds(setDoc(doc(db('m2'), `${T1}/sos/a`), sos('m2')));
    await assertFails(setDoc(doc(db('m2'), `${T1}/sos/b`), sos('m1')));
    await assertFails(setDoc(doc(db('m2'), `${T1}/sos/c`), sos('m2', { createdAt: new Date('2020-01-01') })));
    await assertFails(setDoc(doc(db('m2'), `${T1}/sos/d`), sos('m2', { active: false })));
  });

  it('alarm zamyka (active=false) tylko jego autor; nikt go nie usuwa ani nie podmienia', async () => {
    await assertFails(updateDoc(doc(db('m2'), `${T1}/sos/sos-m1`), { active: false }));
    await assertFails(updateDoc(doc(db('m1'), `${T1}/sos/sos-m1`), { lat: 5 }));
    await assertFails(updateDoc(doc(db('m1'), `${T1}/sos/sos-m1`), { uid: 'm2' }));
    await assertFails(deleteDoc(doc(db('m1'), `${T1}/sos/sos-m1`)));
    await assertFails(deleteDoc(doc(db('owner'), `${T1}/sos/sos-m1`)));
    await assertSucceeds(updateDoc(doc(db('m1'), `${T1}/sos/sos-m1`), { active: false }));
  });
});

describe('zaproszenia i tworzenie podróży', () => {
  const newTrip = (uid, code, extra = {}) => ({
    name: 'x', inviteCode: code, createdBy: uid, memberIds: [uid], memberNames: { [uid]: 'U' }, ...extra,
  });
  const create = (uid, tripId, code, tripExtra = {}, inviteExtra = {}) => {
    const d = db(uid);
    const batch = writeBatch(d);
    batch.set(doc(d, `trips/${tripId}`), newTrip(uid, code, tripExtra));
    batch.set(doc(d, `invites/${code}`), { tripId, createdBy: uid, ...inviteExtra });
    return batch.commit();
  };

  it('nie da się wylistować ani zmienić zaproszeń, odczyt po kodzie działa', async () => {
    await assertFails(getDocs(collection(db('stranger'), 'invites')));
    await assertSucceeds(getDoc(doc(db('stranger'), 'invites/ABC234')));
    await assertFails(updateDoc(doc(db('owner'), 'invites/ABC234'), { tripId: 'T9' }));
    await assertFails(deleteDoc(doc(db('owner'), 'invites/ABC234')));
  });

  it('podróż tworzy się razem z zaproszeniem i tylko z samym sobą w członkach', async () => {
    await assertSucceeds(create('u1', 'T2', 'ZZZ222'));
    await assertFails(create('u1', 'T3', 'ZZZ223', { memberIds: ['u1', 'victim'] }));
    await assertFails(create('u1', 'T4', 'ZZZ224', { createdBy: 'inny' }));
    await assertFails(create('u1', 'T5', 'ZZZ225', { memberNames: { u1: 'U', victim: 'V' } }));
    await assertFails(create('u1', 'T6', 'AB', {}));
  });

  it('zaproszenia nie da się wystawić dla cudzej podróży ani z cudzym createdBy', async () => {
    await assertFails(setDoc(doc(db('u1'), 'invites/NEW234'), { tripId: 'T1', createdBy: 'u1' }));
    await assertFails(setDoc(doc(db('u1'), 'invites/NEW235'), { tripId: 'T1', createdBy: 'owner' }));
    await assertFails(setDoc(doc(db('m1'), 'invites/NEW236'), { tripId: 'T1', createdBy: 'm1' }));
  });

  it('członek odtwarza brakujące zaproszenie do własnej podróży (ensureInvite)', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'trips/T7'), newTrip('m1', 'OLD777', { memberIds: ['m1', 'm2'], memberNames: { m1: 'M', m2: 'N' } }));
    });
    await assertSucceeds(setDoc(doc(db('m2'), 'invites/OLD777'), { tripId: 'T7', createdBy: 'm2' }));
  });
});
