// OPCJONALNE: push FCM (data-message, wysoki priorytet) dla alarmu SOS, gdy aplikacja
// jest zamknięta. Wymaga planu Blaze (pay-as-you-go) - przy tej skali mieści się w
// darmowym limicie, ale Firebase wymaga podpiętej karty. Bez tego SOS działa
// w czasie rzeczywistym, gdy aplikacja jest uruchomiona (także w tle, dopóki system jej nie zabije).
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
admin.initializeApp();

exports.onSos = onDocumentCreated("trips/{tripId}/sos/{sosId}", async (event) => {
  const sos = event.data.data();
  const db = admin.firestore();
  const trip = (await db.doc(`trips/${event.params.tripId}`).get()).data();
  if (!trip) return;
  const targets = trip.memberIds.filter((id) => id !== sos.uid);
  const users = await Promise.all(targets.map((id) => db.doc(`users/${id}`).get()));
  const tokens = users.map((u) => u.data()?.fcmToken).filter(Boolean);
  if (!tokens.length) return;
  await admin.messaging().sendEachForMulticast({
    tokens,
    android: { priority: "high" },
    data: {
      type: "sos",
      title: `SOS: ${sos.name} potrzebuje pomocy!`,
      body: `Podróż: ${trip.name}. Lokalizacja: ${sos.lat}, ${sos.lng}`,
    },
  });
});
